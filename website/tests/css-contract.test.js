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

/**
 * A CARD IS NOT A TEXT LINK.
 *
 * The what-if directory renders each launch as `<a class="token-card">`, and the
 * anchor's own underline is drawn across everything inside it — the name, the
 * symbol, "OPEN LAB →" and the provenance footnote all arrived underlined.
 *
 * Every child computes `text-decoration: none` individually, which is exactly
 * why this survived: inspecting any one of them says the underline is not there,
 * because the line belongs to the anchor rather than to its contents.
 */
test('a card link does not underline its own contents', () => {
  const css = read('website/assets/site.css');
  assert.match(css, /a\.token-card \{ text-decoration:none; \}/);

  // Removing an affordance without replacing it is a different defect, so the
  // hover and focus states have to exist too.
  assert.match(css, /a\.token-card:hover \{[^}]*border-color/);
  assert.match(css, /a\.token-card:focus-visible \{[^}]*outline/);
});

/**
 * NO LOGO IS NOT A BROKEN CARD.
 *
 * The placeholder was a radar pattern, three dots, and the words TOKEN IMAGE
 * UNAVAILABLE across the middle — which reads as a failure every time, on a
 * card whose token is perfectly fine. Two of three launches have no image, so
 * that was most of the board announcing a problem that does not exist.
 *
 * The token's own ticker is the art instead. `.art-symbol` was already styled
 * for exactly this and had simply never been rendered.
 */
