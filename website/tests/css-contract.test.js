/**
 * A CSS CUSTOM PROPERTY THAT DOES NOT EXIST FAILS SILENTLY.
 *
 * `var(--mint)` was written into four declarations in one sitting. The variable
 * had never existed, so every one of them was invalid and the elements inherited
 * whatever was above them — including a badge meant to say "this data is here",
 * which came out the same colour as one saying it is not.
 *
 * The same audit found `var(--font-sans)`, undefined since it was introduced, so
 * a launchpad card heading had quietly been using the body font all along.
 *
 * Nothing about this fails a build, a test, or a page load. It just looks
 * slightly wrong forever, which is the hardest kind of wrong to notice.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('every CSS custom property used is also defined', () => {
  const css = read('website/assets/site.css');
  const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  // Only the form WITHOUT a fallback. `var(--ex,0px)` is deliberate: those two
  // are set at runtime by the mascot's eye tracking and the fallback is the
  // resting value, so an undefined name there is correct rather than a bug.
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `used but never defined: ${missing.join(', ')}`);
});

test('an absent value is not typeset like a present one', () => {
  const css = read('website/assets/site.css');
  const build = read('scripts/build-website.mjs');

  // `.account-stat strong` is bright silver at the value size, so "Unavailable"
  // arrived in exactly the voice a real figure uses. Four of those on one page
  // is why the fees route read as broken rather than as not-yet.
  assert.match(build, /class="account-stat is-unavailable"/);
  const rule = css.match(/\.account-stat\.is-unavailable strong \{[^}]*\}/)?.[0] ?? '';
  assert.ok(rule, 'the unavailable value has no quieter treatment');
  assert.match(rule, /color:var\(--dim\)/);

  // The reason stays legible: it is what a reader actually needs from an empty box.
  assert.match(css, /\.account-stat\.is-unavailable span \{[^}]*color:var\(--steel\)/);
});

test('the custody boundary reads as a state, not an alert', () => {
  const css = read('website/assets/site.css');
  // It appears on all six account routes and says the same thing each time,
  // about a condition that will not change while you read it. Amber also broke
  // the palette, pulling the eye to the least actionable thing on screen.
  assert.match(css, /\.custody-boundary \{[^}]*border-color:rgba\(70,200,140/);
  // And it held an infinite scanning sweep under a message that never changes.
  assert.match(css, /\.custody-boundary::after \{ display:none; \}/);
});

test('a read-only badge does not wear the unavailable colour', () => {
  const css = read('website/assets/site.css');
  // `.status-readonly` existed in the markup and changed nothing: both badges
  // computed to the same amber, so a panel full of real figures wore the exact
  // appearance of one with none.
  assert.match(css, /\.state-badge\.status-readonly \{[^}]*color:var\(--emerald-bright\)/);
});
