import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * All external credentials the bot needs. Every one of these is a placeholder that must be
 * filled in with real values before Phase 1 (testnet) can run end to end -- see
 * docs/SETUP.md and the project's own action-checklist.md for where each of these comes from.
 *
 * Fields are deliberately optional at the schema level (not required) so the backend can
 * boot in a partially-configured state for local development/testing -- individual modules
 * check for their own required config at the point of use and fail loudly there, rather than
 * the whole process refusing to start over an unrelated missing key.
 */
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
   */
  REPLY_INCLUDE_LINK: z.coerce.boolean().default(false),
  /** Base URL used when REPLY_INCLUDE_LINK is on. */
  SITE_BASE_URL: z.string().default('https://ponsr.fun'),
  BOT_X_HANDLE: z.string().default('ponsrdotfun'), // x.com/ponsrdotfun

  // -- Robinhood Chain RPC (Part 10: Alchemy free tier, or fallback public RPC) --
  RPC_URL: z.string().default('https://rpc.testnet.chain.robinhood.com'),
  CHAIN_ID: z.coerce.number().default(46630), // testnet by default; 4663 for mainnet

  // -- pons factory. The real, verified ABI is checked in at src/abi/ponsLaunchFactory.json --
  PONS_FACTORY_ADDRESS: z.string().default('0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB'),
  PONS_LOCKER_ADDRESS: z.string().default('0x736D76699C26D0d966744cAe304C000d471f7F35'),
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

  /**
   * Which factory to launch through.
   *
   * v1 is what both real launches used and what the fee path was proven against. v2
   * adds the thing v1 cannot do at all: a launch priced, funded and graduated in an
   * approved asset other than ETH -- eight of them today, six tokenised stocks.
   *
   * `launchToken` is a DIFFERENT function on v2, not v1 with an argument added, so
   * this is not a cosmetic switch: it selects a different encoder, a different ABI
   * and a different readiness check. Both factories have launching switched off
   * right now, so neither works until pons acts either way.
   */
  PONS_FACTORY_VERSION: z.enum(['v1', 'v2']).default('v1'),
  PONS_V2_FACTORY_ADDRESS: z.string().default('0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8'),
  /**
   * Where to begin scanning for `PairTokenApprovalUpdated`.
   *
   * The approvals sit around block 23.58M, so this is a little below them. Set it
   * too high and an approval is missed, which shows up as the bot quietly refusing
   * an asset pons does support -- indistinguishable from never having approved it.
   * Set it to 0 and every refresh scans 370 windows for nothing.
   */
  PONS_V2_APPROVALS_FROM_BLOCK: z.coerce.number().default(23_400_000),
  /** What a launch pairs against when the person did not ask for anything. ETH keeps
   *  today's behaviour, and is the only pairing that needs no approval. */
  DEFAULT_PAIR_ASSET: z.string().default('ETH'),

  // -- Wallet-per-user (Privy). @privy-io/node -- server-auth is deprecated. --
  PRIVY_APP_ID: z.string().optional(),
  PRIVY_APP_SECRET: z.string().optional(),

  // -- Treasury signer: Turnkey (Part 10) --
  // The API key below only asks Turnkey to sign. What restricts WHAT it will sign is a
  // policy configured in Turnkey, not anything in this codebase -- see treasurySigner.ts.
  TURNKEY_ORGANIZATION_ID: z.string().optional(),
  TURNKEY_API_PUBLIC_KEY: z.string().optional(),
  TURNKEY_API_PRIVATE_KEY: z.string().optional(),
  /** Wallet account address, private key address, or private key ID to sign with. */
  TURNKEY_SIGN_WITH: z.string().optional(),
  /** Operator's acknowledgement that the signing policy exists. Production refuses to
   *  start without it, because an unpolicied Turnkey key is indistinguishable from a
   *  correctly-policied one until it is abused. */
  TURNKEY_POLICY_CONFIRMED: z.coerce.boolean().default(false),

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

export const config: Config = ConfigSchema.parse(process.env);

/** Throws with a clear, actionable message if a required-for-this-operation secret is
 * missing, instead of letting a downstream SDK throw an opaque error. */
export function requireConfig<K extends keyof Config>(key: K): NonNullable<Config[K]> {
  const value = config[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(
      `Missing required config: ${String(key)}. See docs/SETUP.md and action-checklist.md for how to obtain it.`
    );
  }
  return value as NonNullable<Config[K]>;
}
