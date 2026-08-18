import { ethers } from 'ethers';
import {
  PONS_V2_FACTORY_ABI,
  ZERO_ECONOMICS,
  buildV2LaunchCalldata,
  extractV2LaunchDetails,
  isNativePair,
  V2LaunchParams,
} from '../src/ponsV2Encoder';
import { EMPTY_SOCIALS } from '../src/ponsEncoder';
import { NATIVE_ETH } from '../src/pairTokens';

/**
 * v2's launchToken is a different function from v1's, not v1 with an argument added:
 * dexId and salt are gone, feeWallet became creatorFeeRecipient, and three fields
 * appeared. Encoding the wrong one produces a reverted transaction that has already
 * spent gas, so these decode the calldata back rather than trusting it looks right.
 */

const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const CREATOR = '0x1111111111111111111111111111111111111111';
const FEE = 500_000_000_000_000n;
const ECON = '0x' + 'ab'.repeat(32);

function params(over: Partial<V2LaunchParams> = {}): V2LaunchParams {
  return {
    tokenName: 'Diamond Paws',
    tokenSymbol: 'PAWS',
    logo: '',
    description: '',
    socials: EMPTY_SOCIALS,
    feeWallet: CREATOR,
    launchConfigId: 0n,
    pairToken: AAPL,
    creatorTaxBps: 0,
    buybackEnabled: false,
    expectedEconomics: ECON,
    ...over,
  };
}

function decode(data: string) {
  const iface = new ethers.Interface(PONS_V2_FACTORY_ABI);
  const d = iface.decodeFunctionData('launchToken', data);
  return { params: d[0], launchConfigId: d[1], pairToken: d[2] };
}

describe('buildV2LaunchCalldata', () => {
  it('encodes a stock-paired launch that decodes back to what was asked for', () => {
    const { data, value } = buildV2LaunchCalldata(params(), FEE);
    const d = decode(data);
    expect(d.params.name).toBe('Diamond Paws');
    expect(d.params.symbol).toBe('PAWS');
    expect(d.pairToken).toBe(AAPL);
    expect(d.launchConfigId).toBe(0n);
    expect(value).toBe(FEE);
  });

  // The fee is ETH whatever the launch trades in. A stock pairing changes what the
  // proceeds arrive as, not what the fee is paid in.
  it('pays the fee in ETH even for a stock-paired launch', () => {
    expect(buildV2LaunchCalldata(params({ pairToken: AAPL }), FEE).value).toBe(FEE);
    expect(buildV2LaunchCalldata(params({ pairToken: NATIVE_ETH }), FEE).value).toBe(FEE);
  });

  // Anything above the fee is treated by the factory as an initial buy. The treasury
  // must never buy into a token it launched for somebody else.
  it('sends exactly the fee and nothing more', () => {
    const { value } = buildV2LaunchCalldata(params(), FEE);
    expect(value).toBe(FEE);
    expect(value).not.toBeGreaterThan(FEE);
  });

  // The creator's wallet moved field. Encoding it into the old position would pay
  // the wrong address forever.
  it('routes the creator share to the resolved wallet, in v2’s field', () => {
    const d = decode(buildV2LaunchCalldata(params(), FEE).data);
    expect(d.params.creatorFeeRecipient).toBe(CREATOR);
  });

  // A creator tax is a charge on every trade of somebody else's token, set by us,
  // on a launch they asked for in a tweet and cannot renegotiate.
  it('takes no creator tax', () => {
    const d = decode(buildV2LaunchCalldata(params(), FEE).data);
    expect(d.params.creatorTaxBps).toBe(0n);
  });

  it('carries the economics pin through unchanged', () => {
    const d = decode(buildV2LaunchCalldata(params(), FEE).data);
    expect(d.params.expectedEconomics).toBe(ECON);
  });

  // bytes32(0) tells the factory to accept whatever terms are current when the
  // transaction lands. It is encodable, because it is the factory's own default --
  // but it has a name so that choosing it is never accidental.
  it('allows the unpinned digest explicitly', () => {
    const d = decode(buildV2LaunchCalldata(params({ expectedEconomics: ZERO_ECONOMICS }), FEE).data);
    expect(d.params.expectedEconomics).toBe(ZERO_ECONOMICS);
  });

  it('refuses a pairToken that is not an address', () => {
    expect(() => buildV2LaunchCalldata(params({ pairToken: 'AAPL' }), FEE)).toThrow(/not an address/);
  });

  it('refuses an economics pin that is not a bytes32', () => {
    expect(() => buildV2LaunchCalldata(params({ expectedEconomics: '0xdead' }), FEE)).toThrow(/bytes32/);
  });

  it('refuses a creator tax outside the encodable range', () => {
    expect(() => buildV2LaunchCalldata(params({ creatorTaxBps: -1 }), FEE)).toThrow(/out of range/);
    expect(() => buildV2LaunchCalldata(params({ creatorTaxBps: 10_001 }), FEE)).toThrow(/out of range/);
    expect(() => buildV2LaunchCalldata(params({ creatorTaxBps: 1.5 }), FEE)).toThrow(/out of range/);
  });
});

describe('extractV2LaunchDetails', () => {
  const iface = new ethers.Interface(PONS_V2_FACTORY_ABI);

  function launchedLog(token: string, pairToken: string, threshold: bigint) {
    return iface.encodeEventLog('TokenLaunched', [
      token,
      '0x2222222222222222222222222222222222222222', // curve
      '0x3333333333333333333333333333333333333333', // deployer
      pairToken,
      0n,
      threshold,
    ]);
  }

  it('reads the launch back out of the receipt’s own logs', () => {
    const token = '0x4444444444444444444444444444444444444444';
    const log = launchedLog(token, AAPL, 242n * 10n ** 17n);
    const got = extractV2LaunchDetails([{ topics: log.topics, data: log.data } as any]);
    expect(got).toMatchObject({ token, pairToken: AAPL, graduationThreshold: 242n * 10n ** 17n });
  });

  // The pairing is permanent from this moment, so it is confirmed from the chain
  // rather than assumed from what was requested.
  it('reports the pairing the chain recorded, not the one requested', () => {
    const log = launchedLog('0x4444444444444444444444444444444444444444', NATIVE_ETH, 42n);
    expect(extractV2LaunchDetails([{ topics: log.topics, data: log.data } as any])!.pairToken).toBe(NATIVE_ETH);
  });

  // A receipt carries logs from every contract the call touched, including ones
  // whose topics happen to decode against an unrelated ABI.
  it('ignores logs that are not ours', () => {
    expect(extractV2LaunchDetails([{ topics: ['0x' + '11'.repeat(32)], data: '0x' } as any])).toBeNull();
    expect(extractV2LaunchDetails([])).toBeNull();
  });
});

describe('isNativePair', () => {
  it('recognises native ETH regardless of case', () => {
    expect(isNativePair(NATIVE_ETH)).toBe(true);
    expect(isNativePair('0x0000000000000000000000000000000000000000')).toBe(true);
    expect(isNativePair(AAPL)).toBe(false);
    expect(isNativePair(AAPL.toLowerCase())).toBe(false);
  });
});
