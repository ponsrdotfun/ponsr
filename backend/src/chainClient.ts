import { ethers } from 'ethers';
import { preflightEnv } from './preflightEnv';
import { PONS_FACTORY_ABI } from './ponsEncoder';
import { PONS_V2_FACTORY_ABI } from './ponsV2Encoder';
import { PONS_V2_CURRENT_ABI } from './ponsV2CurrentEncoder';
import { executableDeployment, PonsDeployment } from './deployments';

/** The ABI of whichever deployment is executable, so reads decode against the contract
 *  actually being addressed rather than against whichever v2 shipped first. */
function executableAbi(): ethers.InterfaceAbi {
  return executableDeployment().tokenParamsVersion === 'v2-salt'
    ? PONS_V2_CURRENT_ABI
    : PONS_V2_FACTORY_ABI;
}

export function createProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(preflightEnv().RPC_URL, preflightEnv().CHAIN_ID);
}

/**
 * The factory the bot actually launches through.
 *
 * This used to be v1 unconditionally, which was correct while v1 was the only
 * option and quietly wrong the moment it was not: every guard in this file --
 * the live fee, `launchEnabled`, the whitelist, the launch config -- would have
 * been read from a contract the bot was no longer using. Checking the wrong
 * factory before spending money is worse than not checking, because it produces
 * a confident answer about somewhere else.
 */
export function activeFactoryAddress(): string {
  // The registry, and only the registry -- exactly as `createLaunchTarget` does.
  //
  // Two settings that can disagree is the entire shape of what this migration was
  // cleaning up. Until 2026-08-26 an environment variable still got a vote here, and its
  // default named the SUPERSEDED factory: a missing value meant every guard in this file
  // -- the live fee, `launchEnabled`, the whitelist, the launch config -- read a contract
  // the bot was not launching through. A confident answer about somewhere else is worse
  // than no answer, because nothing looks wrong.
  return executableDeployment().factory;
}

function factory(provider: ethers.Provider): ethers.Contract {
  // From the selected deployment's own parameter version, never a version flag.
  const v2 = executableDeployment().tokenParamsVersion !== 'v1';
  return new ethers.Contract(
    activeFactoryAddress(),
    // The current deployment's ABI, not the superseded one's. They differ, and the
    // reads this file makes -- launchFee, launchEnabled, the whitelist -- have to be
    // decoded against the contract actually being addressed.
    v2 ? executableAbi() : PONS_FACTORY_ABI,
    provider
  );
}

/**
 * Reads the CURRENT launch fee from the factory.
 *
 * Per Part 5's audit this must be read immediately before every launch, never cached: it is
 * owner-settable on pons's side and can change without notice.
 *
 * The function is `launchFee()`. It was previously called as `creationFee()`, a name taken
 * from the placeholder ABI -- that function does not exist on the deployed contract, so every
 * call would have reverted. It read 0.0005 ETH live on 2026-08-04, matching the documented
 * figure, but the point stands that the figure is not a constant.
 */
/**
 * The launch fee, from a named deployment when one is given.
 *
 * It took only a provider and read whichever factory the global flag considered active.
 * The orchestrator can be launching through a different one -- a v1 rollback, an injected
 * target -- and pricing a launch from a contract it never calls is how a fee ceiling
 * passes against terms nobody is being offered.
 */
export async function getLiveFeeWei(
  provider: ethers.Provider,
  deployment?: PonsDeployment
): Promise<bigint> {
  const c = deployment
    ? new ethers.Contract(
        deployment.factory,
        deployment.tokenParamsVersion === 'v1' ? PONS_FACTORY_ABI : executableAbi(),
        provider
      )
    : factory(provider);
  const fee = await c.launchFee();
  return BigInt(fee.toString());
}

/**
 * Reads the hot treasury wallet's balance. Backs Part 5 mitigation #7 -- both the
 * pre-launch admission check in validator.ts and the periodic watch in
 * treasuryPolicy.ts. Read live for the same reason the fee is: a balance that was
 * correct a minute ago says nothing about a wallet someone is draining now.
 */
export async function getBalanceWei(provider: ethers.Provider, address: string): Promise<bigint> {
  return provider.getBalance(address);
}

export interface LaunchReadiness {
  /** Global switch. When false, only whitelisted launchers may call `launchToken`. */
  launchEnabled: boolean;
  /** True when the treasury may launch: either launching is open, or it is whitelisted. */
  canLaunch: boolean;
  whitelisted: boolean;
  /** The configured launch config exists and is enabled. */
  launchConfigUsable: boolean;
  launchConfigCount: bigint;
  /** The configured DEX config exists and is enabled. A separate factory guard
   *  (`InvalidDexId` / `DexDisabled`) with the same consequence: a revert we pay gas for. */
  dexConfigUsable: boolean;
  /** What the configured launch config pairs against -- WETH today, but per-config. */
  pairToken: string | null;
  reason?: string;
}

