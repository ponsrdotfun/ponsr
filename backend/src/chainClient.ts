import { ethers } from 'ethers';
import { config } from './config';
import { PONS_FACTORY_ABI } from './ponsEncoder';

export function createProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(config.RPC_URL, config.CHAIN_ID);
}

function factory(provider: ethers.Provider): ethers.Contract {
  return new ethers.Contract(config.PONS_FACTORY_ADDRESS, PONS_FACTORY_ABI, provider);
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
export async function getLiveFeeWei(provider: ethers.Provider): Promise<bigint> {
  const fee = await factory(provider).launchFee();
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
  dexId: bigint = config.PONS_DEX_ID
): Promise<LaunchReadiness> {
  const f = factory(provider);
  const [enabled, whitelisted, count, dexCount] = await Promise.all([
    f.launchEnabled() as Promise<boolean>,
    f.whitelistedLaunchers(launcherAddress) as Promise<boolean>,
    f.launchConfigCount() as Promise<bigint>,
    f.dexConfigCount() as Promise<bigint>,
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

  const [cfg, dex] = await Promise.all([f.getLaunchConfig(launchConfigId), f.getDexConfig(dexId)]);
  const configEnabled = Boolean(cfg.enabled);
  const dexEnabled = Boolean(dex.enabled);
  const pairToken = cfg.pairToken as string;

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
