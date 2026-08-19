import { ethers } from 'ethers';
import { InboundMention } from './types';
import { Db } from './db';
import { ParserClient } from './parser';
import { validateLaunchRequest } from './validator';
import { WalletResolver } from './walletResolver';
import { XClient } from './xClient';
import { TreasurySigner } from './treasurySigner';
import { deploySplitter } from './splitterDeployer';
import { EMPTY_SOCIALS, buildLaunchCalldata, extractLaunchedTokenAddress, saltForTweet } from './ponsEncoder';
import { LaunchTarget, createLaunchTarget } from './launchTarget';
import { NATIVE_ETH, PairAsset, PairResolution } from './pairTokens';
import { composeSuccessReply, composeRejectionReply, composeOnChainFailureReply } from './replyComposer';
import { TreasuryMonitor } from './monitor';
import { config } from './config';

/**
 * This function is the whole bot flow diagram from Part 11 turned into code, in order:
 *   1. Tweet terdeteksi (idempotency claim + parse)
 *   2. Validasi request (guard layer -- may short-circuit here with a rejection reply)
 *   3. Token di-launch (deploy splitter, build calldata, treasury signs & sends)
 *   4. Reply terkirim (success or failure, always something concrete)
 *
 * Every external dependency is passed in as an interface (parser, wallet resolver, X client,
 * treasury signer, chain provider) rather than constructed inside this function -- this is
 * what makes the whole pipeline testable end-to-end with mocks, without hitting any real
 * external service. See tests/orchestrator.test.ts.
 */
export interface OrchestratorDeps {
  db: Db;
  parser: ParserClient;
  walletResolver: WalletResolver;
  xClient: XClient;
  treasurySigner: TreasurySigner;
  provider: ethers.Provider;
  getLiveFeeWei: () => Promise<bigint>;
  /** Hot treasury balance, read live (Part 5 mitigation #7). Backs the admission
   *  check in validator.ts that stops the bot spending money it does not have. */
  getTreasuryBalanceWei: () => Promise<bigint>;
  /** Whether pons's factory would accept a launch from us right now (open question #23). */
  getLaunchReadiness: () => Promise<{
    canLaunch: boolean;
    launchConfigUsable: boolean;
    dexConfigUsable?: boolean;
    reason?: string;
  }>;
  /** Part 5 mitigation #5. Optional so existing callers keep working, but a
   *  production deployment must pass one -- the guards below stop an attack
   *  silently otherwise, and nobody learns it happened. */
  monitor?: TreasuryMonitor;
  /** Resolves what the person asked to pair against, against the set pons has
   *  actually approved. Optional: with no registry every launch is against ETH,
   *  which is v1's only behaviour and remains v2's default. */
  pairAssets?: { resolve(typed: string | null | undefined): Promise<PairResolution> };
  /** Which factory to build for. Defaults from config; injected in tests. */
  launchTarget?: LaunchTarget;
}

/** Alerting must never change a launch outcome. If the notifier is down, that is
 *  a monitoring problem, not a reason to fail a user's launch or to leave the
 *  treasury in a half-known state -- so every monitor call is fire-and-forget. */
function notify(deps: OrchestratorDeps, fn: (m: TreasuryMonitor) => Promise<void>): void {
  if (!deps.monitor) return;
  Promise.resolve()
    .then(() => fn(deps.monitor as TreasuryMonitor))
    .catch((err) => console.error('[monitor] alert failed (launch unaffected):', err?.message ?? err));
}

/**
 * Posts a reply without letting a failure touch the launch.
 *
 * A reply is a NOTIFICATION. The token is on-chain and the fee is spent before this is
 * attempted, and none of that becomes untrue because X refused a POST.
 *
 * On 2026-08-12 it was inside the launch's try/catch, so when the reply failed the catch
 * marked a successful launch `failed` -- overwriting the `confirmed` row that had been written
 * seconds earlier, next to a real token address and transaction hash. It then attempted a
 * second reply, through the same transport that had just failed, from inside the catch that
 * was handling the first failure.
 *
 * So this never throws and never reports the launch. It logs the real error, which is the only
 * record of WHY X refused, and raises an alert -- because a launch nobody was told about is
 * the operator's problem to fix by hand, and silence there is indistinguishable from success.
 */
