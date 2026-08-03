import { handleMention, OrchestratorDeps } from './orchestrator';

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
  alreadyHandled: number;
  failed: number;
  /** Left unchanged when the poll itself failed, so the next run retries the
   *  same window instead of stepping over mentions that were never seen. */
  watermarkAdvanced: boolean;
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
  try {
    mentions = await deps.xClient.getRecentMentions(since);
  } catch (err: any) {
    // A failed poll must not advance the watermark: doing so would skip the
    // very window we failed to read.
    result.error = err?.message ?? String(err);
    return result;
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
      else result.recovered++;
    } catch (err: any) {
      // One bad mention must not abort the sweep -- the rest may be fine.
      result.failed++;
      console.error(`[reconciler] mention ${mention.tweetId} failed:`, err?.message ?? err);
    }
  }

  deps.db.setState(WATERMARK_KEY, now.toISOString());
  result.watermarkAdvanced = true;

  if (result.recovered > 0) {
    console.warn(
      `[reconciler] recovered ${result.recovered} mention(s) the webhook never delivered. ` +
        'Repeated recoveries mean the webhook path is unhealthy.'
    );
  }
  return result;
}

export interface ReconcilerHandle {
  stop(): void;
}

/** Starts the periodic sweep. Returns a handle so tests and shutdown paths can
 *  stop it -- an un-stoppable interval is a leak in any long-lived process. */
export function startReconciliation(
  deps: OrchestratorDeps,
  intervalMinutes = 5,
  options: ReconcilerOptions = DEFAULT_RECONCILER_OPTIONS
): ReconcilerHandle {
  let running = false;

  const tick = async () => {
    // Skip rather than queue: a sweep that outlasts its interval would otherwise
    // stack up runs that all poll the same window.
    if (running) return;
    running = true;
    try {
      const r = await reconcileOnce(deps, options);
      if (r.error) console.error('[reconciler] poll failed, watermark held:', r.error);
    } catch (err: any) {
      console.error('[reconciler] sweep threw:', err?.message ?? err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMinutes * 60 * 1000);
  // Don't hold the process open on this timer alone.
  if (typeof (timer as any).unref === 'function') (timer as any).unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
