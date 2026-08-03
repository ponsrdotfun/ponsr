import { AccountSignals, InboundMention } from './types';

/**
 * Wraps whatever's needed from twitterapi.io (Part 10: confirmed to support both reading
 * mentions and posting replies from a single provider, at $0.00015/read with no minimum).
 *
 * TODO before Phase 1 (see action-checklist.md):
 *   1. Sign up at twitterapi.io, claim the $1 free trial credit.
 *   2. Replace RealXClient's stub bodies with actual HTTP calls to their REST API (webhook
 *      registration happens separately/out of band -- this class only needs to cover the
 *      "post a reply" and "look up account signals" actions the orchestrator calls
 *      synchronously during request handling).
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

export class RealXClient implements XClient {
  constructor(private apiKey: string) {}

  async postReply(inReplyToTweetId: string, text: string): Promise<{ tweetId: string }> {
    throw new Error('RealXClient.postReply is a stub -- wire up the real twitterapi.io write endpoint. See TODO above.');
  }

  async getAccountSignals(xUserId: string): Promise<AccountSignals> {
    throw new Error('RealXClient.getAccountSignals is a stub -- wire up the real twitterapi.io user-lookup endpoint. See TODO above.');
  }

  async getRecentMentions(sinceIso: string): Promise<InboundMention[]> {
    throw new Error('RealXClient.getRecentMentions is a stub -- wire up the real twitterapi.io mention search/lookup endpoint. See TODO above.');
  }
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
