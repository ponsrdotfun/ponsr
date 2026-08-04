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

  // ---------------------------------------------------------------------------
  // ERC20 -- the path pons actually pays fees through.
  //
  // The pons v1 locker collects from the launch's Uniswap v3 position and pushes
  // token0/token1 out as ERC20 (verified from its source, 2026-08-04). Native ETH
  // never appears. Before the 2026-08-04 rewrite this contract had no way to move
  // an ERC20 balance at all, so every creator's fees would have accrued here
  // permanently -- these tests exist because that bug was found, not by routine.
  // ---------------------------------------------------------------------------
  describe('ERC20 fee splitting', function () {
    const ONE = ethers.parseEther('1');
    const creatorShareOf = (amount) => (amount * 9500n) / 10000n;

    async function withToken(kind) {
      const ctx = await deploySplitter();
      const erc20 = await deployContract(kind || 'MockERC20', ctx.deployer, []);
      return Object.assign({}, ctx, { erc20 });
    }

    it('splits an ERC20 balance 95/5 and pushes both shares out', async function () {
      const { splitter, erc20, creator, treasury } = await withToken();
      await erc20.mint(await splitter.getAddress(), ONE);

      await splitter.splitERC20(await erc20.getAddress());

      expect(await erc20.balanceOf(creator.address)).to.equal(creatorShareOf(ONE));
      expect(await erc20.balanceOf(treasury.address)).to.equal(ONE - creatorShareOf(ONE));
      expect(await erc20.balanceOf(await splitter.getAddress())).to.equal(0n);
    });

    it('CRITICAL: leaves nothing behind -- creator + treasury always equals the full balance', async function () {
      // The stranded-funds check. Deliberately awkward amounts, including ones that do not
      // divide evenly by 10000, since rounding dust left in the contract is exactly how a
      // splitter quietly accumulates money nobody can retrieve.
      for (const amount of [1n, 3n, 9999n, 10001n, 12345678901234567n, ONE, ONE * 7n + 13n]) {
        const { splitter, erc20, creator, treasury } = await withToken();
        await erc20.mint(await splitter.getAddress(), amount);

        await splitter.splitERC20(await erc20.getAddress());

        const paid = (await erc20.balanceOf(creator.address)) + (await erc20.balanceOf(treasury.address));
        expect(paid).to.equal(amount);
        expect(await erc20.balanceOf(await splitter.getAddress())).to.equal(0n);
      }
    });

    it('is callable by anyone, so neither party can withhold the other share', async function () {
      const { splitter, erc20, other, creator } = await withToken();
      await erc20.mint(await splitter.getAddress(), ONE);

      await splitter.connect(other).splitERC20(await erc20.getAddress());

      expect(await erc20.balanceOf(creator.address)).to.equal(creatorShareOf(ONE));
    });

    it('splits the pair token too, not only the launched token', async function () {
      // Fees arrive as BOTH token0 and token1, so restricting this to `token` would strand
      // half of every payout.
      const { splitter, deployer, creator } = await withToken();
      const pairToken = await deployContract('MockERC20', deployer, []);
      await pairToken.mint(await splitter.getAddress(), ONE);

      await splitter.splitERC20(await pairToken.getAddress());

      expect(await pairToken.balanceOf(creator.address)).to.equal(creatorShareOf(ONE));
    });

    it('reverts rather than emitting an empty split when there is nothing to split', async function () {
      const { splitter, erc20 } = await withToken();
      await expect(splitter.splitERC20(await erc20.getAddress())).to.be.reverted;
    });

    it('CRITICAL: a blocked creator cannot freeze the treasury share', async function () {
      // Real tokens blacklist addresses. One recipient failing must never hold the other
      // hostage, and must never strand the failed share either.
      const { splitter, erc20, creator, treasury } = await withToken();
      await erc20.setBlocked(creator.address, true);
      await erc20.mint(await splitter.getAddress(), ONE);

      await splitter.splitERC20(await erc20.getAddress());

      expect(await erc20.balanceOf(treasury.address)).to.equal(ONE - creatorShareOf(ONE));
      expect(await splitter.claimableERC20(await erc20.getAddress(), creator.address)).to.equal(creatorShareOf(ONE));
    });

    it('lets a queued share be pulled once the block is lifted', async function () {
      const { splitter, erc20, creator } = await withToken();
      await erc20.setBlocked(creator.address, true);
      await erc20.mint(await splitter.getAddress(), ONE);
      await splitter.splitERC20(await erc20.getAddress());

      await erc20.setBlocked(creator.address, false);
      await splitter.withdrawERC20(await erc20.getAddress(), creator.address);

      expect(await erc20.balanceOf(creator.address)).to.equal(creatorShareOf(ONE));
      expect(await splitter.claimableERC20(await erc20.getAddress(), creator.address)).to.equal(0n);
    });

    it('CRITICAL: never re-splits a balance already owed to someone', async function () {
      // A queued share stays in the contract, so a naive balance-based split would count it
      // as new revenue and pay it out again -- out of the other party's money.
      const { splitter, erc20, creator, treasury } = await withToken();
      await erc20.setBlocked(creator.address, true);
      await erc20.mint(await splitter.getAddress(), ONE);
      await splitter.splitERC20(await erc20.getAddress());

      const treasuryAfterFirst = await erc20.balanceOf(treasury.address);
      await expect(splitter.splitERC20(await erc20.getAddress())).to.be.reverted;
      expect(await erc20.balanceOf(treasury.address)).to.equal(treasuryAfterFirst);
    });

    it('splits only genuinely new funds when a queued share is still outstanding', async function () {
      const { splitter, erc20, creator, treasury } = await withToken();
      await erc20.setBlocked(creator.address, true);
      await erc20.mint(await splitter.getAddress(), ONE);
      await splitter.splitERC20(await erc20.getAddress());
      const treasuryAfterFirst = await erc20.balanceOf(treasury.address);

      await erc20.mint(await splitter.getAddress(), ONE); // a second round of fees arrives
      await splitter.splitERC20(await erc20.getAddress());

      expect((await erc20.balanceOf(treasury.address)) - treasuryAfterFirst).to.equal(ONE - creatorShareOf(ONE));
    });

    it('handles a token whose transfer returns no data (USDT-style)', async function () {
      const { splitter, deployer, creator } = await deploySplitter();
      const erc20 = await deployContract('NoReturnERC20', deployer, []);
      await erc20.mint(await splitter.getAddress(), ONE);

      await splitter.splitERC20(await erc20.getAddress());

      expect(await erc20.balanceOf(creator.address)).to.equal(creatorShareOf(ONE));
    });

    it('CRITICAL: treats a false return as a failure rather than as payment', async function () {
      // A token that reports failure by returning false instead of reverting. Ignoring the
      // return value would mark these as paid and lose them silently.
      const { splitter, deployer, creator, treasury } = await deploySplitter();
      const erc20 = await deployContract('FalseReturnERC20', deployer, []);
      await erc20.mint(await splitter.getAddress(), ONE);

      await splitter.splitERC20(await erc20.getAddress());

      expect(await splitter.claimableERC20(await erc20.getAddress(), creator.address)).to.equal(creatorShareOf(ONE));
      expect(await splitter.claimableERC20(await erc20.getAddress(), treasury.address)).to.equal(ONE - creatorShareOf(ONE));
      expect(await erc20.balanceOf(creator.address)).to.equal(0n);
    });

    it('CRITICAL: reentering splitERC20 mid-transfer cannot pay the same balance twice', async function () {
      const { splitter, deployer, creator, treasury } = await deploySplitter();
      const erc20 = await deployContract('ReentrantERC20', deployer, []);
      await erc20.setSplitter(await splitter.getAddress());
      await erc20.mint(await splitter.getAddress(), ONE);

      await splitter.splitERC20(await erc20.getAddress());

      expect(await erc20.reentryReverted()).to.equal(true);
      const paid = (await erc20.balanceOf(creator.address)) + (await erc20.balanceOf(treasury.address));
      expect(paid).to.equal(ONE);
    });

    it('rejects the zero address rather than silently doing nothing', async function () {
      const { splitter } = await deploySplitter();
      await expect(splitter.splitERC20(ethers.ZeroAddress)).to.be.reverted;
    });

    it('reverts a withdrawal when nothing is owed', async function () {
      const { splitter, erc20, creator } = await withToken();
      await expect(splitter.withdrawERC20(await erc20.getAddress(), creator.address)).to.be.reverted;
    });

    it('tracks the running ERC20 total for off-chain bookkeeping', async function () {
      const { splitter, erc20 } = await withToken();
      await erc20.mint(await splitter.getAddress(), ONE);
      await splitter.splitERC20(await erc20.getAddress());
      await erc20.mint(await splitter.getAddress(), ONE);
      await splitter.splitERC20(await erc20.getAddress());

      expect(await splitter.totalReceivedERC20(await erc20.getAddress())).to.equal(ONE * 2n);
    });
  });
});
