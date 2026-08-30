import { handleMention, OrchestratorDeps } from './orchestrator';
import { Notifier } from './monitor';

/**
 * Part 7 §5 -- listener reconciliation.
 *
 * The webhook is the primary path and it is not reliable: providers drop and
 * retry deliveries under ordinary network conditions, and the process itself can
 * be restarting when one arrives. Without a fallback, a dropped delivery means a
 * user tagged the bot, got nothing back, and no record of the request exists
 * anywhere -- a silent failure, which is the worst kind.
 *
 * This polls recent mentions on a timer and pushes anything unseen back through
 * the same `handleMention` pipeline. It is deliberately *not* a second code path:
 * reprocessing is safe only because `claimTweetForProcessing` is an atomic
 * DB-level claim, so a mention the webhook already handled is a no-op here rather
 * than a second launch. That guarantee is what makes overlapping polls free.
 */

import { PartialMentionCoverageError } from './mentionSources';

const WATERMARK_KEY = 'reconciler:watermark';

export interface ReconcilerOptions {
  /** How far back the first ever poll looks, with no watermark to start from. */
  initialLookbackMinutes: number;
  /** Ceiling on the lookback. After a long outage, replaying days of mentions
   *  would hammer the API and re-answer conversations that have moved on --
   *  better to accept the gap, and report it, than to flood. */
  maxLookbackHours: number;
  /** Re-poll a little before the watermark. Timestamps between the provider and
   *  this process are not perfectly aligned, and an exact-boundary query can
   *  drop a mention that landed in the same second as the last poll. */
  overlapSeconds: number;
}

export const DEFAULT_RECONCILER_OPTIONS: ReconcilerOptions = {
  initialLookbackMinutes: 30,
  maxLookbackHours: 24,
  overlapSeconds: 90,
};

export interface ReconcileResult {
  polled: number;
  recovered: number;
  /** Mentions deliberately consumed while Ponsr public launching is paused. They are
   *  neither recovered nor failed: no parse, reply, launch, or spend occurred. */
  suppressedPaused: number;
  alreadyHandled: number;
  failed: number;
  /** Left unchanged when the poll itself failed, so the next run retries the
   *  same window instead of stepping over mentions that were never seen. */
  watermarkAdvanced: boolean;
  /** Set when a secondary mention source failed: the window was only partly read. */
  partialCoverage?: string[];
  error?: string;
}

function isoMinus(from: Date, ms: number): string {
  return new Date(from.getTime() - ms).toISOString();
}

/** One reconciliation sweep. Safe to call at any time, including while the
 *  webhook path is actively processing. */
export async function reconcileOnce(
  deps: OrchestratorDeps,
  options: ReconcilerOptions = DEFAULT_RECONCILER_OPTIONS,
  now: Date = new Date()
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    polled: 0,
    recovered: 0,
    suppressedPaused: 0,
    alreadyHandled: 0,
    failed: 0,
    watermarkAdvanced: false,
  };

  const stored = deps.db.getState(WATERMARK_KEY);
  const floor = isoMinus(now, options.maxLookbackHours * 3600 * 1000);
  let since = stored ?? isoMinus(now, options.initialLookbackMinutes * 60 * 1000);

  // Clamp forward after a long outage.
  if (since < floor) since = floor;
  // ...then step back slightly, to cover clock skew at the boundary.
  since = isoMinus(new Date(since), options.overlapSeconds * 1000);

  let mentions;
  /**
   * PARTIAL COVERAGE IS PROCESSED, BUT NEVER CONFIRMED.
   *
   * Mentions now come from more than one source (see `mentionSources.ts`). When
   * one of the secondaries fails, the reader throws a `PartialMentionCoverageError`
   * carrying whatever DID arrive. Both halves of that matter:
   *
   *   - the mentions are still processed, so one flaky provider cannot stop
   *     launches the other source genuinely saw;
   *   - the watermark is NOT advanced, so the window is read again next sweep
   *     and whatever the failed source alone would have supplied is not lost.
   *
   * `processed_tweets` makes the re-read free: anything already handled is
   * refused on the second pass.
   */
  let coverageComplete = true;
  try {
    mentions = await deps.xClient.getRecentMentions(since);
  } catch (err: any) {
    if (err instanceof PartialMentionCoverageError) {
      mentions = err.mentions;
      coverageComplete = false;
      result.partialCoverage = err.failures;
    } else {
      // A failed poll must not advance the watermark: doing so would skip the
      // very window we failed to read.
      result.error = err?.message ?? String(err);
      return result;
    }
  }

  result.polled = mentions.length;

  for (const mention of mentions) {
    if (deps.db.isTweetProcessed(mention.tweetId)) {
      result.alreadyHandled++;
      continue;
    }
    try {
      const outcome = await handleMention(mention, deps);
      // A concurrent webhook delivery can win the claim between our check and
      // the call; that is the idempotency guard working, not a recovery.
      if (outcome.kind === 'duplicate') result.alreadyHandled++;
      // Counted as failed, not recovered. The parser being unreachable used to throw
      // out of handleMention and land in the catch below; it is now handled there,
      // which released the claim so the mention survives -- but nothing about it was
      // read, so calling it recovered would report a success that did not happen and
      // hide a bot that cannot process anything at all.
      else if (outcome.kind === 'rejected' && outcome.reason === 'PUBLIC_LAUNCH_PAUSED') {
        // Deliberately consumed so enabling later cannot replay a backlog into launches.
        // Nothing was parsed, answered, launched, signed, or spent, so this is suppression,
        // not recovery and not failure.
        result.suppressedPaused++;
      } else if (outcome.kind === 'rejected' && outcome.reason === 'PARSER_UNAVAILABLE') {
        result.failed++;
      } else result.recovered++;
    } catch (err: any) {
      // One bad mention must not abort the sweep -- the rest may be fine.
      result.failed++;
      console.error(`[reconciler] mention ${mention.tweetId} failed:`, err?.message ?? err);
    }
  }

  if (coverageComplete) {
    deps.db.setState(WATERMARK_KEY, now.toISOString());
    result.watermarkAdvanced = true;
  } else {
    console.warn(
      '[reconciler] partial mention coverage, watermark held:',
      (result.partialCoverage ?? []).join('; ')
    );
  }

  if (result.recovered > 0) {
    console.warn(
      `[reconciler] recovered ${result.recovered} mention(s) the webhook never delivered. ` +
        'Repeated recoveries mean the webhook path is unhealthy.'
    );
  }
  return result;
}

