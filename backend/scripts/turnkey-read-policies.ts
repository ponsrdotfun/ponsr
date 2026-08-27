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

import { runInventory } from '../src/turnkeyInventoryCli';
import { PolicyLike } from '../src/turnkeyPolicyMatch';

/*
 * `line()` and `describeTarget()` were removed on 2026-08-26.
 *
 * They rendered a policy from its name, effect and condition and classified its target by
 * scanning for factory addresses -- a second, weaker copy of what
 * `turnkeyInventory.classifyCapabilities` now does, and one that produced no policy id and
 * no consensus. Two classifiers that agree today and drift tomorrow is how a policy gets
 * matched by one tool and missed by another.
 */

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

  /**
   * ONE organisation, used to SCOPE the request and to PIN the projection.
   *
   * The decision and the rendering live in `src/turnkeyInventoryCli.ts` so the wiring can
   * be tested without a network call: a projection can be perfect while the caller hands
   * it a different organisation than it queried, or exits 0 on a snapshot nobody can bind.
   */
  const result = await runInventory({
    organizationId,
    getPolicies: async (orgId) => {
      const res = await client.getPolicies({ organizationId: orgId });
      return (res.policies || []) as PolicyLike[];
    },
  });

  for (const l of result.lines) console.log(l);
  process.exitCode = result.exitCode;
}

main().catch((err) => {
  console.error('Could not read the policies:', String(err?.message ?? err).slice(0, 200));
  process.exit(1);
});
