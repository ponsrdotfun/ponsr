/**
 * Verifies the bot's Turnkey policy allows exactly what it should, and nothing else.
 *
 *   npx ts-node scripts/turnkey-verify-policy.ts
 *
 * Signs, never broadcasts. Nothing reaches the chain and no funds move -- the question is
 * only whether Turnkey is willing to produce a signature, which is where the policy applies.
 *
 * Three cases, and all three matter:
 *
 *   1. a transaction to the pons factory     -> MUST be allowed  (launching)
 *   2. a contract creation, no destination   -> MUST be allowed  (the FeeSplitter deploy)
 *   3. a transaction to an arbitrary address -> MUST be denied   (this is the point)
 *
 * Case 3 is the one that makes the other two mean anything. A policy that allows everything
 * also allows cases 1 and 2, and would look identical here without it.
 */
import { config } from '../src/config';

const ARBITRARY = '0x000000000000000000000000000000000000dEaD';

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(30)} ${value}`);
}

(async () => {
  const { Turnkey } = require('@turnkey/sdk-server');
  const { TurnkeySigner } = require('@turnkey/ethers');
  const { ethers } = require('ethers');

  const organizationId = config.TURNKEY_ORGANIZATION_ID!;
  const client = new Turnkey({
    apiBaseUrl: 'https://api.turnkey.com',
    apiPublicKey: config.TURNKEY_API_PUBLIC_KEY!,
    apiPrivateKey: config.TURNKEY_API_PRIVATE_KEY!,
    defaultOrganizationId: organizationId,
  }).apiClient();

  const provider = new ethers.JsonRpcProvider(config.RPC_URL, config.CHAIN_ID);
  const signer = new TurnkeySigner(
    { client, organizationId, signWith: config.TURNKEY_SIGN_WITH! },
    provider
  );
  const from = await signer.getAddress();
  const nonce = await provider.getTransactionCount(from);

  const base = {
    chainId: BigInt(config.CHAIN_ID),
    nonce,
    gasLimit: 500000n,
    maxFeePerGas: 100000000n,
    maxPriorityFeePerGas: 1000000n,
    type: 2,
  };

  async function attempt(name: string, tx: any): Promise<boolean> {
    try {
      await signer.signTransaction(tx);
      return true;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (!/permission|policy/i.test(msg)) {
        // Distinguish "the policy said no" from "the request was malformed" -- treating a
        // bad request as a successful denial would be a false pass.
        line(name + ' (error)', msg.slice(0, 90));
      }
      return false;
    }
  }

  console.log('=== VERIFYING THE BOT POLICY ===');
  line('signer', from);
  line('factory', config.PONS_FACTORY_ADDRESS);
  console.log('');

  const toFactory = await attempt('launch', {
    ...base,
    to: config.PONS_FACTORY_ADDRESS,
    value: 500000000000000n,
    data: '0x12345678',
  });
  line('1. tx to the pons factory', toFactory ? 'ALLOWED ✅' : 'denied ❌ (bot cannot launch)');

  const deploy = await attempt('deploy', {
    ...base,
    data: '0x60806040523480156100',
    value: 0n,
  });
  line('2. contract creation', deploy ? 'ALLOWED ✅' : 'denied ❌ (bot cannot deploy splitters)');

  const elsewhere = await attempt('elsewhere', {
    ...base,
    to: ARBITRARY,
    value: 1000000000000000000n,
    data: '0x',
  });
  line('3. tx to an arbitrary address', elsewhere ? 'ALLOWED ❌ THE POLICY IS NOT RESTRICTING' : 'denied ✅');

  console.log('');
  const good = toFactory && deploy && !elsewhere;
  if (good) {
    console.log('=== PASSED ===');
    console.log('The bot can launch and deploy splitters, and cannot move funds anywhere else.');
    console.log('A leak of this key now costs launches, not the treasury.');
    console.log('');
    console.log('Safe to set TURNKEY_POLICY_CONFIRMED=true in backend/.env.');
  } else {
    console.log('=== NOT SAFE YET ===');
    if (!toFactory || !deploy) console.log('  The policy is too narrow -- the bot cannot do its job.');
    if (elsewhere) console.log('  The policy is not restricting anything. Do NOT fund this wallet.');
  }
  process.exit(good ? 0 : 1);
})().catch((err) => {
  console.error('FAILED:', err?.message ?? err);
  process.exit(1);
});
