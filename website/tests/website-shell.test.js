/**
 * Regressions for the static shell that the redesign introduced.
 *
 * Two of these exist because the rebuild CREATED risk that did not exist
 * before, and saying so is the point:
 *
 *   - the previous build emitted a 1.3 KB loading shell and assembled every
 *     page in the browser. It could not interpolate anything into markup,
 *     because it had no markup. This build composes HTML from strings, so
 *     token names and symbols now reach a second sink — one an existing test,
 *     which only covers the runtime `textContent` path, cannot see. It is
 *     driven here with genuinely hostile metadata through the REAL build.
 *
 *   - the same shell is why the pages must be checked for a loading string.
 *     "More premium" is a judgement, but "the first paint is the product
 *     rather than the word Loading" is a fact, and facts can be pinned.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const PSTONKS = '0x7803f37e0db73105c47d5a5f3d054a0ae47e2199';

const pages = () => [
  'website/index.html',
  'website/explore/index.html',
  'website/404.html',
  'website/account/index.html',
  'website/account/launches/index.html',
  'website/account/fees/index.html',
  'website/account/wallet/index.html',
  'website/account/security/index.html',
  'website/account/simulator/index.html',
  `website/token/${PSTONKS}/index.html`,
];

test('every built page ships real content, not a loading shell', () => {
  for (const file of pages()) {
    const html = read(file);
    assert.doesNotMatch(html, /Loading verified launch record/, `${file} still ships the loading shell`);
    assert.doesNotMatch(html, /loading-shell/, `${file} still ships the loading shell class`);
    // A real page has a heading and the site chrome, before any script runs.
    assert.match(html, /<h1[ >]/, `${file} has no h1 in the served HTML`);
    assert.match(html, /<nav class="nav">/, `${file} has no navigation in the served HTML`);
    assert.match(html, /<footer class="footer">/, `${file} has no footer in the served HTML`);
    assert.equal(html.match(/<h1[ >]/g).length, 1, `${file} must have exactly one h1`);
  }
});

test('the homepage uses exact production articulated mascot geometry and an official-only showcase', () => {
  const html = read('website/index.html');
  const css = read('website/assets/site.css');
  const app = read('website/assets/app.mjs');
  assert.match(html, /logo-noeyes\.png[^>]+alt="The Ponsr robot"/, 'the production articulated mascot base must be on the homepage');
  assert.match(html, /class="bot"/);
  assert.match(html, /bot-eyes[^>]*>[\s\S]*eye eye-l[\s\S]*eye eye-r/);
  assert.match(css, /\.eye-l\s*\{[^}]*left:\s*34\.5%[^}]*top:\s*55\.9%/i);
  assert.match(css, /\.eye-r\s*\{[^}]*left:\s*65\.4%[^}]*top:\s*55\.9%/i);
  assert.match(css, /\.eye\s*\{[^}]*width:\s*8\.7%[^}]*height:\s*14\.2%/i);
  assert.match(css, /@keyframes eyeBlink/i);
  assert.match(app, /data-bot-eye/);
  // The gaze must be TIGHT. It ran through a 140ms channel, so the pupils
  // visibly trailed the cursor; production applies the move on the same frame.
  // Pinned as a bound, not a magic number.
  const gaze = app.match(/createMotionChannel\(eye,(\d+)\)/);
  assert.ok(gaze, 'the gaze must run through a motion channel');
  assert.ok(Number(gaze[1]) <= 80, `gaze channel is ${gaze[1]}ms; it must stay under 80ms`);
  assert.match(app, /botRect\.bottom<-120\|\|botRect\.top>window\.innerHeight\+120/, 'the gaze must stop when the robot is off-screen');
  assert.match(app, /state\.move\(\{transform:`translate\(calc\(-50%/);
  assert.match(html, /data-official-showcase/);
  assert.match(html, /No official Ponsr token has been published/i);
  assert.doesNotMatch(html, new RegExp(PSTONKS, 'i'));
  assert.doesNotMatch(html, /PONSR STONKS|Generated record art/i);
  assert.doesNotMatch(html, /The first one|ONE REAL CANARY|validation launch|Inspect PSTONKS/i);
});

test('homepage is official-only while Explore lists every verified current-V2 Ponsr launch', () => {
  const home = read('website/index.html');
  const explore = read('website/explore/index.html');
  const token = read(`website/token/${PSTONKS}/index.html`);
  assert.doesNotMatch(home, new RegExp(PSTONKS, 'i'));
  assert.doesNotMatch(home, /PONSR STONKS|PSTONKS/i);
  assert.match(home, /No official Ponsr token has been published/i);
  assert.match(explore, new RegExp(PSTONKS, 'i'));
  assert.match(explore, /PONSR STONKS|PSTONKS/i);
  assert.match(explore, /data-launch-scope="all-verified-v2"/);
  assert.match(explore, /Verified tokens launched through Ponsr/i);
  assert.match(token, /PONSR STONKS/);
  assert.match(token, new RegExp(PSTONKS, 'i'));
  const build = read('scripts/build-website.mjs');
  const app = read('website/assets/app.mjs');
  assert.match(build, /officialLaunches\s*=\s*launches\.filter/);
  assert.match(app, /data-launch-scope/);
  assert.match(app, /all-verified-v2/);
  assert.doesNotMatch(app, /innerHTML/);
});

test('homepage replaces the oversized official campaign with compact identity and substantive product pathways', () => {
  const html = read('website/index.html');
  const css = read('website/assets/site.css');
  assert.match(html, /class="official-identity-strip"[^>]*data-official-showcase/);
  assert.match(html, /Official token status/);
  assert.doesNotMatch(html, /class="official-stage"/);
  assert.match(html, /class="product-pathways"/);
  assert.match(html, /Explore launchpad/);
  assert.match(html, /Account command center/);
  assert.match(html, /Inspect token workstations/);
  assert.match(html, /class="protocol-flow"/);
  for (const step of ['X signal', 'Verified factory', 'Bonding curve', 'Public record']) assert.match(html, new RegExp(step));
  assert.match(css, /@keyframes\s+pathwayPulse/);
  assert.match(css, /@keyframes\s+flowTrace/);
});

test('homepage routes people directly to Explore, dashboard, and verification with premium action hierarchy', () => {
  const html = read('website/index.html');
  const css = read('website/assets/site.css');
  assert.match(html, /class="btn btn-primary home-action" href="\/explore"[^>]*data-home-action="explore"/);
  assert.match(html, />\s*Explore launches\s*</);
  assert.match(html, /class="btn btn-secondary home-action" href="\/account"[^>]*data-home-action="dashboard"/);
  assert.match(html, />\s*Open dashboard\s*</);
  assert.match(html, /href="#verification-policy"[^>]*data-home-action="verification"/);
  assert.match(html, /Browse verified launches/);
  assert.match(css, /\.home-action\s*\{[^}]*min-height:\s*52px/s);
  assert.match(css, /\.btn-secondary/);
  assert.match(css, /\.action-icon/);
});

test('Explore is a compact launchpad grid with truthful sortable discovery controls', () => {
  const html = read('website/explore/index.html');
  const css = read('website/assets/site.css');
  const app = read('website/assets/app.mjs');
  for (const sort of ['recent-buys', 'newest', 'oldest', 'market-cap']) {
    assert.match(html, new RegExp(`data-launch-sort="${sort}"`));
  }
  assert.match(html, /aria-pressed="true" data-launch-sort="recent-buys"/);
  assert.match(html, /Recent canonical buys · last-known snapshot/);
  assert.match(html, /data-launch-count/);
  assert.match(html, /data-card-market-cap/);
  assert.match(html, /Market cap unavailable/i);
  assert.match(html, /data-card-relative-time/);
  assert.match(html, /data-protocol-badge>V2</);
  assert.match(css, /\.launchpad-shell\s*\{[^}]*width:\s*min\(1040px,/s);
  assert.match(css, /\.launchpad-grid\s*\{[^}]*grid-template-columns:\s*repeat\(5,/s);
  assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*\.launchpad-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(css, /\.launchpad-media\s*\{[^}]*aspect-ratio:\s*1/s);
  assert.match(css, /@media\s*\(pointer:\s*coarse\)[\s\S]*\.launchpad-bottom button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.activity-tabs button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(html, /data-copy-label role="status" aria-live="polite"/);
  assert.match(app, /latestCanonicalBuyTime/);
  assert.match(app, /URLSearchParams/);
  assert.match(app, /sortLaunchpad/);
  assert.match(app, /market-cap[^\n]+marketCapUsd/s);
  assert.match(app, /params\.get\('q'\)/);
  assert.match(app, /params\.set\('q'/);
  assert.match(app, /addEventListener\('popstate'/);
  assert.match(app, /Last-known records · live source error/);
  assert.match(app, /Last-known snapshot · source not live/);
  assert.match(app, /paintLaunchpad\(feed,state\)/);
  assert.doesNotMatch(html, /FDV[^<]*MCAP|reserve[^<]*MCAP/i);
});

test('premium environment has layered cursor-reactive depth and bounded reduced motion', () => {
  const html = read('website/index.html');
  const css = read('website/assets/site.css');
  const app = read('website/assets/app.mjs');
  for (const hook of ['ambient-stars', 'ambient-aurora', 'ambient-beam', 'cursor-glow', 'hero-stage']) assert.match(html, new RegExp(hook));
  // `\b` inside a template literal is a BACKSPACE character, not a word
  // boundary, so this silently matched nothing until it was escaped.
  for (const keyframe of ['auroraDrift', 'starDrift', 'beamSweep', 'heroStageBreathe', 'botFloat']) assert.match(css, new RegExp(`@keyframes ${keyframe}\\b`));
  assert.match(app, /data-cursor-glow/);
  assert.match(app, /pointer:\s*fine/);
  assert.match(app, /\.animate\(/);
  assert.match(app, /rect\.top<innerHeight&&rect\.bottom>0[^\n]+reveal-immediate/);
  assert.match(css, /\.ready \.reveal\.reveal-immediate\s*\{[^}]*transition:\s*none/);
  assert.doesNotMatch(app, /\.style\.|setAttribute\(['"]style/);
  assert.match(css, /\.ambient\s*\{[^}]*position:\s*fixed[^}]*height:\s*auto/s);
  assert.match(css, /animation-timeline:\s*scroll\(root block\)/);
  assert.match(css, /@keyframes\s+scrollProgress/);
  assert.doesNotMatch(app, /function wireScrollProgress/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('generated record art never breaks a ticker and preview toolbar cannot cover product content', () => {
  const css = read('website/assets/site.css');
  assert.match(css, /\.token-art\s*\{[^}]*container-type:\s*inline-size/i);
  assert.match(css, /\.token-art \.art-symbol\s*\{[^}]*white-space:\s*nowrap/i);
  assert.match(css, /font-size:\s*clamp\([^;]*cqi/i);
  assert.match(css, /body\s*>\s*div\[data-netlify-deploy-id\]\[data-netlify-site-id\]\s*\{[^}]*display:\s*none\s*!important/i);
  assert.match(css, /@media\s*\(pointer:\s*coarse\)[\s\S]*\.brand\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/i);
  assert.doesNotMatch(css, /iframe\s*\{[^}]*display:\s*none/i);
});

test('token detail opens as a compact market workstation with external chart and dense activity tabs', () => {
  const html = read(`website/token/${PSTONKS}/index.html`);
  const app = read('website/assets/app.mjs');
  assert.match(html, /token-workstation/);
  assert.match(html, /token-identity-strip/);
  assert.match(html, /Deployed by/i);
  assert.match(html, /data-copy-address/);
  assert.match(html, /geckoterminal\.com\/robinhood\/tokens\//i);
  assert.match(html, /class="[^"]*gecko-chart-shell[^"]*"/);
  assert.match(html, /<iframe[^>]+geckoterminal\.com\/robinhood\/tokens\/0x7803f37e0db73105c47d5a5f3d054a0ae47e2199\?embed=1&amp;info=0&amp;swaps=0/i);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /referrerpolicy="strict-origin-when-cross-origin"/);
  assert.match(html, /allow="clipboard-write"/);
  assert.doesNotMatch(html, /class="market-chart"|data-market-line|data-market-area/);
  assert.doesNotMatch(app, /function marketPath|ohlcvTimeRange/);
  assert.match(read('netlify.toml'), /frame-src https:\/\/www\.geckoterminal\.com/);
  assert.match(app, /paintCanonicalTrades\(token\)/, 'the activity tab must be fed by canonical CurveBuy\/CurveSell events');

  assert.doesNotMatch(app, /data-market-trades[\s\S]{0,1200}market\.trades\.slice/, 'external provider trades must not replace canonical curve activity');
  assert.equal((html.match(/<iframe/gi)||[]).length, 1, 'the only iframe is the exact GeckoTerminal token chart');
  assert.match(html, /data-activity-tab="trades"/);
  assert.doesNotMatch(html, /Waiting for canonical CurveBuy \/ CurveSell activity/);
  assert.match(html, /data-trade-count>4</);
  assert.match(html, /Quote in \+0\.001485 ETH/);
  assert.match(html, /Quote out −0\.009846393619747925 ETH/);
  assert.match(html, /class="inspect-grid token-dossier"/);
  assert.match(html, /Origin &amp; contracts/);
  assert.match(html, /Launch record/);
  assert.match(html, /class="dossier-index">01</);
  assert.match(html, /Last observed curve state/);
  assert.match(html, /Verified chain references/);
  assert.match(html, /Claim path unvalidated/);
  assert.match(html, /3 buys · 1 sell/);
  assert.doesNotMatch(html, /undefined/);
  assert.match(html, /class="reserve-metric-grid"/);
  assert.match(html, /class="observation-grid"/);
  assert.match(html, /data-reserve-metrics/);
  assert.match(html, /data-activity-observation/);
  assert.match(app, /reserve-metric-grid/);
  assert.match(app, /observation-grid/);
  assert.match(html, /data-activity-tab="holders"/);
  assert.match(html, /data-activity-tab="transfers"/);
  assert.match(html, /role="tab"[^>]*aria-controls="activity-panel-/);
  assert.match(html, /role="tabpanel"[^>]*aria-labelledby="activity-tab-/);
  assert.match(html, /tabindex="-1"/);
  assert.match(html, /Canonical Ponsr ledger/i);
  assert.doesNotMatch(html, /fake holder|placeholder image/i);
});

test('account routes share a premium command-center shell with route-specific workspace hierarchy', () => {
  const css = read('website/assets/site.css');
  for (const path of pages().filter((file) => file.includes('/account/'))) {
    const html = read(path);
    assert.match(html, /class="account-command-shell"/);
    assert.match(html, /class="account-sidebar"/);
    assert.match(html, /class="account-workspace"/);
    assert.match(html, /data-account-route=/);
    assert.match(html, /class="account-route-head"/);
    assert.match(html, /class="custody-boundary"/);
    assert.match(html, /href="\/account" aria-current="page">Account<\/a>/);
  }
  assert.match(css, /\.account-command-shell\s*\{[^}]*grid-template-columns:\s*250px\s+minmax\(0,1fr\)/s);
  assert.match(css, /\.account-sidebar/);
  assert.match(css, /\.account-workspace/);
  assert.match(css, /\.account-route-head/);
  assert.match(css, /@keyframes\s+accountRailScan/);
  assert.match(css, /@media\s*\(max-width:\s*820px\)[\s\S]*\.account-command-shell\s*\{[^}]*grid-template-columns:\s*1fr/s);
});

test('account routes are complete signed-out product surfaces with no invented identity or money', () => {
  const files = pages().filter((file) => file.includes('/account/'));
  assert.equal(files.length, 6);
  for (const file of files) {
    const html = read(file);
    const account = html.match(/<main class="account-shell"[\s\S]*?<\/main>/)?.[0] || '';
    assert.match(account, /data-auth-state="signed-out"/);
    assert.match(account, /data-identity-state="unavailable"/);
    assert.match(account, /data-private-data-state="locked"/);
    assert.match(account, /data-execution-authority="NONE_PREVIEW_ONLY"/);
    for (const capability of ['sign','send','swap','claim']) assert.match(account, new RegExp(`data-can-${capability}="false"`));
    assert.match(account, /Account connection unavailable/i, `${file} does not disclose the auth boundary`);
    assert.match(account, /disabled[^>]*aria-disabled="true"|aria-disabled="true"[^>]*disabled/i, `${file} enables an unavailable account action`);
    // The rule is "no INVENTED account data", and an address carried by the
    // canonical public snapshot is the opposite of invented. Whitelisting one
    // hardcoded token made this fail the moment a second real launch appeared,
    // which is a test aging into a false alarm rather than a defect found.
    let accountWithoutVerifiedPublicLaunch = account;
    for (const launch of JSON.parse(read('website/data/launches.json')).launches) {
      // Both forms: the snapshot may carry a checksummed address while the
      // build writes hrefs in lower case.
      for (const form of new Set([String(launch.token), String(launch.token).toLowerCase()])) {
        accountWithoutVerifiedPublicLaunch = accountWithoutVerifiedPublicLaunch.replaceAll(
          form,
          'VERIFIED_PUBLIC_TOKEN'
        );
      }
    }
    assert.doesNotMatch(accountWithoutVerifiedPublicLaunch, /@[a-z0-9_]+|0x[a-f0-9]{40}|\$\d|\b\d+(?:\.\d+)?\s*ETH\b/i, `${file} contains invented account data`);
    assert.doesNotMatch(account, /demo account|sample balance|mock transaction|fake/i, `${file} publishes demo-shaped user data`);
  }
  const simulator = read('website/account/simulator/index.html');
  assert.match(simulator, /data-account-simulator-launches/);
  const app = read('website/assets/app.mjs');
  assert.match(app, /paintAccountSimulator\(feed,state\)/);
  assert.match(app, /account\.dataset\.publicSourceState=state\.kind/);
});

test('account architecture exposes the five agreed routes and separates financial states', () => {
  const overview = read('website/account/index.html');
  const fees = read('website/account/fees/index.html');
  const wallet = read('website/account/wallet/index.html');
  for (const href of ['/account', '/account/launches', '/account/fees', '/account/wallet', '/account/security']) {
    assert.ok(overview.includes(`href="${href}"`), `account navigation is missing ${href}`);
  }
  assert.match(fees, /Accrued/i);
  assert.match(fees, /Claimable/i);
  assert.match(fees, /Queued|Processing/i);
  assert.match(fees, /Paid|Claimed/i);
  assert.match(wallet, /Receive/i);
  assert.match(wallet, /Send/i);
  assert.match(wallet, /Swap/i);
  assert.match(wallet, /exact existing embedded wallet/i);
});

test('Phase B contract pins numeric X identity, one existing wallet, and session/linking controls', () => {
  const contract = read('docs/account-phase-b-contract.md');
  assert.match(contract, /numeric X user ID/i);
  assert.match(contract, /existing Privy embedded wallet/i);
  assert.match(contract, /never create a second wallet/i);
  assert.match(contract, /CSRF/i);
  assert.match(contract, /nonce/i);
  assert.match(contract, /replay/i);
  assert.match(contract, /logout/i);
  assert.match(contract, /receipt/i);
  assert.match(contract, /reconcil/i);
  assert.match(contract, /private key/i);
});

test('Phase B browser activation remains server-gated and read-only', () => {
  const app=read('website/assets/app.mjs'),build=read('scripts/build-website.mjs'),netlify=read('netlify.toml');
  assert.match(app,/\/api\/ready/);assert.match(app,/\/api\/account\/session/);assert.match(app,/\/api\/auth\/x\/start/);assert.match(app,/\/api\/auth\/logout/);
  assert.match(app,/executionAuthority='NONE_PREVIEW_ONLY'/);assert.match(build,/data-can-sign="false"/);assert.match(build,/data-can-send="false"/);assert.match(build,/data-can-swap="false"/);assert.match(build,/data-can-claim="false"/);
  assert.doesNotMatch(app,/eth_sendTransaction|wallet_addEthereumChain|personal_sign|eth_signTypedData/);
  assert.match(netlify,/from\s*=\s*"\/api\/\*"[\s\S]*ponsr-backend\.fly\.dev\/api\/:splat/);
});

test('a three-launch current-V2 snapshot builds a newest-first collection and one canonical route per token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-multi-launch-'));
  const site = path.join(dir, 'website');
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.mkdirSync(path.join(site, 'content'), { recursive: true });
  fs.writeFileSync(path.join(site, 'content/terms.body.html'), read('website/content/terms.body.html'));

  const snapshot = JSON.parse(read('website/data/launches.json'));
  const base = snapshot.launches[0];
  const launches = [
    { ...base, officialPonsr: true, token: '0x0000000000000000000000000000000000000001', name: 'First Launch', symbol: 'FIRST', blockNumber: 100, blockTimestamp: '2026-08-27T10:00:00.000Z', transactionHash: `0x${'1'.repeat(64)}` },
    { ...base, officialPonsr: true, token: '0x0000000000000000000000000000000000000002', name: 'Newest Launch', symbol: 'NEW', logo: 'https://pbs.twimg.com/media/AbCd1234.jpg', description: 'Exact launch description.', blockNumber: 300, blockTimestamp: '2026-08-27T12:00:00.000Z', transactionHash: `0x${'2'.repeat(64)}` },
    { ...base, officialPonsr: true, token: '0x0000000000000000000000000000000000000003', name: 'Middle Launch', symbol: 'MID', blockNumber: 200, blockTimestamp: '2026-08-27T11:00:00.000Z', transactionHash: `0x${'3'.repeat(64)}` },
  ];
  fs.writeFileSync(path.join(site, 'data/launches.json'), JSON.stringify({ ...snapshot, launches }));
  execFileSync(process.execPath, [path.join(root, 'scripts/build-website.mjs')], { cwd: dir, stdio: 'pipe' });

  const home = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  const explore = fs.readFileSync(path.join(site, 'explore/index.html'), 'utf8');
  assert.match(home, /Newest Launch/);
  assert.doesNotMatch(home, /Middle Launch|First Launch/);
  assert.ok(explore.indexOf('Newest Launch') < explore.indexOf('Middle Launch'));
  assert.ok(explore.indexOf('Middle Launch') < explore.indexOf('First Launch'));
  assert.match(explore, /data-launch-search/);
  assert.match(explore, /<img src="https:\/\/pbs\.twimg\.com\/media\/AbCd1234\.jpg" alt="Newest Launch token image"/);
  const newest=fs.readFileSync(path.join(site,'token',launches[1].token.toLowerCase(),'index.html'),'utf8');
  assert.match(newest,/Exact launch description\./);assert.match(newest,/data-token-description/);
  assert.doesNotMatch(newest,/Token image unavailable for NEW/);
  for (const launch of launches) {
    assert.ok(fs.existsSync(path.join(site, 'token', launch.token.toLowerCase(), 'index.html')));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dynamic post-build launches receive the same data workstation contracts', () => {
  const app=read('website/assets/app.mjs');
  assert.match(app,/dynamicWorkstation/);assert.match(app,/dataset\.marketTerminal/);assert.match(app,/dataset\.whatIfSimulator/);assert.match(app,/geckoterminal\.com\/robinhood\/tokens/);
  assert.match(app,/aria-describedby/);assert.match(app,/aria-invalid/);assert.match(app,/aria-live/);
  const css=read('website/assets/site.css');
  assert.match(css,/\.dynamic-token-panel \.token-art\s*\{[^}]*aspect-ratio:\s*1\.6/s);
  assert.match(css,/\.token-description\s*\{[^}]*text-wrap:\s*pretty[^}]*hyphens:\s*none/s);
});

test('unknown future current-V2 addresses resolve to a dynamic inspector shell, while known pages remain prebuilt', () => {
  assert.ok(fs.existsSync(path.join(root, `website/token/${PSTONKS}/index.html`)));
  assert.ok(fs.existsSync(path.join(root, 'website/token/index.html')));
  const shell = read('website/token/index.html');
  assert.match(shell, /data-dynamic-token-page/);
  assert.match(shell, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(read('netlify.toml'), /from\s*=\s*"\/token\/\*"[\s\S]*to\s*=\s*"\/token\/index\.html"/);
});

test('a static build never publishes freshness or an open gate it has not observed', () => {
  // The build has observed nothing about right now. It may only ship the
  // pessimistic state; JavaScript upgrades it after actually reading a feed.
  for (const file of pages().filter((f) => !f.endsWith('404.html'))) {
    const html = read(file);
    if (!html.includes('data-status-strip')) continue;
    assert.match(html, /class="status-strip state-stale"/, `${file} ships a state it did not observe`);
    assert.match(html, /Last-known-good snapshot/);
    assert.match(html, /Ponsr launch tooling paused/);
    assert.doesNotMatch(html, /state-complete/, `${file} claims a complete source at build time`);
    assert.doesNotMatch(html, /synced just now|Live now/i);
  }
});

test('true not-found is its own page, distinct from empty and from failure', () => {
  const html = read('website/404.html');
  assert.match(html, /Not on the record/);
  // It must not imply the source failed, and must not imply nothing has launched.
  assert.doesNotMatch(html, /could not be read|source failed/i);
  assert.match(html, /different from a launch we could not read/i);
});

test('no inline style attribute or inline script survives, so the CSP stays strict', () => {
  // style-src 'self' blocks style="" attributes as well as <style> blocks, and
  // a page that silently loses its styling is worse than one that fails loudly.
  for (const file of pages()) {
    const html = read(file);
    assert.doesNotMatch(html, /\sstyle="/, `${file} carries an inline style attribute`);
    assert.doesNotMatch(html, /<style[ >]/, `${file} carries an inline style block`);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/, `${file} carries an inline script`);
  }
  assert.match(read('netlify.toml'), /style-src 'self'/);
});

test('every published token URL uses immutable lowercase contract-address identity', () => {
  const addressRoute = /^\/token\/0x[a-f0-9]{40}\/?(?:[?#][^\s"<>]*)?$/;
  for (const file of pages()) {
    const html = read(file);
    for (const match of html.matchAll(/href="(\/token\/[^"]+)"/g)) assert.match(match[1], addressRoute, `${file}: ${match[1]}`);
    for (const match of html.matchAll(/https:\/\/ponsr\.fun(\/token\/[^"]+)/g)) assert.match(match[1], addressRoute, `${file}: ${match[1]}`);
  }
  const sitemap = read('website/sitemap.xml');
  for (const match of sitemap.matchAll(/https:\/\/ponsr\.fun(\/token\/[^<]+)/g)) assert.match(match[1], addressRoute);
  assert.match(read('website/assets/app.mjs'), /\/token\/\$\{String\(token\.token\)\.toLowerCase\(\)\}/);
  assert.match(read('scripts/build-website.mjs'), /\/token\/\$\{esc\(token\.token\.toLowerCase\(\)\)\}/);
});

test('every public product route uses a real 1200x630 route-aware social card', () => {
  const build = read('scripts/build-website.mjs');
  assert.match(build, /process\.env\.DEPLOY_PRIME_URL/);
  assert.match(build, /process\.env\.URL/);
  const expected = [
    ['website/index.html', '/social/home.png'],
    ['website/explore/index.html', '/social/explore.png'],
    ['website/account/index.html', '/social/account.png'],
    [`website/token/${PSTONKS}/index.html`, `/social/token-${PSTONKS}.png`],
  ];
  for (const [file, image] of expected) {
    const html = read(file);
    assert.match(html, new RegExp(`<meta property="og:image" content="https://ponsr\\.fun${image.replaceAll('/', '\\/')}"`));
    assert.match(html, /<meta property="og:image:width" content="1200">/);
    assert.match(html, /<meta property="og:image:height" content="630">/);
    assert.match(html, new RegExp(`<meta name="twitter:image" content="https://ponsr\\.fun${image.replaceAll('/', '\\/')}"`));
    const png = path.join(root, 'website', image.slice(1));
    assert.ok(fs.existsSync(png), `${image} was not generated`);
    const bytes = fs.readFileSync(png);
    assert.equal(bytes.toString('ascii', 1, 4), 'PNG');
    assert.equal(bytes.readUInt32BE(16), 1200);
    assert.equal(bytes.readUInt32BE(20), 630);
  }
  assert.notEqual(fs.readFileSync(path.join(root, 'website/social/home.png')).toString('hex'), fs.readFileSync(path.join(root, `website/social/token-${PSTONKS}.png`)).toString('hex'));
});

test('the build escapes hostile token metadata into text, not markup', () => {
  // The real build, on a real hostile snapshot, in a throwaway tree.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-build-'));
  const site = path.join(dir, 'website');
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.mkdirSync(path.join(site, 'content'), { recursive: true });
  // The build reads the hand-written terms body; the throwaway tree needs it too.
  fs.writeFileSync(path.join(site, 'content/terms.body.html'), read('website/content/terms.body.html'));

  const snapshot = JSON.parse(read('website/data/launches.json'));
  const hostile = {
    ...snapshot.launches[0],
    officialPonsr: true,
    name: '<img src=x onerror=alert(1)>',
    symbol: '"><script>alert(2)</script>',
    pairLabel: "' onmouseover='alert(3)",
  };
  fs.writeFileSync(
    path.join(site, 'data/launches.json'),
    JSON.stringify({ ...snapshot, launches: [hostile] })
  );

  execFileSync(process.execPath, [path.join(root, 'scripts/build-website.mjs')], { cwd: dir, stdio: 'pipe' });

  const built = [
    path.join(site, 'index.html'),
    path.join(site, 'explore/index.html'),
    path.join(site, 'token', String(hostile.token).toLowerCase(), 'index.html'),
  ];
  for (const file of built) {
    const html = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(html, /<img src=x onerror/, `${file} rendered hostile metadata as markup`);
    assert.doesNotMatch(html, /<script>alert\(2\)/, `${file} rendered a hostile symbol as markup`);
    assert.doesNotMatch(html, /onmouseover='alert\(3\)/, `${file} rendered a hostile label into an attribute`);
    // The value must still be PRESENT — escaped, not silently dropped.
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    // And the only script tag on the page is still the module the shell loads.
    assert.equal(html.match(/<script/g).length, 1, `${file} gained a script tag`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('V1 history is absent from every public surface and retained in the docs', () => {
  const V1_FACTORY = '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb';
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
  const publicText = walk(path.join(root, 'website'))
    .filter((file) => /\.(?:html|m?js|json|xml|txt)$/.test(file) && !file.includes(`${path.sep}tests${path.sep}`))
    .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(publicText, new RegExp(V1_FACTORY, 'i'), 'a V1 factory address reached a public surface');

  // Absent publicly is only half the requirement: the evidence must survive.
  const doc = read('docs/v1-historical-launches.md');
  assert.match(doc, new RegExp(V1_FACTORY, 'i'));
  assert.match(doc, /public|website|exclu/i);
});
