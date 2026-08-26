import { deploymentById, executableDeployment } from '../src/deployments';
import {
  InventorySnapshot,
  classifyCapabilities,
  projectPolicyInventory,
  renderInventory,
} from '../src/turnkeyInventory';
import { PolicyLike, normalizeCondition } from '../src/turnkeyPolicyMatch';

/**
 * NAMES ARE LABELS, NOT DELETION AUTHORITY.
 *
 * The inventory tool printed name, effect and condition. The ceremony's own rule is to
 * match "exact policy id plus normalized condition, effect and consensus" -- and the tool
 * could not produce any of the identity half, so the removal step had nothing to bind to.
 *
 * The data was always in the `getPolicies` response. Not printing it is worse than not
 * having it: the output looked like a complete inventory.
 */

const ORG = '87e2bc08-33eb-45bf-add6-f48e7a523772';
const CURRENT = executableDeployment().factory.toLowerCase();
const V1 = deploymentById('pons-v1').factory.toLowerCase();
const LEGACY = deploymentById('pons-v2-legacy-7e1').factory.toLowerCase();
const CONSENSUS = "approvers.any(user, user.id == '11111111-2222-3333-4444-555555555555')";

/** The three policies the live organisation actually carries. */
function baseline(): PolicyLike[] {
  return [
    {
      policyId: 'pol-aaa',
      policyName: 'ponsr-bot: v1 factory + zero-value splitter deploy',
      organizationId: ORG,
      effect: 'EFFECT_ALLOW',
      consensus: CONSENSUS,
      condition: `(eth.tx.to == '' && eth.tx.value == 0) || eth.tx.to == '${V1}'`,
    },
    {
      policyId: 'pol-bbb',
      policyName: 'ponsr-bot: launch on pons-v2-current-7ed',
      organizationId: ORG,
      effect: 'EFFECT_ALLOW',
      consensus: CONSENSUS,
      condition: `eth.tx.to == '${CURRENT}'`,
    },
    {
      policyId: 'pol-ccc',
      policyName: 'ponsr-bot: launch on the v2 factory',
      organizationId: ORG,
      effect: 'EFFECT_ALLOW',
      consensus: CONSENSUS,
      condition: `eth.tx.to == '${LEGACY}'`,
    },
  ];
}

const byId = (s: InventorySnapshot, id: string) => s.policies.find((p) => p.policyId === id)!;

