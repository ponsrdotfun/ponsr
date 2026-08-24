import { ethers } from 'ethers';
import { verifyDeployedSplitter } from '../src/splitterVerifier';
import { splitterArtifactFor } from '../src/splitterDeployer';
import { deploymentById } from '../src/deployments';

/**
 * One verifier, used by both paths, and strong enough to matter.
 *
 * The direct path marked a splitter row `confirmed` from the receipt alone and read the
 * deployed code afterwards. A stale contract was therefore recorded as terminal before
 * anything checked what it was — and if the later check exited, `unresolved()` was clean
 * and a rerun could proceed past a permanent invalid splitter. That is the 2026-08-04
 * wrong-splitter loss again, this time under a green journal.
 *
 * Recovery meanwhile grew its own selector check while the script kept a different one
 * inline. Two verifiers for one question disagree eventually, on the day it matters.
 */

const D = deploymentById('pons-v2-current-7ed');
const V1 = deploymentById('pons-v1');
const ADDR = '0x9999999999999999999999999999999999999999';

const artifactRuntime = (d = D) => {
  const a = splitterArtifactFor(d) as { deployedBytecode?: string; runtimeBytecode?: string };
  return (a.deployedBytecode ?? a.runtimeBytecode ?? '') as string;
};

const ev = (over: Record<string, unknown> = {}) => ({
  receiptStatus: 1,
  contractAddress: ADDR,
  deployedCode: artifactRuntime(),
  deployment: D,
  ...over,
});

describe('the deployed splitter is verified, not assumed', () => {
  it('accepts the exact compiled artifact', () => {
    const v = verifyDeployedSplitter(ev());
    expect(v.ok).toBe(true);
    expect(v.splitterAddress).toBe(ADDR);
  });

  it('refuses an empty account', () => {
    const v = verifyDeployedSplitter(ev({ deployedCode: '0x' }));
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/no code|empty/i);
  });

  /**
   * The reviewer's case 2: a four-byte string can sit inside unrelated bytecode by
   * coincidence or by construction, so selector presence alone is not identity.
   */
  it('refuses unrelated bytecode that merely contains the required selectors', () => {
    const fake =
      '0x60806040' +
      ethers.id('splitERC20(address)').slice(2, 10) +
      ethers.id('claimAndSplit(address)').slice(2, 10) +
      'deadbeef'.repeat(8);
    const v = verifyDeployedSplitter(ev({ deployedCode: fake }));
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/does not match the artifact/i);
  });

  it('refuses the wrong deployment’s splitter', () => {
    const v = verifyDeployedSplitter(ev({ deployedCode: artifactRuntime(V1) }));
    expect(v.ok).toBe(false);
  });

  /** A missing receipt is ambiguous, and must not read as a failed verification. */
  it('reports a null receipt as ambiguous, and says not to deploy another', () => {
    const v = verifyDeployedSplitter(ev({ receiptStatus: null, contractAddress: null }));
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/ambiguous/i);
    expect(v.problems.join(' ')).toMatch(/do not deploy another/i);
  });

  it('refuses a reverted deployment', () => {
    const v = verifyDeployedSplitter(ev({ receiptStatus: 0, contractAddress: null }));
    expect(v.ok).toBe(false);
  });

  it('refuses a success with no contract address', () => {
    const v = verifyDeployedSplitter(ev({ contractAddress: null }));
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/no contract address/i);
  });

  /**
   * Metadata is stripped before comparison. solc hashes the source into the trailing CBOR,
   * so a byte of path or line-ending difference changes the tail without changing the
   * logic — and a check that flags a correct splitter is a check somebody deletes.
   */
  it('accepts the artifact with different trailing metadata', () => {
    const runtime = artifactRuntime().toLowerCase().replace(/^0x/, '');
    const declared = parseInt(runtime.slice(-4), 16);
    const body = runtime.slice(0, runtime.length - 4 - declared * 2);
    const rebuilt = '0x' + body + 'ab'.repeat(declared) + runtime.slice(-4);
    expect(verifyDeployedSplitter(ev({ deployedCode: rebuilt })).ok).toBe(true);
  });

  /** v1 has no escrow claim, so requiring claimAndSplit there would refuse a correct one. */
  it('does not require claimAndSplit on v1', () => {
    const v = verifyDeployedSplitter(ev({ deployment: V1, deployedCode: artifactRuntime(V1) }));
    expect(v.ok).toBe(true);
  });
});
