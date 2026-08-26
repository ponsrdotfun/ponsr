import { ethers } from 'ethers';
import { PonsDeployment, executableDeployment } from './deployments';
import { PONS_V2_CURRENT_ABI } from './ponsV2CurrentEncoder';
import { isNativeEth } from './pairTokens';
import { CurrentReadiness, ReadinessVerdict, describeReadiness } from './currentReadiness';

/**
 * The launch-permission reads, issued as ONE round trip, each one timed.
 *
 * WHY THIS EXISTS -- THE MEASUREMENT
 * ----------------------------------
 * `/status` reported `launchpad: down -- launch readiness did not answer within 5000ms`,
 * repeatedly, while `rpc: ok` sat next to it. That combination was read as an upstream
 * outage. It was not. `readCurrentReadiness` makes FOUR SEQUENTIAL HTTP round trips, and
 * the count is structural rather than incidental:
 *
 *   1. eth_getCode          the factory's runtime bytecode -- 24 177 bytes, ~48 KB of hex
 *   2. eth_call             feeEscrow(), on its own, because the identity check awaits
 *                           before returning
 *   3. eth_call x6          the permission reads, correctly batched
 *   4. eth_call             getLaunchConfig(id), sequential because the code checks the id
 *                           against launchConfigCount from trip 3 first
 *
 * Four trips divide the 5 000 ms budget into four ~1 250 ms slices, and trip 1 has to move
 * 48 KB inside its slice. So the check does not fail when the RPC is broken; it fails
 * whenever one round trip costs more than about a second, which on a busy public endpoint
 * is ordinary. It passes only when the network is unusually fast. Measured from the
 * operator's machine: 4 trips, ~1 500 ms end to end, against ~330 ms for the same
 * information in a single batch -- a 4.5x multiplier bought for nothing.
 *
 * WHAT CHANGED
 * ------------
 * Every read below is independent, so all of them go in one `Promise.all` and ethers
 * batches them into a single request. Two dependencies had to be removed to get there:
 *
 *   - the id/count range test now happens AFTER the batch instead of gating it. Calling
 *     `getLaunchConfig` with an out-of-range id reverts, and a revert is an answer: it is
 *     read as "not usable", which is what an out-of-range id means anyway.
 *   - `eth_getCode` is not here at all. See below -- it moved, it was not dropped.
 *
 * WHY IDENTITY IS NOT IN THIS PATH
 * --------------------------------
 * Deleting the bytecode check outright would be unforgivable: it is the guard that
 * separates the current factory from the superseded one, and this project has already lost
 * a week to that exact confusion. It is not deleted. It is asked SEPARATELY, on its own
 * budget, and reported as its own check.
 *
 * The reason is that one timeout was collapsing two unrelated questions. "Would pons let
 * us launch right now?" and "is this the contract the registry describes?" have different
 * answers, different fixes, and very different costs to ask. Sharing a deadline meant a
 * slow 48 KB download published `launchpad: down`, which reads as "the launchpad is
 * closed" -- a statement about pons that nothing had actually measured.
 *
 * Nothing about the LAUNCH path changes. `assertDeploymentIdentity` still runs there,
 * before a splitter is deployed and before a fee is spent, and it still throws. A status
 * page is a report; the launch path is the control. This only stops the report from
 * pretending to be the control.
 */

/**
 * Per-call evidence. `ms` is measured even when the call fails -- a slow failure and a
 * fast one send an operator to different places.
 *
 * READ `shared` BEFORE BELIEVING `ms`.
 *
 * Batching and per-call attribution are in direct tension, and pretending otherwise would
 * produce the most confident kind of wrong answer. When these seven reads travel in one
 * HTTP request they also return in one response, so every call measures the same interval
 * and they all report a near-identical figure -- measured live: seven calls, 322-323 ms
 * each, for a batch that took 325 ms in total. Read as per-call costs those numbers would
 * suggest seven slow calls. There was one slow round trip.
 *
 * So a batched timing is marked `shared: true` and means "this call was in a batch that
 * took `ms`". To attribute cost to an individual call, run the probe with `serial: true`,
 * which is slower on purpose and is a diagnostic, not the status path.
 */
export interface CallTiming {
  name: string;
  ms: number;
  ok: boolean;
  /** True when `ms` is the cost of a shared batch rather than of this call alone. */
  shared: boolean;
  /**
   * True when the CONTRACT answered by reverting, as opposed to the call never arriving.
   *
   * The difference decides whether a failure is evidence. `getLaunchConfig(99)` reverting
   * is the chain telling us that config is unusable -- a real answer. The same call failing
   * because the socket died tells us nothing, and reading it as "unusable" would publish a
   * verdict about pons that was actually a verdict about the network.
   */
  reverted?: boolean;
  /** Present only on failure, truncated, never the raw provider payload. */
  error?: string;
}

