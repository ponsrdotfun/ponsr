import { ethers } from 'ethers';
import {
  PONS_V2_CURRENT_ABI,
  buildCurrentV2LaunchCalldata,
  launchSalt,
  CurrentV2LaunchParams,
} from '../src/ponsV2CurrentEncoder';
import { EMPTY_SOCIALS } from '../src/ponsEncoder';
import { executableDeployment } from '../src/deployments';

/**
 * The current factory takes different calldata from the one Ponsr was built against.
 * `TokenParams` gained a `salt`, which moves the selector from 0xa41d5f2b to
 * 0xf35abbcf -- so the old encoder aimed at the new address does not fail politely,
 * it reverts a transaction that has already paid gas.
 */

const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const SPLITTER = '0x1111111111111111111111111111111111111111';
const FEE = 500_000_000_000_000n;

function params(over: Partial<CurrentV2LaunchParams> = {}): CurrentV2LaunchParams {
  return {
    tokenName: 'Diamond Paws',
    tokenSymbol: 'PAWS',
    logo: '',
    description: '',
    socials: EMPTY_SOCIALS,
    feeWallet: SPLITTER,
    launchConfigId: 0n,
    pairToken: AAPL,
    creatorTaxBps: 0,
    buybackEnabled: false,
    expectedEconomics: '0x' + 'ab'.repeat(32),
    salt: '0x' + 'cd'.repeat(32),
    ...over,
  };
}

describe('current V2 encoder', () => {
  it('produces the salt-bearing selector the current factory accepts', () => {
    const { data } = buildCurrentV2LaunchCalldata(params(), FEE);
    expect(data.slice(0, 10)).toBe('0xf35abbcf');
    expect(data.slice(0, 10)).not.toBe('0xa41d5f2b');
  });

  it('decodes back to every field that was asked for', () => {
    const { data, value } = buildCurrentV2LaunchCalldata(params(), FEE);
    // Decoded by full signature, not by name: the current ABI carries two launchToken
    // overloads -- the three-argument one and an exemption-list variant taking
    // address[] -- and ethers refuses an ambiguous name rather than guessing. That
    // ambiguity is itself worth pinning, since picking the wrong overload would encode
    // a call this product does not intend to make.
    const d = new ethers.Interface(PONS_V2_CURRENT_ABI).decodeFunctionData(
      executableDeployment().launchSignature,
      data
    );
    expect(d[0].name).toBe('Diamond Paws');
    expect(d[0].symbol).toBe('PAWS');
    expect(d[0].creatorFeeRecipient).toBe(SPLITTER);
    expect(d[0].creatorTaxBps).toBe(0n);
    expect(d[0].salt).toBe('0x' + 'cd'.repeat(32));
    expect(d[2]).toBe(AAPL);
    expect(value).toBe(FEE);
  });

  it('targets the executable deployment, not a configured address', () => {
    const { to } = buildCurrentV2LaunchCalldata(params(), FEE);
    expect(to).toBe(executableDeployment().factory);
  });

  it('refuses a salt that is not a bytes32', () => {
    expect(() => buildCurrentV2LaunchCalldata(params({ salt: '0xdead' }), FEE)).toThrow(/bytes32/);
  });
});

/**
 * The salt is a second, independent barrier against launching one request twice --
 * the database claim is the first. It has to be reproducible from the request alone,
 * and it has to be scoped, or the same tweet would predict the same token address on
 * a different factory or a different chain.
 */
describe('launchSalt', () => {
  const d = executableDeployment();

  it('is deterministic for the same request', () => {
    expect(launchSalt(d, 'tweet_1')).toBe(launchSalt(d, 'tweet_1'));
  });

  it('is a bytes32', () => {
    expect(launchSalt(d, 'tweet_1')).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('differs per tweet', () => {
    expect(launchSalt(d, 'tweet_1')).not.toBe(launchSalt(d, 'tweet_2'));
  });

  // Without the factory in the preimage, the same request would predict the same
  // address on two deployments -- so a retry after a migration could collide with a
  // token that already exists.
  it('differs per factory', () => {
    const other = { ...d, factory: '0x' + '99'.repeat(20) };
    expect(launchSalt(d, 'tweet_1')).not.toBe(launchSalt(other, 'tweet_1'));
  });

  it('differs per chain', () => {
    const other = { ...d, chainId: 1 };
    expect(launchSalt(d, 'tweet_1')).not.toBe(launchSalt(other, 'tweet_1'));
  });

  // v1's salt is keccak of the tweet id alone. Reusing it would put the same value in
  // a different protocol's address derivation, which is the collision this prevents.
  it('is not the v1 salt for the same tweet', () => {
    const { saltForTweet } = require('../src/ponsEncoder');
    expect(launchSalt(d, 'tweet_1')).not.toBe(saltForTweet('tweet_1'));
  });
});

/**
 * Reading a launch back out of the bytes that were actually sent.
 *
 * Provenance recorded intentions: the selector came from the registry, the salt was
 * recomputed from the tweet id, and the launch config came from global configuration
 * even when the request carried an override. Every one of those is a statement about
 * what the code MEANT to build, recorded next to a transaction hash as though it
 * described what went out.
 *
 * The distinction is the whole point of the record. If the encoder ever disagrees with
 * the registry -- which is precisely the failure this migration is about -- a provenance
 * row derived from the registry agrees with the bug and hides it.
 */
describe('decodeCurrentV2Launch', () => {
  const { decodeCurrentV2Launch, buildCurrentV2LaunchCalldata, launchSalt } = require('../src/ponsV2CurrentEncoder');
  const { executableDeployment } = require('../src/deployments');

  const d = executableDeployment();
  const ECON = '0x' + 'cd'.repeat(32);
  const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';

  function built(over: Record<string, unknown> = {}) {
    return buildCurrentV2LaunchCalldata(
      {
        tokenName: 'Moon Coin',
        tokenSymbol: 'MOON',
        logo: '',
        description: '',
        socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
        feeWallet: '0x1111111111111111111111111111111111111111',
        launchConfigId: 7n,
        pairToken: AAPL,
        creatorTaxBps: 0,
        buybackEnabled: false,
        expectedEconomics: ECON,
        salt: launchSalt(d, 'tweet-9'),
        ...over,
      },
      500_000_000_000_000n,
      d
    );
  }

  it('returns the salt that is actually in the calldata', () => {
    const decoded = decodeCurrentV2Launch(built().data, d);
    expect(decoded.salt).toBe(launchSalt(d, 'tweet-9'));
  });

  it('returns the economics digest that is actually in the calldata', () => {
    expect(decodeCurrentV2Launch(built().data, d).expectedEconomics).toBe(ECON);
  });

  // The override case: recording the global config here would attribute the launch to a
  // config it was not built against.
  it('returns the launch config that was actually encoded, override included', () => {
    expect(decodeCurrentV2Launch(built().data, d).launchConfigId).toBe('7');
  });

  it('returns the pair token that was actually encoded', () => {
    expect(decodeCurrentV2Launch(built().data, d).pairToken.toLowerCase()).toBe(AAPL.toLowerCase());
  });

  it('returns the selector from the bytes, not from the manifest', () => {
    expect(decodeCurrentV2Launch(built().data, d).selector).toBe(built().data.slice(0, 10));
  });

  it('refuses calldata whose selector is not this deployment’s', () => {
    const foreign = '0xa41d5f2b' + built().data.slice(10);
    expect(() => decodeCurrentV2Launch(foreign, d)).toThrow(/selector/i);
  });
});
