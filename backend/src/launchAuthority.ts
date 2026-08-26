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
 * The same question asked of the BYTES, immediately before the signer is asked.
 *
 * A target can declare the right factory and then build a transaction to somewhere else.
 * `assertLaunchAuthority` cannot see that -- it runs before `build()` exists -- so this
 * runs after, and before any signature is requested for the launch itself.
 */
export function assertBuiltLaunchAuthority(
  deployment: PonsDeployment,
  built: { to: string; data: string }
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
}
