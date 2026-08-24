/**
 * What `/health` deliberately does not tell you.
 *
 * `/health` answers `ok` the moment the process is listening, and that is the
 * right answer to give Fly: its health check decides whether to restart the
 * machine, and restarting fixes a crashed process but does nothing about an RPC
 * outage, an exhausted parser balance or a launchpad the operator has switched
 * off. Wiring real dependency checks into it would turn every upstream wobble
 * into a restart loop.
 *
 * The cost of that correctness is that nothing anywhere reports the real state.
 * The bot can be listening, answering `ok`, and unable to launch anything --
 * which is what this is for. It is read by a person, or by an uptime monitor
 * that is not allowed to restart anything.
 *
 * Two properties matter more than the individual checks:
 *
 *  - Every call is bounded. A status page that hangs because the RPC hangs has
 *    told you nothing at the exact moment you needed it to speak.
 *  - Nothing here is a secret. The treasury address, its balance and every
 *    launchpad setting are already public on chain -- this reads them, it does
 *    not disclose them -- so the endpoint needs no auth, and adding auth via a
 *    URL parameter would put a real secret into every proxy log for nothing.
 */

export type CheckState = 'ok' | 'degraded' | 'down';

export interface StatusCheck {
  name: string;
  state: CheckState;
  detail: string;
}

export interface StatusReport {
  state: CheckState;
  at: string;
  checks: StatusCheck[];
}

export interface StatusDeps {
  expectedChainId: number;
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<number>;
  getTreasuryBalanceWei(): Promise<bigint>;
  getLiveFeeWei(): Promise<bigint>;
  getLaunchReadiness(): Promise<{
    launchEnabled: boolean;
    whitelisted: boolean;
    /** The factory's own predicate, where the deployment publishes one. Reported
     *  rather than inferred: Ponsr spent a week deriving this from a superseded
     *  contract's fields and was confidently wrong the whole time. */
    canLaunch?: boolean;
    durable?: boolean;
    detail?: string;
  }>;
  /** Which registry entry the bot launches through, so the page names the contract
   *  it is actually reading rather than "the launchpad". */
  deploymentId?: string;
  deploymentFactory?: string;
  /** Wei spent by the treasury since midnight UTC, and the cap that bounds it. */
  spentTodayWei(): bigint;
  dailyCapWei: bigint;
  launchesToday(): number;
  coldAddressSet: boolean;
  /** Which route the parser reaches Claude through, for reading, not for calling:
   *  a live parse costs money and a status page must be free to poll. */
  parserRoute: string;
  alertsRoute: string;
  crossCheckHours: number;
  /** Ponsr's own gate. A healthy upstream factory is not public availability. */
  publicLaunchEnabled: boolean;
  /** Which factory launches are built for. v1 prices every launch in ETH. */
  factoryVersion: 'v1' | 'v2';
  /** Symbols a launch can be paired against. Absent on v1, where there is nothing
   *  to discover. Reported because "AAPL is not approved" and "the bot never
   *  managed to read the approved set" produce the same refusal to a user. */
  listPairAssets?: () => Promise<string[]>;
}

const RANK: Record<CheckState, number> = { ok: 0, degraded: 1, down: 2 };

function worst(checks: StatusCheck[]): CheckState {
  return checks.reduce<CheckState>((acc, c) => (RANK[c.state] > RANK[acc] ? c.state : acc), 'ok');
}

/** Bounds a dependency call. The timeout is the check: an RPC that never answers
 *  is down, and waiting to be sure of that defeats the point of asking. */
async function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reason(err: unknown): string {
  const m = (err as { message?: string })?.message;
  return m ? String(m).slice(0, 160) : String(err).slice(0, 160);
}

const ETH = 10n ** 18n;

function eth(wei: bigint, dp = 4): string {
  const s = (Number(wei) / 1e18).toFixed(dp);
  return `${s} ETH`;
}

