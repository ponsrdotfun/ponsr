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
    expect(normalizeCondition("eth.tx.to == '0xAbCd'")).toBe(normalizeCondition("eth.tx.to == '0xabcd'"));
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
   * The one that matters: calldata is case-sensitive in a way addresses are not, and a
   * selector comparison lowercased is a selector comparison that can collide.
   */
  it('refuses a calldata comparison rather than lowercasing it', () => {
    expect(() => normalizeCondition("eth.tx.data[0..10] == '0xF35ABBCF'")).toThrow(/case|calldata|data/i);
  });

  it('refuses a function-name comparison, where case is meaning', () => {
    // `launchToken` and `launchtoken` are different functions as far as an ABI is
    // concerned; treating them as one would match a rule that does not exist.
    expect(() => normalizeCondition("eth.tx.function_name == 'launchToken'")).toThrow(/case|function/i);
  });

  it('says what to do rather than only refusing', () => {
    try {
      normalizeCondition("eth.tx.data[0..10] == '0xF35ABBCF'");
      throw new Error('should have refused');
    } catch (e: any) {
      expect(e.message).toMatch(/case-sensitive|preserve/i);
    }
  });
});
