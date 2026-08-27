import { executableDeployment } from './deployments';
import { PolicyLike } from './turnkeyPolicyMatch';
import { InventorySnapshot, projectPolicyInventory, renderInventory } from './turnkeyInventory';

/**
 * THE INVENTORY COMMAND'S COMPOSITION, SEPARATED FROM ITS NETWORK CALL.
 *
 * The projection can be perfect while the script hands it the wrong organisation, or
 * prints a usable-looking snapshot and exits 0 on an unusable one. Those are wiring
 * questions and they need a wiring test -- which is not possible while the only entry
 * point builds a live Turnkey client on its first line.
 *
 * So the fetch is a seam. `runInventory` decides and renders; the script supplies a
 * function that actually calls `getPolicies`. Nothing here makes a network request.
 *
 * THE PIN IS PASSED, NOT DISCOVERED. The same organisation id used to SCOPE the request
 * is the one handed to the projection -- if those two could differ, the snapshot would
 * describe one organisation while claiming another.
 */

export interface InventoryDeps {
  /** The organisation the request is scoped to. Also the projection's caller pin. */
  organizationId: string;
  /** Receives the exact same organisation the projection will be pinned to. */
  getPolicies: (organizationId: string) => Promise<readonly PolicyLike[]>;
}

export interface InventoryResult {
  snapshot: InventorySnapshot;
  /** 0 only when the snapshot can be bound. An unusable one must not read as success. */
  exitCode: number;
  lines: string[];
}

export async function runInventory(deps: InventoryDeps): Promise<InventoryResult> {
  const rows = await deps.getPolicies(deps.organizationId);
  const snapshot = projectPolicyInventory(rows, deps.organizationId);

  const lines = [...renderInventory(snapshot)];
  const target = executableDeployment();

  lines.push('');
  lines.push('=== WHAT THIS DOES AND DOES NOT ESTABLISH ===');
  const allowsExecutable = snapshot.policies.some(
    (p) => p.effect === 'EFFECT_ALLOW' && p.capabilities.includes('current-factory')
  );
  lines.push(
    `  executable factory            ${allowsExecutable ? 'an ALLOW rule names it' : 'NO rule names it'}`
  );
  for (const p of snapshot.policies) {
    const stale = p.capabilities.filter((c) => c === 'v1-factory' || c === 'legacy-v2-factory');
    if (p.effect !== 'EFFECT_ALLOW' || stale.length === 0) continue;
    const alsoCreates = p.capabilities.some((c) => c.endsWith('creation'));
    lines.push(
      `  superseded, still allowed     ${p.policyId}  ${stale.join(' + ')}` +
        (alsoCreates
          ? '  — DO NOT DELETE ALONE, it also allows contract creation'
          : '  — names nothing else')
    );
  }
  lines.push('');
  lines.push('  This is the rule TEXT and its identity, not its ENFORCEMENT. A policy');
  lines.push('  engine failing open would print exactly the same thing. Before real money');
  lines.push('  moves, run:');
  lines.push('');
  lines.push(`    npx tsx scripts/turnkey-verify-policy.ts --target-deployment=${target.id}`);
  lines.push('');
  lines.push('  and require an arbitrary destination to come back denied.');

  // A snapshot nobody can bind is not a snapshot. Exiting 0 on one would let the ceremony
  // proceed to a deletion with nothing but a name to match on.
  return { snapshot, exitCode: snapshot.usableForMutation ? 0 : 1, lines };
}
