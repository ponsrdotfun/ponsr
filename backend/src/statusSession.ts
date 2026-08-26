import { ethers } from 'ethers';
import { RpcEndpointDescription } from './rpcIdentity';
import { PoolStatus } from './rpcPool';
import { StatusDeps, StatusReport, buildStatus } from './statusReport';
import { CoreDeps, CoreEvidence, DEFAULT_CORE_BUDGET_MS, buildCoreEvidence } from './statusCore';
import { TimingRecorder } from './dependencyTiming';

/**
 * Assembling one `/status` response: acquire an endpoint, then report, under ONE deadline.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES IN THE ROUTE HANDLER
 * ------------------------------------------------------------
 * Because it was four lines in the route handler, and the bound everything claimed was
 * false there. `buildStatus` starts its deadline when it is called; the route called
 * `await rpcPool.acquire()` first. Acquisition serially admits every configured endpoint at
 * the full admission timeout, so with two stalled candidates the route spent 8 026 ms before
 * the "one budget for the whole response" began -- measured, 8 038 ms total against a
 * claimed 5 000 ms.
 *
 * The unit test for the budget passed the entire time, because it called `buildStatus`
 * directly. The composition was the thing that was broken, and nothing tested the
 * composition. So the composition is a function now, and it is what the test drives.
 *
 * WHAT IT GUARANTEES
 * ------------------
 *   - one deadline, started BEFORE acquisition, covering acquisition and every check
 *   - acquisition shares that budget across all candidates rather than spending
 *     endpointCount x admissionTimeoutMs on top of it
 *   - the endpoint label this response publishes is the endpoint THIS response used,
 *     carried by value, never re-read from mutable pool state at render time
 *   - a truthful body when the budget runs out, rather than a hang or a bare 500
 */

export interface AcquiredSession {
  provider: ethers.JsonRpcProvider;
  endpoint: RpcEndpointDescription;
  /** Which entry of `PoolStatus.endpoints` this is. Carried, not looked up later. */
  index: number;
}

export interface StatusPool {
  acquire(options?: { deadlineMs?: number }): Promise<AcquiredSession | null>;
  status(): PoolStatus;
}

export interface AssembleOptions {
  /** Total wall clock for the WHOLE response, acquisition included. */
  totalBudgetMs?: number;
  /**
   * The core's own deadline, nested inside the total.
   *
   * The core must not be able to spend the whole response budget waiting for chain reads
   * either -- it is smaller than the total on purpose, so optional telemetry still gets a
   * chance to answer and the page stays useful to an operator.
   */
  coreBudgetMs?: number;
  now?: () => number;
}

export const DEFAULT_STATUS_BUDGET_MS = 5000;

/**
 * The floor left for reporting once acquisition has spent its share.
 *
 * Acquisition can legitimately eat the entire budget -- that is what a stalled endpoint
 * looks like -- but a status page that then returns nothing has failed at its one job. This
 * reserves a slice so the checks still run, fail fast against a null session, and produce a
 * body that says what happened.
 */
export const REPORTING_FLOOR_MS = 250;

/**
 * Turns the status dependency set into the core's narrower one.
 *
 * Kept as a projection rather than a second dependency set so the two cannot describe
 * different worlds: every core field is read from exactly the same function the page reads.
 */
export function coreDepsFrom(
  deps: StatusDeps,
  session: AcquiredSession | null,
  endpointOrigin: string | null
): CoreDeps {
  return {
    expectedChainId: deps.expectedChainId,
    capWei: deps.dailyCapWei,
    publicLaunchEnabled: deps.publicLaunchEnabled,
    deploymentId: deps.deploymentId,
    deploymentFactory: deps.deploymentFactory,
    treasuryAddress: deps.treasuryAddress,
    observedThrough: session ? session.endpoint.fingerprint : undefined,
    endpointOrigin: endpointOrigin ?? undefined,
    endpointAvailable: Boolean(session),
    getChainId: () => deps.getChainId(),
    getBlockNumber: () => deps.getBlockNumber(),
    getLiveFeeWei: () => deps.getLiveFeeWei(),
    getTreasuryBalanceWei: () => deps.getTreasuryBalanceWei(),
    getLaunchReadiness: () => deps.getLaunchReadiness(),
    getDeploymentIdentity: deps.getDeploymentIdentity
      ? () => deps.getDeploymentIdentity!()
      : undefined,
    rollingSpendLast24hWei: deps.rollingSpendLast24hWei,
  };
}

