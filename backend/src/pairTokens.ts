/**
 * Which assets a launch can be paired against.
 *
 * pons v2 lets a launch be priced, funded and graduated in something other than
 * ETH: buyers spend that asset to buy in, the graduation target is counted in it,
 * the Uniswap pool it graduates into is paired against it, and the creator is paid
 * in it. The superseded factory approved eight; the current one approves 23 and has
 * already revoked one -- which is the argument for the next paragraph, not a figure
 * to rely on. Read the set, never this comment.
 *
 * THE SET IS DISCOVERED, NOT HARDCODED
 * ------------------------------------
 * `setPairTokenApproved` is owner-only and pons calls it whenever they like. A
 * checked-in list would be a snapshot of one afternoon, and this project has been
 * bitten by exactly that: the findings doc confidently recorded "nothing is
 * approved, not even ETH" and was wrong fourteen days later. So the approved set is
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

/** Every approved asset is named "<company> • Robinhood Token". The suffix identifies
 *  the issuer, not the asset, and nobody types it. */
function displayName(name: string): string {
  return name.split('•')[0].trim();
}

/**
 * Strips what people add around an asset's name without meaning anything by it.
 *
 * "tesla stock", "$TSLA", "AAPL shares" and "apple  token" all describe the same
 * choice. Removing these words is not guessing -- none of them distinguishes one
 * approved asset from another, because no approved asset differs from another only
 * by the word "stock".
 */
