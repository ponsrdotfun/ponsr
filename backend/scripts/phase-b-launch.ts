/**
 * Phase B — one controlled mainnet launch, with the treasury as its own creator.
 *
 *   npx ts-node scripts/phase-b-launch.ts                 # dry run, sends nothing
 *   npx ts-node scripts/phase-b-launch.ts --execute       # sends real transactions
 *
 * WHY THIS SCRIPT EXISTS, AND WHY IT IS NOT THE BOT
 * -------------------------------------------------
 * pons is not deployed on Robinhood Chain testnet (verified 2026-08-04: `eth_getCode` on the
 * factory address returns `0x` there). So the roadmap's "validate the launch flow on testnet
 * first" is not available for anything involving pons -- it was written against an assumption
 * nobody had checked.
 *
 * What is available is a launch that cannot hurt anyone but the operator:
 *
 *   - `creator` and `treasury` on the splitter are BOTH the treasury address, so the only
 *     fees at stake are the operator's own. `FeeSplitter` is immutable and has never been
 *     deployed anywhere; if it is wrong, this is the run where that costs nothing that
 *     belongs to a user.
 *   - The token is real and permanent. Use a name you are willing to have on-chain forever.
 *
 * This is deliberately a separate script and not a code path inside the bot. The bot's job is
 * to launch for *users*; a self-dealt launch is a validation exercise, and mixing the two
 * would put a "launch to yourself" branch inside the flow that spends the treasury.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not generate trading fees, and it does not call `collectFees` or `splitERC20`.
 * Those need real swaps against the pool, which is a manual step. The script prints exactly
 * what to run afterwards.
 */
import { ethers } from 'ethers';
import { config, requireConfig } from '../src/config';
import { createProvider, getLiveFeeWei, getBalanceWei, getLaunchReadiness } from '../src/chainClient';
import { EMPTY_SOCIALS, buildLaunchCalldata, extractLaunchDetails, saltForTweet } from '../src/ponsEncoder';
import { RawKeyTreasurySigner } from '../src/treasurySigner';
import { deploySplitter } from '../src/splitterDeployer';
import { formatEth } from '../src/treasuryPolicy';

const EXECUTE = process.argv.includes('--execute');

/** Deliberately boring. This token is permanent and public. */
const TOKEN_NAME = process.env.PHASE_B_NAME ?? 'Ponsr Test';
const TOKEN_SYMBOL = process.env.PHASE_B_SYMBOL ?? 'PONSRTEST';
const TOKEN_DESCRIPTION =
  process.env.PHASE_B_DESCRIPTION ??
  'Validation launch for ponsr.fun. Not a project, not an investment, holds no value.';

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

