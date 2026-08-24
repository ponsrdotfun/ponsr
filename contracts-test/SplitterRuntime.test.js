const { expect } = require('chai');
const { ethers } = require('hardhat');
const path = require('path');
const artifacts = require('./artifacts.json');

/**
 * Verifying a splitter that was actually deployed.
 *
 * The backend's verifier was tested by handing it the compiler's `deployedBytecode`
 * template AS the deployed code. That fixture WAS the expected value, so the test could
 * only ever pass — and it hid a defect that would have stopped the first authorised canary
 * dead: `creator`, `treasury`, `token` and `escrow` are Solidity immutables, patched into
 * the runtime during construction, so a correct deployment never equals the template.
 * Measured: 14 runs of 20 bytes across the four addresses.
 *
 * These tests live in the contracts workspace because that is where a chain exists. A
 * verifier for deployed contracts has to be tested against a deployed contract.
 */

/**
 * The BUILT verifier, not a copy.
 *
 * Requires `npm run build` in backend/ first. Loading the compiled output rather than
 * reimplementing the check here is the point: two implementations of one question drift,
 * and this is the question that decides whether a permanent contract is trusted.
 */
const fs = require('fs');
const DIST = path.join(__dirname, '../backend/dist');
if (!fs.existsSync(path.join(DIST, 'splitterVerifier.js'))) {
  throw new Error('backend/dist is missing. Run `npm run build` in backend/ before these tests.');
}
const { verifyDeployedSplitter } = require(path.join(DIST, 'splitterVerifier.js'));
const { deploymentById } = require(path.join(DIST, 'deployments.js'));

const D = deploymentById('pons-v2-current-7ed');
const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const FOREIGN = '0x000000000000000000000000000000000000dEaD';

describe('the deployed splitter is verified against what was actually deployed', () => {
  let signer;
  let deployWith;

  before(async () => {
    [signer] = await ethers.getSigners();
    const art = artifacts.FeeSplitterV2;
    deployWith = async (creator, treasury, token, escrow) => {
      const f = new ethers.ContractFactory(art.abi, art.bytecode, signer);
      const c = await f.deploy(creator, treasury, token, escrow);
      await c.waitForDeployment();
      const address = await c.getAddress();
      return {
        address,
        code: await ethers.provider.getCode(address),
        bindings: {
          creator: await c.creator(),
          treasury: await c.treasury(),
          token: await c.token(),
          escrow: await c.escrow(),
        },
      };
    };
  });

  const evidence = (d, over = {}) => ({
    receiptStatus: 1,
    contractAddress: d.address,
    deployedCode: d.code,
    deployment: D,
    expectedCreator: TREASURY,
    expectedTreasury: TREASURY,
    expectedTokenPlaceholder: ethers.ZeroAddress,
    expectedEscrow: D.feeEscrow,
    bindings: d.bindings,
    ...over,
  });

  it('accepts a correctly constructed splitter', async () => {
    const d = await deployWith(TREASURY, TREASURY, ethers.ZeroAddress, D.feeEscrow);
    const v = verifyDeployedSplitter(evidence(d));
    expect(v.problems).to.deep.equal([]);
    expect(v.ok).to.equal(true);
    expect(v.splitterAddress).to.equal(d.address);
  });

  /**
   * The bytes that decide where money goes. Masking the immutable offsets instead of
   * binding them would let every one of these through.
   */
  it('refuses a foreign creator', async () => {
    const d = await deployWith(FOREIGN, TREASURY, ethers.ZeroAddress, D.feeEscrow);
    const v = verifyDeployedSplitter(evidence(d));
    expect(v.ok).to.equal(false);
    expect(v.problems.join(' ')).to.match(/creator/i);
  });

  it('refuses a foreign treasury', async () => {
    const d = await deployWith(TREASURY, FOREIGN, ethers.ZeroAddress, D.feeEscrow);
    const v = verifyDeployedSplitter(evidence(d));
    expect(v.ok).to.equal(false);
    expect(v.problems.join(' ')).to.match(/treasury/i);
  });

  it('refuses a wrong token placeholder', async () => {
    const d = await deployWith(TREASURY, TREASURY, FOREIGN, D.feeEscrow);
    const v = verifyDeployedSplitter(evidence(d));
    expect(v.ok).to.equal(false);
    expect(v.problems.join(' ')).to.match(/token/i);
  });

  /** The escrow is immutable and pays msg.sender: a wrong one strands fees forever. */
  it('refuses a foreign escrow', async () => {
    const d = await deployWith(TREASURY, TREASURY, ethers.ZeroAddress, FOREIGN);
    const v = verifyDeployedSplitter(evidence(d));
    expect(v.ok).to.equal(false);
    expect(v.problems.join(' ')).to.match(/escrow/i);
  });

  it('refuses one changed byte of logic outside any immutable', async () => {
    const d = await deployWith(TREASURY, TREASURY, ethers.ZeroAddress, D.feeEscrow);
    // Flip a nibble well inside the code, away from the immutable spans.
    const c = d.code;
    const at = 200;
    const tampered = c.slice(0, at) + (c[at] === 'a' ? 'b' : 'a') + c.slice(at + 1);
    const v = verifyDeployedSplitter(evidence(d, { deployedCode: tampered }));
    expect(v.ok).to.equal(false);
    expect(v.problems.join(' ')).to.match(/differs|length/i);
  });

  it('refuses bytecode that merely contains the required selectors', async () => {
    const fake =
      '0x60806040' +
      ethers.id('splitERC20(address)').slice(2, 10) +
      ethers.id('claimAndSplit(address)').slice(2, 10) +
      'deadbeef'.repeat(8);
    const d = await deployWith(TREASURY, TREASURY, ethers.ZeroAddress, D.feeEscrow);
    const v = verifyDeployedSplitter(evidence(d, { deployedCode: fake }));
    expect(v.ok).to.equal(false);
  });

  /** Getters are independent evidence: the same facts read through the EVM. */
  it('refuses when the contract’s own getters disagree with the bytes', async () => {
    const d = await deployWith(TREASURY, TREASURY, ethers.ZeroAddress, D.feeEscrow);
    const v = verifyDeployedSplitter(
      evidence(d, { bindings: { ...d.bindings, treasury: FOREIGN } })
    );
    expect(v.ok).to.equal(false);
    expect(v.problems.join(' ')).to.match(/treasury\(\) reports/i);
  });

  it('refuses a null receipt as ambiguous rather than failed', async () => {
    const d = await deployWith(TREASURY, TREASURY, ethers.ZeroAddress, D.feeEscrow);
    const v = verifyDeployedSplitter(evidence(d, { receiptStatus: null, contractAddress: null }));
    expect(v.ok).to.equal(false);
    expect(v.problems.join(' ')).to.match(/ambiguous/i);
  });
});