export async function buildStatus(deps: StatusDeps, timeoutMs = 5000): Promise<StatusReport> {
  const checks: StatusCheck[] = [];

  checks.push({
    name: 'public-launches',
    state: deps.publicLaunchEnabled ? 'ok' : 'degraded',
    detail: deps.publicLaunchEnabled
      ? 'enabled by explicit Ponsr operator configuration'
      : 'paused by Ponsr; mentions stop before parsing, wallet creation, signing, or broadcast',
  });

  // The chain, first: every check below it is meaningless if this one fails, but
  // they still run, because "the RPC is down" and "the RPC is down AND the cap is
  // nearly spent" are different mornings.
  let feeWei: bigint | null = null;
  try {
    const [chainId, block] = await within(
      Promise.all([deps.getChainId(), deps.getBlockNumber()]),
      timeoutMs,
      'RPC'
    );
    if (chainId !== deps.expectedChainId) {
      checks.push({
        name: 'rpc',
        state: 'down',
        detail: `connected to chain ${chainId}, expected ${deps.expectedChainId} -- this RPC is not Robinhood Chain`,
      });
    } else {
      checks.push({ name: 'rpc', state: 'ok', detail: `chain ${chainId}, block ${block}` });
    }
  } catch (err) {
    checks.push({ name: 'rpc', state: 'down', detail: reason(err) });
  }

  try {
    feeWei = await within(deps.getLiveFeeWei(), timeoutMs, 'launchFee()');
    checks.push({ name: 'launch-fee', state: 'ok', detail: eth(feeWei) });
  } catch (err) {
    // The fee is read live before every launch and is owner-settable on pons's
    // side, so an unreadable fee is an unlaunchable bot, not a cosmetic gap.
    checks.push({ name: 'launch-fee', state: 'down', detail: reason(err) });
  }

  if (deps.deploymentId) {
    checks.push({
      name: 'deployment',
      state: 'ok',
      detail: `${deps.deploymentId} (${deps.deploymentFactory ?? 'address not reported'})`,
    });
  }

  try {
    const r = await within(deps.getLaunchReadiness(), timeoutMs, 'launch readiness');
    // canLaunch is the contract's own answer where it exists; the older deployments
    // have no such helper, so the inference is the fallback rather than the rule.
    const permitted = r.canLaunch ?? (r.launchEnabled || r.whitelisted);
    checks.push(
      permitted
        ? {
            name: 'launchpad',
            state: 'ok',
            // Says which of the two is carrying it. A launch riding on an open public
            // gate works exactly as well as one riding on a whitelist, right up until
            // the gate closes -- and only one of those is worth planning around.
            detail:
              r.detail ??
              (r.whitelisted ? 'whitelisted on this deployment' : 'open via the public gate'),
          }
        : {
            name: 'launchpad',
            state: 'degraded',
            detail: r.detail ?? 'this deployment would refuse a launch from this address',
          }
    );
  } catch (err) {
    checks.push({ name: 'launchpad', state: 'down', detail: reason(err) });
  }

  try {
    const balance = await within(deps.getTreasuryBalanceWei(), timeoutMs, 'treasury balance');
    if (feeWei && feeWei > 0n) {
      // Stated in launches rather than ETH, because the fee moves and a number of
      // launches is the thing an operator actually needs to decide on.
      const fundable = Number(balance / feeWei);
      checks.push({
        name: 'treasury-hot',
        state: fundable < 1 ? 'down' : fundable < 5 ? 'degraded' : 'ok',
        detail: `${eth(balance)} -- funds ${fundable} launch${fundable === 1 ? '' : 'es'} at the current fee`,
      });
    } else {
      checks.push({ name: 'treasury-hot', state: 'ok', detail: eth(balance) });
    }
  } catch (err) {
    checks.push({ name: 'treasury-hot', state: 'down', detail: reason(err) });
  }

  // Local state below: no network, so these answer even when the chain does not.
  const spent = deps.spentTodayWei();
  const cap = deps.dailyCapWei;
  const pct = cap > 0n ? Number((spent * 100n) / cap) : 0;
  checks.push({
    name: 'daily-cap',
    // Hitting the cap is the circuit breaker working, not a fault -- but it does
    // mean every further launch is refused until midnight UTC, which is exactly
    // the thing someone would otherwise spend an hour failing to explain.
    state: pct >= 100 ? 'degraded' : 'ok',
    detail: `${eth(spent)} of ${eth(cap)} spent today (${pct}%), ${deps.launchesToday()} launch(es)`,
  });

  checks.push({
    name: 'treasury-cold',
    state: deps.coldAddressSet ? 'ok' : 'degraded',
    detail: deps.coldAddressSet
      ? 'cold address configured'
      : 'no cold address set -- the hot/cold split is configuration, not protection',
  });

  if (deps.factoryVersion === 'v2' && deps.listPairAssets) {
    try {
      const symbols = await within(deps.listPairAssets(), timeoutMs, 'pair assets');
      checks.push({
        name: 'pair-assets',
        // An empty set is not an outage -- it is pons having approved nothing -- but
        // it does mean every stock-paired request will be refused, which is worth
        // seeing before spending an afternoon on why.
        state: symbols.length > 0 ? 'ok' : 'degraded',
        detail: symbols.length > 0 ? symbols.join(', ') : 'none approved -- every pairing request will be refused',
      });
    } catch (err) {
      checks.push({ name: 'pair-assets', state: 'degraded', detail: reason(err) });
    }
  } else {
    checks.push({
      name: 'pair-assets',
      state: 'ok',
      detail: deps.factoryVersion === 'v1' ? 'v1: every launch is priced in ETH' : 'no registry configured',
    });
  }

  checks.push({ name: 'parser', state: 'ok', detail: `${deps.parserRoute} (not called: a live parse is billed)` });
  checks.push({ name: 'alerts', state: 'ok', detail: deps.alertsRoute });
  checks.push({
    name: 'mention-crosscheck',
    state: deps.crossCheckHours > 0 ? 'ok' : 'degraded',
    detail:
      deps.crossCheckHours > 0
        ? `every ${deps.crossCheckHours}h against X's own timeline`
        : 'off -- a mention search that silently stops indexing would look like a quiet day',
  });

  return { state: worst(checks), at: new Date().toISOString(), checks };
}

/** 200 unless something is actually down, so an uptime monitor can watch this.
 *
 *  Do NOT point Fly's health check here. Fly restarts on a failing check, and a
 *  restart cannot fix an RPC outage -- it would convert somebody else's downtime
 *  into a crash loop of our own. `/health` exists for that job. */
export function statusHttpCode(report: StatusReport): number {
  return report.state === 'down' ? 503 : 200;
}

export { ETH as WEI_PER_ETH };
