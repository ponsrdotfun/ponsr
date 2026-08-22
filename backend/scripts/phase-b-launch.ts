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
import { assertDeploymentIdentity } from '../src/deploymentIdentity';
import { assertOutgoingLaunch } from '../src/launchAssertions';
import { confirmCanaryLaunch } from '../src/canaryConfirmation';
import { PONS_V2_CURRENT_ABI } from '../src/ponsV2CurrentEncoder';
import { resolveCanaryPair } from '../src/canaryPreflight';
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
  // Printed from the target below, once it exists. Resolving it here as well was one
  // of the six independent answers this script used to give.
  console.log();

  console.log('Treasury');
  const balance = await getBalanceWei(provider, treasury);
  line('signer', process.env.RAW_KEY === '1' ? 'raw key (forced)' : 'from config (Turnkey in production)');
  line('address', treasury);
  line('balance', `${formatEth(balance)} ETH`);
  console.log();

  /**
   * ONE launch target, resolved before anything is asked about it.
   *
   * This script used to resolve the deployment six separate times: identity from
   * `executableDeployment()`, readiness and fee from global defaults, the target created
   * later, pair scanning from another global read, and the receipt decoded from a third.
   * Six answers to one question, each free to differ from the others -- and the canary is
   * the run that spends real money for the first time.
   *
   * Everything below reads `selected` and `target`. Nothing re-resolves.
   */
  const target = createLaunchTarget(provider);
  const selected = target.deployment;
  line('deployment', `${selected.id} (${selected.factory})`);
  line('launch selector', selected.launchSelector);

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
  if (selected.tokenParamsVersion !== 'v1') {
    await assertDeploymentIdentity(selected, provider);
    line('identity', 'chain id, runtime hash, ABI hash, selector and escrow all match');
  }

  // Asked of the SELECTED deployment. Read from a global it describes a contract this
  // run is not calling.
  const readiness = await getLaunchReadiness(
    provider,
    treasury,
    config.PONS_LAUNCH_CONFIG_ID,
    config.PONS_DEX_ID,
    selected
  );
  line('launchEnabled', readiness.launchEnabled);
  line('whitelisted', readiness.whitelisted);
  line('launchConfig usable', readiness.launchConfigUsable);
  line('dexConfig usable', readiness.dexConfigUsable);
  line('pairToken', readiness.pairToken);

  // Priced by the same contract that will be called.
  const fee = await getLiveFeeWei(provider, selected);
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

  /**
   * The pairing, settled BEFORE anything durable exists.
   *
   * This used to run AFTER the splitter was deployed, and the dry run returned before
   * reaching it at all -- so the run whose whole purpose is to surface problems could not
   * surface this one, and execute bought a splitter before finding out the pair was
   * refused. The script even said "the splitter above is deployed but unused", which is an
   * accurate description of money already gone.
   *
   * `resolveCanaryPair` also re-reads the live approval: the registry caches for an hour
   * and pons revokes assets, RIVN among them.
   */
  const factoryForPairs = new ethers.Contract(
    selected.factory,
    ['function approvedPairTokens(address) view returns (bool)'],
    provider
  );
  let pairAsset: PairAsset;
  try {
    const resolvedPair = await resolveCanaryPair(process.env.PAIR_WITH, {
      deployment: selected,
      supportsPairing: target.supportsPairing,
      resolve: (typed) =>
        new PairAssetRegistry(
          new ChainPairTokenSource({ provider, deployment: selected })
        ).resolve(typed),
      isApprovedNow: (addr) => factoryForPairs.approvedPairTokens(addr) as Promise<boolean>,
    });
    pairAsset = resolvedPair.asset;
    line('paired against', `${pairAsset.symbol}  (${resolvedPair.source})`);
  } catch (err: any) {
    console.error('\n' + (err?.message ?? err));
    console.error('Nothing was deployed and nothing was sent.');
    process.exit(1);
  }

  if (!EXECUTE) {
    console.log('Dry run complete. Nothing was sent.');
    console.log('Re-run with --execute to deploy the splitter and launch.');
    return;
  }

  // --- Execute ---
  console.log('1/2  Deploying FeeSplitter (creator == treasury == this wallet)...');
  // The provider is not optional here in spirit: without it `deploySplitter` skips its
  // own identity check, and the splitter is the first artifact that cannot be undone.
  // Both checks again, with nothing between them and the first durable artifact.
  //
  // The dry run above proved them minutes ago. Minutes is an interval, and a factory
  // upgrade or a revocation landing inside it produces a paid-for splitter bound to a
  // launch that must revert.
  await assertDeploymentIdentity(selected, provider);
  if (pairAsset.address.toLowerCase() !== NATIVE_ETH) {
    const stillApproved = await factoryForPairs.approvedPairTokens(pairAsset.address);
    if (!stillApproved) {
      console.error(`\n${pairAsset.symbol} was revoked since the preflight. Nothing deployed.`);
      process.exit(1);
    }
  }

  const { splitterAddress, deployTxHash } = await deploySplitter(
    signer,
    treasury,
    treasury,
    ethers.ZeroAddress,
    provider,
    // The SELECTED deployment. Omitting it would fall back to module-global selection, so
    // under rollback or an injected target the identity, readiness and calldata followed
    // `selected` while the splitter's IMMUTABLE escrow followed something else. The
    // escrow is the one that cannot be repaired afterwards.
    selected
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
  if (selected.tokenParamsVersion !== 'v1') {
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
  // Resolved once at the top of this run; creating a second one here was how the same
  // question came to have six answers.
  line('factory version', target.version);
  line('factory address', target.factoryAddress);



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

  // Decode and assert the exact bytes before they reach the signer. The selected
  // deployment, not a global version flag, is the only authority after selection.
  if (selected.tokenParamsVersion !== 'v1') {
    assertOutgoingLaunch({ to, data, value }, splitterAddress, selected);
  }

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

  // `selected` was resolved once at the top; do not ask module-global selection again,
  // because that is a different question from 'which deployment is this run using'.
  const isV2 = selected.tokenParamsVersion !== 'v1';

  console.log();
  console.log('=== LAUNCHED ===');

  if (isV2) {
    /**
     * V2 handoff.
     *
     * This branch did not exist. After a V2 launch the script read the receipt with the
     * V1 extractor -- a different event shape from a different factory -- and then told
     * the operator to call `locker.collectFees` and `splitter.splitERC20`, neither of
     * which applies. V2 credits an escrow that pays `msg.sender`; there is no collect to
     * call, and following those instructions would end in confusion at best.
     */
    const factory = new ethers.Contract(selected.factory, PONS_V2_CURRENT_ABI, provider);
    const confirmation = await confirmCanaryLaunch({
      selected,
      outgoing: { to, data, value },
      splitterAddress,
      treasuryAddress: treasury,
      receipt: { status: Number(receipt.status), logs: receipt.logs as any },
      readLaunchRecord: async (deployment, token) => {
        if (deployment.id !== selected.id) throw new Error('deployment changed during confirmation');
        const raw = await factory.getLaunchedToken(token);
        return {
          token: String(raw.token ?? raw[0]),
          curve: String(raw.curve ?? raw[1]),
          deployer: String(raw.deployer ?? raw[2]),
          creatorFeeRecipient: String(raw.creatorFeeRecipient ?? raw[3]),
          pairToken: String(raw.pairToken ?? raw[4]),
          exists: Boolean(raw.exists ?? raw[14]),
        };
      },
    });
    if (!confirmation.verdict.ok || !confirmation.receipt || !confirmation.token) {
      console.error(`ABORTING: ${selected.id} launch did not fully reconcile.`);
      for (const problem of confirmation.verdict.problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    const found = confirmation.receipt;

    line('deployment', `${selected.id} (${selected.factory})`);
    line('token', found.token);
    line('curve', found.curve);
    line('pairToken', found.pairToken);
    line('deployer', found.deployer);
    line('creator recipient', splitterAddress);

    // The treasury must never buy into a token it launched for somebody else. Anything
    // above the fee is treated by the factory as an initial buy, so an overpayment is a
    // position taken on a stranger's launch -- fatal, not a warning.
    const overpaid = value - fee;
    if (overpaid !== 0n) {
      console.error();
      console.error(`ABORTING: the launch carried ${overpaid} wei above the live fee.`);
      console.error('The factory treats anything above the fee as an initial buy, so the');
      console.error('treasury has taken a position in a token it launched for someone else.');
      process.exit(1);
    }

    console.log();
    console.log('Next, by hand:');
    console.log('  1. Trade against the curve a few times to generate real fees.');
    console.log(`  2. npm run collect:v2 -- ${splitterAddress} --token=${found.token}`);
    console.log('     (dry run first; add --execute to claim)');
    console.log('  3. Require RECONCILED -- exact 95/5 and nothing left in escrow or splitter.');
    console.log();
    console.log('  Do NOT call locker.collectFees or splitter.splitERC20 here. Those are v1:');
    console.log('  v2 credits an escrow that pays msg.sender, and there is nothing to collect.');
    return;
  }

  const details = extractLaunchDetails(receipt.logs);
  line('token', details?.token ?? '(TokenLaunched not found in logs)');
  line('pool', details?.pool ?? '-');
  line('pairToken', details?.pairToken ?? '-');
  line('positionId', details?.positionId?.toString() ?? '-');
  line('initialBuyAmount', `${details?.initialBuyAmount?.toString() ?? '-'}   <- must be 0`);
  console.log();

  // Fatal on v1 too. A nonzero initial buy means the treasury bought into a token it
  // launched for somebody else, and a warning printed after the fact changes nothing.
  if (details && details.initialBuyAmount !== 0n) {
    console.error('ABORTING: initialBuyAmount is NOT zero. The treasury bought into this token.');
    console.error('msg.value exceeded launchFee. Do not launch again until that is understood.');
    process.exit(1);
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
