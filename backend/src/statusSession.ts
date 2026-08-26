import { ethers } from 'ethers';
import { RpcEndpointDescription } from './rpcIdentity';
import { PoolStatus } from './rpcPool';
import { StatusDeps, StatusReport, buildStatus } from './statusReport';

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

  const remaining = Math.max(REPORTING_FLOOR_MS, deadline - now());
  const deps = makeDeps(session);

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
    },
    remaining
  );
}

function sessionFingerprint(session: AcquiredSession): string {
  return session.endpoint.fingerprint;
}
