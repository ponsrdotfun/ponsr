import { ethers } from 'ethers';
import { LaunchParams } from './ponsEncoder';
import { NATIVE_ETH } from './pairTokens';
import v2FactoryAbi from './abi/ponsV2LaunchFactory.json';

/**
 * Calldata for pons v2's `launchToken`, which is a different function from v1's.
 *
 * It is not a superset with an extra argument -- three things moved:
 *
 *   v1: launchToken(params(…, feeWallet), launchConfigId, dexId, salt)
 *   v2: launchToken(params(…, creatorFeeRecipient, creatorTaxBps, buybackEnabled,
 *                          expectedEconomics), launchConfigId, pairToken)
 *
 * `dexId` and `salt` are gone, `feeWallet` is now `creatorFeeRecipient`, and three
 * fields appear that did not exist. Encoding a v1 call against a v2 factory does not
 * produce a helpful error; it produces a reverted transaction that has already spent
 * gas, which is why this is a separate file rather than a branch inside the old one.
 */

export const PONS_V2_FACTORY_ABI = v2FactoryAbi as ethers.InterfaceAbi;

export interface V2LaunchParams extends Omit<LaunchParams, 'dexId' | 'salt'> {
  /** What the launch is priced, funded and graduated in. NATIVE_ETH for ETH. */
  pairToken: string;
  /**
   * Trading tax paid to the creator, in basis points. The factory caps this at
   * `maxCreatorTaxBps` (1000 = 10% today) and separately caps `curveFeeBps +
   * creatorTaxBps`.
   *
   * Ponsr sends 0. A tax is a charge on every trade of somebody else's token,
   * levied by us, on a launch they asked for in a tweet and cannot renegotiate --
   * and it would be invisible to them. Revenue comes from the fee split, which is
   * on the record and checkable on-chain.
   */
  creatorTaxBps: number;
  buybackEnabled: boolean;
  /**
   * The economics digest from `previewLaunchEconomics`, read immediately before
   * launching. Pins supply, thresholds and fee tiers to what was quoted: if pons
   * changes any of them between the read and the transaction landing, the launch
   * reverts instead of quietly repricing.
   *
   * `bytes32(0)` disables the check. That is the factory's default, not ours --
   * see `ZERO_ECONOMICS` below.
   */
  expectedEconomics: string;
}

/** The factory reads this as "do not check", accepting whatever terms are current
 *  when the transaction lands. Named rather than written inline so that choosing it
 *  is always deliberate. */
export const ZERO_ECONOMICS = '0x' + '00'.repeat(32);

/**
 * Builds the v2 calldata and value.
 *
 * `value` is exactly the launch fee, for the same reason as v1: anything above it is
 * treated as an initial buy, and the treasury must never buy into a token it launched
 * on somebody else's behalf.
 *
 * The fee is paid in ETH whatever the pairing asset is. A stock-paired launch does
 * not mean paying the fee in stock -- it means the *proceeds* arrive in stock.
 */
export function buildV2LaunchCalldata(
  params: V2LaunchParams,
  launchFeeWei: bigint
): { data: string; value: bigint } {
  if (!ethers.isAddress(params.pairToken)) {
    throw new Error(`pairToken is not an address: ${params.pairToken}`);
  }
  if (!Number.isInteger(params.creatorTaxBps) || params.creatorTaxBps < 0 || params.creatorTaxBps > 10_000) {
    throw new Error(`creatorTaxBps out of range: ${params.creatorTaxBps}`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.expectedEconomics)) {
    throw new Error(`expectedEconomics is not a bytes32: ${params.expectedEconomics}`);
  }

  const iface = new ethers.Interface(PONS_V2_FACTORY_ABI);
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
      creatorFeeRecipient: params.feeWallet,
      creatorTaxBps: params.creatorTaxBps,
      buybackEnabled: params.buybackEnabled,
      expectedEconomics: params.expectedEconomics,
    },
    params.launchConfigId,
    params.pairToken,
  ]);

  return { data, value: launchFeeWei };
}

/**
 * Reads what a v2 launch actually produced, from the receipt's own logs.
 *
 * The same rule as v1: the function returns the address, but a mined receipt carries
 * only events, and the event is what the chain recorded. `pairToken` is read back
 * rather than assumed from the request -- it is fixed forever at this moment, so it
 * is worth confirming from the chain what everyone will be trading against.
 */
export function extractV2LaunchDetails(
  logs: readonly ethers.Log[]
): { token: string; curve: string; pairToken: string; graduationThreshold: bigint } | null {
  const iface = new ethers.Interface(PONS_V2_FACTORY_ABI);
  for (const log of logs) {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === 'TokenLaunched') {
        return {
          token: parsed.args.token as string,
          curve: parsed.args.curve as string,
          pairToken: parsed.args.pairToken as string,
          graduationThreshold: BigInt(parsed.args.graduationThreshold),
        };
      }
    } catch {
      /* Not one of ours; receipts carry logs from every contract the call touched. */
    }
  }
  return null;
}

/** True when a launch is against native ETH rather than an ERC20 quote asset. */
export function isNativePair(pairToken: string): boolean {
  return pairToken.toLowerCase() === NATIVE_ETH;
}
