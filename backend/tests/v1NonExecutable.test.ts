import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import {
  DEPLOYMENTS,
  executableDeployment,
  deploymentById,
  indexableDeployments,
} from '../src/deployments';
import { createLaunchTarget } from '../src/launchTarget';
import { startFakeChain, FakeChain } from './fixtures/jsonRpcServer';

/**
 * V1 IS INDEXABLE. V1 IS NOT A DESTINATION.
 *
 * The registry has said `executable: false` for `pons-v1` since the migration, and the
 * exactly-one check in `executableDeployment()` throws rather than guessing. None of that
 * mattered, because `PONS_FACTORY_VERSION` let an ENVIRONMENT VARIABLE answer the same
 * question -- and its default was `v1`. A missing variable selected the superseded
 * factory silently.
 *
 * Two real launches in production went to v1 on 2026-08-12 through exactly that path.
 *
 * One fact must not live in two places. That is §11 of the findings in one line, and it
 * is why this suite tests that the SETTING IS GONE rather than that its default changed:
 * a default is a preference, and the next environment gets a vote.
 *
 * The assertions below are behavioural where it counts. `factoryAddress` is what a target
 * says about itself; `build().to` is where money actually goes, so the launch is
 * constructed through a real JSON-RPC transport and the address is read off the built
 * transaction.
 */

const CURRENT_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const V1_FACTORY = '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB';
const V2_LEGACY_FACTORY = '0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8';
const CURRENT_SELECTOR = '0xf35abbcf';

const SRC = path.join(__dirname, '..', 'src');
const SCRIPTS = path.join(__dirname, '..', 'scripts');

function walk(dir: string, ext = '.ts'): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full, ext);
    return e.isFile() && full.endsWith(ext) ? [full] : [];
  });
}

describe('the registry is the only thing that decides where a launch goes', () => {
  it('exactly one deployment is executable, and it is the current v2', () => {
    const executable = DEPLOYMENTS.filter((d) => d.executable);
    expect(executable).toHaveLength(1);
    expect(executable[0].id).toBe('pons-v2-current-7ed');
    expect(executable[0].factory).toBe(CURRENT_FACTORY);
    expect(executableDeployment().factory).toBe(CURRENT_FACTORY);
  });

  it('v1 and the superseded v2 stay indexable, and stay non-executable', () => {
    const ids = indexableDeployments().map((d) => d.id);
    expect(ids).toContain('pons-v1');
    expect(ids).toContain('pons-v2-legacy-7e1');

    for (const id of ['pons-v1', 'pons-v2-legacy-7e1']) {
      const d = deploymentById(id);
      expect(d.executable).toBe(false);
      expect(d.supersededBy).toBe('pons-v2-current-7ed');
      // The knowledge needed to READ an old launch back must survive.
      expect(d.abiPath.length).toBeGreaterThan(0);
      expect(d.launchSelector).toMatch(/^0x[0-9a-f]{8}$/);
      expect(d.startBlock).toBeGreaterThan(0);
    }
    expect(deploymentById('pons-v1').factory).toBe(V1_FACTORY);
    expect(deploymentById('pons-v2-legacy-7e1').factory).toBe(V2_LEGACY_FACTORY);
  });
});

