import * as fs from 'fs';
import * as path from 'path';
import { PolicyLike } from '../src/turnkeyPolicyMatch';
import { runInventory } from '../src/turnkeyInventoryCli';
import { deploymentById, executableDeployment } from '../src/deployments';

/**
 * THE WIRING, NOT THE PROJECTION.
 *
 * `projectPolicyInventory` is covered exhaustively elsewhere. What is NOT covered by it:
 * whether the command hands the projection the SAME organisation it queried, and whether
 * an unusable snapshot actually reaches the exit code.
 *
 * Both are composition questions, and this project has been bitten three times by a
 * correct function beside a caller that ignored it. The fetch is a seam here, so the
 * wiring is tested with an injected fake and no network request.
 */

const ORG = '87e2bc08-33eb-45bf-add6-f48e7a523772';
const BOT_USER = '009b2000-01e2-4984-9326-5bb743bf007a';
const CONSENSUS = `approvers.any(user, user.id == '${BOT_USER}')`;
const CURRENT = executableDeployment().factory.toLowerCase();
const V1 = deploymentById('pons-v1').factory.toLowerCase();
const LEGACY = deploymentById('pons-v2-legacy-7e1').factory.toLowerCase();

/**
 * The observed `getPolicies` shape of 2026-08-26: no per-row organizationId, because the
 * request carries it. Secret-free -- policy identifiers, conditions and consensus only.
 */
function observedRows(): PolicyLike[] {
  return [
    {
      policyId: '1b8b585f-d92b-40d2-a79e-760b4fc64e53',
      policyName: 'ponsr-bot: launch on the v2 factory',
      effect: 'EFFECT_ALLOW',
      consensus: CONSENSUS,
      condition: `eth.tx.to == '${LEGACY}'`,
    },
    {
      policyId: 'b647cc07-a7fe-4941-914c-2c1032392f80',
      policyName: 'ponsr-bot: v1 factory + zero-value splitter deploy',
      effect: 'EFFECT_ALLOW',
      consensus: CONSENSUS,
      condition: `(eth.tx.to == '' && eth.tx.value == 0) || eth.tx.to == '${V1}'`,
    },
    {
      policyId: 'ece2a399-57fa-4360-a6f1-f6fc11ac3f7c',
      policyName: 'ponsr-bot: launch on pons-v2-current-7ed',
      effect: 'EFFECT_ALLOW',
      consensus: CONSENSUS,
      condition: `eth.tx.to == '${CURRENT}'`,
    },
  ];
}

describe('the inventory command queries and pins the same organisation', () => {
  it('passes the exact organisation it queried into the projection', async () => {
    const asked: string[] = [];
    const r = await runInventory({
      organizationId: ORG,
      getPolicies: async (orgId) => {
        asked.push(orgId);
        return observedRows();
      },
    });

    // The same value on both sides. If they could differ, the snapshot would describe one
    // organisation while claiming another.
    expect(asked).toEqual([ORG]);
    expect(r.snapshot.organizationId).toBe(ORG);
    for (const p of r.snapshot.policies) expect(p.organizationId).toBe(ORG);
  });

  it('rows omitting the organisation produce a usable snapshot and exit 0', async () => {
    const r = await runInventory({ organizationId: ORG, getPolicies: async () => observedRows() });
    expect(r.snapshot.problems).toEqual([]);
    expect(r.snapshot.usableForMutation).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it('prints the organisation, the ids and the binding instruction', async () => {
    const out = (await runInventory({ organizationId: ORG, getPolicies: async () => observedRows() }))
      .lines.join('\n');
    expect(out).toContain(ORG);
    expect(out).toContain('b647cc07-a7fe-4941-914c-2c1032392f80');
    expect(out).toContain(BOT_USER);
    expect(out).toMatch(/never to the name/i);
    // The combined rule must be flagged as undeletable on its own.
    expect(out).toMatch(/DO NOT DELETE ALONE/);
  });

  it('a row claiming a different organisation fails closed and exits 1', async () => {
    const rows = observedRows();
    rows[1].organizationId = 'some-other-organization';
    const r = await runInventory({ organizationId: ORG, getPolicies: async () => rows });
    expect(r.snapshot.usableForMutation).toBe(false);
    expect(r.snapshot.problems.map((p) => p.code)).toContain('organization-mismatch');
    expect(r.exitCode).toBe(1);
    expect(r.lines.join('\n')).toContain('NOT USABLE FOR MUTATION');
  });

  it.each([
    ['a missing policyId', (r: PolicyLike[]) => { delete r[0].policyId; }],
    ['a missing consensus', (r: PolicyLike[]) => { delete r[0].consensus; }],
    ['a missing effect', (r: PolicyLike[]) => { delete r[0].effect; }],
    ['a missing condition', (r: PolicyLike[]) => { r[0].condition = ''; }],
  ])('%s still exits 1 -- the organisation relaxation softened nothing else', async (_l, mutate) => {
    const rows = observedRows();
    mutate(rows);
    const r = await runInventory({ organizationId: ORG, getPolicies: async () => rows });
    expect(r.exitCode).toBe(1);
  });

  it('an empty response is usable but says so honestly', async () => {
    const r = await runInventory({ organizationId: ORG, getPolicies: async () => [] });
    expect(r.exitCode).toBe(0);
    expect(r.lines.join('\n')).toMatch(/policies\s+0/);
    // And it must not claim the executable factory is allowed by anything.
    expect(r.lines.join('\n')).toContain('NO rule names it');
  });
});

describe('the shipped script consumes the composition', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'turnkey-read-policies.ts'),
    'utf8'
  );

  it('calls runInventory and sets the code it returns', () => {
    expect(source).toMatch(/runInventory\(/);
    expect(source).toMatch(/process\.exitCode\s*=\s*\w+\.exitCode/);
  });

  it('queries with the same organisation it pins', () => {
    // One binding, threaded through. A second `organizationId` read here would be the
    // seam where the two could drift apart.
    expect(source).toMatch(/organizationId,\s*\n\s*getPolicies/);
    expect(source).toMatch(/getPolicies\(\{ organizationId: orgId \}\)/);
  });

  it('no longer classifies targets with a second, weaker copy', () => {
    expect(source).not.toMatch(/function describeTarget/);
    expect(source).not.toMatch(/projectPolicyInventory\(/);
  });
});
