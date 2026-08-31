/**
 * A SHARED TOKEN LINK MUST UNFURL AS THE TOKEN.
 *
 * Measured on production an hour after Microduck launched: pasting its address
 * link showed "Inspect a Ponsr launch", the generic site card, and no mention of
 * the token. Two separate defects sat behind that.
 *
 *   1. A token launched since the last build falls to the catch-all route, whose
 *      metadata is generic by construction. Crawlers do not run JavaScript, so
 *      the page rendering correctly for humans changed nothing for the preview.
 *
 *   2. `og:image` pointed at `https://main--ponsr.netlify.app/...` on the LIVE
 *      site. The build preferred `DEPLOY_PRIME_URL` over `URL`, and Netlify sets
 *      both on a production deploy -- so every live page advertised its card on
 *      a branch subdomain.
 *
 * These pin the fixes at the level a crawler actually sees.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const PSTONKS = '0x7803f37e0db73105c47d5a5f3d054a0ae47e2199';

test('production never advertises a preview domain for its social cards', () => {
  const build = read('scripts/build-website.mjs');
  // CONTEXT is the field that answers "is this the live site", and it must be
  // what decides. Preferring DEPLOY_PRIME_URL unconditionally was the defect.
  assert.match(build, /process\.env\.CONTEXT === 'production'/);
  assert.match(build, /\?\s*process\.env\.URL \|\| process\.env\.DEPLOY_PRIME_URL/);

  for (const file of ['website/index.html', `website/token/${PSTONKS}/index.html`]) {
    const html = read(file);
    const image = html.match(/property="og:image" content="([^"]+)"/)?.[1] ?? '';
    assert.ok(image, `${file} has no og:image`);
    assert.doesNotMatch(image, /netlify\.app/, `${file} advertises a Netlify domain`);
  }
});

test('every built token page carries its own card, not the site card', () => {
  const html = read(`website/token/${PSTONKS}/index.html`);
  const image = html.match(/property="og:image" content="([^"]+)"/)?.[1] ?? '';
  assert.match(image, new RegExp(`token-${PSTONKS}\\.png$`));
  assert.ok(fs.existsSync(path.join(root, 'website/social', `token-${PSTONKS}.png`)));
  // A card is a PNG because X does not render SVG previews.
  assert.match(html, /property="og:image:type" content="image\/png"/);
});

test('the card design has ONE author, shared by the build and the endpoint', () => {
  const build = read('scripts/build-website.mjs');
  const fn = read('netlify/functions/token-card.mjs');
  assert.match(build, /from '\.\.\/netlify\/functions\/lib\/socialCard\.mjs'/);
  assert.match(fn, /from '\.\/lib\/socialCard\.mjs'/);
  // A second local copy is how a link's preview would start changing between
  // deploys for no visible reason.
  assert.doesNotMatch(build, /function socialSvg\(/);
  assert.doesNotMatch(fn, /function tokenCardSvg\(/);
});

test('the token card draws the symbol, name, pair and contract — and no price', async () => {
  const { tokenCardSvg } = await import('../../netlify/functions/lib/socialCard.mjs');
  const svg = tokenCardSvg({
    symbol: 'MICRODUCK',
    name: 'Microduck',
    pairLabel: 'NVDA',
    address: '0xC9158abf265aa26766154269f9B3d417f7771D0A',
  });
  assert.match(svg, /\$MICRODUCK/);
  assert.match(svg, /Microduck/);
  assert.match(svg, /NVDA/);
  assert.match(svg, /0xC9158abf…f7771D0A/);
  assert.match(svg, /LAUNCHED VIA PONSR/);
  // Nothing on the card may read as market data.
  assert.doesNotMatch(svg, /price|market cap|\$\d|%/i);
});

test('hostile token metadata cannot escape the card', async () => {
  const { tokenCardSvg } = await import('../../netlify/functions/lib/socialCard.mjs');
  const svg = tokenCardSvg({
    symbol: '"><script>alert(1)</script>',
    name: '<img src=x onerror=alert(2)>',
    pairLabel: "' onload='alert(3)",
    address: '0x' + 'a'.repeat(40),
  });
  assert.doesNotMatch(svg, /<script>/);
  assert.doesNotMatch(svg, /<img src=x/);
  assert.doesNotMatch(svg, /onload='alert/);
  // The symbol is upper-cased before escaping, so match case-insensitively:
  // the point is that the angle brackets are entities, not that they are lower case.
  assert.match(svg, /&lt;script&gt;/i);
  assert.doesNotMatch(svg, /<[a-z]+[^>]*>(?![\s\S]*<\/svg>)/i);
});

test('a long symbol is trimmed rather than allowed to overrun the card', async () => {
  const { tokenCardSvg } = await import('../../netlify/functions/lib/socialCard.mjs');
  const svg = tokenCardSvg({ symbol: 'A'.repeat(40), name: 'B'.repeat(80), address: '0x' + 'c'.repeat(40) });
  const ticker = svg.match(/>\$([^<]+)</)?.[1] ?? '';
  assert.ok(ticker.length <= 12, `ticker was ${ticker.length} characters`);
  assert.match(ticker, /…$/);
});

test('the divider is drawn in user space, where a horizontal gradient survives', async () => {
  const source = read('netlify/functions/lib/socialCard.mjs');
  // A horizontal line has a zero-height bounding box, so an objectBoundingBox
  // gradient collapses across it and the rule renders as nothing.
  assert.match(source, /id="rule" gradientUnits="userSpaceOnUse"/);
  assert.doesNotMatch(source, /stroke="url\(#rule\)"/);
});

test('the on-demand card refuses an address the chain cannot verify', () => {
  const fn = read('netlify/functions/token-card.mjs');
  // Drawing a card is an assertion that this is a real Ponsr launch.
  assert.match(fn, /if \(!launch\) return new Response\('Not found', \{ status: 404, headers: trace \}\)/);
  assert.match(fn, /ADDRESS\.test\(address\)/);
  assert.match(fn, /content-type': 'image\/png'/);
});

test('the edge function rewrites metadata only for a verified launch', () => {
  const edge = read('netlify/edge-functions/token-meta.js');
  assert.match(edge, /if \(!launch\) return response;/, 'an unverified address must pass through untouched');
  assert.match(edge, /config = \{ path: '\/token\/\*' \}/);
  for (const tag of ['og:title', 'og:description', 'og:image', 'og:url', 'twitter:image']) {
    assert.ok(edge.includes(tag), `${tag} is not rewritten`);
  }
  // Content is escaped before it reaches an attribute.
  assert.match(edge, /\$\{esc\(content\)\}/);
  // The DESCRIPTION it publishes must carry no market claim. Scoped to the
  // template rather than the file, because the file's own comment explains why.
  const description = edge.match(/const description =([\s\S]*?);/)?.[1] ?? '';
  assert.ok(description, 'the description template was not found');
  assert.doesNotMatch(description, /market cap|price|valuation|holders|volume/i);
});

test('the card endpoint is routed and its native dependency is declared', () => {
  const config = read('netlify.toml');
  assert.match(config, /from = "\/social\/token\/\*"/);
  assert.match(config, /to = "\/\.netlify\/functions\/token-card\/:splat"/);
  assert.match(config, /external_node_modules = \["sharp"\]/);
  // sharp is needed at RUNTIME by the function, so it cannot be a dev dependency.
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies.sharp, 'sharp must be a runtime dependency');
  assert.ok(!pkg.devDependencies?.sharp, 'sharp must not also be a dev dependency');
});

/* --------------------------------------------------------------------------
 * THE RENDERER MUST CARRY ITS OWN FONTS.
 *
 * The first deployed card drew every character as a tofu box. Netlify's build
 * container ships fonts; its Lambda runtime ships none, so identical code
 * produced a correct card in one place and an unreadable one in the other. It
 * was invisible in the source and invisible in the tests — only fetching the
 * deployed image and looking at it found it.
 * -------------------------------------------------------------------------- */
