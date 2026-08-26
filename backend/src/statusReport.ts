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

import { CoreEvidence } from './statusCore';
import { DependencyName, DependencyTiming, TimingRecorder } from './dependencyTiming';

export type CheckState = 'ok' | 'degraded' | 'down';

export interface StatusCheck {
  name: string;
  state: CheckState;
  detail: string;
}

/** Typed, machine-readable spend. See rollingSpendLast24hWei for why it names its window. */
export interface StatusSpend {
  window: 'rolling-24h';
  /**
   * What this figure is ABOUT.
   *
   * A rolling total with a matching cap is not enough to trust: an honest endpoint for a
   * different deployment, a different treasury or a different chain reports exactly that
   * shape and means something else entirely. A second spender has to be able to prove the
   * budget it is checking is the budget it will draw from.
   */
  chainId: number;
  /**
   * Fingerprint of the endpoint that observed the chain id above.
   *
   * A response used to gather chain/block/fee/balance through one provider and readiness
   * through another, then label the whole page with the second. A consumer binding a spend
   * decision to `chainId` could not tell a coherent envelope from a spliced one.
   */
  observedThrough?: string;
  deploymentId?: string;
  factory?: string;
  treasury?: string;
  /** Whether the bot is currently admitting public launches. */
  publicLaunchEnabled: boolean;
  /** ISO. Freshness is the caller's to bound; staleness is not detectable without it. */
  generatedAt: string;
  /** Decimal wei string. The window the circuit breaker actually admits against. */
  rolling24hWei: string;
  capWei: string;
  /** UTC calendar day, published separately so nothing mistakes it for the breaker's window. */
  currentUtcDayWei: string;
}

