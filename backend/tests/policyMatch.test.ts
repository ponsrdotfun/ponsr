import { normalizeCondition, findEquivalentPolicy } from '../src/turnkeyPolicyMatch';

/**
 * Deciding whether the policy you want already exists.
 *
 * `turnkey-allow-v2-factory.ts` refuses to create a duplicate by comparing `policyName`.
 * A name is the one field that has nothing to do with what a policy permits. Two
 * failures follow from trusting it, in opposite directions:
 *
 *   - a policy with the RIGHT name and the WRONG condition reports "nothing to do", and
 *     the bot cannot sign for the factory it launches through. That already happened
 *     once: `ponsr-bot: launch on the v2 factory` names the SUPERSEDED deployment;
 *   - a policy with a different name and an identical condition is missed, so a
 *     duplicate is created and the next reader cannot tell which one is live.
 */

const BOT = 'user-abc';
const ORG = 'org-1';
const CURRENT = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';

const wanted = {
  organizationId: ORG,
  effect: 'EFFECT_ALLOW',
  consensus: `approvers.any(user, user.id == '${BOT}')`,
  condition: `eth.tx.to == '${CURRENT}'`,
};

describe('normalizeCondition', () => {
  it('ignores whitespace, which is not semantics', () => {
    expect(normalizeCondition("eth.tx.to   ==  '0xAB'")).toBe(normalizeCondition("eth.tx.to=='0xAB'"));
  });

  it('ignores address casing, because EVM addresses are case-insensitive', () => {
    // A REAL address, not a short stub. Only a full 20-byte literal is case
    // normalised, because that is the only literal whose case cannot carry
    // meaning -- four hex characters could be anything, including a selector.
    const checksummed = '0x18d1d206A042260aA86F2aF87a8bf7c959f899D5';
    expect(normalizeCondition(`eth.tx.to == '${checksummed}'`)).toBe(
      normalizeCondition(`eth.tx.to == '${checksummed.toLowerCase()}'`)
    );
  });

  it('does not treat different addresses as the same', () => {
    expect(normalizeCondition("eth.tx.to == '0xaa'")).not.toBe(normalizeCondition("eth.tx.to == '0xbb'"));
  });
});

describe('findEquivalentPolicy', () => {
  it('matches on meaning, whatever the policy is called', () => {
    const found = findEquivalentPolicy(
      [{ policyId: 'p1', policyName: 'something else entirely', ...wanted }],
      wanted
    );
    expect(found?.policyId).toBe('p1');
  });

  /** The one that bit: right name, superseded address. */
  it('does NOT match a same-named policy pointing somewhere else', () => {
    const found = findEquivalentPolicy(
      [
        {
          policyId: 'p2',
          policyName: 'ponsr-bot: launch on the v2 factory',
          ...wanted,
          condition: "eth.tx.to == '0x7e1eabd52ae29598e6483f72dcf1a70b14284db8'",
        },
      ],
      { ...wanted, policyName: 'ponsr-bot: launch on the v2 factory' } as any
    );
    expect(found).toBeUndefined();
  });

  it('does not match a DENY policy with the same condition', () => {
    // Same words, opposite meaning. Treating these as equivalent would skip creating an
    // allow rule because a deny rule already says the same thing about the same address.
    const found = findEquivalentPolicy(
      [{ policyId: 'p3', policyName: 'x', ...wanted, effect: 'EFFECT_DENY' }],
      wanted
    );
    expect(found).toBeUndefined();
  });

  it('does not match a policy scoped to a different user', () => {
    const found = findEquivalentPolicy(
      [{ policyId: 'p4', policyName: 'x', ...wanted, consensus: "approvers.any(user, user.id == 'somebody-else')" }],
      wanted
    );
    expect(found).toBeUndefined();
  });

  it('does not match across organizations', () => {
    const found = findEquivalentPolicy(
      [{ policyId: 'p5', policyName: 'x', ...wanted, organizationId: 'org-2' }],
      wanted
    );
    expect(found).toBeUndefined();
  });

  it('matches despite cosmetic differences in spacing and case', () => {
    const found = findEquivalentPolicy(
      [{ policyId: 'p6', policyName: 'x', ...wanted, condition: `eth.tx.to=='${CURRENT.toUpperCase().replace('0X', '0x')}'` }],
      wanted
    );
    expect(found?.policyId).toBe('p6');
  });
});

