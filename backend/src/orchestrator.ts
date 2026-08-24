import { ethers } from 'ethers';
import { InboundMention } from './types';
import { Db } from './db';
import { ParserClient } from './parser';
import { validateLaunchRequest } from './validator';
import { WalletResolver } from './walletResolver';
import { XClient } from './xClient';
import { TreasurySigner } from './treasurySigner';
import { deploySplitter } from './splitterDeployer';
import { assertDeploymentIdentity } from './deploymentIdentity';
import { executableDeployment, PonsDeployment } from './deployments';
import { EMPTY_SOCIALS, buildLaunchCalldata, extractLaunchedTokenAddress, saltForTweet } from './ponsEncoder';
import { LaunchTarget, createLaunchTarget } from './launchTarget';
import { NATIVE_ETH, PairAsset, PairResolution } from './pairTokens';
import { launchSalt, DecodedCurrentV2Launch, PONS_V2_CURRENT_ABI } from './ponsV2CurrentEncoder';
import {
  assertPairStillApproved,
  verifyLaunchConfirmation,
  FactoryLaunchRecord,
  assertOutgoingLaunch,
  extractLaunchFromReceipt,
  reconcileReceipt,
} from './launchAssertions';
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
  /**
   * The live launch fee, for the deployment this launch is going to.
   *
   * It took no argument and read whichever factory `chainClient` considered active --
   * which is derived from the global flag, not from the target the orchestrator chose.
   * A v1 rollback with the flag on v2 priced the launch from the wrong contract.
   */
  getLiveFeeWei: (deployment?: PonsDeployment) => Promise<bigint>;
  /** Hot treasury balance, read live (Part 5 mitigation #7). Backs the admission
   *  check in validator.ts that stops the bot spending money it does not have. */
  getTreasuryBalanceWei: () => Promise<bigint>;
  /** Whether THIS deployment would accept a launch right now. Same reasoning as the
   *  fee above: readiness read from a global describes a contract nobody is calling. */
  getLaunchReadiness: (deployment?: PonsDeployment) => Promise<{
    canLaunch: boolean;
    launchConfigUsable: boolean;
    dexConfigUsable?: boolean;
    reason?: string;
  }>;
  /**
   * Ponsr's own public-launch switch. Required so every caller must choose; omission
   * cannot become an accidental fail-open path. False stops before paid parsing,
   * wallet creation, chain reads, splitter deployment, signing, or broadcast.
   */
  publicLaunchEnabled: boolean;
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
  /**
   * Proves the factory on chain is still the one the registry describes, immediately
   * before the splitter -- the first durable artifact -- is deployed.
   *
   * Injected like every other chain-facing dependency here, and defaulted to the real
   * check. A test that passes `provider: {} as any` is not exercising this, and saying
   * so explicitly is better than a stub that quietly answers yes.
   */
  verifyIdentity?: (provider: ethers.Provider) => Promise<void>;
  /**
   * Re-reads the selected pair's approval from the chain immediately before the first
   * durable side effect.
   *
   * The registry caches approvals for an hour, which is right -- but a cache is a
   * statement about the past, and pons revokes assets. A revocation inside that window
   * bought a splitter and then reverted the launch. Injected like every other
   * chain-facing dependency, and defaulted to the real read.
   */
  assertPairApproved?: (deployment: PonsDeployment, pairToken: string) => Promise<void>;
  /**
   * The factory's own record of a launch, read AFTER the receipt.
   *
   * The receipt is what the factory announced; this is what it will tell anyone who
   * asks later, and it carries `creatorFeeRecipient` -- the field a creator's share
   * depends on for the life of the token. Injected like every other chain read.
   */
  readLaunchRecord?: (
    deployment: PonsDeployment,
    token: string
  ) => Promise<FactoryLaunchRecord | null>;
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
  | { kind: 'onchain_failure'; detail: string }
  /**
   * The transaction landed but the sources disagree about what it did.
   *
   * Distinct from `onchain_failure` on purpose: nothing failed. A token exists and
   * the fee is spent. What is missing is agreement between the calldata, the event
   * and the factory's record -- so nobody can yet say what was launched. Reporting
   * that as a failure would be a second, larger error.
   */
  | { kind: 'incident'; detail: string; txHash: string; tokenAddress: string | null };

