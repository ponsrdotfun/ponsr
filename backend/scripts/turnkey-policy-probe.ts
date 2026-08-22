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

/**
 * TWO gates, because one is not enough for this script.
 *
 * This probe creates a DENY-EVERYTHING policy on the live organisation to find out
 * whether policies bite, then removes it in a `finally`. Between those two steps, signing
 * is disabled for every key in the organisation -- and if the process dies, or the delete
 * fails, it stays that way. That is precisely the state that cost a day on 2026-08-20,
 * reached from the other direction.
 *
 * It used to run on its name alone. `--execute` is one keystroke from a shell history
 * entry, so it also needs a sentence the operator has to mean.
 */
const EXECUTE = process.argv.includes('--execute');
const ACK_PHRASE = 'I-UNDERSTAND-THIS-DISABLES-SIGNING';
const ACKNOWLEDGED = process.argv.includes(`--acknowledge=${ACK_PHRASE}`);

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

  // Everything above this line was a read. Everything below changes the organisation.
  if (!EXECUTE || !ACKNOWLEDGED) {
    console.log('\n=== PLAN ONLY — nothing was created and nothing was changed ===');
    console.log('');
    console.log('  This probe would create a DENY-EVERYTHING policy on organisation');
    console.log('  ' + organizationId);
    console.log('  named "' + POLICY_NAME + '", try to sign under it, and then delete it.');
    console.log('');
    console.log('  While that policy exists, NO KEY IN THIS ORGANISATION CAN SIGN. If this');
    console.log('  process dies in between, or the delete fails, it stays that way until');
    console.log('  somebody removes it by hand.');
    console.log('');
    console.log('  There is usually a better question to ask. `turnkey-read-policies.ts`');
    console.log('  shows what the rules say, and `turnkey-verify-policy.ts` proves what a');
    console.log('  scoped key can and cannot sign -- neither changes anything.');
    console.log('');
    console.log('  To run it anyway, both of these:');
    console.log('');
    console.log('    npx tsx scripts/turnkey-policy-probe.ts \\');
    console.log('      --execute --acknowledge=' + ACK_PHRASE);
    console.log('');
    process.exit(EXECUTE ? 1 : 0);
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
    // Printed immediately and unmistakably. If this process dies before the delete,
    // this line is the only record of what has to be removed by hand.
    console.log('');
    console.log('  >>> PROBE POLICY ID: ' + (policyId ?? '(NOT RETURNED -- find it by name)'));
    console.log('  >>> If anything goes wrong from here, DELETE THAT POLICY.');
    console.log('');

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
      let deleted = false;
      try {
        await client.deletePolicy({ organizationId, policyId });
        // `deletePolicy` returning without throwing is not proof the policy is gone.
        // The only proof is that it no longer appears, so this asks.
        const after = await client.getPolicies({ organizationId });
        deleted = !(after.policies || []).some((x: any) => x.policyId === policyId);
      } catch (err: any) {
        console.error('\n  cleanup call failed: ' + (err?.message ?? err));
      }

      if (deleted) {
        console.log('\n  cleanup: probe policy deleted, and verified absent.');
      } else {
        console.error('\n  ############################################################');
        console.error('  INCIDENT: THE DENY-ALL POLICY MAY STILL BE ACTIVE.');
        console.error('');
        console.error('  While it exists, nothing in this organisation can sign -- the bot');
        console.error('  cannot launch and no verifier can answer.');
        console.error('');
        console.error('  Delete it now, by hand, in the Turnkey dashboard:');
        console.error('     ' + POLICY_NAME + '  (' + policyId + ')');
        console.error('  ############################################################');
        process.exitCode = 1;
      }
    }
  }
})().catch((err) => {
  console.error('\nFAILED:', err?.message ?? err);
  process.exit(1);
});
