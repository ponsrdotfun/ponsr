import { verifyDeployedSplitter } from '../src/splitterVerifier';
import { deploymentById } from '../src/deployments';

/**
 * What a chainless test can honestly say about a deployed-contract verifier.
 *
 * This file used to hand the compiler's `deployedBytecode` template to the verifier AS the
 * deployed code and assert that it passed. The fixture WAS the expected value, so the test
 * could not fail — and it hid the defect that would have stopped the first authorised
 * canary: `creator`, `treasury`, `token` and `escrow` are Solidity immutables, patched in
 * during construction, so a correct deployment never equals the template. Measured on a
 * real deployment: 14 runs of 20 bytes.
 *
 * The real coverage now lives in contracts-test/SplitterRuntime.test.js, which deploys the
 * committed bytecode and reads it back through eth_getCode. What remains here is the set of
 * questions that need no chain: refusals that happen before any comparison is attempted.
 * A verifier for deployed contracts cannot be proven without a deployed contract, and
 * pretending otherwise is what went wrong.
 */

const D = deploymentById('pons-v2-current-7ed');
const ADDR = '0x9999999999999999999999999999999999999999';
const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';

const ev = (over: Record<string, unknown> = {}) => ({
  receiptStatus: 1 as number | null,
  contractAddress: ADDR as string | null,
  deployedCode: '0x60806040',
  deployment: D,
  expectedCreator: TREASURY,
  expectedTreasury: TREASURY,
  expectedTokenPlaceholder: '0x0000000000000000000000000000000000000000',
  expectedEscrow: D.feeEscrow,
  ...over,
});

describe('refusals that need no chain', () => {
  /** Ambiguity is not failure, and must not read as one. */
  it('reports a missing receipt as ambiguous and forbids deploying another', () => {
    const v = verifyDeployedSplitter(ev({ receiptStatus: null, contractAddress: null }));
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/ambiguous/i);
    expect(v.problems.join(' ')).toMatch(/do not deploy another/i);
  });

  it('refuses a reverted deployment', () => {
    expect(verifyDeployedSplitter(ev({ receiptStatus: 0, contractAddress: null })).ok).toBe(false);
  });

  it('refuses a success carrying no contract address', () => {
    const v = verifyDeployedSplitter(ev({ contractAddress: null }));
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/no contract address/i);
  });

  it('refuses an empty account', () => {
    const v = verifyDeployedSplitter(ev({ deployedCode: '0x' }));
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/no code|empty/i);
  });

  /**
   * Length is checked before the byte walk, so a wholly different contract is refused with
   * a message about being different rather than a byte offset nobody can act on.
   */
  it('refuses runtime of the wrong length as different code entirely', () => {
    const v = verifyDeployedSplitter(ev({ deployedCode: '0x' + 'ab'.repeat(40) }));
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/different code entirely|bytes/i);
  });

  it('refuses bytecode that merely contains the required selectors', () => {
    const fake = '0x60806040' + 'deadbeef'.repeat(16);
    expect(verifyDeployedSplitter(ev({ deployedCode: fake })).ok).toBe(false);
  });

  /**
   * Without the immutable offsets there is no way to distinguish a constructor-patched
   * byte from a tampered one, so the verifier must refuse rather than guess in either
   * direction. Guessing "patched" would accept an attacker's recipients; guessing
   * "tampered" would reject every real splitter, which is what it did.
   */
  it('fails closed when the artifact carries no immutable references', () => {
    const stripped = { ...D, feeModel: 'push-from-locker' as const, tokenParamsVersion: 'v1' as const };
    const v = verifyDeployedSplitter(
      ev({ deployment: { ...stripped, id: 'pons-v1' }, deployedCode: '0x60806040' })
    );
    expect(v.ok).toBe(false);
  });
});