describe('no environment value can aim a launch at a superseded factory', () => {
  let chain: FakeChain;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['PONS_FACTORY_VERSION', 'PONS_FACTORY_ADDRESS'];

  beforeAll(async () => {
    const d = executableDeployment();
    // Real transport. The two reads `build()` makes are answered as the live factory
    // would answer them, so the launch is constructed rather than simulated.
    chain = await startFakeChain({
      calls: {
        // feeEscrow() -> the registry's escrow, so assertEscrowMatches passes
        '0xc4b7de97': ethers.zeroPadValue(d.feeEscrow, 32),
        // previewLaunchEconomics(uint256,address) -> an arbitrary bytes32 digest
        '0xf718b78c': ethers.zeroPadValue('0x01', 32),
      },
    });
  });

  afterAll(async () => {
    await chain.close();
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  /**
   * Every shape an operator, a stale `.env`, or an attacker-supplied variable could take.
   * `undefined` is in the list because the DEFAULT is what actually caused the two v1
   * launches -- nobody had to set anything wrong.
   */
  const HOSTILE_ENV: Array<[string, string | undefined]> = [
    ['unset', undefined],
    ['the legacy string v1', 'v1'],
    ['uppercase V1', 'V1'],
    ['padded v1', ' v1 '],
    ['empty', ''],
    ['nonsense', 'not-a-version'],
    ['the current value v2', 'v2'],
  ];

  it.each(HOSTILE_ENV)('createLaunchTarget with PONS_FACTORY_VERSION %s targets the current factory', (_label, value) => {
    if (value === undefined) delete process.env.PONS_FACTORY_VERSION;
    else process.env.PONS_FACTORY_VERSION = value;

    const provider = new ethers.JsonRpcProvider(chain.url, executableDeployment().chainId, {
      staticNetwork: true,
    });
    const target = createLaunchTarget(provider);

    expect(target.deployment.id).toBe('pons-v2-current-7ed');
    expect(target.deployment.executable).toBe(true);
    expect(target.factoryAddress).toBe(CURRENT_FACTORY);
    expect(target.factoryAddress).not.toBe(V1_FACTORY);
    expect(target.factoryAddress).not.toBe(V2_LEGACY_FACTORY);
  });

  it.each(HOSTILE_ENV)('a BUILT launch with PONS_FACTORY_VERSION %s has `to` = the current factory', async (_label, value) => {
    if (value === undefined) delete process.env.PONS_FACTORY_VERSION;
    else process.env.PONS_FACTORY_VERSION = value;

    const provider = new ethers.JsonRpcProvider(chain.url, executableDeployment().chainId, {
      staticNetwork: true,
    });
    const built = await createLaunchTarget(provider).build(
      {
        tokenName: 'PONSR STONKS',
        tokenSymbol: 'PSTONKS',
        description: '',
        splitterAddress: '0x0000000000000000000000000000000000000001',
        tweetId: '1234567890',
        pairAsset: {
          symbol: 'ETH',
          address: '0x0000000000000000000000000000000000000000',
        } as never,
      },
      500000000000000n
    );

    // The field that decides where the money goes.
    expect(built.to).toBe(CURRENT_FACTORY);
    expect(built.data.slice(0, 10)).toBe(CURRENT_SELECTOR);
    expect(built.to.toLowerCase()).not.toBe(V1_FACTORY.toLowerCase());
    expect(built.to.toLowerCase()).not.toBe(V2_LEGACY_FACTORY.toLowerCase());
  });

  it('an arbitrary PONS_FACTORY_ADDRESS cannot influence the built target', async () => {
    const attacker = '0x000000000000000000000000000000000000dEaD';
    process.env.PONS_FACTORY_ADDRESS = attacker;
    delete process.env.PONS_FACTORY_VERSION;

    const provider = new ethers.JsonRpcProvider(chain.url, executableDeployment().chainId, {
      staticNetwork: true,
    });
    const built = await createLaunchTarget(provider).build(
      {
        tokenName: 'PONSR STONKS',
        tokenSymbol: 'PSTONKS',
        description: '',
        splitterAddress: '0x0000000000000000000000000000000000000001',
        tweetId: '1234567890',
        pairAsset: {
          symbol: 'ETH',
          address: '0x0000000000000000000000000000000000000000',
        } as never,
      },
      500000000000000n
    );

    expect(built.to).toBe(CURRENT_FACTORY);
    expect(built.to.toLowerCase()).not.toBe(attacker.toLowerCase());
  });
});

describe('the second source of truth is gone from the source, not merely defaulted', () => {
  /**
   * Comments are stripped before searching, deliberately.
   *
   * This repository keeps a TOMBSTONE where a removed setting used to be -- see
   * PONS_V2_FACTORY_ADDRESS and PONS_V2_APPROVALS_FROM_BLOCK -- because the next person
   * reaching for an obvious-looking name should find out why it is gone rather than
   * reinvent it. What must not survive is anything that READS the value. So the rule is
   * "no executable reference", not "the characters never appear".
   */
  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it.each([
    ['PONS_FACTORY_VERSION'],
    ['PONS_FACTORY_ADDRESS'],
    ['PONS_LOCKER_ADDRESS'],
  ])('%s has no executable reference left in src or scripts', (name) => {
    const offenders = [...walk(SRC), ...walk(SCRIPTS)]
      .filter((f) => stripComments(fs.readFileSync(f, 'utf8')).includes(name))
      .map((f) => path.relative(path.join(__dirname, '..'), f));

    // Named, so a failure says which file rather than only that one exists.
    expect(offenders).toEqual([]);
  });

  it.each([
    ['PONS_FACTORY_VERSION'],
    ['PONS_FACTORY_ADDRESS'],
    ['PONS_LOCKER_ADDRESS'],
  ])('.env.example carries no %s assignment, live or commented out', (name) => {
    const text = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    // A commented-out assignment is one keystroke from being a live one, so both are
    // refused; prose explaining the removal is not.
    expect(text).not.toMatch(new RegExp(`^\\s*#?\\s*${name}\\s*=`, 'm'));
  });

  it('no financial or signer-capable module constructs a v1 launch target', () => {
    const files = [...walk(SRC), ...walk(SCRIPTS)];
    const offenders = files
      .filter((f) => /new V1Target|class V1Target/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(path.join(__dirname, '..'), f));
    expect(offenders).toEqual([]);
  });

  it('no comment still describes v1 as a selectable rollback path', () => {
    // Rollback is an exact previous image, not runtime routing to a superseded factory.
    // A comment saying otherwise is an instruction to the next person to re-open this.
    const files = [...walk(SRC), ...walk(SCRIPTS)];
    const offenders = files
      .filter((f) => /v1 stays selectable|Rollback is v1|v1 (?:is |remains )?still selectable/i.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(path.join(__dirname, '..'), f));
    expect(offenders).toEqual([]);
  });
});
