import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import { config, requireConfig } from './config';
import { Db } from './db';
import { createParser } from './parser';
import { PrivyWalletResolver } from './walletResolver';
import { createXClient } from './xClient';
import { createTreasurySigner } from './treasurySigner';
import { createProvider, getLiveFeeWei, getBalanceWei, getLaunchReadiness, getSwitchState } from './chainClient';
import { handleMention } from './orchestrator';
import { TreasuryMonitor, createNotifier } from './monitor';
import { startReconciliation } from './reconciler';
import { checkTreasurySetup, startTreasuryWatch, treasuryPolicyFromConfig } from './treasuryPolicy';
import { InboundMention } from './types';
import { webhookAuthorised } from './webhookAuth';
import { startMentionCrossCheck } from './mentionCrossCheck';
import { buildStatus, statusHttpCode } from './statusReport';
import { startLaunchpadWatch } from './launchpadWatch';
import { PairAssetRegistry } from './pairTokens';
import { ChainPairTokenSource } from './pairTokenSource';
import { createLaunchTarget } from './launchTarget';

const app = express();
app.use(express.json());

/**
 * The database is not a cache, and losing it is not a cosmetic failure.
 *
 * `processed_tweets` is the idempotency key for every mention, and `treasury_spend_log` is
 * what the daily circuit breaker counts against. On a container filesystem that resets each
 * deploy, both reset too: previously-handled mentions become eligible for reprocessing, and
 * the day's spend returns to zero. Nothing errors. The bot relaunches tokens it already
 * launched, paying the fee again each time, and the cap that was meant to bound the damage
 * has just been cleared.
 *
 * There is no portable way to ask whether a path is on a persistent mount, so this checks the
 * two things that are actually knowable: that the path was configured at all, and that it can
 * be written to. A production deploy still holding the development default is the specific
 * mistake worth catching, because it is what happens when the container runs but nobody set
 * DATABASE_PATH.
 */
function reportStorage(): void {
  const isProduction = config.NODE_ENV === 'production';
  const isDefault = config.DATABASE_PATH === './data/bot.sqlite';

  if (isProduction && isDefault) {
    console.error(
      '[storage/error] DATABASE_PATH is still the development default in production. If this ' +
        'is a container, the database is inside it and every redeploy wipes the idempotency ' +
        'record and the daily spend total. Point it at a mounted volume (fly.toml uses ' +
        '/data/bot.sqlite).'
    );
  }

  try {
    const dir = path.dirname(path.resolve(config.DATABASE_PATH));
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    // Says "configured", not "persistent": this cannot verify that the path is a real mount,
    // and a log line claiming otherwise would be the kind of unearned reassurance that makes
    // an operator stop checking.
    console.log(`Database at ${config.DATABASE_PATH}${isProduction && !isDefault ? ' (configured, not the default)' : ''}.`);
  } catch (err: any) {
    console.error(`[storage/error] cannot write to the database directory: ${err?.message ?? err}`);
    if (isProduction) {
      // Refuse to start, the same way a missing parser credential does.
      //
      // Continuing is worse than crashing here. A read-only or root-owned mount yields a
      // process that listens, accepts mentions, spends the launch fee and then cannot record
      // that it did -- so idempotency is silently gone and the next sweep launches the same
      // request again. Observed: with a :ro mount the process reported this and carried on
      // listening quite happily.
      console.error('[storage/error] refusing to start in production without a writable database.');
      process.exit(1);
    }
  }
}

reportStorage();
const db = new Db(config.DATABASE_PATH);
const provider = createProvider();
const treasurySigner = createTreasurySigner(provider);
const treasuryPolicy = treasuryPolicyFromConfig();

// Part 5 mitigation #7. The monitor is constructed before the hot address is known
// (the signer answers asynchronously), so the addresses are attached below once it
// has -- they are only used to make alert text actionable, never to gate anything.
// One transport, shared. The treasury monitor and the mention sweep both need to reach the
// operator, and two instances would mean two places to change when the transport changes.
const notifier = createNotifier();

const monitor = new TreasuryMonitor(db, notifier, undefined, 30, {
  policy: treasuryPolicy,
  coldAddress: config.TREASURY_COLD_ADDRESS,
});

