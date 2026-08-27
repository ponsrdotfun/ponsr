import { ethers } from 'ethers';
import { DEPLOYMENTS, executableDeployment } from './deployments';
import { PolicyLike, normalizeCondition, normalizeConsensus } from './turnkeyPolicyMatch';

/**
 * A POLICY'S IDENTITY, NOT ITS LABEL.
 *
 * The inventory tool printed name, effect and condition. The ceremony's own rule is
 * "never delete by policy name alone -- match exact policy id plus normalized condition,
 * effect and consensus. Names are labels, not authority." The tool could not produce that
 * binding, so the removal step had nothing to bind to.
 *
 * The data was always there: `getPolicies` returns `policyId` and the consensus
 * expression. The projection simply did not print them, which is a different failure from
 * not having them and a worse one -- it looks like a complete inventory.
 *
 * FAIL CLOSED ON INCOMPLETE IDENTITY. A row missing an id, an effect, a condition or a
 * consensus is not a row with an empty field; it is a row whose authority nobody has
 * established. Turning a missing consensus into `''` and calling it bound is the same
 * defect as an unreadable cap becoming zero.
 *
 * The ORGANISATION is the exception, and getting that wrong was a defect of its own: the
 * API scopes it on the REQUEST and does not repeat it per row, so an absent one inherits
 * the caller's pin. Only a row claiming a DIFFERENT organisation fails. See
 * `projectPolicyInventory` for what that cost.
 */

/** What a policy names, in closed categories rather than prose. */
export type PolicyCapability =
  | 'current-factory'
  | 'v1-factory'
  | 'legacy-v2-factory'
  | 'zero-value-creation'
  | 'unbounded-creation'
  | 'unknown';

export interface PolicyProjection {
  policyId: string;
  /** Display only. Never used to decide anything. */
  policyName: string;
  organizationId: string;
  effect: string;
  condition: string;
  normalizedCondition: string;
  consensus: string;
  normalizedConsensus: string;
  capabilities: PolicyCapability[];
  /** Canonical digest of organisation, id, effect and the two normalised expressions. */
  identityDigest: string;
}

export type ProjectionProblem =
  | 'missing-policy-id'
  | 'organization-mismatch'
  | 'missing-effect'
  | 'missing-condition'
  | 'missing-consensus'
  | 'condition-unnormalizable'
  | 'duplicate-policy-id';

export interface InventorySnapshot {
  organizationId: string;
  policies: PolicyProjection[];
  /** Closed codes, each paired with the policy id or index it concerns. */
  problems: Array<{ code: ProjectionProblem; policyId: string }>;
  /** False whenever any problem exists. A snapshot nobody can bind is not a snapshot. */
  usableForMutation: boolean;
  /** Stable across API row order; changes when any policy's authority changes. */
  snapshotDigest: string;
}

const sha256 = (s: string): string => ethers.sha256(ethers.toUtf8Bytes(s)).slice(2);

/** Canonical JSON: fixed key order, so a digest depends on values and nothing else. */
function canonical(p: {
  organizationId: string;
  policyId: string;
  effect: string;
  normalizedCondition: string;
  normalizedConsensus: string;
}): string {
  return JSON.stringify([
    p.organizationId,
    p.policyId,
    p.effect,
    p.normalizedCondition,
    p.normalizedConsensus,
  ]);
}

const addressOf = (id: string): string => {
  const d = DEPLOYMENTS.find((x) => x.id === id);
  return (d?.factory ?? '').toLowerCase();
};

/**
 * What this condition permits, read from the NORMALISED text.
 *
 * Deliberately conservative and additive: a condition naming the v1 factory AND carrying
 * a zero-value creation clause is BOTH, because that is exactly the rule the ceremony has
 * to take apart, and describing it as only one of the two is how someone deletes it and
 * discovers the splitter can no longer be deployed.
 */
export function classifyCapabilities(normalized: string): PolicyCapability[] {
  const caps: PolicyCapability[] = [];
  const has = (needle: string) => normalized.includes(needle);

  if (has(addressOf(executableDeployment().id))) caps.push('current-factory');
  if (has(addressOf('pons-v1'))) caps.push('v1-factory');
  if (has(addressOf('pons-v2-legacy-7e1'))) caps.push('legacy-v2-factory');

  // A creation clause has no destination. `to == ''` is the shape; whether the value is
  // pinned to zero is the difference between a splitter deploy and a drained treasury.
  const creation = /eth\.tx\.to==(''|"")/.test(normalized);
  if (creation) {
    caps.push(/eth\.tx\.value==0/.test(normalized) ? 'zero-value-creation' : 'unbounded-creation');
  }

  if (caps.length === 0) caps.push('unknown');
  return caps;
}

/**
 * Projects raw `getPolicies` rows into bindable identities.
 *
 * `expectedOrganizationId` is CALLER-PINNED and REQUIRED. Reading the organisation out of
 * the same response it is meant to validate would be a limit acting as evidence about
 * itself, so a missing pin THROWS rather than being filled in from a row.
 *
 * A ROW THAT OMITS `organizationId` IS NORMAL, and treating it as a defect was a real
 * one. `getPolicies({ organizationId })` scopes the request; the response does not repeat
 * the organisation on every policy. The first live run marked all three genuine policies
 * `missing-organization` and declared a perfect snapshot unusable -- because every test
 * fixture had carried a field the API never sends. The fixtures asserted an assumption
 * about the response shape rather than the shape itself.
 *
 * So an absent row organisation INHERITS the caller pin: that is not trusting the
 * response, it is carrying the authority scope the request was made under. A row that
 * CARRIES a different organisation is still a mismatch and still fails closed -- which is
 * the only case the check was ever for.
 */