describe('the inventory projects a bindable identity for every policy', () => {
  it('emits ids, organisation, effect, both conditions and both consensus forms', () => {
    const s = projectPolicyInventory(baseline(), ORG);
    expect(s.usableForMutation).toBe(true);
    expect(s.problems).toEqual([]);
    expect(s.policies.map((p) => p.policyId)).toEqual(['pol-aaa', 'pol-bbb', 'pol-ccc']);
    for (const p of s.policies) {
      expect(p.organizationId).toBe(ORG);
      expect(p.effect).toBe('EFFECT_ALLOW');
      expect(p.condition.length).toBeGreaterThan(0);
      expect(p.normalizedCondition).toBe(normalizeCondition(p.condition));
      expect(p.consensus).toBe(CONSENSUS);
      expect(p.normalizedConsensus.length).toBeGreaterThan(0);
      expect(p.identityDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('classifies the combined v1 rule as BOTH a v1 destination and zero-value creation', () => {
    // The whole reason the ceremony has an ordering. Describing it as only one of the two
    // is how someone deletes it and finds the splitter can no longer be deployed.
    const caps = byId(projectPolicyInventory(baseline(), ORG), 'pol-aaa').capabilities;
    expect(caps).toContain('v1-factory');
    expect(caps).toContain('zero-value-creation');
    expect(caps).not.toContain('current-factory');
  });

  it('classifies the legacy rule as only a legacy destination', () => {
    const caps = byId(projectPolicyInventory(baseline(), ORG), 'pol-ccc').capabilities;
    expect(caps).toEqual(['legacy-v2-factory']);
  });

  it('classifies the current rule as only the current factory', () => {
    const caps = byId(projectPolicyInventory(baseline(), ORG), 'pol-bbb').capabilities;
    expect(caps).toEqual(['current-factory']);
  });

  it('separates a zero-value creation clause from an unbounded one', () => {
    expect(classifyCapabilities(normalizeCondition("eth.tx.to == '' && eth.tx.value == 0")))
      .toEqual(['zero-value-creation']);
    // No value pin: a creation carrying funds lands the value in a contract the sender
    // writes, which is the difference between a splitter deploy and a drained treasury.
    expect(classifyCapabilities(normalizeCondition("eth.tx.to == ''"))).toEqual(['unbounded-creation']);
  });

  it('an address it does not recognise is `unknown`, never silently ignored', () => {
    expect(classifyCapabilities(normalizeCondition("eth.tx.to == '0x000000000000000000000000000000000000dead'")))
      .toEqual(['unknown']);
  });
});

describe('identity survives what names cannot distinguish', () => {
  it('two policies sharing a name stay distinct by id and digest', () => {
    const rows = baseline();
    rows[2].policyName = rows[1].policyName;
    const s = projectPolicyInventory(rows, ORG);
    expect(byId(s, 'pol-bbb').policyName).toBe(byId(s, 'pol-ccc').policyName);
    expect(byId(s, 'pol-bbb').identityDigest).not.toBe(byId(s, 'pol-ccc').identityDigest);
  });

  it('the same name with a changed condition changes the digest', () => {
    const before = byId(projectPolicyInventory(baseline(), ORG), 'pol-bbb').identityDigest;
    const rows = baseline();
    rows[1].condition = `eth.tx.to == '${LEGACY}'`;
    expect(byId(projectPolicyInventory(rows, ORG), 'pol-bbb').identityDigest).not.toBe(before);
  });

  it('the same condition with a different consensus changes the digest', () => {
    const before = byId(projectPolicyInventory(baseline(), ORG), 'pol-bbb').identityDigest;
    const rows = baseline();
    rows[1].consensus = "approvers.any(user, user.id == '99999999-9999-9999-9999-999999999999')";
    expect(byId(projectPolicyInventory(rows, ORG), 'pol-bbb').identityDigest).not.toBe(before);
  });

  it('cosmetic case and whitespace normalise the same way policy matching does', () => {
    const plain = projectPolicyInventory(baseline(), ORG);
    const rows = baseline();
    rows[1].condition = `  eth.tx.to   ==  '${executableDeployment().factory}'  `;
    const fancy = projectPolicyInventory(rows, ORG);
    expect(byId(fancy, 'pol-bbb').normalizedCondition).toBe(byId(plain, 'pol-bbb').normalizedCondition);
    expect(byId(fancy, 'pol-bbb').identityDigest).toBe(byId(plain, 'pol-bbb').identityDigest);
  });

  it('reordered API rows produce the same snapshot digest', () => {
    const a = projectPolicyInventory(baseline(), ORG).snapshotDigest;
    const b = projectPolicyInventory([...baseline()].reverse(), ORG).snapshotDigest;
    expect(b).toBe(a);
  });

  it('a real authority change moves the snapshot digest', () => {
    const rows = baseline();
    rows[0].condition = `eth.tx.to == '${V1}'`; // creation clause dropped
    expect(projectPolicyInventory(rows, ORG).snapshotDigest)
      .not.toBe(projectPolicyInventory(baseline(), ORG).snapshotDigest);
  });
});

describe('incomplete identity fails closed', () => {
  const cases: Array<[string, (r: PolicyLike[]) => void, string]> = [
    ['a missing policyId', (r) => { delete r[0].policyId; }, 'missing-policy-id'],
    ['a missing consensus', (r) => { delete r[0].consensus; }, 'missing-consensus'],
    ['an empty consensus', (r) => { r[0].consensus = '   '; }, 'missing-consensus'],
    ['a missing effect', (r) => { delete r[0].effect; }, 'missing-effect'],
    ['a missing condition', (r) => { r[0].condition = ''; }, 'missing-condition'],
    ['a missing organisation', (r) => { delete r[0].organizationId; }, 'missing-organization'],
    ['a foreign organisation', (r) => { r[0].organizationId = 'someone-else'; }, 'organization-mismatch'],
    ['a duplicated policyId', (r) => { r[1].policyId = r[0].policyId; }, 'duplicate-policy-id'],
  ];

  it.each(cases)('%s makes the snapshot unusable for mutation', (_label, mutate, code) => {
    const rows = baseline();
    mutate(rows);
    const s = projectPolicyInventory(rows, ORG);
    expect(s.usableForMutation).toBe(false);
    expect(s.problems.map((p) => p.code)).toContain(code);
    expect(renderInventory(s).join('\n')).toContain('NOT USABLE FOR MUTATION');
  });

  it('an empty consensus is a PROBLEM, not an empty binding', () => {
    // Turning a missing consensus into '' and calling it bound is the same defect as an
    // unreadable cap becoming zero: the most permissive reading of a missing fact.
    const rows = baseline();
    rows[0].consensus = '';
    const s = projectPolicyInventory(rows, ORG);
    expect(s.problems.map((p) => p.code)).toContain('missing-consensus');
  });

  it('a condition whose case carries meaning is refused rather than lowercased', () => {
    const rows = baseline();
    rows[0].condition = "eth.tx.data == '0xAbCdEf'";
    const s = projectPolicyInventory(rows, ORG);
    expect(s.problems.map((p) => p.code)).toContain('condition-unnormalizable');
    expect(s.usableForMutation).toBe(false);
  });
});

describe('the rendered inventory is secret-free and complete', () => {
  it('prints every identity field an operator needs to bind a deletion', () => {
    const out = renderInventory(projectPolicyInventory(baseline(), ORG)).join('\n');
    expect(out).toContain('pol-aaa');
    expect(out).toContain(ORG);
    expect(out).toContain('EFFECT_ALLOW');
    expect(out).toContain(CONSENSUS);
    expect(out).toContain('identity digest');
    expect(out).toContain('snapshot digest');
    expect(out).toMatch(/never to the name/i);
  });

  it('a credential-shaped value in a fixture cannot reach the output', () => {
    // Nothing in a policy row should ever carry one, but the projection must not become
    // the thing that publishes it if one appears.
    const rows = baseline() as any[];
    rows[0].apiPrivateKey = 'SECRET_INVENTORY_VALUE';
    rows[0].privateKey = 'SECRET_INVENTORY_VALUE';
    const s = projectPolicyInventory(rows, ORG);
    const out = renderInventory(s).join('\n');
    expect(out).not.toContain('SECRET_INVENTORY_VALUE');
    expect(JSON.stringify(s)).not.toContain('SECRET_INVENTORY_VALUE');
  });
});

describe('the read tool consumes the projection rather than printing its own view', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'scripts', 'turnkey-read-policies.ts'),
    'utf8'
  );

  it('renders through projectPolicyInventory and renderInventory', () => {
    expect(source).toMatch(/projectPolicyInventory\(/);
    expect(source).toMatch(/renderInventory\(/);
  });

  it('exits nonzero when the snapshot cannot be bound', () => {
    // Exiting 0 on an unbindable snapshot would let the ceremony proceed to a deletion
    // with nothing but a name to match on.
    expect(source).toMatch(/usableForMutation \? 0 : 1/);
  });

  it('does not reimplement classification beside the projection', () => {
    expect(source).not.toMatch(/deploymentByFactory\(/);
    expect(source).not.toMatch(/staleAllows/);
  });
});