test('the card faces are vendored, with their licences beside them', () => {
  const dir = path.join(root, 'assets/fonts');
  const files = fs.readdirSync(dir);
  for (const face of ['JetBrainsMono-Regular.ttf', 'Lora-Regular.ttf', 'InstrumentSans-Bold.ttf']) {
    assert.ok(files.includes(face), `${face} is not vendored`);
  }
  // Shipping a face means shipping its licence.
  for (const licence of ['JetBrainsMono-OFL.txt', 'Lora-OFL.txt', 'InstrumentSans-OFL.txt']) {
    assert.ok(files.includes(licence), `${licence} is missing`);
    assert.match(read(`assets/fonts/${licence}`), /SIL OPEN FONT LICENSE/i);
  }
});

test('both renderers point fontconfig at those faces before drawing', () => {
  const build = read('scripts/build-website.mjs');
  const fn = read('netlify/functions/token-card.mjs');
  const fonts = read('netlify/functions/lib/fonts.mjs');
  assert.match(build, /useVendoredFonts\(\)/);
  assert.match(fn, /useVendoredFonts\(\)/);
  // fontconfig reads its configuration once, when the rasteriser initialises.
  assert.match(fonts, /FONTCONFIG_FILE/);
  // A card nobody can read is worse than no card: the endpoint must refuse.
  assert.match(fn, /if \(!fontsReady\) return new Response\('Card fonts unavailable', \{ status: 503 \}\)/);
});