// Real dependencies -- see each module's TODO comments for what's still stubbed pending
// account signups (Privy, Turnkey, twitterapi.io) per Phase 0 of the implementation roadmap.
/**
 * Which assets a launch may be priced in.
 *
 * Only v2 can pair against anything but ETH, so there is nothing to discover on v1
 * and no reason to spend a log scan finding that out. Discovery is lazy: the first
 * mention asking for a pairing pays for it, and an hourly TTL covers the rest.
 */
const pairAssets =
  config.PONS_FACTORY_VERSION === 'v2'
    ? new PairAssetRegistry(
        new ChainPairTokenSource({
          provider,
          factoryAddress: config.PONS_V2_FACTORY_ADDRESS,
          fromBlock: config.PONS_V2_APPROVALS_FROM_BLOCK,
        })
      )
    : undefined;

const launchTarget = createLaunchTarget(provider);

const deps = {
  pairAssets,
  launchTarget,
  db,
  parser: (() => {
    const p = createParser();
    // Refuse to boot rather than start and fail on the first mention. Without a parser the
    // bot can accept tweets and do nothing with them, which looks like the bot ignoring users.
    if (!p) throw new Error('No parser credential. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.');
    return p;
  })(),
  walletResolver: new PrivyWalletResolver(db, config.PRIVY_APP_ID ?? '', config.PRIVY_APP_SECRET ?? ''),
  xClient: createXClient(),
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
    if (!webhookAuthorised(req, config.WEBHOOK_SECRET)) {
      // Deliberately terse. A response that distinguished "no secret configured" from "wrong
      // secret" would tell an attacker which of the two they are up against.
      console.warn(`[webhook] rejected an unauthorised POST from ${req.ip}`);
      res.status(401).json({ error: 'unauthorised' });
      return;
    }

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

/**
 * Deliberately shallow, and it must stay that way.
 *
 * This is Fly's health check, and Fly restarts the machine when it fails. A
 * restart fixes a crashed process; it does nothing about an RPC outage, an
 * exhausted parser balance or a launchpad pons has switched off, so checking
 * those here would convert somebody else's downtime into a crash loop of ours.
 * `/status` is where the real state is reported.
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', env: config.NODE_ENV });
});

/**
 * The real state, for a person or an uptime monitor that cannot restart anything.
 *
 * Unauthenticated on purpose: everything below is already public on chain, and
 * the only way to authenticate a URL somebody opens in a browser is to put a
 * secret in a query string, which writes it into every proxy log in between.
 */
app.get('/status', async (_req, res) => {
  try {
    const report = await buildStatus({
      expectedChainId: config.CHAIN_ID,
      getChainId: async () => Number((await provider.getNetwork()).chainId),
      getBlockNumber: () => provider.getBlockNumber(),
      getTreasuryBalanceWei: deps.getTreasuryBalanceWei,
      getLiveFeeWei: deps.getLiveFeeWei,
      getLaunchReadiness: deps.getLaunchReadiness,
      // The same window the circuit breaker counts, so the page cannot disagree
      // with the thing actually refusing launches.
      spentTodayWei: () => db.totalSpendBetween(startOfUtcDay(), new Date().toISOString()),
      dailyCapWei: config.DAILY_SPEND_CAP_WEI,
      launchesToday: () => db.countLaunchesBetween(startOfUtcDay(), new Date().toISOString()),
      coldAddressSet: !!config.TREASURY_COLD_ADDRESS,
      parserRoute: config.ANTHROPIC_API_KEY ? 'Anthropic (direct)' : 'OpenRouter',
      alertsRoute: config.TELEGRAM_BOT_TOKEN ? 'Telegram' : 'console only -- alerts go nowhere a person will see',
      crossCheckHours: config.X_BEARER_TOKEN ? config.MENTION_CROSSCHECK_HOURS : 0,
      factoryVersion: config.PONS_FACTORY_VERSION,
      listPairAssets: pairAssets ? async () => (await pairAssets.list()).map((a) => a.symbol) : undefined,
    });
    res.status(statusHttpCode(report)).json(report);
  } catch (err) {
    // buildStatus is written not to throw; if it does, saying so beats a 500 with
    // no body, which is indistinguishable from the process being gone.
    res.status(503).json({ state: 'down', error: String((err as Error)?.message ?? err) });
  }
});

function startOfUtcDay(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * Part 7 §5. The webhook above is the primary path; this is the safety net for
 * when a delivery never arrives. Reprocessing is safe because the idempotency
 * claim is a DB-level constraint, so a mention the webhook already handled costs
 * nothing here. Watch the logs: repeated recoveries mean the webhook itself is
 * unhealthy and worth investigating rather than quietly relying on this.
 */
const reconciler = startReconciliation(deps, config.MENTION_POLL_SECONDS / 60, undefined, notifier);

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

/**
 * The one failure that looks exactly like nobody tweeting.
 *
 * The sweep hears through twitterapi.io. When their search stops indexing this
 * account -- observed on 2026-08-12, and documented by them for new accounts -- it
 * keeps succeeding and keeps returning nothing, which no amount of error handling
 * can distinguish from a quiet day. A second source is the only way to know.
 *
 * Off unless a bearer token exists, since the check is billed per post read.
 */
const crossCheck =
  config.X_BEARER_TOKEN && config.MENTION_CROSSCHECK_HOURS > 0
    ? startMentionCrossCheck(
        { db, bearerToken: config.X_BEARER_TOKEN, botHandle: config.BOT_X_HANDLE },
        notifier,
        config.MENTION_CROSSCHECK_HOURS
      )
    : null;

/**
 * The switch that is not ours to hold.
 *
 * pons turned launching off on 2026-08-12 at 19:42 UTC, on both factories, and
 * nothing here noticed for three days. The bot behaved correctly throughout --
 * the readiness check refuses before any money moves, and the person is told the
 * cause is upstream -- but a closed launchpad with no traffic is indistinguishable
 * from an open one with no traffic, so nobody found out. It runs on a timer for
 * exactly that reason: waiting for a mention would mean waiting for the failure.
 */
// Both factories are watched, not just the one the bot launches through. The
// whitelist actually being waited on is a **v2** grant while the bot still runs v1,
// so a watch that only read v1 would miss the exact event it exists to catch. Each
// alert names its factory: two watches sending identical text would send somebody
// to check the wrong contract.
const launchpadWatches = [
  { label: 'the v1 factory', address: config.PONS_FACTORY_ADDRESS },
  { label: 'the v2 factory', address: config.PONS_V2_FACTORY_ADDRESS },
].map(({ label, address }) =>
  startLaunchpadWatch(
    { getLaunchReadiness: async () => getSwitchState(provider, address, await treasurySigner.address()) },
    notifier,
    15,
    label
  )
);

// Checked at boot as well as on the timer. The alternative is a fifteen-minute
// blind spot after every deploy, and the state at boot is the one an operator is
// most likely to be asking about -- they just deployed. The cost is that a deploy
// while the launchpad is closed re-alerts, since the process starts with no memory
// of having said it. Deploys are rare and the condition is critical; a duplicate
// is the right side to err on.
const server = app.listen(config.PORT, () => {
  launchpadWatches.forEach((w) => void w.check());
  console.log(`Ponsr backend listening on port ${config.PORT} (${config.NODE_ENV})`);
  console.log(`Mention sweep every ${config.MENTION_POLL_SECONDS}s. Treasury balance watch every 15 minutes.`);
  console.log(
    crossCheck
      ? `Cross-checking against X's own mentions every ${config.MENTION_CROSSCHECK_HOURS}h.`
      : '[crosscheck/warn] disabled -- without it, a mention search that silently stops indexing this account is undetectable.'
  );
  // Say this at boot rather than leaving it to be discovered when a webhook silently 401s.
  if (!config.WEBHOOK_SECRET) {
    console.error(
      '[webhook/error] WEBHOOK_SECRET is not set, so /webhook/mention refuses every request. ' +
        'Mentions still arrive via the 5-minute reconciliation sweep, just later.'
    );
  } else {
    console.log('Webhook authentication is on.');
  }
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
    launchpadWatches.forEach((w) => w.stop());
    if (crossCheck) crossCheck.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
