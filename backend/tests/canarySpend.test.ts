import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { admitCanarySpend, parseBotSpentWei } from '../src/canarySpend';
import { CanaryJournal } from '../src/canaryJournal';

/**
 * The canary spends the same treasury the bot spends, and must answer to the same cap.
 *
 * `phase-b-launch.ts` checked balance, the per-launch fee ceiling and a gas reserve. None
 * of those is the circuit breaker. The breaker is a rolling 24-hour total, and it exists
 * because Part 5's audit concluded that an attacker does not need to steal anything -- only
 * to make the bot spend. An operator script that ignores it is a second spender against
 * one budget, and the plan's line about the canary "fitting inside the cap" was an
 * assertion nobody had made the code check.
 *
 * WHAT CANNOT BE ACHIEVED HERE, STATED IN TESTS RATHER THAN OMITTED
 * ----------------------------------------------------------------
 * The bot's ledger lives in SQLite on the Fly volume; the canary runs on the operator's
 * machine. There is no shared transaction, so there is no atomic reservation across both.
 * What IS available is the bot's own accounted spend over an unauthenticated read, which
 * is the authoritative number rather than a guess. The residual race is real and is named
 * in `admitCanarySpend`'s result so it lands in the operator's output instead of a
 * comment nobody opens.
 */

const CAP = 10_000_000_000_000_000n; // 0.01 ETH
const FEE = 500_000_000_000_000n; // 0.0005 ETH

describe('the canary answers to the daily spend cap', () => {
  it('admits when the fee fits inside the remaining capacity', () => {
    const r = admitCanarySpend({ botSpentWei: 0n, journalSpentWei: 0n, feeWei: FEE, capWei: CAP });
    expect(r.admitted).toBe(true);
    expect(r.remainingAfterWei).toBe(CAP - FEE);
  });

  it('counts the bot ledger and the canary journal against one budget', () => {
    const r = admitCanarySpend({
      botSpentWei: 9_000_000_000_000_000n,
      journalSpentWei: 400_000_000_000_000n,
      feeWei: FEE,
      capWei: CAP,
    });
    expect(r.admitted).toBe(true);
    expect(r.remainingAfterWei).toBe(100_000_000_000_000n);
  });

  /** Exactly at the cap admits: the existing breaker refuses only what EXCEEDS it. */
  it('admits at the exact boundary, matching the production breaker', () => {
    const r = admitCanarySpend({ botSpentWei: CAP - FEE, journalSpentWei: 0n, feeWei: FEE, capWei: CAP });
    expect(r.admitted).toBe(true);
    expect(r.remainingAfterWei).toBe(0n);
  });

  it('refuses one wei over', () => {
    const r = admitCanarySpend({ botSpentWei: CAP - FEE + 1n, journalSpentWei: 0n, feeWei: FEE, capWei: CAP });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/cap/i);
  });

  /**
   * An unreadable bot ledger is not zero.
   *
   * Treating "could not ask" as "nothing spent" is the same error the Turnkey verifier
   * made when it reported a quota failure as a policy denial, and it fails in the
   * expensive direction: it would admit a canary on top of a full day of bot spending.
   */
  it('refuses rather than assuming zero when the bot ledger cannot be read', () => {
    const r = admitCanarySpend({ botSpentWei: null, journalSpentWei: 0n, feeWei: FEE, capWei: CAP });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/could not|unavailable|unknown/i);
  });

  /** The gap that cannot be closed from here must be reported, not buried. */
  it('always names the cross-process race it cannot eliminate', () => {
    const r = admitCanarySpend({ botSpentWei: 0n, journalSpentWei: 0n, feeWei: FEE, capWei: CAP });
    expect(r.caveat).toMatch(/not atomic|race|separate/i);
  });
});

describe('reading the bot ledger from its own status page', () => {
  it('extracts the accounted spend the bot reports', () => {
    expect(parseBotSpentWei('0.0030 ETH of 0.0100 ETH spent today (30%), 3 launch(es)')).toBe(
      3_000_000_000_000_000n
    );
    expect(parseBotSpentWei('0.0000 ETH of 0.0100 ETH spent today (0%), 0 launch(es)')).toBe(0n);
  });

  /** Null, never zero, when the shape is not what was expected. */
  it('returns null rather than zero on an unrecognised detail string', () => {
    expect(parseBotSpentWei('spend ledger unavailable')).toBeNull();
    expect(parseBotSpentWei('')).toBeNull();
  });
});

describe('the fee is recorded exactly once, whatever the outcome', () => {
  let dir: string;
  let j: CanaryJournal;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-spend-'));
    j = new CanaryJournal(path.join(dir, 'canary.sqlite'), { allowEphemeral: true });
  });
  afterEach(() => {
    j.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const prep = () => ({
    runId: 'r1', op: 'token_launch' as const, deploymentId: 'pons-v2-current-7ed', chainId: 4663,
    to: '0xfactory', value: FEE, calldata: '0xf35abbcf',
  });

  it('records the fee on a reconciled launch', () => {
    const id = j.prepare(prep());
    j.bindHash(id, '0xabc');
    j.recordReceipt(id, { status: 1 });
    expect(j.recordFee(id, FEE)).toBe(true);
    expect(j.recordedFeeTotalWei()).toBe(FEE);
  });

  /** A landed-but-unreconciled launch spent the fee just as surely. */
  it('records the fee on an unreconciled launch too', () => {
    const id = j.prepare(prep());
    j.bindHash(id, '0xabc');
    j.recordReceipt(id, { status: 1 });
    j.markIncident(id, { problems: ['mismatch'], token: null });
    expect(j.recordFee(id, FEE)).toBe(true);
    expect(j.recordedFeeTotalWei()).toBe(FEE);
  });

  it('does not double-count when recovery runs again', () => {
    const id = j.prepare(prep());
    j.bindHash(id, '0xabc');
    j.recordReceipt(id, { status: 1 });
    j.recordFee(id, FEE);
    expect(j.recordFee(id, FEE)).toBe(false);
    expect(j.recordedFeeTotalWei()).toBe(FEE);
  });

  /**
   * A reverted launch consumed gas, not the fee.
   *
   * Recording the fee would overstate the day's spend and refuse launches that the cap
   * actually permits. Recording nothing at all would let a revert loop burn gas invisibly,
   * so the gas stays separately observable rather than being folded into zero.
   */
  it('records no launch fee for a reverted receipt', () => {
    const id = j.prepare(prep());
    j.bindHash(id, '0xabc');
    j.recordReceipt(id, { status: 0 });
    expect(j.byId(id)!.state).toBe('receipt_reverted');
    expect(j.recordedFeeTotalWei()).toBe(0n);
  });
});