test('the card names the vendored faces first, not the host\u2019s', async () => {
  const { tokenCardSvg } = await import('../../netlify/functions/lib/socialCard.mjs');
  const svg = tokenCardSvg({ symbol: 'X', name: 'Y', pairLabel: 'native ETH', address: '0x' + '1'.repeat(40) });
  assert.match(svg, /JetBrains Mono/);
  assert.match(svg, /Lora/);
  assert.match(svg, /Instrument Sans/);
  // A bare generic family is what resolved to a serif in the build container.
  assert.doesNotMatch(svg, /font-family="monospace"/);
});

/* --------------------------------------------------------------------------
 * THE PAIR ASSET IS NAMED, NOT SHRUGGED AT.
 *
 * The launch event carries only the pair token's address, so every non-ETH
 * launch published `pairLabel: 'approved token'` — and Microduck's card said
 * "PAIRED WITH approved token" when the answer was NVDA. What a token trades
 * against is the most consequential fact on the card, and the asset's own
 * contract will say what it is called.
 *
 * The read is deliberately timid: a wrong ticker is a financial claim, while
 * the generic label is at least true.
 * -------------------------------------------------------------------------- */
const symbolCall = (value) => {
  const bytes = Buffer.from(value, 'utf8');
  const body = bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64 || 64, '0');
  return `0x${(32).toString(16).padStart(64, '0')}${bytes.length.toString(16).padStart(64, '0')}${body}`;
};

test('the pair asset is read from its own contract', async () => {
  const { collectPairSymbol } = await import('../../netlify/functions/lib/collector.mjs');
  const asked = [];
  const rpc = async (method, params) => {
    asked.push({ method, to: params[0].to, data: params[0].data });
    return symbolCall('NVDA');
  };
  const symbol = await collectPairSymbol({
    rpc, pairToken: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', blockNumber: 47693658,
  });
  assert.equal(symbol, 'NVDA');
  // Asked the PAIR asset, not the launched token, using symbol()'s selector.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].to.toLowerCase(), '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec');
  assert.equal(asked[0].data, '0x95d89b41');
});

test('an unreadable or implausible pair symbol is never guessed at', async () => {
  const { collectPairSymbol } = await import('../../netlify/functions/lib/collector.mjs');
  const at = (rpc) => collectPairSymbol({ rpc, pairToken: '0x' + 'd'.repeat(40), blockNumber: 1 });

  assert.equal(await at(async () => { throw new Error('RPC HTTP 503'); }), null, 'a refusal must not become a label');
  assert.equal(await at(async () => '0x'), null, 'empty return data must not become a label');
  // A bytes32 symbol is not an ABI string, and must not be read as one.
  assert.equal(await at(async () => `0x${Buffer.from('NVDA').toString('hex').padEnd(64, '0')}`), null);
  // Nothing that could carry markup or a sentence reaches a card.
  assert.equal(await at(async () => symbolCall('<script>alert(1)</script>')), null);
  assert.equal(await at(async () => symbolCall('a pretty long marketing name')), null);
});

