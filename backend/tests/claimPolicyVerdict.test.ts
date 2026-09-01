/**
 * THE VERDICT MUST NOT SAY "SAFE" ABOUT A QUESTION IT NEVER ASKED.
 *
 * Two failures in this repository's history are the reason each of these cases
 * exists. A quota outage made every Turnkey probe fail, and a script reported
 * them all as DENIED -- sending the operator to repair a policy that was
 * correct. And `turnkey-verify-policy.ts` printed NOT SAFE YET and exited 0,
 * because the verdict and the exit code were decided in different places.
 *
 * So both come from one function here, and the exit codes are asserted, not
 * just the words.
 */
import { classifyClaimPolicy, ClaimProbeOutcomes, EXIT_CODE } from '../src/claimPolicyVerdict';

const allowed = { kind: 'allowed' } as const;
const denied = { kind: 'denied', detail: 'policy' } as const;
const unknown = { kind: 'unknown', detail: 'quota exceeded' } as const;

const good: ClaimProbeOutcomes = {
  claimToSplitter: allowed,
  fundedClaim: denied,
  arbitraryDestination: denied,
  currentFactory: allowed,
};

describe('classifyClaimPolicy', () => {
  it('passes only when the claim is allowed and everything else probed is refused', () => {
    expect(classifyClaimPolicy(good)).toBe('pass');
    expect(EXIT_CODE.pass).toBe(0);
  });

  it('reports the pre-policy state as not-yet rather than as a fault', () => {
    const verdict = classifyClaimPolicy({ ...good, claimToSplitter: denied });
    expect(verdict).toBe('not-yet');
    // Distinct from unsafe: an operator waiting on themselves must not read the
    // same exit code as one whose signer is too permissive.
    expect(EXIT_CODE[verdict]).toBe(3);
    expect(EXIT_CODE[verdict]).not.toBe(EXIT_CODE.unsafe);
  });

  it('calls a funded claim unsafe, because a splitter pays whoever withdraws', () => {
    const verdict = classifyClaimPolicy({ ...good, fundedClaim: allowed });
    expect(verdict).toBe('unsafe');
    expect(EXIT_CODE[verdict]).toBe(1);
  });

  it('calls an open arbitrary destination unsafe even while the claim works', () => {
    expect(classifyClaimPolicy({ ...good, arbitraryDestination: allowed })).toBe('unsafe');
  });

  it('calls a broken launch path unsafe, because widening one authority can break another', () => {
    expect(classifyClaimPolicy({ ...good, currentFactory: denied })).toBe('unsafe');
  });

  it('never treats a failure to ask as a denial', () => {
    // Every probe unanswerable: the quota case, which was once reported as four
    // denials and a repair job that did not exist.
    const allUnknown: ClaimProbeOutcomes = {
      claimToSplitter: unknown,
      fundedClaim: unknown,
      arbitraryDestination: unknown,
      currentFactory: unknown,
    };
    expect(classifyClaimPolicy(allUnknown)).toBe('inconclusive');
    expect(EXIT_CODE.inconclusive).toBe(2);

    // And one unknown among three good answers is still inconclusive. It would
    // otherwise read as not-yet, which is a verdict about a policy nobody asked.
    expect(classifyClaimPolicy({ ...good, claimToSplitter: unknown })).toBe('inconclusive');
    // The dangerous direction too: an unaskable funded-claim probe must not be
    // silently counted as the denial we hoped for.
    expect(classifyClaimPolicy({ ...good, fundedClaim: unknown })).toBe('inconclusive');
  });

  it('does not call a state not-yet when something else is wrong as well', () => {
    // Both the claim refused AND an arbitrary destination open. The first half
    // looks like waiting; the second half means an authority is open, and the
    // verdict must follow the worse fact.
    expect(
      classifyClaimPolicy({ ...good, claimToSplitter: denied, arbitraryDestination: allowed })
    ).toBe('unsafe');
  });

  it('gives every verdict its own exit code', () => {
    const codes = Object.values(EXIT_CODE);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
