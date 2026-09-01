/**
 * Token pages unfurl as themselves.
 *
 * A crawler reads the HTML and never runs the page's JavaScript, so a token
 * that did not exist when the site was last built unfurled as the catch-all:
 * "Inspect a Ponsr launch", with the generic site card and no mention of the
 * token at all. Measured on Microduck's page an hour after it launched. That is
 * precisely the moment a link gets shared, so it is precisely the moment the
 * preview has to be right.
 *
 * This runs at the edge, takes the page the site would have served anyway, and
 * replaces only the metadata a crawler reads. The visible page is untouched —
 * it already renders the token from the live feed once JavaScript runs.
 *
 * IT NEVER INVENTS A TOKEN. If the canonical feed cannot verify the address,
 * the original response passes through unchanged: a preview is an assertion
 * that this is a real Ponsr launch, and the edge is not the place to decide
 * that.
 */
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

const esc = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Replace one meta tag's content, matching either attribute order. */
function setMeta(html, attr, name, content) {
  const pattern = new RegExp(
    `(<meta[^>]*${attr}=["']${name}["'][^>]*content=["'])([^"']*)(["'])`,
    'i'
  );
  if (pattern.test(html)) return html.replace(pattern, `$1${esc(content)}$3`);
  const reversed = new RegExp(
    `(<meta[^>]*content=["'])([^"']*)(["'][^>]*${attr}=["']${name}["'])`,
    'i'
  );
  return html.replace(reversed, `$1${esc(content)}$3`);
}

export default async (request, context) => {
  const url = new URL(request.url);
  const address = (url.pathname.match(/^\/token\/(0x[a-fA-F0-9]{40})\/?$/i)?.[1] ?? '').toLowerCase();

  const response = await context.next();
  if (!ADDRESS.test(address)) return response;
  if (!(response.headers.get('content-type') ?? '').includes('text/html')) return response;

  /**
   * A MISS IN A CACHED FEED IS NOT AN ANSWER.
   *
   * The feed is served `max-age=60, stale-while-revalidate=300`, so the CDN can
   * hand back a copy several minutes old -- measured at `Age: 170` on an
   * ordinary request. Consulting only that copy meant the newest launch was
   * invisible for exactly as long as it mattered most.
   *
   * That is not hypothetical. NOBI launched, the bot replied within seconds, X
   * fetched the preview immediately, the cached feed did not know the token yet,
   * and the tweet unfurled as the generic "Inspect a Ponsr launch" -- which X
   * then keeps. The page served the right metadata minutes later, to nobody.
   *
   * So a miss is retried once against a fresh feed. The cached copy still
   * answers for every launch that is not brand new, which is nearly all of
   * them; only a miss pays for the second read. An address that is not a Ponsr
   * launch pays it too, and then passes through untouched as before -- the cost
   * of being right about the one case this endpoint exists for.
   */
  const lookup = async (fresh) => {
    const target = new URL('/.netlify/functions/launch-feed', url);
    if (fresh) target.searchParams.set('fresh', Date.now().toString(36));
    // A distinct URL is a distinct cache key -- that alone bypasses the CDN.
    // The fetch no-store option is deliberately NOT used: this runs on Deno at
    // the edge, where an unsupported option throws rather than being ignored.
    const feed = await fetch(target, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(fresh ? 5000 : 3000),
    });
    if (!feed.ok) return null;
    const body = await feed.json();
    if (!Array.isArray(body?.launches)) return null;
    return {
      launch: body.launches.find((l) => String(l.token).toLowerCase() === address) ?? null,
      // How old the ANSWER is, not how old the HTTP response is. An
      // unparseable timestamp counts as stale: it is not evidence of freshness.
      ageMs: Number.isFinite(Date.parse(body.observedAt)) ? Date.now() - Date.parse(body.observedAt) : Infinity,
    };
  };

  // Each read is guarded separately: a cached read that TIMES OUT must not also
  // cancel the fresh one, which is the read that knows about a new launch.
  const safely = async (fresh) => {
    try {
      return await lookup(fresh);
    } catch {
      return null;
    }
  };

  const cached = await safely(false);
  let launch = cached?.launch ?? null;

  /**
   * The second read is CONDITIONAL, and that is not an optimisation.
   *
   * Retrying every miss would mean any request for `/token/<40 random hex>`
   * forces an uncached feed, which does chain discovery -- cheap to ask for and
   * expensive to serve, repeatedly, by anyone who noticed.
   *
   * A miss only deserves a second look when the copy that missed could plausibly
   * predate the launch. If the feed's own `observedAt` is seconds old, its miss
   * is an answer: the address is not a Ponsr launch, and the page passes through
   * as it always did.
   */
  if (!launch && (cached === null || cached.ageMs > 45_000)) {
    launch = (await safely(true))?.launch ?? null;
  }

  if (!launch) return response;

  const canonical = `${url.origin}/token/${address}`;
  const card = `${url.origin}/social/token/${address}.png`;
  const title = `${launch.name} ($${launch.symbol}) — launched via Ponsr`;
  // Only facts the feed carries. No price, no valuation, nothing a reader could
  // mistake for market data.
  const description =
    `${launch.symbol} is a verified current V2 Ponsr launch on Robinhood Chain, ` +
    `paired with ${launch.pairLabel}. Inspect its factory, bonding curve, block and event time.`;

  let html = await response.text();
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
  html = setMeta(html, 'name', 'description', description);
  html = setMeta(html, 'property', 'og:title', title);
  html = setMeta(html, 'property', 'og:description', description);
  html = setMeta(html, 'property', 'og:url', canonical);
  html = setMeta(html, 'property', 'og:image', card);
  html = setMeta(html, 'name', 'twitter:image', card);
  // The catch-all ships noindex because a wildcard route should not be indexed
  // on its own. A verified token is a real page and should be.
  html = html.replace(/<meta[^>]*name=["']robots["'][^>]*>/i, '');
  html = html.replace(
    /(<link[^>]*rel=["']canonical["'][^>]*href=["'])([^"']*)(["'])/i,
    `$1${canonical}$3`
  );

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(html, { status: response.status, headers });
};

export const config = { path: '/token/*' };