async function replySafely(
  deps: OrchestratorDeps,
  inReplyToTweetId: string,
  text: string,
  context: Record<string, unknown> = {},
  /** Second attempt, used only when X rejects the first for containing a crypto address. */
  withoutAddresses?: () => string
): Promise<void> {
  try {
    await deps.xClient.postReply(inReplyToTweetId, text);
    return;
  } catch (err: any) {
    const detail = err?.message ?? String(err);

    // X blocks crypto addresses for the first 7 days after authentication, and our success
    // reply carries both a token address and a transaction hash. Retrying without them is
    // better than staying silent: the person still learns their token exists and where to
    // find it. Once the window passes, the first attempt succeeds and this never runs.
    if (withoutAddresses && /crypto addresses are prohibited/i.test(detail)) {
      try {
        await deps.xClient.postReply(inReplyToTweetId, withoutAddresses());
        console.warn(`[reply] ${inReplyToTweetId}: addresses refused by X, answered without them`);
        // Alerted, not just logged. This is the only signal that the reply people
        // actually want is still not being delivered, and the way we find out the
        // restriction has lifted is that these stop arriving.
        notify(deps, (m) => m.onReplyDegraded(inReplyToTweetId, detail));
        return;
      } catch (second: any) {
        console.error(`[reply] address-free retry also failed: ${second?.message ?? second}`);
      }
    }

    console.error(`[reply] could not answer tweet ${inReplyToTweetId}: ${detail}`);
    notify(deps, (m) =>
      m.onReplyFailed(inReplyToTweetId, detail, context)
    );
  }
}

/** What a launch pairs against when nobody asked for anything else. ETH needs no
 *  approval and is v1's only option, so this keeps today's behaviour exactly. */
const NATIVE_ETH_ASSET: PairAsset = {
  address: NATIVE_ETH,
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
  graduationThreshold: null,
};

export type OrchestratorOutcome =
  | { kind: 'duplicate' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'launched'; tokenAddress: string; txHash: string }
  | { kind: 'onchain_failure'; detail: string };

