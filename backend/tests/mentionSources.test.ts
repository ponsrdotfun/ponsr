/**
 * THE BOT WENT DEAF TO A REAL MENTION, AND THIS IS THE MEASUREMENT THAT PROVED IT.
 *
 * On 2026-08-30 the owner tweeted, from an active account, a correctly formed
 * launch request naming @ponsrdotfun. The bot never saw it. Everything reported
 * healthy: the sweep succeeded, read credits were plentiful, the public gate was
 * open, and `processed_tweets` simply never grew.
 *
 * Measured against the live provider, four query forms:
 *
 *   "bitcoin"              20 results, newest 0.2 minutes old  -- index is FRESH
 *   "from:0xburnerr"       20 results, newest four days old
 *   "@ponsrdotfun"         20 results, newest four days old
 *   the tweet's own id      0 results
 *
 * So the provider's index was not stale in general and the author was not
 * blocked: that ONE tweet was absent from `advanced_search`. The distinguishing
 * feature is that it was a reply inside somebody else's thread that merely
 * mentioned the bot, rather than a reply addressed to the bot -- a shape X
 * search routinely declines to surface.
 *
 * `mentionCrossCheck.ts` already knew this could happen. Its own header says the
 * search may "not index a real mention of @ponsrdotfun while X's own mentions
 * timeline returned" it, and it polls that timeline every six hours -- but only
 * to ALERT. Nothing fed those mentions back into the pipeline, so the documented
 * failure mode stayed a documented failure mode.
 *
 * These tests pin the fix: X's own mentions timeline becomes a READING source
 * beside the search, the two are unioned and de-duplicated, and a partial read
 * can never be mistaken for a complete one.
 */
import { InboundMention } from '../src/types';
import {
  PartialMentionCoverageError,
  UnionMentionReader,
  XApiMentionsSource,
} from '../src/mentionSources';

const mention = (over: Partial<InboundMention> = {}): InboundMention => ({
  tweetId: '2094031971076993034',
  authorXUserId: '1122334455',
  authorHandle: '0xburnerr',
  text: '@MEADGod @ponsrdotfun launch this called a Microduck, symbol MICRODUCK pairing with nvidia',
  createdAt: '2026-08-30T11:58:00.000Z',
  photoUrl: null,
  inReplyToTweetId: '2093000000000000000',
  ...over,
});

const source = (mentions: InboundMention[]) => ({
  getRecentMentions: async () => mentions,
});

const failing = (message: string) => ({
  getRecentMentions: async () => {
    throw new Error(message);
  },
});

const primaryOf = (mentions: InboundMention[]) => ({
  ...source(mentions),
  getAccountSignals: async () => ({ followers: 10, accountAgeDays: 400, handle: 'x' }) as any,
  getReadCredits: async () => ({ credits: 1, bonus: 0 }),
});

describe('a mention the search cannot see is still heard', () => {
  it('surfaces a reply in another thread that only the authoritative timeline returned', async () => {
    // Exactly the shape that was lost: search returns nothing, X returns the tweet.
    const reader = new UnionMentionReader(primaryOf([]), [source([mention()])]);
    const got = await reader.getRecentMentions('2026-08-30T11:00:00.000Z');
    expect(got.map((m) => m.tweetId)).toEqual(['2094031971076993034']);
  });

  it('does not process the same mention twice when both sources return it', async () => {
    // `processed_tweets` would refuse the duplicate anyway, but a reader that
    // emits it twice makes every downstream count wrong before it gets there.
    const reader = new UnionMentionReader(primaryOf([mention()]), [source([mention()])]);
    const got = await reader.getRecentMentions('2026-08-30T11:00:00.000Z');
    expect(got).toHaveLength(1);
  });

  it('prefers the richer record when the two sources disagree on detail', async () => {
    // The search result carries a photo; the timeline copy does not. Dropping the
    // photo would silently turn an image launch into a text one.
    const withPhoto = mention({ photoUrl: 'https://pbs.twimg.com/media/AbC123_-x.jpg' });
    const withoutPhoto = mention({ photoUrl: null });
    const reader = new UnionMentionReader(primaryOf([withoutPhoto]), [source([withPhoto])]);
    const [only] = await reader.getRecentMentions('2026-08-30T11:00:00.000Z');
    expect(only.photoUrl).toBe('https://pbs.twimg.com/media/AbC123_-x.jpg');
  });
});

