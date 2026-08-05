/**
 * Moves the bot off the root key and onto a scoped one.
 *
 *   npx ts-node scripts/turnkey-scope-bot-user.ts            # plan only
 *   npx ts-node scripts/turnkey-scope-bot-user.ts --execute
 *
 * WHY
 * ---
 * `turnkey-policy-probe.ts` measured it: the root user bypasses the policy engine. A DENY-all
 * policy was active and a signature still went through. So a policy written for the root key
 * is decoration -- it shows up in the dashboard and enforces nothing, which is worse than no
 * policy at all, because it stops anyone looking harder.
 *
 * This creates an API-only, non-root user for the bot, gives it its own key, and writes a
 * policy that grants that user exactly two things:
 *
 *   1. sign a transaction to the pons factory   (launching)
 *   2. sign a contract creation                 (deploying the per-launch FeeSplitter)
 *
 * The second is why the policy is "wider" than the obvious one: a launch is two transactions,
 * and the splitter deployment has no destination address at all. A policy scoped only to the
 * factory rejects it, and the launch fails halfway -- splitter deployed, token never created,
 * gas spent.
 *
 * Root stays exactly as it is. Nothing about it is modified, and it remains the operator's
 * way to administer the organization -- including deleting anything this script creates.
 *
 * The new private key is written straight into backend/.env and never printed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../src/config';

const EXECUTE = process.argv.includes('--execute');
const ENV_PATH = path.join(__dirname, '..', '.env');
const USER_NAME = 'ponsr-bot';
const KEY_NAME = 'ponsr-bot-api-key';
const POLICY_NAME = 'ponsr-bot: launch + splitter deploy only';

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

/** Replaces a key's value in .env, or appends it. Never logs the value. */
function setEnv(contents: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(contents)) return contents.replace(re, `${key}=${value}`);
  return contents.replace(/\n*$/, '\n') + `${key}=${value}\n`;
}

