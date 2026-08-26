import { buildStatus, StatusDeps } from '../src/statusReport';

/**
 * What `/status` publishes about ITSELF: which endpoint answered, what the readiness check
 * cost, and whether the contract identity was measured or remembered.
 *
 * The outage these exist for produced exactly one line -- `launchpad: down -- launch
 * readiness did not answer within 5000ms` -- which is equally consistent with a closed
 * launchpad, a slow endpoint, a wrong endpoint and a bug. Every assertion below is about
 * being able to tell those apart from the page alone.
 */

const ETH = 10n ** 18n;
const FEE = ETH / 2000n;

function deps(over: Partial<StatusDeps> = {}): StatusDeps {
  return {
    expectedChainId: 4663,
    getChainId: async () => 4663,
    getBlockNumber: async () => 1234,
    getTreasuryBalanceWei: async () => ETH / 50n,
    getLiveFeeWei: async () => FEE,
    getLaunchReadiness: async () => ({ launchEnabled: true, whitelisted: false }),
    spentTodayWei: () => 0n,
    dailyCapWei: ETH / 100n,
    launchesToday: () => 0,
    coldAddressSet: true,
    parserRoute: 'OpenRouter',
    alertsRoute: 'Telegram',
    crossCheckHours: 6,
    publicLaunchEnabled: true,
    factoryVersion: 'v2',
    deploymentId: 'pons-v2-current-7ed',
    deploymentFactory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
    ...over,
  };
}

const find = (r: Awaited<ReturnType<typeof buildStatus>>, name: string) =>
  r.checks.find((c) => c.name === name);

const ENDPOINT = {
  identity: { origin: 'https://rpc.mainnet.chain.robinhood.com', fingerprint: '78ccdeee5ef1' },
  admitted: true,
  probeMs: 12,
};

describe('/status names the endpoint it is talking to', () => {
  it('publishes the active origin and fingerprint', async () => {
    const r = await buildStatus(
      deps({ describeRpc: () => ({ endpoints: [ENDPOINT], activeIndex: 0 }) })
    );
    const c = find(r, 'rpc-endpoint')!;
    expect(c.state).toBe('ok');
    // The fingerprint is what lets an operator confirm the backend is on the endpoint they
    // just tested, which RPC_URL being an unreadable Fly secret made impossible.
    expect(c.detail).toContain('rpc.mainnet.chain.robinhood.com');
    expect(c.detail).toContain('78ccdeee5ef1');
  });

  it('names a refused endpoint and why, without degrading a healthy primary', async () => {
    const r = await buildStatus(
      deps({
        describeRpc: () => ({
          endpoints: [
            ENDPOINT,
            {
              identity: { origin: 'https://rpc.testnet.chain.robinhood.com', fingerprint: 'aaaabbbbcccc' },
              admitted: false,
              refusedBecause: 'chain id is 46630, but pons-v2-current-7ed is on 4663',
              probeMs: 30,
            },
          ],
          activeIndex: 0,
        }),
      })
    );
    const c = find(r, 'rpc-endpoint')!;
    // A misconfigured fallback beside a working primary is not an outage. Escalating it
    // would train an operator to ignore the check.
    expect(c.state).toBe('ok');
    expect(c.detail).toContain('REFUSED');
    expect(c.detail).toContain('chain id is 46630');
  });

  it('is degraded when nothing has been admitted', async () => {
    const r = await buildStatus(
      deps({
        describeRpc: () => ({
          endpoints: [{ ...ENDPOINT, admitted: false, refusedBecause: 'could not be probed' }],
          activeIndex: null,
        }),
      })
    );
    expect(find(r, 'rpc-endpoint')!.state).toBe('degraded');
  });

  it('stays absent rather than inventing an endpoint when nothing reports one', async () => {
    const r = await buildStatus(deps());
    expect(find(r, 'rpc-endpoint')).toBeUndefined();
  });
});

