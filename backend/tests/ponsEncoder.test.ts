import { ethers } from 'ethers';
import {
  EMPTY_SOCIALS,
  LaunchParams,
  PONS_FACTORY_ABI,
  buildLaunchCalldata,
  extractLaunchDetails,
  extractLaunchedTokenAddress,
  saltForTweet,
} from '../src/ponsEncoder';

/**
 * Written against the REAL verified factory ABI (`src/abi/ponsLaunchFactory.json`,
 * pulled from robinhoodchain.blockscout.com on 2026-08-04).
 *
 * The previous version of this file tested the encoder against a placeholder interface
 * that turned out to be wrong in every parameter. Those tests all passed -- they proved
 * the encoder was self-consistent, and nothing whatsoever about whether pons would
 * accept the call. That is the difference these tests exist to close.
 */

const SPLITTER = ethers.getAddress('0x' + ethers.keccak256(ethers.toUtf8Bytes('splitter')).slice(-40));
const LIVE_FEE = 500_000_000_000_000n; // 0.0005 ETH, read live from launchFee() on 2026-08-04

const iface = new ethers.Interface(PONS_FACTORY_ABI);

function params(overrides: Partial<LaunchParams> = {}): LaunchParams {
  return {
    tokenName: 'Moon Coin',
    tokenSymbol: 'MOON',
    logo: '',
    description: 'a fun community token',
    socials: EMPTY_SOCIALS,
    feeWallet: SPLITTER,
    launchConfigId: 0n,
    dexId: 0n,
    salt: saltForTweet('tweet_1'),
    ...overrides,
  };
}

describe('buildLaunchCalldata -- against the real factory ABI', () => {
  it('encodes calldata the real launchToken selector accepts', () => {
    const { data } = buildLaunchCalldata(params(), LIVE_FEE);
    expect(data.slice(0, 10)).toBe(iface.getFunction('launchToken')!.selector);
    // Round-trips through the real ABI: a wrong struct shape throws here.
    expect(() => iface.decodeFunctionData('launchToken', data)).not.toThrow();
  });

  it('puts name, symbol and description inside the TokenParams struct', () => {
    const d = iface.decodeFunctionData('launchToken', buildLaunchCalldata(params(), LIVE_FEE).data);
    expect(d[0].name).toBe('Moon Coin');
    expect(d[0].symbol).toBe('MOON');
    expect(d[0].description).toBe('a fun community token');
  });

  it('CRITICAL: routes fees to the splitter, and there is only one wallet field to route', () => {
    // The real ABI has a single `feeWallet` -- no separate creator wallet, and no other
    // address anywhere in the call. There is structurally nowhere for a second,
    // attacker-supplied destination to hide.
    const d = iface.decodeFunctionData('launchToken', buildLaunchCalldata(params(), LIVE_FEE).data);
    expect(d[0].feeWallet).toBe(SPLITTER);

    const struct = d[0].toObject();
    const addressFields = Object.keys(struct).filter(
      (k) => typeof struct[k] === 'string' && /^0x[0-9a-fA-F]{40}$/.test(struct[k])
    );
    expect(addressFields).toEqual(['feeWallet']);
  });

  it('CRITICAL: sends exactly the launch fee, so the factory performs no dev buy', () => {
    // The factory treats msg.value above launchFee as an initial buy. Sending exactly the
    // fee is the whole control here: the old encoder had a `devBuyAmount = 0` constant,
    // and the real ABI has no such field at all.
    expect(buildLaunchCalldata(params(), LIVE_FEE).value).toBe(LIVE_FEE);
  });

  it('passes the launch config and dex ids through as separate arguments', () => {
    const d = iface.decodeFunctionData(
      'launchToken',
      buildLaunchCalldata(params({ launchConfigId: 3n, dexId: 2n }), LIVE_FEE).data
    );
    expect(d[1]).toBe(3n);
    expect(d[2]).toBe(2n);
  });

  it('encodes empty socials without tripping the struct encoder', () => {
    const d = iface.decodeFunctionData('launchToken', buildLaunchCalldata(params(), LIVE_FEE).data);
    expect(d[0].socials.twitter).toBe('');
    expect(d[0].socials.farcaster).toBe('');
  });

  it('passes the live fee through unchanged rather than assuming a constant', () => {
    expect(buildLaunchCalldata(params(), 777_000_000_000_000n).value).toBe(777_000_000_000_000n);
  });
});

