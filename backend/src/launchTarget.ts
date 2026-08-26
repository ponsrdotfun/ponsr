import { ethers } from 'ethers';
import { preflightEnv } from './preflightEnv';
import { EMPTY_SOCIALS } from './ponsEncoder';
import {
  PONS_V2_CURRENT_ABI,
  buildCurrentV2LaunchCalldata,
  extractCurrentV2LaunchDetails,
  launchSalt,
} from './ponsV2CurrentEncoder';
import { PonsDeployment, executableDeployment } from './deployments';
import { assertEscrowMatches } from './splitterDeployer';
import { PairAsset } from './pairTokens';

/**
 * The one place that knows v1 and v2 are different functions.
 *
 * The orchestrator should not carry `if (v2)` through a path that moves money. It
 * builds a request, hands it here, and gets back a transaction and a way to read
 * the result out of the receipt. Everything version-shaped lives below this line.
 *
 * THE DIFFERENCE THAT IS NOT COSMETIC
 * -----------------------------------
 * v1 takes a `salt`, derived from the tweet id, so a retry predicts the same token
 * address and reverts rather than deploying a second token for one request. **v2
 * has no salt.** That safety net does not exist there, and pretending otherwise
 * would be worse than not having it: on v2 the only thing preventing a duplicate
 * launch is the database's idempotency claim, which is a real guarantee but a
 * different one, held one layer up and lost if the database is lost. It is called
 * out here because a reader comparing the two encoders would otherwise assume the
 * omission was an oversight.
 */

export interface LaunchRequest {
  /** Optional override; defaults to the configured launch config. */
  launchConfigId?: bigint;
  tokenName: string;
  tokenSymbol: string;
  description: string | null;
  /** The deployed FeeSplitter: one address, which the locker pays trading fees to. */
  splitterAddress: string;
  tweetId: string;
  /** Resolved and already checked against the approved set. */
  pairAsset: PairAsset;
}

export interface BuiltLaunch {
  to: string;
  data: string;
  value: bigint;
}

export interface LaunchTarget {
  /** One value, because there is one executable deployment. */
  version: 'v2-current';
  /**
   * Which registry entry this builds for. REQUIRED, and that is the point.
   *
   * It was optional, and `V1Target` supplied nothing. So the rollback path had no
   * deployment to verify, and the identity check quietly fell back to
   * `executableDeployment()` -- verifying the current V2 factory's hashes, escrow and
   * chain immediately before sending a V1 transaction. A check for one deployment
   * authorising a transaction to another is not a weaker guard; it is a guard aimed at
   * the wrong contract, which is this migration's own bug one level up.
   */
  deployment: PonsDeployment;
  factoryAddress: string;
  /** True when this target can price a launch in something other than ETH. */
  supportsPairing: boolean;
  build(req: LaunchRequest, launchFeeWei: bigint): Promise<BuiltLaunch>;
  /** The launched token's address, read from the receipt's own logs. */
  extractToken(logs: readonly ethers.Log[]): string | null;
}

/*
 * `V2Target` (the SUPERSEDED v2 factory) was deleted on 2026-08-20, and `V1Target` on
 * 2026-08-26. Neither is a place a launch may go.
 *
 * V1Target outlived its usefulness by a long way. It was described here as "rollback",
 * and that description was wrong in a way that cost money: ROLLBACK IS AN EXACT PREVIOUS
 * APPLICATION IMAGE, not runtime routing to a superseded factory. Deploying old code and
 * pointing new code at an old contract are different acts with different failure modes,
 * and only one of them is reversible.
 *
 * It was reachable because `PONS_FACTORY_VERSION` let an environment variable answer a
 * question the registry already answers -- and the variable DEFAULTED TO v1, so a missing
 * value selected the superseded factory in silence. Two production launches on 2026-08-12
 * went to v1 through exactly that path.
 *
 * The superseded deployments stay in `deployments.ts` and stay indexable: a launch made
 * through an old factory did not stop existing when pons moved on, and the board and the
 * reconciler still have to read them. What is gone is the ability to SEND to them.
 */

/**
 * The pons deployment that is actually live.
 *
 * Three things happen here that the older targets do not do, and each exists because
 * skipping it costs money rather than raising an error:
 *
 *  - the fee escrow is read from the factory and checked against the registry BEFORE
 *    the splitter is deployed. A splitter is bound to an escrow immutably, escrow
 *    claims pay `msg.sender`, and no `claimFor` exists -- so the wrong escrow means a
 *    creator's fees sit somewhere nothing can ever reach.
 *  - the economics digest is read immediately before building, never cached. A stale
 *    pin does not protect the launch, it reverts it with LaunchEconomicsMismatch.
 *  - the salt is derived from chain, factory and request id, so a retry predicts the
 *    same token address and collides instead of minting a second token.
 */
class CurrentV2Target implements LaunchTarget {
  version = 'v2-current' as const;
  supportsPairing = true;
  deployment: PonsDeployment;
  factoryAddress: string;

  constructor(private provider: ethers.Provider, deployment: PonsDeployment = executableDeployment()) {
    this.deployment = deployment;
    this.factoryAddress = deployment.factory;
  }

  async build(req: LaunchRequest, launchFeeWei: bigint): Promise<BuiltLaunch> {
    const factory = new ethers.Contract(this.factoryAddress, PONS_V2_CURRENT_ABI, this.provider);

    // Full identity -- runtime hash, ABI hash, selector -- is verified in
    // `readCurrentReadiness()`, which runs before this and before any gas is spent.
    // Repeating it here would add an RPC round trip per build and would force this
    // module's unit tests to fake a 24kB contract byte for byte to stay honest.
    //
    // Checked here as well as at splitter-deploy time. By this point the splitter is
    // already deployed and paid for, so this catches a factory that migrated between
    // the two steps -- the window is small, and the loss it prevents is permanent.
    assertEscrowMatches(this.deployment, String(await factory.feeEscrow()));

    const expectedEconomics: string = await factory.previewLaunchEconomics(
      req.launchConfigId ?? preflightEnv().PONS_LAUNCH_CONFIG_ID,
      req.pairAsset.address
    );

    return buildCurrentV2LaunchCalldata(
      {
        tokenName: req.tokenName,
        tokenSymbol: req.tokenSymbol,
        logo: '',
        description: req.description ?? '',
        socials: EMPTY_SOCIALS,
        feeWallet: req.splitterAddress,
        launchConfigId: req.launchConfigId ?? preflightEnv().PONS_LAUNCH_CONFIG_ID,
        pairToken: req.pairAsset.address,
        creatorTaxBps: 0,
        buybackEnabled: false,
        expectedEconomics,
        salt: launchSalt(this.deployment, req.tweetId),
      },
      launchFeeWei,
      this.deployment
    );
  }

  extractToken(logs: readonly ethers.Log[]): string | null {
    return extractCurrentV2LaunchDetails(logs)?.token ?? null;
  }
}

/**
 * The one target, resolved from the one source of truth.
 *
 * No environment value is consulted. `executableDeployment()` already enforces that
 * exactly one deployment is executable and THROWS otherwise, so there is nothing left for
 * a setting to disagree with. Changing which factory launches go to is a one-line change
 * to the registry, which that invariant polices.
 */
export function createLaunchTarget(provider: ethers.Provider): LaunchTarget {
  return new CurrentV2Target(provider);
}
