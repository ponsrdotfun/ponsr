import { crossCheckMentions, __resetCrossCheckCache } from '../src/mentionCrossCheck';

/**
 * The failure this guards against is silence that looks like silence: the sweep
 * succeeds, returns nothing, and every launch request is dropped without a trace.
 * On 2026-08-12 twitterapi.io's search did not index a real mention while X's own
 * timeline returned it, so these tests fix the comparison that catches it.
 */

const HOUR = 3600_000;
const NOW = new Date('2026-08-12T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - HOUR).toISOString();
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();

function fakeFetch(routes: Record<string, { ok?: boolean; status?: number; body: any }>) {
  return (async (url: any) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    const r = key ? routes[key] : { ok: false, status: 404, body: {} };
    return {
      ok: r.ok !== false,
      status: r.status ?? 200,
      json: async () => r.body,
    } as any;
  }) as typeof fetch;
}

function deps(processed: string[], routes: any) {
  return {
    db: { isTweetProcessed: (id: string) => processed.includes(id) } as any,
    bearerToken: 'BEARER',
    botHandle: 'ponsrdotfun',
    fetchImpl: fakeFetch(routes),
  };
}

beforeEach(() => __resetCrossCheckCache());

describe('crossCheckMentions', () => {
  const userRoute = { 'users/by/username': { body: { data: { id: '999' } } } };

  it('reports nothing when every mention X shows was handled', async () => {
    const r = await crossCheckMentions(
      deps(['1', '2'], {
        ...userRoute,
        '/mentions': { body: { data: [{ id: '1', created_at: OLD }, { id: '2', created_at: OLD }] } },
      }),
      NOW
    );
    expect(r.missed).toEqual([]);
    expect(r.checked).toBe(2);
  });

  // The whole point: X can see a mention the sweep never delivered.
  it('reports a mention X shows that the bot never handled', async () => {
    const r = await crossCheckMentions(
      deps(['1'], {
        ...userRoute,
        '/mentions': { body: { data: [{ id: '1', created_at: OLD }, { id: '2', created_at: OLD }] } },
      }),
      NOW
    );
    expect(r.missed).toEqual(['2']);
  });

  // A mention seconds old has not had time to reach the sweep. Reporting it would
  // page someone about a race the bot is about to win on its own.
  it('ignores mentions too fresh for the sweep to have seen', async () => {
    const r = await crossCheckMentions(
      deps([], { ...userRoute, '/mentions': { body: { data: [{ id: '9', created_at: FRESH }] } } }),
      NOW
    );
    expect(r.missed).toEqual([]);
  });

  it('reports an error rather than a false all-clear when X refuses', async () => {
    const r = await crossCheckMentions(
      deps([], { ...userRoute, '/mentions': { ok: false, status: 429, body: {} } }),
      NOW
    );
    expect(r.error).toContain('429');
    expect(r.missed).toEqual([]);
  });

  it('reports an error when the handle cannot be resolved', async () => {
    const r = await crossCheckMentions(
      deps([], { 'users/by/username': { ok: false, status: 401, body: {} } }),
      NOW
    );
    expect(r.error).toContain('401');
  });

  // An empty timeline is a real all-clear, not a failure: nobody tweeted.
  it('treats an empty timeline as agreement, not as a fault', async () => {
    const r = await crossCheckMentions(
      deps([], { ...userRoute, '/mentions': { body: {} } }),
      NOW
    );
    expect(r.error).toBeUndefined();
    expect(r.checked).toBe(0);
    expect(r.missed).toEqual([]);
  });

  it('never throws when the network does', async () => {
    const d = {
      db: { isTweetProcessed: () => false } as any,
      bearerToken: 'B',
      botHandle: 'h',
      fetchImpl: (async () => {
        throw new Error('ENOTFOUND api.x.com');
      }) as any,
    };
    await expect(crossCheckMentions(d, NOW)).resolves.toMatchObject({ missed: [] });
  });
});
