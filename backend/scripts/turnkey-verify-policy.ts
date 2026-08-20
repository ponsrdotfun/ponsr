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

  /**
   * Three outcomes, not two.
   *
   * This returned a boolean, and every failure became `false` -- which the report then
   * printed as "denied". On 2026-08-20 the Turnkey organisation went over its signing
   * quota, so every request failed for a reason that has nothing to do with policy,
   * and the script announced NOT SAFE YET and told the operator to fix a policy that
   * had just been created correctly.
   *
   * A verification tool that cannot tell "the policy said no" from "I could not ask"
   * is worse than one that refuses to answer: it sends someone to change security
   * configuration that was not broken.
   */
  type Outcome = 'allowed' | 'denied' | 'unknown';

  async function attempt(name: string, tx: any): Promise<Outcome> {
    try {
      await signer.signTransaction(tx);
      return 'allowed';
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      // A policy denial is the only failure that means "denied".
      if (/permission|policy|not authorized/i.test(msg)) return 'denied';
      // Everything else -- quota, network, a malformed request -- is unknown, and
      // saying so is the whole point.
      line(name + ' (could not ask)', msg.slice(0, 110));
      return 'unknown';
    }
  }

  /** How an outcome reads in the report. */
  function show(o: Outcome, expected: 'allowed' | 'denied'): string {
    if (o === 'unknown') return 'UNKNOWN -- not asked, see the error above';
    if (o === expected) return o === 'allowed' ? 'ALLOWED ✅' : 'denied ✅';
    return o === 'allowed' ? 'ALLOWED ❌' : 'denied ❌';
  }

  console.log('=== VERIFYING THE BOT POLICY ===');
  line('signer', from);
  line('v1 factory', config.PONS_FACTORY_ADDRESS);
  line('v2 factory', config.PONS_V2_FACTORY_ADDRESS);
  line('bot launches through', `${config.PONS_FACTORY_VERSION}  <- the one that has to be ALLOWED`);
  console.log('');

  // Both factories, always. This script used to test only v1 and print PASSED, which on
  // 2026-08-19 reported a healthy policy immediately after an attempt to widen it to v2
  // had silently failed to run at all. A green tick about the contract you are not
  // changing is worse than no tick: it answers a question nobody asked, in the voice of
  // the one they did.
  const toV1 = await attempt('launch v1', {
    ...base,
    to: config.PONS_FACTORY_ADDRESS,
    value: 500000000000000n,
    data: '0x12345678',
  });
  line('1a. tx to the v1 factory', show(toV1, 'allowed'));

  const toV2 = await attempt('launch v2', {
    ...base,
    to: config.PONS_V2_FACTORY_ADDRESS,
    value: 500000000000000n,
    data: '0x12345678',
  });
  line('1b. tx to the v2 factory', show(toV2, 'allowed'));

  const wantV2 = config.PONS_FACTORY_VERSION === 'v2';
  const toFactory = wantV2 ? toV2 : toV1;

  const deploy = await attempt('deploy', {
    ...base,
    data: '0x60806040523480156100',
    value: 0n,
  });
  line('2. contract creation', show(deploy, 'allowed'));

  const elsewhere = await attempt('elsewhere', {
    ...base,
    to: ARBITRARY,
    value: 1000000000000000000n,
    data: '0x',
  });
  line('3. tx to an arbitrary address', show(elsewhere, 'denied'));

  console.log('');
  // Unknown anywhere means the run proves nothing, in either direction. Reporting
  // PASSED on unanswered questions would be the same defect pointing the other way.
  const unknowns = [toV1, toV2, deploy, elsewhere].filter((o) => o === 'unknown').length;
  if (unknowns > 0) {
    console.log('=== INCONCLUSIVE ===');
    console.log(`  ${unknowns} of 4 checks could not be asked, so this run proves nothing.`);
    console.log('  The most common cause is the Turnkey organisation being over its signing');
    console.log('  quota, which disables signing for everything and is not a policy problem.');
    console.log('  Nothing here says the policy is wrong, and nothing says it is right.');
    process.exitCode = 1;
    return;
  }

  const good = toFactory === 'allowed' && deploy === 'allowed' && elsewhere === 'denied';
  if (good) {
    console.log('=== PASSED ===');
    console.log(`The bot can launch on ${config.PONS_FACTORY_VERSION} and deploy splitters, and`);
    console.log('cannot move funds anywhere else.');
    console.log('A leak of this key now costs launches, not the treasury.');
    console.log('');
    console.log('Safe to set TURNKEY_POLICY_CONFIRMED=true in backend/.env.');
    if (toV2 !== 'allowed') {
      console.log('');
      console.log('NOTE: the v2 factory is still denied. That is fine while the bot runs v1,');
      console.log('but switching PONS_FACTORY_VERSION to v2 would produce a bot that passes');
      console.log('every check it makes of pons and is then refused by its own signer --');
      console.log('after the splitter has been deployed and paid for.');
      console.log('  bash scripts/apply-v2-policy.sh --execute');
    }
  } else {
    console.log('=== NOT SAFE YET ===');
    if (toFactory !== 'allowed') {
      console.log(`  The bot launches through ${config.PONS_FACTORY_VERSION}, and that factory is DENIED.`);
      console.log('  It cannot launch anything at all.');
      if (wantV2) console.log('  Fix: bash scripts/apply-v2-policy.sh --execute');
    }
    if (deploy !== 'allowed') console.log('  Contract creation is denied -- the bot cannot deploy splitters.');
    if (elsewhere === 'allowed') console.log('  The policy is not restricting anything. Do NOT fund this wallet.');
  }
  process.exitCode = good ? 0 : 1;
})().catch((err) => {
  console.error('FAILED:', err?.message ?? err);
  process.exit(1);
});
