import { PonsDeployment } from './deployments';
import { NATIVE_ETH, PairAsset, PairResolution } from './pairTokens';

/**
 * Everything the canary must settle before it spends anything.
 *
 * WHY THIS IS A FUNCTION AND NOT INLINE
 * -------------------------------------
 * `phase-b-launch.ts` had the ordering wrong in a way that costs money exactly once:
 *
 *   the dry run returned BEFORE `PAIR_WITH` was ever resolved, so the run whose entire
 *   purpose is to surface problems could not surface this one;
 *
 *   execute deployed the FeeSplitter FIRST and resolved the pair afterwards.
 *
 * An invalid or revoked stock pair therefore produced a deployed, paid-for splitter bound
 * to a launch that then refused to happen. The script said so plainly -- "the splitter
 * above is deployed but unused" -- which is an accurate description of money already gone.
 *
 * It lives here because a preflight that can only be exercised by running a script which
 * broadcasts transactions is a preflight nobody tests, and this is the one run that
 * spends real funds for the first time.
 */

export interface CanaryPairDeps {
  /** The deployment this canary run selected, once, at the top. */
  deployment: PonsDeployment;
  /** Whether the selected target can price a launch in anything but ETH. */
  supportsPairing: boolean;
  /** The registry's answer -- which may be up to an hour old. */
  resolve(typed: string): Promise<PairResolution>;
  /** The factory's answer, right now. */
  isApprovedNow(pairToken: string): Promise<boolean>;
}

const ETH: PairAsset = {
  address: NATIVE_ETH,
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
  graduationThreshold: null,
};

/**
 * Resolves what this launch will trade against, and proves it is still allowed.
 *
 * Throws rather than returning a flag. Every caller is about to spend money, and a
 * boolean at this point is something a caller can forget to read.
 */
export async function resolveCanaryPair(
  requested: string | undefined,
  deps: CanaryPairDeps
): Promise<{ asset: PairAsset; source: 'default-eth' | 'registry' }> {
  const where = `${deps.deployment.id} (${deps.deployment.factory})`;

  // Nothing asked for: ETH, which needs no approval and is what v1 always uses.
  if (!requested) return { asset: ETH, source: 'default-eth' };

  if (!deps.supportsPairing) {
    throw new Error(
      `PAIR_WITH="${requested}" was set, but this target takes its pairing from the launch ` +
        'config rather than from a parameter. Unset it to launch against ETH, or select a ' +
        'deployment that can pair.'
    );
  }

  const resolved = await deps.resolve(requested);
  if (!resolved.ok) {
    throw new Error(
      `PAIR_WITH="${requested}" is not an approved pairing asset on ${where}: ` +
        `${resolved.detail}. Nothing has been deployed.`
    );
  }

  // The registry cached this; the factory decides it. Between the two sits up to an hour
  // in which pons can revoke an asset -- and RIVN was approved and then revoked, so this
  // is a thing that happens rather than a thing that could.
  let approved: boolean;
  try {
    approved = await deps.isApprovedNow(resolved.asset.address);
  } catch (err: unknown) {
    // A read that failed is not an approval, and this is the run that spends real money.
    throw new Error(
      `could not read the live approval for ${resolved.asset.symbol} on ${where}: ` +
        `${(err as Error)?.message ?? String(err)}. Refusing before anything is deployed.`
    );
  }

  if (!approved) {
    throw new Error(
      `${resolved.asset.symbol} (${resolved.asset.address}) is no longer approved on ${where}. ` +
        'It was approved when the pair list was last scanned, so pons has revoked it since. ' +
        'Refusing before the splitter is deployed -- launching would spend the fee on a ' +
        'transaction that must revert.'
    );
  }

  return { asset: resolved.asset, source: 'registry' };
}
