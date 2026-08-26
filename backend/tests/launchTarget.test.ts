import { ethers } from 'ethers';
import { LaunchRequest, createLaunchTarget } from '../src/launchTarget';
import { PONS_V2_FACTORY_ABI } from '../src/ponsV2Encoder';
import { PONS_FACTORY_ABI, extractLaunchedTokenAddress } from '../src/ponsEncoder';
import { NATIVE_ETH, PairAsset } from '../src/pairTokens';
import { executableDeployment, deploymentById } from '../src/deployments';
import { PONS_V2_CURRENT_ABI } from '../src/ponsV2CurrentEncoder';

/**
 * This is the seam between "which factory" and everything else, and it sits on the
 * path that spends money. The failure it exists to prevent is quiet: encoding a v1
 * call against a v2 factory does not raise a helpful error, it reverts a transaction
 * that has already paid gas.
 */

const FEE = 500_000_000_000_000n;
const SPLITTER = '0x1111111111111111111111111111111111111111';

const ETH_ASSET: PairAsset = { address: NATIVE_ETH, symbol: 'ETH', name: 'Ether', decimals: 18, graduationThreshold: null };
const AAPL_ASSET: PairAsset = {
  address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  symbol: 'AAPL',
  name: 'Apple • Robinhood Token',
  decimals: 18,
  graduationThreshold: 242n * 10n ** 17n,
};

function req(over: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    tokenName: 'Diamond Paws',
    tokenSymbol: 'PAWS',
    description: null,
    splitterAddress: SPLITTER,
    tweetId: 'tweet_1',
    pairAsset: ETH_ASSET,
    ...over,
  };
}

const ECON = '0x' + 'ab'.repeat(32);
const fakeProvider = {} as ethers.Provider;

/** Stands in for the v2 factory's previewLaunchEconomics without a node. */
function stubPreview(value: string | (() => never) = ECON, escrow?: string) {
  jest.spyOn(ethers, 'Contract').mockImplementation(
    () =>
      ({
        previewLaunchEconomics: async () => (typeof value === 'function' ? value() : value),
        // The current target reads this before building and refuses on a mismatch.
        // Defaulting to the registry's value keeps these tests about encoding; the
        // mismatch itself is covered in escrowBinding.test.ts and below.
        feeEscrow: async () => escrow ?? executableDeployment().feeEscrow,
      }) as any
  );
}

