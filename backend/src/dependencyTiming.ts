/**
 * Per-dependency cost for one `/status` response, measured without leaking anything.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/status` published per-call timing for the launchpad check and for nothing else. So
 * when the page took 4.7 s while the readiness read took 59 ms, the remaining four
 * seconds were unattributable from outside -- and the honest answer in the deploy report
 * was UNKNOWN.
 *
 * Sampling the live page 25 times narrowed it: `read-credits` was non-ok on 2 of the 3
 * slow responses and on 0 of the 22 fast ones, while one slow response instead showed a
 * 3 012 ms readiness read. Two contributors, not one -- an optional third-party call and,
 * occasionally, the chain path itself. That is exactly why guessing was the wrong move and
 * measurement belongs in the response.
 *
 * WHAT MAY BE PUBLISHED
 * ---------------------
 * A fixed allowlist of dependency names and a closed set of outcome categories. Never a
 * URL, path, query, userinfo, API key, raw error body, request payload, provider response,
 * wallet secret or signer data -- external error text routinely carries the request URL,
 * and RPC and provider URLs routinely carry keys.
 *
 * These are DIAGNOSTICS. Nothing decides anything from them: they say what a response
 * cost, never what is true about the chain.
 */

/** Every dependency whose cost may be published. Anything else is refused. */
export const DEPENDENCY_NAMES = [
  'chain',
  'launch-fee',
  'launch-readiness',
  'treasury-balance',
  'deployment-identity',
  'pair-assets',
  'read-credits',
] as const;

export type DependencyName = (typeof DEPENDENCY_NAMES)[number];

const ALLOWED: ReadonlySet<string> = new Set(DEPENDENCY_NAMES);

/**
 * How a dependency finished. Closed on purpose: an open-ended reason field is where a
 * provider's error text -- and the URL inside it -- ends up being copied.
 */
export type DependencyOutcome = 'ok' | 'failed' | 'timed-out' | 'not-reached' | 'not-configured';

export interface DependencyTiming {
  name: DependencyName;
  outcome: DependencyOutcome;
  /** Wall clock from start to settle, in ms. Present even for a failure: a slow failure
   *  and a fast one send an operator to different places. */
  ms: number;
  /** Offset from the start of the response, so concurrency is visible rather than claimed. */
  startedAtMs: number;
  /**
   * True when `ms` is the cost of a shared batch rather than of this dependency alone.
   *
   * Launch readiness is seven contract reads in one round trip; they all measure the same
   * interval. Reporting that as seven independent costs would be confidently wrong.
   */
  shared: boolean;
}

/**
 * Records dependency costs for exactly one response.
 *
 * Deliberately not a module-level singleton: two concurrent `/status` requests must not be
 * able to write into each other's evidence, and a returned response must not be mutable by
 * work that finished after it.
 */
export class TimingRecorder {
  private readonly rows: DependencyTiming[] = [];
  private sealed = false;

  constructor(
    private readonly origin: number = Date.now(),
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Wraps a dependency promise, recording its cost and outcome.
   *
   * The promise is returned unchanged -- the caller still gets the value or the rejection.
   * This must not serialize anything: it attaches to a promise that is already running.
   */
  track<T>(name: DependencyName, p: Promise<T>, shared = false): Promise<T> {
    if (!ALLOWED.has(name)) {
      throw new Error(`refusing to publish timing for an unlisted dependency: ${String(name)}`);
    }
    const startedAtMs = this.now() - this.origin;
    const started = this.now();
    const settle = (outcome: DependencyOutcome) => {
      // A late settle after the response was returned must not rewrite its evidence.
      if (this.sealed) return;
      this.rows.push({ name, outcome, ms: this.now() - started, startedAtMs, shared });
    };
    p.then(
      () => settle('ok'),
      (err: unknown) => settle(classify(err))
    );
    return p;
  }

  /** Records a dependency the deployment does not have, so its absence is visible. */
  absent(name: DependencyName): void {
    if (this.sealed || !ALLOWED.has(name)) return;
    this.rows.push({ name, outcome: 'not-configured', ms: 0, startedAtMs: 0, shared: false });
  }

  /**
   * Freezes and returns the evidence.
   *
   * After this, nothing can be added. A dependency that is still running when the response
   * is assembled is recorded as `not-reached` rather than silently omitted -- "we ran out
   * of budget before this answered" is information, and dropping the row would make a slow
   * dependency look like one that was never configured.
   */
  seal(expected: readonly DependencyName[]): DependencyTiming[] {
    const seen = new Set(this.rows.map((r) => r.name));
    for (const name of expected) {
      if (!seen.has(name)) {
        this.rows.push({ name, outcome: 'not-reached', ms: this.now() - this.origin, startedAtMs: 0, shared: false });
      }
    }
    this.sealed = true;
    return [...this.rows].sort((a, b) => b.ms - a.ms);
  }

  /** The slowest settled dependency, which is what a budget has to be set against. */
  static slowest(rows: DependencyTiming[]): DependencyTiming | null {
    return rows.length ? rows.reduce((a, b) => (b.ms > a.ms ? b : a)) : null;
  }
}

/**
 * Maps any thrown value to one of the closed categories.
 *
 * Nothing from the error is retained. The one signal read is whether the message looks like
 * this codebase's own deadline marker; everything else is `failed`, because distinguishing
 * further would mean inspecting text written by a remote host.
 */
function classify(err: unknown): DependencyOutcome {
  const message = String((err as { message?: unknown })?.message ?? '');
  if (/did not answer within|already used its whole budget|was not reached/.test(message)) {
    return /already used its whole budget|was not reached/.test(message) ? 'not-reached' : 'timed-out';
  }
  return 'failed';
}

/** One line for an operator, slowest first. Never includes an error message. */
export function summariseDependencies(rows: DependencyTiming[]): string {
  return rows
    .map((r) => `${r.name} ${r.ms}ms${r.outcome === 'ok' ? '' : ` (${r.outcome})`}${r.shared ? ' [batched]' : ''}`)
    .join(', ');
}
