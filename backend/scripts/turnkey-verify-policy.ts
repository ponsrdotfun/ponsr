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
import { classifyTurnkeyOutcome, Outcome } from '../src/turnkeyOutcome';
import { renderVerification, resolveTargetArg } from '../src/turnkeyVerifyCli';
import { splitterArtifactFor } from '../src/splitterDeployer';

const ARBITRARY = '0x000000000000000000000000000000000000dEaD';

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(30)} ${value}`);
}

/**
 * The rollout target, refused BEFORE anything is constructed or signed.
 *
 * Resolved at module scope on purpose: a usage error must not cost a Turnkey client, a
 * provider, a nonce read or six signing requests. The rule itself lives in
 * `src/turnkeyVerifyCli.ts` so it can be tested without any of that.
 */
const targetArg = resolveTargetArg(process.argv);
if (targetArg.kind === 'usage') {
  for (const l of targetArg.lines) console.error(l);
  process.exit(targetArg.exitCode);
}
const rolloutTarget = targetArg.rolloutTarget;

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

  // From the registry, because a config address is how this went wrong twice.
  //
  // On 2026-08-20 this script read `PONS_V2_FACTORY_ADDRESS` and reported PASSED for
  // 0x7E1EAbd5…, a deployment pons replaced on 2026-08-03 and which the bot no longer
  // calls. Every tick was green and none of them described the launch path.
  const target = executableDeployment();
  const superseded = deploymentById('pons-v2-legacy-7e1');

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

  const legacyFactory = await attempt('legacy factory', {
    ...base,
    to: superseded.factory,
    value: 500000000000000n,
    data: superseded.launchSelector,
  });

  const currentFactory = await attempt('current factory', {
    ...base,
    to: target.factory,
    value: 500000000000000n,
    data: target.launchSelector,
  });

  // The ACTUAL splitter initcode, not a ten-byte prefix.
  //
  // A prefix proves a creation is allowed in general. If exact-initcode binding is ever
  // chosen -- one of the two designs for closing the funded-creation finding -- a prefix
  // would pass a rule the real deployment then fails, which is the worst possible time to
  // discover the difference.
  const zeroValueCreation = await attempt('zero-value creation', {
    ...base,
    data: splitterArtifactFor(target).bytecode,
    value: 0n,
  });

  /**
   * The check this script was missing, and the reason its verdict was wrong.
   *
   * Every destination probe asks about a TO. A contract creation has none -- that is what
   * makes `eth.tx.to == ''` a workable rule and what makes it dangerous. `value` rides
   * along on a creation exactly as it does on a transfer, and it lands in the contract
   * being created, whose code the sender writes. Measured 2026-08-21: Turnkey signed a
   * creation carrying 1 ETH.
   */
  const fundedCreation = await attempt('funded creation', {
    ...base,
    data: splitterArtifactFor(target).bytecode,
    value: 1000000000000000000n,
  });

  const arbitraryDestination = await attempt('arbitrary destination', {
    ...base,
    to: ARBITRARY,
    value: 1000000000000000000n,
    data: '0x',
  });

  /**
   * THE DECISION IS NOT MADE HERE, AND NEITHER IS THE EXIT CODE.
   *
   * This script printed `=== NOT SAFE YET ===` and then exited 0: the branch fell out of
   * the async function without setting `process.exitCode`, which was set only on the
   * INCONCLUSIVE and PASS paths. The ceremony's gate is "final exit 0 and the PASS
   * matrix", so exit 0 was satisfied by the exact state the ceremony exists to remove.
   *
   * Both now come from one place, and it is testable with synthetic outcomes.
   */
  const result = renderVerification({
    outcomes: {
      currentFactory,
      zeroValueCreation,
      v1Factory,
      legacyFactory,
      arbitraryDestination,
      fundedCreation,
    },
    signer: from,
    target,
    superseded,
    v1: deploymentById('pons-v1'),
    rolloutTarget,
  });

  for (const l of result.lines) console.log(l);
  process.exitCode = result.exitCode;
})().catch((err) => {
  console.error('FAILED:', err?.message ?? err);
  process.exit(1);
});
