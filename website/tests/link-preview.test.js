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
  for (const via of ["via: 'snapshot'", "via: 'chain'", "'unread:discovery'", "'unread:rpc'"]) {
    assert.ok(fn.includes(via), `${via} is not published`);
  }
  // Never the error's own words: publishing String(err.message) is how this
  // repository leaked an internal path from /status/core.
  assert.doesNotMatch(fn, /via: `[^`]*\$\{[^}]*error/);
  assert.doesNotMatch(fn, /error\?\.message/);
});
