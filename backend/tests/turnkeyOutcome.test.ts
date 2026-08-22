import { classifyTurnkeyOutcome, describeOutcome } from '../src/turnkeyOutcome';

/**
 * Telling "the policy refused" apart from "nobody could ask".
 *
 * The verifier used to decide this with `/permission|policy|not authorized/i` against
 * the error message. Two things are wrong with that, and the second is the expensive
 * one:
 *
 *   - the word "policy" appears in Turnkey's quota message too, and in its docs URL,
 *     which every error carries;
 *   - a substring match is a guess about wording somebody else controls. When it guesses
 *     wrong it does not fail loudly -- it reports a denial that never happened, and an
 *     operator goes and "fixes" a policy that was correct. That happened here on
 *     2026-08-20.
 *
 * Turnkey returns structured fields. These fixtures are copied from real responses:
 * code 7 with a `PolicyEnginePermissionError` detail for a genuine refusal, code 8 for
 * an exhausted quota. Nothing below inspects prose.
 */

/** A real denial, captured from the live API on 2026-08-21. */
const REAL_DENIAL = Object.assign(new Error(
  "Turnkey error 7: You don't have sufficient permissions to take this action. Please add a " +
    'policy granting this user permissions. Learn more at ' +
    'https://docs.turnkey.com/concepts/policies/quickstart.'
), {
  name: 'TurnkeyRequestError',
  code: 7,
  details: [
    {
      '@type': 'type.googleapis.com/errors.v1.PolicyEnginePermissionError',
      message: 'No policies evaluated to outcome: Allow',
      policyEvaluations: [{ policyId: '897d432e-16f4-4a5e-b16e-42c365508ec6', outcome: 'OUTCOME_DENY' }],
    },
  ],
});

/** A real quota refusal, captured 2026-08-20. Note it says "policy" nowhere useful and
 *  yet the old substring rule classified it as a denial. */
const REAL_QUOTA = Object.assign(new Error(
  'Turnkey error 8: Resource exhausted: Signing is disabled because your organization is over ' +
    'its allotted quota. Please upgrade to a paid plan, or reach out to the Turnkey team.'
), { name: 'TurnkeyRequestError', code: 8, details: [] });

describe('classifyTurnkeyOutcome', () => {
  it('calls a policy-engine refusal a denial', () => {
    const o = classifyTurnkeyOutcome(REAL_DENIAL);
    expect(o.kind).toBe('denied');
  });

  it('records which policy denied it, so the refusal is actionable', () => {
    const o = classifyTurnkeyOutcome(REAL_DENIAL);
    expect(o.kind === 'denied' && o.detail).toMatch(/897d432e/);
  });

  /** The 2026-08-20 incident, as a test. */
  it('does NOT call an exhausted quota a denial', () => {
    const o = classifyTurnkeyOutcome(REAL_QUOTA);
    expect(o.kind).toBe('unknown');
  });

  it('does not let the word "policy" in a message establish anything', () => {
    // Every Turnkey error carries a link to /concepts/policies/. A classifier keyed on
    // prose sees that link in a network timeout and calls it a refusal.
    const timeout = Object.assign(new Error('socket hang up. See https://docs.turnkey.com/concepts/policies/'), {
      name: 'FetchError',
    });
    expect(classifyTurnkeyOutcome(timeout).kind).toBe('unknown');
  });

  it('treats an unauthenticated key as unknown, not as a policy denial', () => {
    // A wrong or revoked API key is a credential problem. Reporting it as "the policy
    // denied you" sends the operator to rewrite a rule that is fine.
    const unauth = Object.assign(new Error('Turnkey error 16: unauthenticated'), {
      name: 'TurnkeyRequestError',
      code: 16,
    });
    expect(classifyTurnkeyOutcome(unauth).kind).toBe('unknown');
  });

  it('treats a plain network failure as unknown', () => {
    expect(classifyTurnkeyOutcome(new Error('ECONNRESET')).kind).toBe('unknown');
  });

  it('needs the permission code, not merely a details array', () => {
    // code 7 is the claim; the detail type corroborates it. A malformed error carrying
    // neither must not be promoted to a denial.
    const vague = Object.assign(new Error('something went wrong'), {
      name: 'TurnkeyRequestError',
      details: [{ '@type': 'type.googleapis.com/errors.v1.SomethingElse' }],
    });
    expect(classifyTurnkeyOutcome(vague).kind).toBe('unknown');
  });
});

