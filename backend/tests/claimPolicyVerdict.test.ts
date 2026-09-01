/**
 * THE VERDICT MUST NOT SAY "SAFE" ABOUT A QUESTION IT NEVER ASKED.
 *
 * Two failures in this repository's history are why each of these exists. A
 * quota outage made every Turnkey probe fail, and a script reported them all as
 * DENIED -- sending the operator to repair a policy that was correct. And
 * `turnkey-verify-policy.ts` printed NOT SAFE YET and exited 0, because the
 * verdict and the exit code were decided in different places.
 *
 * The migration cases matter as much. Moving from an address list to a
 * selector-bound rule means a window where BOTH exist, and this repository has
 * already learned what that window costs: while two rules grant the same thing,
 * no probe can say which one is enforcing. The middle has its own mode here, so
 * a ceremony can describe its middle instead of pretending it does not happen.
 */
import { classifyClaimPolicy, ClaimProbeOutcomes, EXIT_CODE, resolvePolicyShape } from '../src/claimPolicyVerdict';

const allowed = { kind: 'allowed' } as const;
const denied = { kind: 'denied', detail: 'policy' } as const;
const unknown = { kind: 'unknown', detail: 'quota exceeded' } as const;

/** What a signer holding only the address-list rule actually answers. */
const addressList: ClaimProbeOutcomes = {
  claimToSplitter: allowed,
  fundedClaim: denied,
  arbitraryDestination: denied,
  currentFactory: allowed,
  claimToUnlistedSplitter: denied,
  // The list constrains nothing about calldata. Not a defect; a residual.
  wrongSelectorToSplitter: allowed,
};

/** What a signer holding only the selector rule answers. */
const selectorOnly: ClaimProbeOutcomes = {
  ...addressList,
  claimToUnlistedSplitter: allowed,
  wrongSelectorToSplitter: denied,
};

/** What a signer holding BOTH answers: each rule grants its own half. */
const both: ClaimProbeOutcomes = {
  ...addressList,
  claimToUnlistedSplitter: allowed,
  wrongSelectorToSplitter: allowed,
};

