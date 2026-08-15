import { Db } from './db';
import { Notifier } from './monitor';

/**
 * Catches the one failure that looks exactly like silence.
 *
 * The bot hears through twitterapi.io's search, and on 2026-08-12 that search did
 * not index a real mention of @ponsrdotfun while X's own mentions timeline returned
 * it immediately. Their documentation says as much: a brand-new or low-reputation
 * account often does not appear in search.
 *
 * Nothing else can detect this. `MENTION_SWEEP_FAILING` fires when a poll throws;
 * a poll that succeeds and returns an empty list is indistinguishable from a quiet
 * afternoon, and for a new bot a quiet afternoon is the normal state — so alerting
 * on "zero for a while" would fire constantly and teach everyone to ignore it.
 *
 * The only reliable signal is a second, independent source. X's own mentions
 * timeline is authoritative about mentions of the account, so this asks it
 * occasionally and compares against what the bot actually handled.
 *
 * COST, stated plainly because it is not free: X bills per post read. Capped at
 * five posts per check, at six-hourly intervals, that is roughly $0.10 a day
 * against a service costing about $8 a month. Widen MENTION_CROSSCHECK_HOURS to
 * spend less and find out later.
 */

export interface CrossCheckDeps {
  db: Db;
  bearerToken: string;
  botHandle: string;
  /** Injected so tests do not reach the network. */
  fetchImpl?: typeof fetch;
}

export interface CrossCheckResult {
  checked: number;
  missed: string[];
  error?: string;
}

/** Mentions younger than this are ignored: the sweep may simply not have run yet,
 *  and reporting a mention the bot is about to handle is a false alarm. */
const SETTLE_MINUTES = 15;

let cachedUserId: string | null = null;

export async function crossCheckMentions(
  deps: CrossCheckDeps,
  now: Date = new Date()
): Promise<CrossCheckResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const auth = { Authorization: `Bearer ${deps.bearerToken}` };

  try {
    if (!cachedUserId) {
      const r = await doFetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(deps.botHandle)}`, {
        headers: auth,
      });
      const b: any = await r.json();
      if (!r.ok || !b?.data?.id) {
        return { checked: 0, missed: [], error: `could not resolve @${deps.botHandle}: ${r.status}` };
      }
      cachedUserId = String(b.data.id);
    }

    // max_results is the cost control: this is billed per post returned, and five
    // is enough to notice that the search has stopped seeing anything at all.
    const url =
      `https://api.x.com/2/users/${cachedUserId}/mentions` +
      `?max_results=5&tweet.fields=created_at`;
    const res = await doFetch(url, { headers: auth });
    const body: any = await res.json();
    if (!res.ok) {
      return { checked: 0, missed: [], error: `mentions timeline ${res.status}` };
    }

    const tweets: any[] = body?.data ?? [];
    const settleBefore = new Date(now.getTime() - SETTLE_MINUTES * 60000).toISOString();
    const missed: string[] = [];

    for (const t of tweets) {
      const id = String(t?.id ?? '');
      if (!id) continue;
      // Only count it as missed once it has had time to arrive through the sweep.
      const createdAt = String(t?.created_at ?? '');
      if (createdAt && createdAt > settleBefore) continue;
      if (!deps.db.isTweetProcessed(id)) missed.push(id);
    }

    return { checked: tweets.length, missed };
  } catch (err: any) {
    return { checked: 0, missed: [], error: err?.message ?? String(err) };
  }
}

export interface CrossCheckHandle {
  stop(): void;
}

/**
 * Runs the cross-check on an interval and alerts when the two sources disagree.
 *
 * A disagreement means the bot is deaf to mentions that demonstrably exist, which
 * is worth waking someone for: every launch request arriving during that window is
 * being dropped in silence.
 */
export function startMentionCrossCheck(
  deps: CrossCheckDeps,
  notifier: Notifier,
  intervalHours = 6
): CrossCheckHandle {
  let running = false;
  let alerted = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await crossCheckMentions(deps);
      if (r.error) {
        console.error('[crosscheck] could not compare against X:', r.error);
        return;
      }
      if (r.missed.length > 0) {
        if (!alerted) {
          alerted = true;
          await notifier.send({
            kind: 'MENTION_MISSED',
            severity: 'critical',
            message:
              `X shows ${r.missed.length} mention(s) the bot never handled. The mention search is ` +
              'not seeing them, so launch requests are being dropped silently. This is the failure ' +
              'that looks exactly like nobody tweeting.',
            detail: { missedTweetIds: r.missed.slice(0, 5), checked: r.checked },
            at: new Date().toISOString(),
          });
        }
      } else if (alerted) {
        alerted = false;
        await notifier.send({
          kind: 'MENTION_SWEEP_RECOVERED',
          severity: 'info',
          message: 'The bot is seeing mentions again: X and the sweep now agree.',
          at: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      console.error('[crosscheck] threw:', err?.message ?? err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, Math.max(1, intervalHours) * 3600 * 1000);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  // Deliberately not run at boot: a redeploy would then re-check every time, and
  // the check costs money on every call.
  return { stop() { clearInterval(timer); } };
}

/** Test seam: the resolved user id is cached for the process's lifetime. */
export function __resetCrossCheckCache() {
  cachedUserId = null;
}
