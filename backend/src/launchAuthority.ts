import { PonsDeployment, executableDeployment } from './deployments';

/**
 * THE ONE SEAM THAT CAN STILL AIM A LAUNCH SOMEWHERE ELSE.
 *
 * `createLaunchTarget` resolves from the registry and cannot produce a superseded target.
 * That is not the same as "no financial path can construct a v1 `to`", which is what an
 * earlier report claimed -- too broadly. `OrchestratorDeps.launchTarget` is an EXPORTED
 * injection point, and a target handed in through it carries its own deployment and its
 * own `factoryAddress`. The orchestrator checked only that a deployment was PRESENT.
 *
 * Present is not the same as permitted. A target naming `pons-v1` satisfied that check,
 * and the guards downstream then verified the identity of the deployment it named -- which
 * is a guard aimed exactly where the caller pointed it.
 *
 * So the rule here is not "an address matches" but "this is THE executable deployment,
 * field for field". An address is not an identity: that is §11 of the findings, and it is
 * why the comparison includes the ABI hash, the runtime bytecode hash and length, the
 * selector, the signature, the escrow and the fee model, rather than the factory address
 * alone. Two deployments differing in escrow alone would strand a creator's fees while
 * comparing equal on address.
 *
 * Historical readers are unaffected. Reading a v1 launch back is not launching, and
 * `deploymentById('pons-v1')` remains available to anything that only reads.
 */

/** Fields that must be identical for two deployment records to be the same deployment. */
const IDENTITY_FIELDS = [
  'id',
  'chainId',
  'factory',
  'startBlock',
  'abiPath',
  'abiSha256',
  'runtimeBytecodeLength',
  'runtimeBytecodeSha256',
  'feeEscrow',
  'feeModel',
  'launchSelector',
  'launchSignature',
  'tokenParamsVersion',
] as const;

/** What a target must state about itself before anything is spent on its behalf. */
export interface LaunchAuthorityClaim {
  version: string;
  deployment: PonsDeployment | undefined | null;
  factoryAddress: string;
}

export class LaunchAuthorityError extends Error {}

const same = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * Refuses anything that is not the one executable deployment.
 *
 * Called BEFORE the parser is billed and long before the splitter is paid for, because the
 * question it answers -- may this target spend money at all -- does not need any of that.
 *
 * Returns the selected deployment so callers cannot accidentally carry a different one.
 */
export function assertLaunchAuthority(target: LaunchAuthorityClaim): PonsDeployment {
  const expected = executableDeployment();
  const selected = target.deployment;

  if (!selected) {
    throw new LaunchAuthorityError(
      `launch target (${target.version}) names no deployment, so its identity cannot be ` +
        'verified. Refusing before anything is deployed or spent.'
    );
  }

  if (selected.executable !== true) {
    throw new LaunchAuthorityError(
      `launch target names ${selected.id}, which is not executable` +
        (selected.supersededBy ? ` (superseded by ${selected.supersededBy})` : '') +
        '. Superseded deployments are readable, never destinations. Refusing before ' +
        'anything is deployed or spent.'
    );
  }

  const mismatched = IDENTITY_FIELDS.filter((f) => !same(selected[f], expected[f]));
  if (mismatched.length > 0) {
    // The FIELD NAMES, never the values. A refusal has to be diagnosable without echoing
    // whatever a caller supplied back into a log.
    throw new LaunchAuthorityError(
      `launch target's deployment does not match the executable deployment ${expected.id}: ` +
        `${mismatched.join(', ')} differ. Refusing before anything is deployed or spent.`
    );
  }

  if (!same(target.factoryAddress, expected.factory)) {
    // A target can name the right deployment and still address a different contract. The
    // deployment is what every guard verifies; `factoryAddress` is where the transaction
    // goes. They have to be the same contract.
    throw new LaunchAuthorityError(
      `launch target names ${expected.id} but addresses a different factory. Refusing ` +
        'before anything is deployed or spent.'
    );
  }

  return expected;
}

