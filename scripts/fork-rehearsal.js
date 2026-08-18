/**
 * A full v2 launch, on a private copy of mainnet.
 *
 *   FORK=1 PONS_FACTORY_VERSION=v2 CHAIN_ID=4663 \
 *     RPC_URL=https://rpc.mainnet.chain.robinhood.com \
 *     npx hardhat run --no-compile scripts/fork-rehearsal.js
 *
 * WHY THIS EXISTS
 * ---------------
 * pons has launching switched off and this treasury is not whitelisted, so no real
 * launch can be made by anyone. Without this, the entire v2 path -- launchToken
 * against the real factory, FeeSplitterV2 as the fee recipient, a real trade, real
 * fees, and getting them back out again -- would stay untested until pons acts, and
 * the first time it ran would be with somebody's money behind it.
 *
 * A fork is a local copy of mainnet carrying the ACTUAL deployed pons contracts. The
 * owner's account can be impersonated here, so the switch is flipped locally and the
 * launch runs against the real thing. Nothing leaves the machine and no real money
 * moves.
 *
 * WHAT IT DOES NOT PROVE, AND THIS MATTERS
 * ----------------------------------------
 *   - The whitelist. Impersonation is exactly what mainnet will not allow.
 *   - Gas, reorgs, congestion, or anything about a live network.
 *   - That pons will not change the rules between now and then.
 *
 * It de-risks; it does not replace the first self-dealt launch on mainnet.
 *
 * WHAT IT DOES PROVE, and did on 2026-08-19:
 *   - The bot's own calldata is accepted by the real v2 factory.
 *   - FeeSplitterV2 is a valid `creatorFeeRecipient`.
 *   - A real buy against the bonding curve credits fees to pons's escrow.
 *   - FeeSplitterV2 can claim them back out and split them 95/5.
 *
 * The calldata comes from `backend/src/launchTarget.ts` via a child process rather
 * than being rewritten here. A rehearsal that re-implements the thing it is
 * rehearsing proves the re-implementation.
 */
const { ethers } = require('hardhat');
const { execFileSync } = require('child_process');
const path = require('path');
const artifacts = require('../contracts-test/artifacts.json');
const v2Abi = require('../backend/src/abi/ponsV2LaunchFactory.json');
const curveAbi = require('../backend/src/abi/ponsV2BondingCurve.json');

const V2 = '0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8';
const ESCROW = '0xbc39B6502E1a6Ab36E4A5c5026A35F08342A0A9c';
const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const CREATOR = '0x1111111111111111111111111111111111111111';
/** Any address holding enough AAPL to trade with. Read from the token's holder list;
 *  on a fork its balance is ours to borrow, and on mainnet this line is meaningless. */
const AAPL_HOLDER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
];

const line = (l, v) => console.log('  ' + String(l).padEnd(26) + v);
const amt = (v) => ethers.formatUnits(v, 18);

async function impersonate(address) {
  await ethers.provider.send('hardhat_impersonateAccount', [address]);
  await ethers.provider.send('hardhat_setBalance', [address, '0x56BC75E2D63100000']);
  return ethers.getSigner(address);
}

