/**
 * The shared formatters, and the rule that there is only one copy of them.
 *
 * This file exists because of a real defect, not a hypothetical one. The build
 * and the runtime each owned their own formatting; a pluralisation fix landed
 * in the build, and the served page still read "1 sells" because `app.mjs`
 * overwrote the corrected markup with its own string. Fixing both copies would
 * have made the symptom go away and left the cause — two authors for one
 * sentence — in place.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('one is singular, and every other count is not', async () => {
  const { plural } = await import('../assets/format.mjs');
  assert.equal(plural(1, 'sell', 'sells'), '1 sell');
  assert.equal(plural(0, 'sell', 'sells'), '0 sells');
  assert.equal(plural(3, 'buy', 'buys'), '3 buys');
});

test('wei converts through BigInt, so no digit is invented at any magnitude', async () => {
  const { ethFromWei } = await import('../assets/format.mjs');
  assert.equal(ethFromWei('5344697858840480'), '0.005344 ETH');
  assert.equal(ethFromWei('4200000000000000000', 2), '4.2 ETH');
  assert.equal(ethFromWei('0'), '0 ETH');
  assert.equal(ethFromWei('1000000000000000000'), '1 ETH');
  // Above 2^53 a float conversion drifts; BigInt does not.
  assert.equal(ethFromWei('123456789123456789123456789', 18), '123456789.123456789123456789 ETH');
});

test('an observation is never shown without its state and the moment it was read', async () => {
  const { activityLine, reserveRows } = await import('../assets/format.mjs');

  // Not observed is null, so a caller cannot accidentally print a bare number.
  assert.equal(activityLine({ state: 'unavailable' }), null);
  assert.equal(activityLine(undefined), null);
  assert.equal(reserveRows({ reserves: { state: 'unavailable' } }), null);

  const line = activityLine({ state: 'observed', curveBuys: 3, curveSells: 1, observedThroughBlock: 47727489 });
  assert.match(line, /3 buys/);
  assert.match(line, /1 sell\b/);
  assert.match(line, /observed through block 47,727,489/);

  const rows = reserveRows({
    graduationThreshold: '4200000000000000000',
    reserves: {
      state: 'observed',
      realQuoteReserveWei: '5344697858840480',
      graduated: false,
      observedAt: '2026-08-27T20:27:00.000Z',
    },
  });
  const labels = rows.map(([label]) => label);
  assert.ok(labels.includes('Observed at'), 'a reserve figure must carry when it was read');
  assert.ok(labels.includes('Curve status'), 'a reserve figure must carry whether the curve graduated');
  assert.deepEqual(rows.find(([l]) => l === 'Curve status'), ['Curve status', 'On the curve']);
});

test('the build and the browser share the formatters rather than keeping copies', () => {
  const build = read('scripts/build-website.mjs');
  const app = read('website/assets/app.mjs');

  for (const [name, source] of [['build', build], ['app', app]]) {
    assert.match(source, /from '[^']*format\.mjs'/, `${name} must import the shared formatters`);
    // A second local definition is how the two drifted the first time.
    assert.doesNotMatch(source, /(?:const|function)\s+ethFromWei\b/, `${name} redefines ethFromWei`);
    assert.doesNotMatch(source, /(?:const|function)\s+shortAddress\b/, `${name} redefines shortAddress`);
    assert.doesNotMatch(source, /(?:const|function)\s+eventTime\b/, `${name} redefines eventTime`);
    assert.doesNotMatch(source, /(?:const|function)\s+plural\b/, `${name} redefines plural`);
  }
});

test('the formatters return text, never markup, so neither caller can inject', async () => {
  const format = await import('../assets/format.mjs');
  const values = [
    format.shortAddress('<img src=x onerror=alert(1)>'),
    format.plural(1, '<b>sell</b>', 'sells'),
    format.eventTime('not-a-date'),
    format.eventTime(null),
    format.activityLine({ state: 'observed', curveBuys: 1, curveSells: 1, observedThroughBlock: 1 }),
  ];
  // The formatters do not escape — that is the caller's job — but they must not
  // ADD markup of their own, which is what would make escaping insufficient.
  const source = read('website/assets/format.mjs');
  assert.doesNotMatch(source, /<[a-z]+[ >]/i, 'format.mjs must not contain markup');
  for (const value of values) assert.equal(typeof value, 'string');
});

test('an unparseable event time degrades to unavailable instead of throwing', async () => {
  const { eventTime } = await import('../assets/format.mjs');
  // Intl.DateTimeFormat throws RangeError on an invalid Date rather than
  // returning a placeholder, and this runs inside card and token rendering.
  assert.equal(eventTime('not-a-date'), 'Event time unavailable');
  assert.equal(eventTime(''), 'Event time unavailable');
  assert.equal(eventTime(null), 'Event time unavailable');
  assert.equal(eventTime(undefined), 'Event time unavailable');
  assert.match(eventTime('2026-08-27T19:30:30.000Z'), /27 Aug 2026, 19:30 UTC/);
});
