/**
 * Validates FeeSplitter on a real chain, end to end, without involving pons.
 *
 *   npx ts-node scripts/validate-splitter.ts                 # dry run
 *   npx ts-node scripts/validate-splitter.ts --execute       # deploys and splits
 *
 * Defaults to Robinhood Chain **testnet**, and refuses mainnet unless you insist.
 *
 * WHY THIS IS WORTH DOING BEFORE PHASE B
 * --------------------------------------
 * pons is not deployed on testnet (verified 2026-08-04), so the launch path cannot be
 * rehearsed there. `FeeSplitter` can: it depends on nothing but ERC20. And it is the one
 * contract that will hold money belonging to *users*, while being **immutable** -- no owner,
 * no admin, no upgrade path. If it is wrong, the only fix is deploying a corrected version and
 * using it for future launches; the fees already routed to a broken one stay stuck forever.
 *
 * So this rehearsal is free and covers the highest-stakes component. Twenty-eight unit tests
 * pass against a Hardhat network, which proves the logic. This proves the same bytecode
 * behaves on a real chain with real gas -- a different question, and the one that has never
 * been answered for this contract.
 *
 * WHAT IT PROVES
 *   1. The contract deploys, and its immutable addresses are what was passed in.
 *   2. An ERC20 balance transferred in splits 95/5 to two distinct addresses.
 *   3. The contract holds a zero balance afterwards -- nothing stranded, no rounding dust.
 */
import { ethers } from 'ethers';
import * as path from 'path';
import { config, requireConfig } from '../src/config';
import { formatEth } from '../src/treasuryPolicy';

const artifacts = require(path.join(__dirname, '..', '..', 'contracts-test', 'artifacts.json'));

const EXECUTE = process.argv.includes('--execute');
const ALLOW_MAINNET = process.argv.includes('--allow-mainnet');
const MAINNET_CHAIN_ID = 4663n;

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

async function deploy(name: string, wallet: ethers.Wallet, args: unknown[] = []) {
  const { abi, bytecode } = artifacts[name];
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function main() {
  console.log(EXECUTE ? '=== SPLITTER VALIDATION — EXECUTING ===' : '=== SPLITTER VALIDATION — DRY RUN ===');
  console.log();

  const provider = new ethers.JsonRpcProvider(config.RPC_URL, config.CHAIN_ID);
  const network = await provider.getNetwork();
  const wallet = new ethers.Wallet(requireConfig('TREASURY_SIGNER_PRIVATE_KEY'), provider);
  const balance = await provider.getBalance(wallet.address);

  line('rpc', config.RPC_URL);
  line('chainId', network.chainId);
  line('wallet', wallet.address);
  line('balance', `${formatEth(balance)} ETH`);
  console.log();

  if (network.chainId === MAINNET_CHAIN_ID && !ALLOW_MAINNET) {
    // This costs real gas and proves nothing testnet cannot. Refusing by default keeps an
    // RPC_URL left over from a Phase B run from quietly spending mainnet funds on a rehearsal.
    console.error('This is mainnet. The rehearsal is meant for testnet, where it is free.');
    console.error('Set RPC_URL/CHAIN_ID to testnet, or pass --allow-mainnet if you mean it.');
    process.exit(1);
  }

  if (balance === 0n) {
    console.error('Wallet has no balance on this chain. Fund it from the Robinhood Chain faucet.');
    process.exit(1);
  }

  // Two distinct, deterministic addresses so the split is observably going to two places.
  // Nobody holds these keys; the point is to read balances, never to spend from them.
  const creator = ethers.getAddress('0x' + ethers.keccak256(ethers.toUtf8Bytes('ponsr:validate:creator')).slice(-40));
  const treasury = ethers.getAddress('0x' + ethers.keccak256(ethers.toUtf8Bytes('ponsr:validate:treasury')).slice(-40));
  const AMOUNT = ethers.parseEther('1000');

  console.log('Plan');
  line('creator', creator);
  line('treasury', treasury);
  line('test amount', `${ethers.formatEther(AMOUNT)} MOCK`);
  line('expected creator', `${ethers.formatEther((AMOUNT * 9500n) / 10000n)} MOCK  (95%)`);
  line('expected treasury', `${ethers.formatEther(AMOUNT - (AMOUNT * 9500n) / 10000n)} MOCK  (5%)`);
  console.log();

  if (!EXECUTE) {
    console.log('Dry run complete. Nothing was deployed.');
    console.log('Re-run with --execute to deploy and split on this chain.');
    return;
  }

  console.log('1/4  Deploying FeeSplitter...');
  const splitter = await deploy('FeeSplitter', wallet, [creator, treasury, ethers.ZeroAddress]);
  const splitterAddress = await splitter.getAddress();
  line('splitter', splitterAddress);

  const onChainCreator = await (splitter as any).creator();
  const onChainTreasury = await (splitter as any).treasury();
  if (onChainCreator !== creator || onChainTreasury !== treasury) {
    console.error('FAIL: the deployed contract does not hold the addresses it was constructed with.');
    process.exit(1);
  }
  line('immutables', 'match ✅');
  console.log();

  console.log('2/4  Deploying a mock ERC20 and funding the splitter...');
  const erc20 = await deploy('MockERC20', wallet);
  const erc20Address = await erc20.getAddress();
  await (await (erc20 as any).mint(splitterAddress, AMOUNT)).wait();
  line('token', erc20Address);
  line('splitter balance', `${ethers.formatEther(await (erc20 as any).balanceOf(splitterAddress))} MOCK`);
  console.log();

  console.log('3/4  Calling splitERC20...');
  const tx = await (splitter as any).splitERC20(erc20Address);
  const receipt = await tx.wait();
  line('tx', receipt.hash);
  line('gas used', receipt.gasUsed.toString());
  console.log();

  console.log('4/4  Checking where the money went...');
  const creatorBalance: bigint = await (erc20 as any).balanceOf(creator);
  const treasuryBalance: bigint = await (erc20 as any).balanceOf(treasury);
  const leftBehind: bigint = await (erc20 as any).balanceOf(splitterAddress);

  const expectedCreator = (AMOUNT * 9500n) / 10000n;
  const expectedTreasury = AMOUNT - expectedCreator;

  line('creator got', `${ethers.formatEther(creatorBalance)} MOCK`);
  line('treasury got', `${ethers.formatEther(treasuryBalance)} MOCK`);
  line('left in splitter', `${ethers.formatEther(leftBehind)} MOCK`);
  console.log();

  const failures: string[] = [];
  if (creatorBalance !== expectedCreator) failures.push(`creator expected ${expectedCreator}, got ${creatorBalance}`);
  if (treasuryBalance !== expectedTreasury) failures.push(`treasury expected ${expectedTreasury}, got ${treasuryBalance}`);
  // The decisive one: anything left behind in an immutable contract is stranded forever.
  if (leftBehind !== 0n) failures.push(`${leftBehind} wei stranded in the splitter`);
  if (creatorBalance + treasuryBalance !== AMOUNT) failures.push('creator + treasury does not equal the input');

  if (failures.length > 0) {
    console.error('FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('\nDo NOT run Phase B. This contract would strand user fees.');
    process.exit(1);
  }

  console.log('=== PASSED ===');
  console.log('95/5 delivered exactly, nothing left behind, on a real chain.');
  console.log('FeeSplitter is validated for Phase B.');
}

main().catch((err) => {
  console.error('\nFAILED:', err?.message ?? err);
  process.exit(1);
});