describe('describeOutcome', () => {
  it('marks an outcome that matches the expectation', () => {
    expect(describeOutcome({ kind: 'allowed' }, 'allowed')).toMatch(/ALLOWED/);
    expect(describeOutcome({ kind: 'denied', detail: 'x' }, 'denied')).toMatch(/denied/);
  });

  it('marks an outcome that contradicts the expectation', () => {
    expect(describeOutcome({ kind: 'allowed' }, 'denied')).toMatch(/❌/);
  });

  // The whole point: an unanswered question reads as unanswered, never as a pass and
  // never as a failure.
  it('never dresses an unknown as either', () => {
    const text = describeOutcome({ kind: 'unknown', detail: 'quota' }, 'denied');
    expect(text).toMatch(/UNKNOWN|not asked/i);
    expect(text).not.toMatch(/✅|❌/);
  });

  /**
   * A capability a design knowingly leaves open must not print as a failure.
   *
   * Option A binds `eth.tx.value` on the creation clause and deliberately leaves
   * initcode unbound, so a zero-value deploy of arbitrary code stays ALLOWED. Asserting
   * `denied` there put a red cross beside an outcome nobody intends to change -- and an
   * operator who learns that a correct run shows a failure is one who will not notice a
   * real one.
   */
  describe('residual', () => {
    it('reports an open residual as accepted, not as a failure', () => {
      const text = describeOutcome({ kind: 'allowed' }, 'residual');
      expect(text).toMatch(/ALLOWED/);
      expect(text).toMatch(/residual/i);
      expect(text).not.toMatch(/❌/);
    });

    it('treats a closed residual as better than required, not as a pass to rely on', () => {
      const text = describeOutcome({ kind: 'denied', detail: 'policy' }, 'residual');
      expect(text).toMatch(/denied/);
      expect(text).not.toMatch(/❌/);
    });

    it('still reports an unanswered residual as unanswered', () => {
      const text = describeOutcome({ kind: 'unknown', detail: 'quota' }, 'residual');
      expect(text).toMatch(/UNKNOWN|not asked/i);
      expect(text).not.toMatch(/✅|❌/);
    });

    /**
     * The abuse this type must never permit.
     *
     * `residual` exists to describe initcode. If the funded-creation case were ever
     * relabelled with it, the finding that the bot key can empty the hot wallet would
     * print as "accepted" and the probe would stop being evidence of anything.
     */
    it('does not soften a denial that is actually required', () => {
      expect(describeOutcome({ kind: 'allowed' }, 'denied')).toMatch(/❌/);
    });
  });
});

/**
 * The wrapper, which is how the first structured classifier still got it wrong.
 *
 * `@turnkey/ethers` catches the SDK's `TurnkeyRequestError` and rethrows a
 * `TurnkeyActivityError` carrying it as `.cause`. The outer error has no `code` and no
 * `details` -- only a stringified message -- so a classifier that inspects the top-level
 * object alone sees nothing structured and reports "could not ask".
 *
 * Measured: a genuine policy denial came back as INCONCLUSIVE through the signer path
 * while the same request classified correctly through the raw client. The refusal was
 * real; the tool could not see it.
 *
 * Walking `.cause` keeps the classification structured. Falling back to the message
 * would not.
 */
describe('errors wrapped by @turnkey/ethers', () => {
  /** Exactly the shape observed on 2026-08-21. */
  function wrapped(inner: Error) {
    return Object.assign(new Error('Failed to sign: ' + inner.message), {
      name: 'TurnkeyActivityError',
      activityId: 'a-1',
      activityStatus: 'ACTIVITY_STATUS_FAILED',
      activityType: 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2',
      cause: inner,
    });
  }

  it('finds a denial through the activity wrapper', () => {
    expect(classifyTurnkeyOutcome(wrapped(REAL_DENIAL)).kind).toBe('denied');
  });

  it('still refuses to call a wrapped quota error a denial', () => {
    expect(classifyTurnkeyOutcome(wrapped(REAL_QUOTA)).kind).toBe('unknown');
  });

  it('does not loop forever on a self-referential cause', () => {
    const loop: any = new Error('round and round');
    loop.cause = loop;
    expect(classifyTurnkeyOutcome(loop).kind).toBe('unknown');
  });

  it('reports the activity status when there is one, so a failure is traceable', () => {
    const o = classifyTurnkeyOutcome(wrapped(REAL_QUOTA));
    expect(o.kind === 'unknown' && o.detail).toMatch(/ACTIVITY_STATUS_FAILED|code 8/);
  });
});
