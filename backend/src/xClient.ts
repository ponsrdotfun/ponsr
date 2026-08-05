import * as crypto from 'crypto';
import { AccountSignals, InboundMention } from './types';
import { config } from './config';

/**
 * Reading and posting are split across two providers, on purpose.
 *
 * They are not the same kind of operation, and the original single-provider plan (Part 10)
 * treated them as if they were:
 *
 *   READING is data collection. It is invisible as account activity, and it is the
 *   high-volume side -- every mention, including the ones that are not launch requests.
 *   twitterapi.io is ~$0.00015 per matched tweet against X's own $0.005 per post read:
 *   **33x cheaper**, on exactly the side where volume lands.
 *
 *   POSTING is account activity. It is what X sees @ponsrdotfun doing, and it is the
 *   low-volume side -- one reply per launch. X's own API charges $0.015 for that. At a
 *   hundred launches a month that is $1.50, and it retires any question of whether automated
 *   posting through a third party sits inside X's rules. The account is the product, and
 *   unlike a domain or a contract it cannot be re-minted.
 *
 * That question was raised in Part 10 and never answered. Splitting the paths settles it for
 * the price of a coffee rather than arguing it.
 *
 * ⚠️ A POST CONTAINING A URL COSTS $0.200, NOT $0.015 -- thirteen times more. The success
 * reply is exactly where a link to ponsr.fun would naturally go, which makes that a product
 * decision with a price attached rather than a detail to discover on an invoice. See
 * REPLY_INCLUDE_LINK in config.ts.
 *
 * Pricing read from docs.x.com on 2026-08-04. X has moved from subscription tiers to
 * pay-per-use, which is why Part 10's "$200/month" figure no longer describes anything real.
 */

export interface XClient {
  postReply(inReplyToTweetId: string, text: string): Promise<{ tweetId: string }>;
  getAccountSignals(xUserId: string): Promise<AccountSignals>;
  /** Mentions of the bot since a timestamp, newest-or-oldest order irrelevant.
   *  This is the fallback path for Part 7 §5: webhooks get dropped under real
   *  network conditions, and without a poll to fall back on a dropped delivery
   *  loses that user's launch request permanently and silently. */
  getRecentMentions(sinceIso: string): Promise<InboundMention[]>;
}

/** The read half -- high volume, no account exposure. */
export interface XReader {
  getAccountSignals(xUserId: string): Promise<AccountSignals>;
  getRecentMentions(sinceIso: string): Promise<InboundMention[]>;
}

/** The write half -- low volume, and the half that can get an account suspended. */
export interface XWriter {
  postReply(inReplyToTweetId: string, text: string): Promise<{ tweetId: string }>;
}

/**
 * Composes the two halves into the interface the orchestrator already expects.
 *
 * Keeping `XClient` intact is what makes this a swap rather than a rewrite: if twitterapi.io
 * disappears, or posting moves elsewhere, one constructor argument changes and no business
 * logic moves at all.
 */
export class SplitXClient implements XClient {
  constructor(private reader: XReader, private writer: XWriter) {}

  getAccountSignals(xUserId: string) {
    return this.reader.getAccountSignals(xUserId);
  }
  getRecentMentions(sinceIso: string) {
    return this.reader.getRecentMentions(sinceIso);
  }
  postReply(inReplyToTweetId: string, text: string) {
    return this.writer.postReply(inReplyToTweetId, text);
  }
}

// ---------------------------------------------------------------------------
// READ -- twitterapi.io
// ---------------------------------------------------------------------------

export class TwitterApiIoReader implements XReader {
  constructor(
    private apiKey: string,
    private botHandle: string,
    private baseUrl = 'https://api.twitterapi.io'
  ) {}