/** The origin of an acquired endpoint, or null. Never a path or query. */
function originOf(session: AcquiredSession | null): string | null {
  const id = session?.endpoint as { origin?: string | null } | undefined;
  return id?.origin ?? null;
}

/**
 * Acquires an endpoint and produces ONLY the authoritative core.
 *
 * This is what `/status/core` serves. It never starts pair discovery or the read-provider
 * credits call, so no third party can make it slow -- which is the structural version of
 * the guarantee, stronger than ordering the work inside one function.
 */
export async function assembleCore(
  pool: StatusPool,
  makeDeps: (session: AcquiredSession | null) => StatusDeps,
  options: AssembleOptions = {}
): Promise<CoreEvidence> {
  const now = options.now ?? (() => Date.now());
  const total = options.totalBudgetMs ?? DEFAULT_STATUS_BUDGET_MS;
  const startedAt = now();
  const deadline = startedAt + total;

  const acquisitionDeadline = Math.max(startedAt, deadline - REPORTING_FLOOR_MS);
  let session: AcquiredSession | null = null;
  try {
    session = await pool.acquire({ deadlineMs: acquisitionDeadline });
  } catch {
    session = null;
  }

  const remaining = Math.max(REPORTING_FLOOR_MS, deadline - now());
  return buildCoreEvidence(coreDepsFrom(makeDeps(session), session, originOf(session)), {
    budgetMs: Math.min(options.coreBudgetMs ?? DEFAULT_CORE_BUDGET_MS, remaining),
    now,
    recorder: new TimingRecorder(now(), now),
  });
}

export async function assembleStatus(
  pool: StatusPool,
  /** Builds the dependency set for whichever endpoint (or none) was acquired. */
  makeDeps: (session: AcquiredSession | null) => StatusDeps,
  options: AssembleOptions = {}
): Promise<StatusReport> {
  const now = options.now ?? (() => Date.now());
  const total = options.totalBudgetMs ?? DEFAULT_STATUS_BUDGET_MS;
  // Started HERE, before anything touches the network. This line is the fix.
  const startedAt = now();
  const deadline = startedAt + total;

  // Acquisition gets the budget minus a reporting floor, so a fully stalled pool still
  // yields a response rather than an empty one.
  const acquisitionDeadline = Math.max(startedAt, deadline - REPORTING_FLOOR_MS);
  let session: AcquiredSession | null = null;
  try {
    session = await pool.acquire({ deadlineMs: acquisitionDeadline });
  } catch {
    // A pool that throws is a pool that admitted nothing. Reported through the checks
    // below, which is where an operator will look for it.
    session = null;
  }

  const deps = makeDeps(session);

  /**
   * THE CORE RUNS FIRST, under its own deadline, before any optional telemetry starts.
   *
   * Ordering is the guarantee: a third-party credits API cannot delay a chain fact that was
   * already read and recorded. Sampled on v36, `read-credits` was the non-ok check on two
   * of three slow responses and on none of the twenty-two fast ones.
   */
  const coreRecorder = new TimingRecorder(now(), now);
  const coreBudget = Math.min(
    options.coreBudgetMs ?? DEFAULT_CORE_BUDGET_MS,
    Math.max(REPORTING_FLOOR_MS, deadline - now())
  );
  const core = await buildCoreEvidence(coreDepsFrom(deps, session, originOf(session)), {
    budgetMs: coreBudget,
    now,
    recorder: coreRecorder,
  });

  const remaining = Math.max(REPORTING_FLOOR_MS, deadline - now());

  return buildStatus(
    {
      ...deps,
      /**
       * The endpoint THIS response used, by value.
       *
       * `describeRpc()` reports the pool's global view, including its preferred endpoint,
       * and that view is mutable: a concurrent request can move `activeIndex` between this
       * response acquiring endpoint A and rendering its `rpc-endpoint` line. The page would
       * then carry `observedThrough=A` in the spend envelope while telling a human that B
       * was serving -- one document, two answers to the same question.
       */
      sessionEndpointIndex: session?.index,
      observedThrough: session ? sessionFingerprint(session) : undefined,
      endpointOrigin: originOf(session) ?? undefined,
      core,
      coreDependencies: core.dependencies,
    },
    remaining
  );
}

function sessionFingerprint(session: AcquiredSession): string {
  return session.endpoint.fingerprint;
}
