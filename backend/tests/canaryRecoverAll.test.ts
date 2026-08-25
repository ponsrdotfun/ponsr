import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ethers } from 'ethers';
import { CanaryJournal } from '../src/canaryJournal';
import { recoverCanary, CanaryRecoveryDeps } from '../src/canaryRecovery';
import { executableDeployment } from '../src/deployments';
import { splitterArtifactFor } from '../src/splitterDeployer';
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

/**
 * The REAL compiled runtime, not a hand-made blob carrying the right selectors.
 *
 * This fixture used to be `'0x60806040' + splitERC20 + claimAndSplit`, and it passed the
 * old selector-only check. The shared verifier refuses it, correctly: four bytes can sit
 * inside unrelated bytecode by accident or by construction, and "contains the selector" is
 * not "is the splitter". The fixture was proving the weak check worked.
 */
const GOOD_CODE = (splitterArtifactFor(D) as { deployedBytecode?: string }).deployedBytecode as string;

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

/**
 * Realistic 32-byte hashes, and every receipt fixture carries its OWN.
 *
 * These were short placeholders and the receipt objects had no hash at all, so a test could
 * not tell a receipt for this transaction from a receipt for another one -- which is exactly
 * the binding the recovery path now requires before it will account any gas.
 */
const TX_LAUNCH = "0xabababababababababababababababababababababababababababababababab";
const TX_DEPLOY = "0xdededededededededededededededededededededededededededededededede";

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
    readReceipt: async () => ({ status: 1, logs: [launchedLog(D.factory)], contractAddress: null, hash: TX_LAUNCH }),
    readLaunchRecord: async () => record(),
    readCode: async () => GOOD_CODE,
    treasuryAddress: TREASURY,
    ...over,
  });

  /** 1 — broadcast + successful receipt resumes the full confirmation. */
  it('confirms a broadcast launch row once the receipt is readable', async () => {
    const id = launchRow(j);
    j.bindHashLegacy(id, TX_LAUNCH);
    const r = await recoverCanary(j, deps());
    expect(r.find((x) => x.id === id)!.confirmed).toBe(true);
    expect(j.byId(id)!.state).toBe('confirmed');
  });

  /** 2 — a null receipt stays exactly where it was. */
  it('leaves a broadcast row ambiguous when no receipt can be read', async () => {
    const id = launchRow(j);
    j.bindHashLegacy(id, TX_LAUNCH);
    const r = await recoverCanary(j, deps({ readReceipt: async () => null }));
    expect(r.find((x) => x.id === id)!.confirmed).toBe(false);
    expect(j.byId(id)!.state).toBe('broadcast');
    expect(j.byId(id)!.txHash).toBe(TX_LAUNCH);
  });

  /** 3 — a row already at receipt_success resumes confirmation after a restart. */
  it('resumes confirmation from receipt_success', async () => {
    const id = launchRow(j);
    j.bindHashLegacy(id, TX_LAUNCH);
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
  /**
   * A reverted transaction still burned gas, so its cost is accounted BEFORE the row is
   * allowed to become terminal. Accounting it as zero would hand a retry under the same
   * deterministic run id the whole combined budget again.
   */
  it('records an actual reverted receipt as terminal, with its gas counted', async () => {
    const id = launchRow(j);
    j.bindHashLegacy(id, TX_LAUNCH);
    await recoverCanary(
      j,
      deps({
        readReceipt: async () => ({
          status: 0,
          logs: [],
          contractAddress: null,
          hash: TX_LAUNCH,
          gasUsed: 100_000n,
          gasPriceWei: 3_000_000_000n,
        }),
      })
    );
    const row = j.byId(id)!;
    expect(row.state).toBe('receipt_reverted');
    expect(row.actualGasCostWei).toBe(300_000_000_000_000n);
    // The reverted attempt counts against the run, so a retry cannot pretend it was free.
    expect(j.actualGasSpentWei(row.runId)).toBe(300_000_000_000_000n);
  });

  /** A mined receipt whose gas cannot be read is blocking, not quietly terminal. */
  it('refuses to make a reverted receipt terminal when its gas is unknown', async () => {
    const id = launchRow(j);
    j.bindHashLegacy(id, TX_LAUNCH);
    const out = await recoverCanary(
      j,
      deps({ readReceipt: async () => ({ status: 0, logs: [], contractAddress: null, hash: TX_LAUNCH }) })
    );
    expect(j.byId(id)!.state).toBe('confirmed_incident');
    expect(out[0].problems.join(' ')).toMatch(/UNKNOWN/);
    expect(j.actualGasSpentWei(j.byId(id)!.runId)).toBeNull();
  });

  /** 6 — terminal rows are not re-read, and nothing is counted twice. */
  it('makes no chain reads for terminal rows and adds no spend on a second pass', async () => {
    const id = launchRow(j);
    j.bindHashLegacy(id, TX_LAUNCH);
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
    j.bindHashLegacy(id, TX_LAUNCH);
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
    readReceipt: async () => ({ status: 1, logs: [], contractAddress: SPLITTER, hash: TX_DEPLOY }),
    readLaunchRecord: async () => record(),
    readCode: async () => GOOD_CODE,
    treasuryAddress: TREASURY,
    ...over,
  });

  /**
   * The artifact TEMPLATE is refused, and that is the correct answer.
   *
   * `deployedBytecode` carries zeros where the constructor writes creator, treasury, token
   * and escrow. A contract whose immutables are all zero is not a correctly deployed
   * splitter — it would send fees nowhere — so refusing it is right, and the earlier
   * version of this test asserted the opposite while feeding exactly that template.
   *
   * The green path needs a real deployment and is proven in
   * contracts-test/SplitterRuntime.test.js, which deploys the committed bytecode and reads
   * it back through eth_getCode.
   */
  it('refuses a splitter whose immutables are unset, template or not', async () => {
    const id = splitterRow(j);
    j.bindHashLegacy(id, TX_DEPLOY);
    await recoverCanary(j, deps());
    const row = j.byId(id)!;
    expect(row.state).toBe('confirmed_incident');
    expect(row.problems.join(' ')).toMatch(/immutable|creator|treasury|escrow/i);
  });

  /** 4 from finding 1 — landed, but the code is not what a splitter must be. */
  it('raises a durable incident when the deployed code lacks the interface', async () => {
    const id = splitterRow(j);
    j.bindHashLegacy(id, TX_DEPLOY);
    await recoverCanary(j, deps({ readCode: async () => '0x6080604052' }));
    expect(j.byId(id)!.state).toBe('confirmed_incident');
  });

  it('raises an incident when the receipt produced no contract address', async () => {
    const id = splitterRow(j);
    j.bindHashLegacy(id, TX_DEPLOY);
    await recoverCanary(j, deps({ readReceipt: async () => ({ status: 1, logs: [], contractAddress: null, hash: TX_LAUNCH }) }));
    expect(j.byId(id)!.state).toBe('confirmed_incident');
  });

  /** 7 from finding 1 — one splitter per run. */
  it('refuses a second splitter deployment for the same run', () => {
    const id = splitterRow(j);
    j.bindHashLegacy(id, TX_DEPLOY);
    j.recordReceipt(id, { status: 1 });
    j.markConfirmed(id, { token: null, splitterAddress: SPLITTER });
    expect(() => splitterRow(j)).toThrow(/already/i);
  });

  /** A splitter never records a launch fee: it costs gas and nothing else. */
  it('records no launch fee against a splitter row', () => {
    const id = splitterRow(j);
    j.bindHashLegacy(id, TX_DEPLOY);
    j.recordReceipt(id, { status: 1 });
    expect(() => j.recordFee(id, FEE)).toThrow(/token_launch/i);
  });
});

