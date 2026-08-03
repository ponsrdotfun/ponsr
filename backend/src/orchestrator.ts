import { ethers } from 'ethers';
import { InboundMention } from './types';
import { Db } from './db';
import { ParserClient } from './parser';
import { validateLaunchRequest } from './validator';
import { WalletResolver } from './walletResolver';
import { XClient } from './xClient';
import { TreasurySigner } from './treasurySigner';
import { deploySplitter } from './splitterDeployer';
import { buildLaunchCalldata, extractLaunchedTokenAddress } from './ponsEncoder';
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
  /** Part 5 mitigation #5. Optional so existing callers keep working, but a
   *  production deployment must pass one -- the guards below stop an attack
   *  silently otherwise, and nobody learns it happened. */
  monitor?: TreasuryMonitor;
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
  const intent = await deps.parser.parse(mention.text);

  // --- Step 2: validation guard ---
  const validation = await validateLaunchRequest(intent, mention.authorXUserId, mention.tweetId, {
    db: deps.db,
    getAccountSignals: (id) => deps.xClient.getAccountSignals(id),
    getLiveFeeWei: deps.getLiveFeeWei,
    getTreasuryBalanceWei: deps.getTreasuryBalanceWei,
  });

  if (!validation.approved) {
    notify(deps, (m) => m.onRejected(mention.tweetId, mention.authorXUserId, validation.reason!));
    const replyText = composeRejectionReply(validation.reason!, validation.detail);
    if (replyText) {
      await deps.xClient.postReply(mention.tweetId, replyText);
    }
    return { kind: 'rejected', reason: validation.reason! };
  }

  const { tokenName, tokenSymbol, description } = validation.sanitized!;

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
      await deps.xClient.postReply(mention.tweetId, replyText);
      return { kind: 'rejected', reason: 'FEE_EXCEEDS_CEILING' };
    }

    const { data, value } = buildLaunchCalldata(
      {
        tokenName,
        tokenSymbol,
        metadataURI: description ?? '',
        creatorWallet: splitterAddress,
        feeWallet: splitterAddress,
      },
      liveFee
    );

    const sent = await deps.treasurySigner.sendTransaction({
      to: config.PONS_FACTORY_ADDRESS,
      data,
      value,
    });

    const receipt = await sent.wait();
    if (!receipt || receipt.status !== 1) {
      deps.db.updateLaunchStatus(launchId, 'failed', { txHash: sent.hash });
      const replyText = composeOnChainFailureReply({ reasonSummary: 'transaction reverted on-chain' });
      await deps.xClient.postReply(mention.tweetId, replyText);
      return { kind: 'onchain_failure', detail: 'transaction reverted' };
    }

    const tokenAddress = extractLaunchedTokenAddress(receipt.logs);
    if (!tokenAddress) {
      // Transaction succeeded but we couldn't find the expected event -- this should not
      // happen against the REAL Pons ABI once verified (see ponsEncoder.ts's warning about
      // the placeholder ABI); treat as a failure requiring investigation rather than
      // guessing an address.
      deps.db.updateLaunchStatus(launchId, 'failed', { txHash: sent.hash });
      const replyText = composeOnChainFailureReply({ reasonSummary: 'could not confirm the deployed token address' });
      await deps.xClient.postReply(mention.tweetId, replyText);
      return { kind: 'onchain_failure', detail: 'token address not found in logs' };
    }

    deps.db.updateLaunchStatus(launchId, 'confirmed', {
      tokenAddress,
      txHash: sent.hash,
      feeWeiPaid: liveFee.toString(),
    });
    deps.db.recordTreasurySpend(launchId, liveFee);
    notify(deps, (m) => m.onLaunchRecorded());

    const replyText = composeSuccessReply({ tokenName, tokenSymbol, tokenAddress, txHash: sent.hash });
    await deps.xClient.postReply(mention.tweetId, replyText);

    return { kind: 'launched', tokenAddress, txHash: sent.hash };
  } catch (err: any) {
    deps.db.updateLaunchStatus(launchId, 'failed');
    notify(deps, (m) => m.onLaunchFailed(mention.tweetId, err?.message ?? 'unknown error'));
    const replyText = composeOnChainFailureReply({ reasonSummary: err?.message ?? 'unknown error' });
    await deps.xClient.postReply(mention.tweetId, replyText);
    return { kind: 'onchain_failure', detail: err?.message ?? 'unknown error' };
  }
}
