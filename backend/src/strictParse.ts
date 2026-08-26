/**
 * Strict parsers for values that arrive from outside: public JSON, and CLI arguments.
 *
 * WHY THIS EXISTS
 * ---------------
 * `validateCoreEvidence` called `BigInt(e.launchFeeWei)` directly on untrusted JSON. A
 * hostile or merely broken body containing `"not-a-bigint"` made the validator THROW a
 * SyntaxError instead of returning a failure, and the CLI's outer catch then exited 2 with
 * the evidence category discarded. A validator that can throw on malformed input is not a
 * validator: it has no closed failure vocabulary at exactly the moment one is needed.
 *
 * Every function here returns `null` on anything it does not fully understand, and never
 * throws. Nothing is coerced: `BigInt` is only ever reached after the shape has been
 * proven, and `Number()` is never used for parsing at all.
 *
 * WHAT IS REFUSED, AND WHY EACH ONE
 * ---------------------------------
 *   ''            `Number('')` is 0 and `BigInt('')` is 0n -- an empty field would read as
 *                 a real zero, which for a spend cap is the difference between refusing
 *                 and permitting
 *   ' 12 '        `BigInt(' 12 ')` succeeds; accepting whitespace means two documents that
 *                 differ byte-for-byte compare equal
 *   '+12', '-1'   a sign on a quantity that cannot be negative is a malformed field, and
 *                 `-1` silently becoming a valid BigInt is how a negative balance passes
 *   '1.0', '1e3'  decimals and exponents are not the wire format, and `BigInt` rejects
 *                 them by throwing rather than by returning
 *   '0x0a'        hex is a different encoding; accepting both means the same value has two
 *                 spellings and equality checks stop being reliable
 *   '007'         leading zeros are refused so one value has exactly one representation
 */

/** Decimal, unsigned, no sign, no whitespace, no leading zeros (except "0" itself). */
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * A practical ceiling. 10^30 wei is a million times the total supply of anything on this
 * chain, so a larger value is not a quantity -- it is either a bug or an attempt to make
 * a comparison overflow into meaninglessness.
 */
export const MAX_WEI = 10n ** 30n;

/** Strict unsigned decimal wei. Null for anything not exactly that shape. */
export function parseWei(raw: unknown, max: bigint = MAX_WEI): bigint | null {
  if (typeof raw !== 'string') return null;
  if (!DECIMAL.test(raw)) return null;
  // Bounded before BigInt, so an absurd digit string cannot cost real work.
  if (raw.length > 40) return null;
  const value = BigInt(raw);
  return value > max ? null : value;
}

/** A finite, non-negative safe integer. Rejects NaN, Infinity, floats and non-numbers. */
export function parseCount(raw: unknown): number | null {
  if (typeof raw !== 'number') return null;
  if (!Number.isFinite(raw) || !Number.isSafeInteger(raw)) return null;
  return raw < 0 ? null : raw;
}

/** A strictly positive safe integer. Zero is refused where zero is not a real answer. */
export function parsePositive(raw: unknown): number | null {
  const n = parseCount(raw);
  return n === null || n === 0 ? null : n;
}

/** Exactly a boolean. `1`, `'true'` and truthy objects are all refused. */
export function parseBoolean(raw: unknown): boolean | null {
  return typeof raw === 'boolean' ? raw : null;
}

/** A 0x-prefixed 20-byte address, by shape. Case-insensitive; checksum is not required. */
export function parseAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : null;
}

/** The 12-hex endpoint fingerprint published by `rpcIdentity`. */
export function parseFingerprint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return /^[0-9a-f]{12}$/.test(raw) ? raw : null;
}

/**
 * A scheme-and-host origin, with nothing else in it.
 *
 * Refuses anything carrying a path, query or userinfo -- if one of those ever appears in a
 * published origin it is a leak, and a consumer accepting it would be helping to hide one.
 */
export function parseOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  return `${u.protocol}//${u.host}`;
}

/** ISO timestamp, as epoch ms. Null when absent or unparseable. */
export function parseTimestamp(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}

/**
 * A CLI argument that must be a non-negative integer.
 *
 * Separated from `parseCount` because the input is a string here, and because a CLI must
 * refuse `--samples NaN` and `--timeout-ms -1` rather than proceeding with a nonsense
 * bound. The raw value is never echoed back: an operator can put anything on a command
 * line, including something they should not have.
 */
export function parseArgInteger(raw: string | undefined, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  if (typeof raw !== 'string' || !DECIMAL.test(raw) || raw.length > 16) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}

/** A CLI argument that must be unsigned decimal wei. */
export function parseArgWei(raw: string | undefined): bigint | null {
  return parseWei(raw);
}
