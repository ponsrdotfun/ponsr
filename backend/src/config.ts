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

  // -- X data provider (Part 10: twitterapi.io, confirmed to support both read + write) --
  TWITTERAPI_IO_KEY: z.string().optional(),
  BOT_X_HANDLE: z.string().default('bot_lo'),

  // -- Robinhood Chain RPC (Part 10: Alchemy free tier, or fallback public RPC) --
  RPC_URL: z.string().default('https://rpc.testnet.chain.robinhood.com'),
  CHAIN_ID: z.coerce.number().default(46630), // testnet by default; 4663 for mainnet

  // -- Pons factory (Part 2/7: pull the real ABI via Blockscout before Phase 1 goes live) --
  PONS_FACTORY_ADDRESS: z.string().default('0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB'),
  PONS_LOCKER_ADDRESS: z.string().default('0x736D76699C26D0d966744cAe304C000d471f7F35'),

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
