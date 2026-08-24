import { buildStatus, StatusDeps } from '../src/statusReport';

/**
 * Whether the status page can see that the bot has gone deaf.
 *
 * On 2026-08-24 production had been answering `402 Credits is not enough` on every mention
 * poll, every two minutes, across the entire retained log window. `/status` reported:
 *
 *     mention-crosscheck = ok
 *     alerts             = ok
 *     overall            = degraded   (for an unrelated reason)
 *
 * Both of those checks read CONFIGURATION -- is a cross-check interval set, is a Telegram
 * token present -- and configuration cannot go wrong in the way that mattered. Nothing on
 * the page could distinguish "polling and finding nothing" from "not polling at all",
 * because a dead read path and a quiet afternoon produce identical evidence: no mentions.
 *
 * The single alert that did fire had scrolled out of the operator's Telegram days earlier.
 * One line, once, days ago, is indistinguishable from no line at all.
 *
 * These tests exist so that combination cannot recur silently.
 */

const base: StatusDeps = {
  chainId: async () => 4663,
  blockNumber: async () => 42_935_366,
  getLiveFeeWei: async () => 500_000_000_000_000n,
  getLaunchReadiness: async () => ({ canLaunch: true, launchConfigUsable: true }),
  getTreasuryBalanceWei: async () => 26_000_000_000_000_000n,
  spentTodayWei: () => 0n,
  dailyCapWei: 10_000_000_000_000_000n,
  launchesToday: () => 0,
  coldAddressSet: true,
  parserRoute: 'OpenRouter',
  alertsRoute: 'Telegram',
  crossCheckHours: 6,
  factoryVersion: 'v2',
} as unknown as StatusDeps;

const find = (r: { checks: Array<{ name: string; state: string; detail?: string }> }, name: string) =>
  r.checks.find((c) => c.name === name);

describe('the status page reports whether the bot is hearing anything', () => {
  it('is ok, and says how recently, when the sweep is succeeding', async () => {
    const r = await buildStatus({
      ...base,
      sweepHealth: () => ({
        lastSuccessAt: new Date(Date.now() - 60_000).toISOString(),
        consecutiveFailures: 0,
        lastError: null,
      }),
    } as StatusDeps);
    const c = find(r, 'mention-sweep');
    expect(c?.state).toBe('ok');
    expect(c?.detail).toMatch(/last success/i);
  });

  /**
   * `down`, not `degraded`. A bot that cannot read mentions is not a degraded bot, it is an
   * absent one, and every other check on the page can be green while this is the only thing
   * that matters.
   */
  it('reports down, and names the cause, while the sweep is failing', async () => {
    const r = await buildStatus({
      ...base,
      sweepHealth: () => ({
        lastSuccessAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
        consecutiveFailures: 120,
        lastError: 'twitterapi.io 402 on /twitter/tweet/advanced_search: Credits is not enough',
      }),
    } as StatusDeps);
    const c = find(r, 'mention-sweep');
    expect(c?.state).toBe('down');
    expect(c?.detail).toMatch(/120 consecutive/);
    expect(c?.detail).toMatch(/402|Credits/i);
    expect(r.state).toBe('down');
  });

  /** A sweep that has never succeeded has proven nothing about itself, so it is not a pass. */
  it('does not report ok before any poll has ever succeeded', async () => {
    const r = await buildStatus({
      ...base,
      sweepHealth: () => ({ lastSuccessAt: null, consecutiveFailures: 0, lastError: null }),
    } as StatusDeps);
    expect(find(r, 'mention-sweep')?.state).not.toBe('ok');
  });

  /**
   * The exact production shape: a long-stale last success with the failure counter reset.
   * Counting failures alone would call this healthy.
   */
  it('catches a stale sweep even when nothing is currently counted as failing', async () => {
    const r = await buildStatus({
      ...base,
      sweepStaleAfterMs: 15 * 60_000,
      sweepHealth: () => ({
        lastSuccessAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
        consecutiveFailures: 0,
        lastError: null,
      }),
    } as StatusDeps);
    expect(find(r, 'mention-sweep')?.state).toBe('down');
  });
});

describe('the status page watches the prepaid balance it depends on', () => {
  /**
   * Zero is not the floor. The measured value on the day this was found was -89, returned
   * with HTTP 200 by an endpoint that is free, while every paid call was refusing with 402.
   * A threshold written as `credits === 0` reports healthy on an already-overdrawn account.
   */
  it('reports down on a negative balance, not just an empty one', async () => {
    const r = await buildStatus({
      ...base,
      readCredits: async () => ({ credits: -89, bonus: 0 }),
    } as StatusDeps);
    const c = find(r, 'read-credits');
    expect(c?.state).toBe('down');
    expect(c?.detail).toMatch(/-89/);
    expect(c?.detail).toMatch(/EXHAUSTED/i);
  });

  it('warns before it runs out, not after', async () => {
    const r = await buildStatus({ ...base, readCredits: async () => ({ credits: 400, bonus: 0 }) } as StatusDeps);
    expect(find(r, 'read-credits')?.state).toBe('degraded');
  });

  it('is ok with a healthy balance', async () => {
    const r = await buildStatus({ ...base, readCredits: async () => ({ credits: 50_000, bonus: 0 }) } as StatusDeps);
    expect(find(r, 'read-credits')?.state).toBe('ok');
  });

  /** "No balance to report" and "no balance left" must never collapse into one reading. */
  it('does not treat a provider without a balance as an exhausted one', async () => {
    const r = await buildStatus({ ...base, readCredits: async () => null } as StatusDeps);
    expect(find(r, 'read-credits')?.state).toBe('ok');
  });

  /** A monitoring read must never be the thing that breaks the page that monitors. */
  it('degrades rather than throwing when the balance cannot be read', async () => {
    const r = await buildStatus({
      ...base,
      readCredits: async () => {
        throw new Error('network');
      },
    } as StatusDeps);
    expect(find(r, 'read-credits')?.state).toBe('degraded');
  });
});