test('the native pair is answered without asking the chain', async () => {
  const { collectPairSymbol } = await import('../../netlify/functions/lib/collector.mjs');
  const rpc = async () => { throw new Error('the zero address is not a contract'); };
  assert.equal(await collectPairSymbol({ rpc, pairToken: '0x' + '0'.repeat(40), blockNumber: 1 }), null);
});

test('the feed labels a launch with the asset it is actually paired with', () => {
  const feed = read('netlify/functions/launch-feed.mjs');
  // Read once per distinct asset: many launches share a pair.
  assert.match(feed, /pairSymbols\.has\(key\)/);
  assert.match(feed, /if \(pairSymbol\) withMetadata = \{ \.\.\.withMetadata, pairLabel: pairSymbol \}/);
});

test('an unverifiable card is a retry, never a permanent absence', () => {
  const fn = read('netlify/functions/token-card.mjs');
  // Measured on the deploy preview: six consecutive requests for a token that
  // plainly exists returned 404, the next six returned 200. A crawler reads a
  // 404 as "there is no image", fetches once, and does not come back.
  assert.match(fn, /if \(!answered\)/);
  assert.match(fn, /status: 503/);
  assert.match(fn, /'cache-control': 'no-store'/);
  // The two outcomes must come from different branches, not one collapsed test.
  assert.match(fn, /answered: false/);
  assert.match(fn, /answered: true/);
});

