/**
 * Lets the bot sign transactions to the pons **v2** factory.
 *
 *   npx tsx scripts/turnkey-allow-v2-factory.ts              # plan only, changes nothing
 *   npx tsx scripts/turnkey-allow-v2-factory.ts --execute
 *
 * WHY THIS EXISTS
 * ---------------
 * The bot's Turnkey policy allows exactly two shapes: a transaction to the **v1**
 * factory, and a contract creation (the per-launch FeeSplitter). That was the whole
 * world when it was written. It is not any more: v2 is the only factory that can
 * price a launch in something other than ETH, and it is a different address.
 *
 * Measured, not assumed — asking Turnkey to sign for each address today:
 *
 *     -> v1 factory   ALLOWED
 *     -> v2 factory   DENIED by the Turnkey policy
 *
 * So moving the executable deployment forward without running this produces a bot that
 * passes every check it makes of pons, gets a green light, and is then refused by its
 * own signer. That failure would arrive after the splitter had already been deployed
 * and paid for.
 *
 * WHAT IT DOES
 * ------------
 * Creates a SECOND allow policy rather than editing the existing one. Turnkey unions
 * allow policies, so this adds the v2 factory without touching the rule that is
 * currently working — and if it is ever unwanted, deleting this one policy restores
 * exactly today's behaviour. Editing the live rule to add an address risks breaking
 * launching entirely to enable launching differently.
 *
 * ROOT CREDENTIALS, AND WHY THEY ARE NOT READ FROM .env
 * -----------------------------------------------------
 * Creating a policy is an administrative act, and the bot's own key cannot do it —
 * that is the point of scoping it. This needs the ROOT key, which deliberately does
 * not live in `backend/.env`: root bypasses the policy engine entirely
 * (`turnkey-policy-probe.ts` measured a signature going through under a DENY-all
 * policy), so storing it beside the bot's key would make the scoping pointless.
 *
 * Supply it for this one command and nowhere else:
 *
 *   TURNKEY_ROOT_PUBLIC_KEY=... TURNKEY_ROOT_PRIVATE_KEY=... \
 *     npx tsx scripts/turnkey-allow-v2-factory.ts --execute
 *
 * Nothing here writes, echoes or logs either value.
 */
import { config } from '../src/config';
import { executableDeployment, deploymentById } from '../src/deployments';
import { findEquivalentPolicy, sameNameDifferentMeaning } from '../src/turnkeyPolicyMatch';

const EXECUTE = process.argv.includes('--execute');
/**
 * Named per deployment, and that is not cosmetic.
 *
 * A policy called "launch on the v2 factory" already exists and points at
 * 0x7E1EAbd5…, which pons replaced. With a shared name the duplicate check below
 * would find it, report "nothing to do", and leave the bot unable to sign for the
 * factory it actually launches through -- a refusal arriving after the splitter had
 * been deployed and paid for.
 */
const policyNameFor = (id: string) => `ponsr-bot: launch on ${id}`;
const BOT_USER_NAME = 'ponsr-bot';

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

