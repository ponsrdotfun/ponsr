/**
 * Which assets a launch can be paired against.
 *
 * pons v2 lets a launch be priced, funded and graduated in something other than
 * ETH: buyers spend that asset to buy in, the graduation target is counted in it,
 * the Uniswap pool it graduates into is paired against it, and the creator is paid
 * in it. As of 2026-08-15 eight assets are approved and six are tokenised stocks
 * (AAPL, NVDA, GOOGL, TSLA, GME, SPCX, SPY) plus USDG.
 *
 * THE SET IS DISCOVERED, NOT HARDCODED
 * ------------------------------------
 * `setPairTokenApproved` is owner-only and pons calls it whenever they like. A
 * checked-in list would be a snapshot of one afternoon, and this project has been
 * bitten by exactly that: the findings doc confidently recorded "nothing is
 * approved, not even ETH" and was wrong eleven days later. So the approved set is
 * rebuilt from the factory's own `PairTokenApprovalUpdated` history, which means
 * an asset pons approves tomorrow works without a deploy, and one they revoke
 * stops working without anyone having to notice.
 *
 * Symbols and decimals are read from each token contract rather than assumed.
 * USDG is 6-decimal while everything else on this chain is 18, so an assumed 18
 * is not a rounding error but a figure off by a factor of a trillion.
 *
 * NATIVE ETH IS NOT IN THE APPROVAL MAP AND IS STILL VALID
 * --------------------------------------------------------
 * `approvedPairTokens(address(0))` reads `false`, which looks like ETH pairing is
 * forbidden. It is not. The factory's own gate is:
 *
 *     if (pairToken != address(0) && !approvedPairTokens[pairToken]) revert ...
 *
 * so the zero address short-circuits the check -- confirmed by 13 of the 43 real
 * v2 launches using it while it read as unapproved. Treating that `false` as a
 * refusal would remove the one pairing that has always worked.
 */

/** The zero address: native ETH, exempt from the approval check. */
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

export interface PairAsset {
  /** `pairToken` as passed to `launchToken`. NATIVE_ETH for ETH. */
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** From `pairTokenEconomics`, denominated in this asset's own decimals. Null for
   *  native ETH, whose threshold lives in the launch config instead -- a number we
   *  do not have here and will not invent. */
  graduationThreshold: bigint | null;
}

export interface ApprovalEvent {
  pairToken: string;
  approved: boolean;
  /** Ordering only. The last event for a token is its current state. */
  blockNumber: number;
  logIndex: number;
}