export function projectPolicyInventory(
  rows: readonly PolicyLike[],
  expectedOrganizationId: string
): InventorySnapshot {
  if (!String(expectedOrganizationId ?? '').trim()) {
    throw new Error(
      'projectPolicyInventory requires a caller-pinned organization id. It is the scope ' +
        'the request was made under and cannot be recovered from the response.'
    );
  }
  const problems: InventorySnapshot['problems'] = [];
  const policies: PolicyProjection[] = [];
  const seenIds = new Set<string>();

  rows.forEach((row, index) => {
    const policyId = String(row.policyId ?? '').trim();
    const label = policyId || `#${index}`;
    const note = (code: ProjectionProblem) => problems.push({ code, policyId: label });

    if (!policyId) note('missing-policy-id');
    else if (seenIds.has(policyId)) note('duplicate-policy-id');
    seenIds.add(policyId);

    // Absent means "inherited from the request scope". Present means it must agree.
    const claimed = String(row.organizationId ?? '').trim();
    if (claimed && claimed !== expectedOrganizationId) note('organization-mismatch');
    const organizationId = claimed || expectedOrganizationId;

    const effect = String(row.effect ?? '').trim();
    if (!effect) note('missing-effect');

    const condition = String(row.condition ?? '');
    if (!condition.trim()) note('missing-condition');

    // ABSENT, not empty. `consensus` decides WHO a policy binds, and a rule bound to
    // nobody-in-particular is the one shape an operator must never mistake for scoped.
    const hasConsensus = row.consensus !== undefined && String(row.consensus).trim() !== '';
    if (!hasConsensus) note('missing-consensus');
    const consensus = String(row.consensus ?? '');

    let normalizedCondition = '';
    try {
      normalizedCondition = normalizeCondition(condition);
    } catch {
      // The normalizer refuses conditions whose case carries meaning. Refusing is right;
      // silently lowercasing them would make two different rules compare equal.
      note('condition-unnormalizable');
    }
    const normalizedConsensus = normalizeConsensus(consensus);

    policies.push({
      policyId,
      policyName: String(row.policyName ?? ''),
      organizationId,
      effect,
      condition,
      normalizedCondition,
      consensus,
      normalizedConsensus,
      capabilities: classifyCapabilities(normalizedCondition),
      identityDigest: sha256(
        canonical({ organizationId, policyId, effect, normalizedCondition, normalizedConsensus })
      ),
    });
  });

  // Sorted by policy id, so the API's row order cannot change the snapshot's identity.
  const ordered = [...policies].sort((a, b) => (a.policyId < b.policyId ? -1 : a.policyId > b.policyId ? 1 : 0));
  const snapshotDigest = sha256(
    JSON.stringify([
      expectedOrganizationId,
      ordered.map((p) =>
        canonical({
          organizationId: p.organizationId,
          policyId: p.policyId,
          effect: p.effect,
          normalizedCondition: p.normalizedCondition,
          normalizedConsensus: p.normalizedConsensus,
        })
      ),
    ])
  );

  return {
    organizationId: expectedOrganizationId,
    policies: ordered,
    problems,
    usableForMutation: problems.length === 0,
    snapshotDigest,
  };
}

/** Human-readable, secret-free. Every field printed is an operational identifier. */
export function renderInventory(snapshot: InventorySnapshot): string[] {
  const lines: string[] = [];
  lines.push('=== TURNKEY POLICY INVENTORY (a read; nothing is signed) ===');
  lines.push(`  organization        ${snapshot.organizationId}`);
  lines.push(`  policies            ${snapshot.policies.length}`);
  lines.push(`  snapshot digest     ${snapshot.snapshotDigest}`);
  lines.push('');
  for (const p of snapshot.policies) {
    lines.push(`  ${p.policyName || '(unnamed)'}`);
    lines.push(`    policyId          ${p.policyId || '(MISSING)'}`);
    lines.push(`    organizationId    ${p.organizationId || '(MISSING)'}`);
    lines.push(`    effect            ${p.effect || '(MISSING)'}`);
    lines.push(`    condition         ${p.condition || '(MISSING)'}`);
    lines.push(`    normalized        ${p.normalizedCondition}`);
    lines.push(`    consensus         ${p.consensus || '(MISSING)'}`);
    lines.push(`    normalized        ${p.normalizedConsensus}`);
    lines.push(`    capabilities      ${p.capabilities.join(', ')}`);
    lines.push(`    identity digest   ${p.identityDigest}`);
    lines.push('');
  }
  if (snapshot.problems.length > 0) {
    lines.push('=== THIS SNAPSHOT IS NOT USABLE FOR MUTATION ===');
    for (const { code, policyId } of snapshot.problems) lines.push(`    ${code}  (${policyId})`);
    lines.push('  A policy whose identity is incomplete cannot be bound, and the ceremony');
    lines.push('  forbids deleting by name. Resolve these before changing anything.');
  } else {
    lines.push('  Every policy carries a bindable identity. Deletion may be bound to the');
    lines.push('  policyId plus the normalized condition, effect and consensus above --');
    lines.push('  never to the name, which is a label and not authority.');
  }
  return lines;
}
