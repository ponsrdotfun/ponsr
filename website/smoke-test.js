const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// The shape of every route depends on one constant in the page. Read it from the
// source rather than hard-coding a single form: these checks previously asserted
// `?view=explore` literally, so turning PRETTY_URLS on for a host that rewrites
// (netlify.toml / vercel.json) would have failed the suite for the wrong reason
// -- and worse, a check written the other way round would have silently passed
// while asserting nothing.
const PRETTY_URLS = /const\s+PRETTY_URLS\s*=\s*true/.test(html);
const URL_MODE = PRETTY_URLS ? 'pretty paths' : 'query strings';

async function run() {
  const errors = [];

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: undefined, // don't actually fetch the Google Fonts stylesheet over the network
    url: 'https://example.com/',
    pretendToBeVisual: true,
    beforeParse(window) {
      // Stub browser APIs jsdom doesn't implement, BEFORE the page's inline script runs
      // (the script executes synchronously as soon as its tag is parsed, so anything set
      // after `new JSDOM(...)` returns would be too late).
      // Mirror a real desktop browser: a fine pointer, no reduced-motion preference.
      // A blanket `matches: false` would silently disable every pointer-gated
      // effect (magnetic CTA, cursor tracking) and they'd go untested.
      window.matchMedia = (q) => ({
        matches: /pointer:\s*fine/.test(String(q)),
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      });
      window.IntersectionObserver = class {
        constructor(cb) { this.cb = cb; }
        observe(el) { this.cb([{ isIntersecting: true, target: el }]); }
        unobserve() {}
      };
      window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);

      // The board reads the chain now, and jsdom has no network. This fixture is
      // the seam fetchLedger() checks first, so the UI logic below -- sorting,
      // search, pagination, routing -- is still exercised against enough rows to
      // be meaningful. The real board has two.
      //
      // Shapes match what the chain layer produces exactly, including the nulls:
      // `trend` and `whatIf` are null because no indexer exists, and several
      // checks assert the UI hides those rather than inventing a value.
      window.__PONSR_FIXTURE__ = Array.from({ length: 30 }, (_, i) => {
        const sym = 'FIX' + String(i).padStart(2, '0');
        const liq = 0.002 + (i % 7) * 0.9;
        return {
          id: sym.toLowerCase(),
          name: 'Fixture ' + i,
          symbol: sym,
          address: '0x' + String(i).padStart(2, '0').repeat(20),
          pool: '0x' + String(i).padStart(2, '0').repeat(20),
          launchedAt: Date.now() - (i + 1) * 3600 * 1000,
          liquidityEth: liq,
          progress: Math.min(1, liq / 4.2),
          holders: 3 + i,
          status: liq >= 4.2 ? 'graduated' : 'curve',
          trend: null,
          whatIf: null,
        };
      });

      // Two tokens, one symbol. This is not hypothetical: two people asked the bot for
      // $PONSR within a day on 2026-08-12, and the detail page keyed on symbol showed the
      // first one to anyone following a link about the second.
      window.__PONSR_FIXTURE__.push(
        {
          id: '0x' + 'aa'.repeat(20), name: 'Dupe One', symbol: 'DUPE',
          address: '0x' + 'aa'.repeat(20), pool: '0x' + 'aa'.repeat(20),
          launchedAt: Date.now() - 1000, liquidityEth: 0.5, progress: 0.1,
          holders: 1, status: 'curve', trend: null, whatIf: null,
        },
        {
          id: '0x' + 'bb'.repeat(20), name: 'Dupe Two', symbol: 'DUPE',
          address: '0x' + 'bb'.repeat(20), pool: '0x' + 'bb'.repeat(20),
          launchedAt: Date.now() - 2000, liquidityEth: 0.6, progress: 0.1,
          holders: 1, status: 'curve', trend: null, whatIf: null,
        }
      );
    },
  });

  const { window } = dom;
  window.onerror = (msg) => { errors.push(String(msg)); };

  // Give the deferred init (fetchLedger().then(renderLedger), timers, rAF chains) time
  // to run. Must outlast the hero reveal sequence, whose last step fires at 700ms.
  await new Promise((resolve) => setTimeout(resolve, 900));

  const doc = window.document;

  const checks = [];

  checks.push(['no window.onerror thrown errors', errors.length === 0, errors.join('; ')]);
  checks.push(['title is set', doc.title.length > 0, doc.title]);
  checks.push(['explore grid rendered a full set of cards', doc.querySelectorAll('.tcard').length >= 12, String(doc.querySelectorAll('.tcard').length)]);
  // The strip used to count up to hardcoded totals. It now reports what the
  // ledger actually returned, so the check is that it reflects the data.
  checks.push(['stat strip reports the real launch count',
    doc.getElementById('stat-total').textContent === '32', doc.getElementById('stat-total').textContent]);
  checks.push(['stat strip reports liquidity in ETH, not invented dollars',
    /ETH$/.test(doc.getElementById('stat-liq').textContent), doc.getElementById('stat-liq').textContent]);
  // Three separate views: the landing page is the pitch, explore is the tool.
  checks.push(['landing page is the default view',
    !doc.getElementById('view-home').hidden && doc.getElementById('view-explore').hidden && doc.getElementById('view-token').hidden, '']);

  // The nav's Explore link switches views instead of scrolling the landing page.
  doc.querySelector('.nav-links a[data-go="explore"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  checks.push(['Explore opens its own page',
    doc.getElementById('view-home').hidden && !doc.getElementById('view-explore').hidden, '']);
  // `route` is path + query, so the same assertion works whichever form the app writes.
  const route = () => window.location.pathname + window.location.search;
  checks.push([`explore page has its own URL (${URL_MODE})`,
    PRETTY_URLS ? /\/explore$/.test(route()) : /view=explore/.test(route()), route()]);

  // Every card must carry the launchpad essentials: cover art, market cap,
  // bonding-curve progress and a contract address.
  const card0 = doc.querySelector('.tcard');
  checks.push(['cards render cover art', !!card0.querySelector('.cardart'), '']);
  checks.push(['cards show a bonding-curve progress bar',
    /%$/.test(card0.querySelector('.tcard-bar i').style.width || ''), card0.querySelector('.tcard-bar i').style.width || 'none']);
  checks.push(['cards show a truncated contract address',
    /^0x[0-9a-f]{4}…[0-9a-f]{4}$/.test(card0.querySelector('.tcard-addr').textContent), card0.querySelector('.tcard-addr').textContent]);

  // Clicking a card must open that token's own page and put it in the URL,
  // so the page can be linked from the bot's reply, refreshed and shared.
  const firstRowName = card0.querySelector('.tcard-name').textContent;
  card0.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));

  checks.push(['clicking a card opens the token page', doc.getElementById('view-explore').hidden && !doc.getElementById('view-token').hidden, '']);
  checks.push(['token page shows the right token', doc.getElementById('tp-name').textContent === firstRowName, doc.getElementById('tp-name').textContent + ' vs ' + firstRowName]);
  checks.push([`token page has its own URL (${URL_MODE})`,
    PRETTY_URLS ? /\/token\/[^/]+$/.test(route()) : /\?token=/.test(route()), route()]);
  // CRITICAL: no price history means no chart. A flat line drawn from nothing is
  // a picture of a claim -- that the price held steady -- which nobody knows. The
  // old check asserted a chart was always drawn, which was only ever satisfiable
  // because the data was generated.
  checks.push(['token page draws NO chart when there is no price history',
    doc.querySelectorAll('#tp-chart path').length === 0, String(doc.querySelectorAll('#tp-chart path').length)]);
  checks.push(['token page hides the 24h change when it cannot be computed',
    doc.getElementById('tp-change').hidden === true, String(doc.getElementById('tp-change').hidden)]);
  checks.push(['token page shows a contract address', /^0x[0-9a-f]{40}$/.test(doc.getElementById('tp-addr').textContent), doc.getElementById('tp-addr').textContent]);

  // Motion preset 12: while the token page is open its art carries the shared
  // name, and it holds the same cover art as the card so the morph is a uniform
  // scale rather than a stretch between two different shapes.
  checks.push(['token page carries the shared-element transition tag',
    doc.getElementById('tp-art').style.viewTransitionName === 'token-hero',
    doc.getElementById('tp-art').style.viewTransitionName || 'none']);
  checks.push(['token page renders the same cover art as the card',
    !!doc.querySelector('#tp-art .cardart'), '']);

  // The what-if figures stay locked until the wallet is connected (the decision
  // recorded in the master doc), then reveal for that token.
  checks.push(['what-if is gated until a wallet is connected', !doc.getElementById('tp-locked').hidden && doc.getElementById('tp-figures').hidden, '']);
  doc.getElementById('tp-connect').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  // CRITICAL: connecting must NOT reveal figures. It used to unlock a full
  // statement -- "value today, had you held everything" -- computed from numbers
  // generated for the preview dataset, for a wallet that was never connected.
  // The indexer that would make it real is not built.
  checks.push(['connecting does NOT reveal invented what-if figures',
    doc.getElementById('tp-figures').hidden === true, String(doc.getElementById('tp-figures').hidden)]);
  checks.push(['connecting says plainly that the feature is not built',
    /not (available|built)/i.test(doc.querySelector('.tp-demo-note').textContent),
    doc.querySelector('.tp-demo-note').textContent]);

  // Back returns to the explore board (where you came from), not the landing page.
  doc.getElementById('tp-back').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  checks.push(['back returns to the explore board',
    !doc.getElementById('view-explore').hidden && doc.getElementById('view-token').hidden && !/token/.test(route()),
    route()]);

  // Sorting: assert the ORDER rather than a specific token, so the check stays
  // valid as the preview dataset changes.
  const parseMcap = (s) => {
    const m = /\$([\d.]+)([KM]?)/.exec(s || '');
    if (!m) return NaN;
    return parseFloat(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1);
  };
  const mcapBtn = doc.querySelector('#ledger-sort button[data-sort="mcap"]');
  if (mcapBtn) {
    mcapBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Liquidity in ETH, not a dollar market cap: this chain has no price oracle a
    // static page can read, so a USD figure would be a guess presented as a fact.
    const vals = Array.from(doc.querySelectorAll('.tcard [data-mcap]')).map((e) => parseFloat(e.textContent));
    const descending = vals.every((v, i) => i === 0 || (!isNaN(v) && vals[i - 1] >= v));
    checks.push(['sort by liquidity orders cards high to low', vals.length > 1 && descending,
      vals.slice(0, 3).map((v) => v + ' ETH').join(' ≥ ')]);
    checks.push(['liquidity is denominated in ETH, never invented dollars',
      Array.from(doc.querySelectorAll('.tcard [data-mcap]')).every((e) => /ETH$/.test(e.textContent)),
      doc.querySelector('.tcard [data-mcap]').textContent]);
  } else {
    checks.push(['sort control renders', false, 'missing #ledger-sort']);
  }

  // Search: filter to a symbol and confirm the table narrows.
  const search = doc.getElementById('ledger-search');
  if (search) {
    search.value = 'fixture 1';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const filtered = doc.querySelectorAll('.tcard').length;
    checks.push(['search narrows the grid', filtered >= 1 && filtered < 12, String(filtered)]);
  }

  // Pagination: the grid must cap how many cards are in the DOM, expose page
  // controls, and actually change the contents when you move to page 2.
  const search2 = doc.getElementById('ledger-search');
  if (search2) { search2.value = ''; search2.dispatchEvent(new window.Event('input', { bubbles: true })); }
  await new Promise((resolve) => setTimeout(resolve, 40));

  const onScreen = doc.querySelectorAll('.tcard').length;
  checks.push(['page shows at most one page of cards', onScreen > 0 && onScreen <= 24, String(onScreen)]);

  const pageBtns = doc.querySelectorAll('#pager button[data-page]');
  checks.push(['pager renders page controls', pageBtns.length >= 3, String(pageBtns.length) + ' buttons']);
  checks.push(['previous is disabled on page 1', doc.querySelector('#pager button[aria-label="Previous page"]').disabled, '']);

  const page1First = doc.querySelector('.tcard') && doc.querySelector('.tcard').dataset.id;
  const page2Btn = doc.querySelector('#pager button[data-page="2"]');
  if (page2Btn) {
    page2Btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const page2First = doc.querySelector('.tcard') && doc.querySelector('.tcard').dataset.id;
    checks.push(['page 2 shows different cards', !!page2First && page2First !== page1First, page1First + ' -> ' + page2First]);
    checks.push(['page 2 is marked current',
      (doc.querySelector('#pager button[aria-current="page"]') || {}).textContent === '2',
      (doc.querySelector('#pager button[aria-current="page"]') || {}).textContent || 'none']);
    // Searching must send you back to page 1 rather than stranding you on a page
    // that no longer exists in the filtered result set.
    search2.value = 'a';
    search2.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const curBtn = doc.querySelector('#pager button[aria-current="page"]');
    checks.push(['searching resets to page 1', !curBtn || curBtn.textContent === '1', curBtn ? curBtn.textContent : 'single page']);
    search2.value = '';
    search2.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
  } else {
    checks.push(['pager offers a second page', false, 'no page-2 button']);
  }

  // The router must resolve the pretty path form (/explore, /token/SYM) as well
  // as the query form — those paths are what the host rewrites serve, so if the
  // parser only understood query strings every rewritten URL would land on the
  // landing page instead. Driven through popstate, which is how a real
  // back/forward or a direct visit re-enters the router.
  const sym = doc.querySelector('.tcard .token-symbol').textContent.replace('$', '');

  window.history.replaceState({}, '', '/explore');
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  checks.push(['/explore path resolves to the explore view',
    !doc.getElementById('view-explore').hidden && doc.getElementById('view-home').hidden,
    window.location.pathname]);

  window.history.replaceState({}, '', '/token/' + sym);
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  checks.push(['/token/SYMBOL path resolves to that token',
    !doc.getElementById('view-token').hidden && doc.getElementById('tp-symbol').textContent === '$' + sym,
    window.location.pathname + ' -> ' + doc.getElementById('tp-symbol').textContent]);

  // A token's URL is its contract address, because symbols are chosen by whoever tweets and
  // two people can pick the same one. Keyed on symbol, the page showed a stranger's token to
  // someone following a link about their own.
  window.history.replaceState({}, '', '/token/0x' + 'aa'.repeat(20));
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  checks.push(['/token/ADDRESS opens exactly that token',
    !doc.getElementById('view-token').hidden && doc.getElementById('tp-name').textContent === 'Dupe One',
    doc.getElementById('tp-name').textContent]);

  window.history.replaceState({}, '', '/token/0x' + 'bb'.repeat(20));
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  checks.push(['a second token with the SAME symbol opens its own page',
    doc.getElementById('tp-name').textContent === 'Dupe Two',
    doc.getElementById('tp-name').textContent]);

  // Guessing would be worse than not resolving: it shows someone a token that is not the one
  // they were sent. The board lets them choose instead.
  window.history.replaceState({}, '', '/token/DUPE');
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  checks.push(['an ambiguous SYMBOL link refuses to guess a token',
    doc.getElementById('view-token').hidden, 'token view hidden: ' + doc.getElementById('view-token').hidden]);

  window.history.replaceState({}, '', '/');
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  await new Promise((resolve) => setTimeout(resolve, 80));

  // AUDIT REGRESSIONS -----------------------------------------------------------
  // Only one element may ever carry the shared view-transition-name; two tagged
  // at once makes the browser reject the transition and cut instead.
  const taggedNow = Array.prototype.filter.call(doc.querySelectorAll('*'), (e) =>
    e.style && e.style.viewTransitionName === 'token-hero');
  checks.push(['at most one element carries the shared transition name',
    taggedNow.length <= 1, taggedNow.length + ' tagged']);

  // This once asserted that symbols were unique, on the reasoning that "symbols are the
  // routing key, so duplicates would make one card open another token's page". The premise
  // was the bug: symbols are chosen by whoever tweets, and two people asked for $PONSR within
  // a day on 2026-08-12. Routing moved to the contract address, and the invariant worth
  // guarding moved with it -- duplicate symbols are now expected and harmless, duplicate
  // routing keys are not.
  const seenIds = {};
  let dupId = null;
  const allSortBtn = doc.querySelector('#ledger-sort button[data-sort="newest"]');
  if (allSortBtn) allSortBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  for (const el of doc.querySelectorAll('.tcard')) {
    const k = el.dataset.id;
    if (k && seenIds[k]) dupId = k;
    if (k) seenIds[k] = 1;
  }
  checks.push(['no duplicate routing keys on a page', dupId === null, dupId || 'all unique']);

  // Focus must follow a route change into the view that is actually visible.
  checks.push(['focus is never stranded inside a hidden view',
    !Array.prototype.some.call(doc.querySelectorAll('[hidden]'), (h) => h.contains(doc.activeElement)), '']);

  // Motion preset 12: the token page's monogram is tagged as the shared element
  // so the browser morphs the card's cover art into it across the route change.
  // ...and once we have navigated away it must be released. Leaving it attached
  // makes the outgoing snapshot a shared element with no counterpart on the new
  // page, and the browser strands that snapshot on screen mid-flight.
  checks.push(['shared-element tag is released after leaving the token page',
    doc.getElementById('tp-art').style.viewTransitionName === '',
    doc.getElementById('tp-art').style.viewTransitionName || '(released)']);
  // The chart's draw-on is deferred past the page transition; it must still end up
  // drawn even when that transition is skipped or never reports completion.
  await new Promise((resolve) => setTimeout(resolve, 750));
  // With history the chart must always finish drawing (the deferred draw-on used
  // to be able to hang). With none it must stay empty. Assert whichever applies.
  const tpChart = doc.getElementById('tp-chart');
  const hasHistory = tpChart.querySelectorAll('path').length > 0;
  checks.push(['token chart either finishes drawing or is absent, never half-drawn',
    hasHistory ? tpChart.classList.contains('drawn') : tpChart.innerHTML.trim() === '',
    hasHistory ? String(tpChart.className) : '(no history, empty)']);
  checks.push(['page-transition class is always cleaned up',
    !doc.documentElement.classList.contains('vt-active'),
    doc.documentElement.className || '(clean)']);

  // Motion preset 15: shimmer placeholders must exist and be replaced by real
  // cards once the data lands (they are gone by the time these checks run).
  checks.push(['loading skeletons are cleared once data arrives',
    doc.querySelectorAll('.skel').length === 0 && doc.querySelectorAll('.tcard').length > 0,
    doc.querySelectorAll('.skel').length + ' skeletons left']);

  // Motion preset 9: the headline is split into per-character spans, all revealed,
  // with the real sentence still exposed to screen readers via aria-label.
  const chars = doc.querySelectorAll('.hero h1 .ch');
  const charsIn = doc.querySelectorAll('.hero h1 .ch.in');
  checks.push(['headline split into characters and revealed',
    chars.length > 5 && charsIn.length === chars.length,
    charsIn.length + '/' + chars.length]);
  checks.push(['split headline still readable by screen readers (aria-label)',
    doc.querySelector('.hero h1').getAttribute('aria-label') === 'Every launch, on the record.',
    doc.querySelector('.hero h1').getAttribute('aria-label') || 'missing']);
  // The sheen line must stay one element, or its gradient breaks per character.
  checks.push(['metallic sheen line was not split',
    doc.querySelectorAll('.hero h1 .sheen .ch').length === 0, '']);

  // The hero reveal sequence must actually un-hide every staged element. This also
  // guards the selector the sequence uses for the sheen line: a stray descendant
  // match there once left the whole second line stuck at opacity 0.
  const staged = [['.hero-eyebrow', 'eyebrow'], ['.hero h1 .sheen', 'sheen line'],
                  ['.hero-sub', 'sub'], ['.hero-cta', 'cta'], ['.hero-livebar', 'live bar']];
  const unrevealed = staged.filter(([sel]) => {
    const el = doc.querySelector(sel);
    return !el || el.style.opacity !== '1';
  }).map(([, name]) => name);
  checks.push(['hero reveal sequence un-hides every staged element',
    unrevealed.length === 0, unrevealed.length ? 'stuck: ' + unrevealed.join(', ') : 'all 5 revealed']);

  // Split characters must sit on one line: a descendant selector once forced them
  // to display:block, stacking the headline one letter per row.
  const chDisplay = chars.length ? dom.window.getComputedStyle(chars[0]).display : '';
  checks.push(['split characters stay inline (not stacked one per line)',
    chDisplay === 'inline-block', chDisplay || 'no chars']);

  // Motion preset 3: magnetic CTA pulls toward the cursor but stays in its hit box.
  const magBtn = doc.querySelector('.hero-cta .btn-primary.magnetic');
  if (magBtn) {
    const br = { width: 166, height: 49 }; // jsdom has no layout; use the known size
    magBtn.getBoundingClientRect = () => ({ left: 0, top: 0, width: br.width, height: br.height, right: br.width, bottom: br.height });
    magBtn.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: br.width, clientY: br.height }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const t = magBtn.style.transform || '';
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(t);
    const pulled = m && (Math.abs(parseFloat(m[1])) > 0.5 || Math.abs(parseFloat(m[2])) > 0.5);
    const inBox = m && Math.abs(parseFloat(m[1])) < br.width / 2 && Math.abs(parseFloat(m[2])) < br.height / 2;
    checks.push(['magnetic CTA pulls toward cursor, clamped inside its hit box', !!(pulled && inBox), t || 'no transform']);
  } else {
    checks.push(['magnetic CTA initialised', false, 'no .btn-primary.magnetic found']);
  }

  // Motion preset 8: step cards stagger in (IntersectionObserver stub fires immediately).
  checks.push(['step cards staggered in',
    doc.querySelectorAll('.steps .step.pop').length === doc.querySelectorAll('.steps .step').length
      && doc.querySelectorAll('.steps .step').length > 0,
    doc.querySelectorAll('.steps .step.pop').length + '/' + doc.querySelectorAll('.steps .step').length]);

  // ---- Footer: attribution and non-affiliation ----
  // These are not cosmetic. pons's attribution terms ask for lowercase "pons"
  // plus a link back, and "Ponsr" is one letter away from "pons" -- the
  // non-affiliation sentence is the thing keeping that from reading as an
  // endorsement. Nothing guarded any of it until now, so a footer tidy-up could
  // have quietly removed all three.
  const footer = doc.querySelector('footer');
  const footerText = footer ? footer.textContent : '';
  checks.push(['footer links back to ponsfamily.com',
    !!(footer && footer.querySelector('a[href*="ponsfamily.com"]'))]);
  checks.push(['footer states Ponsr is not affiliated with pons',
    /not operated by, affiliated with, or endorsed by pons/i.test(footerText)]);
  checks.push(['footer writes "pons" lowercase, never "Pons"',
    !/\bPons\b/.test(footerText), footerText.match(/\bPons\b/) ? 'found capitalised "Pons"' : 'ok']);

  const fx = doc.querySelector('.footer-x');
  checks.push(['footer links to the @ponsrdotfun X account',
    !!(fx && /x\.com\/ponsrdotfun/.test(fx.getAttribute('href') || ''))]);
  checks.push(['X link opens in a new tab safely (noopener)',
    !!(fx && (fx.getAttribute('rel') || '').includes('noopener'))]);

  let failCount = 0;
  for (const [name, pass, detail] of checks) {
    console.log((pass ? 'PASS' : 'FAIL') + ' -- ' + name + (detail ? ' (' + detail + ')' : ''));
    if (!pass) failCount++;
  }

  console.log(`\n${checks.length - failCount}/${checks.length} checks passed.`);
  // Exit explicitly: the page now runs real-time setInterval timers, which keep
  // jsdom's event loop alive and would otherwise stop this runner from ever exiting.
  process.exit(failCount > 0 ? 1 : 0);
}

run();