describe('saltForTweet', () => {
  it('is deterministic for the same tweet', () => {
    expect(saltForTweet('tweet_1')).toBe(saltForTweet('tweet_1'));
  });

  it('differs between tweets, so two launches never collide', () => {
    expect(saltForTweet('tweet_1')).not.toBe(saltForTweet('tweet_2'));
  });

  it('produces a bytes32 value', () => {
    expect(saltForTweet('tweet_1')).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('CRITICAL: a retry of one tweet reuses the salt rather than deploying a second token', () => {
    // The salt feeds CREATE2, so the same tweet predicts the same token address. A retry
    // therefore hits the factory's PoolAlreadyExists guard instead of silently creating a
    // duplicate token for a single request -- a random salt would duplicate instead.
    const a = buildLaunchCalldata(params({ salt: saltForTweet('t9') }), LIVE_FEE);
    const b = buildLaunchCalldata(params({ salt: saltForTweet('t9') }), LIVE_FEE);
    expect(a.data).toBe(b.data);
  });
});

describe('reading the launch result out of receipt logs', () => {
  const token = ethers.getAddress('0x' + '11'.repeat(20));
  const pool = ethers.getAddress('0x' + '22'.repeat(20));
  const pairToken = ethers.getAddress('0x' + '33'.repeat(20));

  const launchedLog = () =>
    iface.encodeEventLog('TokenLaunched', [
      token,
      ethers.getAddress('0x' + '44'.repeat(20)), // deployer
      ethers.getAddress('0x' + '55'.repeat(20)), // dexFactory
      pairToken,
      pool,
      0n, // dexId
      0n, // launchConfigId
      99n, // positionId
      0n, // restrictionsEndBlock
      0n, // initialBuyAmount
    ]);

  it('reads the token address out of the real TokenLaunched event', () => {
    const log = launchedLog();
    expect(extractLaunchedTokenAddress([{ topics: log.topics, data: log.data } as any])).toBe(token);
  });

  it('returns null when no TokenLaunched event is present', () => {
    expect(extractLaunchedTokenAddress([])).toBeNull();
  });

  it('skips unrelated logs without throwing', () => {
    const junk = { topics: ['0xdeadbeef'], data: '0x1234' } as any;
    expect(() => extractLaunchedTokenAddress([junk])).not.toThrow();
    expect(extractLaunchedTokenAddress([junk])).toBeNull();
  });

  it('still finds the event when unrelated logs come first', () => {
    const junk = { topics: [ethers.id('SomethingElse(address)')], data: '0x' } as any;
    const log = launchedLog();
    expect(extractLaunchedTokenAddress([junk, { topics: log.topics, data: log.data } as any])).toBe(token);
  });

  it('exposes the pool, pair token and LP position id -- fees accrue to that position', () => {
    const log = launchedLog();
    const details = extractLaunchDetails([{ topics: log.topics, data: log.data } as any]);
    expect(details).not.toBeNull();
    expect(details!.pool).toBe(pool);
    expect(details!.pairToken).toBe(pairToken);
    expect(details!.positionId).toBe(99n);
  });

  it('reports a zero initial buy, which is what sending exactly the fee produces', () => {
    const log = launchedLog();
    expect(extractLaunchDetails([{ topics: log.topics, data: log.data } as any])!.initialBuyAmount).toBe(0n);
  });
});
