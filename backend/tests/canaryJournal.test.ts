import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CanaryJournal, CanaryOp } from '../src/canaryJournal';

/**
 * The record that survives the process.
 *
 * The canary broadcasts two irreversible transactions: a splitter deployment and a token
 * launch. Between `sendTransaction` returning and the receipt being read, the only
 * evidence that anything was attempted lives in a local variable. A crash there leaves an
 * operator who cannot answer the only question that matters -- did it land? -- and whose
 * cheapest way to find out is to run it again, which is the one thing that must not happen.
 *
 * A deterministic salt is not a substitute. It makes a duplicate launch REVERT rather than
 * succeed, which is a good backstop and a terrible record: the revert reason arrives long
 * after the second fee has been spent on gas, and it says PoolAlreadyExists whether the
 * first attempt was this operator or somebody else entirely.
 *
 * These tests describe crashes, because that is the only condition the journal exists for.
 */

const RUN = 'canary-PSTONKS-2026-08-24';
const DEPLOYMENT = 'pons-v2-current-7ed';
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';

function tmpJournal(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-canary-journal-'));
  return { dir, file: path.join(dir, 'canary.sqlite') };
}

const prepared = (op: CanaryOp = 'token_launch') => ({
  runId: RUN,
  op,
  deploymentId: DEPLOYMENT,
  chainId: 4663,
  to: op === 'splitter_deploy' ? '' : FACTORY,
  value: op === 'splitter_deploy' ? 0n : 500_000_000_000_000n,
  calldata: '0xf35abbcf' + 'ab'.repeat(32),
  tokenName: 'PONSR STONKS',
  tokenSymbol: 'PSTONKS',
  salt: '0x' + 'cd'.repeat(32),
  pairToken: '0x0000000000000000000000000000000000000000',
  splitterAddress: '0x9999999999999999999999999999999999999999',
});

describe('the canary journal records intent before it can be acted on', () => {
  let dir: string;
  let file: string;
  let j: CanaryJournal;

  beforeEach(() => {
    ({ dir, file } = tmpJournal());
    j = new CanaryJournal(file, { allowEphemeral: true });
  });
  afterEach(() => {
    j.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 1. Crash after prepared, before send. */
  it('leaves a prepared row with no hash, and reports it as unresolved', () => {
    const id = j.prepare(prepared());
    j.close();

    const reopened = new CanaryJournal(file, { allowEphemeral: true });
    const open = reopened.unresolved();
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(id);
    expect(open[0].state).toBe('prepared');
    expect(open[0].txHash).toBeNull();
    expect(open[0].calldata).toBe(prepared().calldata);
    reopened.close();
  });

  /** 2. Crash after send returns, before wait completes. */
  it('recovers the transaction hash bound the instant send returned', () => {
    const id = j.prepare(prepared());
    j.bindHash(id, '0xdeadbeef');
    j.close();

    const reopened = new CanaryJournal(file, { allowEphemeral: true });
    const row = reopened.unresolved()[0];
    expect(row.state).toBe('broadcast');
    expect(row.txHash).toBe('0xdeadbeef');
    reopened.close();
  });

  /** 3. Receipt never arrives. Ambiguous is a state, not an excuse to send again. */
  it('keeps a hash-bound row ambiguous and refuses a replacement payload', () => {
    const id = j.prepare(prepared());
    j.bindHash(id, '0xdeadbeef');

    expect(() => j.prepare(prepared())).toThrow(/unresolved/i);
    expect(j.unresolved()).toHaveLength(1);
    expect(j.unresolved()[0].id).toBe(id);
  });

  /** 4. Reverted is terminal. */
  it('records a reverted receipt as terminal, and does not reopen it', () => {
    const id = j.prepare(prepared());
    j.bindHash(id, '0xdeadbeef');
    j.recordReceipt(id, { status: 0 });
    expect(j.unresolved()).toHaveLength(0);
    expect(j.byId(id)!.state).toBe('receipt_reverted');
  });

  /** 5. Landed but unreconciled is durable, and is not failure. */
  it('records a landed-but-unreconciled launch as a confirmed incident', () => {
    const id = j.prepare(prepared());
    j.bindHash(id, '0xdeadbeef');
    j.recordReceipt(id, { status: 1 });
    j.markIncident(id, { problems: ['creatorFeeRecipient disagrees'], token: '0xtoken' });

    const row = j.byId(id)!;
    expect(row.state).toBe('confirmed_incident');
    expect(row.problems).toContain('creatorFeeRecipient disagrees');
    expect(row.txHash).toBe('0xdeadbeef');
    // An incident is unresolved: somebody still has to look at it.
    expect(j.unresolved().map((r) => r.id)).toContain(id);
  });

  /** 6. Recovery twice changes nothing. */
  it('is idempotent across repeated recovery passes', () => {
    const id = j.prepare(prepared());
    j.bindHash(id, '0xdeadbeef');
    j.recordReceipt(id, { status: 1 });
    j.markIncident(id, { problems: ['x'], token: null });

    // Serialised with a BigInt-aware replacer. The row carries `value` as a bigint and a
    // bare JSON.stringify throws on it, which failed this test for a reason that had
    // nothing to do with idempotency.
    const snap = () => JSON.stringify(j.byId(id), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const first = snap();
    j.recordReceipt(id, { status: 1 });
    j.markIncident(id, { problems: ['x'], token: null });
    expect(snap()).toBe(first);
  });

  /** 7. The same run cannot launch twice. */
  it('refuses a second launch for a run that already succeeded', () => {
    const id = j.prepare(prepared());
    j.bindHash(id, '0xdeadbeef');
    j.recordReceipt(id, { status: 1 });
    j.markConfirmed(id, { token: '0xtoken' });
    expect(j.unresolved()).toHaveLength(0);

    expect(() => j.prepare(prepared())).toThrow(/already/i);
  });

  /** A splitter deploy and a launch are different operations within one run. */
  it('allows the launch after the splitter deploy of the same run has settled', () => {
    const s = j.prepare(prepared('splitter_deploy'));
    j.bindHash(s, '0xsplitter');
    j.recordReceipt(s, { status: 1 });
    j.markConfirmed(s, { token: null });

    expect(() => j.prepare(prepared('token_launch'))).not.toThrow();
  });

  it('survives reopen with WAL and reports the same rows', () => {
    const id = j.prepare(prepared());
    j.bindHash(id, '0xdeadbeef');
    j.close();
    const reopened = new CanaryJournal(file, { allowEphemeral: true });
    expect(reopened.byId(id)!.txHash).toBe('0xdeadbeef');
    expect(reopened.integrityOk()).toBe(true);
    reopened.close();
  });

  /** The journal is operator state. It must never be written where a deploy erases it. */
  it('refuses an ephemeral container path', () => {
    expect(() => new CanaryJournal('/app/canary.sqlite')).toThrow(/ephemeral|durable/i);
  });
});
