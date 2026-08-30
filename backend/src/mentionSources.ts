/**
 * A SECOND WAY OF HEARING, BECAUSE ONE WAS NOT ENOUGH.
 *
 * The bot found mentions through `twitterapi.io`'s `advanced_search` for
 * `@ponsrdotfun`, and that was the only way it heard anything. On 2026-08-30 a
 * correctly formed launch request from an active account was never processed.
 * Nothing looked wrong: the sweep succeeded, credits were plentiful, the public
 * gate was open, and `processed_tweets` simply never grew. That is the failure
 * this file exists to end -- the one that looks exactly like nobody tweeting.
 *
 * Measured against the live provider at the time, four query forms:
 *
 *   "bitcoin"               20 results, newest 0.2 minutes old
 *   "from:<the author>"     20 results, newest four days old
 *   "@ponsrdotfun"          20 results, newest four days old
 *   the tweet's own id       0 results
 *
 * The index was fresh and the author was not blocked. That one tweet was simply
 * absent from search, and its distinguishing feature was its shape: a reply
 * inside somebody else's thread that mentioned the bot, rather than a reply
 * addressed to the bot. X search routinely declines to surface those.
 *
 * `mentionCrossCheck.ts` had already written this down -- it polls X's own
 * mentions timeline every six hours precisely because search "may not index a
 * real mention". But it only ALERTS. The authoritative source was in the
 * codebase, correct, and wired to a pager instead of to the pipeline.
 *
 * So it becomes a reading source here, beside the search rather than instead of
 * it. Neither provider can make the bot deaf on its own, and a partial read is
 * never allowed to look like a complete one.
 */
import { structuredPhotoUrls, trustedPhotoUrl } from './launchMedia';
import { InboundMention } from './types';
// Type-only: `xClient.ts` imports the classes below, and a value import here
// would close that loop at runtime.
import type { XReader } from './xClient';

/** Anything that can answer "what mentioned us since then". */
export interface MentionSource {
  getRecentMentions(sinceIso: string): Promise<InboundMention[]>;
}

/**
 * Some sources answered and at least one did not.
 *
 * This is NOT an ordinary failure, and collapsing it into one would cost real
 * launches either way:
 *
 *   - swallow it, return what arrived, and the reconciler advances its watermark
 *     past a window it only partly read. Whatever the failed source alone would
 *     have provided is lost permanently, in silence.
 *   - throw it away entirely, and one flaky secondary stops every launch the
 *     primary DID see, for as long as the flake lasts.
 *
 * So the mentions travel WITH the error: the caller can process what genuinely
 * arrived and still refuse to advance the watermark.
 */
export class PartialMentionCoverageError extends Error {
  constructor(
    readonly mentions: InboundMention[],
    readonly failures: string[]
  ) {
    super(`partial mention coverage: ${failures.join('; ')}`);
    this.name = 'PartialMentionCoverageError';
  }
}

/**
 * X's own mentions timeline: `GET /2/users/:id/mentions`.
 *
 * Authoritative about mentions of the account in a way search is not, and
 * already proven in this codebase -- `mentionCrossCheck.ts` has been calling it
 * on the same bearer token. This asks for the fields a launch actually needs,
 * which the cross-check never had to.
 */
export class XApiMentionsSource implements MentionSource {
  private userId: string | null = null;

  constructor(
    private bearerToken: string,
    private botHandle: string,
    private fetchImpl: typeof fetch = fetch,
    /** Cost control. Billed per post returned; a sweep runs every five minutes. */
    private maxResults = 25
  ) {}

  private async resolveUserId(): Promise<string> {
    if (this.userId) return this.userId;
    const res = await this.fetchImpl(
      `https://api.x.com/2/users/by/username/${encodeURIComponent(this.botHandle)}`,
      { headers: { Authorization: `Bearer ${this.bearerToken}` } }
    );
    const body: any = await res.json();
    if (!res.ok || !body?.data?.id) {
      throw new Error(`could not resolve @${this.botHandle}: ${res.status}`);
    }
    this.userId = String(body.data.id);
    return this.userId;
  }