describe('classifyClaimPolicy', () => {
  it('passes each shape only against the answers that shape actually gives', () => {
    expect(classifyClaimPolicy(addressList, 'address-list')).toBe('pass');
    expect(classifyClaimPolicy(selectorOnly, 'selector')).toBe('pass');
    expect(classifyClaimPolicy(both, 'both')).toBe('pass');
    expect(EXIT_CODE.pass).toBe(0);
  });

  it('does not let one shape pass as another', () => {
    /**
     * An address-list signer measured against the selector target is UNSAFE,
     * not merely waiting, and the difference is worth stating.
     *
     * Two things deviate. The unlisted claim is refused, which is a wait. But
     * the wrong selector is ALLOWED, because the address list constrains
     * nothing about calldata -- that is a real open authority relative to the
     * end state, and an unexpected allow is never something anybody is coming
     * to close on its own.
     *
     * So the migration is not only about covering future launches. It also
     * removes a permission that exists today.
     */
    expect(classifyClaimPolicy(addressList, 'selector')).toBe('unsafe');
    // And it is emphatically not a pass, which is the assertion that would
    // matter most if the rule above were ever loosened.
    expect(classifyClaimPolicy(addressList, 'selector')).not.toBe('pass');
    // And a selector signer checked against the old expectations looks unsafe
    // for the right reason -- a denial that was supposed to be an allow is
    // waiting, but the wrong-selector probe flipping to denied is not.
    expect(classifyClaimPolicy(selectorOnly, 'address-list')).toBe('unsafe');
    // The intermediate is genuinely not the end state and must not read as one.
    expect(classifyClaimPolicy(both, 'selector')).toBe('unsafe');
  });

  it('reports a missing rule as not-yet rather than as a fault', () => {
    const verdict = classifyClaimPolicy({ ...addressList, claimToSplitter: denied }, 'address-list');
    expect(verdict).toBe('not-yet');
    expect(EXIT_CODE[verdict]).toBe(3);
    expect(EXIT_CODE[verdict]).not.toBe(EXIT_CODE.unsafe);
  });

  it('never calls an unexpected ALLOW a state to wait out', () => {
    // A denial where an allow was expected can be waiting on an owner. An allow
    // where a denial was expected is an open authority, and nobody is coming to
    // close it by itself.
    expect(classifyClaimPolicy({ ...addressList, fundedClaim: allowed }, 'address-list')).toBe('unsafe');
    expect(classifyClaimPolicy({ ...addressList, arbitraryDestination: allowed }, 'address-list')).toBe('unsafe');
    expect(classifyClaimPolicy({ ...selectorOnly, wrongSelectorToSplitter: allowed }, 'selector')).toBe('unsafe');
  });

  it('calls a funded claim unsafe under every shape, because a splitter pays whoever withdraws', () => {
    for (const shape of ['address-list', 'both', 'selector'] as const) {
      const base = shape === 'selector' ? selectorOnly : shape === 'both' ? both : addressList;
      expect(classifyClaimPolicy({ ...base, fundedClaim: allowed }, shape)).toBe('unsafe');
    }
  });

  it('calls a broken launch path unsafe, because widening one authority can break another', () => {
    expect(classifyClaimPolicy({ ...selectorOnly, currentFactory: denied }, 'selector')).toBe('unsafe');
  });

  it('never treats a failure to ask as a denial', () => {
    // Built from the real key set rather than typed out, so a probe added later
    // is covered by the quota case automatically instead of being forgotten.
    const allUnknown = Object.fromEntries(
      Object.keys(addressList).map((k) => [k, unknown])
    ) as unknown as ClaimProbeOutcomes;
    expect(classifyClaimPolicy(allUnknown, 'selector')).toBe('inconclusive');
    expect(EXIT_CODE.inconclusive).toBe(2);

    // One unknown among correct answers is still inconclusive. It would
    // otherwise read as pass, which is a verdict about a probe nobody asked.
    expect(classifyClaimPolicy({ ...selectorOnly, claimToSplitter: unknown }, 'selector')).toBe('inconclusive');
    // The dangerous direction too: an unaskable funded-claim probe must not be
    // silently counted as the denial we hoped for.
    expect(classifyClaimPolicy({ ...selectorOnly, fundedClaim: unknown }, 'selector')).toBe('inconclusive');
    // And the discriminating probe, which is the only evidence the migration
    // happened at all.
    expect(classifyClaimPolicy({ ...selectorOnly, claimToUnlistedSplitter: unknown }, 'selector')).toBe('inconclusive');
  });

  it('does not call a state not-yet when something else is wrong as well', () => {
    expect(
      classifyClaimPolicy(
        { ...addressList, claimToSplitter: denied, arbitraryDestination: allowed },
        'address-list'
      )
    ).toBe('unsafe');
  });

  it('gives every verdict its own exit code', () => {
    const codes = Object.values(EXIT_CODE);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('resolvePolicyShape', () => {
  it('defaults to the shape in force today', () => {
    expect(resolvePolicyShape([])).toBe('address-list');
    expect(resolvePolicyShape(['0x' + '1'.repeat(40)])).toBe('address-list');
  });

  it('accepts each named shape', () => {
    expect(resolvePolicyShape(['--expect=selector'])).toBe('selector');
    expect(resolvePolicyShape(['--expect=both'])).toBe('both');
    expect(resolvePolicyShape(['--expect=address-list'])).toBe('address-list');
  });

  it('refuses an unrecognised shape rather than falling back to a lenient default', () => {
    // A typo must not quietly verify against the OLD expectations and print
    // PASS. That is the same failure as a verifier reading the wrong factory
    // address and reporting four green ticks about the wrong contract.
    const result = resolvePolicyShape(['--expect=selectorr']);
    expect(typeof result).toBe('object');
    expect((result as any).usage).toContain('selectorr');
  });
});
