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

/**
 * Named as the interface names them.
 *
 * This said `chainId` and `blockNumber`, which StatusDeps does not have — and
 * `as unknown as StatusDeps` silenced it, so `deps.getChainId` was undefined in every test
 * here. Nothing noticed until buildStatus started calling it. A cast that lets a fixture
 * disagree with the interface removes the one check that would have said so.
 */
const base = {
  expectedChainId: 4663,
  getChainId: async () => 4663,
  getBlockNumber: async () => 1,
  publicLaunchEnabled: false,
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

/**
 * The envelope must describe the runtime that was observed, not the one configured.
 *
 * It was assembled before the RPC read and took chainId from `expectedChainId`. A backend
 * connected to the wrong chain therefore published an envelope naming the chain it was
 * supposed to be on, and a consumer binding against it passed. The separate `rpc: down`
 * check said so elsewhere — but nothing reading the typed block ever saw that.
 */
describe('the spend envelope is evidence, not configuration', () => {
  const withChain = (observed: number, over: Record<string, unknown> = {}) =>
    ({
      ...base,
      expectedChainId: 4663,
      getChainId: async () => observed,
      rollingSpendLast24hWei: () => 1_000_000_000_000_000n,
      deploymentId: 'pons-v2-current-7ed',
      deploymentFactory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
      treasuryAddress: '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa',
      publicLaunchEnabled: false,
      ...over,
    }) as unknown as StatusDeps;

  it('publishes the observed chain id when it matches', async () => {
    const r = await buildStatus(withChain(4663));
    expect(r.spend).toBeDefined();
    expect(r.spend!.chainId).toBe(4663);
  });

  it('publishes NO envelope when the observed chain disagrees with the expected one', async () => {
    const r = await buildStatus(withChain(1));
    expect(r.spend).toBeUndefined();
  });

  it('publishes no envelope when the chain cannot be read at all', async () => {
    const r = await buildStatus(
      withChain(4663, {
        getChainId: async () => {
          throw new Error('RPC unavailable');
        },
      })
    );
    expect(r.spend).toBeUndefined();
  });

  it('carries the deployment, factory, treasury and public gate', async () => {
    const r = await buildStatus(withChain(4663));
    expect(r.spend!.deploymentId).toBe('pons-v2-current-7ed');
    expect(r.spend!.factory).toBe('0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e');
    expect(r.spend!.treasury).toBe('0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa');
    expect(r.spend!.publicLaunchEnabled).toBe(false);
    expect(Date.parse(r.spend!.generatedAt)).toBeGreaterThan(0);
  });

  it('reports the public gate honestly when it is open', async () => {
    const r = await buildStatus(withChain(4663, { publicLaunchEnabled: true }));
    expect(r.spend!.publicLaunchEnabled).toBe(true);
  });
});

/**
 * One request, one observed chain.
 *
 * The envelope read the chain and the rpc check read it again. Two reads can disagree — a
 * provider failing over between them produces a single response carrying a spend envelope
 * bound to 4663 while `rpc` reports down for a different chain. The canary consumes the
 * envelope on its own, so one self-contradicting response could still admit.
 */
describe('the chain is observed once per report', () => {
  const counting = (answers: number[]) => {
    let calls = 0;
    return {
      deps: {
        ...base,
        expectedChainId: 4663,
        getChainId: async () => {
          const v = answers[Math.min(calls, answers.length - 1)];
          calls += 1;
          return v;
        },
        getBlockNumber: async () => 1,
        rollingSpendLast24hWei: () => 1_000_000_000_000_000n,
        deploymentId: 'pons-v2-current-7ed',
        deploymentFactory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
        treasuryAddress: '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa',
        publicLaunchEnabled: false,
      } as unknown as StatusDeps,
      calls: () => calls,
    };
  };

  it('calls getChainId exactly once', async () => {
    const c = counting([4663]);
    await buildStatus(c.deps);
    expect(c.calls()).toBe(1);
  });

  /**
   * The regression. With two reads, the first answer built an admissible envelope and the
   * second produced `rpc: down` — a report that contradicts itself and still admits.
   */
  it('cannot emit an admissible envelope alongside an rpc-down check', async () => {
    const c = counting([4663, 1]);
    const r = await buildStatus(c.deps);
    const rpc = r.checks.find((x) => x.name === 'rpc')!;
    if (rpc.state === 'down') expect(r.spend).toBeUndefined();
    else expect(r.spend!.chainId).toBe(4663);
  });

  it('omits the envelope and reports rpc down from the same failed observation', async () => {
    const deps = {
      ...base,
      expectedChainId: 4663,
      getChainId: async () => {
        throw new Error('RPC unavailable');
      },
      getBlockNumber: async () => 1,
      rollingSpendLast24hWei: () => 1n,
      publicLaunchEnabled: false,
    } as unknown as StatusDeps;
    const r = await buildStatus(deps);
    expect(r.spend).toBeUndefined();
    expect(r.checks.find((x) => x.name === 'rpc')!.state).toBe('down');
  });
});
