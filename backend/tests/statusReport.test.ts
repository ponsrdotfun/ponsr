import { buildStatus, statusHttpCode, StatusDeps } from '../src/statusReport';

/**
 * `/health` says `ok` as soon as the process is listening. These tests are about
 * the gap that leaves: the bot can be listening, answering `ok`, and unable to
 * launch anything at all. Each case below is a way that happens.
 */

const ETH = 10n ** 18n;
const FEE = ETH / 2000n; // 0.0005 ETH, the live mainnet fee on 2026-08-06

function deps(over: Partial<StatusDeps> = {}): StatusDeps {
  return {
    expectedChainId: 4663,
    getChainId: async () => 4663,
    getBlockNumber: async () => 1234,
    getTreasuryBalanceWei: async () => ETH / 50n, // 0.02 ETH -> 40 launches
    getLiveFeeWei: async () => FEE,
    getLaunchReadiness: async () => ({ launchEnabled: true, whitelisted: false }),
    spentTodayWei: () => 0n,
    /**
     * Supplied because production supplies it, and because its ABSENCE is now meaningful.
     *
     * The rolling 24h figure is what validator.ts admits against. When it cannot be read,
     * daily-cap reports UNKNOWN rather than falling back to the calendar day -- unknown is
     * not headroom. These tests are about other things, so they provide it.
     */
    rollingSpendLast24hWei: () => 0n,
    dailyCapWei: ETH / 100n,
    launchesToday: () => 0,
    coldAddressSet: true,
    parserRoute: 'OpenRouter',
    alertsRoute: 'Telegram',
    crossCheckHours: 6,
    publicLaunchEnabled: true,
    factoryVersion: 'v1',
    deploymentId: 'pons-v2-current-7ed',
    deploymentFactory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
    ...over,
  };
}

const find = (r: Awaited<ReturnType<typeof buildStatus>>, name: string) =>
  r.checks.find((c) => c.name === name)!;