export async function handleMention(mention: InboundMention, deps: OrchestratorDeps): Promise<OrchestratorOutcome> {
  // --- Step 1: idempotency, atomic, before anything else runs ---
  const claimed = deps.db.claimTweetForProcessing(mention.tweetId);
  if (!claimed) {
    return { kind: 'duplicate' };
  }

  // Ponsr's gate, independent of pons's factory permission. Production passes this
  // explicitly from config and defaults it off. Keep the atomic claim so a paused
  // backlog is not replayed as a launch storm when the operator later enables public
  // launching. Stop before the paid parser, wallet creation, chain reads, splitter,
  // signer, or reply writer; at this point we do not even know this is a launch intent.
  if (!deps.publicLaunchEnabled) {
    return { kind: 'rejected', reason: 'PUBLIC_LAUNCH_PAUSED' };
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

  /** The calldata actually sent, decoded, so the receipt can be reconciled against
   *  it rather than against what the code intended. */
  let sentCalldata: DecodedCurrentV2Launch | null = null;

  // --- Step 2: choose the deployment, BEFORE anything is asked about it ---
  //
  // Selection used to happen after validation, so readiness and the live fee were read
  // from whichever factory the global flag considered active while the launch was built
  // for the target chosen later. Those two can differ -- a v1 rollback with the flag on
  // v2 priced the launch from a contract it never called, and asked that contract's
  // permission instead of the one it needed.
  //
  // One selected deployment, resolved once, carried through everything downstream:
  // readiness, fee, identity, splitter type, escrow, calldata, send, receipt, provenance.
  const launchTarget = deps.launchTarget ?? createLaunchTarget(deps.provider);
  const selected = launchTarget.deployment;
  if (!selected) {
    // A target that cannot say which deployment it addresses is one no guard can be
    // aimed at, and the only alternative -- falling back to a global -- is the defect
    // this binding exists to remove. Refuse before the claim is consumed further.
    deps.db.releaseTweetClaim(mention.tweetId);
    throw new Error(
      `launch target (${launchTarget.version}) names no deployment, so its identity cannot ` +
        'be verified. Refusing before anything is deployed or spent.'
    );
  }

  // --- Step 3: validation guard, against the SELECTED deployment ---
  const validation = await validateLaunchRequest(intent, mention.authorXUserId, mention.tweetId, {
    db: deps.db,
    getAccountSignals: (id) => deps.xClient.getAccountSignals(id, mention.authorHandle),
    // Both bound to the deployment this launch is going to, rather than to whatever
    // the global flag considers active.
    getLiveFeeWei: () => deps.getLiveFeeWei(selected),
    getTreasuryBalanceWei: deps.getTreasuryBalanceWei,
    getLaunchReadiness: () => deps.getLaunchReadiness(selected),
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
    // The pair, re-read from the chain.
    //
    // `pairAssets.resolve` answered from a cache up to an hour old. pons revokes assets
    // -- RIVN was approved and then revoked -- and a revocation inside that window means
    // the splitter below is bought and paid for against a launch that must revert.
    const assertPair =
      deps.assertPairApproved ??
      (async (d: PonsDeployment, pairToken: string) => {
        const f = new ethers.Contract(
          d.factory,
          ['function approvedPairTokens(address) view returns (bool)'],
          deps.provider
        );
        await assertPairStillApproved(f as never, pairToken, d);
      });
    await assertPair(selected, pairAsset.address);

    // Identity, immediately before the first DURABLE artifact of this launch exists.
    //
    // Readiness verified it earlier, but readiness and this deploy are two moments and
    // only one of them spends gas. A factory upgraded, an RPC repointed at another
    // chain, an ABI regenerated -- all of it lands in the window between, and a splitter
    // bound to a factory that has since moved is not a wasted fee: it is a contract that
    // may be handed a creator's fees and be unable to claim them.
    //
    // Injected like every other chain-facing dependency in this file, so the
    // orchestration tests can state plainly that they are not exercising it.
    // The deployment THIS launch is going to, taken from the target that will build the
    // calldata -- never from `executableDeployment()`.
    //
    // Those two can differ. `createLaunchTarget` returns V1 under rollback, and
    // `deps.launchTarget` can be injected outright. Reading the global here verified the
    // current V2 factory's hashes, escrow and chain and then sent a transaction
    // somewhere else, with every tick green. A check for one deployment must never
    // authorise a transaction to another.
    const verifyIdentity =
      deps.verifyIdentity ?? ((p: ethers.Provider) => assertDeploymentIdentity(selected, p));
    await verifyIdentity(deps.provider);

    /**
     * Identity again, immediately before the deploy.
     *
     * The first check happens before the pair read; this one happens with nothing between
     * it and the transaction. That gap is short but not zero, and a factory upgrade or a
     * repointed RPC landing inside it produces a splitter bound to a deployment that has
     * already moved -- the first artifact of this launch that cannot be undone.
     *
     * Two reads of the same answer cost one RPC round trip. The interval they remove is
     * one nobody can bound.
     */
    await verifyIdentity(deps.provider);

    const { splitterAddress, deployTxHash } = await deploySplitter(
      deps.treasurySigner,
      wallet.walletAddress,
      treasuryAddress,
      ethers.ZeroAddress,
      // Not the provider: the second check runs above, through the same injected seam,
      // so `deploySplitter` is not asked to re-derive it from module state.
      undefined,
      // The SELECTED deployment, so the escrow baked immutably into this splitter comes
      // from the same place the calldata will. Reading module state here was how a
      // splitter could be bound to the current escrow during a v1 rollback.
      selected
    );

    // Priced from the deployment this launch is actually going to.
    const liveFee = await deps.getLiveFeeWei(selected);
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

    // Written before the transaction is sent, so a launch that reverts still leaves
    // evidence of which deployment it was aimed at -- the case where knowing that
    // matters most, because the reason is usually that it was aimed at the wrong one.
    {
      const d = selected;

      /**
       * Read out of the calldata that is about to be sent, not recomputed.
       *
       * These fields used to come from the registry and from global config: the
       * selector was `d.launchSelector`, the salt was recomputed from the tweet id, and
       * the launch config was `config.PONS_LAUNCH_CONFIG_ID` even when the request
       * carried an override. All three describe what the code MEANT to build, written
       * beside a transaction hash as though they described what went out.
       *
       * If the encoder and the registry ever disagree -- the exact class of failure this
       * migration is about -- a record derived from the registry agrees with the bug and
       * hides it. `data` is the only witness to what was actually sent.
       *
       * Decoding is best-effort by deployment schema: v1 has a different shape, and a
       * record that says less is better than one that says something untrue.
       */
      let decoded: DecodedCurrentV2Launch | null = null;
      if (d.tokenParamsVersion === 'v2-salt') {
        // MANDATORY, and it throws.
        //
        // This used to be best-effort: a decode failure was logged and provenance fell
        // back to recomputed intentions. Wrong direction. If the encoder produced bytes
        // this deployment's ABI cannot read, the bytes are not what anyone thinks they
        // are, and the answer to "I cannot read what I am about to send" is to stop.
        //
        // It also checks the destination and that the calldata names the splitter just
        // deployed -- the field that decides where a creator's fees go for the life of
        // the token.
        decoded = assertOutgoingLaunch({ to, data, value }, splitterAddress, d);
        sentCalldata = decoded;
      }

      deps.db.recordLaunchProvenance(launchId, {
        deploymentId: d.id,
        factory: d.factory,
        feeEscrow: d.feeEscrow,
        chainId: d.chainId,
        // The treasury, not the X user. Through the direct path the factory records
        // its caller as the launch's deployer; the user receives the creator share
        // through the splitter. No reply or document may say otherwise.
        originalDeployer: treasuryAddress,
        pairToken: decoded?.pairToken ?? pairAsset.address,
        launchConfigId:
          decoded?.launchConfigId ??
          String(config.PONS_LAUNCH_CONFIG_ID),
        salt: decoded?.salt ?? (d.tokenParamsVersion === 'v2-salt' ? launchSalt(d, mention.tweetId) : ''),
        // Null only when it genuinely could not be read -- a v1 launch, or calldata this
        // deployment's ABI cannot decode. Never null merely because nobody wired it up.
        economicsDigest: decoded?.expectedEconomics ?? null,
        // Filled in from the receipt once the launch confirms. A curve address does not
        // exist before the transaction lands, so recording one here would be a guess.
        curve: null,
        // The splitter, because it is the only address that can ever claim this
        // launch's fees out of the escrow: claims pay `msg.sender` and there is no
        // `claimFor`. Recovering it later from a receipt is possible and is exactly
        // the archaeology nobody performs when a creator asks where their fees went.
        splitter: splitterAddress,
        // The four bytes that are actually going out.
        launchSelector: decoded?.selector ?? data.slice(0, 10),
        tokenParamsVersion: d.tokenParamsVersion,
      });
    }

    const sent = await deps.treasurySigner.sendTransaction({ to, data, value });

    const receipt = await sent.wait();
    if (!receipt || receipt.status !== 1) {
      deps.db.updateLaunchStatus(launchId, 'failed', { txHash: sent.hash });
      const replyText = composeOnChainFailureReply({ reasonSummary: 'transaction reverted on-chain' });
      await replySafely(deps, mention.tweetId, replyText, { stage: 'reverted', txHash: sent.hash });
      return { kind: 'onchain_failure', detail: 'transaction reverted' };
    }

    /**
     * Who is allowed to name the launched token.
     *
     * `launchTarget.extractToken` decodes the FIRST log that parses as `TokenLaunched`,
     * from any emitter. That signature is not unique to pons, so a foreign contract's
     * identically shaped event -- ordered before the real one -- became the persisted
     * token, the success reply, and the address a creator would later be told to claim
     * against. The correctly scoped decoder ran afterwards and could only complain about
     * a record already written.
     *
     * For the deployment that credits an escrow, the scoped decoder is the SOLE
     * authority: logs from `selected.factory` and nowhere else. v1 keeps its own
     * extractor, which reads a different event shape from a different contract.
     */
    const scoped =
      selected.tokenParamsVersion === 'v2-salt'
        ? extractLaunchFromReceipt((receipt.logs ?? []) as never, selected)
        : null;
    const tokenAddress =
      selected.tokenParamsVersion === 'v2-salt'
        ? scoped?.token ?? null
        : launchTarget.extractToken(receipt.logs);
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

    /**
     * Everything must agree before the word "confirmed" is used.
     *
     * The row used to be marked confirmed here, and reconciliation ran afterwards --
     * logging on disagreement while the success reply went out anyway. So "confirmed"
     * meant "an event of the right shape arrived from the right address", and a clean
     * launch was indistinguishable in the database from one nobody had checked.
     *
     * Three sources: the calldata we sent, the event the factory announced, and the
     * record the factory will give anyone who asks later. The record is the one that
     * decides where a creator's fees go.
     */
    if (selected.tokenParamsVersion === 'v2-salt' && scoped && sentCalldata) {
      const readRecord =
        deps.readLaunchRecord ??
        (async (d: PonsDeployment, token: string) => {
          const f = new ethers.Contract(d.factory, PONS_V2_CURRENT_ABI, deps.provider);
          const raw = await f.getLaunchedToken(token);
          return {
            token: String(raw.token ?? raw[0]),
            curve: String(raw.curve ?? raw[1]),
            deployer: String(raw.deployer ?? raw[2]),
            creatorFeeRecipient: String(raw.creatorFeeRecipient ?? raw[3]),
            pairToken: String(raw.pairToken ?? raw[4]),
            exists: Boolean(raw.exists ?? raw[14]),
          };
        });

      let record: FactoryLaunchRecord | null = null;
      try {
        record = await readRecord(selected, scoped.token);
      } catch (err: any) {
        // Left null deliberately. "I could not read it" is a distinct answer from "it
        // disagrees", and the verdict below says so rather than assuming either.
        console.error(`[confirm] could not read the launch record: ${err?.message ?? err}`);
      }

      const verdict = verifyLaunchConfirmation({
        receipt: scoped,
        sent: sentCalldata,
        record,
        splitterAddress,
        treasuryAddress,
      });

      if (!verdict.ok) {
        // The transaction landed and the token exists. Recording it as `failed` would be
        // a lie in the other direction, so the row keeps the hash and the token it saw
        // and is marked for a person to look at.
        const detail = verdict.problems.join('; ');
        deps.db.updateLaunchStatus(launchId, 'incident', {
          tokenAddress,
          txHash: sent.hash,
          feeWeiPaid: liveFee.toString(),
        });
        // The transaction succeeded and consumed the launch fee even though its
        // accounting evidence is not yet trustworthy. The daily circuit breaker must
        // see that spend; this insert is idempotent for later reconciliation retries.
        deps.db.recordTreasurySpend(launchId, liveFee);
        deps.db.recordRejection(mention.tweetId, mention.authorXUserId, `INCIDENT: ${detail}`);

        console.error(`[confirm] ${launchId} landed but does not reconcile:`);
        for (const p of verdict.problems) console.error(`  - ${p}`);
        notify(deps, (m) =>
          m.onReplyFailed(mention.tweetId, 'launch landed but does not reconcile', {
            stage: 'confirm_gate',
            txHash: sent.hash,
            tokenAddress,
            problems: verdict.problems,
          })
        );

        // Said plainly, and without the normal success wording: something happened, it
        // is being looked at, and no claim is made about what was launched.
        await replySafely(
          deps,
          mention.tweetId,
          composeOnChainFailureReply({
            reasonSummary: 'the launch went through but the records do not yet agree',
          }),
          { stage: 'confirm_gate', txHash: sent.hash }
        );
        return {
          kind: 'incident',
          detail,
          txHash: sent.hash,
          tokenAddress,
        };
      }
    }

    deps.db.updateLaunchStatus(launchId, 'confirmed', {
      tokenAddress,
      txHash: sent.hash,
      feeWeiPaid: liveFee.toString(),
    });

    // The bonding curve, from the receipt's own event.
    //
    // It cannot be known before the transaction lands, so provenance was written with
    // `curve: null` and is completed here. Recording a predicted address earlier would
    // put a value in a money-related record that no chain event ever produced -- and
    // `curve` was documented as lineage while being permanently null, which is worse
    // than an admitted gap.
    if (selected.tokenParamsVersion === 'v2-salt') {
      // Logs ONLY from the factory that was addressed.
      //
      // A receipt carries every log every contract in the transaction raised, and
      // `TokenLaunched` has one signature across both V2 deployments -- so a log of that
      // shape from any contract would decode cleanly and be read as this launch's token.
      // Already decoded above, where it decided the token. Re-deriving would invite
      // the two to disagree.
      const fromFactory = scoped;

      if (!fromFactory) {
        // The launch confirmed, so this is not a failure of the launch. It is a failure
        // to account for it, which an operator has to see.
        console.error(
          `[receipt] ${launchId} confirmed but ${selected.id} raised no TokenLaunched we could read`
        );
        notify(deps, (m) =>
          m.onReplyFailed(mention.tweetId, 'no TokenLaunched from the selected factory', {
            stage: 'receipt_reconcile',
            txHash: sent.hash,
          })
        );
      } else {
        if (fromFactory.curve) deps.db.updateLaunchProvenanceCurve(launchId, fromFactory.curve);

        // What came back, against what went out. A disagreement does not make the launch
        // untrue -- the token exists and the fee is spent -- it means the record is wrong
        // or the event is not ours. Either is an incident, not a partial success.
        if (sentCalldata) {
          const problems = reconcileReceipt(fromFactory, sentCalldata, treasuryAddress);
          if (problems.length > 0) {
            console.error(`[receipt] ${launchId} does not reconcile with what was sent:`);
            for (const p of problems) console.error(`  - ${p}`);
            notify(deps, (m) =>
              m.onReplyFailed(mention.tweetId, 'launch receipt does not reconcile', {
                stage: 'receipt_reconcile',
                txHash: sent.hash,
                problems,
              })
            );
          }
        }
      }
    }
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
