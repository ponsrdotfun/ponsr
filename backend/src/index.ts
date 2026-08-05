import express from 'express';
import { ethers } from 'ethers';
import { config, requireConfig } from './config';
import { Db } from './db';
import { ClaudeParser } from './parser';
import { PrivyWalletResolver } from './walletResolver';
import { RealXClient } from './xClient';
import { createTreasurySigner } from './treasurySigner';
import { createProvider, getLiveFeeWei, getBalanceWei, getLaunchReadiness } from './chainClient';
import { handleMention } from './orchestrator';
import { TreasuryMonitor, ConsoleNotifier } from './monitor';
import { startReconciliation } from './reconciler';
import { checkTreasurySetup, startTreasuryWatch, treasuryPolicyFromConfig } from './treasuryPolicy';
import { InboundMention } from './types';

const app = express();
app.use(express.json());

const db = new Db(config.DATABASE_PATH);
const provider = createProvider();
const treasurySigner = createTreasurySigner(provider);
const treasuryPolicy = treasuryPolicyFromConfig();

// Part 5 mitigation #7. The monitor is constructed before the hot address is known
// (the signer answers asynchronously), so the addresses are attached below once it
// has -- they are only used to make alert text actionable, never to gate anything.
const monitor = new TreasuryMonitor(db, new ConsoleNotifier(), undefined, 30, {
  policy: treasuryPolicy,
  coldAddress: config.TREASURY_COLD_ADDRESS,
});

// Real dependencies -- see each module's TODO comments for what's still stubbed pending
// account signups (Privy, Turnkey, twitterapi.io) per Phase 0 of the implementation roadmap.
const deps = {
  db,
  parser: new ClaudeParser(requireConfig('ANTHROPIC_API_KEY')),
  walletResolver: new PrivyWalletResolver(db, config.PRIVY_APP_ID ?? '', config.PRIVY_APP_SECRET ?? ''),
  xClient: new RealXClient(requireConfig('TWITTERAPI_IO_KEY')),
  treasurySigner,
  provider,
  getLiveFeeWei: () => getLiveFeeWei(provider),
  getTreasuryBalanceWei: async () => getBalanceWei(provider, await treasurySigner.address()),
  getLaunchReadiness: async () =>
    getLaunchReadiness(provider, await treasurySigner.address(), config.PONS_LAUNCH_CONFIG_ID),
  // Part 5 mitigation #5. ConsoleNotifier is a starting point only -- Part 5 asks
  // for alerting "wired to something you'll see, not just logs no one reads", so
  // swap in a real transport (Telegram/email/pager) before mainnet. The Notifier
  // interface exists so that is a one-line change here and nothing else moves.
  monitor,
};

/**
 * Webhook endpoint that twitterapi.io (or any equivalent provider) posts mention events to.
 * The exact payload shape below is a reasonable best-effort mapping -- confirm and adjust
 * field names against twitterapi.io's actual webhook documentation once that account is set
 * up (Phase 0), since third-party providers' payload shapes are not guaranteed to match this
 * exactly.
 */
app.post('/webhook/mention', async (req, res) => {
  try {
    const body = req.body;
    const mention: InboundMention = {
      tweetId: body.id ?? body.tweet_id,
      authorXUserId: body.author?.id ?? body.author_id,
      authorHandle: body.author?.username ?? body.author_handle,
      text: body.text,
      createdAt: body.created_at ?? new Date().toISOString(),
      inReplyToTweetId: body.in_reply_to_status_id ?? null,
    };

    if (!mention.tweetId || !mention.authorXUserId || !mention.text) {
      res.status(400).json({ error: 'Malformed webhook payload -- missing required fields.' });
      return;
    }

    // Respond to the webhook immediately, process asynchronously -- most webhook providers
    // expect a fast 2xx and will retry on timeout, which would otherwise race against our
    // own idempotency claim in a confusing way. The idempotency check inside handleMention
    // still protects against genuine duplicate deliveries either way.
    res.status(202).json({ status: 'accepted' });

    const outcome = await handleMention(mention, deps);
    console.log(`[mention ${mention.tweetId}] outcome:`, outcome);
  } catch (err) {
    console.error('Unhandled error processing webhook:', err);
    // The response was already sent above, so this is server-side visibility only.
    // Failures *inside* the launch flow are reported through the monitor on `deps`;
    // this branch catches the ones that never got that far (a malformed payload,
    // a thrown parser client), which is why it is a plain log rather than an alert.
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', env: config.NODE_ENV });
});

/**
 * Part 7 §5. The webhook above is the primary path; this is the safety net for
 * when a delivery never arrives. Reprocessing is safe because the idempotency
 * claim is a DB-level constraint, so a mention the webhook already handled costs
 * nothing here. Watch the logs: repeated recoveries mean the webhook itself is
 * unhealthy and worth investigating rather than quietly relying on this.
 */
const reconciler = startReconciliation(deps, 5);

/**
 * Part 5 mitigation #7. Two distinct jobs, and both are needed:
 *
 *  - The admission check inside validator.ts only runs when someone tweets. It
 *    protects each launch, but a wallet that drains while the bot is quiet stays
 *    unnoticed until the next user is turned away.
 *  - This watch runs regardless of traffic, which is what catches a wallet being
 *    emptied at 4am and an over-funded one that has been sitting exposed.
 *
 * Neither moves money. The cold side has no signer in this process on purpose --
 * see treasuryPolicy.ts's header.
 */
const treasuryWatch = startTreasuryWatch(
  {
    getBalanceWei: deps.getTreasuryBalanceWei,
    getLiveFeeWei: deps.getLiveFeeWei,
    report: async (balanceWei, feeWei, now) => {
      await monitor.checkTreasuryBalance(balanceWei, feeWei, now);
    },
  },
  15
);

/** Configurations that make the split look present while leaving it fictional --
 *  a cold address equal to the hot one, or no cold address at all -- pass every
 *  runtime check silently. Say so loudly at boot, once, where it will be seen. */
async function reportTreasurySetup(): Promise<void> {
  const hotAddress = await treasurySigner.address();
  monitor.setTreasuryAddresses(hotAddress, config.TREASURY_COLD_ADDRESS);

  const problems = checkTreasurySetup({
    hotAddress,
    coldAddress: config.TREASURY_COLD_ADDRESS,
    policy: treasuryPolicy,
    isProduction: config.NODE_ENV === 'production',
  });
  for (const p of problems) {
    const line = `[treasury/${p.level}] ${p.message}`;
    if (p.level === 'error') console.error(line);
    else console.warn(line);
  }
  if (problems.length === 0) {
    console.log(`Hot treasury wallet ${hotAddress}; cold ${config.TREASURY_COLD_ADDRESS}.`);
  }
}

const server = app.listen(config.PORT, () => {
  console.log(`Ponsr backend listening on port ${config.PORT} (${config.NODE_ENV})`);
  console.log('Reconciliation sweep every 5 minutes. Treasury balance watch every 15 minutes.');
  reportTreasurySetup().catch((err) =>
    console.error('[treasury] could not verify hot/cold setup at boot:', err?.message ?? err)
  );
});

// Stop cleanly so an in-flight launch isn't cut off mid-transaction on redeploy.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down.`);
    reconciler.stop();
    treasuryWatch.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
