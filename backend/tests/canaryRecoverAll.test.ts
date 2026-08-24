import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ethers } from 'ethers';
import { CanaryJournal } from '../src/canaryJournal';
import { recoverCanary, CanaryRecoveryDeps } from '../src/canaryRecovery';
import { executableDeployment } from '../src/deployments';
import { PONS_V2_CURRENT_ABI, buildCurrentV2LaunchCalldata, launchSalt } from '../src/ponsV2CurrentEncoder';

/**
 * Recovery has to reach every state the journal can be left in.
 *
 * The first version handled exactly one: `confirmed_incident`, and only for
 * `token_launch`. Every other unresolved state -- prepared, broadcast, receipt_success --
 * blocked the next run forever, because the script refuses to start while anything is
 * unresolved and nothing could advance those rows.
 *
 * So the journal preserved the evidence perfectly and then wedged the operator, and the
 * printed advice ("recover it read-only") named no command. There was none.
 *
 * Every case below is a crash. That is the only condition any of this exists for.
 */

const D = executableDeployment();
const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const SPLITTER = '0x9999999999999999999999999999999999999999';
const TOKEN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const NATIVE = '0x0000000000000000000000000000000000000000';
const FEE = 500_000_000_000_000n;
const iface = new ethers.Interface(PONS_V2_CURRENT_ABI);

const launchedLog = (address: string) => {
  const enc = iface.encodeEventLog('TokenLaunched', [TOKEN, CURVE, TREASURY, NATIVE, 0n, 0n]);
  return { address, topics: enc.topics, data: enc.data };
};

const calldata = () =>
  buildCurrentV2LaunchCalldata(
    {
      tokenName: 'PONSR STONKS', tokenSymbol: 'PSTONKS', logo: '', description: '',
      socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
      feeWallet: SPLITTER, launchConfigId: 0n, pairToken: NATIVE, creatorTaxBps: 0,
      buybackEnabled: false, expectedEconomics: '0x' + 'cd'.repeat(32),
      salt: launchSalt(D, 'canary-PSTONKS'),
    },
    FEE,
    D
  ).data;

const record = () => ({
  token: TOKEN, curve: CURVE, deployer: TREASURY,
  creatorFeeRecipient: SPLITTER, pairToken: NATIVE, exists: true,
});

/** Runtime code carrying the selectors the splitter must expose. */
const GOOD_CODE = '0x60806040' + ethers.id('splitERC20(address)').slice(2, 10) + ethers.id('claimAndSplit(address)').slice(2, 10);

function launchRow(j: CanaryJournal) {
  return j.prepare({
    runId: 'canary-PSTONKS', op: 'token_launch', deploymentId: D.id, chainId: D.chainId,
    to: D.factory, value: FEE, calldata: calldata(), splitterAddress: SPLITTER,
    tokenName: 'PONSR STONKS', tokenSymbol: 'PSTONKS',
  });
}

function splitterRow(j: CanaryJournal) {
  return j.prepare({
    runId: 'canary-PSTONKS', op: 'splitter_deploy', deploymentId: D.id, chainId: D.chainId,
    to: '', value: 0n, calldata: '0x6080604052' + 'ab'.repeat(20),
  });
}

