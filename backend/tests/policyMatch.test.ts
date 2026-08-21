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
