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
import { preflightEnv } from '../src/preflightEnv';
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
import { CanaryJournal } from '../src/canaryJournal';
import { admitCanarySpend, readBotRollingSpend } from '../src/canarySpend';
import { decideCanaryPhase } from '../src/canaryReporting';
import { verifyDeployedSplitter } from '../src/splitterVerifier';
import { signAndPersist, broadcastPersisted, requirePreSigning } from '../src/signedTxFlow';
import { pinnedTreasuryAddress, assertSignerMatchesPin, assertRawKeyNotOnMainnet } from '../src/canarySignerBoundary';
import { deploySplitter } from '../src/splitterDeployer';
import { formatEth } from '../src/treasuryPolicy';

const EXECUTE = process.argv.includes('--execute');

/**
 * The permanent identity. Defaults exist for testnet rehearsal and are refused on mainnet.
 *
 * The canonical plan names PONSR STONKS / PSTONKS; this file defaulted to Ponsr Test /
 * PONSRTEST. Two documents describing one permanent artifact is how a token ends up named
 * by whichever one the operator happened to read -- and the name cannot be changed
 * afterwards by anybody, ever.
 */
const TOKEN_NAME = process.env.PHASE_B_NAME ?? 'Ponsr Test';
const TOKEN_SYMBOL = process.env.PHASE_B_SYMBOL ?? 'PONSRTEST';
const IDENTITY_WAS_EXPLICIT = Boolean(process.env.PHASE_B_NAME && process.env.PHASE_B_SYMBOL);
/**
 * Journal location. Operator state, deliberately outside the container: a deploy would
 * erase a record describing transactions that are still on chain, and an absent journal
 * reads as "nothing was attempted".
 */