test('the card resolves the launch from the chain, not from another function', () => {
  const fn = read('netlify/functions/token-card.mjs');
  // A function calling a function through the CDN pays a second cold start.
  // The established path is the one market-data and what-if already take.
  assert.match(fn, /resolveVerifiedLaunch\(\{ rpc, snapshot, token: address, head \}\)/);
  assert.doesNotMatch(fn, /fetch\(new URL\('\/\.netlify\/functions/);
  // The event names neither the token nor its pair, and a card reading
  // "$UNKNOWN / Metadata unavailable" is worse than asking the crawler back.
  assert.match(fn, /collectTokenMetadata\(\{ rpc, token: launch\.token/);
  assert.match(fn, /collectPairSymbol\(\{ rpc, pairToken: launch\.pairToken/);
  // Both reads sit INSIDE the try: an unreadable name must reach the 503
  // branch, not be swallowed into a card nobody can read.
  const body = fn.slice(fn.indexOf('async function findLaunch'), fn.indexOf('export default'));
  // A doesNotMatch against an empty slice passes while proving nothing.
  assert.ok(body.includes('collectTokenMetadata'), 'the resolver body was not located');
  assert.doesNotMatch(body, /collectTokenMetadata[\s\S]*?\.catch\(/);
  // Every chain read shares one budget, as market-data does.
  assert.match(fn, /RPC_BUDGET_MS/);
});

test('the card says which path answered, in a fixed vocabulary', () => {
  const fn = read('netlify/functions/token-card.mjs');
  // Two builds of this endpoint were externally indistinguishable while one of
  // them was wrong, so diagnosis came down to guessing. Every response now
  // names its branch.
  assert.match(fn, /'x-ponsr-card-source'/);
  for (const via of ["via: 'snapshot'", "'chain:recent'", "'chain:full'", "'unread:discovery'", "'unread:rpc'"]) {
    assert.ok(fn.includes(via), `${via} is not published`);
  }
  // Never the error's own words: publishing String(err.message) is how this
  // repository leaked an internal path from /status/core.
  assert.doesNotMatch(fn, /via: `[^`]*\$\{[^}]*error/);
  assert.doesNotMatch(fn, /error\?\.message/);
});

/* --------------------------------------------------------------------------
 * A SCAN THAT DID NOT COMPLETE CONCLUDES NOTHING.
 *
 * Measured on production: the committed snapshot was two days old, so launch
 * discovery covered 1 547 782 blocks. The feed took 25.5 s, returned `partial`,
 * and a token that plainly exists dropped out of the list entirely. The card,
 * resolving the same way, answered 503 to every request.
 *
 * The distance grows every day the snapshot is not refreshed, so an unbounded
 * scan on a request path is a defect with a date on it.
 * -------------------------------------------------------------------------- */
test('the card looks in a bounded recent window before scanning everything', () => {
  const fn = read('netlify/functions/token-card.mjs');
  assert.match(fn, /RECENT_WINDOW_BLOCKS/);
  assert.match(fn, /head - RECENT_WINDOW_BLOCKS/);
  // The window is tried FIRST, and the full scan remains as the fallback.
  const body = fn.slice(fn.indexOf('async function findLaunch'), fn.indexOf('export default'));
  assert.ok(body.includes('fromRecentWindow'), 'the resolver body was not located');
  assert.ok(
    body.indexOf('fromRecentWindow') < body.indexOf('resolveVerifiedLaunch'),
    'the cheap window must be tried before the full scan'
  );
});

test('a window that did not complete never answers "no such token"', () => {
  const fn = read('netlify/functions/token-card.mjs');
  const window = fn.slice(fn.indexOf('async function fromRecentWindow'), fn.indexOf('export default'));
  assert.ok(window.includes('collectLaunches'), 'the window body was not located');
  // A partial range proves nothing: the token may sit in the part that failed.
  assert.match(window, /if \(observed\.state !== 'complete'\) return null;/);
  // And a miss in the window must fall through to the full scan, not to a 404.
  assert.match(fn, /if \(!launch\) \{\s+via = 'chain:full';/);
});

/* --------------------------------------------------------------------------
 * THE TOKEN'S OWN PICTURE, AND THE RULES THAT COME WITH FETCHING ONE.
 *
 * A launch carries the photo attached to the tweet that asked for it, so a card
 * can show what the token is rather than the same robot a hundred times. But
 * this is a server fetching a picture somebody else chose, so the narrowing is
 * not decoration.
 * -------------------------------------------------------------------------- */
const okImage = (bytes, type = 'image/png') => ({
  ok: true,
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : null) },
  arrayBuffer: async () => bytes,
});

test('only a pbs.twimg.com photo is ever fetched', async () => {
  const { tokenArtDataUri } = await import('../../netlify/functions/lib/tokenArt.mjs');
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    throw new Error('should not have been called');
  };
  for (const hostile of [
    'https://evil.example/media/x.png',
    'http://pbs.twimg.com/media/x.png',
    'https://pbs.twimg.com@evil.example/media/x.png',
    'https://pbs.twimg.com:8080/media/x.png',
    'https://pbs.twimg.com/media/../../etc/passwd',
    'https://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
    null,
    '',
  ]) {
    assert.equal(await tokenArtDataUri(hostile, { fetchImpl }), null, `${hostile} was not refused`);
  }
  // The point is not only the null: nothing left the process at all.
  assert.deepEqual(asked, [], `a request was made to ${asked.join(', ')}`);
});

test('a redirect is refused rather than followed', async () => {
  const { tokenArtDataUri } = await import('../../netlify/functions/lib/tokenArt.mjs');
  let options = null;
  const fetchImpl = async (_url, opts) => {
    options = opts;
    return okImage(new Uint8Array([0]).buffer);
  };
  await tokenArtDataUri('https://pbs.twimg.com/media/AbC123.jpg', { fetchImpl });
  // An allow-list on the URL means nothing if the host may forward the request.
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal, 'the request is not bounded in time');
});

test('anything that is not a picture, or is too big, draws no art', async () => {
  const { tokenArtDataUri } = await import('../../netlify/functions/lib/tokenArt.mjs');
  const url = 'https://pbs.twimg.com/media/AbC123.png';
  const cases = [
    ['not ok', async () => ({ ok: false, headers: { get: () => 'image/png' }, arrayBuffer: async () => new ArrayBuffer(4) })],
    ['html served as an image', async () => okImage(new ArrayBuffer(4), 'text/html')],
    ['declared oversize', async () => ({
      ok: true,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/png' : '99999999') },
      arrayBuffer: async () => new ArrayBuffer(4),
    })],
    ['empty body', async () => okImage(new ArrayBuffer(0))],
    ['undecodable bytes', async () => okImage(Buffer.from('this is not an image').buffer)],
    ['the request throws', async () => { throw new Error('ECONNRESET'); }],
  ];
  for (const [label, fetchImpl] of cases) {
    assert.equal(await tokenArtDataUri(url, { fetchImpl }), null, `${label} produced art`);
  }
});

test('the bytes on the card are re-encoded, never passed through', async () => {
  const { tokenArtDataUri } = await import('../../netlify/functions/lib/tokenArt.mjs');
  const sharp = (await import('sharp')).default;
  const jpeg = await sharp({ create: { width: 64, height: 40, channels: 3, background: '#2E9A67' } })
    .jpeg()
    .toBuffer();
  const art = await tokenArtDataUri('https://pbs.twimg.com/media/AbC123.jpg', {
    fetchImpl: async () => okImage(jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength), 'image/jpeg'),
  });
  assert.ok(art, 'a valid photo produced no art');
  // A JPEG went in; what comes out is a PNG this process wrote, at the card's
  // own size -- so nothing rides along inside a file claiming to be a picture.
  assert.match(art.href, /^data:image\/png;base64,/);
  const out = await sharp(Buffer.from(art.href.split(',')[1], 'base64')).metadata();
  // 64x40 scaled to fit, and NOT squared off: the proportions are the source's.
  assert.equal(out.width, 320);
  assert.equal(out.height, 200);
});

test('the card draws the token portrait, and falls back to the robot', async () => {
  const { tokenCardSvg } = await import('../../netlify/functions/lib/socialCard.mjs');
  const base = { symbol: 'DUCK', name: 'Duck', pairLabel: 'NVDA', address: '0x' + 'a'.repeat(40) };
  const artHref = `data:image/png;base64,${'AAAA'}`;

  const withArt = tokenCardSvg({ ...base, mascotHref: 'data:image/png;base64,ROBOT', artHref });
  assert.match(withArt, /clip-path="url\(#art\)"/, 'the portrait is not masked');
  assert.ok(withArt.includes(artHref), 'the token art is not drawn');
  assert.ok(!withArt.includes('ROBOT'), 'the robot is drawn beside the token art');

  const withoutArt = tokenCardSvg({ ...base, mascotHref: 'data:image/png;base64,ROBOT' });
  assert.ok(withoutArt.includes('ROBOT'), 'a launch with no image lost its robot');
  assert.doesNotMatch(withoutArt, /clip-path="url\(#art\)"/);
});

test('an art reference that is not our own encoding is not drawn', async () => {
  const { tokenCardSvg } = await import('../../netlify/functions/lib/socialCard.mjs');
  const base = { symbol: 'DUCK', name: 'Duck', address: '0x' + 'a'.repeat(40) };
  for (const hostile of [
    'https://evil.example/x.png',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'x" onload="alert(1)',
    'data:image/png;base64,AAA" href="https://evil.example/x.png',
    'javascript:alert(1)',
  ]) {
    const svg = tokenCardSvg({ ...base, artHref: hostile });
    assert.doesNotMatch(svg, /clip-path="url\(#art\)"/, `${hostile} was drawn`);
    assert.ok(!svg.includes('evil.example'), `${hostile} reached the card`);
    assert.ok(!svg.includes('onload'), `${hostile} reached the card`);
  }
});

test('both renderers ask for the token art', () => {
  const fn = read('netlify/functions/token-card.mjs');
  const build = read('scripts/build-website.mjs');
  assert.match(fn, /artFields\(await tokenArtDataUri\(launch\.logo\)\)/);
  assert.match(build, /artFields\(await tokenArtDataUri\(token\.logo\)\)/);
  // One author for the fetching rules, as for the drawing.
  assert.match(fn, /from '\.\/lib\/tokenArt\.mjs'/);
  assert.match(build, /from '\.\.\/netlify\/functions\/lib\/tokenArt\.mjs'/);
});

test('the frame does not cut the corners off a square picture', async () => {
  const { tokenCardSvg } = await import('../../netlify/functions/lib/socialCard.mjs');
  const svg = tokenCardSvg({ symbol: 'D', name: 'D', address: '0x' + 'a'.repeat(40), artHref: 'data:image/png;base64,AAAA', artAspect: 1 });
  // A circular mask removes the corners of every square picture -- and a
  // meme-coin PFP is square, with its horns and ears in exactly those corners.
  assert.doesNotMatch(svg, /<clipPath id="art"><circle/);
  assert.match(svg, /<clipPath id="art"><rect/);
  // `slice` scales up until the box is full and crops the overflow.
  assert.doesNotMatch(svg, /preserveAspectRatio="xMidYMid slice"/);
  // The divider ran the full width and cut straight through the portrait.
  assert.match(svg, /<rect x="76" y="437" width="769"/);
  // A card with no art keeps the full-width rule it always had.
  assert.match(tokenCardSvg({ symbol: 'D', name: 'D', address: '0x' + 'a'.repeat(40) }), /<rect x="76" y="437" width="1048"/);
});

test('the picture comes back the same picture, only smaller', async () => {
  const { tokenArtDataUri } = await import('../../netlify/functions/lib/tokenArt.mjs');
  const sharp = (await import('sharp')).default;

  const serve = (buffer) => async () => ({
    ok: true,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  });

  for (const [width, height] of [[800, 800], [1600, 900], [1500, 500], [500, 1500], [1024, 768]]) {
    const src = await sharp({ create: { width, height, channels: 3, background: '#e8563f' } }).png().toBuffer();
    const art = await tokenArtDataUri('https://pbs.twimg.com/media/A.png', { fetchImpl: serve(src) });
    assert.ok(art, `${width}x${height} produced no art`);
    const out = await sharp(Buffer.from(art.href.split(',')[1], 'base64')).metadata();

    // No bars: a wide picture stays wide, a tall one stays tall.
    assert.ok(out.width === 320 || out.height === 320, `${width}x${height} was not scaled to the card`);
    assert.ok(out.width <= 320 && out.height <= 320, `${width}x${height} overran the frame`);
    // No stretching: the shape it arrived with is the shape it leaves with.
    const drift = Math.abs(out.width / out.height - width / height);
    assert.ok(drift < 0.02, `${width}x${height} was distorted (aspect drifted by ${drift.toFixed(3)})`);
    // And the reported aspect is the one the card must build its frame from.
    assert.ok(Math.abs(art.aspect - out.width / out.height) < 0.001, 'the reported aspect is not the picture\u2019s');
  }
});

test('the frame is built to the picture, not the picture to the frame', async () => {
  const { tokenCardSvg } = await import('../../netlify/functions/lib/socialCard.mjs');
  const base = { symbol: 'D', name: 'D', address: '0x' + 'a'.repeat(40), artHref: 'data:image/png;base64,AAAA' };
  const box = (svg) => {
    const m = svg.match(/<clipPath id="art"><rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/);
    return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null;
  };

  const square = box(tokenCardSvg({ ...base, artAspect: 1 }));
  assert.equal(square.w, square.h, 'a square picture did not get a square frame');

  const wide = box(tokenCardSvg({ ...base, artAspect: 16 / 9 }));
  assert.ok(Math.abs(wide.w / wide.h - 16 / 9) < 0.05, 'a 16:9 picture did not get a 16:9 frame');

  const tall = box(tokenCardSvg({ ...base, artAspect: 9 / 16 }));
  assert.ok(Math.abs(tall.w / tall.h - 9 / 16) < 0.05, 'a 9:16 picture did not get a 9:16 frame');

  // Every frame stays centred on the same point, so the card does not shift.
  for (const b of [square, wide, tall]) {
    assert.ok(Math.abs(b.x + b.w / 2 - 995) <= 1, 'the frame drifted horizontally');
    assert.ok(Math.abs(b.y + b.h / 2 - 428) <= 1, 'the frame drifted vertically');
    assert.ok(b.y + b.h + 11 < 558, 'the frame crosses the bottom hairline');
  }
});

test('the card cannot outlive the platform that runs it', async () => {
  const fn = read('netlify/functions/token-card.mjs');
  const { TIMEOUT_MS } = await import('../../netlify/functions/lib/tokenArt.mjs');

  // A Netlify synchronous function is cut off at 10 s. This endpoint allowed
  // 20 s of chain reads plus 3.5 s of image fetching -- so a slow chain would
  // have produced Netlify's timeout page instead of our 503 with no-store, and
  // a crawler reads that as the card not existing. The 503 branch was written
  // to prevent exactly that, and it was reachable only through the door nobody
  // was watching.
  const rpc = Number(fn.match(/const RPC_BUDGET_MS = (\d+);/)?.[1]);
  const limit = Number(fn.match(/const PLATFORM_LIMIT_MS = (\d+);/)?.[1]);
  assert.ok(rpc > 0 && limit > 0, 'the budgets are not stated');
  // Rendering needs room after both waits are spent.
  assert.ok(rpc + TIMEOUT_MS + 1500 <= limit, `budgets total ${rpc + TIMEOUT_MS}ms against a ${limit}ms limit`);
});

/* --------------------------------------------------------------------------
 * A MISS IN A CACHED FEED IS NOT AN ANSWER.
 *
 * Measured on a real launch. NOBI went live, the bot replied within seconds, X
 * fetched the preview immediately, and the tweet unfurled as the generic
 * "Inspect a Ponsr launch" -- which X then keeps. The page served the correct
 * metadata minutes later, to nobody.
 *
 * The feed is `max-age=60, stale-while-revalidate=300`, and an ordinary request
 * measured `Age: 170`. So the newest launch was invisible for exactly as long
 * as it mattered most, and this endpoint exists for precisely that moment.
 * -------------------------------------------------------------------------- */
test('a token missing from a STALE cached feed is looked up again, fresh', () => {
  const edge = read('netlify/edge-functions/token-meta.js');

  // A distinct URL is what actually bypasses the CDN.
  assert.match(edge, /target\.searchParams\.set\('fresh'/);
  assert.match(edge, /const cached = await safely\(false\)/);
  assert.match(edge, /if \(!launch && \(cached === null \|\| cached\.ageMs > 45_000\)\)/);

  // Order matters: the cached read is tried first, or every page view pays for
  // an uncached feed.
  assert.ok(
    edge.indexOf('await safely(false)') < edge.indexOf('await safely(true)'),
    'the fresh read is attempted before the cached one'
  );

  // The retry is CONDITIONAL. Retrying every miss would let anyone force an
  // uncached feed -- which does chain discovery -- by requesting
  // /token/<40 random hex> repeatedly.
  assert.match(edge, /ageMs/);

  // Freshness is judged from the feed's own observedAt, not from how old the
  // HTTP response is, and an unparseable timestamp counts as stale.
  assert.match(edge, /Number\.isFinite\(Date\.parse\(body\.observedAt\)\)/);
  assert.match(edge, /: Infinity/);

  // Each read guarded separately: a cached read that times out must not also
  // cancel the fresh one.
  assert.match(edge, /const safely = async \(fresh\) => \{\s*try \{/);

  // The no-store fetch option is not relied on -- this runs on Deno, where an
  // unsupported option throws rather than being ignored.
  assert.doesNotMatch(edge, /cache: *'no-store'/);

  // And an unverified address still passes through untouched.
  assert.match(edge, /if \(!launch\) return response;/);
});
