import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * All external credentials the bot needs. Every one of these is a placeholder that must be
 * filled in with real values before Phase 1 (testnet) can run end to end -- see
 * backend/docs/SETUP.md for where each of these comes from.
 *
 * Fields are deliberately optional at the schema level (not required) so the backend can
 * boot in a partially-configured state for local development/testing -- individual modules
 * check for their own required config at the point of use and fail loudly there, rather than
 * the whole process refusing to start over an unrelated missing key.
 */
/**
 * Reads an operator's yes or no exactly as written.
 *
 * `z.coerce.boolean()` is JavaScript truthiness: every non-empty string is true, so
 * "false" and "0" both parsed as TRUE. Applied to TURNKEY_POLICY_CONFIRMED that inverted
 * the one setting whose entire job is to let somebody say "I have NOT verified the signer
 * policy" -- and treasurySigner.ts refuses to start in production without it. An operator
 * writing false got a process that started anyway, holding a signer.
 *
 * Tolerant about shape, strict about meaning: case and surrounding whitespace are ignored,
 * and anything not recognisably "true" is a refusal. Erring toward false costs a startup
 * and a puzzled operator; erring toward true starts on the strength of a word that said no.
 */
export function parseAcknowledgement(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return value.trim().toLowerCase() === 'true';
}

