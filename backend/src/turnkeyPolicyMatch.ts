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
  const stripped = raw.replace(/\s+/g, '');

  /**
   * Case is lowered where it cannot carry meaning, and preserved where it can.
   *
   * The whole expression used to be lowercased, which is right for the rules
   * that existed -- EVM addresses are case-insensitive and two scripts can
   * submit the same rule with different checksum casing. It is wrong the moment
   * a rule compares CALLDATA: `eth.tx.data[0..10] == '0x56C937FC'` and
   * `== '0x56c937fc'` are different string comparisons, and only one of them
   * matches what the node actually produces.
   *
   * So this function refused such conditions outright, and said in its own error
   * message what the fix would be. That refusal was written before any selector
   * rule existed and correctly predicted this one. It is now the rule the signer
   * holds, so refusing it means the inventory reports the organisation as
   * unusable for mutation -- and the next step in the migration IS a mutation.
   *
   * The rule now: strip whitespace, lowercase everything OUTSIDE quotes, and
   * inside quotes lowercase only a full 20-byte address, which is the one
   * literal whose case genuinely cannot matter. Every other literal is compared
   * exactly as written.
   */
  const ADDRESS_LITERAL = /^0x[0-9a-fA-F]{40}$/;
  let out = '';
  let index = 0;
  while (index < stripped.length) {
    const quote = stripped[index];
    if (quote !== "'" && quote !== '"') {
      out += stripped[index].toLowerCase();
      index += 1;
      continue;
    }
    const close = stripped.indexOf(quote, index + 1);
    if (close === -1) {
      /**
       * An unterminated literal is refused, and that refusal is the point.
       *
       * This function decides a policy's IDENTITY, and identity is what a
       * deletion is bound to. A condition whose quoting cannot be parsed is one
       * whose meaning cannot be established, so binding a mutation to it would
       * be binding to a guess.
       *
       * It also keeps the inventory's fail-closed path alive. Handling calldata
       * removed the only case that used to reach it; a normalizer that can never
       * refuse turns `condition-unnormalizable` into dead code, and a guard that
       * cannot fire is not a guard.
       */
      throw new Error(
        'normalizeCondition cannot parse a condition with an unterminated string ' +
          'literal, and will not bind an identity to a guess: ' +
          raw.slice(0, 120)
      );
    }
    const literal = stripped.slice(index + 1, close);
    out += quote + (ADDRESS_LITERAL.test(literal) ? literal.toLowerCase() : literal) + quote;
    index = close + 1;
  }
  return out;
}

/**
 * Same for the consensus expression, which encodes which user the policy binds.
 *
 * EXPORTED so the inventory projection uses THIS rule rather than a second one written
 * beside it. Two normalizers that agree today and drift tomorrow is how a policy gets
 * matched by one tool and missed by another.
 */
export function normalizeConsensus(consensus: string | undefined): string {
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