/**
 * A landed launch consumed the fee, whoever noticed and whenever.
 *
 * Ordinary execution recorded the fee right after receipt success. Recovery could advance a
 * broadcast or receipt_success row all the way to confirmed and never call recordFee at
 * all — so this sequence spent real money and freed the budget:
 *
 *   1. the launch receipt lands;
 *   2. the process dies after recordReceipt and before recordFee;
 *   3. recover:canary verifies and confirms;
 *   4. feeRecordedWei stays null;
 *   5. the rolling total omits a fee that was genuinely paid.
 *
 * Exactly-once accounting has to survive the crash, not just the happy path.
 */
describe('recovery records the launch fee exactly once', () => {
  let dir: string;
  let file: string;
  let j: CanaryJournal;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-recover-fee-'));
    file = path.join(dir, 'canary.sqlite');
    j = new CanaryJournal(file, { allowEphemeral: true });
  });
  afterEach(() => {
    j.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deps = (over: Partial<CanaryRecoveryDeps> = {}): CanaryRecoveryDeps => ({
    resolveDeployment: (id) => (id === D.id ? D : null),
    readReceipt: async () => ({ status: 1, logs: [launchedLog(D.factory)], contractAddress: null, hash: TX_LAUNCH }),
    readLaunchRecord: async () => record(),
    readCode: async () => '0x',
    treasuryAddress: TREASURY,
    ...over,
  });

  it('fills the fee when a crash left it unrecorded', async () => {
    const id = launchRow(j);
    j.bindHashLegacy(id, TX_LAUNCH);
    j.recordReceipt(id, { status: 1 });   // crashed here: fee never recorded
    expect(j.byId(id)!.feeRecordedWei).toBeNull();

    await recoverCanary(j, deps());
    expect(j.byId(id)!.state).toBe('confirmed');
    expect(j.byId(id)!.feeRecordedWei).toBe(FEE);
    expect(j.recordedFeeTotalWei()).toBe(FEE);
  });

  it('records the fee on a landed launch that does not reconcile', async () => {
    const id = launchRow(j);
    j.bindHashLegacy(id, TX_LAUNCH);
    await recoverCanary(j, deps({ readLaunchRecord: async () => null }));
    expect(j.byId(id)!.state).toBe('confirmed_incident');
    // The fee was spent whether or not anybody can say what was launched.
    expect(j.byId(id)!.feeRecordedWei).toBe(FEE);
  });

  it('adds nothing on a second recovery pass', async () => {
    const id = launchRow(j);
    j.bindHashLegacy(id, TX_LAUNCH);
    await recoverCanary(j, deps());
    await recoverCanary(j, deps());
    expect(j.recordedFeeTotalWei()).toBe(FEE);
  });

  it('records no fee for a reverted launch', async () => {
    const id = launchRow(j);
    j.bindHashLegacy(id, TX_LAUNCH);
    await recoverCanary(j, deps({ readReceipt: async () => ({ status: 0, logs: [], contractAddress: null, hash: TX_LAUNCH }) }));
    expect(j.byId(id)!.feeRecordedWei).toBeNull();
    expect(j.recordedFeeTotalWei()).toBe(0n);
  });

  it('records no fee while the receipt is still unknown', async () => {
    const id = launchRow(j);
    j.bindHashLegacy(id, TX_LAUNCH);
    await recoverCanary(j, deps({ readReceipt: async () => null }));
    expect(j.byId(id)!.feeRecordedWei).toBeNull();
  });

  /** A splitter costs gas, never the protocol fee. */
  it('records no launch fee against a recovered splitter', async () => {
    const id = splitterRow(j);
    j.bindHashLegacy(id, TX_DEPLOY);
    await recoverCanary(j, deps({ readReceipt: async () => ({ status: 1, logs: [], contractAddress: SPLITTER, hash: TX_DEPLOY }) }));
    expect(j.byId(id)!.feeRecordedWei).toBeNull();
    expect(j.recordedFeeTotalWei()).toBe(0n);
  });
});

