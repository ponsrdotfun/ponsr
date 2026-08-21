/**
 * Whether a policy that does what you want already exists.
 *
 * WHY NOT COMPARE THE NAME
 * ------------------------
 * `turnkey-allow-v2-factory.ts` refused to create a duplicate by matching `policyName`,
 * which is the one field that has nothing to do with what a policy permits. It fails in
 * both directions, and this repository has already met one of them:
 *
 *   - RIGHT name, WRONG condition -> "nothing to do", and the bot cannot sign for the
 *     factory it actually launches through. `ponsr-bot: launch on the v2 factory` exists
 *     and names the SUPERSEDED deployment. Naming the new rule per deployment dodged the
 *     collision; it did not fix the comparison.
 *   - different name, identical condition -> a duplicate is created, and the next reader
 *     cannot tell which of the two is live. Wondering is how a policy gets deleted for
 *     being redundant when it is not.
 *
 * So equivalence is decided on the four fields that determine effect: organisation,
 * effect, who it applies to, and the normalised condition.
 */

export interface PolicyLike {
  policyId?: string;
  policyName?: string;
  organizationId?: string;
  effect?: string;
  consensus?: string;
  condition?: string;
}

/**
 * A condition reduced to what it means.
 *
 * Whitespace is formatting. Case matters for most strings but NOT for the hex addresses
 * that make up almost every condition here -- EVM addresses are case-insensitive, and
 * Turnkey stores whatever was sent, so the same rule submitted twice from two scripts
 * can differ only by checksum casing.
 *
 * Deliberately conservative: it lowercases and strips spaces, and does nothing clever.
 * It does not reorder `&&` operands or normalise `a == b` to `b == a`, because a
 * comparator that is wrong in the permissive direction silently skips creating a rule
 * somebody needs.
 */
export function normalizeCondition(condition: string | undefined): string {
  const raw = String(condition ?? '');

  // Refuse what this has not been shown to handle.
  //
  // Lowercasing the whole expression is correct for the rules that exist -- EVM
  // addresses are case-insensitive, and two scripts can submit the same rule with
  // different checksum casing. It is not correct in general: calldata and function names
  // carry meaning in their case, so lowercasing makes two DIFFERENT rules compare equal.
  //
  // This function decides whether a rule already exists. Answering "yes" wrongly means
  // the rule somebody needs never gets created -- and the rules likely to arrive next are
  // exactly the case-sensitive ones, since binding a selector is one of the proposed
  // closures for the funded-creation finding.
  if (/eth\.tx\.(data|function_name|contract_call_args)/i.test(raw)) {
    throw new Error(
      'normalizeCondition only handles address, chain-id and value comparisons. This ' +
        'condition compares calldata or a function name, where case is meaning: ' +
        raw.slice(0, 120) +
        ' -- preserve case-sensitive literals before comparing, rather than lowercasing.'
    );
  }

  return raw.replace(/\s+/g, '').toLowerCase();
}

/** Same for the consensus expression, which encodes which user the policy binds. */
function normalizeConsensus(consensus: string | undefined): string {
  return String(consensus ?? '').replace(/\s+/g, '');
}

/**
 * The existing policy equivalent to `wanted`, if there is one.
 *
 * All four fields must agree. `effect` in particular: an `EFFECT_DENY` rule carrying the
 * same condition is not a match but its exact opposite, and treating them as
 * interchangeable would skip creating an allow rule because a deny rule already
 * "mentions" the address.
 */
export function findEquivalentPolicy(
  existing: readonly PolicyLike[],
  wanted: PolicyLike
): PolicyLike | undefined {
  return existing.find(
    (p) =>
      String(p.organizationId ?? '') === String(wanted.organizationId ?? '') &&
      String(p.effect ?? '') === String(wanted.effect ?? '') &&
      normalizeConsensus(p.consensus) === normalizeConsensus(wanted.consensus) &&
      normalizeCondition(p.condition) === normalizeCondition(wanted.condition)
  );
}

/**
 * Policies that share a name but differ in meaning.
 *
 * Reported rather than acted on. A name collision is not an error -- Turnkey allows it --
 * but it is the exact shape of the confusion above, and an operator should see it before
 * a second rule appears in the dashboard under a name they already recognise.
 */
export function sameNameDifferentMeaning(
  existing: readonly PolicyLike[],
  wanted: PolicyLike
): PolicyLike[] {
  return existing.filter(
    (p) =>
      p.policyName === wanted.policyName &&
      normalizeCondition(p.condition) !== normalizeCondition(wanted.condition)
  );
}