(async () => {
  // Hardhat refuses to execute at the fork block itself, treating it as replaying
  // history for a chain whose hardfork timeline it does not ship. One block on top
  // and everything after runs in a block it mined.
  await ethers.provider.send('hardhat_mine', ['0x1']);

  const net = await ethers.provider.getNetwork();
  const code = await ethers.provider.getCode(V2);
  console.log('=== FORKED MAINNET REHEARSAL ===');
  line('chain', net.chainId.toString());
  line('block', await ethers.provider.getBlockNumber());
  line('real v2 factory', ((code.length - 2) / 2) + ' bytes of live bytecode');
  if (code === '0x') throw new Error('not forked -- run with FORK=1');

  const factory = new ethers.Contract(V2, v2Abi, ethers.provider);

  console.log('\n1  Granting the whitelist (this copy only)');
  const owner = await impersonate(await factory.owner());
  const treasury = await impersonate(TREASURY);
  await (await factory.connect(owner).setWhitelistedLauncher(TREASURY, true)).wait();
  line('launchEnabled', await factory.launchEnabled());
  line('whitelisted', await factory.whitelistedLaunchers(TREASURY));

  console.log('\n2  Deploying FeeSplitterV2');
  const sf = new ethers.ContractFactory(
    artifacts.FeeSplitterV2.abi,
    artifacts.FeeSplitterV2.bytecode,
    treasury
  );
  const splitter = await sf.deploy(CREATOR, TREASURY, ethers.ZeroAddress, ESCROW);
  await splitter.waitForDeployment();
  const splitterAddress = await splitter.getAddress();
  line('splitter', splitterAddress);
  line('creator / treasury', '95% / 5%');

  console.log('\n3  Launching, paired against AAPL');
  const out = execFileSync('npx', ['tsx', 'scripts/print-v2-calldata.ts', splitterAddress, AAPL], {
    cwd: path.join(__dirname, '..', 'backend'),
    encoding: 'utf8',
    shell: true,
  });
  const built = JSON.parse(out.trim().split('\n').pop());
  line('calldata from', 'backend/src/launchTarget.ts');
  const receipt = await (
    await treasury.sendTransaction({ to: built.to, data: built.data, value: BigInt(built.value) })
  ).wait();
  if (receipt.status !== 1) throw new Error('launch reverted');

  const iface = new ethers.Interface(v2Abi);
  let token, curveAddress;
  for (const log of receipt.logs) {
    try {
      const p = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (p && p.name === 'TokenLaunched') {
        token = p.args.token;
        curveAddress = p.args.curve;
      }
    } catch { /* not ours */ }
  }
  if (!token) throw new Error('no TokenLaunched event');
  const t = new ethers.Contract(token, ['function name() view returns (string)', 'function symbol() view returns (string)'], ethers.provider);
  line('token', (await t.name()) + ' (' + (await t.symbol()) + ')');
  line('address', token);

  console.log('\n4  Somebody buys, with real AAPL');
  const holder = await impersonate(AAPL_HOLDER);
  const spend = ethers.parseUnits('50', 18);
  await (await new ethers.Contract(AAPL, ERC20, holder).transfer(TREASURY, spend)).wait();
  await (await new ethers.Contract(AAPL, ERC20, treasury).approve(curveAddress, spend)).wait();
  const curve = new ethers.Contract(curveAddress, curveAbi, treasury);
  await (await curve.buy(spend, 0n, TREASURY)).wait();
  line('spent', amt(spend) + ' AAPL');
  line('curve fee rate', Number(await curve.feeBps()) / 100 + '%');
  line('protocol share', Number(await curve.protocolFeeShareBps()) / 100 + '% of the fee');

  // Fees are credited to the escrow on every trade rather than accumulating on the
  // curve -- `quoteFeeBalance` stays 0 and there is nothing for the operator to
  // sweep. The only action a fee recipient ever takes on v2 is the claim.
  console.log('\n5  Where the fee went');
  line('claimable by splitter', amt(await splitter.claimableFromEscrow(AAPL)) + ' AAPL');
  line('sitting in the splitter', amt(await new ethers.Contract(AAPL, ERC20, ethers.provider).balanceOf(splitterAddress)) + ' AAPL');

  console.log('\n6  Claiming it, and splitting');
  const aaplToken = new ethers.Contract(AAPL, ERC20, ethers.provider);
  const before = { creator: await aaplToken.balanceOf(CREATOR), treasury: await aaplToken.balanceOf(TREASURY) };
  await (await splitter['claimAndSplit(address)'](AAPL)).wait();
  const after = { creator: await aaplToken.balanceOf(CREATOR), treasury: await aaplToken.balanceOf(TREASURY) };

  const toCreator = after.creator - before.creator;
  const toTreasury = after.treasury - before.treasury;
  const total = toCreator + toTreasury;
  line('creator received', amt(toCreator) + ' AAPL');
  line('treasury received', amt(toTreasury) + ' AAPL');
  line(
    'split',
    total > 0n
      ? (Number((toCreator * 10000n) / total) / 100).toFixed(2) + '% / ' + (Number((toTreasury * 10000n) / total) / 100).toFixed(2) + '%'
      : 'nothing moved'
  );
  line('left behind', amt(await aaplToken.balanceOf(splitterAddress)) + ' AAPL');
  line('still in escrow', amt(await splitter.claimableFromEscrow(AAPL)) + ' AAPL');

  // Checked against the contract's own arithmetic rather than against "95%".
  // FeeSplitter computes the creator's share as total * 9500 / 10000 and gives the
  // remainder to the treasury, so integer division leaves the creator a wei short of
  // a perfect 95% and the ratio prints as 94.99%. That is the contract behaving
  // exactly as written; asserting a round 9500 bps would fail a correct split.
  const expectedCreator = (total * 9500n) / 10000n;
  const dust = toTreasury - (total - expectedCreator);
  const ok =
    total > 0n &&
    toCreator === expectedCreator &&
    dust === 0n &&
    (await aaplToken.balanceOf(splitterAddress)) === 0n &&
    (await splitter.claimableFromEscrow(AAPL)) === 0n;
  line('exact per contract', toCreator === expectedCreator ? 'yes (rounding dust to treasury)' : 'NO');
  console.log('\n' + (ok ? '=== PASSED: fees reached both parties, 95/5, nothing stranded ===' : '=== FAILED ==='));
  process.exitCode = ok ? 0 : 1;
})().catch((e) => {
  console.error('FAILED:', String(e.message).slice(0, 240));
  process.exit(1);
});