export async function handleMention(mention: InboundMention, deps: OrchestratorDeps): Promise<OrchestratorOutcome> {
  // --- Step 1: idempotency, atomic, before anything else runs ---
  const claimed = deps.db.claimTweetForProcessing(mention.tweetId);
  if (!claimed) {
    return { kind: 'duplicate' };
  }

  // --- Step 1 continued: parse intent ---
  //
  // Guarded, because the claim above is already taken. Without this a parser failure
  // -- an exhausted API balance, a network blip, an outage on the provider's side --
  // throws past every handler, and the mention stays marked as processed forever: the
  // sweep will not retry it, nobody is replied to, and nothing alerts. A real launch
  // request would be consumed and answered with silence.
  //
  // Releasing the claim is safe here and only here: no wallet has been resolved, no
  // contract deployed, no transaction sent. The worst a retry costs is another parse.
  let intent;
  try {
    intent = await deps.parser.parse(mention.text);
  } catch (err: any) {
    deps.db.releaseTweetClaim(mention.tweetId);
    const detail = err?.message ?? String(err);
    console.error(`[parser] failed on tweet ${mention.tweetId}, claim released for retry: ${detail}`);
    notify(deps, (m) => m.onParserFailed(mention.tweetId, detail));
    return { kind: 'rejected', reason: 'PARSER_UNAVAILABLE' };
  }

  // --- Step 2: validation guard ---
  const validation = await validateLaunchRequest(intent, mention.authorXUserId, mention.tweetId, {
    db: deps.db,
    getAccountSignals: (id) => deps.xClient.getAccountSignals(id, mention.authorHandle),
    getLiveFeeWei: deps.getLiveFeeWei,
    getTreasuryBalanceWei: deps.getTreasuryBalanceWei,
    getLaunchReadiness: deps.getLaunchReadiness,
  });

  if (!validation.approved) {
    notify(deps, (m) => m.onRejected(mention.tweetId, mention.authorXUserId, validation.reason!));
    const replyText = composeRejectionReply(validation.reason!, validation.detail);
    if (replyText) {
      await replySafely(deps, mention.tweetId, replyText, { stage: 'rejected', reason: validation.reason });
    }
    return { kind: 'rejected', reason: validation.reason! };
  }

  const { tokenName, tokenSymbol, description } = validation.sanitized!;

  // --- Step 2b: what the launch will be priced and traded in ---
  //
  // Resolved BEFORE the splitter is deployed, because deploying costs gas and
  // refusing afterwards would have spent it for nothing.
  //
  // The pairing decides what every buyer spends to buy in, what the graduation
  // target is counted in, and what the creator and the treasury are paid in. It is
  // fixed at launch and nobody can change it afterwards -- so an asset we cannot
  // honour is a refusal, never a substitution. Launching against ETH because AAPL
  // was unavailable would be a permanent decision made on somebody's behalf.
  const launchTarget = deps.launchTarget ?? createLaunchTarget(deps.provider);
  let pairAsset: PairAsset = NATIVE_ETH_ASSET;

  if (intent.pairWith && deps.pairAssets) {
    const resolved = await deps.pairAssets.resolve(intent.pairWith);
    if (!resolved.ok) {
      notify(deps, (m) => m.onRejected(mention.tweetId, mention.authorXUserId, 'PAIR_ASSET_UNAVAILABLE'));
      const replyText = composeRejectionReply('PAIR_ASSET_UNAVAILABLE', resolved.detail);
      await replySafely(deps, mention.tweetId, replyText, {
        stage: 'pair_asset',
        requested: intent.pairWith,
      });
      return { kind: 'rejected', reason: 'PAIR_ASSET_UNAVAILABLE' };
    }
    pairAsset = resolved.asset;
  }

  // Asking for a pairing this factory cannot honour is the same refusal. v1 takes
  // its pairing from the launch config, so on v1 the only honest answer to "pair it
  // with AAPL" is no.
  if (pairAsset.address.toLowerCase() !== NATIVE_ETH && !launchTarget.supportsPairing) {
    notify(deps, (m) => m.onRejected(mention.tweetId, mention.authorXUserId, 'PAIR_ASSET_UNAVAILABLE'));
    const replyText = composeRejectionReply(
      'PAIR_ASSET_UNAVAILABLE',
      'launches here are priced in ETH right now.'
    );
    await replySafely(deps, mention.tweetId, replyText, { stage: 'pair_asset', requested: pairAsset.symbol });
    return { kind: 'rejected', reason: 'PAIR_ASSET_UNAVAILABLE' };
  }

  // --- Step 3: resolve the user's wallet, deploy the splitter, launch ---
  const wallet = await deps.walletResolver.resolve(mention.authorXUserId, mention.authorHandle);

  const launchId = `launch_${mention.tweetId}`;
  deps.db.insertLaunch({
    id: launchId,
    sourceTweetId: mention.tweetId,
    xUserId: mention.authorXUserId,
    tokenName,
    tokenSymbol,
    splitterAddress: null,
    tokenAddress: null,
    txHash: null,
    status: 'pending',
    rejectionReason: null,
    feeWeiPaid: null,
    createdAt: new Date().toISOString(),
  });

  try {
    const treasuryAddress = await deps.treasurySigner.address();

    // Placeholder token address for the splitter's constructor -- the real token address
    // doesn't exist yet at this point (it's created by the launch tx that comes next).
    // The splitter's `token` field is bookkeeping-only (see FeeSplitter.sol NatSpec), so a
    // placeholder here is safe; it gets superseded by the real launches table record either
    // way once the launch confirms.
    const { splitterAddress, deployTxHash } = await deploySplitter(
      deps.treasurySigner,
      wallet.walletAddress,
      treasuryAddress,
      ethers.ZeroAddress
    );

    const liveFee = await deps.getLiveFeeWei();
    if (liveFee > config.TREASURY_MAX_FEE_WEI) {
      // Re-check immediately before spending -- the validator already checked this, but fee
      // could theoretically move in the window between validation and execution. Belt and
      // suspenders, per Part 5's "read live, never trust a stale value" principle.
      deps.db.updateLaunchStatus(launchId, 'rejected');
      notify(deps, (m) => m.onRejected(mention.tweetId, mention.authorXUserId, 'FEE_EXCEEDS_CEILING'));
      const replyText = composeRejectionReply('FEE_EXCEEDS_CEILING');
      await replySafely(deps, mention.tweetId, replyText, { stage: 'fee_ceiling' });
      return { kind: 'rejected', reason: 'FEE_EXCEEDS_CEILING' };
    }

    // `value` is exactly the live fee. The factory treats anything above it as an initial
    // buy, so overpaying would make the treasury buy into the user's own token.
    // One wallet, not two: the factory writes the splitter to the locker as this
    // token's fee redirect, and the locker pays trading fees to it.
    const { to, data, value } = await launchTarget.build(
      {
        tokenName,
        tokenSymbol,
        description,
        splitterAddress,
        tweetId: mention.tweetId,
        pairAsset,
      },
      liveFee
    );

    const sent = await deps.treasurySigner.sendTransaction({ to, data, value });

    const receipt = await sent.wait();
    if (!receipt || receipt.status !== 1) {
      deps.db.updateLaunchStatus(launchId, 'failed', { txHash: sent.hash });
      const replyText = composeOnChainFailureReply({ reasonSummary: 'transaction reverted on-chain' });
      await replySafely(deps, mention.tweetId, replyText, { stage: 'reverted', txHash: sent.hash });
      return { kind: 'onchain_failure', detail: 'transaction reverted' };
    }

    const tokenAddress = launchTarget.extractToken(receipt.logs);
    if (!tokenAddress) {
      // Transaction succeeded but we couldn't find the expected event -- this should not
      // happen against the REAL Pons ABI once verified (see ponsEncoder.ts's warning about
      // the placeholder ABI); treat as a failure requiring investigation rather than
      // guessing an address.
      deps.db.updateLaunchStatus(launchId, 'failed', { txHash: sent.hash });
      const replyText = composeOnChainFailureReply({ reasonSummary: 'could not confirm the deployed token address' });
      await replySafely(deps, mention.tweetId, replyText, { stage: 'no_token_address', txHash: sent.hash });
      return { kind: 'onchain_failure', detail: 'token address not found in logs' };
    }

    deps.db.updateLaunchStatus(launchId, 'confirmed', {
      tokenAddress,
      txHash: sent.hash,
      feeWeiPaid: liveFee.toString(),
    });
    deps.db.recordTreasurySpend(launchId, liveFee);
    notify(deps, (m) => m.onLaunchRecorded());

    // The launch is complete and recorded at this point. The reply cannot change that, and
    // replySafely makes sure a refusal from X cannot pretend otherwise.
    const replyText = composeSuccessReply({ tokenName, tokenSymbol, tokenAddress, txHash: sent.hash });
    await replySafely(
      deps,
      mention.tweetId,
      replyText,
      { stage: 'launched', tokenAddress, txHash: sent.hash },
      () => composeSuccessReply({ tokenName, tokenSymbol, tokenAddress, txHash: sent.hash, omitAddresses: true })
    );

    return { kind: 'launched', tokenAddress, txHash: sent.hash };
  } catch (err: any) {
    deps.db.updateLaunchStatus(launchId, 'failed');
    notify(deps, (m) => m.onLaunchFailed(mention.tweetId, err?.message ?? 'unknown error'));
    const replyText = composeOnChainFailureReply({ reasonSummary: err?.message ?? 'unknown error' });
    await replySafely(deps, mention.tweetId, replyText, { stage: 'launch_threw' });
    return { kind: 'onchain_failure', detail: err?.message ?? 'unknown error' };
  }
}