/**
 * Answers "would a launch be accepted right now?" without sending one.
 *
 * The factory's own guard is:
 *
 *   if (!launchEnabled && !whitelistedLaunchers[msg.sender]) revert NotWhitelisted();
 *   ...
 *   if (!config.enabled) revert LaunchConfigDisabled();
 *
 * Both are pons-controlled and can flip without warning. Without this check the bot finds out
 * by sending a transaction that reverts -- the user gets a failure and the treasury still pays
 * the gas. Reading first costs one RPC round trip and no gas at all.
 */
export async function getLaunchReadiness(
  provider: ethers.Provider,
  launcherAddress: string,
  launchConfigId: bigint,
  dexId: bigint = preflightEnv().PONS_DEX_ID,
  /** The deployment this launch is going to. Without it this reads whichever factory
   *  the global flag considers active, which can be a contract nobody is calling. */
  deployment?: PonsDeployment
): Promise<LaunchReadiness> {
  const f = deployment
    ? new ethers.Contract(
        deployment.factory,
        deployment.tokenParamsVersion === 'v1' ? PONS_FACTORY_ABI : executableAbi(),
        provider
      )
    : factory(provider);
  // v2 has no dexConfigCount: the DEX is not a launch parameter there, the pairing
  // asset is. Calling it would throw rather than report, so the dex leg is simply
  // not a question on v2 and is answered as satisfied.
  // From the deployment being read -- the one passed in for a historical read, or the
  // executable one. A HISTORICAL v1 read still has to ask v1's questions; what it must
  // not do is take the answer from a global flag that can name a third contract.
  const isV2 = (deployment ?? executableDeployment()).tokenParamsVersion !== 'v1';
  const [enabled, whitelisted, count, dexCount] = await Promise.all([
    f.launchEnabled() as Promise<boolean>,
    f.whitelistedLaunchers(launcherAddress) as Promise<boolean>,
    f.launchConfigCount() as Promise<bigint>,
    isV2 ? Promise.resolve(1n) : (f.dexConfigCount() as Promise<bigint>),
  ]);

  const launchConfigCount = BigInt(count.toString());
  const dexConfigCount = BigInt(dexCount.toString());
  const canLaunch = Boolean(enabled) || Boolean(whitelisted);

  const base = {
    launchEnabled: Boolean(enabled),
    canLaunch,
    whitelisted: Boolean(whitelisted),
    launchConfigCount,
  };

  // Out-of-range ids revert with InvalidLaunchConfigId / InvalidDexId before any other check,
  // so they are answered first -- and reading the config itself would throw here anyway.
  if (launchConfigId >= launchConfigCount) {
    return {
      ...base,
      launchConfigUsable: false,
      dexConfigUsable: false,
      pairToken: null,
      reason: `launchConfigId ${launchConfigId} does not exist (factory has ${launchConfigCount})`,
    };
  }
  if (dexId >= dexConfigCount) {
    return {
      ...base,
      launchConfigUsable: false,
      dexConfigUsable: false,
      pairToken: null,
      reason: `dexId ${dexId} does not exist (factory has ${dexConfigCount})`,
    };
  }

  // v2 has no getDexConfig either, and no pairToken on the launch config: the
  // pairing is a launch parameter there, chosen per launch, not a property of the
  // config. Reporting v1's shape for a v2 launch would describe a pairing nobody
  // is using.
  const cfg = await f.getLaunchConfig(launchConfigId);
  const dex = isV2 ? { enabled: true } : await f.getDexConfig(dexId);
  const configEnabled = Boolean(cfg.enabled);
  const dexEnabled = Boolean(dex.enabled);
  const pairToken = isV2 ? null : (cfg.pairToken as string);

  let reason: string | undefined;
  if (!canLaunch) reason = 'launchEnabled is false and this launcher is not whitelisted';
  else if (!configEnabled) reason = `launch config ${launchConfigId} is disabled`;
  else if (!dexEnabled) reason = `dex config ${dexId} is disabled`;

  return {
    ...base,
    launchConfigUsable: configEnabled,
    dexConfigUsable: dexEnabled,
    pairToken,
    reason,
  };
}

/**
 * Just the switch and the whitelist, on whichever factory is asked about.
 *
 * `getLaunchReadiness` above cannot be pointed at v2: it reads `dexConfigCount`,
 * which v2 does not have, so it would throw rather than report. Both factories do
 * have `launchEnabled` and `whitelistedLaunchers`, and those two are the whole
 * question when what you are watching for is permission to launch at all.
 *
 * This exists because the whitelist we are actually waiting on is a v2 grant while
 * the bot still runs v1 — so a watch that only read v1 would miss the exact event
 * it was put there to catch.
 */
export async function getSwitchState(
  provider: ethers.Provider,
  factoryAddress: string,
  launcherAddress: string
): Promise<{ launchEnabled: boolean; whitelisted: boolean }> {
  const f = new ethers.Contract(
    factoryAddress,
    [
      'function launchEnabled() view returns (bool)',
      'function whitelistedLaunchers(address) view returns (bool)',
    ],
    provider
  );
  const [enabled, whitelisted] = await Promise.all([
    f.launchEnabled() as Promise<boolean>,
    f.whitelistedLaunchers(launcherAddress) as Promise<boolean>,
  ]);
  return { launchEnabled: Boolean(enabled), whitelisted: Boolean(whitelisted) };
}
