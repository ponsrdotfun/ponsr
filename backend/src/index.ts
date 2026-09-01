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
import { AccountClaimService } from './accountClaim';
import { createProvider, getLiveFeeWei, getBalanceWei, getLaunchReadiness, getSwitchState } from './chainClient';
import { probeLaunchPermission } from './readinessProbe';
import { RpcPool, parseChainId, parseEndpointList } from './rpcPool';
import { RpcEndpointDescription } from './rpcIdentity';
import { IdentityWatch } from './identityWatch';
import { handleMention } from './orchestrator';
import { TreasuryMonitor, createNotifier } from './monitor';
import { startReconciliation, ReconcilerHandle } from './reconciler';
import { pinnedTreasuryAddress } from './canarySignerBoundary';
import { checkTreasurySetup, startTreasuryWatch, treasuryPolicyFromConfig } from './treasuryPolicy';
import { InboundMention } from './types';
import { webhookAuthorised } from './webhookAuth';
import { startMentionCrossCheck } from './mentionCrossCheck';
import { statusHandler, statusCoreHandler } from './statusRoutes';
import { assembleCore, assembleStatus, AcquiredSession } from './statusSession';
import { startLaunchpadWatch } from './launchpadWatch';
import { PairAssetRegistry } from './pairTokens';
import { ChainPairTokenSource } from './pairTokenSource';
import { createLaunchTarget } from './launchTarget';
import { executableDeployment, deploymentById, PonsDeployment } from './deployments';
import { readCurrentReadiness } from './currentReadiness';
import { FixedWindowRateLimit } from './webhookRateLimit';
import { AccountAuthService, XOAuthProvider } from './accountAuth';
import { accountRouter } from './accountRoutes';

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

/**
 * A second opinion for the READ path only, and deliberately not for the launch path.
 *
 * Every endpoint is admitted before it answers -- chain id and factory bytecode must match
 * the registry -- so a fallback cannot move the bot onto a different chain or a forked
 * state. Empty by default: one endpoint remains the behaviour until an operator adds one.
 *
 * The launch path keeps the single pinned `provider` above, on purpose. Failing over
 * mid-launch means a nonce reserved against one node and a transaction broadcast through
 * another, and the canary's whole ambiguity model assumes one view of the chain. Making
 * that path resilient is a financial-path change and needs its own review, not a quiet
 * ride-along with a status-page fix.
 */
const rpcPool = new RpcPool(parseEndpointList(config.RPC_URL, config.RPC_FALLBACK_URLS));

/** The fingerprint of whichever endpoint answered, for binding caches and labelling views. */
function endpointFingerprint(e: RpcEndpointDescription): string {
  return e.fingerprint;
}

/** Deployment identity, cached with a published age, off the launchpad check's deadline. */
const identityWatch = new IdentityWatch();
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

// Every external dependency here is live and verified against the real service, not a
// stub: Privy creates real wallets, Turnkey signs under a policy that has been proven to
// bite, and twitterapi.io returns correctly-mapped fields. The Phase 0 signups this
// comment used to warn about were all completed on 2026-08-06.
/**
 * Which assets a launch may be priced in.
 *
 * Only v2 can pair against anything but ETH, so there is nothing to discover on v1
 * and no reason to spend a log scan finding that out. The set is discovered once at
 * boot (below) and refreshed on an hourly TTL.
 */
const pairAssets = (() => {
  const d = executableDeployment();
  // From the deployment's own capability, not an environment string. v1 prices every
  // launch from its launch config, so there is nothing to discover and no reason to spend
  // a log scan finding that out; the current v2 approves a set and can revoke from it.
  if (d.tokenParamsVersion === 'v1') return undefined;
  return new PairAssetRegistry(
    new ChainPairTokenSource({
      provider,
      // From the registry, not from configuration. Approvals belong to the deployment
      // that emitted them: the superseded factory approved eight assets, the current
      // one approves twenty-three and has already revoked one. Reading the old
      // factory's log would offer a set that is both too small and, for anything
      // revoked, wrong -- and wrong here means a launch that reverts after the
      // splitter has been deployed and paid for.
      // The deployment itself, so the address, the ABI and the start block cannot
      // disagree. Passing an address and a block separately was two chances to name
      // different contracts.
      deployment: d,
    })
  );
})();

