/**
 * Answers one question: does a Turnkey policy actually restrict the key the bot holds?
 *
 *   npx ts-node scripts/turnkey-policy-probe.ts
 *
 * WHY THIS EXISTS
 * ---------------
 * The API key is on the organization's **root user**. Turnkey's root quorum is widely
 * understood to bypass the policy engine -- deliberately, so an operator cannot lock
 * themselves out of their own organization. If that holds here, then writing a policy for
 * this key achieves nothing while *appearing* in the dashboard as protection, which is worse
 * than having none: it is a security control that reports success and does nothing.
 *
 * Rather than assume, this measures it:
 *   1. create a DENY-everything policy
 *   2. attempt a signature
 *   3. report whether it was blocked
 *   4. delete the policy, always
 *
 * Safe to run: it signs a message, never a transaction, and the wallet holds no funds. The
 * cleanup is in a finally block because a probe that leaves a DENY-all policy behind on
 * failure would be worse than the uncertainty it set out to remove.
 */
import { config } from '../src/config';

const POLICY_NAME = 'ponsr-probe-deny-all-DELETE-ME';

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

(async () => {
  for (const k of ['TURNKEY_ORGANIZATION_ID', 'TURNKEY_API_PUBLIC_KEY', 'TURNKEY_API_PRIVATE_KEY', 'TURNKEY_SIGN_WITH'] as const) {
    if (!config[k]) {
      console.error(`${k} is not set. Fill backend/.env first.`);
      process.exit(1);
    }
  }

  const { Turnkey } = require('@turnkey/sdk-server');
  const { TurnkeySigner } = require('@turnkey/ethers');
  const { ethers } = require('ethers');

  const organizationId = config.TURNKEY_ORGANIZATION_ID!;
  const turnkey = new Turnkey({
    apiBaseUrl: 'https://api.turnkey.com',
    apiPublicKey: config.TURNKEY_API_PUBLIC_KEY!,
    apiPrivateKey: config.TURNKEY_API_PRIVATE_KEY!,
    defaultOrganizationId: organizationId,
  });
  const client = turnkey.apiClient();
  const provider = new ethers.JsonRpcProvider(config.RPC_URL, config.CHAIN_ID);
  const signer = new TurnkeySigner(
    { client, organizationId, signWith: config.TURNKEY_SIGN_WITH! },
    provider
  );

  console.log('=== BASELINE (no policy) ===');
  let baselineOk = false;
  try {
    const sig = await signer.signMessage('ponsr policy probe');
    baselineOk = typeof sig === 'string' && sig.startsWith('0x');
    line('signMessage', baselineOk ? 'succeeded' : 'unexpected result');
  } catch (err: any) {
    line('signMessage', 'FAILED: ' + (err?.message ?? err));
  }
  if (!baselineOk) {
    console.error('\nSigning does not work even without a policy, so this probe cannot');
    console.error('distinguish anything. Fix the credentials first (check-providers.ts).');
    process.exit(1);
  }

  let policyId: string | null = null;
  try {
    console.log('\n=== APPLYING A DENY-EVERYTHING POLICY ===');
    const created = await client.createPolicy({
      organizationId,
      policyName: POLICY_NAME,
      effect: 'EFFECT_DENY',
      condition: 'true',
      notes: 'Temporary probe by ponsr. Safe to delete.',
    });
    policyId = created?.policyId ?? created?.activity?.result?.createPolicyResult?.policyId ?? null;
    line('policyId', policyId ?? '(created, id not returned)');

    console.log('\n=== SIGNING AGAIN, WITH DENY-ALL ACTIVE ===');
    let blocked = false;
    try {
      const sig = await signer.signMessage('ponsr policy probe');
      line('signMessage', 'STILL SUCCEEDED  (' + String(sig).slice(0, 14) + '…)');
    } catch (err: any) {
      blocked = true;
      line('signMessage', 'BLOCKED: ' + String(err?.message ?? err).slice(0, 110));
    }

    console.log('\n=== VERDICT ===');
    if (blocked) {
      console.log('  Policies DO restrict this key.');
      console.log('  A scoped ALLOW policy on this same user is therefore real protection,');
      console.log('  and widening it to cover contract creation is the right next step.');
    } else {
      console.log('  Policies DO NOT restrict this key -- it bypasses the policy engine.');
      console.log('  This is the root user. Writing any policy for it would appear in the');
      console.log('  dashboard and enforce nothing.');
      console.log('');
      console.log('  The fix is structural, not a wider policy: create a NON-root user for');
      console.log('  the bot, give that user its own API key, and scope it with a policy.');
      console.log('  Root stays yours, for administering the organization.');
    }
  } finally {
    if (policyId) {
      try {
        await client.deletePolicy({ organizationId, policyId });
        console.log('\n  cleanup: probe policy deleted.');
      } catch (err: any) {
        console.error('\n  ⚠️  CLEANUP FAILED -- delete this by hand in the dashboard:');
        console.error('     ' + POLICY_NAME + '  (' + policyId + ')');
        console.error('     ' + (err?.message ?? err));
      }
    }
  }
})().catch((err) => {
  console.error('\nFAILED:', err?.message ?? err);
  process.exit(1);
});
