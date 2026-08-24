import { decideCanaryPhase, LANDED_BANNER, RECONCILED_BANNER, INCIDENT_BANNER, REVERTED_BANNER } from '../src/canaryReporting';

/**
 * What the canary is allowed to say, and when.
 *
 * The script printed `=== LAUNCHED ===` immediately after a status=1 receipt, thirteen
 * lines before `confirmCanaryLaunch` had run. A successful receipt is not a successful
 * launch: the factory record can name a different creator fee recipient, the receipt can
 * carry no event from the selected factory, or the record can be unreadable. In each of
 * those the transaction has landed, the fee is spent, and nobody yet knows what was
 * launched.
 *
 * Printing success there taught the operator to read the banner rather than the
 * reconciliation below it -- and the banner was the one line guaranteed to appear.
 *
 * The ordering is a pure function rather than a sequence of console.log calls so a test
 * can assert it deterministically. A regex over captured stdout would prove the strings
 * exist, not that they cannot be emitted in the wrong order.
 */

const outgoing = { to: '0xfactory', data: '0xf35abbcf', value: 500_000_000_000_000n };

describe('the canary never announces success before reconciliation', () => {
  it('reports a landed, not-yet-reconciled transaction in neutral language', () => {
    const r = decideCanaryPhase({ receiptStatus: 1, confirmation: null, txHash: '0xabc' });
    expect(r.phase).toBe('landed');
    expect(r.banner).toBe(LANDED_BANNER);
    expect(r.banner).not.toMatch(/LAUNCHED/);
    expect(r.final).toBe(false);
  });

  it('only reaches final success when the confirmation verdict is green', () => {
    const r = decideCanaryPhase({
      receiptStatus: 1,
      txHash: '0xabc',
      confirmation: { ok: true, problems: [], token: '0xtoken' },
    });
    expect(r.phase).toBe('reconciled');
    expect(r.banner).toBe(RECONCILED_BANNER);
    expect(r.final).toBe(true);
  });

  /** Landed + mismatch is an incident. Not a failure, and never a success. */
  it('calls a reconciliation mismatch an incident, not a failure', () => {
    const r = decideCanaryPhase({
      receiptStatus: 1,
      txHash: '0xabc',
      confirmation: { ok: false, problems: ['creatorFeeRecipient disagrees'], token: '0xtoken' },
    });
    expect(r.phase).toBe('incident');
    expect(r.banner).toBe(INCIDENT_BANNER);
    expect(r.final).toBe(false);
    expect(r.banner).not.toMatch(/FAILED|REVERTED/);
    // The evidence must survive: the fee is spent and the hash is the only handle on it.
    expect(r.evidence.txHash).toBe('0xabc');
    expect(r.evidence.problems).toContain('creatorFeeRecipient disagrees');
  });

  it('treats an unreadable factory record as an incident too', () => {
    const r = decideCanaryPhase({
      receiptStatus: 1,
      txHash: '0xabc',
      confirmation: { ok: false, problems: ['factory record unavailable'], token: null },
    });
    expect(r.phase).toBe('incident');
    expect(r.final).toBe(false);
  });

  /**
   * A reverted transaction never reaches landed language, let alone success.
   *
   * Asserted by identity against the other banners, not by a regex for the word
   * "LAUNCHED". The reverted banner says NOTHING WAS LAUNCHED, so a word match flags the
   * negation as readily as the claim -- the same trap that made the first version of the
   * `initcode is bound` guard fail on the sentence forbidding it.
   */
  it('never reports landed or success for a reverted receipt', () => {
    const r = decideCanaryPhase({ receiptStatus: 0, txHash: '0xabc', confirmation: null });
    expect(r.phase).toBe('reverted');
    expect(r.banner).toBe(REVERTED_BANNER);
    expect(r.final).toBe(false);
    expect([LANDED_BANNER, RECONCILED_BANNER, INCIDENT_BANNER]).not.toContain(r.banner);
  });

  it('never reports landed or success when there is no receipt at all', () => {
    const r = decideCanaryPhase({ receiptStatus: null, txHash: '0xabc', confirmation: null });
    expect(r.phase).toBe('reverted');
    expect(r.final).toBe(false);
  });

  /**
   * The ordering guard. A confirmation cannot promote a transaction that never landed,
   * which is the shape of the original defect inverted: success language decided before
   * the fact it depends on.
   */
  it('cannot be talked into success by a green verdict on a reverted receipt', () => {
    const r = decideCanaryPhase({
      receiptStatus: 0,
      txHash: '0xabc',
      confirmation: { ok: true, problems: [], token: '0xtoken' },
    });
    expect(r.phase).toBe('reverted');
    expect(r.final).toBe(false);
  });

  it('exposes the outgoing transaction as evidence on every non-final phase', () => {
    for (const status of [1, 0]) {
      const r = decideCanaryPhase({ receiptStatus: status, txHash: '0xabc', confirmation: null, outgoing });
      expect(r.evidence.txHash).toBe('0xabc');
      expect(r.evidence.outgoing).toEqual(outgoing);
    }
  });
});