const JOURNAL_PATH = process.env.CANARY_JOURNAL ?? './data/canary-journal.sqlite';
/** Stable per-token run id, so a rerun for the same symbol is recognised as the same run. */
const RUN_ID = process.env.CANARY_RUN_ID ?? `canary:${TOKEN_SYMBOL}`;
/** The bot's own accounted 24h spend, from its /status. See canarySpend.ts. */
const BOT_STATUS_URL = process.env.BOT_STATUS_URL ?? '';
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
  /**
   * The address from configuration, not from a key.
   *
   * This constructed a signer here and awaited signer.address(), two hundred lines before
   * the EXECUTE gate, to obtain a public address. A rehearsal that requires a credential
   * cannot be run by anyone who does not hold one -- and the completion report went on to
   * call it a "keyless dry run", which it was not.
   *
   * The signer is built after the gate, and checked against this pin before it can spend.
   */
  const treasury = pinnedTreasuryAddress(preflightEnv());
  assertRawKeyNotOnMainnet(network.chainId, process.env.RAW_KEY === '1');

  console.log('Chain');
  line('rpc', preflightEnv().RPC_URL);
  line('chainId', `${network.chainId}${network.chainId === 4663n ? '  (Robinhood Chain MAINNET)' : ''}`);
  // From the registry, never from configuration. This is the script that would perform
  // the first real launch on the current factory, and `config.PONS_V2_FACTORY_ADDRESS`
  // still defaults to the deployment pons replaced -- a landmine for whoever ran it.
  // Printed from the target below, once it exists. Resolving it here as well was one
  // of the six independent answers this script used to give.
  console.log();

  console.log('Treasury');
  const balance = await getBalanceWei(provider, treasury);
  // Says what is actually true of a dry run: the address came from configuration and no
  // credential has been loaded. The signer is built after the EXECUTE gate, or not at all.
  line('address source', EXECUTE ? 'pinned config, signer verified against it' : 'pinned config (no signer loaded)');
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

  /**
   * Opened before the preflight, because the preflight reads it for the daily-cap
   * arithmetic and because an unresolved row must block a new attempt before any guard
   * has a chance to say the coast is clear.
   */
  const journal = new CanaryJournal(JOURNAL_PATH);
  const stillOpen = journal.unresolved();
  if (stillOpen.length > 0) {
    console.error('BLOCKED: the canary journal has unresolved work.');
    for (const r of stillOpen) {
      console.error(`  - id ${r.id} ${r.op} state=${r.state} tx=${r.txHash ?? '(never broadcast)'}`);
      for (const problem of r.problems) console.error(`      ${problem}`);
    }
    console.error();
    console.error('Recover it read-only before sending anything else. A replacement payload sent');
    console.error('because polling timed out is how one ambiguous transaction becomes two.');
    process.exit(1);
  }

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
    preflightEnv().PONS_LAUNCH_CONFIG_ID,
    preflightEnv().PONS_DEX_ID,
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
  /**
   * No accidental names on mainnet.
   *
   * A default is a reasonable convenience for a rehearsal and an unreasonable one for a
   * permanent public artifact. Requiring both to be typed makes the name a decision
   * somebody made rather than one nobody noticed.
   */
  if (network.chainId === 4663n && !IDENTITY_WAS_EXPLICIT) {
    problems.push(
      'PHASE_B_NAME and PHASE_B_SYMBOL must both be set explicitly on mainnet. The token ' +
        `name is permanent and public; refusing to fall back to "${TOKEN_NAME}" / "${TOKEN_SYMBOL}".`
    );
  }

  if (fee > preflightEnv().TREASURY_MAX_FEE_WEI) {
    problems.push(`live fee ${formatEth(fee)} ETH exceeds TREASURY_MAX_FEE_WEI ${formatEth(preflightEnv().TREASURY_MAX_FEE_WEI)} ETH`);
  }
  // Splitter deployment + the launch itself are two transactions, both paying gas from here.
  const needed = fee + preflightEnv().TREASURY_GAS_RESERVE_WEI;
  if (balance < needed) {
    problems.push(`balance ${formatEth(balance)} ETH is below the fee plus gas reserve (${formatEth(needed)} ETH)`);
  }

  /**
   * The daily spend circuit breaker, which this script had never consulted.
   *
   * Balance, fee ceiling and gas reserve are all per-transaction questions. The breaker is
   * a rolling 24h total, and Part 5's audit is explicit that an attacker need not steal
   * anything -- only make the bot spend. A second spender that ignores the shared budget is
   * exactly that shape, whoever is running it.
   */
  const journalSpent = journal.recordedFeeTotalWei(new Date(Date.now() - 24 * 3600_000).toISOString());
  let botSpent: bigint | null = null;
  let botSpentSource = 'typed rolling-24h from /status';
  if (BOT_STATUS_URL) {
    try {
      const res = await fetch(BOT_STATUS_URL);
      // res.ok first: a 500 body parsed as JSON is not a ledger reading, and an endpoint
      // that is failing is exactly the one whose numbers should not be trusted.
      if (!res.ok) throw new Error(`status endpoint returned HTTP ${res.status}`);
      // Typed field, window verified, AND bound to this runtime. The previous version
      // parsed a human-readable sentence built from a UTC calendar-day figure while the
      // breaker admits against a rolling 24 hours -- a different budget, read confidently.
      botSpent = readBotRollingSpend(await res.json(), preflightEnv().DAILY_SPEND_CAP_WEI, {
        chainId: selected.chainId,
        deploymentId: selected.id,
        factory: selected.factory,
        treasury,
        maxAgeMs: 5 * 60_000,
        // Under execute the bot must not be admitting launches while this one spends.
        requirePublicLaunchDisabled: EXECUTE,
      });
    } catch {
      botSpent = null;
    }
  } else if (process.env.BOT_SPENT_WEI) {
    /**
     * A local diagnostic, and never an execute credential.
     *
     * This accepted an arbitrary environment value as the bot's spend, with no window
     * identity, no cap binding and no evidence it came from the production ledger. Setting
     * BOT_SPENT_WEI=0 turned an authoritative fail-closed gate back into an assertion by
     * whoever typed the command -- and it made the report's "one query, one window" claim
     * false, because the query could simply be skipped.
     *
     * Under --execute it is refused outright. In a dry run it is accepted and labelled
     * UNTRUSTED, so a rehearsal remains possible on a machine that cannot reach the bot
     * without that rehearsal ever standing in for admission.
     */
    if (EXECUTE) {
      problems.push(
        'BOT_SPENT_WEI is set. It is an operator-supplied number with no window identity, ' +
          'no cap binding and no proof it came from the production ledger, so it cannot ' +
          'admit a launch. Set BOT_STATUS_URL and let the typed rolling figure be read.'
      );
    } else {
      botSpent = BigInt(process.env.BOT_SPENT_WEI);
      botSpentSource = 'UNTRUSTED/MANUAL (dry run only; refused under --execute)';
    }
  }

  // Under execute the authoritative source is mandatory. Absent it, there is nothing to
  // check the fee against except a hope.
  if (EXECUTE && !BOT_STATUS_URL) {
    problems.push(
      'BOT_STATUS_URL is required under --execute: the daily cap has to be checked against ' +
        "the bot's own typed rolling-24h ledger, not against an absent one."
    );
  }

  const admission = admitCanarySpend({
    botSpentWei: botSpent,
    journalSpentWei: journalSpent,
    feeWei: fee,
    capWei: preflightEnv().DAILY_SPEND_CAP_WEI,
  });
  line('daily cap', `${formatEth(preflightEnv().DAILY_SPEND_CAP_WEI)} ETH`);
  line('bot accounted spend', botSpent === null ? 'UNREADABLE' : `${formatEth(botSpent)} ETH  [${botSpentSource}]`);
  line('canary journal spend', `${formatEth(journalSpent)} ETH`);
  line(
    'remaining after this',
    admission.remainingAfterWei === undefined ? 'n/a' : `${formatEth(admission.remainingAfterWei)} ETH`
  );
  if (!admission.admitted) problems.push(admission.reason ?? 'the daily spend cap refuses this launch');
  console.log(`  ${'note'.padEnd(26)} ${admission.caveat}`);
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
  line('launchConfigId', preflightEnv().PONS_LAUNCH_CONFIG_ID);
  line('dexId', preflightEnv().PONS_DEX_ID);
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
  /**
   * Only now, past the gate, does a credential enter the process -- and the first thing
   * asked of it is whether it is the account every preflight reading above was about.
   */
  /**
   * The credential modules are loaded HERE, dynamically, and nowhere above.
   *
   * A static `import { config }` or `import { createTreasurySigner }` at the top of this file
   * runs `dotenv.config()` at module load and parses every credential-bearing field --
   * including the Turnkey API private key and the raw treasury key -- before a single line of
   * the dry run executes. The dry run needed none of them, and the completion reports called
   * it keyless while it was reading all of them off disk.
   *
   * `await import(...)` moves that to the far side of the EXECUTE gate. Everything above this
   * line runs without the mixed `.env` ever being opened, which is the only version of
   * "keyless" that survives inspection: discarding the values after reading them still reads
   * them.
   */
  const { requireConfig } = await import('../src/config');
  const { RawKeyTreasurySigner, createTreasurySigner } = await import('../src/treasurySigner');

  const signer = process.env.RAW_KEY === '1'
    ? new RawKeyTreasurySigner(requireConfig('TREASURY_SIGNER_PRIVATE_KEY'), provider)
    : createTreasurySigner(provider);
  assertSignerMatchesPin(await signer.address(), treasury);

  /**
   * The two halves of an irreversible send, held apart deliberately.
   *
   * `preSigner` can produce signed bytes and cannot broadcast; `broadcaster` can broadcast
   * and cannot sign. Neither irreversible operation below goes through a call that does both,
   * because a combined call cannot tell anybody what it sent if it dies while sending.
   *
   * `requirePreSigning` refuses rather than falling back: a signer without a sign-only path
   * stops the canary here, at a point where nothing has been spent.
   */
  const preSigner = requirePreSigning(signer);
  const broadcaster = provider;

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

  /**
   * The splitter deployment is journalled too, and this is the row that was missing.
   *
   * `deploySplitter` broadcasts and waits internally, so the first version of this script
   * journalled only the launch -- by which point a permanent contract had already been
   * created and inspected with no durable record at all. A crash inside that call lost the
   * hash, and a rerun would happily deploy a second splitter because the journal held no
   * unresolved row to refuse on.
   */
  /**
   * Re-read, with nothing between this and the first irreversible byte.
   *
   * The preflight reading is minutes old by now: the pair was resolved, identity was
   * re-verified, and a person may have paused to read it all. The circuit breaker is a
   * live number and the public gate is a live setting, and an old observation of either
   * is a statement about a moment that has passed.
   */
  if (EXECUTE && BOT_STATUS_URL) {
    const fresh = await fetch(BOT_STATUS_URL);
    if (!fresh.ok) {
      console.error(`
ABORTING: the status endpoint returned HTTP ${fresh.status} immediately before the splitter deploy.`);
      journal.close();
      process.exit(1);
    }
    const nowSpent = readBotRollingSpend(await fresh.json(), preflightEnv().DAILY_SPEND_CAP_WEI, {
      chainId: selected.chainId,
      deploymentId: selected.id,
      factory: selected.factory,
      treasury,
      maxAgeMs: 60_000,
      requirePublicLaunchDisabled: true,
    });
    const recheck = admitCanarySpend({
      botSpentWei: nowSpent,
      journalSpentWei: journal.recordedFeeTotalWei(new Date(Date.now() - 24 * 3600_000).toISOString()),
      feeWei: fee,
      capWei: preflightEnv().DAILY_SPEND_CAP_WEI,
    });
    if (!recheck.admitted) {
      console.error(`
ABORTING before the splitter deploy: ${recheck.reason}`);
      console.error('Nothing has been sent and no fee was spent.');
      journal.close();
      process.exit(1);
    }
    line('re-checked cap', `${formatEth(recheck.remainingAfterWei ?? 0n)} ETH remaining, public gate false`);
  }

  let splitterRowId = -1;
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
    selected,
    {
      onPlanned: (initcode) => {
        splitterRowId = journal.prepare({
          runId: RUN_ID,
          op: 'splitter_deploy',
          deploymentId: selected.id,
          chainId: selected.chainId,
          to: '',
          value: 0n,
          calldata: initcode,
        });
      },
      /**
       * Sign, persist the identity, then broadcast the exact bytes.
       *
       * This replaced an `onSent` that bound the hash AFTER `sendTransaction` returned. The
       * splitter creation is irreversible and pays real gas, so it gets the same treatment as
       * the launch: nothing is broadcast until the transaction can be named.
       */
      sendVia: async (initcode) => {
        await signAndPersist({ signer: preSigner, broadcaster }, journal, splitterRowId, {
          chainId: selected.chainId,
          to: null, // a true contract creation, not a call to a placeholder
          data: initcode,
          value: 0n,
        });
        return broadcastPersisted({ broadcaster }, journal, splitterRowId);
      },
      // status null stays `broadcast`: a receipt nobody saw is not a revert.
      /**
       * Records the receipt and NOTHING more.
       *
       * This marked the row confirmed on status 1 plus a contract address, and the runtime
       * code was read afterwards. A stale splitter was therefore persisted as terminal
       * before anything checked what it was -- and if the later check exited, unresolved()
       * was clean and a rerun could proceed past a permanent invalid contract. Only the
       * shared verifier below may confirm.
       */
      onReceipt: (r) => {
        journal.recordReceipt(splitterRowId, { status: r.status });
      },
    }
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
  /**
   * One verifier, the same one recovery uses.
   *
   * These were two inline selector checks here and a third implementation inside recovery.
   * Selector presence is also weak evidence on its own: four bytes can appear in unrelated
   * bytecode by accident or by construction. The shared verifier compares the deployed
   * runtime against the compiled artifact and checks the interface as a secondary signal.
   */
  const deployedCode = await provider.getCode(splitterAddress);
  // The splitter's own answer, read through the EVM. Independent evidence for the same
  // facts the bytes assert, which is worth more than reading one string twice.
  const splitterContract = new ethers.Contract(
    splitterAddress,
    ['function creator() view returns (address)', 'function treasury() view returns (address)',
     'function token() view returns (address)', 'function escrow() view returns (address)'],
    provider
  );
  let splitterBindings = null as null | { creator: string; treasury: string; token: string; escrow?: string };
  try {
    splitterBindings = {
      creator: await splitterContract.creator(),
      treasury: await splitterContract.treasury(),
      token: await splitterContract.token(),
      ...(selected.feeModel === 'escrow-credit' ? { escrow: await splitterContract.escrow() } : {}),
    };
  } catch {
    splitterBindings = null;
  }

  const splitterVerdict = verifyDeployedSplitter({
    receiptStatus: 1,
    contractAddress: splitterAddress,
    deployedCode,
    deployment: selected,
    expectedCreator: treasury,
    expectedTreasury: treasury,
    expectedTokenPlaceholder: ethers.ZeroAddress,
    expectedEscrow: selected.feeEscrow,
    bindings: splitterBindings,
    // Authority path: the contract must agree, not merely fail to disagree.
    requireBindings: true,
  });

  if (!splitterVerdict.ok) {
    journal.markIncidentAnyState(splitterRowId, { problems: splitterVerdict.problems, token: null });
    console.error();
    console.error('=== INCIDENT: SPLITTER DEPLOYED, NOT VERIFIED ===');
    console.error(`  address                    ${splitterAddress}`);
    console.error(`  tx                         ${deployTxHash}`);
    console.error(`  journal row                ${splitterRowId} in ${JOURNAL_PATH}, still open`);
    for (const p of splitterVerdict.problems) console.error(`  - ${p}`);
    console.error();
    console.error('  The contract EXISTS and gas is spent. It is recorded as an open incident so');
    console.error('  a rerun cannot deploy a second one. Do not re-run; settle it by looking:');
    console.error('    npm run recover:canary');
    journal.close();
    process.exit(1);
  }

  // Only now, on a full green verdict, is the splitter row terminal.
  journal.markConfirmedAnyState(splitterRowId, { token: null, splitterAddress });
  line('splitter verified', 'runtime matches the compiled artifact ✅');
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

  /**
   * Intent, then signature identity, then the broadcast.
   *
   * The row exists before anything can be signed, and the exact signed bytes plus their
   * canonical hash exist before anything can be broadcast. A crash at any point leaves a row
   * that names either what was about to happen or precisely which transaction is out there --
   * never the old middle state of "something may have been sent, and nothing knows what".
   */
  const launchRowId = journal.prepare({
    runId: RUN_ID,
    op: 'token_launch',
    deploymentId: selected.id,
    chainId: selected.chainId,
    to,
    value,
    calldata: data,
    tokenName: TOKEN_NAME,
    tokenSymbol: TOKEN_SYMBOL,
    salt,
    pairToken: pairAsset.address,
    splitterAddress,
  });

  const signedLaunch = await signAndPersist(
    { signer: preSigner, broadcaster },
    journal,
    launchRowId,
    { chainId: selected.chainId, to, data, value }
  );
  // The hash is already durable at this point; printing it is a courtesy, not the record.
  line('tx', signedLaunch.hash);
  const sent = await broadcastPersisted({ broadcaster }, journal, launchRowId);
  const receipt = await sent.wait();
  /**
   * null, not 0.
   *
   * This passed `: 0`, which the journal treats as a terminal revert, which drops the row
   * out of unresolved(), which unblocks a retry of a launch that may well have landed. The
   * journal was taught to accept null in round 2 and this caller was never changed -- so
   * the unit test passed against the journal while the executable path stayed broken.
   */
  journal.recordReceipt(launchRowId, { status: receipt ? Number(receipt.status) : null });

  /**
   * Two outcomes, two different things to say.
   *
   * These shared one branch, and the prose said "LAUNCH REVERTED ... before retrying" for
   * both. For a missing receipt that is false and dangerous in the same sentence: nothing
   * establishes a revert, and the advice is the one action that must not be taken.
   */
  if (!receipt) {
    console.error();
    console.error(decideCanaryPhase({ receiptStatus: null, txHash: sent.hash, confirmation: null }).banner);
    console.error(`\n  tx                         ${sent.hash}`);
    console.error(`  journal row                ${launchRowId} in ${JOURNAL_PATH}, still open`);
    console.error('\nNo receipt was seen. That proves neither a revert nor an absence: the');
    console.error('transaction may have landed while the RPC failed to answer. The row keeps its');
    console.error('hash and keeps blocking, which is what stops a second permanent launch.');
    console.error('\n  DO NOT RE-RUN THIS SCRIPT. Settle it by looking:');
    console.error('    npm run recover:canary');
    journal.close();
    process.exit(1);
  }

  if (receipt.status !== 1) {
    console.error();
    console.error(decideCanaryPhase({ receiptStatus: Number(receipt.status), txHash: sent.hash, confirmation: null }).banner);
    console.error('\nThe preflight passed, so a revert here is new information -- capture the reason');
    console.error('from the explorer before retrying. Note the salt is deterministic: a retry with');
    console.error('the same symbol predicts the same token address and will revert with');
    console.error('PoolAlreadyExists if the first attempt actually did deploy.');
    journal.close();
    process.exit(1);
  }

  // `selected` was resolved once at the top; do not ask module-global selection again,
  // because that is a different question from 'which deployment is this run using'.
  const isV2 = selected.tokenParamsVersion !== 'v1';

  /**
   * Neutral language, and only neutral language, until the verdict exists.
   *
   * This printed `=== LAUNCHED ===` here, thirteen lines before `confirmCanaryLaunch` ran.
   * A status=1 receipt means the transaction landed and the fee is spent; it does not mean
   * the factory agrees who the creator fee recipient is, or that the receipt carries an
   * event from the factory we selected. The banner was the one line guaranteed to appear.
   */
  console.log();
  console.log(decideCanaryPhase({ receiptStatus: 1, txHash: sent.hash, confirmation: null }).banner);
  journal.recordFee(launchRowId, fee);

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
    /**
     * Landed but unreconciled is an INCIDENT, not a failure.
     *
     * This printed `ABORTING:` and exited 1 -- ordinary failure language for a transaction
     * that is on chain and paid for. It points the reader at the one action that must not
     * be taken next: running it again. The salt makes that second attempt revert, after
     * paying gas, with PoolAlreadyExists, which by then reads like an unrelated fault.
     *
     * The row is written down instead, with the hash and the problems, so recovery can
     * reconcile it read-only later. Nothing here is described as failed and nothing is
     * described as launched.
     */
    if (!confirmation.verdict.ok || !confirmation.receipt || !confirmation.token) {
      const phase = decideCanaryPhase({
        receiptStatus: 1,
        txHash: sent.hash,
        confirmation: {
          ok: false,
          problems: confirmation.verdict.problems,
          token: confirmation.receipt?.token ?? null,
        },
        outgoing: { to, data, value },
      });
      journal.markIncident(launchRowId, {
        problems: confirmation.verdict.problems,
        token: confirmation.receipt?.token ?? null,
      });
      console.error();
      console.error(phase.banner);
      console.error(`  tx                         ${sent.hash}`);
      console.error(`  deployment                 ${selected.id} (${selected.factory})`);
      console.error(`  splitter                   ${splitterAddress} (tx ${deployTxHash})`);
      console.error(`  token candidate            ${confirmation.receipt?.token ?? 'unknown'}`);
      console.error(`  fee consumed               ${formatEth(fee)} ETH, recorded against the daily cap`);
      console.error(`  journal row                ${launchRowId} in ${JOURNAL_PATH}`);
      console.error();
      console.error('  The transaction LANDED. Do not run this again: the salt is deterministic and a');
      console.error('  retry reverts after paying gas. Reconcile the recorded row read-only instead.');
      for (const problem of confirmation.verdict.problems) console.error(`  - ${problem}`);
      journal.close();
      process.exit(1);
    }
    const found = confirmation.receipt;

    /**
     * Final success language, and the only place it appears.
     *
     * Reached only with a green verdict from the full confirmation gate: the event came
     * from the selected factory, the token matches the calldata, and the factory's own
     * record agrees on the creator fee recipient.
     */
    journal.markConfirmed(launchRowId, { token: found.token });
    console.log();
    console.log(
      decideCanaryPhase({
        receiptStatus: 1,
        txHash: sent.hash,
        confirmation: { ok: true, problems: [], token: found.token },
      }).banner
    );

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
