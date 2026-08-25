import { resolveCanaryPair, CanaryPairDeps } from '../src/canaryPreflight';
import { NATIVE_ETH, isNativeEth, PairAsset, PairResolution } from '../src/pairTokens';
import { executableDeployment } from '../src/deployments';

/**
 * One asset, one verdict.
 *
 * The canary asked "what am I pairing against?" by two routes and got two answers. With
 * `PAIR_WITH` unset it returned native ETH and never consulted the approval map. With
 * `PAIR_WITH=ETH` it resolved to the same zero address and then read
 * `approvedPairTokens(0x0)` -- false, as it has always been, because the factory's gate
 * short-circuits on the zero address -- and refused with:
 *
 *   ETH (0x0000…0000) is no longer approved … so pons has revoked it since.
 *
 * Nothing had been revoked. This was measured on mainnet during the authorised keyless dry
 * run of 2026-08-25, which exited 1 having spent nothing, and it is the reason the exemption
 * is now bound to the resolved ADDRESS rather than to a label or a call order.
 */

const DEPLOYMENT = executableDeployment();

const ETH_ASSET: PairAsset = {
  address: NATIVE_ETH,
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
  graduationThreshold: null,
};

const AAPL: PairAsset = {
  address: '0x1111111111111111111111111111111111111111',
  symbol: 'AAPL',
  name: 'Apple',
  decimals: 18,
  graduationThreshold: 4_200_000_000_000_000_000n,
};

interface Spy extends CanaryPairDeps {
  approvalCalls: string[];
  resolveCalls: string[];
}

function deps(over: {
  supportsPairing?: boolean;
  resolve?: (typed: string) => Promise<PairResolution>;
  isApprovedNow?: (a: string) => Promise<boolean>;
} = {}): Spy {
  const spy: Spy = {
    approvalCalls: [],
    resolveCalls: [],
    deployment: DEPLOYMENT,
    supportsPairing: over.supportsPairing ?? true,
    resolve: async (typed: string) => {
      spy.resolveCalls.push(typed);
      return over.resolve
        ? over.resolve(typed)
        : ({ ok: true, asset: ETH_ASSET } as unknown as PairResolution);
    },
    isApprovedNow: async (a: string) => {
      spy.approvalCalls.push(a);
      return over.isApprovedNow ? over.isApprovedNow(a) : true;
    },
  };
  return spy;
}

describe('explicit native ETH is the same launch as default native ETH', () => {
  /**
   * The exact shape that failed on mainnet: a resolver that correctly returns native ETH, and
   * a factory that correctly answers false for the zero address.
   */
  it('accepts explicit ETH and never reads the approval map', async () => {
    const d = deps({ isApprovedNow: async () => false });
    const out = await resolveCanaryPair('ETH', d);

    expect(out.asset.address).toBe(NATIVE_ETH);
    expect(out.source).toBe('explicit-eth');
    // The whole finding, in one assertion: the approval map is not consulted for ETH.
    expect(d.approvalCalls).toEqual([]);
  });

  it('produces the same asset as the default path', async () => {
    const explicit = await resolveCanaryPair('ETH', deps());
    const fallback = await resolveCanaryPair(undefined, deps());

    expect(explicit.asset).toEqual(fallback.asset);
    expect(explicit.asset.address).toBe(fallback.asset.address);
    expect(explicit.asset.decimals).toBe(fallback.asset.decimals);
    expect(explicit.asset.symbol).toBe(fallback.asset.symbol);
  });

  /** Same launch, but the evidence still says which one the operator chose. */
  it('distinguishes an explicit choice from a default in the source', async () => {
    expect((await resolveCanaryPair('ETH', deps())).source).toBe('explicit-eth');
    expect((await resolveCanaryPair(undefined, deps())).source).toBe('default-eth');
    // Neither claims a registry approval that was never consulted.
    expect((await resolveCanaryPair('ETH', deps())).source).not.toBe('registry');
  });

  /**
   * Bound to the address, not the spelling. A resolver that maps some alias onto native ETH
   * gets the same exemption, and a label alone can never earn one.
   */
  it('exempts by resolved address whatever the operator typed', async () => {
    const d = deps({
      resolve: async () => ({ ok: true, asset: ETH_ASSET } as unknown as PairResolution),
      isApprovedNow: async () => false,
    });
    const out = await resolveCanaryPair('native', d);
    expect(out.source).toBe('explicit-eth');
    expect(d.approvalCalls).toEqual([]);
  });

  it('compares the address case-insensitively', async () => {
    const upper = { ...ETH_ASSET, address: '0x' + '0'.repeat(40).toUpperCase() };
    const d = deps({
      resolve: async () => ({ ok: true, asset: upper } as unknown as PairResolution),
      isApprovedNow: async () => false,
    });
    expect((await resolveCanaryPair('ETH', d)).source).toBe('explicit-eth');
    expect(d.approvalCalls).toEqual([]);
    expect(isNativeEth(upper.address)).toBe(true);
  });

  /**
   * A target that prices every launch in ETH cannot honour an arbitrary pair -- but "pair with
   * ETH" is exactly what it already does, so refusing it would refuse the thing it is about
   * to do anyway.
   */
  it('accepts explicit ETH on a target that cannot select an arbitrary pair', async () => {
    const d = deps({ supportsPairing: false, isApprovedNow: async () => false });
    const out = await resolveCanaryPair('ETH', d);
    expect(out.asset.address).toBe(NATIVE_ETH);
    expect(out.source).toBe('explicit-eth');
    expect(d.approvalCalls).toEqual([]);
  });
});

