import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import { config } from '../src/config';
import { deploymentById, executableDeployment } from '../src/deployments';
import { activeFactoryAddress } from '../src/chainClient';
import { createLaunchTarget } from '../src/launchTarget';
import { readCurrentReadiness } from '../src/currentReadiness';
import { splitterEscrowFor } from '../src/splitterDeployer';
import { NATIVE_ETH } from '../src/pairTokens';

/**
 * Nothing on the active current-V2 path may touch the factory pons replaced.
 *
 * This is the regression test for the defect that started the whole migration, written
 * so it cannot come back quietly. Ponsr read `0x7E1EAbd5…` for a week: an address that
 * resolved, answered every call, and returned confident answers about a contract nobody
 * launches through. Every individual guard was correct. All of them were aimed at the
 * wrong contract.
 *
 * Two kinds of check, because either alone is escapable:
 *
 *   RUNTIME  a provider that records every address actually contacted. Catches an
 *            indirect path -- a helper that resolves the legacy address at runtime --
 *            which no amount of source grepping would find.
 *   STATIC   the source of the modules on the active path. Catches a reference that
 *            exists but was not reached by this test's particular inputs, which is how
 *            dead code waits to be revived.
 */

const LEGACY = deploymentById('pons-v2-legacy-7e1');
const LEGACY_FACTORY = LEGACY.factory.toLowerCase();
const LEGACY_ESCROW = LEGACY.feeEscrow.toLowerCase();
const CURRENT = executableDeployment();

/**
 * A provider that answers plausibly and remembers who was asked.
 *
 * Every read returns something shaped like the current deployment, so the code under
 * test proceeds far enough to reveal which addresses it reaches for.
 */
function recordingProvider(): { provider: ethers.Provider; contacted: string[] } {
  const contacted: string[] = [];
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const abi = new ethers.Interface(
    JSON.parse(fs.readFileSync(path.join(__dirname, '../src', CURRENT.abiPath), 'utf8'))
  );

  const provider = {
    getCode: async (address: string) => {
      contacted.push(String(address).toLowerCase());
      // Bytes matching the registry, so identity verification passes and the code
      // proceeds instead of failing early and hiding later calls.
      return '0x' + 'ab'.repeat(10);
    },
    call: async (tx: { to?: string; data?: string }) => {
      contacted.push(String(tx.to ?? '').toLowerCase());
      const selector = String(tx.data ?? '').slice(0, 10);
      let name = '';
      try {
        name = abi.getFunctionName(selector);
      } catch {
        /* not a function this ABI knows */
      }
      switch (name) {
        case 'feeEscrow':
          return coder.encode(['address'], [CURRENT.feeEscrow]);
        case 'launchEnabled':
        case 'canLaunch':
        case 'approvedPairTokens':
          return coder.encode(['bool'], [true]);
        case 'whitelistedLaunchers':
          return coder.encode(['bool'], [false]);
        case 'launchConfigCount':
          return coder.encode(['uint256'], [1]);
        case 'launchFee':
          return coder.encode(['uint256'], [500_000_000_000_000n]);
        case 'previewLaunchEconomics':
          return coder.encode(['bytes32'], ['0x' + 'ab'.repeat(32)]);
        default:
          return coder.encode(['uint256'], [0]);
      }
    },
    getNetwork: async () => ({ chainId: BigInt(CURRENT.chainId), name: 'robinhood' }),
  } as unknown as ethers.Provider;

  return { provider, contacted };
}