/**
 * What the sweep's health looks like from outside.
 *
 * Exists because `/status` reported `mention-crosscheck = ok` while the sweep had been
 * failing every two minutes for days. That check read CONFIGURATION -- is a cross-check
 * interval set -- and configuration cannot go wrong in the way that mattered. A status page
 * that cannot distinguish "polling and finding nothing" from "not polling at all" says
 * nothing on the day it is needed, because a dead read path and a quiet afternoon look
 * identical from the outside.
 */
export interface SweepHealth {
  /** ISO timestamp of the last poll that completed without error, or null if none has. */
  lastSuccessAt: string | null;
  /** Consecutive failures since the last success. Zero when healthy. */
  consecutiveFailures: number;
  /** The last error, truncated, so the status page can name the cause rather than the symptom. */
  lastError: string | null;
}

export interface ReconcilerHandle {
  /** Live sweep health. See SweepHealth. */
  health(): SweepHealth;
  stop(): void;
}

/** Starts the periodic sweep. Returns a handle so tests and shutdown paths can
 *  stop it -- an un-stoppable interval is a leak in any long-lived process. */
/**
 * How many consecutive failures before the operator is told.
 *
 * Not one: a single failed poll is usually a blip -- a timeout, a 429, a provider hiccup --
 * and an alert per blip trains people to ignore alerts. Three in a row is a pattern, and at a
 * 300s interval that is fifteen minutes of silence, which is still well inside the window
 * where nobody has noticed the bot is deaf.
 */
const FAILURES_BEFORE_ALERT = 3;

/**
 * How often to say it again while the sweep is still failing.
 *
 * Alerting once per incident is correct for something that gets noticed. This did not get
 * noticed: on 2026-08-24 the production sweep had been answering `402 Credits is not
 * enough` every two minutes across the whole retained log window, and the only alert had
 * fired days earlier and scrolled out of the operator's Telegram.
 *
 * One line, once, days ago, is indistinguishable from no line at all. So the alert repeats
 * while the condition persists -- rarely enough not to become noise, often enough that a
 * deaf bot cannot stay quietly deaf.
 */
const REALERT_AFTER_FAILURES = 60;