describe('a partial read is never mistaken for a complete one', () => {
  it('reports partial coverage, WITH the mentions it did read, when a secondary fails', async () => {
    const reader = new UnionMentionReader(primaryOf([mention()]), [failing('timeline 503')]);
    await expect(reader.getRecentMentions('2026-08-30T11:00:00.000Z')).rejects.toBeInstanceOf(
      PartialMentionCoverageError
    );
    // The mentions must travel WITH the error. Throwing them away would mean a
    // single flaky secondary stops every launch the primary did see.
    try {
      await reader.getRecentMentions('2026-08-30T11:00:00.000Z');
      throw new Error('expected a partial-coverage error');
    } catch (err) {
      const partial = err as PartialMentionCoverageError;
      expect(partial.mentions.map((m) => m.tweetId)).toEqual(['2094031971076993034']);
      expect(partial.failures[0]).toMatch(/timeline 503/);
    }
  });

  it('fails outright when the PRIMARY fails, so the watermark cannot advance', async () => {
    const reader = new UnionMentionReader(failing('search 500') as any, [source([mention()])]);
    await expect(reader.getRecentMentions('2026-08-30T11:00:00.000Z')).rejects.toThrow(/search 500/);
  });

  it('is a plain complete read when every source answers', async () => {
    const reader = new UnionMentionReader(primaryOf([mention()]), [source([])]);
    await expect(reader.getRecentMentions('2026-08-30T11:00:00.000Z')).resolves.toHaveLength(1);
  });
});