describe('nothing is weakened for any non-native asset', () => {
  const asAapl = { resolve: async () => ({ ok: true, asset: AAPL } as unknown as PairResolution) };

  it('reads the live approval exactly once', async () => {
    const d = deps({ ...asAapl, isApprovedNow: async () => true });
    const out = await resolveCanaryPair('AAPL', d);
    expect(out.source).toBe('registry');
    expect(d.approvalCalls).toEqual([AAPL.address]);
  });

  it('still refuses an asset revoked since the scan', async () => {
    const d = deps({ ...asAapl, isApprovedNow: async () => false });
    await expect(resolveCanaryPair('AAPL', d)).rejects.toThrow(/no longer approved/);
  });

  it('still refuses when the live approval cannot be read', async () => {
    const d = deps({
      ...asAapl,
      isApprovedNow: async () => {
        throw new Error('RPC down');
      },
    });
    await expect(resolveCanaryPair('AAPL', d)).rejects.toThrow(/could not read the live approval/);
  });

  it('still refuses an asset the registry does not recognise', async () => {
    const d = deps({
      resolve: async () => ({ ok: false, detail: 'unknown symbol' } as unknown as PairResolution),
    });
    await expect(resolveCanaryPair('NOTREAL', d)).rejects.toThrow(/is not an approved pairing asset/);
    expect(d.approvalCalls).toEqual([]);
  });

  it('still refuses a non-native pair on a target that cannot pair', async () => {
    const d = deps({ ...asAapl, supportsPairing: false });
    await expect(resolveCanaryPair('AAPL', d)).rejects.toThrow(/takes its pairing from the launch config/);
    expect(d.approvalCalls).toEqual([]);
  });

  /** A resolver that throws is not an approval either. */
  it('refuses when the resolver itself fails', async () => {
    const d = deps({
      resolve: async () => {
        throw new Error('registry unreachable');
      },
    });
    await expect(resolveCanaryPair('AAPL', d)).rejects.toThrow(/could not be resolved/);
    expect(d.approvalCalls).toEqual([]);
  });
});

describe('outgoing parity: both routes encode the zero address', () => {
  /**
   * The launch is priced in whatever `pairToken` says. If the explicit route returned anything
   * other than the zero address -- a placeholder, a wrapped-ETH ERC20 -- it would be a
   * different launch wearing the same name.
   */
  it('carries NATIVE_ETH as the outgoing pairToken on both routes', async () => {
    for (const requested of [undefined, 'ETH']) {
      const out = await resolveCanaryPair(requested, deps());
      expect(out.asset.address).toBe(NATIVE_ETH);
      expect(isNativeEth(out.asset.address)).toBe(true);
      expect(out.asset.address).not.toMatch(/^0x0{39}[1-9a-f]/i);
    }
  });

  it('never substitutes an ERC20 address for native ETH', async () => {
    const out = await resolveCanaryPair('ETH', deps());
    expect(out.asset.address).not.toBe(AAPL.address);
    expect(out.asset.decimals).toBe(18);
  });
});
