/**
 * The canary answers to the same daily spend cap as the bot.
 *
 * `phase-b-launch.ts` checked the treasury balance, the per-launch fee ceiling, and a gas
 * reserve. None of those is the circuit breaker. The breaker is a rolling 24-hour total,
 * and Part 5's audit is explicit about why it exists: an attacker does not need to steal
 * anything, only to make the bot spend. An operator script that ignores it is a second
 * spender against a single budget.
 *
 * The canary plan asserted the launch "fits comfortably" inside the cap. It probably does.
 * Nothing in the code had ever checked, which is the difference between a fact and a hope.
 *
 * WHAT THIS CANNOT DO, AND WHY IT SAYS SO OUT LOUD
 * -----------------------------------------------
 * The bot's ledger is SQLite on the Fly volume; the canary runs on the operator's machine.
 * There is no shared transaction between them, so there is no atomic reservation: between
 * reading the bot's accounted spend and the canary's launch landing, the bot could admit a
 * launch of its own.
 *
 * Two things narrow it and neither closes it. `PUBLIC_LAUNCH_ENABLED=false` means the bot
 * currently admits nothing -- but a gate that happens to be shut is not an invariant, and
 * treating it as one is how a temporary state becomes an assumption. And the bot's own
 * accounted total is readable over an unauthenticated status endpoint, so the number used
 * here is authoritative rather than guessed.
 *
 * The residual is returned in `caveat` so it prints in the operator's output. A limitation
 * recorded only in a comment is a limitation nobody reads at the moment it matters.
 */

export interface CanarySpendInput {
  /** The bot's own accounted spend over its rolling window. NULL means it could not be read. */
  botSpentWei: bigint | null;
  /** Fees this journal has already recorded for the same window. */
  journalSpentWei: bigint;
  feeWei: bigint;
  capWei: bigint;
}

export interface CanarySpendVerdict {
  admitted: boolean;
  reason?: string;
  totalAfterWei?: bigint;
  remainingAfterWei?: bigint;
  caveat: string;
}

const CAVEAT =
  'The bot ledger and this journal are separate stores, so admission is not atomic: ' +
  'between this read and the launch landing, a running bot could admit a launch of its own. ' +
  'PUBLIC_LAUNCH_ENABLED=false narrows the window but is a state, not an invariant.';

/**
 * Admits or refuses, on the same rule the production breaker uses.
 *
 * At the exact cap it ADMITS. `validator.ts` refuses what exceeds the cap, not what
 * reaches it, and quietly using a stricter rule here would make the canary refuse launches
 * the bot would allow -- a divergence that looks like a bug in whichever one you happen to
 * be reading.
 */
export function admitCanarySpend(input: CanarySpendInput): CanarySpendVerdict {
  if (input.botSpentWei === null) {
    // Not zero. "Could not ask" reported as "nothing spent" is the same error the Turnkey
    // verifier made in reporting a quota failure as a policy denial, and it fails in the
    // expensive direction: admitting a canary on top of a full day of bot spending.
    return {
      admitted: false,
      reason:
        "the bot's accounted spend could not be read, and an unknown ledger is not an empty one. " +
        'Read /status and supply the figure, or establish that the bot is not spending.',
      caveat: CAVEAT,
    };
  }

  const totalAfter = input.botSpentWei + input.journalSpentWei + input.feeWei;
  if (totalAfter > input.capWei) {
    return {
      admitted: false,
      reason:
        `the launch fee would take the day to ${totalAfter} wei against a cap of ${input.capWei} wei ` +
        `(bot ${input.botSpentWei}, canary journal ${input.journalSpentWei}, fee ${input.feeWei})`,
      totalAfterWei: totalAfter,
      caveat: CAVEAT,
    };
  }

  return {
    admitted: true,
    totalAfterWei: totalAfter,
    remainingAfterWei: input.capWei - totalAfter,
    caveat: CAVEAT,
  };
}

/**
 * Pulls the bot's accounted spend out of its own status detail line.
 *
 * The shape is produced by statusReport.ts's daily-cap check:
 *
 *   "0.0030 ETH of 0.0100 ETH spent today (30%), 3 launch(es)"
 *
 * Returns null, never zero, when the string is not that shape. A parser that falls back to
 * zero turns a format change into a silently raised spending limit.
 */
export function parseBotSpentWei(detail: string): bigint | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*ETH\s+of\s+[0-9.]+\s*ETH\s+spent today/i.exec(detail ?? '');
  if (!m) return null;
  const [whole, frac = ''] = m[1].split('.');
  const padded = (frac + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(padded);
}

/**
 * Reads the bot's ROLLING 24-hour spend from its status report.
 *
 * Replaces a regex over a human-readable sentence. That string was produced from a UTC
 * calendar-day total while `validator.ts` admits against `db.totalSpendLast24h()`, so the
 * canary was checking a different budget from the one that actually refuses launches --
 * and a sentence cannot say which window it means, so the mistake was invisible.
 *
 * Every refusal below returns null, never zero. An unreadable ledger must refuse; a zero
 * would admit.
 */
export function readBotRollingSpend(report: unknown, expectedCapWei?: bigint): bigint | null {
  const spend = (report as { spend?: Record<string, unknown> } | null)?.spend;
  if (!spend || typeof spend !== 'object') return null;
  // The window must be named, and named correctly. An unlabelled figure is exactly the
  // thing that went wrong: right shape, wrong meaning.
  if (spend.window !== 'rolling-24h') return null;

  const raw = spend.rolling24hWei;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null;

  if (expectedCapWei !== undefined) {
    const cap = spend.capWei;
    // Disagreement about the cap means the two are not measuring one budget, and admitting
    // against a ceiling nobody shares is worse than refusing.
    if (typeof cap !== 'string' || !/^[0-9]+$/.test(cap) || BigInt(cap) !== expectedCapWei) return null;
  }
  return BigInt(raw);
}