export interface ReadinessProbe {
  verdict: ReadinessVerdict | null;
  timings: CallTiming[];
  /** Wall clock for the whole probe, including the batching stall. */
  totalMs: number;
  /** The slowest single call, which is what a budget has to be set against. */
  slowestMs: number;
  /** False only in the `serial` diagnostic mode. When true, every `ms` is a batch figure. */
  batched: boolean;
  /** Absent when every call answered. */
  failure?: string;
}

async function timed<T>(
  name: string,
  start: () => Promise<T>,
  into: CallTiming[],
  shared: boolean
): Promise<T | undefined> {
  const started = Date.now();
  try {
    const v = await start();
    into.push({ name, ms: Date.now() - started, ok: true, shared });
    return v;
  } catch (err: any) {
    // A revert is proven by REVERT DATA, not by the error code. Measured against ethers
    // 6.17: `eth_call` failing for ANY reason yields CALL_EXCEPTION -- a genuine revert, a
    // `-32000 server overloaded`, and a node returning nonsense all arrive identically, and
    // the last two even share the shortMessage "missing revert data" with a revert that
    // carried no data. So code alone would classify an overloaded node as the contract
    // saying no.
    //
    // Revert data is the one thing only the contract can produce. Anything without it is
    // UNKNOWN, which fails closed. Real out-of-range ids revert with the custom error
    // `InvalidLaunchConfigId`, so the case this matters for does carry data -- and the
    // primary proof is the id/count comparison, which needs no revert at all.
    const data = err?.data;
    const reverted = typeof data === 'string' && data.length > 2;
    into.push({
      name,
      ms: Date.now() - started,
      ok: false,
      shared,
      reverted,
      error: String(err?.shortMessage ?? err?.message ?? err).slice(0, 120),
    });
    return undefined;
  }
}

export interface ProbeOptions {
  /**
   * Issue each read on its own round trip so `ms` attributes cost to a single call.
   *
   * Costs one round trip per read -- the exact multiplier this module exists to remove --
   * so it is for answering "WHICH call is slow?" after the fast path has already reported
   * that something is. Never the status path.
   */
  serial?: boolean;
}

/**
 * Reads launch permission in one batch.
 *
 * Deliberately does NOT throw. The caller is a status page, and an exception there loses
 * the timings -- which are the only evidence of WHY a slow check was slow.
 */