describe('recovery advances every unresolved state', () => {
  let dir: string;
  let file: string;
  let j: CanaryJournal;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-recover-all-'));
    file = path.join(dir, 'canary.sqlite');
    j = new CanaryJournal(file, { allowEphemeral: true });
  });
  afterEach(() => {
    j.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deps = (over: Partial<CanaryRecoveryDeps> = {}): CanaryRecoveryDeps => ({
    resolveDeployment: (id) => (id === D.id ? D : null),
    readReceipt: async () => ({ status: 1, logs: [launchedLog(D.factory)], contractAddress: null }),
    readLaunchRecord: async () => record(),
    readCode: async () => GOOD_CODE,
    treasuryAddress: TREASURY,
    ...over,
  });

  /** 1 — broadcast + successful receipt resumes the full confirmation. */
  it('confirms a broadcast launch row once the receipt is readable', async () => {
    const id = launchRow(j);
    j.bindHash(id, '0xabc');
    const r = await recoverCanary(j, deps());
    expect(r.find((x) => x.id === id)!.confirmed).toBe(true);
    expect(j.byId(id)!.state).toBe('confirmed');
  });

  /** 2 — a null receipt stays exactly where it was. */
  it('leaves a broadcast row ambiguous when no receipt can be read', async () => {
    const id = launchRow(j);
    j.bindHash(id, '0xabc');
    const r = await recoverCanary(j, deps({ readReceipt: async () => null }));
    expect(r.find((x) => x.id === id)!.confirmed).toBe(false);
    expect(j.byId(id)!.state).toBe('broadcast');
    expect(j.byId(id)!.txHash).toBe('0xabc');
  });

  /** 3 — a row already at receipt_success resumes confirmation after a restart. */
  it('resumes confirmation from receipt_success', async () => {
    const id = launchRow(j);
    j.bindHash(id, '0xabc');
    j.recordReceipt(id, { status: 1 });
    await recoverCanary(j, deps());
    expect(j.byId(id)!.state).toBe('confirmed');
  });

  /** 4 — prepared with no hash is never called reverted, and never called safe to resend. */
  it('reports a never-bound intent without classifying it either way', async () => {
    const id = launchRow(j);
    const r = await recoverCanary(j, deps());
    const row = r.find((x) => x.id === id)!;
    expect(row.confirmed).toBe(false);
    expect(row.problems.join(' ')).toMatch(/never bound|no transaction hash/i);
    expect(j.byId(id)!.state).toBe('prepared');
    expect(j.byId(id)!.state).not.toBe('receipt_reverted');
  });

  /** A real revert is terminal and recovery says so. */
  it('records an actual reverted receipt as terminal', async () => {
    const id = launchRow(j);
    j.bindHash(id, '0xabc');
    await recoverCanary(j, deps({ readReceipt: async () => ({ status: 0, logs: [], contractAddress: null }) }));
    expect(j.byId(id)!.state).toBe('receipt_reverted');
  });

  /** 6 — terminal rows are not re-read, and nothing is counted twice. */
  it('makes no chain reads for terminal rows and adds no spend on a second pass', async () => {
    const id = launchRow(j);
    j.bindHash(id, '0xabc');
    j.recordReceipt(id, { status: 1 });
    j.recordFee(id, FEE);
    await recoverCanary(j, deps());

    let reads = 0;
    await recoverCanary(j, deps({ readReceipt: async () => { reads += 1; return null; } }));
    expect(reads).toBe(0);
    expect(j.recordedFeeTotalWei()).toBe(FEE);
  });

  /** 7 — the reason survives the process, rather than only reaching stdout. */
  it('persists the latest recovery reason durably', async () => {
    const id = launchRow(j);
    j.bindHash(id, '0xabc');
    await recoverCanary(j, deps({ readReceipt: async () => null }));
    j.close();

    const reopened = new CanaryJournal(file, { allowEphemeral: true });
    expect(reopened.byId(id)!.problems.join(' ')).toMatch(/receipt/i);
    reopened.close();
  });
});

describe('splitter rows are recovered by their own verifier', () => {
  let dir: string;
  let file: string;
  let j: CanaryJournal;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-recover-splitter-'));
    file = path.join(dir, 'canary.sqlite');
    j = new CanaryJournal(file, { allowEphemeral: true });
  });
  afterEach(() => {
    j.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deps = (over: Partial<CanaryRecoveryDeps> = {}): CanaryRecoveryDeps => ({
    resolveDeployment: (id) => (id === D.id ? D : null),
    readReceipt: async () => ({ status: 1, logs: [], contractAddress: SPLITTER }),
    readLaunchRecord: async () => record(),
    readCode: async () => GOOD_CODE,
    treasuryAddress: TREASURY,
    ...over,
  });

  /** 5 from finding 1 — an exactly-verified splitter can be reused, not redeployed. */
  it('confirms a landed splitter whose deployed code carries the required interface', async () => {
    const id = splitterRow(j);
    j.bindHash(id, '0xdeploy');
    await recoverCanary(j, deps());
    const row = j.byId(id)!;
    expect(row.state).toBe('confirmed');
    expect(row.splitterAddress!.toLowerCase()).toBe(SPLITTER.toLowerCase());
  });

  /** 4 from finding 1 — landed, but the code is not what a splitter must be. */
  it('raises a durable incident when the deployed code lacks the interface', async () => {
    const id = splitterRow(j);
    j.bindHash(id, '0xdeploy');
    await recoverCanary(j, deps({ readCode: async () => '0x6080604052' }));
    expect(j.byId(id)!.state).toBe('confirmed_incident');
  });

  it('raises an incident when the receipt produced no contract address', async () => {
    const id = splitterRow(j);
    j.bindHash(id, '0xdeploy');
    await recoverCanary(j, deps({ readReceipt: async () => ({ status: 1, logs: [], contractAddress: null }) }));
    expect(j.byId(id)!.state).toBe('confirmed_incident');
  });

  /** 7 from finding 1 — one splitter per run. */
  it('refuses a second splitter deployment for the same run', () => {
    const id = splitterRow(j);
    j.bindHash(id, '0xdeploy');
    j.recordReceipt(id, { status: 1 });
    j.markConfirmed(id, { token: null, splitterAddress: SPLITTER });
    expect(() => splitterRow(j)).toThrow(/already/i);
  });

  /** A splitter never records a launch fee: it costs gas and nothing else. */
  it('records no launch fee against a splitter row', () => {
    const id = splitterRow(j);
    j.bindHash(id, '0xdeploy');
    j.recordReceipt(id, { status: 1 });
    expect(() => j.recordFee(id, FEE)).toThrow(/token_launch/i);
  });
});
