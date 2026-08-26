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
