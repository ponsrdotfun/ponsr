import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The non-secret settings, from an environment that was never allowed to hold a credential.
 *
 * WHY THIS EXISTS (5A)
 * --------------------
 * The canary's dry run constructs no signer and requests no signature, and the completion
 * reports said so. What it also did was `import { config }`, and that module runs
 * `dotenv.config()` at load and parses every credential-bearing field. On a machine whose
 * `backend/.env` holds the Turnkey API private key, the raw treasury key, the X tokens and
 * the parser keys, a "keyless" preflight read all of them into the process.
 *
 * Three claims that used to be conflated, and are kept apart here:
 *
 *   1. no signer constructed        -- was true
 *   2. no signature requested       -- was true
 *   3. no credential material read  -- was NOT true
 *
 * Discarding the credential keys after parsing would not have helped: the bytes were read the
 * moment the file was opened. The only way to make claim 3 true is to never open the file, so
 * nothing in this module opens `backend/.env` and nothing in it imports `./config`.
 *
 * WHERE THE VALUES COME FROM
 * --------------------------
 *   1. `process.env` -- what Fly injects in production, and what an operator exports.
 *   2. `.env.canary`, if present -- a file whose contract is that it holds NO secrets.
 *
 * WHY IT IS LAZY
 * --------------
 * Every value is read at CALL time, not at module load. That is what preserves local
 * developer ergonomics: the bot's own entrypoint imports `./config`, whose `dotenv.config()`
 * populates `process.env` before any of these functions run, so the bot behaves exactly as it
 * did. The canary never imports that module, so nothing populates `process.env` from the
 * mixed file and these functions see only what was genuinely exported.
 *
 * A module-load snapshot would have broken that: it would have read `process.env` before
 * dotenv had run, and the bot would have silently fallen back to defaults.
 */

/**
 * Names this module will refuse to serve.
 *
 * Not a security boundary -- it cannot stop anyone reading `process.env` directly. It is a
 * design boundary with teeth: it makes "I only need one little credential here" fail loudly
 * at the point somebody tries it, in the module whose entire purpose is to have none.
 */
const CREDENTIAL_NAMES = [
  'TURNKEY_API_PRIVATE_KEY',
  'TURNKEY_API_PUBLIC_KEY',
  'TREASURY_SIGNER_PRIVATE_KEY',
  'PRIVY_APP_SECRET',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'TWITTERAPI_IO_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN_SECRET',
  'X_BEARER_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'WEBHOOK_SECRET',
];

/** Parsed once per file mtime; the file is tiny and this keeps repeated reads honest. */
let canaryFileCache: { path: string; values: Record<string, string> } | null = null;

/**
 * Reads `.env.canary` if it exists. Never `.env`.
 *
 * The filename is the contract. A reviewer can check in one `ls` that the dry run's only file
 * input is one whose name says it carries no secrets, which is a much easier property to
 * verify than "we parse the mixed file but ignore the dangerous keys".
 */
function canaryFileValues(): Record<string, string> {
  const file = path.resolve(process.cwd(), '.env.canary');
  if (canaryFileCache && canaryFileCache.path === file) return canaryFileCache.values;
  const values: Record<string, string> = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      /**
       * ALLOWLIST, not a denylist.
       *
       * The denylist that stood here enumerated credential names by hand and had already
       * drifted: `X_API_KEY` and `X_ACCESS_TOKEN` exist in `config.ts` and were missing, so a
       * file called secret-free could carry live X authentication material and pass the
       * guard. Every future credential would have had to be remembered here too.
       *
       * An allowlist inverts the failure. The only names accepted are the exact non-secret
       * fields this module serves; anything unrecognised is refused whether or not anybody
       * anticipated it. Forgetting to add a credential now costs a loud refusal instead of a
       * silent read.
       */
      if (!ALLOWED_NAMES.has(key)) {
        throw new Error(
          `.env.canary contains ${key}, which is not one of the non-secret preflight settings. ` +
            'This file is read by the keyless preflight and may hold only those. If it is a ' +
            `credential it belongs in backend/.env. Allowed: ${[...ALLOWED_NAMES].join(', ')}.`
        );
      }
      values[key] = trimmed.slice(eq + 1).trim();
    }
  }
  canaryFileCache = { path: file, values };
  return values;
}

