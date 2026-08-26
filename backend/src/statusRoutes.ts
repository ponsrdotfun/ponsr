import type { Request, Response } from 'express';
import { CORE_SCHEMA, CORE_VERSION, CoreProblem } from './statusCore';
import { StatusDeps, statusHttpCode } from './statusReport';
import {
  AcquiredSession,
  AssembleOptions,
  StatusPool,
  assembleCore,
  assembleStatus,
} from './statusSession';

/**
 * The ACTUAL `/status` and `/status/core` handlers, extracted so they can be exercised.
 *
 * WHY THIS FILE EXISTS, AND IT IS NOT TIDINESS
 * --------------------------------------------
 * The previous round reported "both route catches are sanitised". Only `/status` was. The
 * real `/status/core` catch in `index.ts` still published
 * `detail: String(err.message).slice(0, 160)`, and the test that was supposed to prove
 * otherwise built a SEPARATE express app and mirrored a sanitised version of the handler.
 * So the test passed while the production source stayed vulnerable.
 *
 * That is the same defect as the fake RPC provider and the direct `buildStatus` call: a
 * test standing next to the thing instead of on it can only confirm what its author
 * already believed. The handlers live here now, `index.ts` mounts THESE, and the tests
 * import THESE. There is one copy.
 *
 * WHAT THE CATCHES MAY SAY
 * ------------------------
 * A closed shape and nothing else. No message, no `detail`, no cause, no stack, no URL, no
 * path. An exception message from anywhere in the assembly can carry a filesystem path or a
 * credential-bearing URL, and these are public endpoints.
 *
 * `assembly-failed` rather than `core-deadline-exceeded`: an arbitrary internal throw is not
 * a deadline, and labelling it as one would put a wrong but plausible cause in front of
 * whoever is debugging it.
 */

export interface StatusRouteDeps {
  pool: StatusPool;
  /** Builds the dependency set for whichever endpoint (or none) was acquired. */
  makeDeps: (session: AcquiredSession | null) => StatusDeps;
  options?: AssembleOptions;
}

/** The closed body a failed core assembly publishes. Never carries exception text. */
export function coreFailureBody(problem: CoreProblem = 'assembly-failed'): {
  schema: typeof CORE_SCHEMA;
  version: typeof CORE_VERSION;
  ok: false;
  problems: CoreProblem[];
} {
  return { schema: CORE_SCHEMA, version: CORE_VERSION, ok: false, problems: [problem] };
}

/** The closed body a failed status assembly publishes. */
export function statusFailureBody(): { state: 'down'; problem: string } {
  return { state: 'down', problem: 'status-could-not-be-assembled' };
}

/**
 * `GET /status` — the operator page: core evidence plus optional telemetry.
 *
 * `buildStatus` is written not to throw, and the producer boundary makes that true for
 * every dependency it invokes. The catch is still here because "written not to throw" is a
 * claim that has been wrong twice in this codebase, and a bare 500 with no body is
 * indistinguishable from the process being gone.
 */
export function statusHandler(deps: StatusRouteDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const report = await assembleStatus(deps.pool, deps.makeDeps, deps.options);
      res.status(statusHttpCode(report)).json(report);
    } catch (err) {
      void err;
      res.status(503).json(statusFailureBody());
    }
  };
}

/**
 * `GET /status/core` — the authoritative core alone.
 *
 * 200 when the core is ok, 503 when it is not, so a consumer reading only the status line
 * still fails closed.
 */
export function statusCoreHandler(deps: StatusRouteDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const core = await assembleCore(deps.pool, deps.makeDeps, deps.options);
      res.status(core.ok ? 200 : 503).json(core);
    } catch (err) {
      void err;
      res.status(503).json(coreFailureBody());
    }
  };
}
