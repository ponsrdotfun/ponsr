/**
 * Creates a scoped non-root Turnkey bot identity. Root credentials are inputs only and are
 * never copied into backend/.env. This command is plan-only unless every explicit target,
 * --execute, and the exact typed acknowledgement are supplied.
 *
 * Example:
 *   npx ts-node scripts/turnkey-scope-bot-user.ts \
 *     --organization-id=<org> --user-name=ponsr-bot \
 *     --policy-name='ponsr-bot: launch + splitter deploy only'
 *
 * Execution additionally requires:
 *   --execute --acknowledge='CREATE <org> ponsr-bot ponsr-bot: launch + splitter deploy only'
 *   --root-key-file=/operator-only/path/turnkey-root-key.json
 *   --bot-key-output=/operator-only/path/ponsr-bot-key.json
 *   --recovery-output=./data/turnkey-scope-recovery.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../src/config';

const EXECUTE = process.argv.includes('--execute');
const valueFor = (name: string): string | undefined => {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};

const organizationId = valueFor('--organization-id');
const userName = valueFor('--user-name');
const policyName = valueFor('--policy-name');
const acknowledgement = valueFor('--acknowledge');
const rootKeyFile = valueFor('--root-key-file');
const botKeyOutput = valueFor('--bot-key-output');
const recoveryOutput = valueFor('--recovery-output');
const EXPECTED_USER = 'ponsr-bot';
const EXPECTED_POLICY = 'ponsr-bot: launch + splitter deploy only';

type Recovery = {
  status: 'planned' | 'partial' | 'complete';
  organizationId: string;
  userName: string;
  policyName: string;
  userId?: string;
  apiKeyId?: string;
  policyId?: string;
  error?: string;
};

function requireExactTargets(): asserts organizationId is string {
  if (!organizationId || !userName || !policyName) {
    throw new Error('Exact --organization-id, --user-name, and --policy-name targets are required.');
  }
  if (userName !== EXPECTED_USER || policyName !== EXPECTED_POLICY) {
    throw new Error(`Targets must be exactly user "${EXPECTED_USER}" and policy "${EXPECTED_POLICY}".`);
  }
}

function writeRecovery(state: Recovery) {
  if (!recoveryOutput) throw new Error('--recovery-output is required for execution.');
  fs.mkdirSync(path.dirname(path.resolve(recoveryOutput)), { recursive: true });
  fs.writeFileSync(recoveryOutput, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

(async () => {
  requireExactTargets();
  const expectedAck = `CREATE ${organizationId} ${userName} ${policyName}`;
  console.log(EXECUTE ? '=== TURNKEY BOT SCOPE — EXECUTION REQUESTED ===' : '=== PLAN ONLY ===');
  console.log(`  organization             ${organizationId}`);
  console.log(`  user                     ${userName}`);
  console.log(`  policy                   ${policyName}`);
  console.log(`  factory                  ${config.PONS_FACTORY_ADDRESS}`);
  console.log('  root credentials         input only; never written to .env or output files');
  console.log('  bot credential           separate operator-only file; never written to .env');
  console.log('  recovery                 non-secret ids and partial-failure state only');

  if (!EXECUTE) {
    console.log('\nNothing was read from Turnkey and nothing was created.');
    console.log(`To execute, add --execute and --acknowledge='${expectedAck}'.`);
    return;
  }
  if (acknowledgement !== expectedAck) throw new Error(`Typed acknowledgement must exactly equal: ${expectedAck}`);
  if (!rootKeyFile || !botKeyOutput || !recoveryOutput) {
    throw new Error('--root-key-file, --bot-key-output, and --recovery-output are required for execution.');
  }
  const rootKey = JSON.parse(fs.readFileSync(rootKeyFile, 'utf8')) as {
    organizationId?: string;
    apiPublicKey?: string;
    apiPrivateKey?: string;
  };
  if (rootKey.organizationId !== organizationId || !rootKey.apiPublicKey || !rootKey.apiPrivateKey) {
    throw new Error('Root key file must contain the exact organizationId, apiPublicKey, and apiPrivateKey.');
  }

  const { Turnkey } = require('@turnkey/sdk-server');
  const { generateP256KeyPair } = require('@turnkey/crypto');
  const client = new Turnkey({
    apiBaseUrl: 'https://api.turnkey.com',
    apiPublicKey: rootKey.apiPublicKey,
    apiPrivateKey: rootKey.apiPrivateKey,
    defaultOrganizationId: organizationId,
  }).apiClient();
  const state: Recovery = { status: 'partial', organizationId, userName: userName!, policyName: policyName! };
  writeRecovery(state);

  try {
    const keyPair = generateP256KeyPair();
    const existing = await client.getUsers({ organizationId });
    const already = (existing.users || []).find((user: any) => user.userName === userName);
    let apiKeyId: string | undefined;
    if (already) {
      state.userId = already.userId;
      const created = await client.createApiKeys({
        organizationId,
        userId: state.userId,
        apiKeys: [{ apiKeyName: `ponsr-bot-api-key-${Date.now()}`, publicKey: keyPair.publicKey, curveType: 'API_KEY_CURVE_P256' }],
      });
      apiKeyId = created?.apiKeyIds?.[0] ?? created?.activity?.result?.createApiKeysResult?.apiKeyIds?.[0];
    } else {
      const created = await client.createUsers({
        organizationId,
        users: [{
          userName,
          apiKeys: [{ apiKeyName: 'ponsr-bot-api-key', publicKey: keyPair.publicKey, curveType: 'API_KEY_CURVE_P256' }],
          authenticators: [], oauthProviders: [], userTags: [],
        }],
      });
      state.userId = created?.userIds?.[0] ?? created?.activity?.result?.createUsersResult?.userIds?.[0];
      apiKeyId = created?.apiKeyIds?.[0] ?? created?.activity?.result?.createUsersResult?.apiKeyIds?.[0];
    }
    if (!state.userId) throw new Error('Turnkey did not return the created or existing user id.');
    state.apiKeyId = apiKeyId;
    writeRecovery(state);

    fs.writeFileSync(botKeyOutput, `${JSON.stringify({
      organizationId,
      userId: state.userId,
      apiPublicKey: keyPair.publicKey,
      apiPrivateKey: keyPair.privateKey,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    const factory = String(config.PONS_FACTORY_ADDRESS).toLowerCase();
    const policy = await client.createPolicy({
      organizationId,
      policyName,
      effect: 'EFFECT_ALLOW',
      consensus: `approvers.any(user, user.id == '${state.userId}')`,
      condition: `eth.tx.to == '${factory}' || eth.tx.to == ''`,
      notes: 'ponsr bot: launch on the selected factory and deploy the per-launch splitter.',
    });
    state.policyId = policy?.policyId ?? policy?.activity?.result?.createPolicyResult?.policyId;
    if (!state.policyId) throw new Error('Turnkey did not return the created policy id.');
    state.status = 'complete';
    writeRecovery(state);

    console.log('\nCreated. Store the bot key file in the bot secret store; do not combine it with root credentials.');
    console.log('Verify without a deny-all mutation: npm run signer:verify-policy');
  } catch (error: any) {
    state.status = 'partial';
    state.error = 'operation failed; inspect operator console without copying secrets into recovery state';
    writeRecovery(state);
    throw error;
  }
})().catch((error) => {
  console.error('\nFAILED:', error?.message ?? error);
  process.exit(1);
});