describe('buildStatus', () => {
  it('reports ok when every dependency answers', async () => {
    const r = await buildStatus(deps());
    expect(r.state).toBe('ok');
    expect(statusHttpCode(r)).toBe(200);
    expect(find(r, 'rpc').detail).toContain('block 1234');
  });

  // The whole reason this endpoint exists: a hung RPC must produce an answer, not
  // a hung request. A status page that waits is silent exactly when it is needed.
  it('bounds a dependency that never answers instead of hanging', async () => {
    const started = Date.now();
    const r = await buildStatus(
      deps({ getBlockNumber: () => new Promise(() => {}) }),
      60
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(find(r, 'rpc').state).toBe('down');
    expect(r.state).toBe('down');
    expect(statusHttpCode(r)).toBe(503);
  });

  // One dependency failing must not stop the others being reported. "The RPC is
  // down" and "the RPC is down and the cap is spent" are different mornings.
  it('still reports local state when the chain is unreachable', async () => {
    const r = await buildStatus(
      deps({
        getChainId: async () => { throw new Error('ECONNREFUSED'); },
        getLiveFeeWei: async () => { throw new Error('ECONNREFUSED'); },
        getTreasuryBalanceWei: async () => { throw new Error('ECONNREFUSED'); },
        getLaunchReadiness: async () => { throw new Error('ECONNREFUSED'); },
        spentTodayWei: () => ETH / 100n,
        launchesToday: () => 20,
      }),
    );
    expect(find(r, 'rpc').state).toBe('down');
    expect(find(r, 'daily-cap').detail).toContain('20 launch(es)');
    expect(find(r, 'alerts').state).toBe('ok');
  });

  // An RPC pointed at the wrong network answers every call happily and every
  // answer is about somewhere else.
  it('calls the wrong chain down rather than ok', async () => {
    const r = await buildStatus(deps({ getChainId: async () => 1 }));
    expect(find(r, 'rpc').state).toBe('down');
    expect(find(r, 'rpc').detail).toContain('expected 4663');
  });

  it('reports Ponsr public launching paused independently of an open upstream factory', async () => {
    const r = await buildStatus(deps({ publicLaunchEnabled: false }));
    expect(find(r, 'public-launches').state).toBe('degraded');
    expect(find(r, 'public-launches').detail).toMatch(/before parsing.*signing.*broadcast/i);
    expect(find(r, 'launchpad').state).toBe('ok');
    expect(r.state).toBe('degraded');
  });

  it('flags a launchpad pons has switched off', async () => {
    const r = await buildStatus(
      deps({ getLaunchReadiness: async () => ({ launchEnabled: false, whitelisted: false }) })
    );
    expect(find(r, 'launchpad').state).toBe('degraded');
    expect(r.state).toBe('degraded');
    expect(statusHttpCode(r)).toBe(200);
  });

  // Whitelisting only applies while launching is globally off, so this is the one
  // case where a disabled launchpad is survivable.
  it('does not treat a disabled launchpad as fatal when whitelisted', async () => {
    const r = await buildStatus(
      deps({ getLaunchReadiness: async () => ({ launchEnabled: false, whitelisted: true }) })
    );
    expect(find(r, 'launchpad').detail).toContain('whitelisted');
  });

  it('counts the hot wallet in launches, not ETH alone', async () => {
    const r = await buildStatus(deps({ getTreasuryBalanceWei: async () => FEE * 3n }));
    expect(find(r, 'treasury-hot').detail).toContain('funds 3 launches');
    expect(find(r, 'treasury-hot').state).toBe('degraded');
  });

  it('calls a hot wallet that cannot fund one launch down', async () => {
    const r = await buildStatus(deps({ getTreasuryBalanceWei: async () => FEE / 2n }));
    expect(find(r, 'treasury-hot').state).toBe('down');
  });

  // The breaker firing is the system working. It is reported because otherwise
  // every launch is refused for a reason nobody can see.
  it('says so when the daily cap is spent', async () => {
    // The ROLLING figure is the one that refuses launches, so it is the one that must be
    // at cap for the page to say the breaker is spent.
    const r = await buildStatus(
      deps({ rollingSpendLast24hWei: () => ETH / 100n, spentTodayWei: () => ETH / 100n, launchesToday: () => 20 })
    );
    expect(find(r, 'daily-cap').state).toBe('degraded');
    expect(find(r, 'daily-cap').detail).toContain('(100%)');
  });

  it('reports an unset cold address as a split that is not real', async () => {
    const r = await buildStatus(deps({ coldAddressSet: false }));
    expect(find(r, 'treasury-cold').state).toBe('degraded');
    expect(find(r, 'treasury-cold').detail).toContain('not protection');
  });

  it('reports a disabled cross-check, since its absence is invisible by design', async () => {
    const r = await buildStatus(deps({ crossCheckHours: 0 }));
    expect(find(r, 'mention-crosscheck').state).toBe('degraded');
  });

  // Overall state is the worst check, not an average: one dead dependency is not
  // softened by eight healthy ones.
  it('takes the worst check as the overall state', async () => {
    const r = await buildStatus(
      deps({ coldAddressSet: false, getChainId: async () => { throw new Error('x'); } })
    );
    expect(r.state).toBe('down');
  });

  // "AAPL is not approved" and "the bot never managed to read the approved set"
  // produce exactly the same refusal to a user, so they must not look the same here.
  it('lists the assets a launch can be paired against on v2', async () => {
    const r = await buildStatus(deps({ factoryVersion: 'v2', listPairAssets: async () => ['AAPL', 'TSLA'] }));
    expect(find(r, 'pair-assets').detail).toBe('AAPL, TSLA');
    expect(find(r, 'pair-assets').state).toBe('ok');
  });

  it('flags an approved set that could not be read, without calling it an outage', async () => {
    const r = await buildStatus(
      deps({ factoryVersion: 'v2', listPairAssets: async () => { throw new Error('ECONNREFUSED'); } })
    );
    expect(find(r, 'pair-assets').state).toBe('degraded');
    expect(r.state).not.toBe('down');
  });

  // pons approving nothing is a real state, not a fault -- but every pairing request
  // will be refused, which is worth seeing before investigating it as a bug.
  it('distinguishes an empty approved set from a failure', async () => {
    const r = await buildStatus(deps({ factoryVersion: 'v2', listPairAssets: async () => [] }));
    expect(find(r, 'pair-assets').state).toBe('degraded');
    expect(find(r, 'pair-assets').detail).toContain('none approved');
  });

  it('says plainly that v1 prices everything in ETH', async () => {
    const r = await buildStatus(deps({ factoryVersion: 'v1' }));
    expect(find(r, 'pair-assets').detail).toContain('ETH');
    expect(find(r, 'pair-assets').state).toBe('ok');
  });

  // Calling the parser would bill on every poll, so it is reported as configured
  // rather than proven. Saying which is the difference between a status page and
  // a decoration.
  it('is explicit that the parser was not actually called', async () => {
    const r = await buildStatus(deps());
    expect(find(r, 'parser').detail).toContain('not called');
  });
});
