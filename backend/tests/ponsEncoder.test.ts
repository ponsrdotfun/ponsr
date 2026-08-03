import { ethers } from 'ethers';
import { buildLaunchCalldata, extractLaunchedTokenAddress, PONS_FACTORY_ABI_FRAGMENT } from '../src/ponsEncoder';

describe('buildLaunchCalldata', () => {
  it('encodes calldata that decodes back to the exact input parameters', () => {
    const params = {
      tokenName: 'Moon Coin',
      tokenSymbol: 'MOON',
      metadataURI: 'ipfs://xyz',
      creatorWallet: '0x1111111111111111111111111111111111111111'.slice(0, 42),
      feeWallet: '0x2222222222222222222222222222222222222222'.slice(0, 42),
    };
    const fee = 500_000_000_000_000n;
    const { data, value } = buildLaunchCalldata(params, fee);

    expect(value).toBe(fee);

    const iface = new ethers.Interface(PONS_FACTORY_ABI_FRAGMENT);
    const decoded = iface.decodeFunctionData('launchToken', data);
    expect(decoded[0]).toBe(params.tokenName);
    expect(decoded[1]).toBe(params.tokenSymbol);
    expect(decoded[2]).toBe(params.metadataURI);
    expect(decoded[3].toLowerCase()).toBe(params.creatorWallet.toLowerCase());
    expect(decoded[4].toLowerCase()).toBe(params.feeWallet.toLowerCase());
  });

  it('CRITICAL: always encodes devBuyAmount as exactly 0, regardless of input', () => {
    const params = {
      tokenName: 'X',
      tokenSymbol: 'X',
      metadataURI: '',
      creatorWallet: ethers.ZeroAddress,
      feeWallet: ethers.ZeroAddress,
    };
    const { data } = buildLaunchCalldata(params, 500_000_000_000_000n);

    const iface = new ethers.Interface(PONS_FACTORY_ABI_FRAGMENT);
    const decoded = iface.decodeFunctionData('launchToken', data);
    // devBuyAmount is the 6th parameter (index 5) in the placeholder ABI.
    expect(decoded[5]).toBe(0n);
  });

  it('passes the live fee through as the transaction value unchanged', () => {
    const params = {
      tokenName: 'X', tokenSymbol: 'X', metadataURI: '', creatorWallet: ethers.ZeroAddress, feeWallet: ethers.ZeroAddress,
    };
    const customFee = 777_000_000_000_000n;
    const { value } = buildLaunchCalldata(params, customFee);
    expect(value).toBe(customFee);
  });
});

describe('extractLaunchedTokenAddress', () => {
  it('correctly decodes the token address from a matching TokenLaunched event log', () => {
    const iface = new ethers.Interface(PONS_FACTORY_ABI_FRAGMENT);
    const tokenAddr = '0x3333333333333333333333333333333333333333'.slice(0, 42);
    const poolAddr = '0x4444444444444444444444444444444444444444'.slice(0, 42);
    const creatorAddr = '0x5555555555555555555555555555555555555555'.slice(0, 42);

    const fakeLog = iface.encodeEventLog('TokenLaunched', [tokenAddr, poolAddr, creatorAddr, 'Moon Coin', 'MOON']);

    const result = extractLaunchedTokenAddress([
      { topics: fakeLog.topics, data: fakeLog.data } as any,
    ]);
    expect(result?.toLowerCase()).toBe(tokenAddr.toLowerCase());
  });

  it('returns null when no matching event is present in the logs', () => {
    const result = extractLaunchedTokenAddress([]);
    expect(result).toBeNull();
  });

  it('skips unrelated logs that fail to decode against this ABI, without throwing', () => {
    const garbageLog = { topics: ['0xdeadbeef'], data: '0x1234' } as any;
    expect(() => extractLaunchedTokenAddress([garbageLog])).not.toThrow();
    expect(extractLaunchedTokenAddress([garbageLog])).toBeNull();
  });
});
