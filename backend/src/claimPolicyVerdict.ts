/**
 * THE VERDICT ON THE CLAIM POLICY, SEPARATED FROM THE ASKING.
 *
 * The probe script needs Turnkey, a provider and a nonce. This does not, and it
 * is where every decision lives -- so the rules can be tested against synthetic
 * outcomes instead of against a live signer that is expensive to put into each
 * of the states that matter.
 *
 * The separation is not tidiness. `turnkey-verify-policy.ts` printed
 * `=== NOT SAFE YET ===` and then exited 0, because the verdict and the exit
 * code were computed in different places and one branch set neither. A gate
 * that reads "exit 0" was satisfied by the exact state it exists to catch.
 */
import type { Outcome } from './turnkeyOutcome';

export interface ClaimProbeOutcomes {
  /** `claimAndSplit` to a real splitter, no value. The thing being enabled. */
  claimToSplitter: Outcome;
  /**
   * The same call CARRYING VALUE.
   *
   * This is the drain path, and it is not obvious. A splitter's native
   * `withdraw()` pays `msg.sender`, so ETH that lands in a splitter can be
   * taken by whoever asks first -- the treasury would be funding a contract
   * that hands its balance to a stranger. Allowing a destination is not the
   * same as allowing a destination to be paid.
   */
  fundedClaim: Outcome;
  /** A plain transfer elsewhere. Must still be refused, or the widening was a blanket. */
  arbitraryDestination: Outcome;
  /** The launch path, which this change must not have disturbed. */
  currentFactory: Outcome;
}

export type ClaimVerdict = 'pass' | 'not-yet' | 'unsafe' | 'inconclusive';

const EXPECTED: Record<keyof ClaimProbeOutcomes, 'allowed' | 'denied'> = {
  claimToSplitter: 'allowed',
  fundedClaim: 'denied',
  arbitraryDestination: 'denied',
  currentFactory: 'allowed',
};

/**
 * A failure to ASK is never a denial.
 *
 * When Turnkey disabled signing org-wide over a quota, every probe failed and an
 * earlier script reported them all as denied, sending the operator to repair a
 * policy that was correct. An unknown outcome makes the whole run inconclusive,
 * and inconclusive is a distinct exit code from both pass and fail.
 */
export function classifyClaimPolicy(outcomes: ClaimProbeOutcomes): ClaimVerdict {
  const entries = Object.entries(outcomes) as [keyof ClaimProbeOutcomes, Outcome][];
  if (entries.some(([, o]) => o.kind === 'unknown')) return 'inconclusive';

  const wrong = entries.filter(([name, o]) => o.kind !== EXPECTED[name]);
  if (wrong.length === 0) return 'pass';

  /**
   * "Not yet" and "unsafe" are different facts and must not share an exit code.
   *
   * Before the policy exists the claim is refused, which is the expected state of
   * a system waiting on an owner -- nothing is wrong and nothing needs repairing.
   * Anything else wrong means an authority is open that should not be, and that
   * is not a state to wait out.
   */
  const onlyTheClaimIsRefused =
    wrong.length === 1 && wrong[0][0] === 'claimToSplitter' && wrong[0][1].kind === 'denied';
  return onlyTheClaimIsRefused ? 'not-yet' : 'unsafe';
}

export const EXIT_CODE: Record<ClaimVerdict, number> = {
  pass: 0,
  // Distinct from unsafe on purpose: an operator waiting on themselves should
  // not read the same code as an operator whose signer is too permissive.
  'not-yet': 3,
  unsafe: 1,
  inconclusive: 2,
};

export function expectationFor(name: keyof ClaimProbeOutcomes): 'allowed' | 'denied' {
  return EXPECTED[name];
}