export interface StatusReport {
  state: CheckState;
  at: string;
  checks: StatusCheck[];
  /** Absent when the rolling figure is unavailable. Absent refuses; invented would admit. */
  spend?: StatusSpend;
  /**
   * The authoritative core, produced under its OWN deadline before any optional telemetry.
   *
   * Embedded so an operator reading one document sees one coherent answer, and so the
   * dedicated `/status/core` endpoint and this page cannot drift apart in shape. Absent
   * only when the caller did not supply core dependencies.
   */
  core?: CoreEvidence;
  /**
   * Per-dependency cost for THIS response. Diagnostics; nothing is decided from them.
   *
   * Added because the deploy report had to record the tail as UNKNOWN: the page published
   * per-call timing for the launchpad check and nothing else, so four unattributable
   * seconds could not be explained from outside.
   */
  dependencies?: DependencyTiming[];
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
    /**
     * What `canLaunch()` returned before any local narrowing.
     *
     * `canLaunch` above is narrowed to fail closed on unrelated conditions -- a mismatched
     * fee escrow makes it false even when pons would happily accept the launch. That is
     * right for a gate and wrong for a report: an operator reading `canLaunch: false` goes
     * looking for a closed launchpad. Both are published so the page can say which it is.
     */
    canLaunchOnChain?: boolean;
    durable?: boolean;
    detail?: string;
    /**
     * Set when a verdict was reachable but some evidence was still missing.
     *
     * Discarding this was a real defect: an unreadable launchFee became 0n, nothing in the
     * verdict inspects the fee, and the page published `launchpad: ok` for a launch whose
     * price nobody had managed to read.
     */
    incomplete?: string;
    /**
     * Per-call evidence for WHY this check was slow.
     *
     * The outage that motivated this had `launchpad: down -- did not answer within 5000ms`
     * and nothing else. That sentence is compatible with a closed launchpad, a slow RPC, a
     * wrong endpoint and a bug, and distinguishing them needed access nobody watching the
     * page had.
     */
    timings?: Array<{ name: string; ms: number; ok: boolean; shared: boolean; error?: string }>;
    totalMs?: number;
  }>;
  /**
   * Which RPC endpoints exist and which are allowed to answer -- identity, never the URL.
   *
   * `RPC_URL` is a Fly secret whose value cannot be read back, so "is the backend pointed
   * at the endpoint I just tested?" was unanswerable by anyone, including the operator who
   * set it. This publishes enough to compare and not enough to call.
   */
  describeRpc?: () => {
    endpoints: Array<{
      identity: { origin: string | null; fingerprint: string; credentialed?: boolean };
      admitted: boolean;
      refusedBecause?: string;
      probeMs: number;
    }>;
    activeIndex: number | null;
  };
  /**
   * Fingerprint of the ONE endpoint every chain observation in this response came from.
   *
   * Published inside the spend envelope, because a consumer binding a spend decision to an
   * observed chain needs to know which view produced it. Absent when no endpoint could be
   * admitted -- and the envelope is then omitted entirely rather than sourced from nowhere.
   */
  observedThrough?: string;
  /**
   * Index into `describeRpc().endpoints` of the endpoint THIS response actually used.
   *
   * Carried by value rather than read from `activeIndex` at render time. The pool's
   * preferred endpoint is mutable global state: a concurrent request can move it between
   * this response acquiring endpoint A and rendering its `rpc-endpoint` line, so the page
   * could publish `observedThrough=A` in the machine-readable envelope while telling a
   * human that B was serving. Two answers to the same question, in one document.
   */
  sessionEndpointIndex?: number;
  /** Scheme and host of the endpoint that served this response. Never path or query. */
  endpointOrigin?: string;
  /**
   * Pre-computed authoritative core, produced by the caller under its OWN deadline.
   *
   * Passed in rather than built here, so the core can be produced BEFORE optional telemetry
   * is even started -- which is the whole point of the split. `/status/core` builds the same
   * structure and serves it alone, so the two cannot drift apart in shape.
   */
  core?: CoreEvidence;
  /** Timings already recorded while producing the core, so one response has one ledger. */
  coreDependencies?: DependencyTiming[];
  /**
   * Deployment identity, on its own budget and cadence.
   *
   * Split out of the launchpad check because a 48 KB bytecode download sharing a deadline
   * with the permission reads meant a slow transfer published `launchpad: down` -- a claim
   * about pons produced by a file transfer.
   */
  getDeploymentIdentity?: () => Promise<{
    result: { ok: boolean; mismatches: string[] } | null;
    ageMs: number | null;
    fromCache: boolean;
    unreadable?: string;
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
  /**
   * The ROLLING 24-hour total, from the same query the circuit breaker admits against.
   *
   * Separate from spentTodayWei, which is a UTC calendar day. They agree for most of the
   * day and diverge exactly when it is expensive: at 00:01 UTC the calendar figure resets
   * while the breaker still counts the previous day. A comment in index.ts claimed the
   * calendar figure was "the same window the circuit breaker counts". It was not, and any
   * second spender reading it could be told it had a full cap of headroom.
   */
  rollingSpendLast24hWei?: () => bigint;
  /** Binds the spend envelope to the runtime it describes. See StatusSpend. */
  treasuryAddress?: string;
  /** Ponsr's own gate. A healthy upstream factory is not public availability. */
  publicLaunchEnabled: boolean;
  /** Which factory launches are built for. v1 prices every launch in ETH. */
  factoryVersion: 'v1' | 'v2';
  /** Symbols a launch can be paired against. Absent on v1, where there is nothing
   *  to discover. Reported because "AAPL is not approved" and "the bot never
   *  managed to read the approved set" produce the same refusal to a user. */
  listPairAssets?: () => Promise<string[]>;
  /**
   * Live health of the mention sweep -- when it last SUCCEEDED, not whether it is configured.
   *
   * The distinction is the whole reason this exists. On 2026-08-24 this page reported
   * `mention-crosscheck = ok` while the sweep had been failing every two minutes for days
   * with `402 Credits is not enough`. That check asked whether a cross-check interval was
   * set, and an interval cannot go wrong in the way that mattered. Nothing here could tell
   * "polling and finding nothing" from "not polling at all".
   */
  sweepHealth?: () => { lastSuccessAt: string | null; consecutiveFailures: number; lastError: string | null };
  /** Prepaid balance at the read provider, when it exposes one. The call is free. */
  readCredits?: () => Promise<{ credits: number; bonus: number } | null>;
  /** How stale a last-success may get before the sweep is reported degraded. */
  sweepStaleAfterMs?: number;
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
        // Distinguished on purpose. "The check timed out" and "the response had already
        // spent its whole budget before reaching this check" send an operator to different
        // places, and reporting the second as the first blames the wrong dependency.
        const message =
          ms <= 0
            ? `${label} was not reached: the status request had already used its whole budget`
            : `${label} did not answer within ${ms}ms`;
        timer = setTimeout(() => reject(new Error(message)), ms);
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

  /**
   * ONE budget for the whole response, not one per check.
   *
   * Every dependency below used to get its own full `timeoutMs`, awaited in sequence, so a
   * page nominally bounded at five seconds could take five checks times five seconds. Under
   * an uptime monitor polling every thirty seconds that also accumulates orphaned in-flight
   * work, because racing a timer does not cancel the request underneath it.
   *
   * Two changes. Every network dependency is STARTED up front, so they travel concurrently
   * and ethers batches what it can. And each await is bounded by the time actually
   * remaining, so the total is bounded by `timeoutMs` rather than by a multiple of it.
   */
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());

  /**
   * Cost evidence for the OPTIONAL dependencies this function starts.
   *
   * The core's own timings arrive already recorded, because the core ran before this
   * function was called. Merged at the end so one response carries one ledger.
   */
  const optionalRecorder = new TimingRecorder(Date.now());
  const OPTIONAL: readonly DependencyName[] = ['pair-assets', 'read-credits'];

  /**
   * Started here, awaited later.
   *
   * A rejection on a promise nobody is awaiting yet is an unhandled rejection, which in
   * production is a process-level warning and in some configurations a crash -- from a
   * status page, which is the one component that must never take the bot down. Attaching a
   * no-op catch now keeps the rejection for the real await below.
   */
  const start = <T>(make: () => Promise<T>): Promise<T> => {
    let p: Promise<T>;
    try {
      p = make();
    } catch (err) {
      // A dependency that throws SYNCHRONOUSLY -- a missing function, a bad config read --
      // must become a failed check, not an exception that takes the whole status page down.
      // This is the one component that has to keep answering when everything else is broken.
      p = Promise.reject(err);
    }
    p.catch(() => {});
    return p;
  };

  const inflight = {
    chain: start(() => Promise.all([deps.getChainId(), deps.getBlockNumber()])),
    fee: start(() => deps.getLiveFeeWei()),
    readiness: start(() => deps.getLaunchReadiness()),
    balance: start(() => deps.getTreasuryBalanceWei()),
    identity: deps.getDeploymentIdentity ? start(deps.getDeploymentIdentity) : undefined,
    pairAssets: deps.listPairAssets
      ? optionalRecorder.track('pair-assets', start(deps.listPairAssets))
      : undefined,
    credits: deps.readCredits
      ? optionalRecorder.track('read-credits', start(deps.readCredits))
      : undefined,
  };
  if (!deps.listPairAssets) optionalRecorder.absent('pair-assets');
  if (!deps.readCredits) optionalRecorder.absent('read-credits');
  /**
   * Machine-readable, and it names its own window.
   *
   * Another process deciding whether it may spend cannot safely parse a sentence written
   * for a human: the string cannot say which window it means, so the wrong number gets
   * used with complete confidence. Omitted entirely rather than defaulted when the rolling
   * figure is unavailable -- a missing block refuses, an invented one admits.
   */
  /**
   * Built only AFTER the chain has been read, and from what it answered.
   *
   * This was assembled before the RPC call and took chainId from `expectedChainId` -- the
   * configured value, not the observed one. So a backend connected to the wrong chain
   * published an envelope naming the chain it was supposed to be on, and a second spender
   * binding against it would pass. The separate `rpc: down` check said so elsewhere, but a
   * consumer reading the typed block never saw that.
   *
   * Omitted entirely when the chain cannot be read or disagrees. Absent refuses; a
   * confidently wrong value admits.
   */
  /**
   * ONE observation, used by everything below it.
   *
   * The envelope read the chain, and the rpc check read it again. Two reads in one response
   * can disagree -- a provider that fails over between them produces a report carrying a
   * spend envelope bound to 4663 while `rpc` says down for a different chain. A consumer
   * reads the envelope on its own, so a single self-contradicting response could still
   * admit a launch. One request, one observed truth.
   */
  let observed: { chainId: number; block: number } | null = null;
  let observedError: unknown = null;
  try {
    const [chainId, block] = await within(inflight.chain, remaining(), 'RPC');
    observed = { chainId, block };
  } catch (err) {
    observedError = err;
  }
  const observedChainId = observed?.chainId ?? null;

  const spend =
    deps.rollingSpendLast24hWei && observedChainId === deps.expectedChainId
      ? {
          window: 'rolling-24h' as const,
          rolling24hWei: deps.rollingSpendLast24hWei().toString(),
          capWei: deps.dailyCapWei.toString(),
          currentUtcDayWei: deps.spentTodayWei().toString(),
          // Observed, not configured.
          chainId: observedChainId,
          // Which endpoint saw that chain. Without it, a consumer cannot tell a coherent
          // envelope from one assembled out of two different views.
          observedThrough: deps.observedThrough,
          deploymentId: deps.deploymentId,
          factory: deps.deploymentFactory,
          treasury: deps.treasuryAddress,
          publicLaunchEnabled: deps.publicLaunchEnabled,
          generatedAt: new Date().toISOString(),
        }
      : undefined;

  /**
   * Ponsr's own gate, restored.
   *
   * A slice-based edit that inserted the spend envelope swallowed this check along with
   * the code it replaced, and the suite caught it — the one place in this whole rollout
   * where a destructive edit was noticed by something other than a reviewer.
   */
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
  if (!observed) {
    checks.push({ name: 'rpc', state: 'down', detail: reason(observedError) });
  } else if (observed.chainId !== deps.expectedChainId) {
    checks.push({
      name: 'rpc',
      state: 'down',
      detail: `connected to chain ${observed.chainId}, expected ${deps.expectedChainId} -- this RPC is not Robinhood Chain`,
    });
  } else {
    checks.push({ name: 'rpc', state: 'ok', detail: `chain ${observed.chainId}, block ${observed.block}` });
  }

  try {
    feeWei = await within(inflight.fee, remaining(), 'launchFee()');
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

  // Where the traffic goes, published before anything that depends on it. An operator
  // debugging a slow readiness check needs this first, not buried under the consequences.
  if (deps.describeRpc) {
    const pool = deps.describeRpc();
    // THIS response's endpoint when one was pinned; the pool's preferred one only as a
    // fallback for callers that do not pin a session. Never the mutable value when a
    // pinned one exists.
    const usedIndex = deps.sessionEndpointIndex ?? pool.activeIndex;
    const active = usedIndex === null || usedIndex === undefined ? null : pool.endpoints[usedIndex];
    const refused = pool.endpoints.filter((e) => e.refusedBecause && e.refusedBecause !== 'not probed yet');
    const where = active
      ? `${active.identity.origin ?? 'unparseable'} (fingerprint ${active.identity.fingerprint})`
      : 'none admitted yet';
    const extra = [
      `${pool.endpoints.length} configured`,
      ...refused.map(
        (e) => `REFUSED ${e.identity.origin ?? 'unparseable'}: ${e.refusedBecause}`
      ),
    ];
    checks.push({
      name: 'rpc-endpoint',
      // A refused endpoint is not an outage: the primary may be serving perfectly while a
      // misconfigured fallback sits refused beside it. Reported, not escalated.
      state: active ? 'ok' : 'degraded',
      detail:
        `${where}; ${extra.join('; ')}` +
        // Said explicitly, because "the pool prefers B" and "this page was built from B"
        // are different claims and only the second one belongs on this response.
        (deps.sessionEndpointIndex !== undefined ? '; served this response' : ''),
    });
  }

  try {
    const r = await within(inflight.readiness, remaining(), 'launch readiness');
    // canLaunch is the contract's own answer where it exists; the older deployments
    // have no such helper, so the inference is the fallback rather than the rule.
    const permitted = r.canLaunch ?? (r.launchEnabled || r.whitelisted);

    // Appended to whichever detail is chosen below. Present on the healthy path too: a
    // check that only reports its cost once it has already failed gives an operator no
    // baseline to compare against, which is how a four-round-trip check sat unnoticed.
    const cost: string[] = [];
    if (typeof r.totalMs === 'number') cost.push(`read in ${r.totalMs}ms`);
    if (r.timings?.length) {
      const slowest = r.timings.reduce((a, t) => (t.ms > a.ms ? t : a));
      cost.push(
        r.timings.every((t) => t.shared)
          ? `${r.timings.length} calls in one batch`
          : `slowest call ${slowest.name} ${slowest.ms}ms`
      );
      const failed = r.timings.filter((t) => !t.ok).map((t) => t.name);
      if (failed.length) cost.push(`did not answer: ${failed.join(', ')}`);
    }
    // Only when the two disagree -- which is exactly when the narrowed field misleads.
    if (r.canLaunchOnChain !== undefined && r.canLaunchOnChain !== r.canLaunch) {
      cost.push(
        `canLaunch() on chain is ${r.canLaunchOnChain}; refused locally for another reason`
      );
    }
    const suffix = cost.length ? ` [${cost.join('; ')}]` : '';

    // A verdict reached with gaps is not a clean pass. Reported as degraded rather than ok:
    // "we could not read part of this" and "everything is fine" must not look identical.
    if (permitted && r.incomplete) {
      checks.push({
        name: 'launchpad',
        state: 'degraded',
        detail:
          `${r.detail ?? 'this deployment would accept a launch'} -- but the evidence is incomplete: ` +
          `${r.incomplete}${suffix}`,
      });
    } else
    checks.push(
      permitted
        ? {
            name: 'launchpad',
            state: 'ok',
            // Says which of the two is carrying it. A launch riding on an open public
            // gate works exactly as well as one riding on a whitelist, right up until
            // the gate closes -- and only one of those is worth planning around.
            detail:
              (r.detail ??
                (r.whitelisted ? 'whitelisted on this deployment' : 'open via the public gate')) +
              suffix,
          }
        : {
            name: 'launchpad',
            state: 'degraded',
            detail: (r.detail ?? 'this deployment would refuse a launch from this address') + suffix,
          }
    );
  } catch (err) {
    checks.push({ name: 'launchpad', state: 'down', detail: reason(err) });
  }

  if (deps.getDeploymentIdentity) {
    try {
      const id = await within(inflight.identity!, remaining(), 'deployment identity');
      const age =
        id.ageMs === null ? 'never measured' : `measured ${Math.round(id.ageMs / 1000)}s ago`;
      if (!id.result) {
        checks.push({
          name: 'deployment-identity',
          state: 'degraded',
          detail: id.unreadable ? `not verified yet: ${id.unreadable}` : 'not verified yet',
        });
      } else if (!id.result.ok) {
        // The most serious thing this page can say: the contract being addressed is not
        // the one the registry describes. Never softened by a cache -- mismatches are
        // re-read every time.
        checks.push({
          name: 'deployment-identity',
          state: 'down',
          detail: `does NOT match the registry (${age}) -- ${id.result.mismatches.join('; ')}`,
        });
      } else {
        checks.push({
          name: 'deployment-identity',
          // A pass that could not be refreshed is still a pass, but its age is stated so
          // nobody reads a remembered answer as a fresh one.
          state: id.unreadable ? 'degraded' : 'ok',
          detail: id.unreadable
            ? `matched the registry (${age}), but the latest attempt failed: ${id.unreadable}`
            : `matches the registry (${id.fromCache ? age : 'measured just now'})`,
        });
      }
    } catch (err) {
      checks.push({ name: 'deployment-identity', state: 'degraded', detail: reason(err) });
    }
  }

  try {
    const balance = await within(inflight.balance, remaining(), 'treasury balance');
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
  //
  // THE FIGURE THAT GATES LAUNCHES, NOT THE ONE THAT READS NICELY.
  //
  // This check reported the UTC CALENDAR day while validator.ts admits against
  // db.totalSpendLast24h(), a ROLLING window. They agree for most of the day and diverge
  // exactly when it is expensive: at 00:01 UTC the calendar figure resets to zero while the
  // breaker still counts yesterday's spend. So the page could say `daily-cap: ok` with a
  // full cap of apparent headroom while every launch was being refused -- and the old text
  // said refusals last "until midnight UTC", which is the calendar boundary and not when a
  // rolling window actually frees up.
  const calendarSpent = deps.spentTodayWei();
  const rollingSpent = deps.rollingSpendLast24hWei?.();
  const cap = deps.dailyCapWei;

  if (rollingSpent === undefined) {
    /**
     * UNKNOWN IS NOT HEADROOM.
     *
     * This used to fall back to the calendar figure and report `ok` whenever that was under
     * cap. But the calendar figure is not what admits a launch -- the rolling one is -- so a
     * missing rolling value with a quiet calendar day produced a confident green light for a
     * breaker whose state nobody had read. That is the same defect as an unreadable launch
     * fee becoming zero, in a different file.
     */
    checks.push({
      name: 'daily-cap',
      state: 'degraded',
      detail:
        `the rolling 24h spend could not be read, so the operative cap state is UNKNOWN. ` +
        `${eth(calendarSpent)} of ${eth(cap)} is the UTC-day figure and is accounting only -- ` +
        `it is not what the circuit breaker admits against`,
    });
  } else {
    const pct = cap > 0n ? Number((rollingSpent * 100n) / cap) : 0;
    checks.push({
      name: 'daily-cap',
      // Hitting the cap is the circuit breaker working, not a fault -- but it does mean
      // every further launch is refused, and it is worth saying when that ends. A rolling
      // window frees up gradually as the oldest spend ages out, not all at once at midnight.
      state: pct >= 100 ? 'degraded' : 'ok',
      detail:
        `${eth(rollingSpent)} of ${eth(cap)} spent in the last rolling 24h (${pct}%), ` +
        `${deps.launchesToday()} launch(es) today; UTC-day figure ${eth(calendarSpent)} is ` +
        `accounting only` +
        (pct >= 100
          ? '. Launches are refused until enough of the oldest spend ages out of the 24h window'
          : ''),
    });
  }

  checks.push({
    name: 'treasury-cold',
    state: deps.coldAddressSet ? 'ok' : 'degraded',
    detail: deps.coldAddressSet
      ? 'cold address configured'
      : 'no cold address set -- the hot/cold split is configuration, not protection',
  });

  if (deps.factoryVersion === 'v2' && deps.listPairAssets) {
    try {
      const symbols = await within(inflight.pairAssets!, remaining(), 'pair assets');
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

  /**
   * Is the bot actually hearing anything?
   *
   * Reported as `down`, not `degraded`, when the sweep has been failing: a bot that cannot
   * read mentions is not a degraded bot, it is an absent one. Every other check on this page
   * can be green while this is the only thing that matters.
   */
  if (deps.sweepHealth) {
    const h = deps.sweepHealth();
    const staleAfter = deps.sweepStaleAfterMs ?? 15 * 60 * 1000;
    const ageMs = h.lastSuccessAt ? Date.now() - new Date(h.lastSuccessAt).getTime() : null;
    const mins = (ms: number) => `${Math.floor(ms / 60000)}m`;

    if (h.consecutiveFailures > 0 || (ageMs !== null && ageMs > staleAfter)) {
      checks.push({
        name: 'mention-sweep',
        state: 'down',
        detail:
          `${h.consecutiveFailures} consecutive failure(s); last success ` +
          (ageMs === null ? 'never' : `${mins(ageMs)} ago`) +
          (h.lastError ? ` -- ${h.lastError.slice(0, 110)}` : ''),
      });
    } else if (ageMs === null) {
      // Not a pass. A sweep that has never succeeded has proven nothing about itself.
      checks.push({
        name: 'mention-sweep',
        state: 'degraded',
        detail: 'no successful poll yet since boot -- nothing has been heard',
      });
    } else {
      checks.push({ name: 'mention-sweep', state: 'ok', detail: `last success ${mins(ageMs)} ago` });
    }
  }

  /**
   * The read provider's prepaid balance, read for free.
   *
   * Zero is not the floor: twitterapi.io was measured at -89 while still answering this
   * endpoint 200. So a threshold at zero reports healthy on an account that is already
   * overdrawn and refusing every data call.
   */
  if (deps.readCredits) {
    try {
      const c = await within(inflight.credits!, remaining(), 'read credits');
      if (c === null) {
        checks.push({ name: 'read-credits', state: 'ok', detail: 'provider reports no balance' });
      } else {
        const total = c.credits + c.bonus;
        checks.push({
          name: 'read-credits',
          state: total <= 0 ? 'down' : total < 1000 ? 'degraded' : 'ok',
          detail:
            `${c.credits} credits` +
            (c.bonus ? ` + ${c.bonus} bonus` : '') +
            (total <= 0 ? ' -- EXHAUSTED, every mention read is refused' : total < 1000 ? ' -- running low' : ''),
        });
      }
    } catch (err) {
      checks.push({ name: 'read-credits', state: 'degraded', detail: `could not read: ${reason(err)}` });
    }
  }

  // One ledger for the whole response: the core's timings, recorded before this function
  // was called, merged with the optional ones started here. Sealed, so a dependency that
  // settles later cannot rewrite a document that has already been returned.
  const dependencies = [...(deps.coreDependencies ?? []), ...optionalRecorder.seal(OPTIONAL)].sort(
    (a, b) => b.ms - a.ms
  );

  return {
    state: worst(checks),
    at: new Date().toISOString(),
    checks,
    ...(spend ? { spend } : {}),
    ...(deps.core ? { core: deps.core } : {}),
    dependencies,
  };
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