describe('the authoritative timeline source', () => {
  const body = {
    data: [
      {
        id: '2094031971076993034',
        author_id: '1122334455',
        text: '@MEADGod @ponsrdotfun launch this called a Microduck, symbol MICRODUCK pairing with nvidia',
        created_at: '2026-08-30T11:58:00.000Z',
        referenced_tweets: [{ type: 'replied_to', id: '2093000000000000000' }],
        attachments: { media_keys: ['3_1'] },
      },
    ],
    includes: {
      users: [{ id: '1122334455', username: '0xburnerr' }],
      media: [{ media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/AbC123_-x.jpg' }],
    },
  };

  const fetchReturning = (payload: unknown, ok = true, status = 200) =>
    jest.fn(async (url: any) => {
      if (String(url).includes('/users/by/username/')) {
        return { ok: true, status: 200, json: async () => ({ data: { id: '999' } }) } as any;
      }
      return { ok, status, json: async () => payload } as any;
    });

  it('maps the timeline into mentions, including author, reply parent and photo', async () => {
    const src = new XApiMentionsSource('token', 'ponsrdotfun', fetchReturning(body) as any);
    const [m] = await src.getRecentMentions('2026-08-30T11:00:00.000Z');
    expect(m.tweetId).toBe('2094031971076993034');
    expect(m.authorHandle).toBe('0xburnerr');
    expect(m.authorXUserId).toBe('1122334455');
    expect(m.inReplyToTweetId).toBe('2093000000000000000');
    expect(m.photoUrl).toBe('https://pbs.twimg.com/media/AbC123_-x.jpg');
    expect(m.createdAt).toBe('2026-08-30T11:58:00.000Z');
  });

  it('drops a photo that is not a validated X media entity', async () => {
    // Same validator the search path uses. An attacker-controlled host must not
    // reach the launch pipeline just because it arrived on a different route.
    const hostile = JSON.parse(JSON.stringify(body));
    hostile.includes.media[0].url = 'https://evil.example/media/x.jpg';
    const src = new XApiMentionsSource('token', 'ponsrdotfun', fetchReturning(hostile) as any);
    const [m] = await src.getRecentMentions('2026-08-30T11:00:00.000Z');
    expect(m.photoUrl).toBeNull();
  });

  it('asks only for mentions newer than the watermark', async () => {
    const doFetch = fetchReturning(body);
    const src = new XApiMentionsSource('token', 'ponsrdotfun', doFetch as any);
    await src.getRecentMentions('2026-08-30T11:00:00.000Z');
    const called = doFetch.mock.calls.map((c: any[]) => String(c[0])).find((u) => u.includes('/mentions'));
    expect(called).toContain('start_time=2026-08-30T11%3A00%3A00.000Z');
  });

  it('throws rather than returning an empty list when the timeline refuses', async () => {
    // An empty array and a refusal are different answers, and only one of them
    // means "nobody tweeted".
    const src = new XApiMentionsSource('token', 'ponsrdotfun', fetchReturning({}, false, 429) as any);
    await expect(src.getRecentMentions('2026-08-30T11:00:00.000Z')).rejects.toThrow(/429/);
  });

  it('is inert when no bearer token is configured', async () => {
    const doFetch = jest.fn();
    const src = new XApiMentionsSource('', 'ponsrdotfun', doFetch as any);
    await expect(src.getRecentMentions('2026-08-30T11:00:00.000Z')).resolves.toEqual([]);
    expect(doFetch).not.toHaveBeenCalled();
  });
});

/* --------------------------------------------------------------------------
 * A CORRECT SOURCE BESIDE A COMPOSITION THAT IGNORES IT IS WORTH NOTHING.
 *
 * This repository has been bitten by that shape repeatedly: a verdict computed
 * correctly and left out of the exit code, a formatter fixed in one of its two
 * copies, an admission gate that compared a constant to itself. So the wiring
 * gets its own tests, not just the parts.
 * -------------------------------------------------------------------------- */
describe('the production composition actually reads both sources', () => {
  it('builds a union reader carrying the authoritative timeline', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../src/xClient.ts'), 'utf8');
    expect(source).toMatch(/new UnionMentionReader\(/);
    expect(source).toMatch(/new XApiMentionsSource\(config\.X_BEARER_TOKEN/);
    // The search reader must remain the PRIMARY: it is the only one that answers
    // account signals and read credits.
    expect(source).toMatch(/new UnionMentionReader\(\s*search,\s*\[timeline\]\s*\)/);
  });
});

describe('the reconciler holds its watermark when coverage was partial', () => {
  const { reconcileOnce, DEFAULT_RECONCILER_OPTIONS } = require('../src/reconciler');

  const depsWith = (getRecentMentions: () => Promise<InboundMention[]>) => {
    const state = new Map<string, string>();
    const processed = new Set<string>();
    return {
      deps: {
        db: {
          getState: (k: string) => state.get(k) ?? null,
          setState: (k: string, v: string) => void state.set(k, v),
          isTweetProcessed: (id: string) => processed.has(id),
        },
        xClient: { getRecentMentions },
        publicLaunchEnabled: false,
      } as any,
      state,
      processed,
    };
  };

  it('processes what arrived but does NOT advance the watermark', async () => {
    const { deps, state } = depsWith(async () => {
      throw new PartialMentionCoverageError([mention()], ['source 1: timeline 503']);
    });
    const result = await reconcileOnce(deps, DEFAULT_RECONCILER_OPTIONS, new Date('2026-08-30T12:00:00.000Z'));
    // The mention was seen...
    expect(result.polled).toBe(1);
    expect(result.partialCoverage).toEqual(['source 1: timeline 503']);
    // ...and the window stays open so the failed source is read again.
    expect(result.watermarkAdvanced).toBe(false);
    expect(state.get('reconciler:watermark')).toBeUndefined();
  });

  it('advances normally when every source answered', async () => {
    const { deps, state } = depsWith(async () => [mention()]);
    const result = await reconcileOnce(deps, DEFAULT_RECONCILER_OPTIONS, new Date('2026-08-30T12:00:00.000Z'));
    expect(result.watermarkAdvanced).toBe(true);
    expect(state.get('reconciler:watermark')).toBe('2026-08-30T12:00:00.000Z');
    expect(result.partialCoverage).toBeUndefined();
  });

  it('still refuses to advance when the primary itself failed', async () => {
    const { deps, state } = depsWith(async () => {
      throw new Error('search 500');
    });
    const result = await reconcileOnce(deps, DEFAULT_RECONCILER_OPTIONS, new Date('2026-08-30T12:00:00.000Z'));
    expect(result.error).toMatch(/search 500/);
    expect(result.watermarkAdvanced).toBe(false);
    expect(state.get('reconciler:watermark')).toBeUndefined();
  });
});

/* --------------------------------------------------------------------------
 * A BLANK HANDLE IS PERMANENT, SO IT MUST NEVER BE WRITTEN.
 *
 * A first-time launcher's Privy wallet is created write-once with
 * `display_name: ponsr:@<handle>`. The new reading source is the only path that
 * could deliver a mention whose handle did not arrive with it, and correcting a
 * wallet name afterwards needs exactly the provider mutation this project
 * forbids. So the handle is resolved, and the sink refuses to bake a blank.
 * -------------------------------------------------------------------------- */
describe('a handle is never delivered blank', () => {
  const tweetOnly = {
    data: [{ id: '1', author_id: '42', text: 'hi @ponsrdotfun', created_at: '2026-08-30T11:58:00.000Z' }],
    includes: {},
  };

  it('looks the username up when the expansion did not carry it', async () => {
    const doFetch = jest.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/users/by/username/')) return { ok: true, status: 200, json: async () => ({ data: { id: '999' } }) } as any;
      if (u.includes('/mentions')) return { ok: true, status: 200, json: async () => tweetOnly } as any;
      return { ok: true, status: 200, json: async () => ({ data: { id: '42', username: 'recovered' } }) } as any;
    });
    const src = new XApiMentionsSource('token', 'ponsrdotfun', doFetch as any);
    const [m] = await src.getRecentMentions('2026-08-30T11:00:00.000Z');
    expect(m.authorHandle).toBe('recovered');
  });

  it('still delivers the mention when the handle cannot be recovered', async () => {
    // Losing a launch request is worse than an unnamed author.
    const doFetch = jest.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/users/by/username/')) return { ok: true, status: 200, json: async () => ({ data: { id: '999' } }) } as any;
      if (u.includes('/mentions')) return { ok: true, status: 200, json: async () => tweetOnly } as any;
      return { ok: false, status: 404, json: async () => ({}) } as any;
    });
    const src = new XApiMentionsSource('token', 'ponsrdotfun', doFetch as any);
    const [m] = await src.getRecentMentions('2026-08-30T11:00:00.000Z');
    expect(m.tweetId).toBe('1');
    expect(m.authorHandle).toBe('');
  });

  it('never writes `ponsr:@` as a wallet name', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../src/walletResolver.ts'), 'utf8');
    expect(source).toMatch(/xHandle \? `ponsr:@\$\{xHandle\}` : `ponsr:id:\$\{xUserId\}`/);
  });
});