/**
 * Getter evidence is required, and the operator command actually supplies it.
 *
 * The direct path read creator/treasury/token/escrow before confirming. Recovery declared
 * an optional `readSplitterBindings` and `recover-canary.ts` never passed one — so a crash
 * between the splitter receipt and the direct getter check was resolved on byte evidence
 * alone, while the round-4 report claimed the two paths shared an evidence contract.
 *
 * Optional was the real defect: a null read produced no problem, so weaker evidence looked
 * like agreement.
 */
describe('recovery requires the splitter to speak for itself', () => {
  let dir: string;
  let file: string;
  let j: CanaryJournal;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-bindings-'));
    file = path.join(dir, 'canary.sqlite');
    j = new CanaryJournal(file, { allowEphemeral: true });
  });
  afterEach(() => {
    j.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = (over: Partial<CanaryRecoveryDeps> = {}): CanaryRecoveryDeps => ({
    resolveDeployment: (id) => (id === D.id ? D : null),
    readReceipt: async () => ({ status: 1, logs: [], contractAddress: SPLITTER, hash: TX_DEPLOY }),
    readLaunchRecord: async () => record(),
    readCode: async () => GOOD_CODE,
    treasuryAddress: TREASURY,
    ...over,
  });

  it('leaves an incident when the getters cannot be read at all', async () => {
    const id = splitterRow(j);
    j.bindHashLegacy(id, TX_DEPLOY);
    await recoverCanary(j, base({ readSplitterBindings: async () => { throw new Error('RPC down'); } }));
    const row = j.byId(id)!;
    expect(row.state).toBe('confirmed_incident');
    expect(row.problems.join(' ')).toMatch(/getters could not be read|immutable/i);
  });

  it('leaves an incident when no getter reader is supplied at all', async () => {
    const id = splitterRow(j);
    j.bindHashLegacy(id, TX_DEPLOY);
    await recoverCanary(j, base());
    expect(j.byId(id)!.state).toBe('confirmed_incident');
  });

  /** A contract that names someone else's treasury is refused whatever the bytes say. */
  it('leaves an incident when a getter names a foreign address', async () => {
    const id = splitterRow(j);
    j.bindHashLegacy(id, TX_DEPLOY);
    await recoverCanary(
      j,
      base({
        readSplitterBindings: async () => ({
          creator: TREASURY,
          treasury: '0x000000000000000000000000000000000000dEaD',
          token: '0x0000000000000000000000000000000000000000',
          escrow: D.feeEscrow,
        }),
      })
    );
    expect(j.byId(id)!.state).toBe('confirmed_incident');
  });
});

/**
 * The operator command must wire what the contract requires.
 *
 * A source-level check, because instantiating recover-canary.ts needs a provider and a
 * journal on disk. It is a sentinel, not the proof — the behavioural proof is above — but
 * the omission it guards against was invisible for a whole review round.
 */
describe('the operator recovery command supplies the getter reader', () => {
  it('passes readSplitterBindings', () => {
    const src = fs.readFileSync(path.join(__dirname, '../scripts/recover-canary.ts'), 'utf8');
    expect(src).toMatch(/readSplitterBindings:/);
    expect(src).toMatch(/creator\(\)/);
    expect(src).toMatch(/treasury\(\)/);
    expect(src).toMatch(/token\(\)/);
    // v1 has no escrow, so asking one for it would fail a correct contract.
    expect(src).toMatch(/escrow-credit/);
  });
});