function normaliseAssetWord(s: string): string {
  return s
    .toLowerCase()
    .replace(/\$/g, '')
    // Word boundaries matter. Without them "Bitcoin" loses its "coin" and
    // "Restock" loses its "stock", so two unrelated assets could normalise to
    // the same string and be reported as ambiguous -- or treated as equal.
    .replace(/\b(stocks?|shares?|equity|token|coin)\b/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
 * Names for an asset that are not written anywhere on chain.
 *
 * Everything else in this file is discovered: the approved set, the symbols, the
 * decimals, the thresholds. This table is the one exception, and it is deliberately
 * tiny, because it encodes knowledge the chain does not carry -- that Google is
 * Alphabet, that SpaceX is Space Exploration Technologies Corp., that the S&P 500 is
 * what SPY tracks. No amount of reading the factory would reveal any of that.
 *
 * WHY THIS IS SAFE, GIVEN THE PAIRING IS PERMANENT
 * An entry is a hint, not an answer. It names a SYMBOL, which is then looked up in
 * the approved set like any other -- so an alias pointing at something pons has
 * revoked resolves to nothing and is refused normally, exactly as if the table were
 * empty. It cannot introduce an asset, only recognise one already approved.
 *
 * WHAT DOES NOT BELONG HERE
 * Guesses, near misses, and anything a reasonable person might mean two ways. These
 * are alternative *names for the same company*, not similar-sounding tickers. "AAP"
 * will never appear here.
 */
const ALIASES: Record<string, string> = {
  google: 'GOOGL',
  spacex: 'SPCX',
  'space x': 'SPCX',
  'sp 500': 'SPY',
  sp500: 'SPY',
  // "S&P 500" normalises to "s p 500" -- the ampersand becomes a space before this
  // table is consulted, so the key has to be the normalised form, not the typed one.
  's p 500': 'SPY',
  's p500': 'SPY',
  spx: 'SPY',
  's and p 500': 'SPY',
  'standard and poors 500': 'SPY',
};

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

  // Both sides go through the same normalisation, the issuer suffix included:
  // somebody who copies an asset's full name out of the block explorer has named
  // it more precisely than someone typing "tesla", and should not lose for it.
  const norm = normaliseAssetWord(displayName(want));
  let matches = assets.filter((a) => normaliseAssetWord(a.symbol) === norm);

  // Then by the asset's own name, which is where "pair it with tesla stock" lands.
  //
  // This is interpretation, and it belongs here rather than in the parser: the parser
  // reads a tweet and has no idea what pons has approved, whereas this is matching
  // against a closed set read from the factory minutes ago. Refusing "Tesla" because
  // it is not the string "TSLA" would be pedantry that costs a launch.
  //
  // Still exact, not fuzzy. The comparison is against the display half of the name --
  // "Tesla • Robinhood Token" becomes "tesla" -- so "Tesla" matches and "Tes" does
  // not. Nothing here does prefix or edit-distance matching: this choice is permanent
  // and unchangeable once made, so a near miss must remain a refusal.
  if (matches.length === 0) {
    matches = assets.filter((a) => normaliseAssetWord(displayName(a.name)) === norm);
  }

  // Last, the handful of names the chain does not know it has. Resolved through the
  // approved set rather than around it, so a revoked asset stays refused.
  if (matches.length === 0 && ALIASES[norm]) {
    const wanted = ALIASES[norm];
    matches = assets.filter((a) => normaliseAssetWord(a.symbol) === normaliseAssetWord(wanted));
  }

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
  /** When a scan last FAILED, or 0 if the last one succeeded. See `retryFloorMs`. */
  private failedAt = 0;

  constructor(
    private source: PairTokenSource,
    private ttlMs = 3600_000,
    private now: () => number = Date.now,
    /**
     * How soon a FAILED refresh may be retried.
     *
     * Only matters once serving stale stopped blocking. Before, a caller waited for the
     * scan and the next one could not start until it finished; now every caller returns
     * immediately, so a persistently failing RPC would have each one start another scan
     * the moment the last gave up -- turning a slow dependency into a scan storm against
     * it. `fetchedAt` cannot carry this: moving it on failure would make a stale set look
     * freshly fetched, which is a lie told to the very code deciding whether to refresh.
     *
     * Applies only after a failure. A successful scan clears it, so the ordinary TTL
     * refresh is never delayed by it.
     */
    private retryFloorMs = 60_000
  ) {}

  /**
   * Fresh cache is served; a stale one is served too, and refreshed behind it.
   *
   * Only a cold registry waits. The catch below already decided that serving a stale list
   * beats refusing a launch over a transient RPC failure -- but the wait on expiry did not
   * follow that decision, so a refresh that was merely SLOW was treated worse than one that
   * outright failed. Whichever caller happened to land on the expiring TTL paid for the
   * whole scan, and on `/status`, where every dependency call is bounded at five seconds,
   * that surfaced as `pair-assets` degraded while a perfectly good cached set sat unused.
   *
   * Observed in production on 2026-08-22: one request degraded, the next `ok` with the same
   * eight assets, nothing wrong in between. That is the shape of a check that reports on its
   * own latency rather than on the dependency, and a status page that cries wolf on a timer
   * teaches its reader to skip it -- the exact failure `launchpadWatch.ts` exists to catch.
   *
   * Serving stale is safe here for the reason the catch already gives, and one more: the
   * launch path re-reads approval live before anything irreversible (`assertPairStillApproved`),
   * so this list decides what is OFFERED, never what is permitted.
   */
  async list(): Promise<PairAsset[]> {
    if (this.cached && this.now() - this.fetchedAt < this.ttlMs) return this.cached;

    // Stale-while-revalidate. A cold registry has nothing to serve and must wait.
    if (this.cached) {
      // Not awaited, so its rejection must be marked handled here. The chain below
      // resolves to the cached set whenever one exists, but `invalidate()` can clear
      // the cache mid-scan and turn that into a throw nobody is listening for.
      if (this.mayAttempt()) void this.startRefresh().catch(() => undefined);
      return this.cached;
    }
    return this.startRefresh();
  }

  /**
   * Whether a new scan may start.
   *
   * Backoff is measured from the last FAILURE, never from the last attempt. Measuring from
   * the attempt gates the ordinary hourly refresh too -- the first version did exactly that,
   * and a healthy registry stopped rediscovering entirely while every test that only checked
   * the happy path still passed.
   */
  private mayAttempt(): boolean {
    if (this.inFlight !== null) return true;
    if (this.failedAt === 0) return true;
    return this.now() - this.failedAt >= this.retryFloorMs;
  }

  /** The single shared scan. Concurrent callers must not each trigger their own. */
  private startRefresh(): Promise<PairAsset[]> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = discoverPairAssets(this.source)
      .then((assets) => {
        this.cached = assets;
        this.fetchedAt = this.now();
        this.failedAt = 0;
        return assets;
      })
      .catch((err) => {
        this.failedAt = this.now();
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
