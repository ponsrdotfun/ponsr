import { PonsDeployment } from './deployments';
import { NATIVE_ETH, PairAsset, PairResolution, isNativeEth } from './pairTokens';

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
): Promise<{ asset: PairAsset; source: 'default-eth' | 'explicit-eth' | 'registry' }> {
  const where = `${deps.deployment.id} (${deps.deployment.factory})`;

  // Nothing asked for: ETH, which needs no approval and is what v1 always uses.
  if (!requested) return { asset: ETH, source: 'default-eth' };

  /**
   * RESOLVE FIRST, then decide -- because the exemption belongs to the address.
   *
   * The order used to be the other way round: the pairing-support check ran before anything
   * was resolved, and the approval re-read ran unconditionally afterwards. That produced two
   * verdicts for one asset. With PAIR_WITH unset, native ETH returned immediately and was
   * never checked against the approval map; with PAIR_WITH=ETH it reached
   * `isApprovedNow(0x0)`, which is false and always has been, and the run refused with a
   * revocation message about something nobody had revoked. Measured on mainnet during the
   * authorised dry run of 2026-08-25.
   *
   * A failure to resolve is held rather than thrown here, so a target that cannot pair at all
   * still gets the more useful message below instead of a resolver error.
   */
  let resolved: PairResolution | null = null;
  let resolveError: unknown = null;
  try {
    resolved = await deps.resolve(requested);
  } catch (err) {
    resolveError = err;
  }

  /**
   * Explicit native ETH is the same launch as default native ETH.
   *
   * No approval read, because the factory's gate short-circuits on the zero address and
   * `approvedPairTokens(0x0)` has never been true. The canonical ETH descriptor is returned
   * rather than the resolver's copy, so the outgoing `pairToken`, the decimals and the symbol
   * are identical to the default path by construction rather than by coincidence.
   *
   * The source says `explicit-eth`, not `default-eth` and not `registry`: the operator did
   * choose it, and no registry approval was consulted. A log that claimed either would be
   * describing a check that did not happen.
   *
   * Reached before the pairing-support check on purpose. A target that prices every launch in
   * ETH cannot honour an arbitrary pair, but "pair with ETH" is exactly what it already does,
   * so refusing it would be refusing the thing it is about to do anyway.
   */
  if (resolved?.ok && isNativeEth(resolved.asset.address)) {
    return { asset: ETH, source: 'explicit-eth' };
  }

  if (!deps.supportsPairing) {
    throw new Error(
      `PAIR_WITH="${requested}" was set, but this target takes its pairing from the launch ` +
        'config rather than from a parameter. Unset it to launch against ETH, or select a ' +
        'deployment that can pair.'
    );
  }

  if (resolveError) {
    throw new Error(
      `PAIR_WITH="${requested}" could not be resolved on ${where}: ` +
        `${(resolveError as Error)?.message ?? String(resolveError)}. Nothing has been deployed.`
    );
  }
  if (!resolved || !resolved.ok) {
    throw new Error(
      `PAIR_WITH="${requested}" is not an approved pairing asset on ${where}: ` +
        `${resolved?.detail ?? 'no resolution'}. Nothing has been deployed.`
    );
  }
  // Narrowed once, here, so the non-native path below reads as it always did.
  const asset = resolved.asset;

  // The registry cached this; the factory decides it. Between the two sits up to an hour
  // in which pons can revoke an asset -- and RIVN was approved and then revoked, so this
  // is a thing that happens rather than a thing that could.
  let approved: boolean;
  try {
    approved = await deps.isApprovedNow(asset.address);
  } catch (err: unknown) {
    // A read that failed is not an approval, and this is the run that spends real money.
    throw new Error(
      `could not read the live approval for ${asset.symbol} on ${where}: ` +
        `${(err as Error)?.message ?? String(err)}. Refusing before anything is deployed.`
    );
  }

  if (!approved) {
    throw new Error(
      `${asset.symbol} (${asset.address}) is no longer approved on ${where}. ` +
        'It was approved when the pair list was last scanned, so pons has revoked it since. ' +
        'Refusing before the splitter is deployed -- launching would spend the fee on a ' +
        'transaction that must revert.'
    );
  }

  return { asset, source: 'registry' };
}
