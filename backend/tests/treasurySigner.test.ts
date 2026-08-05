import { assertTurnkeyPolicyAcknowledged, RawKeyTreasurySigner, TurnkeyTreasurySigner } from '../src/treasurySigner';
import { config } from '../src/config';
import { ethers } from 'ethers';

describe('treasury signer safety rails', () => {
  const originalEnv = config.NODE_ENV;
  const originalConfirmed = config.TURNKEY_POLICY_CONFIRMED;
  afterEach(() => {
    (config as any).NODE_ENV = originalEnv;
    (config as any).TURNKEY_POLICY_CONFIRMED = originalConfirmed;
  });

  it('CRITICAL: a raw key is refused in production', () => {
    (config as any).NODE_ENV = 'production';
    expect(() => new RawKeyTreasurySigner(ethers.Wallet.createRandom().privateKey, {} as any))
      .toThrow(/never be used in production/i);
  });

  it('CRITICAL: production refuses to start until the Turnkey policy is acknowledged', () => {
    // The failure this guards is silent: a Turnkey key with no policy signs anything and
    // behaves exactly like one with a perfect policy, right up until it is stolen. The SDK
    // cannot check the policy, so the operator has to assert it.
    (config as any).NODE_ENV = 'production';
    (config as any).TURNKEY_POLICY_CONFIRMED = false;
    expect(() => assertTurnkeyPolicyAcknowledged()).toThrow(/TURNKEY_POLICY_CONFIRMED/);
  });

  it('passes once acknowledged', () => {
    (config as any).NODE_ENV = 'production';
    (config as any).TURNKEY_POLICY_CONFIRMED = true;
    expect(() => assertTurnkeyPolicyAcknowledged()).not.toThrow();
  });

  it('does not demand the acknowledgement outside production', () => {
    (config as any).NODE_ENV = 'development';
    (config as any).TURNKEY_POLICY_CONFIRMED = false;
    expect(() => assertTurnkeyPolicyAcknowledged()).not.toThrow();
  });

  it('refuses to construct a Turnkey signer with missing credentials', () => {
    expect(() => new TurnkeyTreasurySigner('', '', '', '', {} as any)).toThrow(/not configured/i);
  });
});
