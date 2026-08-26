import { assembleStatus, AcquiredSession, StatusPool } from '../src/statusSession';
import { StatusDeps, buildStatus } from '../src/statusReport';
import { RpcPool } from '../src/rpcPool';
import { executableDeployment } from '../src/deployments';
import { startFakeChain, FakeChain, MATCHING_SHA256 } from './fixtures/jsonRpcServer';

/**
 * The COMPOSITION, which is what was actually broken.
 *
 * `buildStatus` was bounded and tested as bounded. The route was not, because it did
 * `await rpcPool.acquire()` FIRST and `buildStatus` only starts its deadline when called.
 * Acquisition serially admits every candidate at the full admission timeout, so two stalled
 * endpoints cost 8 026 ms before the "one budget for the whole response" began -- 8 038 ms
 * total against a claimed 5 000 ms. The unit test passed the entire time; it called
 * `buildStatus` directly and never exercised the assembly.
 *
 * So the assembly is a function now, and these tests drive it.
 */

const D = { ...executableDeployment(), runtimeBytecodeSha256: MATCHING_SHA256 };
const ETH = 10n ** 18n;
const open: FakeChain[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function chain(opts: Parameters<typeof startFakeChain>[0] = {}): Promise<FakeChain> {
  const c = await startFakeChain(opts);
  open.push(c);
  return c;
}

const hang = () => new Promise<never>(() => {});

function deps(over: Partial<StatusDeps> = {}): StatusDeps {
  return {
    expectedChainId: D.chainId,
    getChainId: async () => D.chainId,
    getBlockNumber: async () => 1234,
    getTreasuryBalanceWei: async () => ETH / 50n,
    getLiveFeeWei: async () => ETH / 2000n,
    getLaunchReadiness: async () => ({ launchEnabled: true, whitelisted: false, canLaunch: true }),
    spentTodayWei: () => 0n,
    dailyCapWei: ETH / 100n,
    launchesToday: () => 0,
    coldAddressSet: true,
    parserRoute: 'OpenRouter',
    alertsRoute: 'Telegram',
    crossCheckHours: 6,
    publicLaunchEnabled: false,
    factoryVersion: 'v2',
    ...over,
  };
}

const find = (r: Awaited<ReturnType<typeof buildStatus>>, name: string) =>
  r.checks.find((c) => c.name === name);

/**
 * Deps that depend on the SESSION, exactly as the route builds them.
 *
 * A makeDeps that ignores its argument would report a healthy chain with no endpoint
 * admitted -- which is the opposite of what these tests exist to check.
 */
function sessionDeps(session: AcquiredSession | null, over: Partial<StatusDeps> = {}): StatusDeps {
  const unavailable = () => {
    throw new Error('no admitted RPC endpoint is available to serve this status request');
  };
  return deps({
    getChainId: async () => (session ? D.chainId : unavailable()),
    getBlockNumber: async () => (session ? 1234 : unavailable()),
    getLiveFeeWei: async () => (session ? ETH / 2000n : unavailable()),
    getTreasuryBalanceWei: async () => (session ? ETH / 50n : unavailable()),
    getLaunchReadiness: async () =>
      session ? { launchEnabled: true, whitelisted: false, canLaunch: true } : unavailable(),
    ...over,
  });
}

describe('one budget covers acquisition AND reporting', () => {
  it('does not spend endpointCount x admissionTimeout before the budget starts', async () => {
    // Two endpoints that never answer eth_chainId: admission stalls on each in turn. This
    // is the exact shape that measured 8 026 ms of acquisition on the route.
    const a = await chain({ hang: ['eth_chainId'] });
    const b = await chain({ hang: ['eth_chainId'] });
    const pool = new RpcPool([a.url, b.url], { deployment: D, admissionTimeoutMs: 4000 });

    const started = Date.now();
    const report = await assembleStatus(pool, (session) => sessionDeps(session), {
      totalBudgetMs: 800,
    });
    const elapsed = Date.now() - started;

    // Was 8 038 ms for this exact configuration. Generous tolerance; the point is that it
    // is bounded by the budget rather than by 2 x 4000ms + the budget.
    expect(elapsed).toBeLessThan(2500);
    expect(report.state).toBe('down');
    expect(find(report, 'rpc')!.state).toBe('down');
  }, 30_000);

  it('stays bounded when acquisition AND every check hangs', async () => {
    const a = await chain({ hang: ['eth_chainId'] });
    const b = await chain({ hang: ['eth_chainId'] });
    const pool = new RpcPool([a.url, b.url], { deployment: D, admissionTimeoutMs: 4000 });

    const started = Date.now();
    const report = await assembleStatus(
      pool,
      (session) =>
        sessionDeps(session, {
          getChainId: hang,
          getBlockNumber: hang,
          getLiveFeeWei: hang,
          getLaunchReadiness: hang,
          getTreasuryBalanceWei: hang,
          getDeploymentIdentity: hang,
        }),
      { totalBudgetMs: 900 }
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect(report.checks.length).toBeGreaterThan(0);
  }, 30_000);

  it('still returns a body when acquisition consumes the whole budget', async () => {
    // A status page that answers nothing has failed at its one job, so a reporting floor is
    // reserved even when the pool eats everything.
    const a = await chain({ hang: ['eth_chainId'] });
    const pool = new RpcPool([a.url], { deployment: D, admissionTimeoutMs: 4000 });

    const report = await assembleStatus(pool, (session) => sessionDeps(session), {
      totalBudgetMs: 300,
    });
    expect(report.checks.length).toBeGreaterThan(0);
    expect(find(report, 'public-launches')).toBeDefined();
  }, 30_000);

  it('says a check was not reached rather than blaming it for timing out', async () => {
    const a = await chain({ hang: ['eth_chainId'] });
    const pool = new RpcPool([a.url], { deployment: D, admissionTimeoutMs: 4000 });

    const report = await assembleStatus(
      pool,
      (session) =>
        sessionDeps(session, {
          getChainId: hang,
          getBlockNumber: hang,
          getLiveFeeWei: hang,
          getLaunchReadiness: hang,
        }),
      { totalBudgetMs: 400 }
    );
    const detail = report.checks.map((c) => c.detail).join(' | ');
    expect(detail).toMatch(/budget|did not answer/);
  }, 30_000);

  it('reports a refused-for-budget endpoint as a budget problem, not an endpoint problem', async () => {
    const a = await chain({ hang: ['eth_chainId'] });
    const b = await chain();
    const pool = new RpcPool([a.url, b.url], { deployment: D, admissionTimeoutMs: 4000 });
    await assembleStatus(pool, (session) => sessionDeps(session), { totalBudgetMs: 300 });

    const refusals = pool.status().endpoints.map((e) => e.refusedCode);
    // "We ran out of time" must not be recorded as a judgement about the endpoint, and must
    // not be cached: b is healthy and has to remain usable on the next request.
    expect(refusals).toContain('budget-exhausted');
    const healthy = await pool.acquire();
    expect(healthy).not.toBeNull();
  }, 30_000);

  it('a budget-exhausted refusal is never remembered as permanent', async () => {
    const a = await chain();
    const pool = new RpcPool([a.url], { deployment: D, admissionTimeoutMs: 4000 });
    // Zero budget: refused before being probed at all.
    await assembleStatus(pool, (session) => sessionDeps(session), { totalBudgetMs: 0 });
    expect(pool.status().endpoints[0].admitted).toBe(false);

    // The same endpoint, given time, is fine. A single slow response must not blacklist it.
    const session = await pool.acquire();
    expect(session).not.toBeNull();
  }, 30_000);
});

describe('the endpoint the page names is the endpoint the page used', () => {
  /** A pool whose global "preferred" endpoint can be moved out from under a response. */
  function movablePool(): StatusPool & { movePreferredTo(i: number): void } {
    const endpoints = [
      { identity: { origin: 'https://a.example', fingerprint: 'aaaaaaaaaaaa' } as any, admitted: true, probeMs: 1, checkedAt: null, ageMs: null },
      { identity: { origin: 'https://b.example', fingerprint: 'bbbbbbbbbbbb' } as any, admitted: true, probeMs: 1, checkedAt: null, ageMs: null },
    ];
    let activeIndex = 0;
    return {
      movePreferredTo(i: number) {
        activeIndex = i;
      },
      async acquire(): Promise<AcquiredSession> {
        return { provider: {} as any, endpoint: endpoints[0].identity, index: 0 };
      },
      status: () => ({ endpoints: [...endpoints], activeIndex }),
    };
  }

  it('labels the acquired endpoint even after a concurrent request moves the pool', async () => {
    const pool = movablePool();
    const report = await assembleStatus(
      pool,
      () =>
        deps({
          describeRpc: () => pool.status(),
          rollingSpendLast24hWei: () => 0n,
          // Another request wins the race and repoints the pool while this one is still
          // assembling its body.
          getLiveFeeWei: async () => {
            pool.movePreferredTo(1);
            return ETH / 2000n;
          },
        }),
      { totalBudgetMs: 2000 }
    );

    const line = find(report, 'rpc-endpoint')!.detail;
    expect(line).toContain('a.example');
    expect(line).not.toContain('b.example: ');
    expect(line).toContain('served this response');
    // And the machine-readable envelope agrees with the human line, which is the whole
    // point: one document must not give two answers to "which endpoint served this?".
    expect(report.spend?.observedThrough).toBe('aaaaaaaaaaaa');
  }, 20_000);

  it('falls back to the pool preference only when no session was pinned', async () => {
    const pool = movablePool();
    pool.movePreferredTo(1);
    const report = await buildStatus(
      deps({ describeRpc: () => pool.status() })
    );
    expect(find(report, 'rpc-endpoint')!.detail).toContain('b.example');
    expect(find(report, 'rpc-endpoint')!.detail).not.toContain('served this response');
  });
});

describe('an unknown rolling spend is not headroom', () => {
  const CAP = ETH / 100n;

  it('is NOT ok when the rolling figure is unavailable and the UTC day is zero', async () => {
    const r = await buildStatus(
      deps({ dailyCapWei: CAP, spentTodayWei: () => 0n, rollingSpendLast24hWei: undefined })
    );
    const c = find(r, 'daily-cap')!;
    // The rolling window is what admits a launch. A quiet calendar day says nothing about
    // it, and reporting ok would be a confident green light for a breaker nobody read.
    expect(c.state).not.toBe('ok');
    expect(c.detail).toContain('UNKNOWN');
  });

  it('is NOT ok when the rolling figure is unavailable and the UTC day is merely below cap', async () => {
    const r = await buildStatus(
      deps({ dailyCapWei: CAP, spentTodayWei: () => CAP / 2n, rollingSpendLast24hWei: undefined })
    );
    expect(find(r, 'daily-cap')!.state).not.toBe('ok');
  });

  it('is ok when the rolling figure is available and below cap', async () => {
    const r = await buildStatus(
      deps({ dailyCapWei: CAP, spentTodayWei: () => CAP, rollingSpendLast24hWei: () => CAP / 4n })
    );
    expect(find(r, 'daily-cap')!.state).toBe('ok');
  });

  it('is degraded when the rolling figure is at cap, whatever the UTC day says', async () => {
    const r = await buildStatus(
      deps({ dailyCapWei: CAP, spentTodayWei: () => 0n, rollingSpendLast24hWei: () => CAP })
    );
    expect(find(r, 'daily-cap')!.state).toBe('degraded');
  });

  it('never implies the calendar figure is the operative breaker', async () => {
    for (const rolling of [undefined, () => CAP / 4n]) {
      const r = await buildStatus(
        deps({ dailyCapWei: CAP, spentTodayWei: () => CAP / 2n, rollingSpendLast24hWei: rolling })
      );
      expect(find(r, 'daily-cap')!.detail).toContain('accounting only');
      expect(find(r, 'daily-cap')!.detail).not.toContain('midnight');
    }
  });

  it('omits the typed spend envelope when the rolling value is unavailable', async () => {
    const r = await buildStatus(deps({ rollingSpendLast24hWei: undefined }));
    // Absent refuses; a calendar-derived substitute would admit.
    expect(r.spend).toBeUndefined();
  });
});
