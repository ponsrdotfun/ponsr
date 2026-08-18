import {
  NATIVE_ETH,
  PairAsset,
  PairAssetRegistry,
  PairTokenSource,
  discoverPairAssets,
  resolvePairAsset,
} from '../src/pairTokens';

/**
 * The pairing asset is chosen at launch and fixed forever: buyers spend it, the
 * graduation target is counted in it, and the creator and treasury are paid in it.
 * Nobody can change it afterwards. Every test here exists because getting one of
 * these wrong writes the mistake permanently on-chain.
 */

const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const GONE = '0x1111111111111111111111111111111111111111';

const META: Record<string, { symbol: string; name: string; decimals: number }> = {
  [AAPL.toLowerCase()]: { symbol: 'AAPL', name: 'Apple • Robinhood Token', decimals: 18 },
  [USDG.toLowerCase()]: { symbol: 'USDG', name: 'Global Dollar', decimals: 6 },
  [GONE.toLowerCase()]: { symbol: 'GONE', name: 'Revoked', decimals: 18 },
};

function source(over: Partial<PairTokenSource> = {}): PairTokenSource {
  return {
    approvalHistory: async () => [
      { pairToken: AAPL, approved: true, blockNumber: 100, logIndex: 0 },
      { pairToken: USDG, approved: true, blockNumber: 120, logIndex: 3 },
    ],
    tokenMeta: async (a) => {
      const m = META[a.toLowerCase()];
      if (!m) throw new Error('no symbol()');
      return m;
    },
    economics: async (a) =>
      a.toLowerCase() === USDG.toLowerCase()
        ? { graduationThreshold: 8_090_000_000n, decimals: 6 }
        : { graduationThreshold: 242n * 10n ** 17n, decimals: 18 },
    isApproved: async () => true,
    ...over,
  };
}

describe('discoverPairAssets', () => {
  it('builds the approved set from the factory’s own history', async () => {
    const assets = await discoverPairAssets(source());
    expect(assets.map((a) => a.symbol)).toEqual(['AAPL', 'USDG']);
  });

  // USDG is 6-decimal and everything else on this chain is 18. Assuming 18 is not a
  // rounding error, it is a figure wrong by a factor of a trillion.
  it('carries each asset’s real decimals rather than assuming 18', async () => {
    const assets = await discoverPairAssets(source());
    expect(assets.find((a) => a.symbol === 'USDG')!.decimals).toBe(6);
    expect(assets.find((a) => a.symbol === 'USDG')!.graduationThreshold).toBe(8_090_000_000n);
  });

  // A token can be approved, revoked, and approved again. Only the newest event counts.
  it('honours a revocation that came after an approval', async () => {
    const assets = await discoverPairAssets(
      source({
        approvalHistory: async () => [
          { pairToken: GONE, approved: true, blockNumber: 100, logIndex: 0 },
          { pairToken: GONE, approved: false, blockNumber: 300, logIndex: 0 },
        ],
      })
    );
    expect(assets).toEqual([]);
  });

  it('re-approval after a revocation puts the asset back', async () => {
    const assets = await discoverPairAssets(
      source({
        approvalHistory: async () => [
          { pairToken: GONE, approved: true, blockNumber: 100, logIndex: 0 },
          { pairToken: GONE, approved: false, blockNumber: 300, logIndex: 0 },
          { pairToken: GONE, approved: true, blockNumber: 400, logIndex: 0 },
        ],
      })
    );
    expect(assets.map((a) => a.symbol)).toEqual(['GONE']);
  });

  // pons granted six of the eight within 200 blocks; two events can share a block,
  // and sorting on block alone leaves their order to chance.
  it('breaks ties within a block by log index, not by luck', async () => {
    const assets = await discoverPairAssets(
      source({
        approvalHistory: async () => [
          { pairToken: GONE, approved: false, blockNumber: 500, logIndex: 9 },
          { pairToken: GONE, approved: true, blockNumber: 500, logIndex: 2 },
        ],
      })
    );
    expect(assets).toEqual([]);
  });

  // The log said approved; the chain says otherwise. The chain wins, or every launch
  // against that asset reverts after spending gas.
  it('drops an asset the log approved but the factory no longer does', async () => {
    const assets = await discoverPairAssets(source({ isApproved: async (a) => !a.toLowerCase().startsWith('0xaf3d') }));
    expect(assets.map((a) => a.symbol)).toEqual(['USDG']);
  });

  // An asset that cannot state its own symbol cannot be offered by name, and
  // inventing one would let somebody pick an asset they did not mean.
  it('skips an asset whose symbol cannot be read', async () => {
    const assets = await discoverPairAssets(
      source({
        tokenMeta: async (a) => {
          if (a.toLowerCase() === AAPL.toLowerCase()) throw new Error('not ERC20');
          return META[a.toLowerCase()];
        },
      })
    );
    expect(assets.map((a) => a.symbol)).toEqual(['USDG']);
  });

  // The threshold is informational. Losing it must not lose the asset.
  it('keeps an asset whose economics cannot be read', async () => {
    const assets = await discoverPairAssets(
      source({ economics: async () => { throw new Error('reverted'); } })
    );
    expect(assets.map((a) => a.symbol)).toEqual(['AAPL', 'USDG']);
    expect(assets[0].graduationThreshold).toBeNull();
  });
});