describe('createLaunchTarget', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /*
   * The `v1` block that stood here was RETARGETED, not deleted, on 2026-08-26.
   *
   * Its four cases asserted properties of a launch target that no longer exists: v1
   * calldata decoding, the refusal to pair against a stock, `supportsPairing === false`,
   * and the tweet-derived salt. The first and the last are still real guarantees about
   * reading history back, and they live in `v1HistoricalReader.test.ts` now, asked of the
   * encoder and the registry directly. The middle two described how V1Target behaved when
   * chosen, and nothing can choose it.
   *
   * `v1NonExecutable.test.ts` holds the replacement for what this block was really for:
   * proof that no environment value produces a launch aimed at v1.
   */
  // Every property below is a real safety guarantee; what changed is which deployment it
  // must hold for. The superseded V2 is not reachable from createLaunchTarget, and a test
  // asserting its address would be asserting that the bot still aims at a replaced factory.
  describe('current v2', () => {
    it('builds a stock-paired call that decodes against the current ABI', async () => {
      stubPreview();
      const t = createLaunchTarget(fakeProvider);
      const built = await t.build(req({ pairAsset: AAPL_ASSET }), FEE);
      expect(t.version).toBe('v2-current');
      expect(built.to).toBe(executableDeployment().factory);
      expect(built.data.slice(0, 10)).toBe('0xf35abbcf');
      const d = new ethers.Interface(PONS_V2_CURRENT_ABI).decodeFunctionData(
        executableDeployment().launchSignature,
        built.data
      );
      expect(d[2]).toBe(AAPL_ASSET.address);
      expect(d[0].creatorFeeRecipient).toBe(SPLITTER);
      expect(d[0].creatorTaxBps).toBe(0n);
      expect(d[0].salt).toMatch(/^0x[0-9a-f]{64}$/);
    });

    // The migration's central failure: a splitter bound to an escrow the live factory
    // does not use holds creator fees nothing can ever claim.
    it('refuses to build when the factory reports a different escrow', async () => {
      stubPreview(ECON, deploymentById('pons-v2-legacy-7e1').feeEscrow);
      await expect(createLaunchTarget(fakeProvider).build(req({ pairAsset: AAPL_ASSET }), FEE))
        .rejects.toThrow(/escrow/i);
    });

    // Same request, same address prediction -- which is what makes a retry collide
    // rather than mint a second token.
    it('derives a deterministic salt from the request', async () => {
      stubPreview();
      const t = createLaunchTarget(fakeProvider);
      const a = await t.build(req({ tweetId: 't1', pairAsset: AAPL_ASSET }), FEE);
      const b = await t.build(req({ tweetId: 't1', pairAsset: AAPL_ASSET }), FEE);
      const c = await t.build(req({ tweetId: 't2', pairAsset: AAPL_ASSET }), FEE);
      expect(a.data).toBe(b.data);
      expect(a.data).not.toBe(c.data);
    });

    it('still pays the fee in ETH when the launch trades in stock', async () => {
      stubPreview();
      const built = await createLaunchTarget(fakeProvider).build(req({ pairAsset: AAPL_ASSET }), FEE);
      expect(built.value).toBe(FEE);
    });

    it('launches against ETH when nothing else was asked for', async () => {
      stubPreview();
      const built = await createLaunchTarget(fakeProvider).build(req(), FEE);
      const d = new ethers.Interface(PONS_V2_CURRENT_ABI).decodeFunctionData(
        executableDeployment().launchSignature,
        built.data
      );
      expect(d[2]).toBe(NATIVE_ETH);
    });

    // The digest pins the terms to what was quoted. Read live and never cached: a
    // stale pin does not protect the launch, it reverts it.
    it('pins the economics digest read at build time', async () => {
      stubPreview();
      const built = await createLaunchTarget(fakeProvider).build(req({ pairAsset: AAPL_ASSET }), FEE);
      const d = new ethers.Interface(PONS_V2_CURRENT_ABI).decodeFunctionData(
        executableDeployment().launchSignature,
        built.data
      );
      expect(d[0].expectedEconomics).toBe(ECON);
    });

    // A launch that does not happen beats one priced on terms nobody saw.
    it('fails the build when the digest cannot be read', async () => {
      stubPreview(() => { throw new Error('reverted'); });
      await expect(createLaunchTarget(fakeProvider).build(req({ pairAsset: AAPL_ASSET }), FEE)).rejects.toThrow('reverted');
    });

    it('reports that it can pair', () => {
      expect(createLaunchTarget(fakeProvider).supportsPairing).toBe(true);
    });
  });

  describe('reading the launch back', () => {
    it('the current decoder and the v1 decoder read different event shapes', () => {
      const token = '0x4444444444444444444444444444444444444444';

      const v2Log = new ethers.Interface(PONS_V2_FACTORY_ABI).encodeEventLog('TokenLaunched', [
        token, '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333',
        AAPL_ASSET.address, 0n, 1n,
      ]);
      expect(createLaunchTarget(fakeProvider).extractToken([{ topics: v2Log.topics, data: v2Log.data } as any])).toBe(token);

      // The decoders are genuinely different, asserted against the v1 reader directly.
      // This used to flip `PONS_FACTORY_VERSION` between the two calls, which measured the
      // setting rather than the decoders; the setting is gone and the property is not.
      expect(extractLaunchedTokenAddress([{ topics: v2Log.topics, data: v2Log.data } as any])).toBeNull();
    });
  });
});
