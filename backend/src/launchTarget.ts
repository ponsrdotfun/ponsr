import { ethers } from 'ethers';
import { config } from './config';
import { EMPTY_SOCIALS, buildLaunchCalldata, extractLaunchedTokenAddress, saltForTweet } from './ponsEncoder';
import {
  PONS_V2_CURRENT_ABI,
  buildCurrentV2LaunchCalldata,
  extractCurrentV2LaunchDetails,
  launchSalt,
} from './ponsV2CurrentEncoder';
import { PonsDeployment, executableDeployment, deploymentById } from './deployments';
import { assertEscrowMatches } from './splitterDeployer';
import { NATIVE_ETH, PairAsset } from './pairTokens';

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
  version: 'v1' | 'v2' | 'v2-current';
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

class V1Target implements LaunchTarget {
  version = 'v1' as const;
  /**
   * Rollback, stated explicitly.
   *
   * `pons-v1` is `executable: false` and stays that way -- it is not where launches go.
   * Carrying it here says which contract THIS target addresses, which is a different
   * question from which deployment the registry routes to by default. Representing
   * rollback as its own deployment beats bypassing the registry's invariant.
   */
  deployment = deploymentById('pons-v1');
  factoryAddress = deploymentById('pons-v1').factory;
  supportsPairing = false;

  async build(req: LaunchRequest, launchFeeWei: bigint): Promise<BuiltLaunch> {
    // v1 takes its pairing from the launch config, not from a parameter. Accepting a
    // request for anything else and launching against WETH regardless would be a
    // launch nobody asked for, permanently.
    if (req.pairAsset.address.toLowerCase() !== NATIVE_ETH) {
      throw new Error(
        `v1 cannot pair against ${req.pairAsset.symbol}: its pairing comes from the launch config. ` +
          'Set PONS_FACTORY_VERSION=v2 to launch against an approved asset.'
      );
    }
    const { data, value } = buildLaunchCalldata(
      {
        tokenName: req.tokenName,
        tokenSymbol: req.tokenSymbol,
        logo: '',
        description: req.description ?? '',
        socials: EMPTY_SOCIALS,
        feeWallet: req.splitterAddress,
        launchConfigId: config.PONS_LAUNCH_CONFIG_ID,
        dexId: config.PONS_DEX_ID,
        salt: saltForTweet(req.tweetId),
      },
      launchFeeWei
    );
    return { to: this.factoryAddress, data, value };
  }

  extractToken(logs: readonly ethers.Log[]): string | null {
    return extractLaunchedTokenAddress(logs);
  }
}

/*
 * `V2Target` -- the target for the SUPERSEDED v2 factory -- was deleted on 2026-08-20.
 *
 * It had been unreachable since `createLaunchTarget` started routing everything except
 * v1 to the registry, so it changed no behaviour. It was removed anyway, because what
 * it still held was `config.PONS_V2_FACTORY_ADDRESS` -- a setting whose default is the
 * factory pons replaced -- inside a class that looks maintained and deliberate.
 *
 * Dead code carrying a superseded address is not neutral. It reads as something kept
 * for a reason, and the next person to need a "v2 target" finds one already written.
 *
 * The superseded deployment stays in `deployments.ts` and stays indexable; what is gone
 * is the ability to LAUNCH through it. Rollback is v1, which is still selectable.
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
      req.launchConfigId ?? config.PONS_LAUNCH_CONFIG_ID,
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
        launchConfigId: req.launchConfigId ?? config.PONS_LAUNCH_CONFIG_ID,
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

export function createLaunchTarget(provider: ethers.Provider): LaunchTarget {
  // v1 stays selectable for rollback and for the suites that exercise it. Everything
  // else routes to whichever deployment the registry marks executable, so the target
  // cannot drift from the ABI the way a bare address setting allowed.
  if (config.PONS_FACTORY_VERSION === 'v1') return new V1Target();
  return new CurrentV2Target(provider);
}