test('a launch with no image shows its ticker, not a failure notice', () => {
  /**
   * Asserted at the SHARED model now, and on the built page.
   *
   * This used to read both producers' own copies of the artwork block, because
   * there were two. There is one: `website/assets/cards.mjs`, rendered to a
   * string at deploy time and to DOM nodes in the browser. Reading it once is
   * not weaker -- it is the only place the answer can differ from itself.
   */
  const cards = read('website/assets/cards.mjs');
  assert.match(cards, /art-symbol/, 'the shared model does not draw the ticker');
  assert.doesNotMatch(cards, />Token image unavailable</, 'the failure notice is back on the card');

  // The accessible label is unchanged: a screen reader still learns there is no
  // image. The sighted reader is the one who did not need telling twice.
  assert.match(cards, /'aria-label': `Token image unavailable for/);

  // And the page a visitor actually receives.
  const explore = read('website/explore/index.html');
  assert.match(explore, /class="art-symbol" data-art-len="\d+"/);
  assert.match(explore, /aria-label="Token image unavailable for [A-Z]+"/);
});

test('the ticker is sized without an inline style', () => {
  const css = read('website/assets/site.css');
  const build = read('scripts/build-website.mjs');
  const app = read('website/assets/app.mjs');

  // Measured: at one size a nine-character ticker needed 208px of a 211px box
  // and a twelve-character one needed 256px, so it clipped mid-character —
  // the same ugliness the placeholder replaced, moved one token along.
  // CSS cannot measure text, so the length is published and the stylesheet
  // carries one static rule per length. An inline custom property would have
  // been an inline style, which this site's CSP forbids.
  // One model now, so one assertion. The length is published as a data
  // attribute by `cards.mjs`, and neither renderer can disagree with it.
  const cards = read('website/assets/cards.mjs');
  assert.match(cards, /'data-art-len': String\(Math\.min\(12,/);
  assert.doesNotMatch(cards, /\.style\.setProperty\(['"]--art-len/);
  assert.doesNotMatch(app, /\.style\.setProperty\(['"]--art-len/);
  assert.doesNotMatch(build, /style="[^"]*--art-len/);

  // Plain string matching: a regex built by interpolation reads `[data-art-len]`
  // as a character class, which is how the first version of this assertion threw
  // rather than failed.
  for (const n of [1, 6, 9, 12]) {
    assert.ok(
      css.includes(`.art-symbol[data-art-len='${n}'] { font-size:min(16cqi,`),
      `no rule for a ${n}-character ticker`
    );
  }
  // And a ticker of unusually wide letters ends in an ellipsis rather than being
  // cut through the middle of one.
  assert.match(css, /\.token-art \.art-symbol \{[^}]*text-overflow:ellipsis/);
});

/**
 * THE HEADER SHOULD LOOK LIKE NAVIGATION, NOT LIKE FINE PRINT.
 *
 * Measured at 1440px: the bar is 1180px wide and `space-between`, so the brand
 * sits at one edge and three links at the other with a wide emptiness between.
 * The links were 14.4px at weight 400 — body-copy size, at the edge of the
 * screen — which is why the header read as unfinished.
 *
 * They are a segmented control now. Not a new idea here: the board's own sort
 * tabs are exactly this shape, so the header speaks the language the rest of
 * the site already uses.
 */
test('the nav links are a control, not three loose words', () => {
  const css = read('website/assets/site.css');
  const rule = [...css.matchAll(/^\.nav-links \{[\s\S]*?\}/gm)].pop()?.[0] ?? '';
  assert.ok(rule, 'the nav group has no rule of its own');
  assert.match(rule, /border-radius:999px/);
  assert.match(rule, /border:1px solid var\(--line-soft\)/);

  // Inside a control, an underline under the current item reads as a stray
  // line, so the active page is a filled segment instead.
  // The LAST matching rule wins, and the original one earlier in the file has a
  // selector ending the same way -- matching the first would test the rule this
  // change replaced. That mistake has been made twice in this file already.
  const active = [...css.matchAll(/\.nav-links a\[aria-current="page"\] \{[^}]*\}/g)].pop()?.[0] ?? '';
  assert.ok(active, 'the current page has no segment style');
  assert.match(active, /background:rgba\(70,200,140/);
  assert.match(css, /\.nav-links a\[aria-current="page"\]::after \{ display:none; \}/);

  // Keyboard users lose the underline too, so the focus ring has to be explicit.
  assert.match(css, /\.nav-links a:focus-visible \{[^}]*outline/);
});

/**
 * HERO DEPTH IS SCROLL-DRIVEN, AND MUST NOT COST WHAT IS ALREADY THERE.
 *
 * `animation` is not additive: a second declaration on an element silently
 * replaces the first. `.hero-copy` runs `revealEnter` and `.hero-stage` runs
 * `heroStageBreathe`, so the parallax goes on `.hero-inner`, which carries
 * none — otherwise the robot would quietly stop breathing and nothing would
 * report it.
 *
 * The timeline is the same one the scroll-progress bar already uses here: it
 * runs off the main thread, so it cannot stutter while the page is busy, and it
 * needs no inline style, which this site's CSP forbids.
 */
test('hero parallax sits on an element with no animation of its own', () => {
  const css = read('website/assets/site.css');

  const rule = [...css.matchAll(/\.hero-inner \{[^}]*\}/g)].map((m) => m[0]).join('\n');
  assert.match(rule, /animation: *heroDepth/);
  assert.match(rule, /animation-timeline: *scroll\(root block\)/);

  // Neither of the animated hero elements may be given a competing animation.
  for (const selector of ['.hero-copy', '.hero-stage']) {
    const own = [...css.matchAll(new RegExp(`\${selector} \{[^}]*\}`, 'g'))].map((m) => m[0]).join('\n');
    assert.doesNotMatch(own, /animation: *heroDepth/, `${selector} was given the parallax and would lose its own animation`);
  }

  // Guarded twice: unsupported browsers get nothing rather than a broken hero,
  // and a reader who asked for less motion is not given more.
  const block = css.slice(css.indexOf('@supports (animation-timeline: scroll())'));
  assert.match(block.slice(0, 200), /@media \(prefers-reduced-motion: no-preference\)/);
});

/**
 * THE WHITE FLASH HAD A CAUSE, AND IT WAS NOT THE TRANSITION.
 *
 * Measured: `body` was rgb(5,6,7) but `html` was transparent, so the browser
 * painted its own canvas — white — for the moment before the page's background
 * existed. Every navigation flashed, and no transition could have covered it,
 * because the flash happens before any of that runs.
 *
 * `color-scheme: dark` is the part that does the work: the canvas is dark from
 * the first frame, and scrollbars stop being light furniture on a dark page.
 */
test('the browser paints dark before the page does', () => {
  const css = read('website/assets/site.css');
  assert.match(css, /:root \{ color-scheme: dark; \}/);
  assert.match(css, /^html \{ background: var\(--ink\); \}/m);
  // Mobile browser chrome takes its colour from the meta tag, not the stylesheet.
  assert.match(read('scripts/build-website.mjs'), /<meta name="theme-color" content="#050607">/);
});

test('a page transition is declared, bounded, and reducible', () => {
  const css = read('website/assets/site.css');
  assert.match(css, /@view-transition \{ navigation: auto; \}/);

  // Short on purpose: a transition long enough to admire is one that makes the
  // site feel slow the second time it is seen.
  const out = css.match(/::view-transition-old\(root\) \{ animation:pageFadeOut ([\d.]+)s/)?.[1];
  const inn = css.match(/::view-transition-new\(root\) \{ animation:pageFadeIn ([\d.]+)s/)?.[1];
  assert.ok(out && inn, 'the transition has no stated duration');
  assert.ok(Number(out) <= 0.3 && Number(inn) <= 0.35, `transition runs ${out}s/${inn}s, long enough to feel slow`);

  // A reader who asked for less motion still gets the navigation, without the
  // movement — suppressed, not left to blink.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,220}?animation:none/);
});

test('a view-transition name is unique on every page that has one', () => {
  const css = read('website/assets/site.css');
  assert.match(css, /\.nav \{ view-transition-name: ponsr-nav; \}/);

  // Two elements sharing a name make the whole transition fail, so the selector
  // must match exactly one element per page.
  const pages = pages_().filter((file) => !file.includes('/social/'));
  for (const file of pages) {
    const html = read(file);
    const count = (html.match(/class="nav"/g) ?? []).length;
    assert.ok(count <= 1, `${file} has ${count} elements named ponsr-nav`);
  }
});

function pages_() {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(file) : file.endsWith('.html') ? [path.relative(root, file).split(path.sep).join('/')] : [];
    });
  return walk(path.join(root, 'website'));
}

/**
 * PRESS HAS TO FEEL LIKE PRESS.
 *
 * Audited: the whole stylesheet held exactly ONE `:active` rule, on `.btn`.
 * Cards, nav segments, copy buttons and sort tabs had none — they changed
 * colour on hover and then did nothing at all when actually pressed, which is
 * the moment a reader is asking the interface to confirm it heard them.
 *
 * And nothing set `-webkit-tap-highlight-color`, so on a phone every tap drew
 * the OS's own grey box over the design. That single default undoes more
 * perceived quality than any animation adds.
 */
test('every interactive family answers a press', () => {
  const css = read('website/assets/site.css');
  for (const selector of ['.nav-links a:active', '.ca-copy:active', 'a.token-card:active', '.public-launch-row:active']) {
    assert.ok(css.includes(selector), `${selector} has no press state`);
  }
  // A card is pressed through the anchor that covers it, not through the
  // article, so the state has to be read from the child.
  assert.match(css, /\.launchpad-card:has\(\.launchpad-card-link:active\)/);
  assert.match(css, /-webkit-tap-highlight-color: *transparent/);
});

test('the press is faster than the release', () => {
  const css = read('website/assets/site.css');
  // Symmetric timing reads as a slideshow; asymmetric reads as weight. The one
  // press state that already existed used the 250ms hover transition for both,
  // so even it felt soft.
  const rest = css.match(/\.btn,\s*\n\s*\.nav-links a,\s*\n\s*\.ca-copy,\s*\n\s*\[data-launch-sort\] \{\s*transition-duration: *\.(\d+)s/)?.[1];
  const press = css.match(/\.btn:active,[\s\S]{0,140}?transition-duration: *\.(\d+)s/)?.[1];
  assert.ok(rest && press, 'the press and release timings are not both stated');
  assert.ok(Number(press) < Number(rest), `press ${press} is not faster than release ${rest}`);
});

test('keyboard users get a ring where mouse users get a press', () => {
  const css = read('website/assets/site.css');
  // :active never fires for a keyboard user, so the focus ring is the only
  // thing telling them the control is theirs. Two of these families had none.
  for (const selector of ['.ca-copy:focus-visible', '[data-launch-sort]:focus-visible', '.public-launch-row:focus-visible']) {
    assert.ok(css.includes(selector), `${selector} has no focus ring`);
  }
});