/**
 * Normalisation is scoped to what it was proven safe for.
 *
 * `normalizeCondition` lowercases the WHOLE expression. That is correct for the rules
 * that exist -- `eth.tx.to == '0x…'`, where EVM addresses are case-insensitive and two
 * scripts can submit the same rule with different checksum casing.
 *
 * It is not correct in general. The moment a condition carries a selector or calldata
 * comparison, lowercasing makes two DIFFERENT rules look identical, and this function's
 * job is to decide whether a rule already exists. Answering "yes" wrongly means the rule
 * somebody needs never gets created.
 *
 * So it refuses conditions it has not been shown to handle rather than guessing.
 */
describe('normalizeCondition refuses what it cannot safely compare', () => {
  it('handles the address-only rules it was written for', () => {
    expect(() => normalizeCondition("eth.tx.to == '0xAbCd'")).not.toThrow();
    expect(() => normalizeCondition("eth.tx.to == '0xaa' || eth.tx.to == ''")).not.toThrow();
  });

  it('accepts a chain id comparison, which is numeric', () => {
    expect(() => normalizeCondition("eth.tx.to == '0xaa' && eth.tx.chain_id == 4663")).not.toThrow();
  });

  it('accepts a value ceiling, also numeric', () => {
    expect(() => normalizeCondition("eth.tx.to == '0xaa' && eth.tx.value <= 2000000000000000")).not.toThrow();
  });

  /**
   * CALLDATA IS HANDLED NOW, AND ITS CASE IS PRESERVED.
   *
   * This function used to throw on any calldata comparison, and the refusal was
   * right when it was written: lowercasing the whole expression would make
   * `'0x56C937FC'` and `'0x56c937fc'` compare equal, and they are different
   * string comparisons at runtime -- only one matches what the node produces.
   * The comment predicted a selector rule would arrive next, and one did.
   *
   * Refusing it stopped being free the moment the signer held such a rule: the
   * inventory reported the whole organisation as NOT USABLE FOR MUTATION, and
   * the next step of the migration is a deletion. So the case is preserved
   * instead of the condition being refused.
   */
  it('normalises a calldata comparison instead of refusing it', () => {
    expect(() => normalizeCondition("eth.tx.data[0..10] == '0x56c937fc'")).not.toThrow();
    expect(normalizeCondition("eth.tx.value == 0 && eth.tx.data[0..10] == '0x56c937fc'")).toBe(
      "eth.tx.value==0&&eth.tx.data[0..10]=='0x56c937fc'"
    );
  });

  it('does NOT make two selector casings compare equal', () => {
    // The exact collision the old refusal existed to prevent. These are
    // different rules: a node producing lowercase calldata matches one and not
    // the other, so an identity check that merged them would report a rule as
    // already in place when the one somebody needs does not exist.
    expect(normalizeCondition("eth.tx.data[0..10] == '0x56C937FC'")).not.toBe(
      normalizeCondition("eth.tx.data[0..10] == '0x56c937fc'")
    );
  });

  it('preserves case in a function name, where case is meaning', () => {
    // `launchToken` and `launchtoken` are different functions as far as an ABI
    // is concerned; merging them would match a rule that does not exist.
    expect(normalizeCondition("eth.tx.function_name == 'launchToken'")).not.toBe(
      normalizeCondition("eth.tx.function_name == 'launchtoken'")
    );
  });

  it('still lowercases the field names around a case-sensitive literal', () => {
    // Only what is inside quotes is protected. The expression itself is not
    // case-sensitive, and two rules differing only in field casing are one rule.
    expect(normalizeCondition("ETH.TX.DATA[0..10] == '0x56c937fc'")).toBe(
      normalizeCondition("eth.tx.data[0..10] == '0x56c937fc'")
    );
  });

  it('refuses an unterminated literal rather than binding an identity to a guess', () => {
    // The one case that still fails closed. Identity is what a deletion binds
    // to, so a condition whose quoting cannot be parsed must not produce one --
    // and a normalizer that can never refuse turns the inventory's
    // `condition-unnormalizable` guard into dead code.
    expect(() => normalizeCondition("eth.tx.to == '0xAbCd")).toThrow(/unterminated|parse/i);
  });
});
