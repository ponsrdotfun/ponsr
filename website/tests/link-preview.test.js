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

test('the on-demand card refuses an address the canonical feed cannot verify', () => {
  const fn = read('netlify/functions/token-card.mjs');
  // Drawing a card is an assertion that this is a real Ponsr launch.
  assert.match(fn, /if \(!launch\) return new Response\('Not found', \{ status: 404 \}\)/);
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
