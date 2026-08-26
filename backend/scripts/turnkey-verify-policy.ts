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
import { deploymentById, executableDeployment } from '../src/deployments';
import { classifyTurnkeyOutcome, describeOutcome, Outcome } from '../src/turnkeyOutcome';
import { splitterArtifactFor } from '../src/splitterDeployer';

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
   * Three outcomes, not two -- and decided from structured fields, never from prose.
   *
   * This returned a boolean, and every failure became `false`, printed as "denied". On
   * 2026-08-20 the organisation went over its signing quota, so every request failed
   * for a reason unrelated to policy, and the script announced NOT SAFE YET and sent
   * the operator to fix a policy created correctly minutes earlier.
   *
   * The first repair kept the guess and only widened it: `/permission|policy|not
   * authorized/i` against the message. Every Turnkey error carries a link to
   * `docs.turnkey.com/concepts/policies/`, so that rule reads a network timeout as a
   * refusal. Classification now lives in `src/turnkeyOutcome.ts` and reads gRPC code 7
   * plus the policy engine's own error type. See its header for the evidence.
   */
  async function attempt(name: string, tx: any): Promise<Outcome> {
    try {
      await signer.signTransaction(tx);
      return { kind: 'allowed' };
    } catch (err) {
      const outcome = classifyTurnkeyOutcome(err);
      if (outcome.kind === 'unknown') line(name + ' (could not ask)', outcome.detail.slice(0, 100));
      return outcome;
    }
  }

  const show = describeOutcome;

  // From the registry, because a config address is how this went wrong twice.
  //
  // On 2026-08-20 this script read `PONS_V2_FACTORY_ADDRESS` and reported PASSED for
  // 0x7E1EAbd5…, a deployment pons replaced on 2026-08-03 and which the bot no longer
  // calls. Every tick was green and none of them described the launch path. That is the
  // §11 lesson arriving inside the tool written to apply it: an address is not an
  // identity, and the registry is the only thing that knows which one is executable.
  const target = executableDeployment();
  const superseded = deploymentById('pons-v2-legacy-7e1');

  console.log('=== VERIFYING THE BOT POLICY ===');
  line('signer', from);
  line('v1 factory (deny-test only)', deploymentById('pons-v1').factory);
  line('current factory', `${target.factory}  (${target.id})`);
  line('superseded factory', `${superseded.factory}  (not launched through)`);
  line('bot launches through', `${target.id}  <- the one that has to be ALLOWED`);
  console.log('');

  // Both factories, always. This script used to test only v1 and print PASSED, which on
  // 2026-08-19 reported a healthy policy immediately after an attempt to widen it to v2
  // had silently failed to run at all. A green tick about the contract you are not
  // changing is worse than no tick: it answers a question nobody asked, in the voice of
  // the one they did.
  const toV1 = await attempt('launch v1', {
    ...base,
    to: deploymentById('pons-v1').factory,
    value: 500000000000000n,
    data: '0x12345678',
  });
  line('1a. tx to the v1 factory', show(toV1, 'allowed'));

  const toCurrent = await attempt('launch current', {
    ...base,
    to: target.factory,
    value: 500000000000000n,
    data: target.launchSelector,
  });
  line('1b. tx to the CURRENT factory', show(toCurrent, 'allowed'));

  /**
   * Which deployment the ROLLOUT needs, not which one config currently names.
   *
   * With the flag still on v1 this script would PASS while the current V2 factory was
   * denied -- and the runbook's very next step flips to v2. A gate that goes green
   * immediately before the change that invalidates it is not a gate.
   *
   *   --target-deployment pons-v2-current-7ed
   *
   * Given one, that deployment being denied is fatal regardless of the flag.
   */
  const targetArg = process.argv
    .find((a) => a.startsWith('--target-deployment='))
    ?.slice('--target-deployment='.length);
  const rolloutTarget = targetArg ? deploymentById(targetArg) : null;
  // A rollout target must be a deployment the bot could actually launch through. Naming a
  // superseded one used to be accepted and then checked against the v1 probe, which is a
  // DENY test -- so "the rollout target is allowed" would have meant the opposite of what
  // it says. v1 and v2-legacy are deny-test destinations here and nothing else.
  if (rolloutTarget && !rolloutTarget.executable) {
    console.error(
      `--target-deployment names ${rolloutTarget.id}, which is not executable ` +
        `(superseded by ${rolloutTarget.supersededBy ?? 'the current deployment'}). ` +
        'Rollback is a previous application image, not a superseded factory.'
    );
    process.exit(2);
  }
  if (rolloutTarget) line('rollout target', `${rolloutTarget.id}  <- must be ALLOWED`);

  // The executable deployment IS the answer. There is no longer a setting that can point
  // this probe at a factory the bot does not launch through -- which is what made a run
  // report four green ticks about the superseded contract.
  const toFactory = toCurrent;
  // The rollout target, when named, is checked in addition to the executable deployment.
  // Only an executable target can be named, and there is exactly one, so this is the
  // current probe. Never `toV1`, which is a DENY test.
  const rolloutOk = !rolloutTarget || toCurrent.kind === 'allowed';

  // The ACTUAL splitter initcode, not a ten-byte prefix.
  //
  // A prefix proves a creation is allowed in general. If exact-initcode binding is ever
  // chosen -- it is one of the two designs for closing the funded-creation finding --
  // a prefix would pass a rule that the real deployment then fails, which is the worst
  // possible time to discover the difference.
  const deploy = await attempt('deploy', {
    ...base,
    data: splitterArtifactFor(target).bytecode,
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

  /**
   * The check this script was missing, and the reason its verdict was wrong.
   *
   * Cases 1-3 all ask about a DESTINATION. A contract creation has none -- that is what
   * makes `eth.tx.to == ''` a workable rule and what makes it dangerous. `value` rides
   * along on a creation exactly as it does on a transfer, and it lands in the contract
   * being created, whose code the sender writes.
   *
   * So a key that may create contracts with value attached may move the whole balance in
   * one transaction, and case 3 will still print `denied ✅` because no arbitrary address
   * was ever named. Measured 2026-08-21: Turnkey signed a creation carrying 1 ETH.
   */
  const fundedCreation = await attempt('funded creation', {
    ...base,
    data: splitterArtifactFor(target).bytecode,
    value: 1000000000000000000n,
  });
  line('4. contract creation CARRYING FUNDS', show(fundedCreation, 'denied'));

  console.log('');
  // Unknown anywhere means the run proves nothing, in either direction. Reporting
  // PASSED on unanswered questions would be the same defect pointing the other way.
  const unknowns = [toV1, toCurrent, deploy, elsewhere, fundedCreation].filter(
    (o) => o.kind === 'unknown'
  ).length;
  if (unknowns > 0) {
    console.log('=== INCONCLUSIVE ===');
    console.log(`  ${unknowns} of 5 checks could not be asked, so this run proves nothing.`);
    console.log('  The most common cause is the Turnkey organisation being over its signing');
    console.log('  quota, which disables signing for everything and is not a policy problem.');
    console.log('  Nothing here says the policy is wrong, and nothing says it is right.');
    process.exitCode = 1;
    return;
  }

  const good =
    rolloutOk &&
    toFactory.kind === 'allowed' &&
    deploy.kind === 'allowed' &&
    elsewhere.kind === 'denied' &&
    fundedCreation.kind === 'denied';
  if (good) {
    console.log('=== PASSED ===');
    console.log(`The bot can launch on ${target.id} and deploy splitters, and`);
    console.log('cannot move funds anywhere else, including by attaching them to a deploy.');
    console.log('');
    console.log('Safe to set TURNKEY_POLICY_CONFIRMED=true in backend/.env.');
    if (toCurrent.kind !== 'allowed') {
      console.log('');
      console.log(`NOTE: ${target.id} is still denied. That is fine while the bot runs v1,`);
      console.log('but moving the executable deployment would produce a bot that passes');
      console.log('every check it makes of pons and is then refused by its own signer --');
      console.log('after the splitter has been deployed and paid for.');
      console.log('  powershell -File scripts\\apply-v2-policy.ps1 -Execute');
    }
  } else {
    console.log('=== NOT SAFE YET ===');
    if (rolloutTarget && !rolloutOk) {
      console.log(`  The rollout target ${rolloutTarget.id} is DENIED by the policy.`);
      console.log(`  The executable deployment is ${executableDeployment().id}, so this run`);
      console.log('  would otherwise have passed -- and the next runbook step flips to that');
      console.log('  target, producing a bot refused by its own signer after the splitter is');
      console.log('  paid for.');
    }
    if (fundedCreation.kind === 'allowed') {
      console.log('  THE TREASURY IS DRAINABLE BY THIS KEY.');
      console.log('  Turnkey signed a contract creation carrying funds. A creation has no');
      console.log('  destination, so the arbitrary-address check above cannot see it: the value');
      console.log('  lands in a contract whose code the sender chooses. One transaction empties');
      console.log('  the hot wallet, and every destination-only check still reports green.');
      console.log('  Do NOT claim anywhere that a leak of this key costs only launches.');
      console.log('  Closing it is an operator action -- see docs/TURNKEY-CREATION-AUTHORITY.md');
    }
    if (toFactory.kind !== 'allowed') {
      console.log(`  The bot launches through ${target.id}, and that factory is DENIED.`);
      console.log('  It cannot launch anything at all.');
      console.log('  Fix: powershell -File scripts\\apply-v2-policy.ps1 -Execute');
    }
    if (deploy.kind !== 'allowed') console.log('  Contract creation is denied -- the bot cannot deploy splitters.');
    if (elsewhere.kind === 'allowed') console.log('  The policy is not restricting anything. Do NOT fund this wallet.');
  }
  process.exitCode = good ? 0 : 1;
})().catch((err) => {
  console.error('FAILED:', err?.message ?? err);
  process.exit(1);
});
