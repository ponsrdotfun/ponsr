const { expect } = require('chai');
const { ethers } = require('hardhat');
const artifacts = require('./artifacts.json');

// Deploy directly from the manually-compiled ABI/bytecode (see hardhat.config.js for why).
async function deployContract(name, signer, args = []) {
  const { abi, bytecode } = artifacts[name];
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

describe('FeeSplitter', function () {
  async function deploySplitter() {
    const [deployer, creator, treasury, other, fakeToken] = await ethers.getSigners();
    const splitter = await deployContract('FeeSplitter', deployer, [creator.address, treasury.address, fakeToken.address]);
    return { splitter, deployer, creator, treasury, other, fakeToken };
  }

  describe('Deployment', function () {
    it('sets creator, treasury, and token addresses correctly', async function () {
      const { splitter, creator, treasury, fakeToken } = await deploySplitter();
      expect(await splitter.creator()).to.equal(creator.address);
      expect(await splitter.treasury()).to.equal(treasury.address);
      expect(await splitter.token()).to.equal(fakeToken.address);
    });

    it('sets the split ratio constants to exactly 95/5', async function () {
      const { splitter } = await deploySplitter();
      expect(await splitter.CREATOR_SHARE_BPS()).to.equal(9500n);
      expect(await splitter.TREASURY_SHARE_BPS()).to.equal(500n);
    });

    it('reverts on zero-address creator', async function () {
      const [deployer, , treasury, , fakeToken] = await ethers.getSigners();
      await expect(
        deployContract('FeeSplitter', deployer, [ethers.ZeroAddress, treasury.address, fakeToken.address])
      ).to.be.reverted;
    });

    it('reverts on zero-address treasury', async function () {
      const [deployer, creator, , , fakeToken] = await ethers.getSigners();
      await expect(
        deployContract('FeeSplitter', deployer, [creator.address, ethers.ZeroAddress, fakeToken.address])
      ).to.be.reverted;
    });
  });

  describe('Splitting -- happy path', function () {
    it('splits a round number exactly 95/5 with zero dust', async function () {
      const { splitter, creator, treasury, other } = await deploySplitter();

      const creatorBefore = await ethers.provider.getBalance(creator.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      const amount = ethers.parseEther('1.0');
      await other.sendTransaction({ to: await splitter.getAddress(), value: amount });

      const creatorGain = (await ethers.provider.getBalance(creator.address)) - creatorBefore;
      const treasuryGain = (await ethers.provider.getBalance(treasury.address)) - treasuryBefore;

      expect(creatorGain).to.equal(ethers.parseEther('0.95'));
      expect(treasuryGain).to.equal(ethers.parseEther('0.05'));
      expect(creatorGain + treasuryGain).to.equal(amount);
    });

    it('handles an odd, non-round amount without losing or creating wei', async function () {
      const { splitter, creator, treasury, other } = await deploySplitter();
      const amount = 123456789n;

      const creatorBefore = await ethers.provider.getBalance(creator.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      await other.sendTransaction({ to: await splitter.getAddress(), value: amount });

      const creatorGain = (await ethers.provider.getBalance(creator.address)) - creatorBefore;
      const treasuryGain = (await ethers.provider.getBalance(treasury.address)) - treasuryBefore;

      expect(creatorGain + treasuryGain).to.equal(amount);
      const expectedTreasury = amount / 20n;
      const diff = treasuryGain > expectedTreasury ? treasuryGain - expectedTreasury : expectedTreasury - treasuryGain;
      expect(diff).to.be.lte(1n);
    });

    it('emits FeesSplit with correct amounts', async function () {
      const { splitter, other } = await deploySplitter();
      const amount = ethers.parseEther('2.0');

      await expect(other.sendTransaction({ to: await splitter.getAddress(), value: amount }))
        .to.emit(splitter, 'FeesSplit')
        .withArgs(amount, ethers.parseEther('1.9'), ethers.parseEther('0.1'));
    });

    it('correctly accumulates totalReceived across multiple sends', async function () {
      const { splitter, other } = await deploySplitter();
      await other.sendTransaction({ to: await splitter.getAddress(), value: ethers.parseEther('1.0') });
      await other.sendTransaction({ to: await splitter.getAddress(), value: ethers.parseEther('0.5') });
      expect(await splitter.totalReceived()).to.equal(ethers.parseEther('1.5'));
    });

    it('does nothing (no revert) on a zero-value send', async function () {
      const { splitter, other } = await deploySplitter();
      await expect(
        other.sendTransaction({ to: await splitter.getAddress(), value: 0 })
      ).to.not.be.reverted;
    });
  });

  describe('Forward-failure fallback (claimable + withdraw)', function () {
    it('queues the creator share as claimable if the creator address rejects ETH, and treasury still gets paid immediately', async function () {
      const [deployer, , treasury, other, fakeToken] = await ethers.getSigners();
      const rejecter = await deployContract('RejectsEther', deployer);
      const splitter = await deployContract('FeeSplitter', deployer, [await rejecter.getAddress(), treasury.address, fakeToken.address]);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const amount = ethers.parseEther('1.0');

      await expect(other.sendTransaction({ to: await splitter.getAddress(), value: amount }))
        .to.emit(splitter, 'ForwardFailed')
        .withArgs(await rejecter.getAddress(), ethers.parseEther('0.95'));

      const treasuryGain = (await ethers.provider.getBalance(treasury.address)) - treasuryBefore;
      expect(treasuryGain).to.equal(ethers.parseEther('0.05'));
      expect(await splitter.claimable(await rejecter.getAddress())).to.equal(ethers.parseEther('0.95'));
    });

    it('reverts withdraw() when nothing is claimable', async function () {
      const { splitter, creator } = await deploySplitter();
      await expect(splitter.connect(creator).withdraw()).to.be.reverted;
    });

    it('prevents reentrancy from draining more than the owed claimable balance', async function () {
      const [deployer, , treasury, other, fakeToken] = await ethers.getSigners();
      const attacker = await deployContract('ReentrantAttacker', deployer);
      const splitter = await deployContract('FeeSplitter', deployer, [await attacker.getAddress(), treasury.address, fakeToken.address]);
      await (await attacker.setSplitter(await splitter.getAddress())).wait();

      const amount = ethers.parseEther('1.0');
      await other.sendTransaction({ to: await splitter.getAddress(), value: amount });

      const queued = await splitter.claimable(await attacker.getAddress());
      expect(queued).to.equal(ethers.parseEther('0.95'));

      const attackerBalanceBefore = await ethers.provider.getBalance(await attacker.getAddress());
      await (await attacker.attack()).wait();
      const attackerBalanceAfter = await ethers.provider.getBalance(await attacker.getAddress());

      // The attacker must receive AT MOST what it was owed -- proving checks-effects-
      // interactions in withdraw() blocks a reentrant double-spend.
      expect(attackerBalanceAfter - attackerBalanceBefore).to.equal(queued);
      expect(await splitter.claimable(await attacker.getAddress())).to.equal(0n);

      const reentryReverted = await attacker.reentryReverted();
      expect(reentryReverted).to.equal(true);
    });
  });

  describe('Invariant check across many amounts', function () {
    it('creatorAmount + treasuryAmount always equals the input amount', async function () {
      const { splitter, creator, treasury, other } = await deploySplitter();
      const amounts = [1n, 7n, 99n, 1000n, 999999n, ethers.parseEther('0.0001'), ethers.parseEther('3.333333')];

      for (const amount of amounts) {
        const creatorBefore = await ethers.provider.getBalance(creator.address);
        const treasuryBefore = await ethers.provider.getBalance(treasury.address);

        await other.sendTransaction({ to: await splitter.getAddress(), value: amount });

        const creatorGain = (await ethers.provider.getBalance(creator.address)) - creatorBefore;
        const treasuryGain = (await ethers.provider.getBalance(treasury.address)) - treasuryBefore;

        expect(creatorGain + treasuryGain).to.equal(amount);
      }
    });
  });
});