  private async get(pathAndQuery: string): Promise<any> {
    if (!this.apiKey) throw new Error('twitterapi.io is not configured: set TWITTERAPI_IO_KEY.');
    const res = await fetch(this.baseUrl + pathAndQuery, { headers: { 'x-api-key': this.apiKey } });
    if (!res.ok) {
      throw new Error(`twitterapi.io ${res.status} on ${pathAndQuery}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }

  async getAccountSignals(xUserId: string): Promise<AccountSignals> {
    const body = await this.get(`/twitter/user/info?userId=${encodeURIComponent(xUserId)}`);
    const u = body?.data ?? body;
    const createdAt = u?.createdAt ?? u?.created_at;
    const followers = u?.followers ?? u?.followers_count ?? u?.followersCount;

    // validator.ts's anti-Sybil checks run entirely off these two numbers. A response that
    // silently lacked them would make every account look brand new with zero followers --
    // failing closed, but as a flood of baffling rejections rather than something anyone can
    // act on. Name the actual problem instead.
    if (createdAt === undefined || followers === undefined) {
      throw new Error(
        `twitterapi.io returned no account age or follower count for ${xUserId}, so the ` +
          'anti-Sybil checks cannot run. Payload keys: ' + Object.keys(u ?? {}).join(', ')
      );
    }

    return {
      xUserId,
      accountCreatedAt: new Date(createdAt).toISOString(),
      followerCount: Number(followers),
    };
  }

  async getRecentMentions(sinceIso: string): Promise<InboundMention[]> {
    const query = encodeURIComponent(`@${this.botHandle}`);
    const body = await this.get(`/twitter/tweet/advanced_search?query=${query}&queryType=Latest`);
    const tweets: any[] = body?.tweets ?? body?.data ?? [];

    return tweets
      .map((t) => ({
        tweetId: String(t.id ?? t.id_str ?? t.tweet_id ?? ''),
        authorXUserId: String(t.author?.id ?? t.author_id ?? t.userId ?? ''),
        authorHandle: String(t.author?.userName ?? t.author?.username ?? t.username ?? ''),
        text: String(t.text ?? t.full_text ?? ''),
        createdAt: new Date(t.createdAt ?? t.created_at ?? Date.now()).toISOString(),
        inReplyToTweetId: t.inReplyToId ?? t.in_reply_to_status_id ?? null,
      }))
      // Filtered here as well as in the query. The reconciler relies on this window to avoid
      // reprocessing, and a provider that quietly ignored a date filter would otherwise
      // replay history on every sweep -- safe, thanks to the idempotency claim, but wasteful
      // and very confusing to read in logs.
      .filter((m) => m.tweetId && m.authorXUserId && m.createdAt > sinceIso);
  }
}

// ---------------------------------------------------------------------------
// WRITE -- X's own API
// ---------------------------------------------------------------------------

/**
 * Posts as @ponsrdotfun through X's official API, signed with OAuth 1.0a.
 *
 * OAuth 1.0a rather than a bearer token because posting happens *as the account*, which needs
 * user context. The four credentials come from X's developer portal: two identify the app,
 * two identify the account it acts for.
 *
 * The signing is implemented here rather than pulled from a library on purpose. It is forty
 * lines of HMAC, and this is the one credential path that can get the account suspended --
 * fewer dependencies inside it is worth the forty lines.
 */
export class XApiWriter implements XWriter {
  constructor(
    private apiKey: string,
    private apiSecret: string,
    private accessToken: string,
    private accessSecret: string
  ) {}

  private oauthHeader(method: string, url: string): string {
    const params: Record<string, string> = {
      oauth_consumer_key: this.apiKey,
      oauth_nonce: crypto.randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: this.accessToken,
      oauth_version: '1.0',
    };

    const enc = (s: string) =>
      encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

    // The JSON body is deliberately not part of the signature: only form-encoded bodies
    // participate in OAuth 1.0a's base string, and X's v2 endpoints take JSON.
    const paramString = Object.keys(params)
      .sort()
      .map((k) => `${enc(k)}=${enc(params[k])}`)
      .join('&');
    const base = [method.toUpperCase(), enc(url), enc(paramString)].join('&');
    const signingKey = `${enc(this.apiSecret)}&${enc(this.accessSecret)}`;
    params.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');

    return (
      'OAuth ' +
      Object.keys(params)
        .sort()
        .map((k) => `${enc(k)}="${enc(params[k])}"`)
        .join(', ')
    );
  }

  async postReply(inReplyToTweetId: string, text: string): Promise<{ tweetId: string }> {
    if (!this.apiKey || !this.apiSecret || !this.accessToken || !this.accessSecret) {
      throw new Error(
        'X API is not configured: set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET.'
      );
    }
    const url = 'https://api.x.com/2/tweets';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.oauthHeader('POST', url),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: inReplyToTweetId } }),
    });

    if (!res.ok) {
      throw new Error(`X API ${res.status} posting reply: ${(await res.text()).slice(0, 300)}`);
    }
    const body: any = await res.json();
    return { tweetId: String(body?.data?.id ?? '') };
  }
}

/** Builds the production client: twitterapi.io for reads, X's own API for writes. */
export function createXClient(): XClient {
  return new SplitXClient(
    new TwitterApiIoReader(config.TWITTERAPI_IO_KEY ?? '', config.BOT_X_HANDLE),
    new XApiWriter(
      config.X_API_KEY ?? '',
      config.X_API_SECRET ?? '',
      config.X_ACCESS_TOKEN ?? '',
      config.X_ACCESS_TOKEN_SECRET ?? ''
    )
  );
}

/** In-memory mock for tests/local dev. Lets tests configure account age/follower count per
 * user ID so both the "passes anti-Sybil checks" and "rejected by anti-Sybil checks" paths
 * are exercised without a live API. */
export class MockXClient implements XClient {
  public sentReplies: { inReplyToTweetId: string; text: string }[] = [];
  /** Mentions the poll will return. Tests set these to stand in for deliveries
   *  the webhook never made. */
  public recentMentions: InboundMention[] = [];
  /** When set, the next poll rejects -- used to prove an unreachable X API
   *  neither crashes the loop nor advances the watermark past unseen mentions. */
  public failNextPoll: Error | null = null;
  private accounts = new Map<string, AccountSignals>();

  registerAccount(xUserId: string, signals: AccountSignals) {
    this.accounts.set(xUserId, signals);
  }

  async getRecentMentions(sinceIso: string): Promise<InboundMention[]> {
    if (this.failNextPoll) {
      const err = this.failNextPoll;
      this.failNextPoll = null;
      throw err;
    }
    return this.recentMentions.filter((m) => m.createdAt > sinceIso);
  }

  async postReply(inReplyToTweetId: string, text: string): Promise<{ tweetId: string }> {
    this.sentReplies.push({ inReplyToTweetId, text });
    return { tweetId: `mock-reply-${this.sentReplies.length}` };
  }

  async getAccountSignals(xUserId: string): Promise<AccountSignals> {
    const found = this.accounts.get(xUserId);
    if (found) return found;
    // Sensible default for tests that don't care about anti-Sybil specifics: an
    // account old enough and popular enough to pass the default thresholds.
    return { xUserId, accountCreatedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(), followerCount: 100 };
  }
}
