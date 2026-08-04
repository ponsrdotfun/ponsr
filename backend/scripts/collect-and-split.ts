/**
 * Phase B step 4 — pull trading fees out of the locker and split them.
 *
 *   npx ts-node scripts/collect-and-split.ts <tokenAddress> <splitterAddress>
 *   npx ts-node scripts/collect-and-split.ts <tokenAddress> <splitterAddress> --execute
 *
 * This is the half of the fee model that has only ever been verified by reading source:
 *
 *   1. `locker.collectFees(token)` collects from the launch's Uniswap v3 position, takes the
 *      protocol's cut, and **pushes** the rest to `feeRedirects[token]` as ERC20 -- both
 *      `token0` and `token1`, never native ETH.
 *   2. `splitter.splitERC20(x)` divides whatever arrived 95/5.
 *
 * Step 1 is authorised for the owner, the deployer, the recipient, or a whitelisted
 * collector. The bot's treasury is the deployer, so it can always trigger this.
 *
 * Both steps are permissionless in the direction that matters: `splitERC20` sends only to the
 * two addresses fixed at the splitter's construction, so running this on someone else's
 * launch would pay *them*, not the caller.
 */
import { ethers } from 'ethers';
import { config, requireConfig } from '../src/config';
import { createProvider } from '../src/chainClient';
import lockerArtifact from '../src/abi/ponsLaunchLocker.json';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
];
const SPLITTER_ABI = [
  'function splitERC20(address) returns (uint256,uint256)',
  'function creator() view returns (address)',
  'function treasury() view returns (address)',
  'function claimableERC20(address,address) view returns (uint256)',
];

const EXECUTE = process.argv.includes('--execute');
const [tokenArg, splitterArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function balances(provider: ethers.Provider, tokens: string[], who: string) {
  const out: Record<string, bigint> = {};
  for (const t of tokens) {
    const c = new ethers.Contract(t, ERC20_ABI, provider);
    out[t] = await c.balanceOf(who);
  }
  return out;
}

async function main() {
  if (!tokenArg || !splitterArg) {
    console.error('usage: collect-and-split.ts <tokenAddress> <splitterAddress> [--execute]');
    process.exit(1);
  }
  const token = ethers.getAddress(tokenArg);
  const splitter = ethers.getAddress(splitterArg);

  const provider = createProvider();
  const wallet = new ethers.Wallet(requireConfig('TREASURY_SIGNER_PRIVATE_KEY'), provider);

  const locker = new ethers.Contract(config.PONS_LOCKER_ADDRESS, lockerArtifact.abi, wallet);
  const split = new ethers.Contract(splitter, SPLITTER_ABI, wallet);

  const creator = (await split.creator()) as string;
  const treasury = (await split.treasury()) as string;
  const redirect = (await locker.feeRedirects(token)) as string;
  const pairToken = ethers.getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'); // WETH
  const tracked = [token, pairToken];

  console.log(EXECUTE ? '=== COLLECT & SPLIT — EXECUTING ===' : '=== COLLECT & SPLIT — DRY RUN ===');
  console.log();
  line('token', token);
  line('splitter', splitter);
  line('feeRedirects[token]', redirect);
  line('creator', creator);
  line('treasury', treasury);
  console.log();

  if (redirect.toLowerCase() !== splitter.toLowerCase()) {
    console.error('The locker does not point at this splitter. Refusing -- collecting would send');
    console.error('the fees somewhere else entirely.');
    process.exit(1);
  }

  const before = {
    splitter: await balances(provider, tracked, splitter),
    creator: await balances(provider, tracked, creator),
    treasury: await balances(provider, tracked, treasury),
  };

  console.log('Before');
  for (const t of tracked) {
    const sym = await new ethers.Contract(t, ERC20_ABI, provider).symbol();
    line(`${sym} splitter`, ethers.formatUnits(before.splitter[t], 18));
    line(`${sym} creator`, ethers.formatUnits(before.creator[t], 18));
    line(`${sym} treasury`, ethers.formatUnits(before.treasury[t], 18));
  }
  console.log();

  if (!EXECUTE) {
    console.log('Dry run. Re-run with --execute to call collectFees and splitERC20.');
    return;
  }

  console.log('1  locker.collectFees(token)...');
  try {
    const tx = await locker.collectFees(token);
    const receipt = await tx.wait();
    line('tx', receipt.hash);
  } catch (err: any) {
    // NoFeesToCollect is the expected outcome when nothing has traded yet -- not a failure
    // of anything, just nothing to do.
    console.error(`  failed: ${err?.shortMessage ?? err?.message}`);
    console.error('  If this is NoFeesToCollect, the pool has not accrued fees yet.');
    process.exit(1);
  }

  const afterCollect = await balances(provider, tracked, splitter);
  console.log('   arrived at the splitter:');
  for (const t of tracked) {
    const sym = await new ethers.Contract(t, ERC20_ABI, provider).symbol();
    line(`   ${sym}`, ethers.formatUnits(afterCollect[t] - before.splitter[t], 18));
  }
  console.log();

  console.log('2  splitter.splitERC20() for each token...');
  for (const t of tracked) {
    const sym = await new ethers.Contract(t, ERC20_ABI, provider).symbol();
    if (afterCollect[t] === 0n) {
      line(sym, 'nothing to split, skipped');
      continue;
    }
    try {
      const tx = await split.splitERC20(t);
      const receipt = await tx.wait();
      line(sym, `split in ${receipt.hash}`);
    } catch (err: any) {
      line(sym, `failed: ${err?.shortMessage ?? err?.message}`);
    }
  }
  console.log();

  console.log('3  Where it ended up');
  const after = {
    splitter: await balances(provider, tracked, splitter),
    creator: await balances(provider, tracked, creator),
    treasury: await balances(provider, tracked, treasury),
  };

  let allGood = true;
  for (const t of tracked) {
    const sym = await new ethers.Contract(t, ERC20_ABI, provider).symbol();
    const toCreator = after.creator[t] - before.creator[t];
    const toTreasury = after.treasury[t] - before.treasury[t];
    const left = after.splitter[t];
    const total = toCreator + toTreasury;
    if (total === 0n && left === 0n) continue;

    console.log(`  ${sym}`);
    line('  -> creator', `${ethers.formatUnits(toCreator, 18)}`);
    line('  -> treasury', `${ethers.formatUnits(toTreasury, 18)}`);
    line('  left in splitter', `${ethers.formatUnits(left, 18)}`);
    if (total > 0n) {
      const creatorPct = Number((toCreator * 10000n) / total) / 100;
      line('  creator share', `${creatorPct}%   (expected 95%)`);
      if (creatorPct < 94.9 || creatorPct > 95.1) allGood = false;
    }
    // Anything left behind in an immutable contract is stranded, unless it is a queued claim.
    if (left > 0n) {
      const owedCreator = await split.claimableERC20(t, creator);
      const owedTreasury = await split.claimableERC20(t, treasury);
      line('  claimable creator', ethers.formatUnits(owedCreator, 18));
      line('  claimable treasury', ethers.formatUnits(owedTreasury, 18));
      if (owedCreator + owedTreasury !== left) allGood = false;
    }
  }

  console.log();
  console.log(allGood ? '=== PASSED — the fee path works end to end ===' : '=== CHECK THE NUMBERS ABOVE ===');
}

main().catch((err) => {
  console.error('\nFAILED:', err?.message ?? err);
  process.exit(1);
});