  async getRecentMentions(sinceIso: string): Promise<InboundMention[]> {
    // Inert rather than broken when unconfigured: this is an ADDITIONAL source,
    // and a deployment without a bearer token should keep working on search
    // alone rather than failing every poll.
    if (!this.bearerToken) return [];

    const userId = await this.resolveUserId();
    const url =
      `https://api.x.com/2/users/${userId}/mentions` +
      `?max_results=${this.maxResults}` +
      `&start_time=${encodeURIComponent(sinceIso)}` +
      `&tweet.fields=created_at,referenced_tweets,attachments` +
      `&expansions=author_id,attachments.media_keys` +
      `&user.fields=username` +
      `&media.fields=type,url`;

    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });
    const body: any = await res.json();
    // An empty list and a refusal are different answers, and only one of them
    // means "nobody tweeted". Never return [] for a refusal.
    if (!res.ok) throw new Error(`mentions timeline ${res.status}`);

    const tweets: any[] = Array.isArray(body?.data) ? body.data : [];
    const usersById = new Map<string, string>(
      (body?.includes?.users ?? []).map((u: any) => [String(u?.id ?? ''), String(u?.username ?? '')])
    );
    const mediaByKey = new Map<string, any>(
      (body?.includes?.media ?? []).map((m: any) => [String(m?.media_key ?? ''), m])
    );

    return tweets.flatMap((t: any): InboundMention[] => {
      const tweetId = String(t?.id ?? '');
      const authorXUserId = String(t?.author_id ?? '');
      if (!tweetId || !authorXUserId) return [];

      const repliedTo = (t?.referenced_tweets ?? []).find(
        (r: any) => String(r?.type ?? '') === 'replied_to'
      );

      // Rebuilt into the shape `structuredPhotoUrls` reads, so the SAME validator
      // guards both routes. A second, laxer photo path would be a hole in the
      // launch pipeline that happens to be reachable from a different provider.
      const media = (t?.attachments?.media_keys ?? [])
        .map((key: string) => mediaByKey.get(String(key)))
        .filter(Boolean)
        .map((m: any) => ({ type: m?.type, media_url_https: m?.url }));

      return [
        {
          tweetId,
          authorXUserId,
          authorHandle: usersById.get(authorXUserId) ?? '',
          text: String(t?.text ?? ''),
          createdAt: new Date(t?.created_at ?? Date.now()).toISOString(),
          photoUrl: trustedPhotoUrl(structuredPhotoUrls({ media })),
          inReplyToTweetId: repliedTo ? String(repliedTo.id) : null,
        },
      ];
    });
  }
}

/** Prefer whichever copy of a mention carries more, field by field. */
function richer(a: InboundMention, b: InboundMention): InboundMention {
  const pick = <K extends keyof InboundMention>(key: K): InboundMention[K] => {
    const left = a[key];
    const right = b[key];
    const empty = (v: unknown) => v === null || v === undefined || v === '';
    if (empty(left)) return right;
    if (empty(right)) return left;
    // Both present: keep the longer text, otherwise the first.
    if (key === 'text') return (String(right).length > String(left).length ? right : left);
    return left;
  };
  return {
    tweetId: a.tweetId,
    authorXUserId: pick('authorXUserId'),
    authorHandle: pick('authorHandle'),
    text: pick('text'),
    createdAt: pick('createdAt'),
    photoUrl: pick('photoUrl'),
    inReplyToTweetId: pick('inReplyToTweetId'),
  };
}

/**
 * The search reader plus every additional source, unioned and de-duplicated.
 *
 * The PRIMARY stays authoritative for everything that is not a mention --
 * account signals and read credits -- because those are the search provider's
 * job and X's timeline does not answer them.
 */
export class UnionMentionReader implements XReader {
  constructor(
    private primary: XReader,
    private extras: MentionSource[] = []
  ) {}

  getAccountSignals(xUserId: string, xHandle?: string) {
    return this.primary.getAccountSignals(xUserId, xHandle);
  }

  getReadCredits() {
    return this.primary.getReadCredits ? this.primary.getReadCredits() : Promise.resolve(null);
  }

  async getRecentMentions(sinceIso: string): Promise<InboundMention[]> {
    // A primary failure is a plain failure: the reconciler holds its watermark
    // and retries, exactly as it did before this file existed.
    const fromPrimary = await this.primary.getRecentMentions(sinceIso);

    const byId = new Map<string, InboundMention>();
    for (const m of fromPrimary) if (m?.tweetId) byId.set(m.tweetId, m);

    const failures: string[] = [];
    const settled = await Promise.allSettled(
      this.extras.map((extra) => extra.getRecentMentions(sinceIso))
    );
    for (const [index, result] of settled.entries()) {
      if (result.status === 'rejected') {
        failures.push(`source ${index + 1}: ${result.reason?.message ?? String(result.reason)}`);
        continue;
      }
      for (const m of result.value) {
        if (!m?.tweetId) continue;
        const existing = byId.get(m.tweetId);
        byId.set(m.tweetId, existing ? richer(existing, m) : m);
      }
    }

    const mentions = [...byId.values()];
    if (failures.length > 0) throw new PartialMentionCoverageError(mentions, failures);
    return mentions;
  }
}
