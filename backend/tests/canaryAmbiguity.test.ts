import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CanaryJournal } from '../src/canaryJournal';
import { decideCanaryPhase, UNKNOWN_BANNER, REVERTED_BANNER } from '../src/canaryReporting';

/**
 * The difference between "it reverted" and "I did not see a receipt".
 *
 * The first implementation collapsed them. `sent.wait()` can return null, and the script
 * passed `status: receipt ? Number(receipt.status) : 0` — so a missing receipt became
 * status 0, which the journal treats as terminal `receipt_reverted`, which removes the row
 * from `unresolved()`, which unblocks the next run.
 *
 * That is the exact failure the journal was built to prevent, reintroduced one line below
 * the journal call. A launch may well have landed while the RPC blinked; recording it as
 * reverted invites a retry of a permanent, already-paid-for transaction, and the
 * deterministic salt means that retry burns gas to discover PoolAlreadyExists.
 *
 * Absence of evidence is not evidence of absence, and a state machine is exactly the place
 * that distinction has to be mechanical rather than remembered.
 */

const FEE = 500_000_000_000_000n;

function tmp(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-ambiguity-'));
  return { dir, file: path.join(dir, 'canary.sqlite') };
}

const prep = () => ({
  runId: 'r1',
  op: 'token_launch' as const,
  deploymentId: 'pons-v2-current-7ed',
  chainId: 4663,
  to: '0xfactory',
  value: FEE,
  calldata: '0xf35abbcf',
});

describe('a missing receipt is ambiguous, never reverted', () => {
  let dir: string;
  let file: string;
  let j: CanaryJournal;
  beforeEach(() => {
    ({ dir, file } = tmp());
    j = new CanaryJournal(file, { allowEphemeral: true });
  });
  afterEach(() => {
    j.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a hash-bound row nonterminal when no receipt arrives', () => {
    const id = j.prepare(prep());
    j.bindHashLegacy(id, '0xabc');
    j.recordReceipt(id, { status: null });

    const row = j.byId(id)!;
    expect(row.state).toBe('broadcast');
    expect(row.state).not.toBe('receipt_reverted');
    expect(row.txHash).toBe('0xabc');
  });

  it('keeps blocking a replacement after a missing receipt', () => {
    const id = j.prepare(prep());
    j.bindHashLegacy(id, '0xabc');
    j.recordReceipt(id, { status: null });

    expect(j.unresolved().map((r) => r.id)).toContain(id);
    expect(() => j.prepare(prep())).toThrow(/unresolved/i);
  });

  /** An actual status 0 IS terminal. The distinction is the whole point. */
  it('still records a real reverted receipt as terminal', () => {
    const id = j.prepare(prep());
    j.bindHashLegacy(id, '0xabc');
    j.recordReceipt(id, { status: 0 });
    expect(j.byId(id)!.state).toBe('receipt_reverted');
    expect(j.unresolved()).toHaveLength(0);
  });

  it('records no launch fee for an ambiguous receipt', () => {
    const id = j.prepare(prep());
    j.bindHashLegacy(id, '0xabc');
    j.recordReceipt(id, { status: null });
    expect(() => j.recordFee(id, FEE)).toThrow();
    expect(j.recordedFeeTotalWei()).toBe(0n);
  });
});

describe('the banner for a missing receipt says so', () => {
  it('reports unknown, not reverted, when there is no receipt', () => {
    const r = decideCanaryPhase({ receiptStatus: null, txHash: '0xabc', confirmation: null });
    expect(r.phase).toBe('unknown');
    expect(r.banner).toBe(UNKNOWN_BANNER);
    expect(r.final).toBe(false);
  });

  it('never tells the operator nothing was launched when nothing is known', () => {
    const r = decideCanaryPhase({ receiptStatus: null, txHash: '0xabc', confirmation: null });
    expect(r.banner).not.toBe(REVERTED_BANNER);
    expect(r.banner).toMatch(/UNKNOWN|PENDING/i);
  });

  /** The instruction matters as much as the label: do not retry. */
  it('preserves the hash, which is the only handle on an unknown transaction', () => {
    const r = decideCanaryPhase({ receiptStatus: null, txHash: '0xabc', confirmation: null });
    expect(r.evidence.txHash).toBe('0xabc');
  });

  it('still reports a real revert as reverted', () => {
    const r = decideCanaryPhase({ receiptStatus: 0, txHash: '0xabc', confirmation: null });
    expect(r.phase).toBe('reverted');
    expect(r.banner).toBe(REVERTED_BANNER);
  });
});