(async () => {
  for (const k of ['TURNKEY_ORGANIZATION_ID', 'TURNKEY_API_PUBLIC_KEY', 'TURNKEY_API_PRIVATE_KEY'] as const) {
    if (!config[k]) {
      console.error(`${k} is not set. Fill backend/.env first.`);
      process.exit(1);
    }
  }

  const { Turnkey } = require('@turnkey/sdk-server');
  const { generateP256KeyPair } = require('@turnkey/crypto');

  const organizationId = config.TURNKEY_ORGANIZATION_ID!;
  const client = new Turnkey({
    apiBaseUrl: 'https://api.turnkey.com',
    apiPublicKey: config.TURNKEY_API_PUBLIC_KEY!,
    apiPrivateKey: config.TURNKEY_API_PRIVATE_KEY!,
    defaultOrganizationId: organizationId,
  }).apiClient();

  console.log(EXECUTE ? '=== SCOPING THE BOT USER — EXECUTING ===' : '=== PLAN ONLY (nothing is created) ===');
  line('organization', organizationId);
  line('factory', config.PONS_FACTORY_ADDRESS);

  const existing = await client.getUsers({ organizationId });
  const already = (existing.users || []).find((u: any) => u.userName === USER_NAME);
  line('existing bot user', already ? `found (${already.userId})` : 'none');

  console.log('\nPolicy this will create');
  line('name', POLICY_NAME);
  line('effect', 'ALLOW, for the bot user only');
  line('rule 1', `sign a transaction to ${config.PONS_FACTORY_ADDRESS}`);
  line('rule 2', 'sign a contract creation (the FeeSplitter deployment)');
  console.log('  Everything else that user attempts is denied by default, because Turnkey');
  console.log('  denies any activity no policy allows -- for non-root users.');

  if (!EXECUTE) {
    console.log('\nPlan only. Re-run with --execute.');
    return;
  }

  // 1. Key pair. Generated here so the private half goes straight to .env.
  const keyPair = generateP256KeyPair();
  const publicKey: string = keyPair.publicKey;
  const privateKey: string = keyPair.privateKey;

  // 2. The user.
  let userId: string;
  if (already) {
    userId = already.userId;
    console.log('\n1/4  Reusing the existing bot user...');
    await client.createApiKeys({
      organizationId,
      userId,
      apiKeys: [{ apiKeyName: `${KEY_NAME}-${Date.now()}`, publicKey, curveType: 'API_KEY_CURVE_P256' }],
    });
  } else {
    console.log('\n1/4  Creating an API-only, non-root user...');
    // createUsers, not createApiOnlyUsers -- the latter does not exist on SDK v7. An
    // API-only user is simply one with an API key and no authenticators: it can never sign
    // in to the dashboard, which is what we want for a credential a server holds.
    const created = await client.createUsers({
      organizationId,
      users: [
        {
          userName: USER_NAME,
          apiKeys: [{ apiKeyName: KEY_NAME, publicKey, curveType: 'API_KEY_CURVE_P256' }],
          authenticators: [],
          oauthProviders: [],
          userTags: [],
        },
      ],
    });
    userId = created?.userIds?.[0] ?? created?.activity?.result?.createUsersResult?.userIds?.[0];
  }
  line('userId', userId);

  // 3. The policy. Two allowed shapes, one rule.
  console.log('\n2/4  Writing the policy...');
  const factory = String(config.PONS_FACTORY_ADDRESS).toLowerCase();
  const policy = await client.createPolicy({
    organizationId,
    policyName: POLICY_NAME,
    effect: 'EFFECT_ALLOW',
    consensus: `approvers.any(user, user.id == '${userId}')`,
    // eth.tx.to is empty for a contract creation, which is how the splitter deploy is
    // distinguished -- and why it needs naming explicitly rather than being covered by
    // the factory rule.
    condition: `eth.tx.to == '${factory}' || eth.tx.to == ''`,
    notes: 'ponsr: launch on the pons factory, and deploy the per-launch FeeSplitter. Nothing else.',
  });
  const policyId = policy?.policyId ?? policy?.activity?.result?.createPolicyResult?.policyId;
  line('policyId', policyId);

  // 4. Point .env at the new key.
  console.log('\n3/4  Updating backend/.env (the private key is not printed)...');
  let env = fs.readFileSync(ENV_PATH, 'utf8');
  // Preserve the root key before overwriting. Losing it would mean losing the only way to
  // administer the organization from the API -- including undoing everything above. It is
  // parked under a different name rather than deleted, and flagged: two credentials of very
  // different power in one file means a single leak exposes both.
  env = setEnv(env, 'TURNKEY_ROOT_API_PUBLIC_KEY', config.TURNKEY_API_PUBLIC_KEY!);
  env = setEnv(env, 'TURNKEY_ROOT_API_PRIVATE_KEY', config.TURNKEY_API_PRIVATE_KEY!);
  env = setEnv(env, 'TURNKEY_API_PUBLIC_KEY', publicKey);
  env = setEnv(env, 'TURNKEY_API_PRIVATE_KEY', privateKey);
  fs.writeFileSync(ENV_PATH, env, { encoding: 'utf8', mode: 0o600 });
  line('TURNKEY_API_*', 'now the bot user\'s key');
  console.log('  The root key is preserved as TURNKEY_ROOT_API_* and is no longer what the bot');
  console.log('  uses. Move it out of this file once the verification below passes: two');
  console.log('  credentials of very different power in one file means one leak exposes both.');
  console.log('  You can always mint a fresh root API key from the dashboard with your passkey,');
  console.log('  so deleting it here loses nothing.');

  console.log('\n4/4  Now VERIFY, do not assume:');
  console.log('  npx ts-node scripts/turnkey-policy-probe.ts');
  console.log('  It must now report BLOCKED under a DENY-all policy. If it still signs, the');
  console.log('  policy is not biting and this achieved nothing -- which is exactly the');
  console.log('  failure this whole exercise exists to catch.');
})().catch((err) => {
  console.error('\nFAILED:', err?.message ?? err);
  process.exit(1);
});