const ConfigSchema = z.object({
  // -- LLM parser (Part 9: Claude Haiku 4.5 is the chosen model) --
  ANTHROPIC_API_KEY: z.string().optional(),
  PARSER_MODEL: z.string().default('claude-haiku-4-5'),
  // Same model, routed through OpenRouter when there is no direct Anthropic key.
  OPENROUTER_API_KEY: z.string().optional(),
  // Alert transport. Both are required together -- a token without a chat id cannot deliver.
  // Shared secret the webhook caller must present. Without it the endpoint is an
  // unauthenticated way to spend the treasury -- see the guard in index.ts.
  /**
   * How often to sweep for mentions, in seconds.
   *
   * This is the latency a user feels between tagging the bot and being answered, and it is
   * bought by the poll: twitterapi.io bills a search whether or not it matches anything, at
   * roughly 15 credits (1 USD = 100,000 credits). So, per month:
   *
   *   300s (default)  288 polls/day   ~$1.30
   *    60s          1,440 polls/day   ~$6.50
   *    10s          8,640 polls/day  ~$39
   *
   * Their own filter-rule product bills per poll too, so it costs the same at the same
   * interval while adding a webhook, a dashboard setting and a shared secret held by a third
   * party. This is the cheaper half of that trade, and the interval is the only real lever.
   */
  MENTION_POLL_SECONDS: z.coerce.number().int().min(5).default(300),
  WEBHOOK_SECRET: z.string().optional(),
  // OAuth 2.0 App-Only. The bot never writes with this -- replies must come from the
  // account, which needs user context. It exists because /2/usage/tweets refuses OAuth 1.0a
  // and is the only way to read the project's post quota.
  X_BEARER_TOKEN: z.string().optional(),
  /**
   * How often to check the bot's mention sweep against X's own timeline, in hours.
   *
   * Billed per post read and capped at five posts a check, so six-hourly costs
   * roughly $0.10 a day. Widening it spends less and finds a deaf bot later.
   * Setting it to 0 turns the check off entirely.
   */
  MENTION_CROSSCHECK_HOURS: z.coerce.number().min(0).default(6),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-haiku-4.5'),

  // -- X: reads and writes go to different providers. See xClient.ts for why. --
  // READ (mentions, account signals) -- twitterapi.io, ~$0.00015/tweet vs X's $0.005.
  TWITTERAPI_IO_KEY: z.string().optional(),
  // WRITE (replies) -- X's own API, OAuth 1.0a, because posting is account activity and a
  // suspended @ponsrdotfun cannot be re-minted. ~$0.015 per reply.
  X_API_KEY: z.string().optional(),
  X_API_SECRET: z.string().optional(),
  X_ACCESS_TOKEN: z.string().optional(),
  X_ACCESS_TOKEN_SECRET: z.string().optional(),
  /**
   * Whether the success reply links to the token's page on ponsr.fun.
   *
   * This is a pricing decision, not a formatting one: X charges **$0.200 for a post
   * containing a URL against $0.015 without** -- thirteen times more. At a hundred launches a
   * month that is $20 versus $1.50.
   *
   * Defaults to off so the cost is opted into rather than discovered. Turning it on is
   * perfectly reasonable -- driving traffic to the board may well be worth $18.50 a month --
   * but it should be a decision someone made.
   *
   * Parsed like the acknowledgement gate, and for the same reason: under
   * `z.coerce.boolean()` an operator writing `REPLY_INCLUDE_LINK=false` turned the expensive
   * option ON. A default nobody can decline is not a default.
   */
  REPLY_INCLUDE_LINK: z.preprocess(parseAcknowledgement, z.boolean()),
  /** Base URL used when REPLY_INCLUDE_LINK is on. */
  SITE_BASE_URL: z.string().default('https://ponsr.fun'),
  BOT_X_HANDLE: z.string().default('ponsrdotfun'), // x.com/ponsrdotfun

  // -- Robinhood Chain RPC (Part 10: Alchemy free tier, or fallback public RPC) --
  RPC_URL: z.string().default('https://rpc.testnet.chain.robinhood.com'),
  /**
   * Additional RPC endpoints, comma-separated, tried in order after RPC_URL.
   *
   * Optional, and empty by default: one endpoint is the current behaviour and stays the
   * behaviour until an operator deliberately adds another. Every entry is ADMITTED before
   * it is allowed to answer -- chain id and factory bytecode must match the registry -- so
   * a fallback cannot silently move the bot to a different chain or a forked state. See
   * `rpcPool.ts` for why an unchecked fallback is worse than none.
   */
  RPC_FALLBACK_URLS: z.string().default(''),
  CHAIN_ID: z.coerce.number().default(46630), // testnet by default; 4663 for mainnet

  /*
   * PONS_FACTORY_ADDRESS and PONS_LOCKER_ADDRESS were REMOVED on 2026-08-26, joining
   * PONS_V2_FACTORY_ADDRESS, PONS_V2_FEE_ESCROW_ADDRESS and PONS_V2_APPROVALS_FROM_BLOCK.
   *
   * Both named v1, and the registry already holds them bound to an ABI hash, a runtime
   * bytecode hash, a selector and an escrow that are checked against the chain -- where an
   * address means something. A bare settable address means only itself, which is how a
   * superseded factory and the current one came to look identical for a week.
   *
   * Historical readers take `deploymentById('pons-v1')`. Its `feeEscrow` IS the v1 locker:
   * v1 pushes fees from the locker rather than escrowing them, and the registry says so.
   */
  /**
   * Which launch config and DEX config `launchToken` is called with.
   *
   * A launch config carries the pair token, graduation threshold, supply and wallet/tx limits.
   * The factory had exactly one (id 0, enabled, paired against WETH, 4.2 ETH graduation) when
   * this was read on 2026-08-04 -- but pons can add and disable configs at will, so these are
   * settings, and `getLaunchReadiness()` verifies the chosen one is live before every launch.
   */
  PONS_LAUNCH_CONFIG_ID: z.coerce.bigint().default(0n),
  PONS_DEX_ID: z.coerce.bigint().default(0n),

  /*
   * PONS_FACTORY_VERSION was REMOVED on 2026-08-26.
   *
   * It chose which factory a launch went to -- and `deployments.ts` already decides that,
   * with an invariant that THROWS unless exactly one entry is executable. One fact in two
   * places, and the setting's default was `v1`, so a missing value silently selected the
   * factory pons replaced. Two production launches on 2026-08-12 went to v1 that way.
   *
   * Changing `.default('v1')` to `.default('v2')` would have closed that instance and left
   * the shape: a default is a preference, and the next environment gets a vote. There is
   * nothing to vote on now. The registry answers, and `executableDeployment()` refuses to
   * guess.
   */
  /**
   * Ponsr's own public-launch gate. This is independent of pons's factory gate:
   * deploys, migrations, and operator canaries must not silently make user-triggered
   * launches live. Enabling it is a separate post-canary operator decision.
   */
  PUBLIC_LAUNCH_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Ceiling on authenticated webhook deliveries per minute. Guards the parser's
   *  prepaid balance, not the treasury -- the daily spend cap already bounds that. */
  WEBHOOK_MAX_PER_MINUTE: z.coerce.number().default(30),
  /*
   * PONS_V2_FACTORY_ADDRESS and PONS_V2_FEE_ESCROW_ADDRESS were REMOVED on 2026-08-20.
   *
   * Nobody ever wrote the superseded factory into a code path. They read these two
   * settings, whose defaults were it -- which is exactly why every review of the code
   * looked clean while every guard was aimed at the contract pons had replaced.
   *
   * The last reader is gone, and an unread default is one import away from being read
   * again by someone reaching for the obvious-looking name. Both addresses live in
   * `deployments.ts` now, bound to an ABI, an escrow, a selector and hashes that are
   * checked against the chain -- where an address means something.
   *
   * Nothing selects a factory any more. The registry answers, and the exactly-one
   * invariant in `executableDeployment()` refuses to guess.
   */
  /*
   * PONS_V2_APPROVALS_FROM_BLOCK was REMOVED on 2026-08-21, for the same reason as the
   * two addresses above: a separately settable number that must agree with a deployment
   * but was free not to. Set below the deployment it scanned millions of empty blocks;
   * set above it, it silently missed approvals -- which looks exactly like pons never
   * having granted them.
   *
   * The scanner takes the deployment's own startBlock now.
   */
  /** What a launch pairs against when the person did not ask for anything. ETH keeps
   *  today's behaviour, and is the only pairing that needs no approval. */
  DEFAULT_PAIR_ASSET: z.string().default('ETH'),

  // -- Wallet-per-user (Privy). @privy-io/node -- server-auth is deprecated. --
  PRIVY_APP_ID: z.string().optional(),
  PRIVY_APP_SECRET: z.string().optional(),

  // -- Account Phase B. Fail-closed until every value is configured. --
  ACCOUNT_AUTH_ENABLED: z.enum(['true','false']).default('false').transform((value)=>value==='true'),
  X_OAUTH_CLIENT_ID: z.string().optional(),
  X_OAUTH_CLIENT_SECRET: z.string().optional(),
  X_OAUTH_CALLBACK_URL: z.string().url().optional(),
  ACCOUNT_SITE_ORIGIN: z.string().url().default('https://ponsr.fun'),

  // -- Treasury signer: Turnkey (Part 10) --
  // The API key below only asks Turnkey to sign. What restricts WHAT it will sign is a
  // policy configured in Turnkey, not anything in this codebase -- see treasurySigner.ts.
  TURNKEY_ORGANIZATION_ID: z.string().optional(),
  TURNKEY_API_PUBLIC_KEY: z.string().optional(),
  TURNKEY_API_PRIVATE_KEY: z.string().optional(),
  /** Wallet account address, private key address, or private key ID to sign with. */
  TURNKEY_SIGN_WITH: z.string().optional(),
  /**
   * The treasury's EVM address, as a non-secret pin.
   *
   * Separate from TURNKEY_SIGN_WITH, which Turnkey accepts as a wallet address, a
   * private-key address OR an opaque private-key ID. Reading an opaque signer identifier
   * as though it were an address is how a preflight ends up describing an account that
   * does not exist, and every balance and cap reading above it becomes about nothing.
   */
  TREASURY_ADDRESS: z.string().optional(),
  /** Operator's acknowledgement that the signing policy exists. Production refuses to
   *  start without it, because an unpolicied Turnkey key is indistinguishable from a
   *  correctly-policied one until it is abused.
   *
   *  Parsed by `parseAcknowledgement`, never by `z.coerce.boolean()` — see that function's
   *  comment. An absent variable reaches the preprocessor as undefined and comes back false,
   *  so the refusal is the default without needing a separate `.default()`. */
  TURNKEY_POLICY_CONFIRMED: z.preprocess(parseAcknowledgement, z.boolean()),

  // -- Treasury signer (Part 5/10: Turnkey, scoped to launchToken() only) --
  TREASURY_SIGNER_PRIVATE_KEY: z.string().optional(), // testnet-only raw key; Turnkey in prod
  TREASURY_MAX_FEE_WEI: z.coerce.bigint().default(2_000_000_000_000_000n), // 0.002 ETH ceiling

  // -- Hot/cold treasury split (Part 5 mitigation #7) --
  // The bot spends from the hot wallet (TREASURY_SIGNER_*) and never from the cold one --
  // there is deliberately no cold signer anywhere in this codebase, because a process that
  // could refill itself from cold storage would re-create the single point of failure the
  // split exists to remove. Top-ups and sweeps are operator actions; see treasuryPolicy.ts.
  TREASURY_COLD_ADDRESS: z.string().optional(),
  /** Hot balance ceiling as a multiple of DAILY_SPEND_CAP_WEI. Part 5 says "a day or two". */
  HOT_WALLET_MAX_DAILY_CAPS: z.coerce.number().default(2),
  /** Thresholds are in *launches*, not ETH -- the launch fee is owner-settable on pons's side
   *  and must never be frozen into a constant (see docs/pons-v2-findings.md). */
  HOT_WALLET_FLOOR_LAUNCHES: z.coerce.number().default(20),
  HOT_WALLET_TARGET_LAUNCHES: z.coerce.number().default(60),
  HOT_WALLET_CRITICAL_LAUNCHES: z.coerce.number().default(3),
  /** Held back from launch fees so the splitter deployment and the launch transaction can
   *  both still pay gas. One launch is two transactions out of this same wallet. */
  TREASURY_GAS_RESERVE_WEI: z.coerce.bigint().default(2_000_000_000_000_000n), // 0.002 ETH

  // -- Anti-abuse thresholds (Part 5: required Phase 1 mitigations, not optional hardening) --
  DAILY_SPEND_CAP_WEI: z.coerce.bigint().default(50_000_000_000_000_000n), // 0.05 ETH/day to start
  MIN_ACCOUNT_AGE_DAYS: z.coerce.number().default(30),
  MIN_FOLLOWER_COUNT: z.coerce.number().default(5),
  MAX_LAUNCHES_PER_USER_PER_DAY: z.coerce.number().default(3),

  // -- Storage --
  DATABASE_PATH: z.string().default('./data/bot.sqlite'),

  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * The same parse the exported config uses, against an arbitrary environment.
 *
 * Exported so tests can assert what the SCHEMA produces rather than what a helper returns.
 * The distinction is not academic: `TURNKEY_POLICY_CONFIRMED` once had a correct parser and a
 * broken schema declaration, with a full green suite covering the parser nothing called.
 */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  return ConfigSchema.parse(env);
}

export const config: Config = parseConfig(process.env);

/** Throws with a clear, actionable message if a required-for-this-operation secret is
 * missing, instead of letting a downstream SDK throw an opaque error. */
export function requireConfig<K extends keyof Config>(key: K): NonNullable<Config[K]> {
  const value = config[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(
      `Missing required config: ${String(key)}. See backend/docs/SETUP.md for how to obtain it.`
    );
  }
  return value as NonNullable<Config[K]>;
}
