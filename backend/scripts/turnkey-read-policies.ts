/**
 * Prints the Turnkey policies as they are written, without asking anything to be signed.
 *
 *   npx tsx scripts/turnkey-read-policies.ts
 *
 * WHY THIS EXISTS ALONGSIDE turnkey-verify-policy.ts
 * ---------------------------------------------------
 * The verifier is the stronger tool: it asks Turnkey to sign four transactions and
 * reports what actually happened. But it needs signing to work, and signing is exactly
 * what goes away when an organisation runs out of quota, loses its key, or is
 * suspended -- the moments when you most want to know what the policies say.
 *
 * On 2026-08-20 that happened: the v2 policy was created correctly and minutes later
 * every check came back unanswerable, because signing was disabled org-wide over quota.
 * There was no way to tell a correct policy from a missing one.
 *
 * This closes that gap. It is a read, so it survives the signer being unavailable.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT
 * ------------------------------------
 * It proves the rule TEXT is what was intended -- the right factory, the right effect,
 * scoped to the bot. It does NOT prove Turnkey enforces it. A policy engine that
 * silently failed open would print exactly this. Before a launch moves real money, the
 * verifier still has to run and still has to show an arbitrary destination denied.
 *
 * Uses the bot's own key. Reading policies is not an administrative act, so root is
 * neither needed nor wanted here.
 */
import { config } from '../src/config';
import { DEPLOYMENTS, executableDeployment, deploymentById } from '../src/deployments';
import { projectPolicyInventory, renderInventory } from '../src/turnkeyInventory';

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(28)} ${value}`);
}

/** Names the address a condition mentions, so a stale rule is visible as stale. */
function describeTarget(condition: string): string {
  const c = condition.toLowerCase();
  const hits: string[] = [];
  for (const d of DEPLOYMENTS) {
    if (c.includes(d.factory.toLowerCase())) {
      hits.push(d.executable ? `${d.id} (EXECUTABLE)` : `${d.id} (superseded)`);
    }
  }
  const v1 = deploymentById('pons-v1').factory.toLowerCase();
  if (v1 && c.includes(v1)) hits.push('v1 factory');
  // An empty `to` is a contract creation -- how the per-launch FeeSplitter is deployed.
  if (/eth\.tx\.to\s*==\s*''/.test(c)) hits.push('contract creation');
  return hits.length ? hits.join(' + ') : 'an address not in the registry';
}

async function main() {
  const organizationId = config.TURNKEY_ORGANIZATION_ID;
  if (!organizationId || !config.TURNKEY_API_PUBLIC_KEY || !config.TURNKEY_API_PRIVATE_KEY) {
    console.error('Turnkey is not configured in backend/.env. Nothing to read.');
    process.exit(1);
  }

  const { Turnkey } = require('@turnkey/sdk-server');
  const client = new Turnkey({
    apiBaseUrl: 'https://api.turnkey.com',
    apiPublicKey: config.TURNKEY_API_PUBLIC_KEY,
    apiPrivateKey: config.TURNKEY_API_PRIVATE_KEY,
    defaultOrganizationId: organizationId,
  }).apiClient();

  const target = executableDeployment();

  console.log('=== TURNKEY POLICIES AS WRITTEN (a read; nothing is signed) ===');
  line('organization', organizationId);
  line('bot launches through', `${target.id}  ${target.factory}`);

  const res = await client.getPolicies({ organizationId });
  const rows: any[] = res.policies || [];

  /**
   * IDENTITY, NOT LABELS.
   *
   * This printed name, effect and condition. The removal ceremony's own rule is "never
   * delete by policy name alone -- match exact policy id plus normalized condition,
   * effect and consensus", and none of the identity half was here. The data was always in
   * the response; not printing it looked like a complete inventory, which is worse than
   * an obviously partial one.
   *
   * The organisation is CALLER-PINNED. Reading it out of the same response it is meant to
   * validate would be a limit acting as evidence about itself.
   */
  const snapshot = projectPolicyInventory(rows, organizationId);
  for (const l of renderInventory(snapshot)) console.log(l);

  console.log('');
  console.log('=== WHAT THIS DOES AND DOES NOT ESTABLISH ===');
  const allowsExecutable = snapshot.policies.some(
    (p) => p.effect === 'EFFECT_ALLOW' && p.capabilities.includes('current-factory')
  );
  line('executable factory', allowsExecutable ? 'an ALLOW rule names it' : 'NO rule names it');
  for (const p of snapshot.policies) {
    const stale = p.capabilities.filter((c) => c === 'v1-factory' || c === 'legacy-v2-factory');
    if (p.effect !== 'EFFECT_ALLOW' || stale.length === 0) continue;
    const alsoCreates = p.capabilities.some((c) => c.endsWith('creation'));
    line(
      'superseded, still allowed',
      `${p.policyId}  ${stale.join(' + ')}` +
        (alsoCreates ? '  — DO NOT DELETE ALONE, it also allows contract creation' : '  — names nothing else')
    );
  }
  console.log('');
  console.log('  This is the rule TEXT and its identity, not its ENFORCEMENT. A policy');
  console.log('  engine failing open would print exactly the same thing. Before real money');
  console.log('  moves, run:');
  console.log('');
  console.log('    npx tsx scripts/turnkey-verify-policy.ts --target-deployment=' + target.id);
  console.log('');
  console.log('  and require an arbitrary destination to come back denied.');

  // A snapshot nobody can bind is not a snapshot. Exiting 0 on one would let the ceremony
  // proceed to a deletion with nothing but a name to match on.
  process.exitCode = snapshot.usableForMutation ? 0 : 1;
}

main().catch((err) => {
  console.error('Could not read the policies:', String(err?.message ?? err).slice(0, 200));
  process.exit(1);
});