function raw(name: string): string | undefined {
  /**
   * Same allowlist, applied to reads as well as to the file.
   *
   * One policy rather than two: a name this module does not serve cannot be read through it,
   * whether it appears in `.env.canary` or in the process environment, and whether or not
   * anyone remembered to classify it as a credential.
   */
  if (!ALLOWED_NAMES.has(name)) {
    throw new Error(
      `${name} is not a non-secret preflight setting and must not be read through the ` +
        'secret-free preflight environment. Load it explicitly, after the execute gate.'
    );
  }
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  const fromFile = canaryFileValues()[name];
  return fromFile === '' ? undefined : fromFile;
}

/**
 * Non-secret settings only. Every default mirrors `config.ts` exactly, so a value absent from
 * both sources means the same thing to the canary as it does to the bot.
 */
const PreflightSchema = z.object({
  RPC_URL: z.string().default('https://rpc.testnet.chain.robinhood.com'),
  CHAIN_ID: z.coerce.number().default(46630),
  PONS_FACTORY_VERSION: z.enum(['v1', 'v2']).default('v1'),
  PONS_LAUNCH_CONFIG_ID: z.coerce.bigint().default(0n),
  PONS_DEX_ID: z.coerce.bigint().default(0n),
  DAILY_SPEND_CAP_WEI: z.coerce.bigint().default(50_000_000_000_000_000n),
  TREASURY_GAS_RESERVE_WEI: z.coerce.bigint().default(2_000_000_000_000_000n),
  TREASURY_MAX_FEE_WEI: z.coerce.bigint().default(2_000_000_000_000_000n),
  /**
   * Contract addresses, all public and all readable from the chain by anyone. Kept here with
   * the same defaults as `config.ts` so the preflight and the bot resolve identically.
   */
  PONS_FACTORY_ADDRESS: z.string().default('0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB'),
  /** Hot/cold treasury policy thresholds. Numbers about money, never keys to it. */
  HOT_WALLET_MAX_DAILY_CAPS: z.coerce.number().default(2),
  HOT_WALLET_FLOOR_LAUNCHES: z.coerce.number().default(20),
  HOT_WALLET_TARGET_LAUNCHES: z.coerce.number().default(60),
  HOT_WALLET_CRITICAL_LAUNCHES: z.coerce.number().default(3),
  /** The treasury's address is a public pin, not a credential. */
  TREASURY_ADDRESS: z.string().optional(),
  TREASURY_COLD_ADDRESS: z.string().optional(),
  /**
   * Turnkey accepts this as an address OR an opaque private-key id. Only ever used here as an
   * address pin when TREASURY_ADDRESS is absent; it is not a credential and cannot sign.
   */
  TURNKEY_SIGN_WITH: z.string().optional(),
});

export type PreflightEnv = z.infer<typeof PreflightSchema>;

/**
 * The single source of truth for what `.env.canary` may contain: the schema's own field
 * names. Derived, so it cannot drift from what this module actually serves.
 */
const ALLOWED_NAMES: ReadonlySet<string> = new Set(Object.keys(PreflightSchema.shape));

/**
 * Reads the non-secret environment. Call it; never cache it at module scope.
 */
export function preflightEnv(): PreflightEnv {
  const names = Object.keys(PreflightSchema.shape) as Array<keyof PreflightEnv>;
  const source: Record<string, string> = {};
  for (const n of names) {
    const v = raw(n as string);
    if (v !== undefined) source[n as string] = v;
  }
  return PreflightSchema.parse(source);
}

/** For the boundary tests: the credential names this module refuses to serve. */
export const REFUSED_CREDENTIAL_NAMES: readonly string[] = CREDENTIAL_NAMES;
