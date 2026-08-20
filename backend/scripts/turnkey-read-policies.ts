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
import { DEPLOYMENTS, executableDeployment } from '../src/deployments';

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
  const v1 = String(config.PONS_FACTORY_ADDRESS ?? '').toLowerCase();
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
  const policies: any[] = res.policies || [];
  console.log(`\n${policies.length} polic${policies.length === 1 ? 'y' : 'ies'}:\n`);

  let allowsExecutable = false;
  const staleAllows: string[] = [];

  for (const p of policies) {
    const condition = String(p.condition ?? '');
    const effect = String(p.effect ?? '');
    console.log(`  ${p.policyName}`);
    line('  effect', effect);
    line('  condition', condition);
    line('  targets', describeTarget(condition));
    console.log('');

    if (effect === 'EFFECT_ALLOW') {
      const c = condition.toLowerCase();
      if (c.includes(target.factory.toLowerCase())) allowsExecutable = true;
      const stale = DEPLOYMENTS.filter((d) => !d.executable && c.includes(d.factory.toLowerCase()));
      // A rule may name a dead factory AND still carry permission the bot needs. The v1
      // rule is exactly that: it also allows contract creation, which is how every
      // FeeSplitter gets deployed. Listing it as "superseded" without that qualifier is
      // an instruction to cause the outage this tool exists to prevent.
      const alsoCarries =
        (/eth\.tx\.to\s*==\s*''/.test(c) ? ['contract creation'] : []).concat(
          c.includes(target.factory.toLowerCase()) ? ['the current factory'] : []
        );
      for (const d of stale) {
        staleAllows.push(
          alsoCarries.length
            ? `${p.policyName} -> ${d.id}  — DO NOT DELETE, also allows ${alsoCarries.join(' and ')}`
            : `${p.policyName} -> ${d.id}  — names nothing else; safe to delete`
        );
      }
    }
  }

  console.log('=== WHAT THIS DOES AND DOES NOT ESTABLISH ===');
  if (allowsExecutable) {
    line('executable factory', 'an ALLOW rule names it');
  } else {
    line('executable factory', 'NO ALLOW RULE NAMES IT — the bot could not launch');
  }

  // Not dangerous, but it is permission that buys nothing, and permission nobody can
  // explain is permission nobody removes.
  for (const s of staleAllows) {
    line('superseded, still allowed', s);
  }
  if (staleAllows.length) {
    console.log('\n  Those rules allow factories this bot no longer calls. Harmless today --');
    console.log('  read each line before removing anything: a rule can name a dead factory');
    console.log('  and still be the only thing permitting contract creation, and deleting');
    console.log('  it would leave a bot that launches and then cannot deploy its splitter.');
  }

  console.log('\n  This is the rule TEXT, not its enforcement. A policy engine failing open');
  console.log('  would print exactly the same thing. Before real money moves, run:');
  console.log('\n    npx tsx scripts/turnkey-verify-policy.ts');
  console.log('\n  and require an arbitrary destination to come back denied.');
}

main().catch((err) => {
  console.error('Could not read the policies:', String(err?.message ?? err).slice(0, 200));
  process.exit(1);
});
