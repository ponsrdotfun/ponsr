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

  it('renders through the shared composition rather than its own view', () => {
    // The projection and the exit wiring moved into `turnkeyInventoryCli` so they could be
    // tested with an injected fake client. What this pins is that the script goes through
    // it; the behaviour itself is covered in `turnkeyInventoryCli.test.ts`.
    expect(source).toMatch(/runInventory\(/);
    expect(source).not.toMatch(/projectPolicyInventory\(/);
  });

  it('exits with the code the composition returned', () => {
    // Exiting 0 on an unbindable snapshot would let the ceremony proceed to a deletion
    // with nothing but a name to match on.
    expect(source).toMatch(/process\.exitCode\s*=\s*\w+\.exitCode/);
  });

  it('does not reimplement classification beside the projection', () => {
    expect(source).not.toMatch(/deploymentByFactory\(/);
    expect(source).not.toMatch(/staleAllows/);
  });
});

/**
 * THE SHAPE THE API ACTUALLY RETURNS.
 *
 * Every fixture above carries `organizationId` on each row. The real
 * `getPolicies({ organizationId })` response DOES NOT: the organisation is the scope of
 * the REQUEST, not a property of each policy. So the first live run -- during the owner's
 * root-credential revocation on 2026-08-26 -- marked all three genuine policies
 * `missing-organization` and declared a perfect snapshot unusable for the one job it
 * exists to do.
 *
 * The fixtures asserted my assumption about the response shape rather than the shape
 * itself. Thirteen tests passed over a projection that could not handle a real row.
 *
 * PROVENANCE: the rows below mirror the observed `getPolicies` output of 2026-08-26 for
 * organisation 87e2bc08-…-a523772 -- policy ids, names, effects, conditions and consensus
 * only, with no per-row organizationId because the API sends none. Secret-free: every
 * value here is an operational identifier.
 */
describe('a real getPolicies row omits organizationId, and that is normal', () => {
  const BOT_USER = '009b2000-01e2-4984-9326-5bb743bf007a';
  const REAL_CONSENSUS = `approvers.any(user, user.id == '${BOT_USER}')`;

  /** Exactly the observed shape: no `organizationId` key at all. */
  function observedRows(): PolicyLike[] {
    return [
      {
        policyId: '1b8b585f-d92b-40d2-a79e-760b4fc64e53',
        policyName: 'ponsr-bot: launch on the v2 factory',
        effect: 'EFFECT_ALLOW',
        consensus: REAL_CONSENSUS,
        condition: `eth.tx.to == '${LEGACY}'`,
      },
      {
        policyId: 'b647cc07-a7fe-4941-914c-2c1032392f80',
        policyName: 'ponsr-bot: v1 factory + zero-value splitter deploy',
        effect: 'EFFECT_ALLOW',
        consensus: REAL_CONSENSUS,
        condition: `(eth.tx.to == '' && eth.tx.value == 0) || eth.tx.to == '${V1}'`,
      },
      {
        policyId: 'ece2a399-57fa-4360-a6f1-f6fc11ac3f7c',
        policyName: 'ponsr-bot: launch on pons-v2-current-7ed',
        effect: 'EFFECT_ALLOW',
        consensus: REAL_CONSENSUS,
        condition: `eth.tx.to == '${CURRENT}'`,
      },
    ];
  }

  it('the observed three-policy response yields a USABLE snapshot', () => {
    const s = projectPolicyInventory(observedRows(), ORG);
    expect(s.problems).toEqual([]);
    expect(s.usableForMutation).toBe(true);
    expect(s.policies).toHaveLength(3);
  });

  it('every projected policy carries the caller-pinned organisation', () => {
    // Not trusting the response: carrying the authority scope the request was made under.
    for (const p of projectPolicyInventory(observedRows(), ORG).policies) {
      expect(p.organizationId).toBe(ORG);
    }
  });

  it('the same rows under a different caller pin produce different digests', () => {
    // The organisation is part of identity, so it must be part of the digest even when
    // the row does not carry it.
    const a = projectPolicyInventory(observedRows(), ORG);
    const b = projectPolicyInventory(observedRows(), 'a-different-organization');
    expect(b.snapshotDigest).not.toBe(a.snapshotDigest);
    expect(b.policies[0].identityDigest).not.toBe(a.policies[0].identityDigest);
  });

  it('digests stay stable when the API reorders the rows', () => {
    expect(projectPolicyInventory([...observedRows()].reverse(), ORG).snapshotDigest)
      .toBe(projectPolicyInventory(observedRows(), ORG).snapshotDigest);
  });

  it('classifies the observed rules exactly as the ceremony needs', () => {
    const s = projectPolicyInventory(observedRows(), ORG);
    expect(byId(s, 'b647cc07-a7fe-4941-914c-2c1032392f80').capabilities)
      .toEqual(expect.arrayContaining(['v1-factory', 'zero-value-creation']));
    expect(byId(s, '1b8b585f-d92b-40d2-a79e-760b4fc64e53').capabilities).toEqual(['legacy-v2-factory']);
    expect(byId(s, 'ece2a399-57fa-4360-a6f1-f6fc11ac3f7c').capabilities).toEqual(['current-factory']);
  });

  it('a row that DOES carry a matching organisation is accepted', () => {
    const rows = observedRows();
    rows[0].organizationId = ORG;
    expect(projectPolicyInventory(rows, ORG).usableForMutation).toBe(true);
  });

  it('a row that carries a DIFFERENT organisation still fails closed', () => {
    // The case the check was actually for, and the only one it should have caught.
    const rows = observedRows();
    rows[0].organizationId = 'some-other-organization';
    const s = projectPolicyInventory(rows, ORG);
    expect(s.usableForMutation).toBe(false);
    expect(s.problems.map((p) => p.code)).toContain('organization-mismatch');
  });

  it('mixed rows -- some omitting, some matching -- are accepted', () => {
    const rows = observedRows();
    rows[1].organizationId = ORG;
    expect(projectPolicyInventory(rows, ORG).usableForMutation).toBe(true);
  });

  it('mixed rows containing ONE mismatch are rejected', () => {
    const rows = observedRows();
    rows[1].organizationId = ORG;
    rows[2].organizationId = 'some-other-organization';
    expect(projectPolicyInventory(rows, ORG).usableForMutation).toBe(false);
  });

  it.each([[''], ['   '], [undefined as unknown as string]])(
    'a caller pin of %p is refused before any projection',
    (pin) => {
      // A missing pin must never be filled in from a row. The caller is the only party
      // that knows which organisation was asked.
      expect(() => projectPolicyInventory(observedRows(), pin)).toThrow(/organi[sz]ation/i);
    }
  );

  it('missing policyId, effect, condition or consensus still fails closed', () => {
    // The organisation relaxation must not soften anything else.
    for (const mutate of [
      (r: PolicyLike[]) => { delete r[0].policyId; },
      (r: PolicyLike[]) => { delete r[0].effect; },
      (r: PolicyLike[]) => { r[0].condition = ''; },
      (r: PolicyLike[]) => { delete r[0].consensus; },
    ]) {
      const rows = observedRows();
      mutate(rows);
      expect(projectPolicyInventory(rows, ORG).usableForMutation).toBe(false);
    }
  });
});
