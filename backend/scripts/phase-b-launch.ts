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
import { createLaunchTarget } from '../src/launchTarget';
import { NATIVE_ETH, PairAsset } from '../src/pairTokens';
import { PairAssetRegistry } from '../src/pairTokens';
import { ChainPairTokenSource } from '../src/pairTokenSource';
import { executableDeployment } from '../src/deployments';
import { assertDeploymentIdentity } from '../src/deploymentIdentity';
import { RawKeyTreasurySigner, createTreasurySigner } from '../src/treasurySigner';
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

  // The launch MUST come from the wallet pons whitelisted, which is the Turnkey
  // treasury -- so this uses the same signer the bot does rather than a raw key.
  //
  // It used to hardcode RawKeyTreasurySigner, and that was correct in August when the
  // raw key made the two Phase B launches. It stopped being correct the moment the
  // bot moved to Turnkey: the whitelist we asked pons for names the Turnkey address,
  // and this script would have launched from the retired raw-key wallet instead --
  // an address that will never be whitelisted, holding 0.000249 ETH. The first
  // launch, on the day the whitelist finally landed, would have been refused, and
  // the refusal would have read as "pons did not actually grant it".
  //
  // RAW_KEY=1 forces the old behaviour, for the case where the raw wallet is
  // deliberately the subject.
  const signer = process.env.RAW_KEY === '1'
    ? new RawKeyTreasurySigner(requireConfig('TREASURY_SIGNER_PRIVATE_KEY'), provider)
    : createTreasurySigner(provider);
  const treasury = await signer.address();

  console.log('Chain');
  line('rpc', config.RPC_URL);
  line('chainId', `${network.chainId}${network.chainId === 4663n ? '  (Robinhood Chain MAINNET)' : ''}`);
  // From the registry, never from configuration. This is the script that would perform
  // the first real launch on the current factory, and `config.PONS_V2_FACTORY_ADDRESS`
  // still defaults to the deployment pons replaced -- a landmine for whoever ran it.
  line(
    'factory',
    config.PONS_FACTORY_VERSION === 'v2'
      ? `${executableDeployment().factory}  (${executableDeployment().id})`
      : config.PONS_FACTORY_ADDRESS
  );
  console.log();

  console.log('Treasury');
  const balance = await getBalanceWei(provider, treasury);
  line('signer', process.env.RAW_KEY === '1' ? 'raw key (forced)' : 'from config (Turnkey in production)');
  line('address', treasury);
  line('balance', `${formatEth(balance)} ETH`);
  console.log();

  // --- Preflight: every guard the factory would apply, read before spending anything ---
  console.log('Preflight');

  // Identity FIRST, ahead of every permission.
  //
  // This script had none. It read permissions through `getLaunchReadiness`, which asks
  // whether pons would allow a launch and nothing about WHICH contract it is asking --
  // leaving the one path here that spends real money as the only one with no check that
  // the chain matches the registry. The bot has three; this had zero.
  //
  // A green `canLaunch` from an unexpected contract is not reassurance. It is the most
  // dangerous reading available, because everything after it looks like a go-ahead.
  if (config.PONS_FACTORY_VERSION === 'v2') {
    const d = executableDeployment();
    await assertDeploymentIdentity(d, provider);
    line('deployment', `${d.id} (${d.factory})`);
    line('identity', 'chain id, runtime hash, ABI hash, selector and escrow all match');
  }

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
    if (!readiness.whitelisted && !readiness.launchEnabled) {
      // Naming the address here is the difference between "pons has not granted it"
      // and "we asked for a different address than the one we are launching from".
      problems.push(`the address above (${treasury}) is the one that must be whitelisted -- check it is the address in docs/email-pons-whitelist.md`);
    }
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
  // The provider is not optional here in spirit: without it `deploySplitter` skips its
  // own identity check, and the splitter is the first artifact that cannot be undone.
  const { splitterAddress, deployTxHash } = await deploySplitter(
    signer,
    treasury,
    treasury,
    ethers.ZeroAddress,
    provider
  );
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

  // Built through the same launch target the bot uses, not through the v1 encoder
  // directly.
  //
  // This script hardcoded the v1 encoder and the v1 factory address, which was
  // correct while v1 was the only option and silently wrong afterwards: production
  // moved to v2, the whitelist we asked pons for is a v2 grant, and this script --
  // the one that performs the FIRST self-dealt launch -- would have deployed a v2
  // splitter and then sent v1 calldata to the v1 factory. On v1 we are not
  // whitelisted, so the very launch this script exists to make would have reverted,
  // at the exact moment it mattered, for a reason that reads as "pons refused us".
  const target = createLaunchTarget(provider);
  line('factory version', target.version);
  line('factory address', target.factoryAddress);

  // Resolve the pairing asset the same way the bot does, so a self-dealt launch is
  // the same shape as a user's. PAIR_WITH is a symbol or an address; unset means ETH,
  // which is what v1 always uses and what v2 defaults to.
  let pairAsset: PairAsset = {
    address: NATIVE_ETH, symbol: 'ETH', name: 'Ether', decimals: 18, graduationThreshold: null,
  };
  const wanted = process.env.PAIR_WITH;
  if (wanted && target.supportsPairing) {
    const registry = new PairAssetRegistry(
      new ChainPairTokenSource({
        provider,
        factoryAddress: executableDeployment().factory,
        fromBlock: config.PONS_V2_APPROVALS_FROM_BLOCK,
      })
    );
    const resolved = await registry.resolve(wanted);
    if (!resolved.ok) {
      console.error(`
PAIR_WITH="${wanted}" is not an approved pairing asset: ${resolved.detail}`);
      console.error('Nothing was launched. The splitter above is deployed but unused.');
      process.exit(1);
    }
    pairAsset = resolved.asset;
  } else if (wanted && !target.supportsPairing) {
    console.error(`
PAIR_WITH is set but ${target.version} takes its pairing from the launch config.`);
    console.error('Set PONS_FACTORY_VERSION=v2, or unset PAIR_WITH to launch against ETH.');
    process.exit(1);
  }
  line('paired against', pairAsset.symbol);

  const { to, data, value } = await target.build(
    {
      tokenName: TOKEN_NAME,
      tokenSymbol: TOKEN_SYMBOL,
      description: TOKEN_DESCRIPTION,
      splitterAddress,
      tweetId: salt,
      pairAsset,
    },
    fee
  );

  const sent = await signer.sendTransaction({ to, data, value });
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
