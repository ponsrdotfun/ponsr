import { ethers } from 'ethers';
import { LaunchRequest, createLaunchTarget } from '../src/launchTarget';
import { PONS_V2_FACTORY_ABI } from '../src/ponsV2Encoder';
import { PONS_FACTORY_ABI } from '../src/ponsEncoder';
import { NATIVE_ETH, PairAsset } from '../src/pairTokens';
import { config } from '../src/config';

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
function stubPreview(value: string | (() => never) = ECON) {
  jest.spyOn(ethers, 'Contract').mockImplementation(
    () => ({ previewLaunchEconomics: async () => (typeof value === 'function' ? value() : value) }) as any
  );
}

describe('createLaunchTarget', () => {
  const realVersion = config.PONS_FACTORY_VERSION;
  afterEach(() => {
    (config as any).PONS_FACTORY_VERSION = realVersion;
    jest.restoreAllMocks();
  });

  describe('v1', () => {
    beforeEach(() => { (config as any).PONS_FACTORY_VERSION = 'v1'; });

    it('builds a v1 call that decodes against the v1 ABI', async () => {
      const t = createLaunchTarget(fakeProvider);
      const built = await t.build(req(), FEE);
      expect(t.version).toBe('v1');
      expect(built.to).toBe(config.PONS_FACTORY_ADDRESS);
      expect(built.value).toBe(FEE);
      const d = new ethers.Interface(PONS_FACTORY_ABI).decodeFunctionData('launchToken', built.data);
      expect(d[0].symbol).toBe('PAWS');
      expect(d[0].feeWallet).toBe(SPLITTER);
    });

    // v1's pairing comes from the launch config, not a parameter. Accepting a request
    // for AAPL and launching against WETH anyway would be a permanent pairing nobody
    // asked for -- so it refuses rather than silently doing something else.
    it('refuses a pairing it cannot honour instead of ignoring it', async () => {
      const t = createLaunchTarget(fakeProvider);
      await expect(t.build(req({ pairAsset: AAPL_ASSET }), FEE)).rejects.toThrow(/cannot pair against AAPL/);
    });

    it('reports that it cannot pair', () => {
      expect(createLaunchTarget(fakeProvider).supportsPairing).toBe(false);
    });

    // The salt is derived from the tweet, so a retry predicts the same address and
    // reverts rather than launching a second token for one request.
    it('derives its salt from the tweet, so two builds of one tweet match', async () => {
      const t = createLaunchTarget(fakeProvider);
      const a = await t.build(req({ tweetId: 't1' }), FEE);
      const b = await t.build(req({ tweetId: 't1' }), FEE);
      const c = await t.build(req({ tweetId: 't2' }), FEE);
      expect(a.data).toBe(b.data);
      expect(a.data).not.toBe(c.data);
    });
  });

  describe('v2', () => {
    beforeEach(() => { (config as any).PONS_FACTORY_VERSION = 'v2'; });

    it('builds a stock-paired call that decodes against the v2 ABI', async () => {
      stubPreview();
      const t = createLaunchTarget(fakeProvider);
      const built = await t.build(req({ pairAsset: AAPL_ASSET }), FEE);
      expect(t.version).toBe('v2');
      expect(built.to).toBe(config.PONS_V2_FACTORY_ADDRESS);
      const d = new ethers.Interface(PONS_V2_FACTORY_ABI).decodeFunctionData('launchToken', built.data);
      expect(d[2]).toBe(AAPL_ASSET.address);
      expect(d[0].creatorFeeRecipient).toBe(SPLITTER);
      expect(d[0].creatorTaxBps).toBe(0n);
    });

    it('still pays the fee in ETH when the launch trades in stock', async () => {
      stubPreview();
      const built = await createLaunchTarget(fakeProvider).build(req({ pairAsset: AAPL_ASSET }), FEE);
      expect(built.value).toBe(FEE);
    });

    it('launches against ETH when nothing else was asked for', async () => {
      stubPreview();
      const built = await createLaunchTarget(fakeProvider).build(req(), FEE);
      const d = new ethers.Interface(PONS_V2_FACTORY_ABI).decodeFunctionData('launchToken', built.data);
      expect(d[2]).toBe(NATIVE_ETH);
    });

    // The digest pins the terms to what was quoted. Read live and never cached: a
    // stale pin does not protect the launch, it reverts it.
    it('pins the economics digest read at build time', async () => {
      stubPreview();
      const built = await createLaunchTarget(fakeProvider).build(req({ pairAsset: AAPL_ASSET }), FEE);
      const d = new ethers.Interface(PONS_V2_FACTORY_ABI).decodeFunctionData('launchToken', built.data);
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
    it('each version reads its own event shape', () => {
      const token = '0x4444444444444444444444444444444444444444';

      (config as any).PONS_FACTORY_VERSION = 'v2';
      const v2Log = new ethers.Interface(PONS_V2_FACTORY_ABI).encodeEventLog('TokenLaunched', [
        token, '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333',
        AAPL_ASSET.address, 0n, 1n,
      ]);
      expect(createLaunchTarget(fakeProvider).extractToken([{ topics: v2Log.topics, data: v2Log.data } as any])).toBe(token);

      (config as any).PONS_FACTORY_VERSION = 'v1';
      expect(createLaunchTarget(fakeProvider).extractToken([{ topics: v2Log.topics, data: v2Log.data } as any])).toBeNull();
    });
  });
});
