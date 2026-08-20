import { ethers } from 'ethers';
import { PonsDeployment, executableDeployment } from './deployments';
import { PONS_V2_CURRENT_ABI } from './ponsV2CurrentEncoder';
import { NATIVE_ETH } from './pairTokens';
import { verifyDeploymentIdentity } from './deploymentIdentity';

/**
 * Whether the current pons deployment would accept a launch, asked rather than inferred.
 *
 * The older helper works out permission as `launchEnabled || whitelisted`. The current
 * factory publishes `canLaunch(address)` as its own predicate, and those two agree only
 * for as long as pons chooses to keep them agreeing. Ponsr has already spent a week
 * confidently wrong about this contract's state; re-deriving a permission the contract
 * will state directly is exactly how that happens a second time.
 *
 * The parts are reported alongside the answer because they mean different things:
 *
 *   launchEnabled  the public gate. Open to everyone, and closable without notice.
 *   whitelisted    granted to this address specifically. Survives the gate closing.
 *   canLaunch      what the contract will actually do.
 *
 * A launch riding on the public gate works exactly as well as one riding on a
 * whitelist, right up until the gate closes. Anyone planning for continuity needs to
 * see which of the two is carrying it, so `durable` says so plainly.
 */

export interface CurrentReadiness {
  launchEnabled: boolean;
  whitelisted: boolean;
  /** The factory's own predicate for this address. */
  canLaunch: boolean;
  launchConfigUsable: boolean;
  /** Whether the specific pair asset for this launch is approved right now. */
  pairApproved: boolean;
  feeWei: bigint;
  /** Whether the live factory's fee escrow matches the registry. */
  escrowMatches: boolean;
  /**
   * Whether the contract on chain is the one the registry describes -- runtime
   * bytecode, ABI file, and the selector derived from it.
   *
   * Kept apart from every permission above, because "pons will not let you launch" and
   * "this is not the contract we think it is" are unrelated problems with unrelated
   * fixes. The registry has recorded these hashes since it was written; this is what
   * finally reads them.
   */
  identityMatches: boolean;
  /** One entry per drifted axis, each naming the axis. Empty when identity holds. */
  identityMismatches: string[];
}

export interface ReadinessVerdict extends CurrentReadiness {
  /** True only when every condition holds. */
  ready: boolean;
  /** Whether permission survives the public gate closing. */
  durable: boolean;
  reason?: string;
  detail: string;
}

/**
 * Turns the raw reads into a verdict, without asking the network.
 *
 * Split out from the reading so the decision is testable on its own -- the reads are
 * four RPC calls and the decision is where the mistakes live.
 */
export function describeReadiness(r: CurrentReadiness): ReadinessVerdict {
  const durable = r.whitelisted;

  // Ordered by what an operator would act on first. The escrow is last because it is
  // not a permission at all -- but it fails closed here rather than at signing time,
  // since launching with the wrong escrow loses the fees permanently and a launch that
  // does not happen costs nothing.
  let reason: string | undefined;
  // First, and ahead of every permission: if this is not the contract the registry
  // describes, nothing else asked about it means anything. A green `canLaunch` from an
  // unexpected contract is not reassurance, it is the most dangerous reading available.
  if (!r.identityMatches) {
    reason =
      'the contract at this address is not the one the registry describes -- ' +
      r.identityMismatches.join('; ');
  } else if (!r.canLaunch) {
    reason = r.launchEnabled
      ? 'canLaunch() is false for this address even though the public gate is open'
      : 'canLaunch() is false: the public gate is closed and this address is not whitelisted';
  } else if (!r.launchConfigUsable) {
    reason = 'the configured launch config is disabled on this deployment';
  } else if (!r.pairApproved) {
    reason = 'the selected pair token is not approved on this deployment';
  } else if (!r.escrowMatches) {
    reason =
      'the factory reports a different fee escrow than the registry records -- refusing, ' +
      'because a splitter built against the wrong escrow holds creator fees nothing can claim';
  }

  const detail = r.whitelisted
    ? 'whitelisted on this deployment, so launching survives the public gate closing'
    : r.launchEnabled
      ? 'launching rests on the public gate, which is open to everyone and can be closed without notice'
      : 'the public gate is closed and this address is not whitelisted';

  return { ...r, ready: !reason, canLaunch: r.canLaunch && !reason, durable, reason, detail };
}

/**
 * Reads the current deployment's state for one prospective launch.
 *
 * Everything here is read live. `launchEnabled`, the whitelist, the launch config and
 * every pair approval are owner-settable on pons's side, and the fee has already moved
 * once between factories.
 */
export async function readCurrentReadiness(
  provider: ethers.Provider,
  launcher: string,
  launchConfigId: bigint,
  pairToken: string,
  deployment: PonsDeployment = executableDeployment()
): Promise<ReadinessVerdict> {
  const f = new ethers.Contract(deployment.factory, PONS_V2_CURRENT_ABI, provider);

  // Asked before the permissions, and reported alongside them.
  const identity = await verifyDeploymentIdentity(deployment, provider);

  const [launchEnabled, whitelisted, canLaunch, configCount, feeWei, escrow] = await Promise.all([
    f.launchEnabled() as Promise<boolean>,
    f.whitelistedLaunchers(launcher) as Promise<boolean>,
    f.canLaunch(launcher) as Promise<boolean>,
    f.launchConfigCount() as Promise<bigint>,
    f.launchFee() as Promise<bigint>,
    f.feeEscrow() as Promise<string>,
  ]);

  let launchConfigUsable = launchConfigId < BigInt(configCount.toString());
  if (launchConfigUsable) {
    try {
      const cfg = await f.getLaunchConfig(launchConfigId);
      launchConfigUsable = Boolean(cfg.enabled);
    } catch {
      // An unreadable config is an unusable one: launching against it would revert.
      launchConfigUsable = false;
    }
  }

  // Native ETH is exempt from the approval map -- the factory's own gate short-circuits
  // on the zero address -- so asking `approvedPairTokens` about it returns false and
  // would refuse the one pairing that always works.
  const pairApproved =
    pairToken.toLowerCase() === NATIVE_ETH
      ? true
      : Boolean(await f.approvedPairTokens(pairToken));

  return describeReadiness({
    launchEnabled: Boolean(launchEnabled),
    whitelisted: Boolean(whitelisted),
    canLaunch: Boolean(canLaunch),
    launchConfigUsable,
    pairApproved,
    feeWei: BigInt(feeWei.toString()),
    escrowMatches: String(escrow).toLowerCase() === deployment.feeEscrow.toLowerCase(),
    identityMatches: identity.ok,
    identityMismatches: identity.mismatches,
  });
}
