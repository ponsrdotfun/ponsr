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

      // jsdom has no fetch. Nothing in the suite should reach the network -- the ledger
      // uses a fixture and the paused notice uses its own seam -- so this is a tripwire
      // rather than a stub: if anything calls it, that is a page touching the network
      // during a test and it should fail loudly rather than crash the runner.
      window.__PONSR_PAUSED__ = false;
      window.fetch = () => Promise.reject(new Error('the page reached for the network during a test'));

      // jsdom has no canvas: getContext returns null, so every card builder threw
      // and the whole share path -- wrapping, the shrink-to-fit loop, which story a
      // wallet is told -- was covered by nothing but opening a browser and looking.
      // Two shipped bugs lived in that arithmetic. This records the calls instead of
      // painting, and measureText is proportional to the size in the font string, so
      // wrapping behaves like a real face rather than returning a constant that would
      // make every layout assertion vacuous.
      window.HTMLCanvasElement.prototype.getContext = function () {
        // One context per canvas, as a real browser does. Handing back a fresh
        // recorder each call loses everything already drawn, and a test reading
        // the calls afterwards would see an empty card and pass or fail for a
        // reason that has nothing to do with the page.
        if (this.__ctx) return this.__ctx;
        const calls = [];
        const rec = (name) => (...args) => { calls.push([name, ...args]); };
        const ctx = {
          __calls: calls,
          canvas: this,
          font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '',
          lineJoin: '', textAlign: '', textBaseline: '', globalAlpha: 1,
          globalCompositeOperation: '', filter: '',
          shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
          save: rec('save'), restore: rec('restore'), translate: rec('translate'),
          rotate: rec('rotate'), scale: rec('scale'), setTransform: rec('setTransform'),
          beginPath: rec('beginPath'), closePath: rec('closePath'),
          moveTo: rec('moveTo'), lineTo: rec('lineTo'), arc: rec('arc'),
          arcTo: rec('arcTo'), ellipse: rec('ellipse'), rect: rec('rect'),
          roundRect: rec('roundRect'), quadraticCurveTo: rec('quadraticCurveTo'),
          bezierCurveTo: rec('bezierCurveTo'), clip: rec('clip'),
          fill: rec('fill'), stroke: rec('stroke'),
          fillRect: rec('fillRect'), strokeRect: rec('strokeRect'),
          clearRect: rec('clearRect'), drawImage: rec('drawImage'),
          fillText(text, x, y) { calls.push(['fillText', String(text), x, y]); },
          strokeText(text, x, y) { calls.push(['strokeText', String(text), x, y]); },
          measureText(t) {
            const m = /(\d+(?:\.\d+)?)px/.exec(ctx.font || '16px');
            const size = m ? parseFloat(m[1]) : 16;
            return { width: String(t).length * size * 0.5 };
          },
          createLinearGradient: () => ({ addColorStop() {} }),
          createRadialGradient: () => ({ addColorStop() {} }),
          createPattern: () => null,
        };
        this.__ctx = ctx;
        return ctx;
      };

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
          // Uncapped, exactly as the real rows carry it. Sorting uses this: with only
          // the clamped value, every fixture above 4.2 ETH ties at 1 and the ordering
          // assertion below passes or fails on log order rather than on the sort.
          progressRaw: liq / 4.2,
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
  // Wallet discovery is deliberately asynchronous: EIP-6963 asks every installed
  // wallet to announce itself and waits ~120ms so a slow extension is not missed.
  // Anything shorter here tests the moment before the answer arrives.
  await new Promise((resolve) => setTimeout(resolve, 300));
  // CRITICAL: connecting must NOT reveal figures. It used to unlock a full
  // statement -- "value today, had you held everything" -- computed from numbers
  // generated for the preview dataset, for a wallet that was never connected.
  // The indexer that would make it real is not built.
  checks.push(['connecting does NOT reveal invented what-if figures',
    doc.getElementById('tp-figures').hidden === true, String(doc.getElementById('tp-figures').hidden)]);
  // The feature is built now (it reads ERC20 Transfer logs and the pool price), so
  // the old check that it announced itself as unbuilt has gone. What replaces it is
  // the property that still matters in an environment with no wallet: say why
  // nothing appeared, rather than showing figures or failing silently.
  checks.push(['with no wallet available, connecting explains why instead of showing figures',
    /wallet/i.test(doc.getElementById('tp-wallet-note').textContent),
    doc.getElementById('tp-wallet-note').textContent]);

  // No dollar figure anywhere in this panel. There is no price oracle on this chain,
  // so a USD number could only be invented -- the mistake this panel already made once.
  checks.push(['what-if panel quotes no dollar figure',
    doc.getElementById('tp-whatif').textContent.indexOf('$') === -1,
    'no $ in panel']);

  // Two bugs the panel shipped with, both invisible to a passing test that only
  // checked the figures appeared.
  //
  // 1. `.tp-locked { display: flex }` outranks the browser's [hidden] rule, so
  //    setting hidden left the Connect button on screen underneath the results,
  //    frozen mid-flight.
  const lockedEl = doc.getElementById('tp-locked');
  lockedEl.hidden = true;
  const lockedDisplay = window.getComputedStyle(lockedEl).display;
  checks.push(['[hidden] actually hides the connect panel',
    lockedDisplay === 'none', 'computed display: ' + lockedDisplay]);
  lockedEl.hidden = false;

  // 2. Opening another token re-locks the panel, but the button kept the previous
  //    token's disabled state and label, so it read "Reading the chain…" forever.
  doc.getElementById('tp-connect').disabled = true;
  doc.querySelector('#tp-connect span').textContent = 'Reading the chain…';
  window.history.replaceState({}, '', '/token/0x' + 'bb'.repeat(20));
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  await new Promise((resolve) => setTimeout(resolve, 260));
  checks.push(['opening another token resets the connect button',
    doc.getElementById('tp-connect').disabled === false &&
      doc.querySelector('#tp-connect span').textContent === 'Connect wallet',
    doc.querySelector('#tp-connect span').textContent]);

  // The share button builds a PNG card on canvas, and has two paths worth testing.
  //
  // Path 1: canvas is unavailable -- it is blocked in some browsers, and it used to
  // be unavailable here too. It must still share, by falling back to the link; a
  // share button that silently does nothing is worse than a plain one. The suite now
  // provides a working canvas, so this takes it away again for one click rather than
  // relying on jsdom's absence, which is what this check was really testing before.
  const shareBtn = doc.getElementById('tp-share');
  let copied = null;
  window.navigator.clipboard = { writeText: (v) => { copied = v; return Promise.resolve(); } };
  const realGetContext = window.HTMLCanvasElement.prototype.getContext;
  window.HTMLCanvasElement.prototype.getContext = function () { return null; };
  shareBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  window.HTMLCanvasElement.prototype.getContext = realGetContext;
  checks.push(['share falls back to the link when canvas is unavailable',
    typeof copied === 'string' && copied.indexOf('/token/') !== -1, String(copied)]);
  // The link it shares is the address form, so it cannot land on another token that
  // happens to share the symbol.
  checks.push(['the shared link is keyed on the contract address',
    typeof copied === 'string' && /\/token\/0x[0-9a-fA-F]{40}/.test(copied), String(copied)]);

  // Path 2: the card builds, so the button must reach X's composer carrying the same
  // address-keyed link. Neither jsdom nor the recording context can encode a real
  // PNG, so the blob is empty here -- what is asserted is that the click ends at the
  // composer rather than dying quietly somewhere in the clipboard branch.
  let opened = null;
  window.open = (u) => { opened = String(u); return null; };
  window.HTMLCanvasElement.prototype.toBlob = function (cb) { cb(null); };
  shareBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  checks.push(['share opens the composer when the card builds',
    typeof opened === 'string' && opened.includes('x.com/intent/post') &&
      /%2Ftoken%2F0x[0-9a-fA-F]{40}/.test(opened),
    String(opened).slice(0, 110)]);

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
  // A shared link is how a launch travels. Without these tags X renders a bare URL
  // with no preview and nothing that says Ponsr.
  const og = (prop) => {
    const el = doc.querySelector('meta[property="' + prop + '"], meta[name="' + prop + '"]');
    return el && el.getAttribute('content');
  };
  checks.push(['link previews carry an image and a card type',
    !!og('og:image') && og('twitter:card') === 'summary_large_image',
    (og('og:image') || 'no og:image') + ' / ' + (og('twitter:card') || 'no card')]);

  // Every asset path must be absolute. On /token/0x… a relative src resolves to
  // /token/logo.png, which the SPA rewrite answers with index.html at status 200 --
  // so the browser is handed HTML where it expected an image and simply shows a
  // broken one. No 404, no console error, nothing to notice. That is exactly how
  // the header logo broke on every token page.
  const relAssets = Array.from(doc.querySelectorAll('img[src], link[rel*="icon"][href]'))
    .map((el) => el.getAttribute('src') || el.getAttribute('href'))
    .filter((v) => v && !/^(https?:)?\/\//.test(v) && v[0] !== '/' && !v.startsWith('data:'));
  checks.push(['every asset path is absolute, so deep routes do not break them',
    relAssets.length === 0, relAssets.join(', ') || 'all absolute']);

  // Part 4 asks for the disclaimer to be live on a public surface, not filed in the repo.
  // A page nothing links to is filed in the repo.
  const termsLink = doc.querySelector('footer a[href="/terms"], footer a[href$="terms.html"]');
  checks.push(['footer links to the terms & disclaimer page', !!termsLink,
    termsLink ? termsLink.getAttribute('href') : 'missing']);

  checks.push(['X link opens in a new tab safely (noopener)',
    !!(fx && (fx.getAttribute('rel') || '').includes('noopener'))]);

  // ---------------------------------------------------------------------------
  // Share cards
  //
  // These are permanent images people put on their timeline under this project's
  // name, and until now nothing tested them. Every assertion below corresponds to
  // something that actually went wrong or could only be seen by eye.
  // ---------------------------------------------------------------------------
  const CARD = dom.window.__PONSR_CARD__;
  checks.push(['card builders are reachable from the suite', !!CARD,
    CARD ? '' : 'window.__PONSR_CARD__ missing']);

  if (CARD) {
    const B = (n) => BigInt(n) * 10n ** 18n;
    const T = {
      symbol: 'FIX00', name: 'Fixture 0',
      address: '0x' + '00'.repeat(20),
      liquidityEth: 1.2, launchedAt: Date.now() - 3600e3,
    };
    const WORDMARK_TOP = 675 - 96;   // the hairline the card draws above 'Ponsr'

    // Which story a wallet is told. `moved` exists because a card once called a
    // wallet a diamond hand directly above STILL HOLD 0.00 -- it had transferred
    // the lot away, which is neither selling nor holding.
    const stories = [
      ['never sold, still holds', [B(100), 0n, B(100)], 'diamond'],
      ['sold the whole bag', [B(100), B(100), 0n], 'sold_all'],
      ['sold part of it', [B(100), B(40), B(60)], 'sold_some'],
      ['transferred out without selling', [B(100), 0n, 0n], 'moved'],
    ];
    const wrongStory = stories
      .map(([label, args, want]) => [label, CARD.roastKind(...args), want])
      .filter(([, got, want]) => got !== want);
    checks.push(['the card tells the story the chain supports',
      wrongStory.length === 0,
      wrongStory.map(([l, g, w]) => `${l}: ${g} not ${w}`).join('; ') || 'all four correct']);

    // A story with no copy renders the word `undefined` onto a permanent image.
    const kindNames = Object.keys(CARD.ROAST);
    const missingCopy = kindNames.filter((k) =>
      !Array.isArray(CARD.ROAST[k]) || CARD.ROAST[k].length === 0 ||
      CARD.ROAST[k].some((s) => !s || !String(s).trim()) ||
      !Array.isArray(CARD.ROAST_TWEET[k]) || CARD.ROAST_TWEET[k].length === 0 ||
      CARD.ROAST_TWEET[k].some((s) => !s || !String(s).trim()));
    checks.push(['every story has both card copy and tweet copy',
      kindNames.length === 4 && missingCopy.length === 0,
      missingCopy.join(', ') || kindNames.join('/')]);

    // Build the real card for each story at its real size. `statsBottom` is the
    // lowest text the builder places; anything at or below the hairline is text
    // sitting on top of the wordmark.
    const cardFaults = [];
    for (const [, args, want] of stories) {
      const wi = { received: args[0], sold: args[1], balance: args[2], priceEth: 0.0000012 };
      let built = null;
      try { built = CARD.buildWhatIfCard(T, wi); }
      catch (e) { cardFaults.push(`${want}: threw ${(e && e.message) || e}`); continue; }
      if (built.canvas.width !== 1200 || built.canvas.height !== 675) {
        cardFaults.push(`${want}: ${built.canvas.width}x${built.canvas.height}`);
      }
      if (built.kind !== want) cardFaults.push(`${want}: built as ${built.kind}`);
      if (built.layout.statsBottom >= WORDMARK_TOP) {
        cardFaults.push(`${want}: text reaches ${built.layout.statsBottom}, wordmark at ${WORDMARK_TOP}`);
      }
    }
    checks.push(['every story builds a card that clears the wordmark',
      cardFaults.length === 0, cardFaults.join('; ') || 'all four fit']);

    // The roast is set at the largest size whose wrapped block still clears the
    // footer, and at 62px the two-line cases fitted by a single pixel. Force a
    // roast far longer than any real one and the loop must actually react --
    // otherwise a future third line runs straight through the wordmark.
    const realDiamond = CARD.ROAST.diamond;
    CARD.ROAST.diamond = ['this is a deliberately enormous roast written for no ' +
      'reason other than to force the block onto several lines so the shrink loop ' +
      'has to react to it rather than sitting at its starting size'];
    let longCard = null, longErr = '';
    try {
      longCard = CARD.buildWhatIfCard(T,
        { received: B(100), sold: 0n, balance: B(100), priceEth: 0.0000012 });
    } catch (e) { longErr = String((e && e.message) || e); }
    CARD.ROAST.diamond = realDiamond;
    checks.push(['an over-long roast shrinks rather than overrunning the card',
      !!longCard && longCard.layout.roastLines > 1 && longCard.layout.roastSize < 62 &&
        longCard.layout.statsBottom < WORDMARK_TOP,
      longCard
        ? `${longCard.layout.roastLines} lines at ${longCard.layout.roastSize}px, bottom ${longCard.layout.statsBottom}`
        : `threw ${longErr}`]);

    // Wrapping must respect the column. Nothing clips the text, so a line wider
    // than the column is a line that runs off the edge of a published image.
    const probe = doc.createElement('canvas').getContext('2d');
    const wrapped = CARD.cardLines(probe,
      'the quick brown fox jumps over the lazy dog and then keeps running well past the edge',
      62, 640, 600);
    probe.font = '600 62px Fraunces, Georgia, serif';
    // A single word longer than the column cannot be broken, so only multi-word
    // lines are a wrapping fault.
    const overWide = wrapped.filter((l) => l.split(' ').length > 1 && probe.measureText(l).width > 640);
    checks.push(['card text wraps inside its column',
      wrapped.length > 1 && overWide.length === 0,
      `${wrapped.length} lines, ${overWide.length} too wide`]);

    // The token card is a separate builder on a separate path; asserting the
    // what-if card says nothing about it.
    let shareCanvas = null, shareErr = '';
    try { shareCanvas = CARD.buildShareCard(T); }
    catch (e) { shareErr = String((e && e.message) || e); }
    checks.push(['the token share card builds at card size',
      !!shareCanvas && shareCanvas.width === 1200 && shareCanvas.height === 675,
      shareCanvas ? `${shareCanvas.width}x${shareCanvas.height}` : `threw ${shareErr}`]);

    // Both cards must carry the mark, or a share is an anonymous picture of a
    // number. Asserted on the text actually drawn, not on the source.
    const drawn = (c) => (c.getContext('2d').__calls || [])
      .filter((k) => k[0] === 'fillText').map((k) => k[1]).join(' | ');
    const whatIfCard = CARD.buildWhatIfCard(T,
      { received: B(100), sold: B(100), balance: 0n, priceEth: 0.0000012 });
    checks.push(['both cards carry the Ponsr wordmark',
      /Ponsr/.test(drawn(whatIfCard.canvas)) && /ponsr\.fun/.test(drawn(whatIfCard.canvas)) &&
        /Ponsr/.test(drawn(shareCanvas)),
      'what-if and token card both signed']);

    // The card must never state a figure the chain did not give it. With no price
    // it shows an em dash; inventing a number here would be a permanent image
    // making a claim nobody can check.
    const priceless = CARD.buildWhatIfCard(T,
      { received: B(100), sold: 0n, balance: B(100), priceEth: null });
    checks.push(['with no price the card shows a dash, not an invented value',
      drawn(priceless.canvas).includes('—'),
      'no price -> em dash']);
  }

  // ---------------------------------------------------------------------------
  // The paused notice
  //
  // The page invites people to tag the bot, and through the whole of pons's pause
  // that invitation could not be honoured. The notice is driven by the chain so it
  // clears itself; these assert both states, because a banner that never disappears
  // is as wrong as one that never appears.
  // ---------------------------------------------------------------------------
  const note = doc.getElementById('pause-note');
  checks.push(['a paused notice exists on the page', !!note, note ? '' : 'missing #pause-note']);

  if (note) {
    // Hidden by default matters: a failed chain read must leave the page saying
    // nothing rather than claiming a pause that may have ended.
    const freshDom = new JSDOM(html, { runScripts: 'outside-only' });
    const fresh = freshDom.window.document.getElementById('pause-note');
    checks.push(['the notice is hidden until the chain answers',
      fresh ? fresh.hasAttribute('hidden') : false,
      fresh ? '' : 'not found in raw markup']);

    checks.push(['the notice names pons, lowercase, and blames nobody',
      /pons/.test(note.textContent) && !/Pons/.test(note.textContent) &&
        !/(down|broken|abandoned)/i.test(note.textContent),
      note.textContent.trim().slice(0, 60) + '…']);

    // Driven, not decorative.
    const recheck = window.__PONSR_CHECK_PAUSED__;
    window.__PONSR_PAUSED__ = true;
    if (recheck) recheck();
    const shownWhenPaused = !note.hidden;
    window.__PONSR_PAUSED__ = false;
    if (recheck) recheck();
    const hiddenWhenOpen = note.hidden;
    checks.push(['the notice follows the chain in both directions',
      shownWhenPaused && hiddenWhenOpen,
      `paused->${shownWhenPaused ? 'shown' : 'HIDDEN'}, open->${hiddenWhenOpen ? 'hidden' : 'SHOWN'}`]);
  }

  // ---------------------------------------------------------------------------
  // WHICH v2 FACTORY THE PAGE ASKS
  //
  // The three checks above all passed while the notice was reading the SUPERSEDED
  // factory, whose launchEnabled is false permanently. So the page told every visitor
  // "pons has new launches switched off platform-wide" -- a false statement about
  // somebody else's product -- and the suite called it correct, because it tested that
  // the notice follows the chain without testing WHICH contract it asks.
  //
  // A test that verifies the wiring but not the destination is how a confident wrong
  // answer survives a green suite.
  // ---------------------------------------------------------------------------
  const CURRENT_V2 = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'.toLowerCase();
  const LEGACY_V2 = '0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8'.toLowerCase();
  const src = html.toLowerCase();

  checks.push(['the current v2 factory is configured', src.includes(CURRENT_V2), CURRENT_V2]);

  // The pause notice must ask the factory pons actually uses.
  const pausedBlock = html.slice(Math.max(0, html.indexOf('SEL_LAUNCH_ENABLED = ')), html.indexOf('function hexToBig'));
  checks.push(['the paused notice asks the CURRENT factory',
    /factoryV2Current, data: SEL_LAUNCH_ENABLED/.test(pausedBlock),
    pausedBlock.includes('CHAIN.factoryV2, data: SEL_LAUNCH_ENABLED') ? 'still asking the superseded factory' : '']);

  // History must stay visible: the superseded factory holds real launches.
  checks.push(['the ledger still reads the superseded factory too',
    src.includes(LEGACY_V2) && /v2Addresses\s*=\s*\[\s*CHAIN\.factoryV2\s*,\s*CHAIN\.factoryV2Current/.test(html),
    'a launch made through it did not stop existing']);

  // The notice must not generalise one contract's gate into a claim about all of pons.
  // It read "switched off platform-wide" while querying the SUPERSEDED factory, so the
  // sentence was an overreach AND false: the deployment pons actually uses was open.
  checks.push(['the notice does not generalise beyond the deployment it queried',
    note ? !/platform-wide|platform wide|all of pons|everywhere/i.test(note.textContent) : false,
    note ? '' : 'no notice']);

  checks.push(['the notice says which scope it speaks for',
    note ? /deployment/i.test(note.textContent) : false,
    note ? note.textContent.replace(/\s+/g, ' ').trim().slice(0, 70) + '…' : '']);

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