/**
 * The same question asked of the BYTES -- ONCE, before the first signer request.
 *
 * WHY A SECOND BUILD IS NOT AN OPTION
 * -----------------------------------
 * This used to run twice: a dry build inspected before the splitter deploy, and the real
 * build inspected after it. `build()` belongs to an injected object; nothing requires it
 * to be pure or stable. A STATEFUL target could answer honestly on the first call and
 * name v1 on the second -- and the splitter deploy, which is a signer request and real
 * gas, sat between them. The launch would have been refused, correctly, after money had
 * already moved.
 *
 * Two inspections of two different byte strings is not a check, it is a race. There is
 * one build now, and these are the bytes that get sent.
 *
 * EVERY FIELD, not just the destination. `to` and the selector alone leave the recipient,
 * the pair, the salt, the launch config and the economics digest free to be anything --
 * and a launch whose creatorFeeRecipient is not the splitter this flow deployed pays a
 * stranger, permanently, from a transaction that passed every check.
 */
export interface ExpectedLaunchBytes {
  /** The splitter this flow will deploy, predicted before any signature is requested. */
  creatorFeeRecipient: string;
  pairToken: string;
  launchConfigId: bigint;
  salt: string;
  /** The digest observed independently, not the one the target chose to embed. */
  expectedEconomics: string;
  /** The live fee. `value` must equal it exactly: the factory treats excess as a buy. */
  valueWei: bigint;
  /** The operator's per-transaction ceiling. */
  maxValueWei: bigint;
}

export function assertBuiltLaunchAuthority(
  deployment: PonsDeployment,
  built: { to: string; data: string; value?: bigint },
  expected?: ExpectedLaunchBytes,
  decode?: (data: string, d: PonsDeployment) => {
    selector: string;
    salt: string;
    expectedEconomics: string;
    launchConfigId: string;
    pairToken: string;
    creatorFeeRecipient: string;
  }
): void {
  if (!same(built.to, deployment.factory)) {
    throw new LaunchAuthorityError(
      `refusing to sign: the built launch is addressed to a contract that is not ` +
        `${deployment.id}'s factory.`
    );
  }
  const selector = String(built.data ?? '').slice(0, 10).toLowerCase();
  if (selector !== deployment.launchSelector.toLowerCase()) {
    throw new LaunchAuthorityError(
      `refusing to sign: the built launch calls selector ${selector}, not ` +
        `${deployment.id}'s ${deployment.launchSelector}.`
    );
  }
  if (!expected || !decode) return;

  // The bytes are the only witness. Every field is compared against a value this flow
  // knows independently -- never against something read back out of the same calldata.
  let d: ReturnType<NonNullable<typeof decode>>;
  try {
    d = decode(built.data, deployment);
  } catch {
    // A launch this deployment's own ABI cannot read is not what anyone thinks it is.
    throw new LaunchAuthorityError(
      `refusing to sign: the built launch cannot be decoded as ${deployment.id}'s launch.`
    );
  }

  const mismatched: string[] = [];
  if (!same(d.creatorFeeRecipient, expected.creatorFeeRecipient)) mismatched.push('creatorFeeRecipient');
  if (!same(d.pairToken, expected.pairToken)) mismatched.push('pairToken');
  if (d.launchConfigId !== expected.launchConfigId.toString()) mismatched.push('launchConfigId');
  if (!same(d.salt, expected.salt)) mismatched.push('salt');
  if (!same(d.expectedEconomics, expected.expectedEconomics)) mismatched.push('expectedEconomics');
  if (mismatched.length > 0) {
    // Field names only. A refusal must be diagnosable without echoing supplied values.
    throw new LaunchAuthorityError(
      `refusing to sign: the built launch does not match what this flow prepared: ` +
        `${mismatched.join(', ')} differ.`
    );
  }

  const value = built.value ?? 0n;
  if (value !== expected.valueWei) {
    // The factory treats anything above the fee as an initial buy, so overpaying makes
    // the treasury buy into the user's own token.
    throw new LaunchAuthorityError(
      'refusing to sign: the built launch does not carry exactly the live launch fee.'
    );
  }
  if (value > expected.maxValueWei) {
    throw new LaunchAuthorityError(
      'refusing to sign: the built launch carries more than the per-transaction ceiling.'
    );
  }
}

/**
 * The splitter this launch names must be the splitter this flow actually deployed.
 *
 * Predicted from the treasury's nonce before anything is signed, so the launch can be
 * built once. If the deployed address differs -- another transaction consumed the nonce,
 * a provider answered from a stale view -- the launch calldata names a contract this flow
 * did not create, and the creator's fees would be pushed to it forever.
 */
export function assertSplitterMatchesPrediction(predicted: string, actual: string): void {
  if (!same(predicted, actual)) {
    throw new LaunchAuthorityError(
      'refusing to sign the launch: the deployed splitter is not the address the launch ' +
        'calldata was built against. Nothing further is sent.'
    );
  }
}