async function main() {
  console.log(EXECUTE ? '=== PHASE B — EXECUTING (real transactions) ===' : '=== PHASE B — DRY RUN (nothing is sent) ===');
  console.log();

  const provider = createProvider();
  const network = await provider.getNetwork();

  // RawKeyTreasurySigner refuses to run under NODE_ENV=production by design (Part 5). That
  // guard is about the *bot*, not this one-off script -- but it does mean this must be run
  // with NODE_ENV unset or 'development', which is a useful accident: it keeps the production
  // process and this script from ever sharing a configuration.
  const signer = new RawKeyTreasurySigner(requireConfig('TREASURY_SIGNER_PRIVATE_KEY'), provider);
  const treasury = await signer.address();

  console.log('Chain');
  line('rpc', config.RPC_URL);
  line('chainId', `${network.chainId}${network.chainId === 4663n ? '  (Robinhood Chain MAINNET)' : ''}`);
  line('factory', config.PONS_FACTORY_ADDRESS);
  console.log();

  console.log('Treasury');
  const balance = await getBalanceWei(provider, treasury);
  line('address', treasury);
  line('balance', `${formatEth(balance)} ETH`);
  console.log();

  // --- Preflight: every guard the factory would apply, read before spending anything ---
  console.log('Preflight');
  const readiness = await getLaunchReadiness(provider, treasury, config.PONS_LAUNCH_CONFIG_ID, config.PONS_DEX_ID);
  line('launchEnabled', readiness.launchEnabled);
  line('whitelisted', readiness.whitelisted);
  line('launchConfig usable', readiness.launchConfigUsable);
  line('dexConfig usable', readiness.dexConfigUsable);
  line('pairToken', readiness.pairToken);

  const fee = await getLiveFeeWei(provider);
  line('launchFee (live)', `${formatEth(fee)} ETH`);

  const problems: string[] = [];
  if (!readiness.canLaunch || !readiness.launchConfigUsable || !readiness.dexConfigUsable) {
    problems.push(readiness.reason ?? 'the factory would refuse this launch');
  }
  if (fee > config.TREASURY_MAX_FEE_WEI) {
    problems.push(`live fee ${formatEth(fee)} ETH exceeds TREASURY_MAX_FEE_WEI ${formatEth(config.TREASURY_MAX_FEE_WEI)} ETH`);
  }
  // Splitter deployment + the launch itself are two transactions, both paying gas from here.
  const needed = fee + config.TREASURY_GAS_RESERVE_WEI;
  if (balance < needed) {
    problems.push(`balance ${formatEth(balance)} ETH is below the fee plus gas reserve (${formatEth(needed)} ETH)`);
  }
  console.log();

  if (problems.length > 0) {
    console.error('BLOCKED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('Preflight clean.');
  console.log();

  // --- What will be sent ---
  const salt = saltForTweet(`phase-b:${TOKEN_SYMBOL}`);
  console.log('Planned launch');
  line('name', TOKEN_NAME);
  line('symbol', TOKEN_SYMBOL);
  line('creator', `${treasury}   <- the treasury itself, so no user funds are at risk`);
  line('launchConfigId', config.PONS_LAUNCH_CONFIG_ID);
  line('dexId', config.PONS_DEX_ID);
  line('salt', salt);
  line('value', `${formatEth(fee)} ETH   <- exactly the fee, so the factory performs no dev buy`);
  console.log();

  if (!EXECUTE) {
    console.log('Dry run complete. Nothing was sent.');
    console.log('Re-run with --execute to deploy the splitter and launch.');
    return;
  }

  // --- Execute ---
  console.log('1/2  Deploying FeeSplitter (creator == treasury == this wallet)...');
  const { splitterAddress, deployTxHash } = await deploySplitter(signer, treasury, treasury, ethers.ZeroAddress);
  line('splitter', splitterAddress);
  line('tx', deployTxHash);

  // Verify the DEPLOYED CODE, not the artifact we deployed from.
  //
  // On 2026-08-04 this launched with the pre-rewrite ETH-only splitter, because the backend's
  // artifact was a stale hand-made copy. The fees it later received are stranded in it
  // permanently. Everything upstream had passed: the contract tests, the testnet rehearsal --
  // all reading a different, fresh copy of the artifact.
  //
  // Reading the selector back out of the chain is the one check that cannot be fooled by a
  // stale build, because it asks the deployed bytecode what it can actually do. It is two
  // lines and it is the difference between a launch and a permanent loss.
  const deployedCode = await provider.getCode(splitterAddress);
  const splitSelector = ethers.id('splitERC20(address)').slice(2, 10);
  if (!deployedCode.includes(splitSelector)) {
    console.error('\nABORTING: the deployed splitter has no splitERC20(address).');
    console.error('That is the ETH-only version. It can receive pons fees and never pay them out.');
    console.error('Run `node ../compile-all.js` from the repo root and try again.');
    console.error(`(The splitter at ${splitterAddress} is already deployed but will not be used.)`);
    process.exit(1);
  }
  line('splitERC20 in code', 'present ✅');

  // The same check, for the failure v2 introduces. On v2 fees are not pushed here at
  // all -- they are credited to pons's escrow and collected by calling `claimToken`,
  // which pays msg.sender. A splitter without `claimAndSplit` would therefore be
  // credited correctly and forever with no transaction able to move the money: the
  // 2026-08-04 loss again, by a different route, and just as permanent.
  if (config.PONS_FACTORY_VERSION === 'v2') {
    const claimSelector = ethers.id('claimAndSplit(address)').slice(2, 10);
    if (!deployedCode.includes(claimSelector)) {
      console.error('\nABORTING: the deployed splitter has no claimAndSplit(address).');
      console.error('That is the v1 splitter. On v2 it can be credited fees it can never claim.');
      console.error('Run `node ../compile-all.js` from the repo root and try again.');
      console.error(`(The splitter at ${splitterAddress} is already deployed but will not be used.)`);
      process.exit(1);
    }
    line('claimAndSplit in code', 'present ✅');
  }
  console.log();

  console.log('2/2  Launching...');
  const { data, value } = buildLaunchCalldata(
    {
      tokenName: TOKEN_NAME,
      tokenSymbol: TOKEN_SYMBOL,
      logo: '',
      description: TOKEN_DESCRIPTION,
      socials: { ...EMPTY_SOCIALS, website: 'https://ponsr.fun' },
      feeWallet: splitterAddress,
      launchConfigId: config.PONS_LAUNCH_CONFIG_ID,
      dexId: config.PONS_DEX_ID,
      salt,
    },
    fee
  );

  const sent = await signer.sendTransaction({ to: config.PONS_FACTORY_ADDRESS, data, value });
  line('tx', sent.hash);
  const receipt = await sent.wait();

  if (!receipt || receipt.status !== 1) {
    console.error('\nLAUNCH REVERTED. The preflight passed, so this is new information -- capture the');
    console.error('revert reason from the explorer before retrying. Note the salt is deterministic:');
    console.error('a retry with the same symbol predicts the same token address and will revert with');
    console.error('PoolAlreadyExists if the first attempt actually did deploy.');
    process.exit(1);
  }

  const details = extractLaunchDetails(receipt.logs);
  console.log();
  console.log('=== LAUNCHED ===');
  line('token', details?.token ?? '(TokenLaunched not found in logs)');
  line('pool', details?.pool ?? '-');
  line('pairToken', details?.pairToken ?? '-');
  line('positionId', details?.positionId?.toString() ?? '-');
  line('initialBuyAmount', `${details?.initialBuyAmount?.toString() ?? '-'}   <- must be 0`);
  console.log();

  if (details && details.initialBuyAmount !== 0n) {
    console.error('⚠️  initialBuyAmount is NOT zero. The treasury just bought into this token.');
    console.error('   That means msg.value exceeded launchFee -- investigate before launching again.');
  }

  console.log('Next, by hand:');
  console.log('  1. Swap against the pool a few times to generate real trading fees.');
  console.log(`  2. locker.collectFees(${details?.token ?? '<token>'})  -- the treasury is authorised as deployer`);
  console.log(`  3. splitter.splitERC20(<token>) and splitter.splitERC20(${details?.pairToken ?? '<pairToken>'})`);
  console.log('  4. Confirm both shares landed 95/5. Only then is the fee path proven end to end.');
}

main().catch((err) => {
  console.error('\nFAILED:', err?.message ?? err);
  process.exit(1);
});
