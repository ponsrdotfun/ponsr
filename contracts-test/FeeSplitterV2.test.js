const { expect } = require('chai');
const { ethers } = require('hardhat');
const artifacts = require('./artifacts.json');

/**
 * The failure these guard against is silent and permanent.
 *
 * pons v2 does not push creator fees; it credits them to an escrow that pays whoever
 * calls `claimToken` — `msg.sender`, with no way to claim on another address's behalf.
 * A plain FeeSplitter named as a v2 launch's `creatorFeeRecipient` would therefore be
 * credited correctly and forever, with no transaction in existence able to move the
 * money. Nothing reverts, nothing errors, and the fees are simply unreachable.
 *
 * That is the 2026-08-04 incident wearing different clothes, so these tests care most
 * about one question: can this contract actually get its own money out.
 */
async function deployContract(name, signer, args = []) {
  const { abi, bytecode } = artifacts[name];
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

describe('FeeSplitterV2', function () {
  async function setup() {
    const [deployer, creator, treasury, other, fakeToken] = await ethers.getSigners();
    const escrow = await deployContract('MockEscrow', deployer);
    const splitter = await deployContract('FeeSplitterV2', deployer, [
      creator.address,
      treasury.address,
      fakeToken.address,
      await escrow.getAddress(),
    ]);
    const token = await deployContract('MockERC20', deployer, []);
    return { escrow, splitter, token, deployer, creator, treasury, other, fakeToken };
  }

  /** Credits the splitter inside the escrow, exactly as a real launch's fees would arrive. */
  async function creditSplitter(escrow, token, splitter, deployer, amount) {
    await token.mint(deployer.address, amount);
    await token.approve(await escrow.getAddress(), amount);
    await escrow.creditToken(await splitter.getAddress(), await token.getAddress(), amount);
  }

  describe('Deployment', function () {
    it('keeps the 95/5 split and the recipients from FeeSplitter', async function () {
      const { splitter, creator, treasury } = await setup();
      expect(await splitter.CREATOR_SHARE_BPS()).to.equal(9500n);
      expect(await splitter.TREASURY_SHARE_BPS()).to.equal(500n);
      expect(await splitter.creator()).to.equal(creator.address);
      expect(await splitter.treasury()).to.equal(treasury.address);
    });

    it('records the escrow immutably', async function () {
      const { splitter, escrow } = await setup();
      expect(await splitter.escrow()).to.equal(await escrow.getAddress());
      // No setter exists. A splitter that could be repointed later would be one whose
      // fees could be redirected after a creator had agreed to the terms.
      expect(splitter.interface.fragments.some((f) => f.name === 'setEscrow')).to.equal(false);
    });

    it('refuses a zero escrow', async function () {
      const [deployer, creator, treasury, , fakeToken] = await ethers.getSigners();
      const { abi, bytecode } = artifacts.FeeSplitterV2;
      const factory = new ethers.ContractFactory(abi, bytecode, deployer);
      await expect(
        factory.deploy(creator.address, treasury.address, fakeToken.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError({ interface: new ethers.Interface(abi) }, 'ZeroAddress');
    });
  });

  describe('Claiming from the escrow', function () {
    // The whole point. Without this the money is visible, attributed, and unreachable.
    it('pulls its own fees out of the escrow and splits them 95/5', async function () {
      const { escrow, splitter, token, deployer, creator, treasury } = await setup();
      const amount = ethers.parseEther('100');
      await creditSplitter(escrow, token, splitter, deployer, amount);

      expect(await splitter.claimableFromEscrow(await token.getAddress())).to.equal(amount);

      await splitter['claimAndSplit(address)'](await token.getAddress());

      expect(await token.balanceOf(creator.address)).to.equal(ethers.parseEther('95'));
      expect(await token.balanceOf(treasury.address)).to.equal(ethers.parseEther('5'));
      // Nothing left behind: the splitter is a conduit, not a destination.
      expect(await token.balanceOf(await splitter.getAddress())).to.equal(0n);
    });

    // Permissionless, like every other movement in this contract. The destinations are
    // fixed at construction, so neither party needs the other's cooperation to be paid.
    it('can be triggered by anyone, and still pays only the two fixed addresses', async function () {
      const { escrow, splitter, token, deployer, creator, treasury, other } = await setup();
      await creditSplitter(escrow, token, splitter, deployer, ethers.parseEther('10'));

      await splitter.connect(other)['claimAndSplit(address)'](await token.getAddress());

      expect(await token.balanceOf(creator.address)).to.equal(ethers.parseEther('9.5'));
      expect(await token.balanceOf(treasury.address)).to.equal(ethers.parseEther('0.5'));
      expect(await token.balanceOf(other.address)).to.equal(0n);
    });

    // The real escrow's own documentation warns that a full-balance claim can revert
    // against a quote asset with a per-transfer cap, which would leave the recipient
    // unable to draw any of it. The amount-taking form is the way out of that.
    it('supports a partial claim', async function () {
      const { escrow, splitter, token, deployer, creator } = await setup();
      await creditSplitter(escrow, token, splitter, deployer, ethers.parseEther('100'));

      await splitter['claimAndSplit(address,uint256)'](await token.getAddress(), ethers.parseEther('40'));

      expect(await token.balanceOf(creator.address)).to.equal(ethers.parseEther('38'));
      expect(await splitter.claimableFromEscrow(await token.getAddress())).to.equal(ethers.parseEther('60'));
    });

    it('claiming twice does not pay twice', async function () {
      const { escrow, splitter, token, deployer, creator } = await setup();
      await creditSplitter(escrow, token, splitter, deployer, ethers.parseEther('10'));

      await splitter['claimAndSplit(address)'](await token.getAddress());
      await expect(
        splitter['claimAndSplit(address)'](await token.getAddress())
      ).to.be.revertedWithCustomError(splitter, 'NothingToClaim');

      expect(await token.balanceOf(creator.address)).to.equal(ethers.parseEther('9.5'));
    });

    it('refuses to spend gas when the escrow holds nothing', async function () {
      const { splitter, token } = await setup();
      await expect(
        splitter['claimAndSplit(address)'](await token.getAddress())
      ).to.be.revertedWithCustomError(splitter, 'NothingToClaim');
    });

    // A claim that lands on top of an earlier unsplit push must move both, not strand
    // the older one. splitERC20 walks the whole balance, which is what makes that true.
    it('also splits anything already sitting here from a direct push', async function () {
      const { escrow, splitter, token, deployer, creator, treasury } = await setup();
      await token.mint(await splitter.getAddress(), ethers.parseEther('50'));
      await creditSplitter(escrow, token, splitter, deployer, ethers.parseEther('50'));

      await splitter['claimAndSplit(address)'](await token.getAddress());

      expect(await token.balanceOf(creator.address)).to.equal(ethers.parseEther('95'));
      expect(await token.balanceOf(treasury.address)).to.equal(ethers.parseEther('5'));
    });
  });

  describe('Native ETH', function () {
    // A launch paired against native ETH is credited on the escrow's ETH side. The
    // inherited receive() splits it as it arrives, so no explicit split call follows --
    // this asserts that really happens rather than assuming it.
    it('claims ETH from the escrow and splits it on arrival', async function () {
      const { escrow, splitter, creator, treasury, deployer } = await setup();
      await escrow.credit(await splitter.getAddress(), { value: ethers.parseEther('10') });

      const creatorBefore = await ethers.provider.getBalance(creator.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      await splitter.connect(deployer).claimEthAndSplit();

      expect((await ethers.provider.getBalance(creator.address)) - creatorBefore)
        .to.equal(ethers.parseEther('9.5'));
      expect((await ethers.provider.getBalance(treasury.address)) - treasuryBefore)
        .to.equal(ethers.parseEther('0.5'));
      expect(await ethers.provider.getBalance(await splitter.getAddress())).to.equal(0n);
    });

    it('refuses an ETH claim when the escrow holds nothing', async function () {
      const { splitter } = await setup();
      await expect(splitter.claimEthAndSplit()).to.be.revertedWithCustomError(splitter, 'NothingToClaim');
    });
  });

  describe('Inherited safety still applies', function () {
    // The claimable ledger is what stops one recipient blocking the other. It is
    // inherited rather than restated, so this confirms the inheritance actually carries
    // the behaviour and not just the function names.
    it('queues a share that cannot be delivered instead of reverting the whole split', async function () {
      const [deployer, , treasury, , fakeToken] = await ethers.getSigners();
      const escrow = await deployContract('MockEscrow', deployer);
      const rejecter = await deployContract('RejectsEther', deployer);
      const splitter = await deployContract('FeeSplitterV2', deployer, [
        await rejecter.getAddress(),
        treasury.address,
        fakeToken.address,
        await escrow.getAddress(),
      ]);

      await escrow.credit(await splitter.getAddress(), { value: ethers.parseEther('10') });
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      await splitter.claimEthAndSplit();

      // The treasury is paid even though the creator's push failed.
      expect((await ethers.provider.getBalance(treasury.address)) - treasuryBefore)
        .to.equal(ethers.parseEther('0.5'));
      // And the creator's share is pullable rather than lost.
      expect(await splitter.claimable(await rejecter.getAddress())).to.equal(ethers.parseEther('9.5'));
    });
  });
});
