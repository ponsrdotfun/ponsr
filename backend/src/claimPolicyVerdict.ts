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
 *
 * TWO POLICY SHAPES, AND THE MIGRATION BETWEEN THEM
 * -------------------------------------------------
 * The first rule binds an ADDRESS LIST: the two splitters whose creator is the
 * owner. Narrow, and it does not cover a splitter that does not exist yet -- so
 * the next launch's creator presses collect and is told the policy refuses.
 *
 * The replacement binds the SELECTOR, `claimAndSplit(address)`, and covers every
 * splitter there will ever be. It is looser about where a call may be aimed and
 * TIGHTER about what may be sent: the address list permits any zero-value call
 * to those two contracts, including the native `withdraw()` that pays
 * `msg.sender`.
 *
 * Two probes tell the rules apart, because their expected outcomes are
 * OPPOSITE under each:
 *
 *   - a claim to an UNLISTED splitter   -- denied by the list, allowed by the selector
 *   - a WRONG selector to a listed one  -- allowed by the list, denied by the selector
 *
 * While both policies exist, each of those is allowed by one rule or the other,
 * and no probe can say which. That intermediate state has its own mode and its
 * own honest verdict, because a ceremony that cannot describe its middle is one
 * that pretends the middle does not happen.
 */
import type { Outcome } from './turnkeyOutcome';

export interface ClaimProbeOutcomes {
  /** `claimAndSplit` to a splitter in the address list, no value. */
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
  /** A plain transfer elsewhere. Must be refused under every shape. */
  arbitraryDestination: Outcome;
  /** The launch path, which no migration may disturb. */
  currentFactory: Outcome;
  /**
   * `claimAndSplit` to a splitter that is NOT in the address list.
   *
   * This is what a future launch looks like: a real splitter, a real claim, and
   * an address no rule was written for. Denied by the list, allowed by the
   * selector -- so it is the probe that proves the migration actually happened.
   */
  claimToUnlistedSplitter: Outcome;
  /**
   * A DIFFERENT selector, sent to a listed splitter, no value.
   *
   * Allowed by the address list, which constrains nothing about calldata, and
   * denied by the selector rule. It measures the residual the list carries and
   * the selector removes.
   */
  wrongSelectorToSplitter: Outcome;
}

/** Which policy shape the signer is expected to be holding. */
export type PolicyShape = 'address-list' | 'both' | 'selector';

export type ClaimVerdict = 'pass' | 'not-yet' | 'unsafe' | 'inconclusive';

type Expectation = 'allowed' | 'denied';

const EXPECTED: Record<PolicyShape, Record<keyof ClaimProbeOutcomes, Expectation>> = {
  'address-list': {
    claimToSplitter: 'allowed',
    fundedClaim: 'denied',
    arbitraryDestination: 'denied',
    currentFactory: 'allowed',
    claimToUnlistedSplitter: 'denied',
    // Not a defect, a residual: the list says nothing about calldata.
    wrongSelectorToSplitter: 'allowed',
  },
  both: {
    claimToSplitter: 'allowed',
    fundedClaim: 'denied',
    arbitraryDestination: 'denied',
    currentFactory: 'allowed',
    // Granted by the selector rule -- this is the half that proves it exists.
    claimToUnlistedSplitter: 'allowed',
    // Still granted by the list. Nothing here can show the selector rule is
    // tight until the list is gone, and saying so is the point of this mode.
    wrongSelectorToSplitter: 'allowed',
  },
  selector: {
    claimToSplitter: 'allowed',
    fundedClaim: 'denied',
    arbitraryDestination: 'denied',
    currentFactory: 'allowed',
    claimToUnlistedSplitter: 'allowed',
    wrongSelectorToSplitter: 'denied',
  },
};

/**
 * A failure to ASK is never a denial.
 *
 * When Turnkey disabled signing org-wide over a quota, every probe failed and an
 * earlier script reported them all as denied, sending the operator to repair a
 * policy that was correct. An unknown outcome makes the whole run inconclusive,
 * and inconclusive is a distinct exit code from both pass and fail.
 */
export function classifyClaimPolicy(
  outcomes: ClaimProbeOutcomes,
  shape: PolicyShape = 'address-list'
): ClaimVerdict {
  const expected = EXPECTED[shape];
  const entries = Object.entries(outcomes) as [keyof ClaimProbeOutcomes, Outcome][];
  if (entries.some(([, o]) => o.kind === 'unknown')) return 'inconclusive';

  const wrong = entries.filter(([name, o]) => o.kind !== expected[name]);
  if (wrong.length === 0) return 'pass';

  /**
   * "Not yet" and "unsafe" are different facts and must not share an exit code.
   *
   * Before a rule exists the claim it would grant is refused, which is the
   * expected state of a system waiting on an owner -- nothing is wrong and
   * nothing needs repairing. Anything else wrong means an authority is open
   * that should not be, and that is not a state to wait out.
   *
   * Only a DENIAL where an allow was expected can be "not yet". An unexpected
   * ALLOW is never waiting for anybody.
   */
  const waiting: (keyof ClaimProbeOutcomes)[] = ['claimToSplitter', 'claimToUnlistedSplitter'];
  const onlyWaiting = wrong.every(
    ([name, o]) => waiting.includes(name) && o.kind === 'denied' && expected[name] === 'allowed'
  );
  return onlyWaiting ? 'not-yet' : 'unsafe';
}

export const EXIT_CODE: Record<ClaimVerdict, number> = {
  pass: 0,
  // Distinct from unsafe on purpose: an operator waiting on themselves should
  // not read the same code as an operator whose signer is too permissive.
  'not-yet': 3,
  unsafe: 1,
  inconclusive: 2,
};

export function expectationFor(
  name: keyof ClaimProbeOutcomes,
  shape: PolicyShape = 'address-list'
): Expectation {
  return EXPECTED[shape][name];
}

/** The shapes a caller may name, for a usage message that cannot drift. */
export const POLICY_SHAPES: PolicyShape[] = ['address-list', 'both', 'selector'];

export function resolvePolicyShape(argv: string[]): PolicyShape | { usage: string } {
  const flag = argv.find((a) => a.startsWith('--expect='));
  if (!flag) return 'address-list';
  const value = flag.slice('--expect='.length);
  if ((POLICY_SHAPES as string[]).includes(value)) return value as PolicyShape;
  return { usage: `--expect must be one of ${POLICY_SHAPES.join(', ')} (got ${JSON.stringify(value)})` };
}