async function main() {
  const { Turnkey } = require('@turnkey/sdk-server');

  const rootPublic = process.env.TURNKEY_ROOT_PUBLIC_KEY;
  const rootPrivate = process.env.TURNKEY_ROOT_PRIVATE_KEY;
  const organizationId = config.TURNKEY_ORGANIZATION_ID;

  if (!organizationId) {
    console.error('TURNKEY_ORGANIZATION_ID is not set.');
    process.exit(1);
  }
  // From the registry, not from configuration. The policy has to name the factory the
  // bot will actually call, and an address settable independently of the ABI is how a
  // policy comes to allow a contract nobody launches through -- which is precisely
  // what happened: the previous plan targeted 0x7E1EAbd5…, a deployment pons replaced
  // on 2026-08-03 and which no longer accepts the calldata this bot builds.
  const target = executableDeployment();
  const v1Addr = deploymentById('pons-v1').factory.toLowerCase();
  const v2Addr = target.factory.toLowerCase();
  const superseded = deploymentById('pons-v2-legacy-7e1').factory.toLowerCase();

  // The plan needs no credentials, and this script originally demanded them anyway --
  // which meant the only way to see what it would do was to hand it the one key that can
  // rewrite the treasury's guard rails. Everything below comes from config. Nothing is
  // sent to Turnkey and nothing is changed.
  if (!EXECUTE) {
    console.log('=== PLAN ONLY (no credentials used, nothing contacted, nothing changed) ===');
    line('organization', organizationId);
    line('v1 factory', `${v1Addr}  (already allowed)`);
    line('current factory', `${v2Addr}  (to allow — ${target.id})`);
    line('superseded factory', `${superseded}  (deliberately NOT allowed)`);
    line('launch selector', target.launchSelector);
    console.log('\nPolicy this would create');
    line('name', policyNameFor(target.id));
    line('effect', 'ALLOW, for the ponsr-bot user only');
    line('condition', `eth.tx.to == '${v2Addr}'`);
    console.log('\n  Additive. The existing v1 policy is not read, edited or replaced, so the');
    console.log('  contract-creation rule that lets the bot deploy a FeeSplitter stays exactly');
    console.log('  as it is, and deleting this one policy restores today\'s behaviour precisely.');
    console.log('\n  Still denied afterwards: any other destination from the bot user, and');
    console.log('  anything at all from a key that is not the bot\'s.');
    console.log('\nTo apply it, supply the ROOT credentials for this one command:');
    console.log('\n  TURNKEY_ROOT_PUBLIC_KEY=... TURNKEY_ROOT_PRIVATE_KEY=... \\');
    console.log('    npx tsx scripts/turnkey-allow-v2-factory.ts --execute');
    console.log('\n  Root is deliberately not in backend/.env: it bypasses the policy engine');
    console.log('  entirely, so keeping it beside the bot\'s key would make scoping pointless.');
    console.log('\n  Then confirm the policy still bites -- an over-wide rule looks identical');
    console.log('  to a correct one until the morning it matters:');
    console.log('    npx tsx scripts/turnkey-verify-policy.ts');
    return;
  }

  if (!rootPublic || !rootPrivate) {
    console.error(
      'Root credentials are required to execute, and are read only from the environment.\n\n' +
        '  TURNKEY_ROOT_PUBLIC_KEY=... TURNKEY_ROOT_PRIVATE_KEY=... \\\n' +
        '    npx tsx scripts/turnkey-allow-v2-factory.ts --execute\n\n' +
        'The bot\'s own key cannot create a policy -- that is what scoping it means.'
    );
    process.exit(1);
  }

  const client = new Turnkey({
    apiBaseUrl: 'https://api.turnkey.com',
    apiPublicKey: rootPublic,
    apiPrivateKey: rootPrivate,
    defaultOrganizationId: organizationId,
  }).apiClient();

  const v1 = v1Addr;
  const v2 = v2Addr;

  console.log('=== ALLOWING THE V2 FACTORY — EXECUTING ===');
  line('organization', organizationId);
  line('v1 factory (already allowed)', v1);
  line('v2 factory (to allow)', v2);

  const users = await client.getUsers({ organizationId });
  const bot = (users.users || []).find((u: any) => u.userName === BOT_USER_NAME);
  if (!bot) {
    console.error(`\nNo user named "${BOT_USER_NAME}". Run turnkey-scope-bot-user.ts first.`);
    process.exit(1);
  }
  line('bot userId', bot.userId);

  // Refuse to create a duplicate. Two identical allow policies are harmless but they
  // make the next person wonder which one is live, and wondering is how a policy
  // gets deleted for being redundant when it is not.
  const existing = await client.getPolicies({ organizationId });
  const wanted = {
    organizationId,
    effect: 'EFFECT_ALLOW',
    consensus: `approvers.any(user, user.id == '${bot.userId}')`,
    condition: `eth.tx.to == '${v2}'`,
    policyName: policyNameFor(target.id),
  };

  // Equivalence by MEANING, not by name.
  //
  // This compared `policyName`, the one field that has nothing to do with what a policy
  // permits, and it fails in both directions. Right name with the wrong condition
  // reports "nothing to do" and leaves the bot unable to sign for the factory it
  // launches through -- `ponsr-bot: launch on the v2 factory` already exists and names
  // the SUPERSEDED deployment. A different name with an identical condition is missed,
  // and a duplicate appears that nobody can tell apart from the live one.
  const already = findEquivalentPolicy(existing.policies || [], wanted);
  if (already) {
    line('existing policy', `found (${already.policyId}) — nothing to do`);
    line('  its name', String(already.policyName));
    line('  its condition', String(already.condition));
    console.log('\nAlready in place, matched by condition rather than by name.');
    console.log('Verify with:  npx tsx scripts/turnkey-verify-policy.ts');
    return;
  }

  // Not an error -- Turnkey permits duplicate names -- but an operator should see it
  // before a second rule appears under a name they already recognise.
  for (const clash of sameNameDifferentMeaning(existing.policies || [], wanted)) {
    line('NAME COLLISION', `${clash.policyId} is also called "${clash.policyName}"`);
    line('  but permits', String(clash.condition));
  }

  console.log('\nPolicy this will create');
  line('name', policyNameFor(target.id));
  line('effect', 'ALLOW, for the bot user only');
  line('rule', `sign a transaction to ${v2}`);
  console.log('  The existing v1 policy is NOT modified. Contract creation stays covered by it,');
  console.log('  so splitter deployment is unaffected either way.');
  console.log('  Everything still denied: any other destination, from this user.');

  if (!EXECUTE) {
    console.log('\nPlan only. Re-run with --execute.');
    return;
  }

  const policy = await client.createPolicy({
    organizationId,
    policyName: policyNameFor(target.id),
    effect: 'EFFECT_ALLOW',
    consensus: `approvers.any(user, user.id == '${bot.userId}')`,
    // Only the destination. The value ceiling is enforced in validator.ts against the
    // live fee, and duplicating it here as a constant would be a second number to keep
    // in step with a fee pons can change.
    condition: `eth.tx.to == '${v2}'`,
    notes: `ponsr: launch on ${target.id} (${target.factory}), selector ${target.launchSelector}. Additive to the v1 policy.`,
  });

  const policyId = policy?.policyId ?? policy?.activity?.result?.createPolicyResult?.policyId;
  line('policyId', policyId);

  console.log('\nDone. Confirm it actually bites before moving the executable deployment:');
  console.log('  npx tsx scripts/turnkey-verify-policy.ts');
  console.log('\nThat script must still show an arbitrary destination DENIED. If this policy');
  console.log('were mis-scoped, the bot would be able to send the treasury anywhere, and a');
  console.log('policy that permits everything looks exactly like one that permits the right');
  console.log('thing until the morning it matters.');
}

main().catch((err) => {
  console.error('Failed:', err?.message ?? err);
  process.exit(1);
});