export async function probeLaunchPermission(
  provider: ethers.Provider,
  launcher: string,
  launchConfigId: bigint,
  pairToken: string,
  deployment: PonsDeployment = executableDeployment(),
  options: ProbeOptions = {}
): Promise<ReadinessProbe> {
  const f = new ethers.Contract(deployment.factory, PONS_V2_CURRENT_ABI, provider);
  const timings: CallTiming[] = [];
  const started = Date.now();
  const serial = Boolean(options.serial);

  // Native ETH is exempt from the approval map -- the factory short-circuits on the zero
  // address -- so asking about it would return false and refuse the one pairing that
  // always works. Resolved without a call rather than called and then corrected.
  const nativePair = isNativeEth(pairToken);

  // Thunks, not promises: a promise starts the moment it is constructed, so building this
  // list eagerly would issue every call in parallel and make `serial` a lie that still
  // reported plausible-looking per-call numbers.
  const reads: Array<[string, () => Promise<unknown>]> = [
    ['launchEnabled', () => f.launchEnabled()],
    ['whitelistedLaunchers', () => f.whitelistedLaunchers(launcher)],
    ['canLaunch', () => f.canLaunch(launcher)],
    ['launchConfigCount', () => f.launchConfigCount()],
    ['launchFee', () => f.launchFee()],
    ['feeEscrow', () => f.feeEscrow()],
    // Issued alongside the count rather than after it. An out-of-range id reverts, and the
    // revert is caught here and read as "not usable" -- the same verdict the range test
    // produced, one round trip earlier.
    ['getLaunchConfig', () => f.getLaunchConfig(launchConfigId)],
  ];
  if (!nativePair) reads.push(['approvedPairTokens', () => f.approvedPairTokens(pairToken)]);

  let results: Array<unknown>;
  if (serial) {
    results = [];
    for (const [name, start] of reads) results.push(await timed(name, start, timings, false));
  } else {
    results = await Promise.all(reads.map(([name, start]) => timed(name, start, timings, true)));
  }

  const byName = new Map(reads.map(([name], i) => [name, results[i]]));
  const launchEnabled = byName.get('launchEnabled') as boolean | undefined;
  const whitelisted = byName.get('whitelistedLaunchers') as boolean | undefined;
  const canLaunch = byName.get('canLaunch') as boolean | undefined;
  const configCount = byName.get('launchConfigCount') as bigint | undefined;
  const feeWei = byName.get('launchFee') as bigint | undefined;
  const escrow = byName.get('feeEscrow') as string | undefined;
  const cfg = byName.get('getLaunchConfig') as any;
  const approved = nativePair ? true : (byName.get('approvedPairTokens') as boolean | undefined);

  const totalMs = Date.now() - started;
  const slowestMs = timings.reduce((a, t) => (t.ms > a ? t.ms : a), 0);
  const failed = timings.filter((t) => !t.ok);
  const byTiming = new Map(timings.map((t) => [t.name, t]));

  const noVerdict = (why: string): ReadinessProbe => ({
    verdict: null,
    timings,
    totalMs,
    slowestMs,
    batched: !serial,
    failure: why,
  });

  /**
   * The COMPLETE evidence a launch verdict needs.
   *
   * This used to be three permission reads. Everything else was allowed to fail into a
   * default, and one default was actively dangerous: an unreadable `launchFee` became 0n,
   * `describeReadiness` never inspects the fee, and the page therefore published
   * `launchpad: ok` on a launch whose price nobody had managed to read. `launchConfigCount`
   * failing was invisible in the same way.
   *
   * A missing input is not a permissive input. Anything here that did not answer produces
   * NO verdict at all.
   */
  const required = [
    'launchEnabled',
    'whitelistedLaunchers',
    'canLaunch',
    'launchFee',
    'feeEscrow',
  ] as const;
  const missing = required.filter((n) => byTiming.get(n)?.ok !== true);
  if (missing.length) {
    return noVerdict(
      `launch readiness is UNKNOWN: ${missing.join(', ')} did not answer` +
        (failed.some((t) => t.reverted) ? ' (some calls reverted)' : '')
    );
  }

  /**
   * Whether the configured launch config is usable, and whether that is even knowable.
   *
   * Three outcomes, not two. A revert is the contract answering; a transport failure is
   * nobody answering; and only the first may be reported as "unusable".
   */
  const cfgTiming = byTiming.get('getLaunchConfig');
  const count = configCount === undefined ? null : BigInt(configCount.toString());
  let launchConfigUsable: boolean;
  if (count !== null && launchConfigId >= count) {
    // Proven out of range by a successful count read. The revert is expected and does not
    // need to have happened.
    launchConfigUsable = false;
  } else if (cfg !== undefined) {
    launchConfigUsable = Boolean(cfg.enabled);
  } else if (cfgTiming?.reverted) {
    // The contract refused to describe it. Out of range or disabled -- either way unusable,
    // and either way an answer from the chain.
    launchConfigUsable = false;
  } else {
    return noVerdict('launch readiness is UNKNOWN: the launch config could not be read');
  }

  // Native ETH resolved without a call. Otherwise an unreadable approval map is UNKNOWN --
  // silently treating it as unapproved would report a refusal pons never made.
  if (!nativePair && approved === undefined) {
    return noVerdict('launch readiness is UNKNOWN: the pair-token approval could not be read');
  }

  const readiness: CurrentReadiness = {
    launchEnabled: Boolean(launchEnabled),
    whitelisted: Boolean(whitelisted),
    canLaunch: Boolean(canLaunch),
    launchConfigUsable,
    pairApproved: Boolean(approved),
    // Never synthesised: the guard above guarantees this read succeeded.
    feeWei: BigInt(feeWei!.toString()),
    escrowMatches: String(escrow).toLowerCase() === deployment.feeEscrow.toLowerCase(),
    // Asked on its own budget by IdentityWatch. Stated as true here so this verdict
    // describes permission only; the caller reports identity as its own check.
    identityMatches: true,
    identityMismatches: [],
  };

  return {
    verdict: describeReadiness(readiness),
    timings,
    totalMs,
    slowestMs,
    batched: !serial,
    // A verdict was reachable, but something still did not answer -- for example the
    // config count while getLaunchConfig itself succeeded. Reported rather than dropped.
    failure: failed.length
      ? `answered with gaps: ${failed.map((t) => `${t.name}${t.reverted ? ' (reverted)' : ''}`).join(', ')}`
      : undefined,
  };
}

/** Formats timings for a status detail line, slowest first. */
export function summariseTimings(timings: CallTiming[]): string {
  const body = [...timings]
    .sort((a, b) => b.ms - a.ms)
    .map((t) => `${t.name} ${t.ms}ms${t.ok ? '' : ' FAILED'}`)
    .join(', ');
  // Said once, in front, rather than repeated per entry: without it seven near-identical
  // figures read as seven slow calls instead of one shared round trip.
  return timings.some((t) => t.shared) ? `one batch, per-call figures shared: ${body}` : body;
}
