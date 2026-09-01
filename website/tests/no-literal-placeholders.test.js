/**
 * A `${...}` INSIDE A PLAIN QUOTE IS TEXT, AND IT SHIPPED.
 *
 * Three of them were on every live token page on 2026-09-01:
 *
 *     ● BUY ADDS ${UNIT}
 *     ● SELL REMOVES ${UNIT}
 *     Observed ${quoteName(token)}
 *
 * Source: `element('span','buy','● BUY adds ${unit}')`. Single quotes where
 * backticks were meant, so the placeholder never interpolated. `const unit` was
 * in scope the whole time -- nothing was missing except one character, three
 * times.
 *
 * WHY NOTHING CAUGHT IT
 * ---------------------
 * `scripts/build-website.mjs` emits the SAME legend correctly, with
 * `${esc(unit)}` inside a real template literal. The static page was right and
 * the client repainted it wrong, so every test that read the built HTML passed.
 * Fifty-four CSS classes are emitted by both files; this is what drift between
 * two copies of one component looks like.
 *
 * HOW THIS CHECKS IT
 * ------------------
 * A regex cannot do this. `href="${url}"` is a quoted attribute INSIDE a
 * template literal and is perfectly correct -- a pattern match reports 67 of
 * those as hits and buries the three real ones. So this walks the source
 * tracking which kind of quote it is inside, and only flags `${` seen while
 * inside a single- or double-quoted string. Escapes and comments are handled,
 * because a false positive here would train someone to ignore the test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

/**
 * Every `${` that appears inside a plain quoted string, with its line number.
 *
 * Deliberately a scanner rather than a parser: it needs to know string state
 * and nothing else, and a real parser would be a dependency for one property.
 */
function literalPlaceholders(source) {
  const found = [];
  let line = 1;
  let state = 'code'; // code | single | double | template | line-comment | block-comment | regex-ish
  let templateDepth = 0;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '\n') line += 1;

    if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') { state = 'code'; i += 1; }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (ch === '\\') { i += 1; continue; } // an escape consumes the next char
      if (state === 'single' && ch === "'") { state = 'code'; continue; }
      if (state === 'double' && ch === '"') { state = 'code'; continue; }
      if (state === 'template') {
        if (ch === '`') { state = 'code'; continue; }
        // `${` inside a template opens real code again, where quotes are legal.
        if (ch === '$' && next === '{') { templateDepth += 1; state = 'code'; i += 1; }
        continue;
      }
      // Inside a plain quote, a `${` is the defect this test exists for.
      if (ch === '$' && next === '{') found.push({ line, at: source.slice(i, i + 40) });
      continue;
    }

    // state === 'code'
    if (ch === '/' && next === '/') { state = 'line-comment'; i += 1; continue; }
    if (ch === '/' && next === '*') { state = 'block-comment'; i += 1; continue; }
    if (ch === "'") { state = 'single'; continue; }
    if (ch === '"') { state = 'double'; continue; }
    if (ch === '`') { state = 'template'; continue; }
    if (ch === '}' && templateDepth > 0) { templateDepth -= 1; state = 'template'; continue; }
  }
  return found;
}

const SOURCES = [
  'website/assets/app.mjs',
  'website/assets/format.mjs',
  'website/assets/render.mjs',
  'website/assets/claim.mjs',
  'website/assets/feed-model.mjs',
  'website/assets/market-model.mjs',
  'website/assets/data-state.mjs',
  'website/assets/what-if-model.mjs',
  'scripts/build-website.mjs',
  'scripts/refresh-snapshot.mjs',
];

test('no source string carries an uninterpolated ${...}', () => {
  for (const file of SOURCES) {
    const found = literalPlaceholders(fs.readFileSync(path.join(root, file), 'utf8'));
    assert.deepEqual(
      found,
      [],
      `${file} has ${found.length} placeholder(s) in plain quotes: ${found.map((f) => `line ${f.line}: ${f.at}`).join(' | ')}`
    );
  }
});

test('the scanner itself distinguishes the two cases', () => {
  // The real bug.
  assert.equal(literalPlaceholders("element('span','buy','x ${unit}')").length, 1);
  assert.equal(literalPlaceholders('const a = "y ${b}";').length, 1);

  // The shapes that are correct and must never be reported, because a test that
  // cries wolf 67 times is a test nobody reads.
  assert.deepEqual(literalPlaceholders('const a = `x ${b}`;'), []);
  assert.deepEqual(literalPlaceholders('const a = `<a href="${url}">${esc(t)}</a>`;'), []);
  assert.deepEqual(literalPlaceholders("const a = `${x ? 'has' : 'none'}`;"), []);
  assert.deepEqual(literalPlaceholders("const a = `${f(`${g}`)}`;"), [], 'nested templates');
  assert.deepEqual(literalPlaceholders("// a comment with '${x}'"), []);
  assert.deepEqual(literalPlaceholders("/* block with '${x}' */"), []);
  assert.deepEqual(literalPlaceholders("const a = 'it\\'s ${not} real';").length, 1, 'escaped quote');
  assert.deepEqual(literalPlaceholders("const a = 'no placeholder here';"), []);
});

/**
 * The pairing asset is not ETH, and saying so is not cosmetic.
 *
 * Microduck trades against NVDA. The token page said "cumulative ETH movement"
 * and the what-if lab printed amounts as "... ETH" -- the same defect already
 * fixed once in this repository, where `ethFromWei` stamped " ETH" onto every
 * amount and a Microduck sell read as `-0.320168264216621238 ETH` with not one
 * wei of ETH involved.
 */
test('the client never states a quote amount in a hardcoded ETH', () => {
  const app = fs.readFileSync(path.join(root, 'website/assets/app.mjs'), 'utf8');
  assert.doesNotMatch(app, /\}\s*ETH`/, 'an amount interpolated and then labelled ETH');
  assert.doesNotMatch(app, /cumulative ETH movement/);
  // And the unit it uses instead comes from the page, with no default: an
  // absent unit must print no unit rather than a plausible wrong one.
  assert.match(app, /host\.dataset\.quoteUnit/);
  assert.match(app, /quote\s*\?\s*`\$\{value\}\s*\$\{quote\}`\s*:\s*value/);
});