describe('the legacy factory never enters the active current-V2 path', () => {
  const realVersion = process.env.PONS_FACTORY_VERSION;
  beforeEach(() => {
    process.env.PONS_FACTORY_VERSION = 'v2';
  });
  afterEach(() => {
    if (realVersion === undefined) delete process.env.PONS_FACTORY_VERSION; else process.env.PONS_FACTORY_VERSION = realVersion;
    jest.restoreAllMocks();
  });

  it('resolves the active factory to the executable deployment', () => {
    expect(activeFactoryAddress().toLowerCase()).toBe(CURRENT.factory.toLowerCase());
    expect(activeFactoryAddress().toLowerCase()).not.toBe(LEGACY_FACTORY);
  });

  it('binds the splitter to the current escrow, never the legacy one', () => {
    expect(splitterEscrowFor().toLowerCase()).toBe(CURRENT.feeEscrow.toLowerCase());
    expect(splitterEscrowFor().toLowerCase()).not.toBe(LEGACY_ESCROW);
  });

  it('contacts only the current factory while reading readiness', async () => {
    const { provider, contacted } = recordingProvider();
    await readCurrentReadiness(
      provider,
      '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa',
      0n,
      NATIVE_ETH,
      CURRENT
    );
    expect(contacted.length).toBeGreaterThan(0);
    expect(contacted).not.toContain(LEGACY_FACTORY);
    expect(contacted).not.toContain(LEGACY_ESCROW);
    expect(contacted).toContain(CURRENT.factory.toLowerCase());
  });

  it('contacts only the current factory while building a launch', async () => {
    const { provider, contacted } = recordingProvider();
    const built = await createLaunchTarget(provider).build(
      {
        tokenName: 'Regression',
        tokenSymbol: 'RGRS',
        description: null,
        splitterAddress: '0x1111111111111111111111111111111111111111',
        tweetId: 'no-legacy-1',
        pairAsset: {
          address: NATIVE_ETH,
          symbol: 'ETH',
          name: 'Ether',
          decimals: 18,
          graduationThreshold: null,
        },
      },
      500_000_000_000_000n
    );
    expect(contacted).not.toContain(LEGACY_FACTORY);
    expect(built.to.toLowerCase()).toBe(CURRENT.factory.toLowerCase());
    expect(built.data.slice(0, 10)).toBe(CURRENT.launchSelector);
  });
});

/**
 * The static half. A reference that this test's inputs did not reach is still a
 * reference, and dead code holding a superseded address is exactly what gets revived by
 * somebody who assumes it was kept for a reason.
 */
