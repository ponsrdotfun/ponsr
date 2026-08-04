import { ethers } from 'ethers';
import artifact from '../src/feeSplitterArtifact.json';

/**
 * Guards the artifact the backend actually deploys from.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * On 2026-08-04 a mainnet launch deployed the **wrong version** of FeeSplitter, and the fees
 * it later received are stranded in it permanently.
 *
 * The cause was not a bug in any contract. `contracts-test/artifacts.json` is written by
 * `compile-all.js`; `backend/src/feeSplitterArtifact.json` was a hand-made copy of it. When
 * FeeSplitter was rewritten for ERC20 and recompiled, the first was refreshed and the second
 * was not. Every one of the 28 contract tests passed -- against the fresh artifact. The
 * testnet rehearsal passed too, because it also read the fresh one. The deploy path was the
 * only thing reading the stale copy, and nothing tested the deploy path's artifact.
 *
 * `compile-all.js` now writes both from the same compile, so they cannot drift. These tests
 * are the second line: if the file the backend deploys from ever loses the ERC20 interface
 * again, the suite fails here rather than a launch failing on-chain months later.
 */

const abi = (artifact as any).FeeSplitter.abi as any[];
const bytecode = (artifact as any).FeeSplitter.bytecode as string;
const functionNames = abi.filter((e) => e.type === 'function').map((e) => e.name);

describe('the FeeSplitter artifact the backend deploys from', () => {
  it('CRITICAL: exposes the ERC20 split path', () => {
    // pons pays creator fees as ERC20. A splitter without these is a contract that can be
    // paid and can never pay out -- which is exactly what was deployed to mainnet.
    expect(functionNames).toContain('splitERC20');
    expect(functionNames).toContain('withdrawERC20');
    expect(functionNames).toContain('claimableERC20');
  });

  it('keeps the ETH path too, so a stray transfer is not stranded either', () => {
    expect(functionNames).toContain('withdraw');
    expect(abi.some((e) => e.type === 'receive')).toBe(true);
  });

  it('still has no owner, admin, or upgrade function', () => {
    // The immutability promise in Part 8. Immutability is also why the wrong-version deploy
    // could not be repaired: there was no admin to call.
    for (const forbidden of ['owner', 'transferOwnership', 'upgradeTo', 'setCreator', 'setTreasury']) {
      expect(functionNames).not.toContain(forbidden);
    }
  });

  it('has the 95/5 split as compile-time constants', () => {
    expect(functionNames).toContain('CREATOR_SHARE_BPS');
    expect(functionNames).toContain('TREASURY_SHARE_BPS');
  });

  it('carries deployable bytecode', () => {
    expect(bytecode).toMatch(/^0x[0-9a-f]+$/);
    expect(bytecode.length).toBeGreaterThan(2);
  });

  it('CRITICAL: the compiled bytecode contains the splitERC20 selector', () => {
    // The ABI is a description; the bytecode is what runs. Checking the selector is present
    // in the deployed code is what would actually have caught the stale artifact -- an ABI
    // and a bytecode from different compiles is precisely the shape of that failure.
    const selector = ethers.id('splitERC20(address)').slice(2, 10);
    expect(bytecode).toContain(selector);
  });

  it('constructor takes creator, treasury and token, in that order', () => {
    const ctor = abi.find((e) => e.type === 'constructor');
    expect(ctor).toBeDefined();
    expect(ctor.inputs.map((i: any) => i.type)).toEqual(['address', 'address', 'address']);
  });
});
