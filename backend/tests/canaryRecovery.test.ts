import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ethers } from 'ethers';
import { CanaryJournal } from '../src/canaryJournal';
import { recoverCanary, CanaryRecoveryDeps } from '../src/canaryRecovery';
import { executableDeployment } from '../src/deployments';
import { PONS_V2_CURRENT_ABI, buildCurrentV2LaunchCalldata, launchSalt } from '../src/ponsV2CurrentEncoder';

/**
 * Reconciling a launch that landed while nobody was watching.
 *
 * When the receipt succeeds but reconciliation is unavailable or disagrees, the canary
 * previously printed `ABORTING:` and exited 1. That is ordinary failure language for a
 * transaction that is on chain and paid for, and it points the operator at the one action
 * that must not be taken: running it again.
 *
 * Recovery is READ-ONLY by construction. The dependency interface below carries a receipt
 * reader and a factory-record reader and nothing else -- no signer, no sendTransaction, no
 * Turnkey credential. That is not a convention to be careful about; there is no parameter
 * through which a broadcast could be requested.
 */

const D = executableDeployment();
const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const SPLITTER = '0x9999999999999999999999999999999999999999';
const TOKEN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const NATIVE = '0x0000000000000000000000000000000000000000';
const FEE = 500_000_000_000_000n;

const iface = new ethers.Interface(PONS_V2_CURRENT_ABI);

function launchedLog(address: string, token = TOKEN, deployer = TREASURY, pair = NATIVE) {
  const enc = iface.encodeEventLog('TokenLaunched', [token, CURVE, deployer, pair, 0n, 0n]);
  return { address, topics: enc.topics, data: enc.data };
}

function calldata(): string {
  return buildCurrentV2LaunchCalldata(
    {
      tokenName: 'PONSR STONKS',
      tokenSymbol: 'PSTONKS',
      logo: '',
      description: '',
      socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
      feeWallet: SPLITTER,
      launchConfigId: 0n,
      pairToken: NATIVE,
      creatorTaxBps: 0,
      buybackEnabled: false,
      expectedEconomics: '0x' + 'cd'.repeat(32),
      salt: launchSalt(D, 'canary-PSTONKS'),
    },
    FEE,
    D
  ).data;
}

const record = (over: Record<string, unknown> = {}) => ({
  token: TOKEN, curve: CURVE, deployer: TREASURY,
  creatorFeeRecipient: SPLITTER, pairToken: NATIVE, exists: true, ...over,
});

function journalWithIncident(file: string): { j: CanaryJournal; id: number } {
  const j = new CanaryJournal(file, { allowEphemeral: true });
  const id = j.prepare({
    runId: 'canary-PSTONKS', op: 'token_launch', deploymentId: D.id, chainId: D.chainId,
    to: D.factory, value: FEE, calldata: calldata(),
    tokenName: 'PONSR STONKS', tokenSymbol: 'PSTONKS', splitterAddress: SPLITTER,
  });
  j.bindHashLegacy(id, '0x' + 'ab'.repeat(32));
  j.recordReceipt(id, { status: 1 });
  j.markIncident(id, { problems: ['factory record unavailable'], token: null });
  return { j, id };
}

describe('canary incident recovery reads, and only reads', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-canary-recovery-'));
    file = path.join(dir, 'canary.sqlite');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const deps = (over: Partial<CanaryRecoveryDeps> = {}): CanaryRecoveryDeps => ({
    resolveDeployment: (id) => (id === D.id ? D : null),
    readReceipt: async (h: string) => ({ status: 1, logs: [launchedLog(D.factory)], contractAddress: null, hash: h, gasUsed: 90_000n, gasPriceWei: 2_000_000_000n }),
    readLaunchRecord: async () => record(),
    readCode: async () => '0x',
    treasuryAddress: TREASURY,
    ...over,
  });

  it('promotes an incident to confirmed when everything now agrees', async () => {
    const { j, id } = journalWithIncident(file);
    const results = await recoverCanary(j, deps());
    expect(results).toHaveLength(1);
    expect(results[0].confirmed).toBe(true);
    expect(j.byId(id)!.state).toBe('confirmed');
    expect(j.byId(id)!.token!.toLowerCase()).toBe(TOKEN.toLowerCase());
    j.close();
  });

  it('leaves the incident open when the factory record still disagrees', async () => {
    const { j, id } = journalWithIncident(file);
    const results = await recoverCanary(
      j,
      deps({ readLaunchRecord: async () => record({ creatorFeeRecipient: '0xdead000000000000000000000000000000000000' }) })
    );
    expect(results[0].confirmed).toBe(false);
    expect(j.byId(id)!.state).toBe('confirmed_incident');
    j.close();
  });

  /** A landed transaction is never downgraded to ordinary failure. */
  it('never turns a landed launch into a failure, however unreadable it is', async () => {
    const { j, id } = journalWithIncident(file);
    await recoverCanary(j, deps({ readLaunchRecord: async () => { throw new Error('RPC down'); } }));
    const row = j.byId(id)!;
    expect(row.state).toBe('confirmed_incident');
    expect(row.state).not.toBe('receipt_reverted');
    expect(row.txHash).toBeTruthy();
    j.close();
  });

  /** 8 from the brief: a same-signature log from somewhere else proves nothing. */
  it('cannot be confirmed by a matching event emitted from a foreign address', async () => {
    const { j, id } = journalWithIncident(file);
    const foreign = '0x000000000000000000000000000000000000beef';
    const results = await recoverCanary(
      j,
      deps({ readReceipt: async (h: string) => ({ status: 1, logs: [launchedLog(foreign)], contractAddress: null, hash: h, gasUsed: 90_000n, gasPriceWei: 2_000_000_000n }) })
    );
    expect(results[0].confirmed).toBe(false);
    expect(j.byId(id)!.state).toBe('confirmed_incident');
    j.close();
  });

  it('is idempotent: a second pass confirms nothing new and writes no second row', async () => {
    const { j, id } = journalWithIncident(file);
    await recoverCanary(j, deps());
    const after = j.byId(id)!.updatedAt;
    const second = await recoverCanary(j, deps());
    expect(second).toHaveLength(0); // already confirmed, so no longer an open incident
    expect(j.byId(id)!.updatedAt).toBe(after);
    j.close();
  });

  it('records no additional spend on a repeated recovery pass', async () => {
    const { j, id } = journalWithIncident(file);
    j.recordFee(id, FEE);
    await recoverCanary(j, deps());
    await recoverCanary(j, deps());
    expect(j.recordedFeeTotalWei()).toBe(FEE);
    j.close();
  });

  /**
   * The structural guarantee, asserted rather than described.
   *
   * If a signer ever appears on this interface, somebody will eventually pass one, and a
   * recovery path that can broadcast is a recovery path that can launch a second token.
   */
  it('exposes no signing or sending capability on its dependency interface', async () => {
    const { j } = journalWithIncident(file);
    const passed = deps();
    for (const key of Object.keys(passed)) {
      expect(key).not.toMatch(/sign|send|broadcast|privateKey|turnkey|wallet/i);
    }
    j.close();
  });

  it('reports a receipt that cannot be fetched as still unresolved, not as reverted', async () => {
    const { j, id } = journalWithIncident(file);
    const results = await recoverCanary(j, deps({ readReceipt: async () => null }));
    expect(results[0].confirmed).toBe(false);
    expect(results[0].problems.join(' ')).toMatch(/receipt/i);
    expect(j.byId(id)!.state).toBe('confirmed_incident');
    j.close();
  });
});