describe('/status publishes what the readiness check cost', () => {
  const timings = [
    { name: 'launchEnabled', ms: 1801, ok: true, shared: true },
    { name: 'canLaunch', ms: 1799, ok: true, shared: true },
  ];

  it('reports the cost on the HEALTHY path, not only after a failure', async () => {
    const r = await buildStatus(
      deps({
        getLaunchReadiness: async () => ({
          launchEnabled: true,
          whitelisted: false,
          canLaunch: true,
          timings,
          totalMs: 1808,
        }),
      })
    );
    const c = find(r, 'launchpad')!;
    expect(c.state).toBe('ok');
    // Without a healthy baseline there is nothing to compare a slow day against, which is
    // how a four-round-trip check went unnoticed until it started timing out.
    expect(c.detail).toContain('read in 1808ms');
    expect(c.detail).toContain('2 calls in one batch');
  });

  it('does not present shared batch figures as per-call costs', async () => {
    const r = await buildStatus(
      deps({
        getLaunchReadiness: async () => ({
          launchEnabled: true,
          whitelisted: false,
          canLaunch: true,
          timings,
          totalMs: 1808,
        }),
      })
    );
    // Two near-identical numbers read as two slow calls; they were one slow round trip.
    expect(find(r, 'launchpad')!.detail).not.toContain('slowest call');
  });

  it('names the slowest call when the figures are genuinely per-call', async () => {
    const r = await buildStatus(
      deps({
        getLaunchReadiness: async () => ({
          launchEnabled: true,
          whitelisted: false,
          canLaunch: true,
          timings: [
            { name: 'launchEnabled', ms: 40, ok: true, shared: false },
            { name: 'getLaunchConfig', ms: 1600, ok: true, shared: false },
          ],
          totalMs: 1700,
        }),
      })
    );
    expect(find(r, 'launchpad')!.detail).toContain('slowest call getLaunchConfig 1600ms');
  });

  it('says which calls did not answer', async () => {
    const r = await buildStatus(
      deps({
        getLaunchReadiness: async () => ({
          launchEnabled: true,
          whitelisted: false,
          canLaunch: true,
          timings: [{ name: 'feeEscrow', ms: 5000, ok: false, shared: true, error: 'timeout' }],
          totalMs: 5001,
        }),
      })
    );
    expect(find(r, 'launchpad')!.detail).toContain('did not answer: feeEscrow');
  });

  it('says so when the contract permits a launch but something local refused it', async () => {
    const r = await buildStatus(
      deps({
        getLaunchReadiness: async () => ({
          launchEnabled: true,
          whitelisted: false,
          // The gate that fails closed says no; the chain says yes.
          canLaunch: false,
          canLaunchOnChain: true,
          detail: 'the factory reports a different fee escrow than the registry records',
        }),
      })
    );
    const c = find(r, 'launchpad')!;
    expect(c.state).toBe('degraded');
    // Without this line an operator reads `canLaunch: false` and goes looking for a closed
    // launchpad that is in fact wide open.
    expect(c.detail).toContain('canLaunch() on chain is true');
  });

  it('does not add the disagreement line when the two agree', async () => {
    const r = await buildStatus(
      deps({
        getLaunchReadiness: async () => ({
          launchEnabled: true,
          whitelisted: false,
          canLaunch: true,
          canLaunchOnChain: true,
        }),
      })
    );
    expect(find(r, 'launchpad')!.detail).not.toContain('on chain is');
  });
});

describe('/status reports deployment identity as its own check', () => {
  it('is ok, and says the answer was measured now', async () => {
    const r = await buildStatus(
      deps({
        getDeploymentIdentity: async () => ({
          result: { ok: true, mismatches: [] },
          ageMs: 0,
          fromCache: false,
        }),
      })
    );
    const c = find(r, 'deployment-identity')!;
    expect(c.state).toBe('ok');
    expect(c.detail).toContain('measured just now');
  });

  it('states the age when the answer is remembered rather than measured', async () => {
    const r = await buildStatus(
      deps({
        getDeploymentIdentity: async () => ({
          result: { ok: true, mismatches: [] },
          ageMs: 120_000,
          fromCache: true,
        }),
      })
    );
    // A cached pass and a fresh pass are not the same claim.
    expect(find(r, 'deployment-identity')!.detail).toContain('120s ago');
  });

  it('is DOWN on a mismatch -- the most serious thing this page can say', async () => {
    const r = await buildStatus(
      deps({
        getDeploymentIdentity: async () => ({
          result: { ok: false, mismatches: ['runtime sha256: expected abc, chain says def'] },
          ageMs: 0,
          fromCache: false,
        }),
      })
    );
    const c = find(r, 'deployment-identity')!;
    expect(c.state).toBe('down');
    expect(c.detail).toContain('runtime sha256');
  });

  it('degrades rather than failing the launchpad when identity cannot be read', async () => {
    const r = await buildStatus(
      deps({
        getDeploymentIdentity: async () => ({
          result: { ok: true, mismatches: [] },
          ageMs: 300_000,
          fromCache: true,
          unreadable: 'ECONNRESET',
        }),
      })
    );
    expect(find(r, 'deployment-identity')!.state).toBe('degraded');
    // The whole point of the split: a slow 48 KB bytecode download must never publish a
    // claim about pons's launchpad.
    expect(find(r, 'launchpad')!.state).toBe('ok');
  });

  it('a slow identity check does not take the launchpad down with it', async () => {
    const r = await buildStatus(
      deps({
        getDeploymentIdentity: () => new Promise(() => {}),
      }),
      60
    );
    expect(find(r, 'deployment-identity')!.state).toBe('degraded');
    expect(find(r, 'launchpad')!.state).toBe('ok');
  });
});

describe('one response, one observed view', () => {
  it('names the endpoint that supplied the observed chain, inside the envelope', async () => {
    const r = await buildStatus(
      deps({ observedThrough: '78ccdeee5ef1', rollingSpendLast24hWei: () => 0n })
    );
    // A consumer binding a spend decision to `chainId` has to know which view produced it.
    // The page used to read chain/fee/balance through one provider and readiness through
    // another, then label the whole thing with the second.
    expect(r.spend?.observedThrough).toBe('78ccdeee5ef1');
    expect(r.spend?.chainId).toBe(4663);
  });

  it('omits the envelope entirely when the chain could not be observed', async () => {
    const r = await buildStatus(
      deps({
        getChainId: async () => {
          throw new Error('no admitted RPC endpoint');
        },
        rollingSpendLast24hWei: () => 0n,
      })
    );
    // Absent refuses; a value sourced from nowhere would admit.
    expect(r.spend).toBeUndefined();
    expect(find(r, 'rpc')!.state).toBe('down');
  });
});