describe('no module on the active path names the legacy deployment', () => {
  const ACTIVE_MODULES = [
    'chainClient.ts',
    'launchTarget.ts',
    'currentReadiness.ts',
    'splitterDeployer.ts',
    'ponsV2CurrentEncoder.ts',
    'pairTokenSource.ts',
    'orchestrator.ts',
  ];

  /**
   * Operator scripts that move real money, held to the same rule.
   *
   * They live outside `src/`, which is exactly why they were missed. Both spend or
   * recover funds: `phase-b-launch.ts` performs a launch, and `collect-and-split-v2.ts`
   * claims a creator's fees. A launch script aimed at the superseded factory is a
   * landmine for the first person to run it, and the collector was worse -- it REFUSES
   * when a splitter's escrow differs from the configured one, and since the config
   * default is the legacy escrow while every current splitter binds the current one, it
   * would have refused every real claim while reporting the splitter as the wrong half.
   */
  const ACTIVE_SCRIPTS = ['phase-b-launch.ts', 'collect-and-split-v2.ts'];

  /** Comments are stripped first: these files deliberately explain what they used to
   *  read and why it was dangerous, and a check that cannot tell an explanation from an
   *  instruction forces the explanation out. That is how the reason for a guard is lost
   *  while the guard survives. */
  function stripComments(raw: string): string {
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
  }

  const codeOf = (file: string) =>
    stripComments(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'));

  for (const file of ACTIVE_SCRIPTS) {
    it(`scripts/${file} does not read the legacy config defaults`, () => {
      const code = stripComments(fs.readFileSync(path.join(__dirname, '../scripts', file), 'utf8'));
      expect(code).not.toMatch(/config\.PONS_V2_FACTORY_ADDRESS/);
      expect(code).not.toMatch(/config\.PONS_V2_FEE_ESCROW_ADDRESS/);
    });
  }

  for (const file of ACTIVE_MODULES) {
    it(`${file} does not hardcode the legacy factory or escrow`, () => {
      const code = codeOf(file).toLowerCase();
      expect(code).not.toContain(LEGACY_FACTORY);
      expect(code).not.toContain(LEGACY_ESCROW);
    });

    // The config defaults ARE the legacy addresses, so reading them is the same defect
    // wearing a different name. That is precisely how this happened: nobody wrote the
    // superseded address anywhere, they read a setting whose default was it.
    it(`${file} does not read the legacy config defaults`, () => {
      const code = codeOf(file);
      expect(code).not.toMatch(/config\.PONS_V2_FACTORY_ADDRESS/);
      expect(code).not.toMatch(/config\.PONS_V2_FEE_ESCROW_ADDRESS/);
    });
  }
});

/**
 * The setting that caused all of this, removed rather than merely unused.
 *
 * Nobody ever wrote `0x7E1EAbd5…` into a code path. They read
 * `config.PONS_V2_FACTORY_ADDRESS`, whose DEFAULT was it -- which is why every review
 * of the code looked clean and every guard was aimed at the wrong contract anyway.
 *
 * With the last reader gone the setting is harmless today and a loaded gun tomorrow: it
 * still parses, still resolves, and still hands back a superseded address to anyone who
 * reaches for the obvious-looking name. A default nobody reads is one import away from
 * being read again.
 */
describe('the config no longer ships a superseded address as a default', () => {
  it('does not define PONS_V2_FACTORY_ADDRESS at all', () => {
    const code = stripCommentsTop(fs.readFileSync(path.join(__dirname, '../src/config.ts'), 'utf8'));
    expect(code).not.toMatch(/PONS_V2_FACTORY_ADDRESS/);
  });

  it('does not define PONS_V2_FEE_ESCROW_ADDRESS at all', () => {
    const code = stripCommentsTop(fs.readFileSync(path.join(__dirname, '../src/config.ts'), 'utf8'));
    expect(code).not.toMatch(/PONS_V2_FEE_ESCROW_ADDRESS/);
  });

  it('holds no superseded address as any default', () => {
    const code = stripCommentsTop(
      fs.readFileSync(path.join(__dirname, '../src/config.ts'), 'utf8')
    ).toLowerCase();
    expect(code).not.toContain(LEGACY_FACTORY);
    expect(code).not.toContain(LEGACY_ESCROW);
  });
});

function stripCommentsTop(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

/**
 * The launch script verifies identity before it spends anything.
 *
 * `phase-b-launch.ts` is the script that would perform the first real launch on the
 * current factory. It read readiness through the older `getLaunchReadiness` helper --
 * which asks about permissions and nothing about identity -- and called `deploySplitter`
 * with no provider, so the pre-deploy guard did not run either.
 *
 * That left the one code path in this repository that spends real money as the only one
 * with no check that the contract on chain is the one the registry describes. The bot
 * has three; the script had none.
 *
 * A static check, deliberately. Running this script broadcasts transactions, so the test
 * for it cannot execute it -- what it can do is refuse to let the guard be dropped.
 */
describe('the operator launch script cannot skip the identity guard', () => {
  const code = stripCommentsTop(
    fs.readFileSync(path.join(__dirname, '../scripts/phase-b-launch.ts'), 'utf8')
  );

  it('asserts deployment identity somewhere before launching', () => {
    expect(code).toMatch(/assertDeploymentIdentity\(/);
  });

  it('hands deploySplitter a provider, so the pre-deploy check runs', () => {
    // Without a provider the guard inside deploySplitter is skipped entirely, and the
    // splitter -- the first durable artifact -- is deployed unchecked.
    expect(code).toMatch(/deploySplitter\([\s\S]{0,200}provider/);
  });
});
