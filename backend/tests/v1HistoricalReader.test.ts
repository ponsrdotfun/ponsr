import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import { deploymentById, deploymentByFactory, indexableDeployments } from '../src/deployments';
import { canonicalAbiSha256 } from '../src/deploymentIdentity';
import { PONS_FACTORY_ABI, buildLaunchCalldata, saltForTweet, EMPTY_SOCIALS } from '../src/ponsEncoder';

/**
 * V1 MUST STAY READABLE. Making it unreachable is not the same as forgetting it.
 *
 * Two launches on 2026-08-12 went to `pons-v1`. Their tokens exist, their fee splitters
 * exist, and the board and the reconciler still have to read them back. So the coverage
 * that used to live under "v1 is a selectable launch target" was RETARGETED here rather
 * than deleted: the same ABI, the same decoder, the same salt derivation, asked as a
 * question about history instead of about where the next launch goes.
 *
 * Deleting these to get green would have traded one silent failure for another -- a bot
 * that cannot send to v1 and also cannot tell you what it already sent there.
 */

const V1 = deploymentById('pons-v1');

describe('the v1 deployment stays fully readable while staying non-executable', () => {
  it('is registered, non-executable, and superseded by the current deployment', () => {
    expect(V1.executable).toBe(false);
    expect(V1.supersededBy).toBe('pons-v2-current-7ed');
    expect(V1.factory).toBe('0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB');
    expect(V1.chainId).toBe(4663);
    expect(indexableDeployments().map((d) => d.id)).toContain('pons-v1');
  });

  it('carries the metadata an indexer actually needs', () => {
    expect(V1.startBlock).toBeGreaterThan(0);
    expect(V1.launchSelector).toBe('0x686399cb');
    expect(V1.tokenParamsVersion).toBe('v1');
    // v1 PUSHES fees from the locker rather than escrowing them, so this field is the
    // locker. The `PONS_LOCKER_ADDRESS` setting that used to hold it separately was
    // removed: a settable address that must agree with a deployment is free not to.
    expect(V1.feeModel).toBe('push-from-locker');
    expect(V1.feeEscrow).toBe('0x736D76699C26D0d966744cAe304C000d471f7F35');
  });

  it('its ABI is on disk and still hashes to the pinned value', () => {
    const file = path.join(__dirname, '..', 'src', V1.abiPath);
    expect(fs.existsSync(file)).toBe(true);
    const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(canonicalAbiSha256(artifact.abi ?? artifact)).toBe(V1.abiSha256);
  });

  it('resolves from the factory address the two historical launches were sent to', () => {
    // Exactly the `to` observed on chain for
    // 0x6b4ada64c5853073135a110e695c671162575d616782f8ec25f3a789ed2329c0 and
    // 0x8e8449778ca8ba4a303f7ee1d574f03b32ca4554e423b85f5b9e700bf291f201.
    const found = deploymentByFactory('0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb');
    expect(found?.id).toBe('pons-v1');
    expect(found?.executable).toBe(false);
  });
});

describe('the v1 encoder still decodes v1 calldata', () => {
  const params = {
    tokenName: 'PONSR',
    tokenSymbol: 'PONSR',
    logo: '',
    description: '',
    socials: EMPTY_SOCIALS,
    feeWallet: '0x86AD6AA9E248382A2AF7dD0f157e3400D94Ad6Df',
    launchConfigId: 0n,
    dexId: 0n,
    salt: saltForTweet('2087386573054849274'),
  };

  it('round-trips through the pinned v1 ABI', () => {
    const { data } = buildLaunchCalldata(params, 500000000000000n);
    expect(data.slice(0, 10)).toBe(V1.launchSelector);
    const decoded = new ethers.Interface(PONS_FACTORY_ABI).decodeFunctionData('launchToken', data);
    expect(decoded[0].symbol).toBe('PONSR');
    expect(decoded[0].feeWallet).toBe(params.feeWallet);
  });

  it('derives a stable salt from the tweet id', () => {
    // The property that made a v1 retry collide instead of minting a second token. It is
    // still worth asserting: a decoder that disagrees about the salt cannot match an old
    // launch back to the mention that caused it.
    expect(saltForTweet('t1')).toBe(saltForTweet('t1'));
    expect(saltForTweet('t1')).not.toBe(saltForTweet('t2'));
  });
});