const launchTarget = createLaunchTarget(provider);
const walletResolver = new PrivyWalletResolver(db, config.PRIVY_APP_ID ?? '', config.PRIVY_APP_SECRET ?? '');
const accountAuth = new AccountAuthService(
  db,
  walletResolver,
  new XOAuthProvider(config.X_OAUTH_CLIENT_ID ?? '', config.X_OAUTH_CLIENT_SECRET ?? ''),
  {
    enabled: config.ACCOUNT_AUTH_ENABLED,
    clientId: config.X_OAUTH_CLIENT_ID ?? '',
    clientSecret: config.X_OAUTH_CLIENT_SECRET ?? '',
    callbackUrl: config.X_OAUTH_CALLBACK_URL ?? '',
    siteOrigin: config.ACCOUNT_SITE_ORIGIN,
    walletContinuityConfigured: !!config.PRIVY_APP_ID && !!config.PRIVY_APP_SECRET,
  }
);
/**
 * Claiming is wired here because it needs the same provider and signer the
 * launch path already uses -- one chain view and one signer, not a second set
 * that could drift from it.
 *
 * Until a Turnkey policy permits calls to splitter addresses, every claim will
 * be refused by the signer and reported as `signer-refused`. That is the
 * intended state, not a broken deployment.
 */
const accountClaims = new AccountClaimService({
  db,
  provider: { call: (tx) => provider.call(tx) },
  signer: treasurySigner,
});
app.use('/api', accountRouter(accountAuth, accountClaims, async (address) => {
  const wei = await provider.getBalance(address);
  return wei.toString();
}));

/**
 * What a leaked webhook secret costs.
 *
 * The treasury is already bounded by the daily spend cap. The parser is not: every
 * accepted mention is a paid API call against a fixed prepaid balance, so a flood
 * exhausts it and the bot goes deaf to everyone until somebody tops it up. That is a
 * denial of service that needs no launch to succeed and costs the attacker nothing.
 *
 * Sized well above any real provider's delivery rate -- twitterapi.io is polled every
 * two minutes and a webhook fires per mention -- so this is a ceiling on abuse rather
 * than a throttle on normal use.
 */
const webhookLimit = new FixedWindowRateLimit(
  config.WEBHOOK_MAX_PER_MINUTE,
  60_000
);

// Warmed at boot, in the background.
//
// Discovery is a log scan, and the first caller pays for it. Left cold, that caller
// is whoever first asks for a stock-paired launch -- so the feature's first ever use
// is also its slowest, and /status reports the approved set as unavailable until
// somebody happens to trigger it. Neither is a failure, but both look like one.
//
// Fire-and-forget on purpose: a failure here must not stop the bot booting. The set
// is re-read on demand anyway, and approval is checked live at launch time.
if (pairAssets) {
  void pairAssets
    .list()
    .then((assets) => console.log(`Pair assets discovered: ${assets.map((a) => a.symbol).join(', ') || 'none'}.`))
    .catch((err) => console.warn('[pairTokens] initial discovery failed, will retry on demand:', err?.message ?? err));
}