describe('resolvePairAsset', () => {
  let assets: PairAsset[];
  beforeAll(async () => { assets = await discoverPairAssets(source()); });

  it('resolves a symbol, with or without the $', () => {
    expect(resolvePairAsset(assets, 'AAPL')).toMatchObject({ ok: true, asset: { symbol: 'AAPL' } });
    expect(resolvePairAsset(assets, '$aapl')).toMatchObject({ ok: true, asset: { symbol: 'AAPL' } });
  });

  // Native ETH is exempt from the approval check, so it is never in the discovered
  // set. Reading its `false` as a refusal would remove the pairing that always worked.
  it('always offers native ETH even though it reads as unapproved', () => {
    const r = resolvePairAsset([], 'ETH');
    expect(r).toMatchObject({ ok: true, asset: { address: NATIVE_ETH, decimals: 18 } });
  });

  // The choice is permanent and nobody can change it later, so a near miss has to be
  // a refusal. "AAP" must not become AAPL.
  it('refuses a near miss instead of guessing', () => {
    expect(resolvePairAsset(assets, 'AAP')).toMatchObject({ ok: false, reason: 'UNKNOWN' });
    expect(resolvePairAsset(assets, 'TSLA')).toMatchObject({ ok: false, reason: 'UNKNOWN' });
  });

  it('names what is actually available when it refuses', () => {
    const r = resolvePairAsset(assets, 'MSFT');
    expect(r.ok).toBe(false);
    expect((r as any).detail).toContain('AAPL');
  });

  // Two approved assets sharing a symbol is a coin flip over somebody's money.
  it('refuses an ambiguous symbol rather than taking the first', () => {
    const dupes: PairAsset[] = [
      { address: AAPL, symbol: 'AAPL', name: 'one', decimals: 18, graduationThreshold: null },
      { address: USDG, symbol: 'AAPL', name: 'two', decimals: 18, graduationThreshold: null },
    ];
    expect(resolvePairAsset(dupes, 'AAPL')).toMatchObject({ ok: false, reason: 'AMBIGUOUS' });
  });

  it('accepts an approved address but refuses an arbitrary one', () => {
    expect(resolvePairAsset(assets, AAPL)).toMatchObject({ ok: true });
    expect(resolvePairAsset(assets, GONE)).toMatchObject({ ok: false, reason: 'UNKNOWN' });
  });

  it('treats nothing given as nothing chosen', () => {
    expect(resolvePairAsset(assets, null)).toMatchObject({ ok: false, reason: 'UNKNOWN' });
    expect(resolvePairAsset(assets, '   ')).toMatchObject({ ok: false, reason: 'UNKNOWN' });
  });
});

describe('PairAssetRegistry', () => {
  it('discovers once and serves the cache until the TTL expires', async () => {
    let scans = 0;
    const s = source({ approvalHistory: async () => { scans++; return [{ pairToken: AAPL, approved: true, blockNumber: 1, logIndex: 0 }]; } });
    let clock = 0;
    const reg = new PairAssetRegistry(s, 1000, () => clock);

    await reg.list();
    await reg.list();
    expect(scans).toBe(1);

    clock = 1500;
    await reg.list();
    expect(scans).toBe(2);
  });

  // Every mention would otherwise trigger its own log scan.
  it('collapses concurrent discovery into one scan', async () => {
    let scans = 0;
    const s = source({
      approvalHistory: async () => {
        scans++;
        await new Promise((r) => setTimeout(r, 10));
        return [{ pairToken: AAPL, approved: true, blockNumber: 1, logIndex: 0 }];
      },
    });
    const reg = new PairAssetRegistry(s);
    await Promise.all([reg.list(), reg.list(), reg.list()]);
    expect(scans).toBe(1);
  });

  // A transient RPC failure must not refuse every launch. The set changes rarely and
  // approval is re-checked live at launch time regardless.
  it('serves the stale set when a refresh fails', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let fail = false;
    const s = source({
      approvalHistory: async () => {
        if (fail) throw new Error('ECONNREFUSED');
        return [{ pairToken: AAPL, approved: true, blockNumber: 1, logIndex: 0 }];
      },
    });
    let clock = 0;
    const reg = new PairAssetRegistry(s, 1000, () => clock);
    await reg.list();

    fail = true;
    clock = 5000;
    await expect(reg.list()).resolves.toMatchObject([{ symbol: 'AAPL' }]);
    jest.restoreAllMocks();
  });

  // With nothing cached there is nothing to serve, and pretending the approved set is
  // empty would tell every user their asset does not exist.
  it('throws rather than reporting an empty set on a cold failure', async () => {
    const reg = new PairAssetRegistry(source({ approvalHistory: async () => { throw new Error('cold'); } }));
    await expect(reg.list()).rejects.toThrow('cold');
  });
});
