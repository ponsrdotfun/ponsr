import { ethers } from 'ethers';
import factoryArtifact from './abi/ponsLaunchFactory.json';

/**
 * Encodes calls to the pons v1 launch factory.
 *
 * The ABI below is the **real, verified interface**, pulled from the Robinhood Chain
 * Blockscout instance on 2026-08-04 (`backend/src/abi/ponsLaunchFactory.json`). Everything
 * this file previously contained was a best-effort guess and was wrong in every parameter --
 * see `docs/pons-v2-findings.md` §8 for the before/after.
 *
 * The real signature:
 *
 *   launchToken(
 *     TokenParams { name, symbol, logo, description, Socials, feeWallet },
 *     uint256 launchConfigId,
 *     uint256 dexId,
 *     bytes32 salt
 *   ) payable returns (address token)
 *
 * Three things worth knowing before changing anything here:
 *
 *  1. **There is no dev-buy parameter.** The old encoder hardcoded `devBuyAmount = 0` to keep
 *     the bot from ever buying into a launch it created. That protection is now structural:
 *     the caller cannot express a dev buy at all. (The factory *can* perform one, but only
 *     from `msg.value` above the launch fee -- so sending exactly the fee is what keeps it
 *     at zero. `buildLaunchCalldata` returns exactly the fee for that reason.)
 *
 *  2. **There is one `feeWallet`, not a separate creator wallet.** It is written to the
 *     locker as `feeRedirects[token]`, and the locker pays trading fees to it. It is also the
 *     recipient of any initial buy.
 *
 *  3. **Fees arrive as ERC20, never as native ETH.** The locker collects from the Uniswap v3
 *     position and pushes `token0`/`token1` to the recipient. Any contract used as `feeWallet`
 *     must be able to move ERC20 out again, or the fees are stranded permanently.
 */

export const PONS_FACTORY_ABI = factoryArtifact.abi;

/** Kept for callers that only need the fragment; the full ABI is a superset. */
export const PONS_FACTORY_ABI_FRAGMENT = PONS_FACTORY_ABI;

export interface LaunchSocials {
  twitter: string;
  telegram: string;
  discord: string;
  website: string;
  farcaster: string;
}

export const EMPTY_SOCIALS: LaunchSocials = {
  twitter: '',
  telegram: '',
  discord: '',
  website: '',
  farcaster: '',
};

export interface LaunchParams {
  tokenName: string;
  tokenSymbol: string;
  /** Free-form image reference. Travels as a calldata string -- there is no IPFS step. */
  logo: string;
  /** Free-form description, also calldata. */
  description: string;
  socials: LaunchSocials;
  /**
   * Receives trading fees (via the locker's `feeRedirects`) and any initial buy. Per Part 8
   * this is the per-launch splitter, not the user's raw wallet -- but see note 3 above: the
   * splitter must be able to move ERC20 out, which the original ETH-only design could not.
   */
  feeWallet: string;
  /** Index into the factory's launch configs. Read live, never assumed -- a config carries the
   *  pair token, graduation threshold and supply, and pons can add or disable them. */
  launchConfigId: bigint;
  /** Index into the factory's DEX configs. */
  dexId: bigint;
  /** CREATE2 salt. Must differ per launch or the predicted token address collides. */
  salt: string;
}

/**
 * Derives the CREATE2 salt from the source tweet.
 *
 * Deterministic on purpose: if a launch is retried after an ambiguous failure, it resolves to
 * the same predicted token address, so the second attempt reverts with `PoolAlreadyExists`
 * rather than quietly deploying a second token for one request. A random salt would silently
 * duplicate instead -- the exact double-spend the idempotency work exists to prevent.
 */
export function saltForTweet(tweetId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`ponsr:launch:${tweetId}`));
}

/**
 * Builds the calldata and value for `launchToken`.
 *
 * `value` is exactly the live launch fee. The factory treats anything above the fee as an
 * initial buy, so overpaying would make the treasury buy into the user's token -- sending the
 * exact fee is what keeps the dev buy at zero.
 */
export function buildLaunchCalldata(
  params: LaunchParams,
  launchFeeWei: bigint
): { data: string; value: bigint } {
  const iface = new ethers.Interface(PONS_FACTORY_ABI);

  const data = iface.encodeFunctionData('launchToken', [
    {
      name: params.tokenName,
      symbol: params.tokenSymbol,
      logo: params.logo,
      description: params.description,
      socials: {
        twitter: params.socials.twitter,
        telegram: params.socials.telegram,
        discord: params.socials.discord,
        website: params.socials.website,
        farcaster: params.socials.farcaster,
      },
      feeWallet: params.feeWallet,
    },
    params.launchConfigId,
    params.dexId,
    params.salt,
  ]);

  return { data, value: launchFeeWei };
}

/**
 * Reads the deployed token address out of the receipt's own logs.
 *
 * Never derived any other way. The factory does return the address, but a return value is not
 * available from a mined transaction receipt -- only the event is, and the event is what the
 * chain actually recorded.
 */
export function extractLaunchedTokenAddress(logs: readonly ethers.Log[]): string | null {
  const iface = new ethers.Interface(PONS_FACTORY_ABI);
  for (const log of logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed && parsed.name === 'TokenLaunched') {
        return parsed.args.token as string;
      }
    } catch {
      continue; // a log from another contract, or a different event
    }
  }
  return null;
}

/** The Uniswap v3 position the launch created. Needed to reason about fee collection, and
 *  emitted only in `TokenLaunched`. */
export function extractLaunchDetails(
  logs: readonly ethers.Log[]
): { token: string; pool: string; pairToken: string; positionId: bigint; initialBuyAmount: bigint } | null {
  const iface = new ethers.Interface(PONS_FACTORY_ABI);
  for (const log of logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed && parsed.name === 'TokenLaunched') {
        return {
          token: parsed.args.token as string,
          pool: parsed.args.pool as string,
          pairToken: parsed.args.pairToken as string,
          positionId: BigInt(parsed.args.positionId.toString()),
          initialBuyAmount: BigInt(parsed.args.initialBuyAmount.toString()),
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}
