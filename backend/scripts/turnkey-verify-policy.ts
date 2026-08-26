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
import { ALL_PROBES, PROBE_LABELS, classifyPolicy, verdictExitCode } from '../src/turnkeyVerdict';
import { splitterArtifactFor } from '../src/splitterDeployer';

const ARBITRARY = '0x000000000000000000000000000000000000dEaD';

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(30)} ${value}`);
}

/**
 * The rollout target, refused BEFORE anything is constructed or signed.
 *
 * Parsed at module scope on purpose: a usage error must not cost a Turnkey client, a
 * provider, a nonce read or four signing requests. It also must be a deployment the bot
 * could actually launch through -- naming a superseded one used to be accepted and then
 * checked against the v1 probe, which is a DENY test, so "the rollout target is allowed"
 * would have meant the opposite of what it says.
 */
const targetArg = process.argv
  .find((a) => a.startsWith('--target-deployment='))
  ?.slice('--target-deployment='.length);
const rolloutTarget = targetArg ? deploymentById(targetArg) : null;
if (rolloutTarget && !rolloutTarget.executable) {
  console.error(
    `--target-deployment names ${rolloutTarget.id}, which is not executable ` +
      `(superseded by ${rolloutTarget.supersededBy ?? 'the current deployment'}). ` +
      'Rollback is a previous application image, not a superseded factory.'
  );
  process.exit(2);
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
  // BOTH superseded factories, and both are DENY tests. The v1 probe used to be asked,
  // printed with an expected label of `allowed`, counted toward the "could not ask" tally
  // -- and then left out of the verdict, so the script could print PASSED while v1 was
  // still an allowed destination. v2-legacy was never asked about at all.
  const v1Factory = await attempt('v1 factory', {
    ...base,
    to: deploymentById('pons-v1').factory,
    value: 500000000000000n,
    data: '0x12345678',
  });
  line('1. tx to the v1 factory', show(v1Factory, 'denied'));

  const legacyFactory = await attempt('legacy factory', {
    ...base,
    to: superseded.factory,
    value: 500000000000000n,
    data: superseded.launchSelector,
  });
  line('2. tx to the superseded v2 factory', show(legacyFactory, 'denied'));

  const currentFactory = await attempt('current factory', {
    ...base,
    to: target.factory,
    value: 500000000000000n,
    data: target.launchSelector,
  });
  line('3. tx to the CURRENT factory', show(currentFactory, 'allowed'));

  if (rolloutTarget) line('rollout target', `${rolloutTarget.id}  <- must be ALLOWED`);
  // Only an executable target can be named -- refused at module scope otherwise -- and
  // there is exactly one, so this is the current probe. Never a superseded one, which is
  // a DENY test and would make "the rollout target is allowed" mean its opposite.
  const rolloutOk = !rolloutTarget || currentFactory.kind === 'allowed';

  // The ACTUAL splitter initcode, not a ten-byte prefix.
  //
  // A prefix proves a creation is allowed in general. If exact-initcode binding is ever
  // chosen -- it is one of the two designs for closing the funded-creation finding --
  // a prefix would pass a rule that the real deployment then fails, which is the worst
  // possible time to discover the difference.
  const zeroValueCreation = await attempt('zero-value creation', {
    ...base,
    data: splitterArtifactFor(target).bytecode,
    value: 0n,
  });
  line('4. zero-value contract creation', show(zeroValueCreation, 'allowed'));

  const arbitraryDestination = await attempt('arbitrary destination', {
    ...base,
    to: ARBITRARY,
    value: 1000000000000000000n,
    data: '0x',
  });
  line('6. tx to an arbitrary address', show(arbitraryDestination, 'denied'));

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
  line('5. contract creation CARRYING FUNDS', show(fundedCreation, 'denied'));

  console.log('');

  /**
   * The verdict is NOT computed here.
   *
   * It lives in `src/turnkeyVerdict.ts`, where it can be driven with synthetic outcomes
   * without spending signing quota -- and where the defect that stood in this file is now
   * impossible to reintroduce quietly: v1 was ASKED, PRINTED, counted toward the unknown
   * tally, and then omitted from the pass condition, so this script could announce
   *
   *     === PASSED ===   Safe to set TURNKEY_POLICY_CONFIRMED=true
   *
   * while v1 remained an allowed destination.
   */
  const verdict = classifyPolicy({
    currentFactory,
    zeroValueCreation,
    v1Factory,
    legacyFactory,
    arbitraryDestination,
    fundedCreation,
  });

  if (verdict.kind === 'inconclusive') {
    console.log('=== INCONCLUSIVE ===');
    console.log(`  ${verdict.unknown.length} of ${ALL_PROBES.length} checks could not be asked, so this run proves nothing.`);
    for (const p of verdict.unknown) console.log(`    - ${PROBE_LABELS[p]}`);
    console.log('  The most common cause is the Turnkey organisation being over its signing');
    console.log('  quota, which disables signing for everything and is not a policy problem.');
    console.log('  Nothing here says the policy is wrong, and nothing says it is right.');
    process.exitCode = verdictExitCode(verdict);
    return;
  }

  if (verdict.kind === 'pass' && rolloutOk) {
    console.log('=== PASSED ===');
    console.log(`The bot can launch on ${target.id} and deploy splitters, and`);
    console.log('cannot move funds anywhere else, including by attaching them to a deploy.');
    console.log('Both superseded factories are denied.');
    console.log('');
    console.log('Safe to set TURNKEY_POLICY_CONFIRMED=true in backend/.env.');
    process.exitCode = 0;
    return;
  }

  console.log('=== NOT SAFE YET ===');
  if (verdict.kind === 'not-safe') for (const p of verdict.problems) console.log(`  ${p}`);
  if (rolloutTarget && !rolloutOk) {
    console.log(`  The rollout target ${rolloutTarget.id} is DENIED by the policy.`);
    console.log('  The next runbook step launches through it, producing a bot refused by');
    console.log('  its own signer after the splitter is paid for.');
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
  if (v1Factory.kind === 'allowed' || legacyFactory.kind === 'allowed') {
    console.log('  A superseded factory is still an allowed destination. Removing it is an');
    console.log('  owner ceremony -- see docs/TURNKEY-V1-REVOCATION-CEREMONY.md, and read the');
    console.log('  ordering there first: the v1 rule also carries the only zero-value');
    console.log('  contract-creation clause, so deleting it alone leaves a bot that can launch');
    console.log('  and then cannot deploy its splitter.');
  }
  if (currentFactory.kind !== 'allowed') {
    console.log('  Fix: powershell -File scripts\apply-v2-policy.ps1 -Execute');
  }
})().catch((err) => {
  console.error('FAILED:', err?.message ?? err);
  process.exit(1);
});