export interface PairTokenSource {
  /** Every `PairTokenApprovalUpdated` ever emitted, in any order. */
  approvalHistory(): Promise<ApprovalEvent[]>;
  tokenMeta(address: string): Promise<{ symbol: string; name: string; decimals: number }>;
  economics(address: string): Promise<{ graduationThreshold: bigint; decimals: number }>;
  /** Read live before use. History can be stale by a block; this cannot. */
  isApproved(address: string): Promise<boolean>;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Rebuilds the approved set from history.
 *
 * A token can be approved, revoked and approved again, so only the newest event
 * per token counts. Ordering is (block, logIndex) because two approvals can share
 * a block -- pons granted six of the eight within 200 blocks of each other, and
 * sorting on block alone would leave their relative order to chance.
 */
export async function discoverPairAssets(source: PairTokenSource): Promise<PairAsset[]> {
  const history = await source.approvalHistory();

  const newest = new Map<string, ApprovalEvent>();
  for (const e of history) {
    const key = e.pairToken.toLowerCase();
    const prev = newest.get(key);
    if (
      !prev ||
      e.blockNumber > prev.blockNumber ||
      (e.blockNumber === prev.blockNumber && e.logIndex > prev.logIndex)
    ) {
      newest.set(key, e);
    }
  }

  const assets: PairAsset[] = [];
  for (const e of newest.values()) {
    if (!e.approved) continue;
    // Confirmed against current state, not just the log: a revocation we failed to
    // read would otherwise leave an asset in the list that every launch reverts on.
    if (!(await source.isApproved(e.pairToken))) continue;

    let meta: { symbol: string; name: string; decimals: number };
    try {
      meta = await source.tokenMeta(e.pairToken);
    } catch {
      // A token whose own symbol cannot be read cannot be offered by name, and
      // guessing one would let a user pick an asset they did not mean.
      continue;
    }

    let threshold: bigint | null = null;
    try {
      const econ = await source.economics(e.pairToken);
      threshold = econ.graduationThreshold;
      // The economics record carries its own decimals. Where they disagree with the
      // token, the economics figure is the one the factory does arithmetic with.
      if (econ.decimals !== meta.decimals) meta = { ...meta, decimals: econ.decimals };
    } catch {
      /* Threshold is informational; a launch does not need it. */
    }

    assets.push({
      address: e.pairToken,
      symbol: meta.symbol,
      name: meta.name,
      decimals: meta.decimals,
      graduationThreshold: threshold,
    });
  }

  assets.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return assets;
}

export type PairResolution =
  | { ok: true; asset: PairAsset }
  | { ok: false; reason: 'UNKNOWN'; detail: string }
  | { ok: false; reason: 'AMBIGUOUS'; detail: string };

/**
 * Turns what somebody typed into an asset.
 *
 * Deliberately strict. This picks which asset a launch is priced and paid in, it
 * is fixed forever at launch, and nobody can change it afterwards -- so a near
 * miss must be a refusal rather than a guess. "AAP" does not become AAPL, and a
 * symbol two assets share is refused rather than silently resolved to the first.
 */
export function resolvePairAsset(assets: readonly PairAsset[], typed: string | null | undefined): PairResolution {
  const want = (typed ?? '').trim().replace(/^\$/, '');
  if (!want) return { ok: false, reason: 'UNKNOWN', detail: 'no asset given' };

  // Native ETH is always available and is never in the approval map.
  if (/^(eth|ether|weth)$/i.test(want)) {
    return {
      ok: true,
      asset: { address: NATIVE_ETH, symbol: 'ETH', name: 'Ether', decimals: 18, graduationThreshold: null },
    };
  }

  // An address is accepted only if it is in the approved set -- passing an
  // arbitrary one through would be a launch that reverts, having spent gas.
  if (/^0x[0-9a-fA-F]{40}$/.test(want)) {
    const byAddress = assets.find((a) => eq(a.address, want));
    return byAddress
      ? { ok: true, asset: byAddress }
      : { ok: false, reason: 'UNKNOWN', detail: `${want} is not an approved pairing asset` };
  }

  const matches = assets.filter((a) => a.symbol.toLowerCase() === want.toLowerCase());
  if (matches.length === 1) return { ok: true, asset: matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      reason: 'AMBIGUOUS',
      detail: `${want} matches ${matches.length} approved assets; name the contract address instead`,
    };
  }
  return {
    ok: false,
    reason: 'UNKNOWN',
    detail: `${want} is not an approved pairing asset (available: ${assets.map((a) => a.symbol).join(', ') || 'none'})`,
  };
}

/**
 * Caches the discovered set.
 *
 * Discovery is a log scan plus three calls per asset, which is far too much to do
 * on every mention, and the set changes about as often as pons decides to change
 * it. The TTL is the delay between pons approving something and the bot offering
 * it -- an hour is a reasonable trade, and `refresh()` exists for when it is not.
 */
export class PairAssetRegistry {
  private cached: PairAsset[] | null = null;
  private fetchedAt = 0;
  private inFlight: Promise<PairAsset[]> | null = null;

  constructor(
    private source: PairTokenSource,
    private ttlMs = 3600_000,
    private now: () => number = Date.now
  ) {}

  async list(): Promise<PairAsset[]> {
    if (this.cached && this.now() - this.fetchedAt < this.ttlMs) return this.cached;
    // Concurrent mentions must not each trigger their own log scan; they share one.
    if (this.inFlight) return this.inFlight;

    this.inFlight = discoverPairAssets(this.source)
      .then((assets) => {
        this.cached = assets;
        this.fetchedAt = this.now();
        return assets;
      })
      .catch((err) => {
        // Serving a stale list beats refusing every launch over a transient RPC
        // failure: the set changes rarely, and `isApproved` is checked live at
        // launch time anyway. With nothing cached there is nothing to fall back on.
        if (this.cached) {
          console.warn('[pairTokens] refresh failed, serving cached set:', (err as Error)?.message ?? err);
          return this.cached;
        }
        throw err;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  async resolve(typed: string | null | undefined): Promise<PairResolution> {
    return resolvePairAsset(await this.list(), typed);
  }

  /** Drops the cache so the next read rediscovers. */
  refresh(): void {
    this.cached = null;
    this.fetchedAt = 0;
  }
}
