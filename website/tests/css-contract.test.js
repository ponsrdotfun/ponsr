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

/**
 * THE ACCOUNT LAUNCHES ROUTE HAD NOTHING ON IT ABOUT LAUNCHES.
 *
 * It is honest and empty: it will list launches bound to a signed-in identity,
 * and there is no sign-in yet. But launches are the one subject where the record
 * is completely public, so the page said nothing about the thing it is named
 * after.
 *
 * The panel added is NOT a filtered view and must not imply it is. Someone who
 * launched a token can confirm it is recorded, with the same block and event
 * time anyone else reads, before an account exists to claim it with.
 */
test('the launches route carries the public record, and says that is what it is', () => {
  const build = read('scripts/build-website.mjs');
  const app = read('website/assets/app.mjs');

  assert.match(build, /Public record &middot; no account required/);
  assert.match(build, /route==='\/account\/launches' \? accountLaunches\(\) \+ accountPublicLaunches\(\)/);
  // It must not claim to be scoped to anybody.
  assert.match(build, /The complete current-V2 record, unfiltered/);

  // Newest first: the record a reader came to check is usually the last one made.
  assert.match(app, /launches\.sort\(\(a, b\) => Number\(b\.blockNumber \|\| 0\) - Number\(a\.blockNumber \|\| 0\)\)/);
  // An unavailable feed shows nothing rather than an empty record.
  assert.match(app, /no record is shown rather than an empty one/);
});

test('the wallet route is deliberately left alone', () => {
  const build = read('scripts/build-website.mjs');
  // There is no public record of somebody's embedded wallet, and putting
  // Ponsr's treasury address under a heading that says "your wallet" would be
  // worse than an empty page. Filling it would mean inventing a subject.
  assert.doesNotMatch(build, /function accountWallet\(\)[\s\S]{0,600}?public-launch-rows/);
  assert.doesNotMatch(build, /function accountWallet\(\)[\s\S]{0,600}?data-account-fee-escrow/);
});

/**
 * THE TOKEN LEADS ITS OWN CARD.
 *
 * Measured on the board at a card 190px wide: the token's name was 12.48px at
 * weight 400, while "Market cap unavailable" sat beside it at weight 650. The
 * card's headline was outranked by a line saying a number is missing — the same
 * defect as the account pages, in the one place a reader looks first.
 *
 * The ordering is what is pinned, not the exact numbers: the name is the
 * identity, the metric is data about it, and that holds whether the figure is
 * missing or present.
 */
test('a card\u2019s metric never outranks the token it belongs to', () => {
  const css = read('website/assets/site.css');

  const name = css.match(/\.launchpad-card-body h3 \{[^}]*font-size:\.?([\d.]+)rem/)?.[1];
  assert.ok(name, 'the card name has no size of its own');
  assert.ok(Number(name) >= 0.9, `the token name is ${name}rem, too quiet to lead the card`);

  // The LAST declaration wins in CSS, so the last is the one to read -- the
  // original rule is still in the file, at weight 650, earlier.
  const mcap = [...css.matchAll(/\.launchpad-mcap strong \{[^}]*font-weight:(\d+)/g)].pop()?.[1];
  assert.ok(mcap, 'the card metric has no weight of its own');
  assert.ok(Number(mcap) <= 600, `the metric is weight ${mcap}, heavier than the name it sits under`);
});

test('the board gives a card room before it gives it a column', () => {
  const css = read('website/assets/site.css');
  // Five fixed columns put 8px type in a 190px card. A floor lets the grid
  // choose how many fit, so the art and the name are readable at any width.
  // Read the rule OUTSIDE a media query: the narrow-viewport override that
  // follows it legitimately uses a smaller floor, and matching that instead is
  // how this assertion would pass while testing the wrong breakpoint.
  const wide = [...css.matchAll(/^\.launchpad-grid \{[^}]*\}/gm)].map((m) => m[0]).pop() ?? '';
  assert.ok(wide, 'the board grid has no rule of its own outside a media query');
  assert.match(wide, /repeat\(auto-fill,minmax\(2\d\dpx,1fr\)\)/);

  // The entry animation already existed and ran on every card at once. A capped
  // stagger reads as assembly; an uncapped one makes the last card feel broken.
  assert.match(css, /\.ready \.launchpad-card:nth-child\(n\+6\) \{ animation-delay:\.24s; \}/);
  assert.match(css, /@media \(prefers-reduced-motion:no-preference\)/);
});

/**
 * THE SECURITY PAGE SHOWS SOMETHING A STRANGER CAN CHECK.
 *
 * It carried four "Unavailable" rows and nothing verifiable, on the subject
 * where verifying is the whole point. Those four genuinely wait for a sign-in —
 * identity binding, wallet continuity, session controls, signing authority.
 * These do not: which factory the bot launches through, which escrow credits
 * fees, which address deploys, and whether the public gate is open.
 */
test('the security route publishes boundaries as addresses, not assurances', () => {
  const build = read('scripts/build-website.mjs');
  assert.match(build, /route==='\/account\/security' \? accountSecurity\(\) \+ accountVerifiableNow\(\)/);
  // Named constants, not inlined: a wrong one would be a confident link to the
  // wrong contract.
  assert.match(build, /const ESCROW_ADDRESS = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e'/);
  assert.match(build, /const DEPLOYER_ADDRESS = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa'/);
  // Each is a link to the explorer, or the invitation to check is empty.
  assert.match(build, /href="\$\{EXPLORER\}\/\$\{kind\}\/\$\{esc\(value\)\}"/);
});

test('a gate that could not be read is never drawn as closed', () => {
  const app = read('website/assets/app.mjs');
  // "Closed" is the reassuring answer, so it is the one a guess must never
  // produce. An unread gate says it is unread.
  assert.match(app, /if \(!gate \|\| typeof gate\.enabled !== 'boolean'\)/);
  assert.match(app, /host\.dataset\.gate = 'unknown'/);
  assert.match(app, /none is shown rather than a reassuring guess/);

  const css = read('website/assets/site.css');
  // And it must not inherit the closed colour by omission.
  assert.match(css, /\.verifiable-gate\[data-gate='unknown'\] strong \{ color:var\(--dim\); \}/);
});
