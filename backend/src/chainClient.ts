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
  launchConfigId: bigint
): Promise<LaunchReadiness> {
  const f = factory(provider);
  const [enabled, whitelisted, count] = await Promise.all([
    f.launchEnabled() as Promise<boolean>,
    f.whitelistedLaunchers(launcherAddress) as Promise<boolean>,
    f.launchConfigCount() as Promise<bigint>,
  ]);

  const launchConfigCount = BigInt(count.toString());
  const canLaunch = Boolean(enabled) || Boolean(whitelisted);

  if (launchConfigId >= launchConfigCount) {
    return {
      launchEnabled: Boolean(enabled),
      canLaunch,
      whitelisted: Boolean(whitelisted),
      launchConfigUsable: false,
      launchConfigCount,
      pairToken: null,
      reason: `launchConfigId ${launchConfigId} does not exist (factory has ${launchConfigCount})`,
    };
  }

  const cfg = await f.getLaunchConfig(launchConfigId);
  const configEnabled = Boolean(cfg.enabled ?? cfg[8]);
  const pairToken = (cfg.pairToken ?? cfg[0]) as string;

  let reason: string | undefined;
  if (!canLaunch) reason = 'launchEnabled is false and this launcher is not whitelisted';
  else if (!configEnabled) reason = `launch config ${launchConfigId} is disabled`;

  return {
    launchEnabled: Boolean(enabled),
    canLaunch,
    whitelisted: Boolean(whitelisted),
    launchConfigUsable: configEnabled,
    launchConfigCount,
    pairToken,
    reason,
  };
}
