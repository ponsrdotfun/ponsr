import { AccountSignals, ParsedIntent, ValidationResult } from './types';
import { Db } from './db';
import { config } from './config';
import { TreasuryPolicy, assessHotWallet, canAdmitLaunch, treasuryPolicyFromConfig } from './treasuryPolicy';

/**
 * This module is the layer that actually protects the treasury. It runs unconditionally on
 * every request, treats the LLM's output as untrusted input, and never trusts anything about
 * money-routing from parsed tweet text (see parser.ts's header comment for why that's
 * structurally impossible anyway). Every check below corresponds directly to a mitigation
 * required in Part 5 of the master doc -- this is not optional hardening, it is what makes
 * the "treasury pays every launch fee" model in Part 8 safe to run in Phase 3+.
 */

const NAME_MAX_LENGTH = 32;
const SYMBOL_MAX_LENGTH = 12;
// Alphanumeric, spaces, and a small set of safe punctuation only. Deliberately excludes
// anything that could be used for homoglyph tricks, control characters, or injection into
// whatever downstream system eventually renders these strings (website, X reply, etc).
const SAFE_NAME_PATTERN = /^[a-zA-Z0-9 .,'&-]+$/;
const SAFE_SYMBOL_PATTERN = /^[A-Z0-9]+$/;

export function sanitizeName(raw: string): string | null {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_LENGTH) return null;
  if (!SAFE_NAME_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function sanitizeSymbol(raw: string): string | null {
  // Normalize: strip a leading $, uppercase, trim.
  const trimmed = raw.trim().replace(/^\$/, '').toUpperCase();
  if (trimmed.length === 0 || trimmed.length > SYMBOL_MAX_LENGTH) return null;
  if (!SAFE_SYMBOL_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function sanitizeDescription(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 280);
}

export interface ValidatorDeps {
  db: Db;
  getAccountSignals: (xUserId: string) => Promise<AccountSignals>;
  /** Reads the CURRENT on-chain launch fee, immediately before this check runs. Must never
   * be a cached/stale value -- Part 5's audit specifically calls out reading live to avoid
   * being caught off guard by a fee change on Pons's side. */
  getLiveFeeWei: () => Promise<bigint>;
  /**
   * Reads the hot treasury wallet's CURRENT balance (Part 5 mitigation #7).
   *
   * Deliberately required rather than optional. An optional money guard is one a
   * future call site forgets to pass and nobody notices until the wallet is empty
   * and every launch is burning gas on a transaction that cannot succeed --
   * making it required means the compiler asks the question instead.
   */
  getTreasuryBalanceWei: () => Promise<bigint>;
  /**
   * Asks pons's factory whether it would accept a launch from us right now.
   *
   * Its guards (`launchEnabled`, the whitelist, and whether the configured launch config is
   * enabled) are all owner-controlled on pons's side and can flip without warning. Reading
   * them costs one call and no gas; finding out by sending a transaction costs gas on a
   * revert and hands the user a meaningless failure.
   */
  getLaunchReadiness: () => Promise<{
    canLaunch: boolean;
    launchConfigUsable: boolean;
    /** Optional so existing callers keep compiling; treated as usable when absent. */
    dexConfigUsable?: boolean;
    reason?: string;
  }>;
  /** Defaults to the config-derived policy; injectable so tests can exercise the
   *  thresholds without rewriting the environment. */
  treasuryPolicy?: TreasuryPolicy;
}

export async function validateLaunchRequest(
  intent: ParsedIntent,
  xUserId: string,
  sourceTweetId: string,
  deps: ValidatorDeps
): Promise<ValidationResult> {
  if (!intent.isLaunchIntent) {
    return { approved: false, reason: 'NOT_LAUNCH_INTENT' };
  }

  if (intent.confidence === 'low') {
    return { approved: false, reason: 'LOW_CONFIDENCE', detail: 'Ask the user to clarify the missing field(s).' };
  }

  if (!intent.tokenName || !intent.tokenSymbol) {
    return { approved: false, reason: 'MISSING_REQUIRED_FIELD' };
  }

  const cleanName = sanitizeName(intent.tokenName);
  const cleanSymbol = sanitizeSymbol(intent.tokenSymbol);
  if (!cleanName || !cleanSymbol) {
    return { approved: false, reason: 'FAILED_SANITIZATION' };
  }
  const cleanDescription = sanitizeDescription(intent.description);

  // -- Anti-Sybil signals (Part 5 §"Required mitigations" item 1) --
  const signals = await deps.getAccountSignals(xUserId);
  const accountAgeDays = (Date.now() - new Date(signals.accountCreatedAt).getTime()) / (1000 * 60 * 60 * 24);
  if (accountAgeDays < config.MIN_ACCOUNT_AGE_DAYS) {
    return { approved: false, reason: 'ACCOUNT_TOO_NEW' };
  }
  if (signals.followerCount < config.MIN_FOLLOWER_COUNT) {
    return { approved: false, reason: 'INSUFFICIENT_FOLLOWERS' };
  }

  // -- Per-user rate cap --
  const recentLaunches = deps.db.countLaunchesLast24h(xUserId);
  if (recentLaunches >= config.MAX_LAUNCHES_PER_USER_PER_DAY) {
    return { approved: false, reason: 'RATE_LIMIT_USER' };
  }

  // -- Global daily spend circuit breaker (Part 5 §"Required mitigations" item 2) --
  const liveFee = await deps.getLiveFeeWei();
  if (liveFee > config.TREASURY_MAX_FEE_WEI) {
    // The fee itself is higher than we're willing to ever pay per-launch, regardless of the
    // daily cap -- this catches a sudden fee hike on Pons's side (Part 5 §3.5).
    return { approved: false, reason: 'FEE_EXCEEDS_CEILING' };
  }
  const spentSoFar = deps.db.totalSpendLast24h();
  if (spentSoFar + liveFee > config.DAILY_SPEND_CAP_WEI) {
    return { approved: false, reason: 'DAILY_SPEND_CAP_REACHED' };
  }

  // -- Hot-wallet admission floor (Part 5 §"Required mitigations" item 7) --
  // Last money gate, and deliberately last: it is the only one that costs an RPC
  // round-trip, so everything cheap and deterministic gets to reject first.
  //
  // The daily cap above is a *policy* limit -- "we choose not to spend more today".
  // This is a *physical* one -- "there is not enough in the wallet". They fail
  // separately and mean different things to the operator, so they stay separate
  // reasons rather than one merged "out of budget".
  const balanceWei = await deps.getTreasuryBalanceWei();
  const assessment = assessHotWallet(balanceWei, liveFee, deps.treasuryPolicy ?? treasuryPolicyFromConfig());
  const admission = canAdmitLaunch(assessment);
  if (!admission.ok) {
    return { approved: false, reason: 'TREASURY_EXHAUSTED', detail: admission.detail };
  }

  // -- Would pons accept this launch at all? (master doc open question #23) --
  // Last, because it is the one guard whose answer belongs to somebody else. Everything above
  // is a decision this project makes; this is pons's factory telling us its door is shut.
  const readiness = await deps.getLaunchReadiness();
  const dexUsable = readiness.dexConfigUsable !== false;
  if (!readiness.canLaunch || !readiness.launchConfigUsable || !dexUsable) {
    return {
      approved: false,
      reason: 'LAUNCHPAD_UNAVAILABLE',
      detail: readiness.reason ?? 'the pons factory would refuse this launch',
    };
  }

  return {
    approved: true,
    sanitized: { tokenName: cleanName, tokenSymbol: cleanSymbol, description: cleanDescription },
  };
}