export function startReconciliation(
  deps: OrchestratorDeps,
  intervalMinutes = 5,
  options: ReconcilerOptions = DEFAULT_RECONCILER_OPTIONS,
  notifier?: Notifier
): ReconcilerHandle {
  let running = false;
  // The sweep failing is invisible from outside: the process stays up, /health keeps
  // answering 200, and mentions simply stop being seen. Running out of twitterapi.io credit
  // produces exactly this, and so does a rotated key. Without an alert the first symptom is
  // somebody asking why the bot ignored them.
  let consecutiveFailures = 0;
  let alerted = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;

  const onFailure = async (reason: string) => {
    consecutiveFailures += 1;
    lastError = reason.slice(0, 300);
    if (consecutiveFailures < FAILURES_BEFORE_ALERT || !notifier) return;
    // First crossing, then again every REALERT_AFTER_FAILURES. An incident that outlives
    // the operator's scrollback has to speak up more than once.
    const sinceFirst = consecutiveFailures - FAILURES_BEFORE_ALERT;
    if (alerted && sinceFirst % REALERT_AFTER_FAILURES !== 0) return;
    alerted = true;
    await notifier.send({
      kind: 'MENTION_SWEEP_FAILING',
      severity: 'critical',
      message:
        `The mention sweep has failed ${consecutiveFailures} times in a row. The bot is not ` +
        'seeing mentions and nobody is being answered. Check twitterapi.io credit first -- ' +
        'an exhausted balance looks exactly like this.',
      detail: {
        consecutiveFailures,
        lastError: reason.slice(0, 300),
        lastSuccessAt,
        repeated: sinceFirst > 0,
      },
      at: new Date().toISOString(),
    });
  };

  const onSuccess = async () => {
    const wasAlerted = alerted;
    consecutiveFailures = 0;
    alerted = false;
    lastError = null;
    lastSuccessAt = new Date().toISOString();
    if (!wasAlerted || !notifier) return;
    await notifier.send({
      kind: 'MENTION_SWEEP_RECOVERED',
      severity: 'info',
      message: 'The mention sweep is working again.',
      at: new Date().toISOString(),
    });
  };

  /**
   * A SWEEP THAT HANGS MUST NOT LOOK LIKE A SWEEP THAT IS FINE.
   *
   * `running` skips a tick while the previous one is still going, which is right
   * -- stacked runs would all poll the same window. But it turns one hung
   * request into permanent silence: every later tick returns immediately, so the
   * sweep records neither a success nor a failure. `/status` then reads
   * `degraded` ("no successful poll yet") rather than `down`, and the alert is
   * driven by consecutiveFailures, so nobody is ever told. The bot stops hearing
   * anybody and every signal we have says it is merely warming up.
   *
   * The deadline is shorter than the interval on purpose: a hung sweep must be
   * reported before the next tick would have run.
   *
   * The abandoned attempt is left to finish or fail on its own. It cannot be
   * cancelled from here, and its result is discarded -- `processed_tweets` is
   * what makes a mention seen twice harmless, and the watermark only advances on
   * a completed poll.
   */
  const timedOut = Symbol('sweep-deadline');
  const withDeadline = async <T,>(work: Promise<T>): Promise<T | typeof timedOut> => {
    let timer: NodeJS.Timeout | undefined;
    const alarm = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), deadlineMs);
      if (typeof (timer as any).unref === 'function') (timer as any).unref();
    });
    try {
      return await Promise.race([work, alarm]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const tick = async () => {
    // Skip rather than queue: a sweep that outlasts its interval would otherwise
    // stack up runs that all poll the same window.
    if (running) return;
    running = true;
    try {
      const outcome = await withDeadline(reconcileOnce(deps, options));
      if (outcome === timedOut) {
        console.error(`[reconciler] sweep exceeded its ${deadlineMs}ms deadline, watermark held`);
        await onFailure(`sweep exceeded its ${deadlineMs}ms deadline`);
        return;
      }
      const r = outcome;
      if (r.error) {
        console.error('[reconciler] poll failed, watermark held:', r.error);
        await onFailure(String(r.error));
      } else {
        await onSuccess();
      }
    } catch (err: any) {
      console.error('[reconciler] sweep threw:', err?.message ?? err);
      await onFailure(String(err?.message ?? err));
    } finally {
      running = false;
    }
  };

  // Fractional minutes are meaningful here: the interval is the latency users feel, and it
  // is bought from twitterapi.io by the poll. See MENTION_POLL_SECONDS in config.ts for the
  // arithmetic behind whatever value index.ts passes.
  const intervalMs = Math.round(intervalMinutes * 60 * 1000);
  // Comfortably inside the interval, and never so small that a healthy sweep on
  // a slow day is called a failure.
  const deadlineMs = Math.max(15_000, Math.min(120_000, Math.round(intervalMs * 0.8)));

  const timer = setInterval(tick, intervalMs);
  // Don't hold the process open on this timer alone.
  if (typeof (timer as any).unref === 'function') (timer as any).unref();

  return {
    health: () => ({ lastSuccessAt, consecutiveFailures, lastError }),
    stop() {
      clearInterval(timer);
    },
  };
}