const deps = {
  publicLaunchEnabled: config.PUBLIC_LAUNCH_ENABLED,
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
  walletResolver,
  xClient: createXClient(),
  treasurySigner,
  provider,
  // Priced from the deployment the orchestrator selected, not from the global flag.
  getLiveFeeWei: (deployment?: PonsDeployment) => getLiveFeeWei(provider, deployment),
  getTreasuryBalanceWei: async () => getBalanceWei(provider, await treasurySigner.address()),
  // Asked of the deployment the orchestrator selected. Readiness read from a global
  // describes a contract nobody is calling.
  getLaunchReadiness: async (deployment?: PonsDeployment) =>
    getLaunchReadiness(
      provider,
      await treasurySigner.address(),
      config.PONS_LAUNCH_CONFIG_ID,
      config.PONS_DEX_ID,
      deployment
    ),
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

    // After the secret check on purpose: an unauthenticated flood must not be able to
    // eat the allowance and lock out the real provider.
    const limit = webhookLimit.check();
    if (!limit.allowed) {
      console.warn(`[webhook] rate limited (${limit.count} in the current window) from ${req.ip}`);
      res.setHeader('Retry-After', String(limit.resetInSeconds));
      res.status(429).json({ error: 'rate limited' });
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
/**
 * The dependency set for one status response, built once and shared by BOTH routes.
 *
 * `/status` and `/status/core` must never be able to describe different worlds. A core
 * endpoint reading the chain through its own definition would be a second source of truth,
 * which is the shape of every defect in this file's history.
 *
 * ONE endpoint per response, pinned by the caller. Chain id, block, fee, balance, readiness
 * and identity used to arrive through two different providers -- the pinned one and whatever
 * the pool happened to pick -- while the page labelled the result with the POOL's endpoint.
 * Null session means nothing could be admitted; the chain checks then fail as they should.
 */
/**
 * The PUBLIC treasury address, resolved once, without the signer.
 *
 * Serving a status page used to call `treasurySigner.address()`, which resolves through the
 * Turnkey client. That does not sign anything, but it made a read-only endpoint depend on
 * the signer path -- and it made the claim "the endpoint loads no Turnkey credential" false
 * at the composition boundary even though every leaf module was clean.
 *
 * The address is public and already pinned in configuration, so status reads it from there.
 * No second signer is built and no additional credential is loaded.
 *
 * BE PRECISE ABOUT WHAT THIS DOES AND DOES NOT FIX: the endpoint performs no signing and
 * grants no authority, but the production PROCESS is still signer-capable -- `index.ts`
 * constructs a treasury signer at startup for the launch path. Serving `/status` no longer
 * touches it; the process it lives in is not thereby keyless.
 */
const statusTreasuryAddress = (() => {
  try {
    return pinnedTreasuryAddress(config as { TURNKEY_SIGN_WITH?: string; TREASURY_ADDRESS?: string });
  } catch {
    return undefined;
  }
})();

const statusDepsFor = (session: AcquiredSession | null) => {
      const readProvider = session?.provider;
      const unavailable = () => {
        throw new Error('no admitted RPC endpoint is available to serve this status request');
      };

      return {
      expectedChainId: config.CHAIN_ID,
      /**
       * A FRESH `eth_chainId` OVER THE WIRE, not `getNetwork()`.
       *
       * The pool builds providers with `staticNetwork: true`, and `getNetwork()` then
       * answers from the CONFIGURED value without sending a request -- the same property
       * that made the pool's admission gate inert until it was rewritten. Admission does
       * check the transport, but an admission PASS is cached for up to five minutes, so a
       * core response could look freshly chain-bound while nothing had asked the endpoint
       * anything during that response.
       *
       * `provider.send` bypasses the static-network shortcut, and the result is parsed
       * strictly rather than coerced: `Number('')` is 0 and `parseInt('4663junk')` is 4663.
       */
      getChainId: async () => {
        if (!readProvider) return unavailable();
        const raw = await readProvider.send('eth_chainId', []);
        const observed = parseChainId(raw);
        if (observed === null) {
          throw new Error('the endpoint did not return a valid hex chain id');
        }
        return observed;
      },
      getBlockNumber: () => (readProvider ? readProvider.getBlockNumber() : unavailable()),
      getTreasuryBalanceWei: async () =>
        readProvider && statusTreasuryAddress
          ? getBalanceWei(readProvider, statusTreasuryAddress)
          : unavailable(),
      getLiveFeeWei: async () =>
        readProvider ? getLiveFeeWei(readProvider, launchTarget.deployment) : unavailable(),
      // Read from the deployment the bot launches through, using that contract's own
      // canLaunch predicate. Reading a superseded factory is precisely how /status
      // reported the launchpad closed for a week while it was open.
      getLaunchReadiness: async () => {
        const d = launchTarget.deployment;
        if (!d || !readProvider) return deps.getLaunchReadiness();
        // ONE round trip, and each call timed. This used to be readCurrentReadiness, which
        // makes four sequential trips -- a 48 KB bytecode download, then feeEscrow alone,
        // then the permission batch, then the launch config -- inside a single 5 000 ms
        // deadline. It did not fail because the launchpad was closed or the RPC was
        // broken; it failed whenever one round trip cost more than about a second.
        if (!statusTreasuryAddress) return unavailable();
        const launcher = statusTreasuryAddress;
        const probe = await probeLaunchPermission(
          readProvider,
          launcher,
          config.PONS_LAUNCH_CONFIG_ID,
          '0x0000000000000000000000000000000000000000',
          d
        );
        const r = probe.verdict;
        if (!r) {
          // A required read did not answer. Thrown rather than reported as a closed
          // launchpad: not knowing is not the same as being refused.
          throw new Error(probe.failure ?? 'launch readiness could not be determined');
        }
        return {
          launchEnabled: r.launchEnabled,
          whitelisted: r.whitelisted,
          canLaunch: r.canLaunch,
          canLaunchOnChain: r.canLaunchOnChain,
          durable: r.durable,
          detail: r.reason ? `${r.reason}` : r.detail,
          timings: probe.timings,
          totalMs: probe.totalMs,
          // Carried through rather than dropped. A verdict reached with gaps in the
          // evidence is not the same claim as one reached with all of it.
          incomplete: probe.failure,
        };
      },
      // Bound to the endpoint that actually answered, and it is the SAME endpoint every
      // other chain read above used.
      getDeploymentIdentity: () =>
        readProvider && session
          ? identityWatch.check(readProvider, session.endpoint.fingerprint)
          : Promise.reject(new Error('no admitted RPC endpoint is available')),
      describeRpc: () => rpcPool.status(),
      /**
       * The UTC CALENDAR DAY, for the human-facing line only.
       *
       * This comment used to claim it was "the same window the circuit breaker counts".
       * It is not: validator.ts admits against db.totalSpendLast24h(), a ROLLING window.
       * The two agree for most of the day and diverge exactly when it is expensive --
       * at 00:01 UTC this figure resets while the breaker still counts the previous day.
       * A second spender reading this number could be told it had a full cap of headroom.
       */
      spentTodayWei: () => db.totalSpendBetween(startOfUtcDay(), new Date().toISOString()),
      /** The window that actually refuses launches, published as a typed field. */
      rollingSpendLast24hWei: () => db.totalSpendLast24h(),
      /**
       * The validated EVM pin, never TURNKEY_SIGN_WITH.
       *
       * Turnkey accepts that setting as a wallet address, a private-key address OR an
       * opaque private-key ID. Publishing an identifier where an account is expected would
       * make every canary admission fail permanently against a value that is not wrong so
       * much as not an address at all.
       */
      treasuryAddress: (() => {
        try {
          return statusTreasuryAddress;
        } catch {
          return undefined;
        }
      })(),
      dailyCapWei: config.DAILY_SPEND_CAP_WEI,
      launchesToday: () => db.countLaunchesBetween(startOfUtcDay(), new Date().toISOString()),
      coldAddressSet: !!config.TREASURY_COLD_ADDRESS,
      parserRoute: config.ANTHROPIC_API_KEY ? 'Anthropic (direct)' : 'OpenRouter',
      alertsRoute: config.TELEGRAM_BOT_TOKEN ? 'Telegram' : 'console only -- alerts go nowhere a person will see',
      crossCheckHours: config.X_BEARER_TOKEN ? config.MENTION_CROSSCHECK_HOURS : 0,
      publicLaunchEnabled: config.PUBLIC_LAUNCH_ENABLED,
      /**
       * Published because a Fly secret's VALUE cannot be read back.
       *
       * This one is a price, not a formatting choice: X charges $0.200 for a
       * post containing a URL against $0.015 without -- thirteen times, for one
       * link. An operator who sets it and cannot observe it has bought a
       * thirteenfold cost increase on faith, and this repository has already
       * been bitten by a boolean setting that silently meant its opposite,
       * because `z.coerce.boolean()` read "false" as true.
       */
      replyIncludeLink: config.REPLY_INCLUDE_LINK,
      // The PUBLIC string stays 'v1'/'v2' -- it is part of what /status has always
      // published -- but it is DERIVED from the selected deployment now rather than read
      // from a setting that could name a version the bot is not running.
      factoryVersion: (executableDeployment().tokenParamsVersion === 'v1' ? 'v1' : 'v2') as 'v1' | 'v2',
      deploymentId: launchTarget.deployment?.id,
      deploymentFactory: launchTarget.deployment?.factory,
      listPairAssets: pairAssets ? async () => (await pairAssets.list()).map((a) => a.symbol) : undefined,
      // Whether the bot is actually HEARING anything, not whether polling is configured.
      // Undefined until the sweep starts below; this callback runs per request, long after.
      sweepHealth: () => (reconciler ? reconciler.health() : { lastSuccessAt: null, consecutiveFailures: 0, lastError: null }),
      // Free at twitterapi.io, and it answers while data calls are being refused.
      readCredits: () => (deps.xClient as { getReadCredits?: () => Promise<{ credits: number; bonus: number } | null> }).getReadCredits?.() ?? Promise.resolve(null),
      sweepStaleAfterMs: Math.max(config.MENTION_POLL_SECONDS * 3, 900) * 1000,
      };
};

/**
 * Both status routes, mounted from the ONE extracted definition.
 *
 * They used to be written inline here, and a test that mirrored a sanitised copy of the
 * core handler passed while this file still published `detail: String(err.message)`. A test
 * standing next to the thing instead of on it confirms only what its author believed. There
 * is one copy now, in `statusRoutes.ts`, and the tests import it.
 */
const statusRouteDeps = { pool: rpcPool, makeDeps: statusDepsFor };
app.get('/status', statusHandler(statusRouteDeps));
app.get('/status/core', statusCoreHandler(statusRouteDeps));

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
const reconciler: ReconcilerHandle = startReconciliation(deps, config.MENTION_POLL_SECONDS / 60, undefined, notifier);

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
// Both factories are watched, not just the one the bot launches through -- and the v1
// address comes from the REGISTRY, which binds it to an ABI, a selector and hashes, not
// from a settable string that could name anything. Each alert names its factory: two
// watches sending identical text would send somebody to check the wrong contract.
//
// Watching is not launching. `pons-v1` is `executable: false`, so nothing here can send
// to it; reading its switch state is how an operator learns pons changed something on a
// contract Ponsr still has tokens on.
const launchpadWatches = [
  // `launchesThrough: false` is the whole point of watching it. pons closing v1
  // is not an outage for Ponsr -- the bot left that factory on 2026-08-26 and
  // `pons-v1` is `executable: false`. Without this flag the watch sent CRITICAL
  // saying "the bot cannot launch anything" while the bot launched fine through
  // v2, three times in four hours on 2026-09-01.
  { label: 'the v1 factory', address: deploymentById('pons-v1').factory, launchesThrough: false },
  // The CURRENT factory, from the registry. This watched
  // `config.PONS_V2_FACTORY_ADDRESS` until 2026-08-20 -- the superseded deployment --
  // which is how a "launchpad closed" alert kept firing accurately about a contract
  // pons had already replaced, while the one Ponsr would launch through was open the
  // entire time. A monitor pointed at the wrong contract does not go quiet; it reports
  // confidently on somewhere else.
  { label: `the current factory (${executableDeployment().id})`, address: executableDeployment().factory, launchesThrough: true },
].map(({ label, address, launchesThrough }) =>
  startLaunchpadWatch(
    { getLaunchReadiness: async () => getSwitchState(provider, address, await treasurySigner.address()) },
    notifier,
    15,
    label,
    // The store makes the edge survive a deploy. Each watch keys on its own
    // label, so closing one factory cannot silence the alert for the other.
    { launchesThrough, store: { get: (k) => db.getState(k), set: (k, v) => db.setState(k, v) } }
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
/**
 * Do not die quietly.
 *
 * Node terminates the process on an unhandled promise rejection, and this codebase is
 * full of deliberately fire-and-forget promises -- alerts, the boot-time asset scan,
 * the launchpad checks. Every one of them has a `.catch`, but the failure mode being
 * guarded here is the one that does not: a rejection added later, or thrown from a
 * dependency, kills the listener.
 *
 * Fly restarts it, so the bot recovers on its own. What it does not do is tell anyone,
 * and a process that dies and restarts every few minutes looks from outside exactly
 * like a process that is running fine and receiving no mentions.
 *
 * So this alerts and then exits rather than swallowing. Continuing after an unknown
 * rejection means running in a state nobody reasoned about, on a path that spends
 * money; a clean restart from a known-good state is the safer half of the trade.
 */
function reportFatal(kind: string, err: unknown): void {
  const detail = (err as Error)?.stack ?? String(err);
  console.error(`[fatal] ${kind}:`, detail);
  // Fire and forget with a hard deadline: the alert is worth a moment, but a hung
  // notifier must not keep a broken process alive indefinitely.
  const done = notifier
    .send({
      kind: 'LAUNCH_FAILED',
      severity: 'critical',
      message:
        `The bot process hit an ${kind} and is exiting so Fly can restart it from a known ` +
        'state. It will come back on its own; this alert exists because otherwise a crash ' +
        'loop is indistinguishable from a quiet day.',
      detail: { error: String(detail).slice(0, 500) },
      at: new Date().toISOString(),
    })
    .catch(() => undefined);
  void Promise.race([done, new Promise((r) => setTimeout(r, 3000))]).then(() => process.exit(1));
}

process.on('unhandledRejection', (reason) => reportFatal('unhandled rejection', reason));
process.on('uncaughtException', (err) => reportFatal('uncaught exception', err));

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
