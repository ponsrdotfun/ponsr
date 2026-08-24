import { buildStatus, StatusDeps } from '../src/statusReport';
import { readBotRollingSpend } from '../src/canarySpend';

/**
 * The canary and the breaker must count the same window.
 *
 * `validator.ts` admits against `db.totalSpendLast24h()` — a ROLLING 24 hours. `/status`
 * reported `totalSpendBetween(startOfUtcDay(), now)` — a UTC CALENDAR DAY — under a comment
 * claiming it was "the same window the circuit breaker counts". It was not.
 *
 * The two agree for most of the day and diverge exactly when it is expensive. At 00:01 UTC
 * the calendar figure resets to near zero while the breaker still counts everything spent
 * since 00:01 the previous day. A canary admitting against the calendar number can be told
 * it has a full cap of headroom while the real breaker has almost none.
 *
 * So the canary now reads a TYPED field and verifies which window it names. A human-readable
 * detail string cannot say which window it means, and parsing one is how the wrong number
 * gets used with total confidence.
 */

const CAP = 10_000_000_000_000_000n;

const base = {
  chainId: async () => 4663,
  blockNumber: async () => 1,
  getLiveFeeWei: async () => 500_000_000_000_000n,
  getLaunchReadiness: async () => ({ canLaunch: true, launchConfigUsable: true }),
  getTreasuryBalanceWei: async () => 26_000_000_000_000_000n,
  spentTodayWei: () => 0n,
  dailyCapWei: CAP,
  launchesToday: () => 0,
  coldAddressSet: true,
  parserRoute: 'OpenRouter',
  alertsRoute: 'Telegram',
  crossCheckHours: 6,
  factoryVersion: 'v2',
} as unknown as StatusDeps;

describe('the status report exposes the rolling window as a typed field', () => {
  it('publishes rolling-24h spend separately from the calendar-day figure', async () => {
    const r = await buildStatus({
      ...base,
      spentTodayWei: () => 1_000_000_000_000_000n, // calendar day: 0.001
      rollingSpendLast24hWei: () => 8_000_000_000_000_000n, // rolling: 0.008
    } as StatusDeps);

    expect(r.spend).toBeDefined();
    expect(r.spend!.window).toBe('rolling-24h');
    expect(r.spend!.rolling24hWei).toBe('8000000000000000');
    expect(r.spend!.capWei).toBe(CAP.toString());
    // The calendar figure is still published, under its own name, so the operational
    // display can keep it without anything mistaking it for the breaker's window.
    expect(r.spend!.currentUtcDayWei).toBe('1000000000000000');
  });

  it('omits the block entirely rather than guessing when the rolling figure is unavailable', async () => {
    const r = await buildStatus(base);
    expect(r.spend).toBeUndefined();
  });
});

describe('the canary reads the rolling figure, and refuses anything else', () => {
  const report = (over: Record<string, unknown> = {}) => ({
    spend: {
      window: 'rolling-24h',
      rolling24hWei: '8000000000000000',
      capWei: CAP.toString(),
      currentUtcDayWei: '1000000000000000',
      ...over,
    },
  });

  it('reads the rolling value as an exact integer', () => {
    expect(readBotRollingSpend(report())).toBe(8_000_000_000_000_000n);
  });

  /** The divergence the reviewer found, asserted directly. */
  it('never falls back to the calendar-day figure', () => {
    expect(readBotRollingSpend(report())).not.toBe(1_000_000_000_000_000n);
  });

  it('refuses a report that does not name the window', () => {
    expect(readBotRollingSpend(report({ window: undefined }))).toBeNull();
  });

  it('refuses a report naming a different window', () => {
    expect(readBotRollingSpend(report({ window: 'utc-day' }))).toBeNull();
  });

  it('refuses a malformed amount rather than coercing it', () => {
    expect(readBotRollingSpend(report({ rolling24hWei: '' }))).toBeNull();
    expect(readBotRollingSpend(report({ rolling24hWei: 'lots' }))).toBeNull();
    expect(readBotRollingSpend(report({ rolling24hWei: 1.5 }))).toBeNull();
  });

  it('refuses a report with no spend block at all', () => {
    expect(readBotRollingSpend({})).toBeNull();
    expect(readBotRollingSpend(null)).toBeNull();
  });

  /**
   * A cap the bot disagrees about means the two are not measuring the same budget, and
   * proceeding would admit against a ceiling nobody shares.
   */
  it('refuses when the reported cap differs from the local one', () => {
    expect(readBotRollingSpend(report(), CAP)).toBe(8_000_000_000_000_000n);
    expect(readBotRollingSpend(report({ capWei: '999' }), CAP)).toBeNull();
  });
});