describe('a verdict reached with gaps is not a clean pass', () => {
  it('degrades launchpad when part of the evidence never answered', async () => {
    const r = await buildStatus(
      deps({
        getLaunchReadiness: async () => ({
          launchEnabled: true,
          whitelisted: false,
          canLaunch: true,
          incomplete: 'answered with gaps: launchConfigCount',
        }),
      })
    );
    const c = find(r, 'launchpad')!;
    // "We could not read part of this" and "everything is fine" must not look identical.
    expect(c.state).toBe('degraded');
    expect(c.detail).toContain('evidence is incomplete');
    expect(c.detail).toContain('launchConfigCount');
  });

  it('stays ok when nothing was missing', async () => {
    const r = await buildStatus(
      deps({
        getLaunchReadiness: async () => ({ launchEnabled: true, whitelisted: false, canLaunch: true }),
      })
    );
    expect(find(r, 'launchpad')!.state).toBe('ok');
  });
});

describe('the whole response is bounded, not each check', () => {
  it('answers within roughly one budget even when several dependencies hang', async () => {
    const hang = () => new Promise<never>(() => {});
    const started = Date.now();
    const r = await buildStatus(
      deps({
        getChainId: hang,
        getBlockNumber: hang,
        getLiveFeeWei: hang,
        getLaunchReadiness: hang,
        getTreasuryBalanceWei: hang,
        getDeploymentIdentity: hang,
      }),
      300
    );
    const elapsed = Date.now() - started;

    // Six hanging checks used to cost six full timeouts, in sequence. One budget now.
    expect(elapsed).toBeLessThan(1200);
    expect(find(r, 'rpc')!.state).toBe('down');
    expect(r.state).toBe('down');
  }, 20_000);

  it('says when a check was never reached, rather than blaming it for timing out', async () => {
    const r = await buildStatus(
      deps({
        getChainId: () => new Promise<never>(() => {}),
        getBlockNumber: () => new Promise<never>(() => {}),
        // This one is healthy; it simply never gets a chance.
        getTreasuryBalanceWei: async () => ETH,
        getLiveFeeWei: () => new Promise<never>(() => {}),
        getLaunchReadiness: () => new Promise<never>(() => {}),
      }),
      120
    );
    const detail = r.checks.map((c) => c.detail).join(' | ');
    // Reporting an exhausted budget as "the treasury balance timed out" blames a
    // dependency that was never asked.
    expect(detail).toContain('had already used its whole budget');
  }, 20_000);
});

describe('the cap the page reports is the cap that refuses launches', () => {
  const CAP = ETH / 100n;

  it('degrades on the ROLLING window even when the UTC day reads zero', async () => {
    // 00:01 UTC: the calendar figure has just reset, the rolling breaker has not.
    const r = await buildStatus(
      deps({
        dailyCapWei: CAP,
        spentTodayWei: () => 0n,
        rollingSpendLast24hWei: () => CAP,
      })
    );
    const c = find(r, 'daily-cap')!;
    // The old check read the calendar figure and would have said ok with a full cap of
    // apparent headroom while every launch was being refused.
    expect(c.state).toBe('degraded');
    expect(c.detail).toContain('rolling 24h');
  });

  it('does not claim refusals end at midnight UTC', async () => {
    const r = await buildStatus(
      deps({ dailyCapWei: CAP, spentTodayWei: () => 0n, rollingSpendLast24hWei: () => CAP })
    );
    // A rolling window frees up gradually as the oldest spend ages out.
    expect(find(r, 'daily-cap')!.detail).not.toContain('midnight');
    expect(find(r, 'daily-cap')!.detail).toContain('ages out');
  });

  it('still publishes the UTC-day figure, labelled as accounting only', async () => {
    const r = await buildStatus(
      deps({ dailyCapWei: CAP, spentTodayWei: () => CAP / 2n, rollingSpendLast24hWei: () => CAP / 4n })
    );
    const d = find(r, 'daily-cap')!.detail;
    expect(d).toContain('accounting only');
  });

  it('does NOT fall back to the calendar figure when the rolling one is unavailable', async () => {
    // An earlier revision used `rollingSpent ?? calendarSpent`, so a missing rolling value
    // with a quiet calendar day published `ok` -- a confident green light for a breaker
    // nobody had read. Unknown is not headroom. Full coverage in statusSession.test.ts.
    const r = await buildStatus(
      deps({ dailyCapWei: CAP, spentTodayWei: () => 0n, rollingSpendLast24hWei: undefined })
    );
    const c = find(r, 'daily-cap')!;
    expect(c.state).not.toBe('ok');
    expect(c.detail).toContain('UNKNOWN');
  });
});
