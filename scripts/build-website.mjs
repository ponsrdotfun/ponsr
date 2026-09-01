/**
 * Builds the static website from the canonical launch snapshot.
 *
 * WHY THE PAGES ARE NOW REAL RATHER THAN SHELLS
 * ---------------------------------------------
 * The previous build emitted a 1.3 KB shell whose entire body was
 * "Loading verified launch record…", and `app.mjs` replaced it on boot. Three
 * things followed, and all three were the reason the design read as an
 * internal console rather than a product:
 *
 *   1. the first thing a visitor saw was a loading string;
 *   2. anyone without JS, and every crawler that does not execute it, saw
 *      nothing but that string;
 *   3. the markup could not be reviewed or tested as HTML, only as DOM built
 *      at runtime.
 *
 * Now each route ships complete, readable HTML built from the verified
 * snapshot, and `app.mjs` refreshes the data-bound parts in place.
 *
 * THE ONE HONESTY RULE THAT SHAPES THIS FILE
 * ------------------------------------------
 * A static build cannot know whether the chain source is healthy right now, so
 * every page ships marked `stale` — "Last-known-good snapshot" — and the public
 * gate ships as whatever the snapshot last verified, which is `false`.
 * JavaScript may only ever UPGRADE that after it has actually read the feed.
 * A build can never publish freshness it has not observed, and a page whose JS
 * fails degrades to a true statement rather than a flattering one.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
// One design, shared with the on-demand card endpoint so a link's preview cannot
// change the next time the site happens to redeploy.
import { socialSvg, tokenCardSvg } from '../netlify/functions/lib/socialCard.mjs';
import { tokenArtDataUri } from '../netlify/functions/lib/tokenArt.mjs';

/** Spread the picture and the proportions it kept, or nothing at all. */
const artFields = (art) => (art ? { artHref: art.href, artAspect: art.aspect } : {});
import { useVendoredFonts } from '../netlify/functions/lib/fonts.mjs';
import { launchpadCard as launchpadCardModel, curveProgress, tokenArt as tokenArtModel, trustedLogoUrl } from '../website/assets/cards.mjs';
import { h, toHtml, escapeHtml } from '../website/assets/markup.mjs';
import { activityLine, amountFromWei, curveFlowSeries, ethFromWei, eventTime, plural, quoteName, quoteUnit, reserveRows, shortAddress, whole } from '../website/assets/format.mjs';

const site = path.join(process.cwd(), 'website');
const feed = JSON.parse(await fs.readFile(path.join(site, 'data/launches.json'), 'utf8'));

/**
 * The bot's handle, in one place.
 *
 * It was a literal in the footer and nowhere else on the page -- so the product
 * whose entire interface is "tag this account" never printed the account except
 * as a link captioned "Registry updates". Now that it appears in the
 * instructions, the example request and the paused note, one source is the
 * difference between renaming an account and hunting for its spellings.
 */
const X_HANDLE = 'ponsrdotfun';

const EXPLORER = 'https://robinhoodchain.blockscout.com';
// Named here rather than inlined: both are deployment identity, and a wrong one
// would be a confident link to the wrong contract.
const ESCROW_ADDRESS = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e';
const DEPLOYER_ADDRESS = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const ZERO = '0x0000000000000000000000000000000000000000';

const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

// Before the first render: fontconfig reads its configuration once. The build
// container has fonts of its own, but using ours is what makes the build-time
// card and the on-demand card the same image.
if (!useVendoredFonts()) console.warn('[build] vendored fonts not found; cards fall back to system faces');

const socialDir = path.join(site, 'social');
await fs.mkdir(socialDir, { recursive: true });
/**
 * PRODUCTION MUST NOT ADVERTISE A PREVIEW DOMAIN.
 *
 * This read `DEPLOY_PRIME_URL || URL`, and Netlify sets BOTH on a production
 * deploy: `URL` is the canonical site (https://ponsr.fun) while
 * `DEPLOY_PRIME_URL` is that deploy's own subdomain. Preferring the latter meant
 * every live page advertised `og:image` on `main--ponsr.netlify.app`, so a link
 * shared from ponsr.fun unfurled with an image hosted somewhere else -- measured
 * on the production token page before this fix.
 *
 * `CONTEXT` is the field that actually answers the question, so it decides:
 * production uses the canonical URL, and a preview keeps pointing at itself so
 * its own cards still resolve.
 */
const socialOrigin = (() => {
  try {
    const preferred = process.env.CONTEXT === 'production'
      ? process.env.URL || process.env.DEPLOY_PRIME_URL
      : process.env.DEPLOY_PRIME_URL || process.env.URL;
    const url = new URL(preferred || 'https://ponsr.fun');
    if (url.protocol !== 'https:') throw new Error('social origin must use HTTPS');
    return url.origin;
  } catch {
    return 'https://ponsr.fun';
  }
})();
let socialMascot = '';
try {
  const logo = await fs.readFile(path.join(site, 'logo-transparent.png'));
  socialMascot = `data:image/png;base64,${logo.toString('base64')}`;
} catch {
  // Throwaway test builds intentionally copy only canonical data/content. The
  // card still renders deterministically there; production builds add the exact
  // original mascot asset.
}


async function socialCard(file, data) {
  const output = path.join(socialDir, file);
  // Netlify must publish the exact reviewed Git bytes. Native libvips builds can
  // produce visually equivalent but byte/pixel-different PNGs across images.
  // Local/CI builds still regenerate below and prove those committed bytes.
  if (process.env.NETLIFY === 'true') {
    try { await fs.access(output); return `/social/${file}`; } catch { /* generate a missing test-only card */ }
  }
  await sharp(Buffer.from(data.svg ?? socialSvg({ ...data, mascotHref: socialMascot }))).png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(output);
  return `/social/${file}`;
}

const socialImages = {
  home: await socialCard('home.png', { eyebrow: 'Current V2 · Robinhood Chain', title: 'Every launch,\non the record.', detail: 'Verified launch records. No invented market data.', badge: 'ponsr.fun' }),
  explore: await socialCard('explore.png', { eyebrow: 'The public record', title: 'Every verified\nPonsr launch.', detail: 'Factory, curve, block, event time, and source state.', badge: 'Explore launches' }),
  account: await socialCard('account.png', { eyebrow: 'Account unavailable', title: 'Your launches.\nYour wallet.', detail: 'Secure X and existing-wallet access is not yet enabled.', badge: 'Public preview', detailSize: 27 }),
  tokens: new Map(),
};
for (const token of feed.launches) {
  const address = String(token.token).toLowerCase();
  // The token's own card: symbol first, because that is what a reader
  // recognises in a feed, with the pair asset and contract as evidence.
  socialImages.tokens.set(address, await socialCard(`token-${address}.png`, {
    svg: tokenCardSvg({
      symbol: token.symbol,
      name: token.name,
      pairLabel: token.pairLabel,
      address: token.token,
      mascotHref: socialMascot,
      ...artFields(await tokenArtDataUri(token.logo)),
    }),
  }));
}

/** An address cell that links to the explorer, or plain text when absent. */
const addressCell = (value, kind = 'address') => (value
  ? `<a class="text-link" href="${EXPLORER}/${kind}/${esc(value)}" target="_blank" rel="noopener noreferrer">${esc(shortAddress(value))}</a>`
  : 'Not published');

/**
 * A block number is a number, not an address.
 *
 * This shipped once as `47693658…693658`, because the block was passed through
 * the address cell and truncated by `shortAddress`. Abbreviation belongs to
 * things that are long and opaque; a block height is neither.
 */
const blockCell = (value) => (value
  ? `<a class="text-link" href="${EXPLORER}/block/${esc(value)}" target="_blank" rel="noopener noreferrer">${esc(whole(value))}</a>`
  : 'Not published');


const facts = (rows) => `<dl class="facts">${rows
  .map(([label, value]) => `<div class="fact"><dt>${esc(label)}</dt><dd>${value}</dd></div>`)
  .join('')}</dl>`;

function nav(current) {
  /**
   * Current means "this page, or a page under it", compared on normalised paths.
   *
   * The rule used to be a string match against '/account'. When the links were
   * corrected to name the URL that is actually served -- `/account/`, because
   * the page is a directory with an index -- that comparison stopped matching
   * and every account page silently lost its nav highlight. A trailing slash is
   * a serving detail; it must not be able to switch behaviour off.
   */
  const withoutSlash = (path) => (path.length > 1 ? path.replace(/\/+$/, '') : path);
  const link = ([label, href]) => {
    const here = withoutSlash(current), target = withoutSlash(href);
    const active = here === target || (target !== '/' && here.startsWith(`${target}/`)) ? ' aria-current="page"' : '';
    return `<a href="${href}"${active}>${esc(label)}</a>`;
  };
  return `<nav class="nav"><div class="nav-inner">` +
    `<a class="brand" href="/"><img src="/logo-transparent.png" alt="" width="32" height="32"><span>PONSR</span></a>` +
    `<div class="nav-links">${[['Home', '/'], ['Explore', '/explore/'], ['Account', '/account/']].map(link).join('')}</div>` +
    `</div></nav>`;
}

/**
 * THE BUILD MAY ONLY EVER SHIP THE CLOSED GATE.
 *
 * Not "the gate as the snapshot found it" — the closed one, always. A built page
 * is cached by Netlify, by browsers and by X's crawler, so it outlives whatever
 * was true when it was written. Baking `open` into it means that the moment the
 * gate closes, a stale copy invites requests that will be refused; baking
 * `paused` can only ever understate, and the client raises it within a frame of
 * reading a feed.
 *
 * This was written as `feed.publicGate.enabled ? … : …` in three places, and the
 * two tests guarding the rule could not see it: the snapshot's gate had never
 * been `true`, so the pessimistic branch was the only one they ever ran. When it
 * did turn true on 2026-09-02 the build immediately published an open gate on
 * every page.
 */
const BUILD_GATE_ENABLED = false;

/**
 * THE REQUEST, DESCRIBED ONCE.
 *
 * It appears twice on the landing page -- beside the hero, where somebody
 * arriving from X sees it without scrolling, and again in the how-to section
 * where it is explained. Twice on screen, once in source: this repository has
 * already paid for a component described by two producers, and four visible
 * defects in one day came out of it.
 *
 * The copy button carries `data-copy-text` rather than an address, because
 * `wireCopyButtons` refuses anything that is not 40 hex characters and a tweet
 * is not one. That guard is not weakened here; a second, explicit path exists.
 */
const REQUEST_TEXT = `@${X_HANDLE} launch a token called Micro Duck, symbol MICRODUCK`;

function requestLine() {
  return `<span class="howto-mention">@${esc(X_HANDLE)}</span> launch a token called Micro Duck, symbol MICRODUCK`;
}

function copyRequestButton(label) {
  return `<button class="btn btn-ghost howto-copy" type="button" data-copy-text="${esc(REQUEST_TEXT)}">${esc(label)}</button>`;
}

/**
 * Always the closed state -- see BUILD_GATE_ENABLED above. Every copy of this
 * note carries `data-howto-gate`, and the client raises all of them together.
 */
function gateNote(extraClass = '') {
  return `<p class="note howto-gate${extraClass ? ` ${extraClass}` : ''}" data-howto-gate><strong>${BUILD_GATE_ENABLED ? 'Open now' : 'Paused right now'}</strong>` +
    `${BUILD_GATE_ENABLED
      ? 'Requests are being read. Post the tweet and Ponsr will answer it.'
      : `New launches are paused, so a request will not be answered yet. Follow <a href="https://x.com/${esc(X_HANDLE)}" target="_blank" rel="noopener noreferrer">@${esc(X_HANDLE)}</a> — that is where it is announced when they open.`}</p>`;
}

/**
 * Ships `stale`. See the honesty rule at the top of this file — the build has
 * observed nothing about right now, and says so.
 */
function statusStrip() {
  return `<section class="status-strip state-stale" data-status-strip aria-live="polite">` +
    `<span class="group"><span class="dot"></span><strong data-status-label>Last-known-good snapshot</strong></span>` +
    `<span class="sep" aria-hidden="true">·</span>` +
    `<span class="detail" data-status-detail>Registry snapshot through block ${esc(whole(feed.asOfBlock))}</span>` +
    `<span class="sep" aria-hidden="true">·</span>` +
    `<span class="gate-pill" data-gate-pill>Ponsr launch tooling ${BUILD_GATE_ENABLED ? 'open' : 'paused'}</span>` +
    `<span class="gate" data-gate-message>${esc(gateMessage(BUILD_GATE_ENABLED))}</span>` +
    `</section>`;
}

/** Kept identical in wording to `data-state.mjs`, which the tests pin. */
const gateMessage = (enabled) => (enabled
  ? 'Ponsr launch tooling is accepting public requests.'
  : 'Creation of new launches through Ponsr is paused; existing records remain available.');

function footer() {
  return `<footer class="footer"><div class="footer-inner">` +
    `<div class="footer-top"><strong>PONSR</strong><span class="lede">Launches recorded from the chain, and nothing that is not.</span></div>` +
    `<div class="footer-links">` +
      `<a href="https://ponsfamily.com" target="_blank" rel="noopener noreferrer">pons ↗</a>` +
      `<a href="https://x.com/${esc(X_HANDLE)}" target="_blank" rel="noopener noreferrer">@${esc(X_HANDLE)} ↗</a>` +
      `<a href="/terms">Terms</a>` +
    `</div>` +
    `<p class="footer-note">Ponsr is independent. It is not operated by, affiliated with, or endorsed by pons, Robinhood, or X. ` +
    `Launch records are observations — not recommendations, prices, or valuations.</p>` +
    `</div></footer>`;
}

/** The mascot, with the pieces app.mjs animates. Decorative throughout. */
function mascot() {
  return `<div class="hero-stage" data-hero-stage><div class="bot" data-bot>` +
    `<span class="bot-halo" aria-hidden="true"></span>` +
    `<svg class="bot-gauge" viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="96" fill="none" stroke="rgba(196,205,218,0.26)" stroke-width="2" stroke-dasharray="1.5 6.2"/></svg>` +
    `<span class="bot-ring" aria-hidden="true"></span>` +
    `<span class="bot-ring r2" aria-hidden="true"></span>` +
    `<span class="bot-orbit o1" aria-hidden="true"><i></i></span>` +
    `<span class="bot-orbit o2" aria-hidden="true"><i></i></span>` +
    `<span class="motion-mote m1" aria-hidden="true"></span><span class="motion-mote m2" aria-hidden="true"></span><span class="motion-mote m3" aria-hidden="true"></span><span class="motion-mote m4" aria-hidden="true"></span>` +
    `<span class="bot-tilt" data-bot-tilt><span class="bot-avatar" data-bot-avatar><img src="/logo-noeyes.png" alt="The Ponsr robot" width="512" height="507"><span class="bot-eyes" aria-hidden="true"><span class="eye eye-l" data-bot-eye><i></i></span><span class="eye eye-r" data-bot-eye><i></i></span></span></span></span><span class="bot-shadow" aria-hidden="true"></span></div><span class="stage-caption" aria-hidden="true">PONSR · ROBINHOOD CHAIN</span></div>`;
}

function officialStage() {
  return `<aside class="official-identity-strip" data-official-showcase><span class="official-sigil" aria-hidden="true"><i></i></span><div><p class="eyebrow">Official token status</p><strong>No official Ponsr token has been published.</strong><p>Contract, artwork, and launch record remain unpublished. Verified launches in Explore are not automatically official.</p></div><a class="section-action" href="https://x.com/ponsrdotfun" target="_blank" rel="noopener noreferrer"><span>Registry updates</span><i class="action-icon" aria-hidden="true">↗</i></a></aside>`;
}

function page({ title, description, canonical, body, socialImage = socialImages.home, noindex = false }) {
  const socialUrl = `${socialOrigin}${socialImage}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#050607"><title>${esc(title)}</title><meta name="description" content="${esc(description)}">${noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}<link rel="canonical" href="${canonical}"><meta property="og:type" content="website"><meta property="og:site_name" content="Ponsr"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${canonical}"><meta property="og:image" content="${socialUrl}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@ponsrdotfun"><meta name="twitter:image" content="${socialUrl}"><link rel="icon" href="/logo-transparent.png"><link rel="apple-touch-icon" href="/logo-transparent.png"><link rel="stylesheet" href="/assets/site.css"><script type="module" src="/assets/app.mjs"></script></head><body><a class="skip" href="#content">Skip to content</a><div class="scroll-progress" data-scroll-progress aria-hidden="true"></div><div class="ambient" data-motion-field aria-hidden="true"><span class="ambient-stars"></span><span class="ambient-grid"></span><span class="ambient-aurora aurora-a"></span><span class="ambient-aurora aurora-b"></span><span class="ambient-beam beam-a"></span><span class="ambient-beam beam-b"></span><span class="ambient-sweep"></span><span class="ambient-orb orb-a"></span><span class="ambient-orb orb-b"></span></div><span class="cursor-glow" data-cursor-glow aria-hidden="true"></span>${nav(canonical.replace('https://ponsr.fun', '') || '/')}<div id="content" data-ponsr-app>${body}</div>${footer()}</body></html>
`;
}

/* -------------------------------------------------------------------------- */
/* Home                                                                        */
/* -------------------------------------------------------------------------- */

const launches = feed.launches.slice().sort((a, b) => {
  if (!a.blockTimestamp && !b.blockTimestamp) return Number(b.blockNumber || 0) - Number(a.blockNumber || 0);
  if (!a.blockTimestamp) return 1;
  if (!b.blockTimestamp) return -1;
  return b.blockTimestamp.localeCompare(a.blockTimestamp);
});
const officialLaunches = launches.filter((launch) => launch.officialPonsr === true);

function home() {
  const body =
    `<main>` +
    `<section class="hero"><div class="hero-inner">` +
      `<div class="hero-copy reveal">` +
        `<p class="eyebrow">Protocol V2 · Robinhood Chain</p>` +
        `<h1 aria-label="Every launch, on the record."><span aria-hidden="true" class="metal">Every launch,</span> ` +
          `<span aria-hidden="true" class="sheen metal-emerald"><em>on the record.</em></span></h1>` +
        `<p class="lede">Ponsr launches tokens from a tag on X and writes down what actually happened — the factory, the curve, the block, the fee. ` +
          `If a number cannot be read from the chain, this site does not show it.</p>` +
        /**
         * THE ACTION THE PRODUCT IS FOR, ON THE FIRST SCREEN.
         *
         * The hero offered "Explore launches" and "Open dashboard" -- both about
         * reading records -- while the one thing Ponsr exists to do, tagging the
         * bot, was a section down the page. Somebody arriving from X who wanted
         * exactly what Ponsr sells had to scroll to find out how to ask.
         *
         * The gate note travels with it, and stays pessimistic at build time
         * like every other copy of it. Inviting a tweet without saying whether
         * it will be answered is the half-truth this whole page exists to avoid.
         */
        `<div class="hero-request">` +
          `<p class="hero-request-label">Launch one — tag the bot on X</p>` +
          `<p class="hero-request-line">${requestLine()}</p>` +
          copyRequestButton('Copy this request') +
          gateNote('hero-request-gate') +
        `</div>` +
        `<div class="hero-cta home-actions">` +
          `<a class="btn btn-primary home-action" href="/explore/" data-home-action="explore"><span>Explore launches</span><i class="action-icon" aria-hidden="true">→</i></a>` +
          `<a class="btn btn-secondary home-action" href="/account/" data-home-action="dashboard"><span>Open dashboard</span><i class="action-icon" aria-hidden="true">→</i></a>` +
          `<a class="home-tertiary" href="#verification-policy" data-home-action="verification"><span>How Ponsr verifies records</span><i class="action-icon" aria-hidden="true">↓</i></a>` +
        `</div>` +
      `</div>` +
      `<div class="reveal">${mascot()}</div>` +
    `</div></section>` +

    statusStrip() +

    `<section class="section reveal home-product-section"><div class="section-head product-head"><div><p class="eyebrow">Built as a product—not a promise</p><h2>Three surfaces. One verifiable record.</h2><p class="lede">Discover launches, inspect exact token mechanics, or enter the account command center. Every surface keeps public facts separate from unavailable private state.</p></div></div>` +
    `<div class="product-pathways">` +
      `<a href="/explore/"><span class="pathway-index">01</span><div><p class="eyebrow">Discovery</p><h3>Explore launchpad</h3><p>Sort verified Protocol V2 launches by canonical activity and open exact token records.</p></div><i class="action-icon" aria-hidden="true">→</i></a>` +
      `<a href="/account/"><span class="pathway-index">02</span><div><p class="eyebrow">Private workspace</p><h3>Account command center</h3><p>Launches, creator fees, wallet continuity, and security—only after verified identity exists.</p></div><i class="action-icon" aria-hidden="true">→</i></a>` +
      `<a href="/explore/"><span class="pathway-index">03</span><div><p class="eyebrow">Market context</p><h3>Inspect token workstations</h3><p>Chart, curve ledger, holders, transfers, provenance, and read-only wallet analysis.</p></div><i class="action-icon" aria-hidden="true">→</i></a>` +
    `</div></section>` +
    /**
     * THE PAGE NEVER SAID HOW TO USE THE PRODUCT.
     *
     * The whole thing is "tag the bot on X". Before this, `@ponsrdotfun`
     * appeared only in the footer as "Registry updates", there was no example
     * of a request, and the how-it-works step read "A recognized launch request
     * begins the process" without ever saying what one looks like. A stranger
     * who wanted exactly what Ponsr sells could not find out how to ask.
     *
     * The call to action follows the REAL gate. Paused, it says so and offers
     * the one useful next step instead of a dead end; open, it asks for the
     * tweet. Nobody has to remember to edit this when the gate moves.
     */
    `<section class="section reveal launch-howto" id="how-to-launch"><div class="section-head"><p class="eyebrow">How to launch</p><h2>Tag the bot. That is the whole interface.</h2>` +
      `<p class="lede">No wallet to connect, no form to fill in, nothing to install. Ponsr reads the request, pays the launch fee, and writes the token to the chain.</p></div>` +
      `<div class="howto-grid">` +
        `<article class="howto-step"><b>01</b><span>Write the tweet</span>` +
          `<small>Name the token and its symbol in plain words. Ponsr asks rather than guesses when either is missing.</small></article>` +
        `<article class="howto-step"><b>02</b><span>Ponsr replies</span>` +
          `<small>With the contract address and the transaction, or with the exact reason it could not — never with silence.</small></article>` +
        `<article class="howto-step"><b>03</b><span>The fees are yours</span>` +
          `<small>Sign in here with the same X account and collect them. Ponsr sends the transaction and pays the gas.</small></article>` +
      `</div>` +
      `<figure class="howto-example"><figcaption>An example request</figcaption>` +
        `<blockquote>${requestLine()}</blockquote>` +
        copyRequestButton('Copy this request') +
      `</figure>` +
      gateNote() +
    `</section>` +
    /**
     * WHAT THE CREATOR ACTUALLY KEEPS.
     *
     * The reason to use Ponsr rather than launching yourself, and it was on no
     * page: "66.5", "3.5%" and "95" appeared nowhere on this site.
     *
     * These two are the only figures allowed in user-facing copy, because they
     * are what the contracts actually transfer and anyone can check them. The
     * launchpad's own locker takes its cut BEFORE Ponsr's splitter sees
     * anything, so naming it is the difference between an honest 66.5% and a
     * number with thirty percent quietly missing.
     */
    `<section class="section reveal creator-economics"><div class="section-head"><p class="eyebrow">What you keep</p><h2>The trading fees are the creator&rsquo;s.</h2></div>` +
      `<div class="economics-grid">` +
        `<article class="economics-figure is-primary"><b>66.5%</b><span>of trading fees, to you</span>` +
          `<small>Pushed to your own wallet by the splitter. Ponsr cannot redirect it.</small></article>` +
        `<article class="economics-figure"><b>3.5%</b><span>to Ponsr</span>` +
          `<small>What the treasury keeps for running the bot and covering the launch fee and gas.</small></article>` +
        `<article class="economics-figure"><b>Nothing</b><span>to launch</span>` +
          `<small>Ponsr pays the launch fee and the gas, including the gas to collect.</small></article>` +
      `</div>` +
      `<p class="note"><strong>Where the rest goes</strong>The launchpad&rsquo;s locker takes 30% of trading fees before Ponsr&rsquo;s splitter sees any of it; 66.5% and 3.5% are what is left, divided 95/5. Every share is set by contracts on chain, not by this page, and can be read there.</p>` +
    `</section>` +
    `<section class="section reveal protocol-section"><div class="section-head"><p class="eyebrow">How a record becomes public</p><h2>Signal to chain, without the mythology.</h2></div><div class="protocol-flow"><span class="flow-trace" aria-hidden="true"></span>` +
      `<article><b>01</b><span>X signal</span><small>A recognized launch request begins the process.</small></article>` +
      `<article><b>02</b><span>Verified factory</span><small>Only the exact current Protocol V2 deployment counts.</small></article>` +
      `<article><b>03</b><span>Bonding curve</span><small>Native-pair reserves and canonical events define lifecycle.</small></article>` +
      `<article><b>04</b><span>Public record</span><small>Block, curve, deployer, activity, and source state become inspectable.</small></article>` +
    `</div></section>` +
    `<section class="section reveal compact-official-section" id="latest-launches"><div class="compact-official-head"><p class="eyebrow">Official Ponsr identity</p><a class="text-link" href="/explore/">Browse verified launches →</a></div>` +
      (officialLaunches.length ? `<aside class="official-identity-strip published" data-official-showcase><span class="official-sigil" aria-hidden="true"><i></i></span><div><p class="eyebrow">Official token status</p><strong>${esc(officialLaunches[0].name)} · ${esc(officialLaunches[0].symbol)}</strong><p>Explicitly marked official in the verified Ponsr feed.</p></div><a class="section-action" href="/token/${esc(officialLaunches[0].token.toLowerCase())}/"><span>Inspect token</span><i class="action-icon" aria-hidden="true">→</i></a></aside>` : officialStage()) +
    `</section>` +

    `<section class="section reveal verification-policy" id="verification-policy"><div class="section-head">` +
      `<p class="eyebrow">How the record is kept</p>` +
      `<h2>Three rules, and the third is the one that matters.</h2>` +
    `</div><div class="steps">` +
      `<article class="step"><span class="num">01</span><h3>Only Ponsr's own launches</h3>` +
        `<p>The feed reads one factory and one deployer. An older factory Ponsr used to call is excluded from everything public — it stays documented, not displayed.</p></article>` +
      `<article class="step"><span class="num">02</span><h3>Time comes from the block</h3>` +
        `<p>A launch is dated by its confirmed block, never by your clock or by when this page happened to load. When the block time cannot be read, the page says so instead of guessing.</p></article>` +
      `<article class="step"><span class="num">03</span><h3>A failure never looks like calm</h3>` +
        `<p>If the source is partial, stale, or down, the strip above says which — because an empty list and a broken reader look identical, and only one of them is good news.</p></article>` +
    `</div></section>` +
    `</main>`;

  return page({
    title: 'Ponsr — every launch, on the record.',
    description: 'Ponsr launches tokens on Robinhood Chain and publishes what can be read from the chain: factory, curve, block, event time and fee. No prices, no valuations, no invented numbers.',
    canonical: 'https://ponsr.fun/',
    body,
  });
}

/* -------------------------------------------------------------------------- */
/* Explore                                                                     */
/* -------------------------------------------------------------------------- */

function tokenCard(token) {
  const href=`/token/${esc(token.token.toLowerCase())}`;const progress=curveProgress(token);
  return `<article class="token-card">${tokenArt(token)}<div class="launch-card-body"><p class="eyebrow">Current V2 · ${esc(token.pairLabel)}</p><div class="launch-title"><div><h3>${esc(token.name)}</h3><p class="proof-symbol">${esc(token.symbol)}</p></div><a class="go" href="${href}">INSPECT →</a></div><p class="deployer">Deployed by <a href="${EXPLORER}/address/${esc(token.deployer)}" target="_blank" rel="noopener noreferrer">${esc(shortAddress(token.deployer))}</a>${token.creator && String(token.creator).toLowerCase() !== String(token.deployer).toLowerCase() ? ` &middot; creator <a href="${EXPLORER}/address/${esc(token.creator)}" target="_blank" rel="noopener noreferrer">${esc(shortAddress(token.creator))}</a>` : ''}</p><button class="ca-copy" type="button" data-copy-address="${esc(token.token)}" aria-label="Copy contract address ${esc(token.token)}"><span class="mono">${esc(shortAddress(token.token))}</span><span data-copy-label role="status" aria-live="polite">Copy CA</span></button><div class="curve-progress"><div><span>Curve progress</span><strong>${esc(progress.toFixed(2))}%</strong></div><progress max="100" value="${esc(progress)}">${esc(progress.toFixed(2))}%</progress></div><p class="launch-meta"><span>Block ${esc(whole(token.blockNumber))}</span><span>${esc(eventTime(token.blockTimestamp))}</span></p></div></article>`;
}
function latestCanonicalBuyTime(token) {
  return (token.activity?.events || []).filter((event) => event.kind === 'buy' && event.blockTimestamp).map((event) => event.blockTimestamp).sort().at(-1) || token.blockTimestamp || null;
}
function relativeTime(iso, anchor = feed.observedAt) {
  const delta = new Date(anchor).getTime() - new Date(iso).getTime();
  if (!Number.isFinite(delta) || delta < 0) return 'Time unavailable';
  const seconds=Math.floor(delta/1000);if(seconds<60)return seconds<5?'now':`${seconds}s ago`;
  const minutes=Math.floor(seconds/60);if(minutes<60)return `${minutes}m ago`;
  const hours=Math.floor(minutes/60);if(hours<24)return `${hours}h ago`;
  return `${Math.floor(hours/24)}d ago`;
}
/**
 * The card now comes from `website/assets/cards.mjs`, which the browser imports
 * too. It was written here AND there, and the two copies had drifted four ways
 * -- the cover link, the attribution, the percentage label, and the progress
 * arithmetic. Structure is shared; the values this side knows stay here.
 */
/**
 * The artwork block as a string, for the call sites that build HTML directly.
 *
 * A thin wrapper, not a second implementation: the structure comes from the
 * shared model that the browser also renders, so the two cannot drift again.
 */
const tokenArt = (token) => toHtml(tokenArtModel(token));

function launchpadCard(token) {
  return toHtml(launchpadCardModel({
    token,
    art: tokenArtModel(token),
    // The static build has observed no price, and says so rather than leaving
    // a gap the reader fills in.
    marketCapLabel: 'Market cap unavailable',
    relativeTime: relativeTime(latestCanonicalBuyTime(token)),
  }));
}

function explore() {
  const count = launches.length;
  const body =
    `<main class="launchpad-shell" data-launch-scope="all-verified-v2">` +
    `<section class="launchpad-panel reveal">` +
      `<header class="launchpad-head"><div class="launchpad-intro"><div class="launchpad-title-row"><h1>Explore</h1><span data-launch-count>${count} launched</span></div>` +
      `<p>Verified tokens launched through Ponsr Protocol V2 on Robinhood Chain.</p></div>` +
      `<div class="launchpad-tools"><div class="sort-segments" role="group" aria-label="Sort launches">` +
        `<button type="button" aria-pressed="true" data-launch-sort="recent-buys">Recent buys</button>` +
        `<button type="button" aria-pressed="false" data-launch-sort="newest">Newest</button>` +
        `<button type="button" aria-pressed="false" data-launch-sort="oldest">Oldest</button>` +
        `<button type="button" aria-pressed="false" data-launch-sort="market-cap" disabled title="Market cap source unavailable">Market cap</button>` +
      `</div><label class="launchpad-search"><span class="sr-only">Search launches</span><input type="search" inputmode="search" autocomplete="off" placeholder="Search name, ticker, or CA" data-launch-search></label></div></header>` +
      `<div class="launchpad-truth"><strong>Current V2 provenance</strong><span>Inclusion is not endorsement, official status, price, or safety.</span><span data-result-detail>Recent canonical buys · last-known snapshot</span></div>` +
      `<div class="launchpad-grid" data-launchpad-grid>${launches.map(launchpadCard).join('')}</div>` +
      `<p class="note" data-empty-note hidden><strong>No matching launches</strong>Try a token name, symbol, or exact 0x address.</p>` +
    `</section></main>`;

  return page({
    title: 'Explore · Ponsr',
    description: 'Every current V2 token Ponsr has launched on Robinhood Chain, with source state, block and authoritative event time.',
    canonical: 'https://ponsr.fun/explore/',
    socialImage: socialImages.explore,
    body,
  });
}

/* -------------------------------------------------------------------------- */
/* Token                                                                       */
/* -------------------------------------------------------------------------- */

function curveActivityBlock(token) {
  // Quote amounts are denominated in the launch's pairing asset, not in ETH.
  const unit = quoteUnit(token);
  const series = curveFlowSeries(token.activity);
  if (!series.length) return `<p class="note"><strong>Curve activity not published</strong>This feed publishes no verified CurveBuy or CurveSell events for this token.</p>`;
  const width=640, height=220, padX=34, padY=26;
  const numeric=series.map((event)=>Number(BigInt(event.netQuoteWei))/1e18);
  const min=Math.min(0,...numeric), max=Math.max(0,...numeric), span=max-min||1;
  const points=series.map((event,index)=>({event,x:series.length===1?width/2:padX+(index*(width-padX*2))/(series.length-1),y:height-padY-((numeric[index]-min)/span)*(height-padY*2)}));
  const zeroY=height-padY-((0-min)/span)*(height-padY*2);
  const line=points.map((point,index)=>index===0?`M ${point.x.toFixed(2)} ${zeroY.toFixed(2)} V ${point.y.toFixed(2)}`:`H ${point.x.toFixed(2)} V ${point.y.toFixed(2)}`).join(' ');
  const markers=points.map(({event,x,y})=>`<g class="flow-marker ${event.kind}"><circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="9"></circle><text x="${x.toFixed(2)}" y="${(y-17).toFixed(2)}" text-anchor="middle">${event.kind==='buy'?'BUY':'SELL'}</text></g>`).join('');
  const timeline=series.slice().reverse().map((event)=>`<li class="flow-event ${event.kind}"><span class="flow-kind">${event.kind==='buy'?'BUY':'SELL'}</span><span><strong>${event.kind==='buy'?'Quote in +':'Quote out −'}${esc(amountFromWei(event.quoteWei,18,unit))}</strong><small>Cumulative ${esc(amountFromWei(event.netQuoteWei,18,unit))} · ${esc(eventTime(event.blockTimestamp))} · block ${esc(whole(event.blockNumber))}</small></span><a class="text-link" href="${EXPLORER}/tx/${esc(event.transactionHash)}" target="_blank" rel="noopener noreferrer">tx ↗</a></li>`).join('');
  const maxWei=series.reduce((best,event)=>BigInt(event.netQuoteWei)>best?BigInt(event.netQuoteWei):best,0n).toString();
  const buyWei=series.filter((event)=>event.kind==='buy').reduce((sum,event)=>sum+BigInt(event.quoteWei),0n);
  const sellWei=series.filter((event)=>event.kind==='sell').reduce((sum,event)=>sum+BigInt(event.quoteWei),0n);
  const netWei=BigInt(series.at(-1).netQuoteWei), netDirection=netWei>=0n?'inflow':'outflow';
  const activityFresh=token.activity?.sourceState==='complete';
  const gridLines=[.25,.5,.75].map((ratio)=>{const y=(padY+(height-padY*2)*ratio).toFixed(2);return `<line class="flow-grid-line" x1="${padX}" x2="${width-padX}" y1="${y}" y2="${y}"></line>`;}).join('');
  return `<section class="panel curve-flow reveal" data-curve-flow-chart><div class="curve-flow-head"><div><p class="eyebrow">Cumulative quote accounting · authoritative block time</p><h2>Net ${esc(unit)} flow</h2><p class="flow-intro">See how much ${esc(quoteName(token))} entered through buys, exited through sells, and remained as net transaction flow.</p></div><div class="flow-summary ${netDirection}"><span class="flow-not-price">Not token price · liquidity · PnL</span><span class="flow-summary-label">Net ${netDirection}</span><p class="mono">${esc(amountFromWei(netWei<0n?-netWei:netWei,18,unit))}</p></div></div>` +
    `<p class="flow-source ${activityFresh?'complete':'stale'}">${activityFresh?'Activity indexed':'Last-known activity'} through block ${esc(whole(token.activity.observedThroughBlock))}${token.activity?.sourceState==='partial'?' · source partial':''}</p>` +
    `<div class="flow-metric-rail"><article data-flow-buy-inflow><span>Buy inflow</span><strong>+${esc(amountFromWei(buyWei,18,unit))}</strong><small>Σ verified CurveBuy quote in</small></article><article data-flow-sell-outflow><span>Sell outflow</span><strong>${esc(amountFromWei(sellWei,18,unit))}</strong><small>Unsigned magnitude · subtracted from buys</small></article><article class="net ${netDirection}" data-flow-net-inflow><span>Net ${netDirection}</span><strong>${netDirection==='inflow'?'+':'−'}${esc(amountFromWei(netWei<0n?-netWei:netWei,18,unit))}</strong><small>Buy inflow − sell outflow</small></article></div>` +
    `<div class="flow-ledger-note"><span aria-hidden="true">◇</span><p><strong>Transaction-flow ledger</strong>Direction and cumulative ${esc(unit)} movement through exact curve events—not valuation or available reserve.</p></div>` +
    `<div class="flow-plot"><div class="flow-plot-head"><span>Running net flow</span><span>Older events → newer events</span></div><span class="flow-scale flow-scale-max">${esc(amountFromWei(maxWei,18,unit))}</span><span class="flow-scale flow-scale-zero">0 ${esc(unit)}</span>` +
    `<svg class="flow-chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="flow-title flow-desc"><title id="flow-title">Running net ${esc(unit)} flow through the bonding curve</title><desc id="flow-desc">${series.length} verified CurveBuy and CurveSell events, oldest to newest, plotted from exact quoteIn minus quoteOut values.</desc>${gridLines}<line class="flow-zero" x1="${padX}" x2="${width-padX}" y1="${(height-padY-((0-min)/span)*(height-padY*2)).toFixed(2)}" y2="${(height-padY-((0-min)/span)*(height-padY*2)).toFixed(2)}"></line><path class="flow-line-glow" d="${line}"></path><path class="flow-line" d="${line}"></path>${markers}</svg><div class="flow-legend"><span class="buy">● BUY adds ${esc(unit)}</span><span class="sell">● SELL removes ${esc(unit)}</span></div></div>` +
    `<div class="flow-list-head"><div><p class="eyebrow">Canonical event ledger</p><h3>Verified curve events</h3></div><span class="eyebrow">Newest first</span></div><ol class="flow-events">${timeline}</ol></section>`;
}

function marketTerminalBlock(token) {
  const chart=`https://www.geckoterminal.com/robinhood/tokens/${esc(token.token.toLowerCase())}`;
  const chartEmbed=`${chart}?embed=1&amp;info=0&amp;swaps=0`;
  const unit = quoteUnit(token);
  const canonicalSeries=curveFlowSeries(token.activity);
  const canonicalRows=canonicalSeries.length
    ? canonicalSeries.slice().reverse().map((event)=>`<li class="market-trade ${event.kind}"><span class="market-kind">${event.kind.toUpperCase()}</span><span><strong>${event.kind==='buy'?'Quote in +':'Quote out −'}${esc(amountFromWei(event.quoteWei,18,unit))}</strong><small>${esc(eventTime(event.blockTimestamp))} · block ${esc(whole(event.blockNumber))}</small></span><a class="text-link" href="${EXPLORER}/tx/${esc(event.transactionHash)}" target="_blank" rel="noopener noreferrer">tx ↗</a></li>`).join('')
    : `<li class="market-empty">Canonical CurveBuy / CurveSell activity is unavailable for this observation range.</li>`;
  const canonicalCount=canonicalSeries.length?String(canonicalSeries.length):'Unavailable';
  return `<section class="panel market-terminal token-workstation reveal" data-market-terminal data-token="${esc(token.token.toLowerCase())}" data-curve="${esc(token.curve.toLowerCase())}">` +
    `<div class="terminal-head"><div><p class="eyebrow">External market layer · GeckoTerminal</p><h2>Chart + activity</h2></div><div class="terminal-source"><span class="terminal-source-dot"></span><span data-market-state>Loading indexed sources</span></div></div>` +
    `<div class="market-metrics"><article><span>Price USD</span><strong data-market-price>Unavailable</strong><small>GeckoTerminal</small></article><article><span>24h volume</span><strong data-market-volume>Unavailable</strong><small>GeckoTerminal</small></article><article><span>24h flow</span><strong data-market-transactions>Unavailable</strong><small>GeckoTerminal aggregate</small></article><article><span>FDV</span><strong data-market-fdv>Unavailable</strong><small>Provider estimate · not market cap</small></article><article><span>Holders</span><strong data-holder-count>Unavailable</strong><small>Chain-derived Transfer logs</small></article></div>` +
    `<div class="workstation-grid"><div class="gecko-frame"><div class="market-chart-shell gecko-chart-shell"><iframe src="${chartEmbed}" title="${esc(token.symbol)} live chart on GeckoTerminal" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="clipboard-write"></iframe></div><p>Interactive GeckoTerminal chart. <a class="text-link" href="${chart}" target="_blank" rel="noopener noreferrer">Open on GeckoTerminal ↗</a></p></div>` +
    `<section class="activity-terminal"><div class="activity-tabs" role="tablist" aria-label="Token activity"><button id="activity-tab-trades" type="button" role="tab" aria-selected="true" aria-controls="activity-panel-trades" tabindex="0" data-activity-tab="trades">Buy / Sell <span data-trade-count>${canonicalCount}</span></button><button id="activity-tab-holders" type="button" role="tab" aria-selected="false" aria-controls="activity-panel-holders" tabindex="-1" data-activity-tab="holders">Holders <span data-holder-tab-count>—</span></button><button id="activity-tab-transfers" type="button" role="tab" aria-selected="false" aria-controls="activity-panel-transfers" tabindex="-1" data-activity-tab="transfers">Transfers <span data-transfer-count>—</span></button></div><div id="activity-panel-trades" class="activity-pane" role="tabpanel" aria-labelledby="activity-tab-trades" data-activity-pane="trades"><ol data-market-trades>${canonicalRows}</ol></div><div id="activity-panel-holders" class="activity-pane" role="tabpanel" aria-labelledby="activity-tab-holders" data-activity-pane="holders" hidden><ol data-token-holders><li class="market-empty">Waiting for chain-derived holders…</li></ol></div><div id="activity-panel-transfers" class="activity-pane" role="tabpanel" aria-labelledby="activity-tab-transfers" data-activity-pane="transfers" hidden><ol data-token-transfers><li class="market-empty">Waiting for chain-derived transfers…</li></ol></div></section></div>` +
    `<p class="terminal-disclosure">Market price, FDV, volume and 24h aggregate are external GeckoTerminal observations. Holders and transfers are derived from exact token Transfer logs. <strong>Canonical Ponsr ledger</strong>: Buy/Sell rows are canonical CurveBuy and CurveSell events and are never replaced by provider trades.</p></section>`;
}

function whatIfBlock(token) {
  return `<section class="panel what-if-lab reveal" id="what-if" data-what-if-simulator data-quote-unit="${esc(quoteUnit(token))}" data-token="${esc(token.token.toLowerCase())}">` +
    `<div class="what-if-head"><div><p class="eyebrow">Read-only wallet laboratory</p><h2>What if you never sold?</h2><p class="lede">Reconstruct your observed Ponsr trade history, then compare today's actual position with a never-sold counterfactual.</p></div><span class="read-only-badge">Read-only · no signing</span></div>` +
    `<div class="simulator-controls"><label><span>Wallet address</span><input type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="0x…" data-wallet-input></label><button class="btn btn-primary" type="button" data-run-simulator><span>Run analysis</span></button><button class="btn btn-ghost" type="button" data-connect-wallet><span>Select with MetaMask</span></button></div>` +
    `<p class="simulator-boundary">MetaMask is used only to return the address you explicitly select via <span class="mono">eth_requestAccounts</span>. Ponsr does not request a signature, chain switch, approval, or transaction.</p>` +
    `<div class="simulator-state" data-simulator-state><strong>Connect or paste a wallet</strong><p>No account data is inferred from an X handle. Analysis starts only after you select or enter an exact address.</p></div>` +
    `<div class="simulator-results" data-simulator-results hidden><article><span>If you never sold</span><strong data-never-sold>Unavailable</strong><small>All observed buys valued now</small></article><article><span>What you actually have</span><strong data-actual-now>Unavailable</strong><small>Current holdings + realized quote</small></article><article><span>Counterfactual delta</span><strong data-what-if-delta>Unavailable</strong><small>Never-sold minus actual</small></article><article><span>Observed trades</span><strong data-what-if-trades>Unavailable</strong><small>Reconciled history only</small></article></div>` +
    `<div class="simulator-audit" data-simulator-audit hidden><div class="flow-list-head"><h3>Reconciliation inputs</h3><span class="eyebrow">Derived · auditable</span></div><dl class="facts"><div class="fact"><dt>Total tokens bought</dt><dd data-audit-bought>Unavailable</dd></div><div class="fact"><dt>Current token balance</dt><dd data-audit-balance>Unavailable</dd></div><div class="fact"><dt>Realized quote</dt><dd data-audit-realized>Unavailable</dd></div><div class="fact"><dt>Token price used</dt><dd data-audit-token-price>Unavailable</dd></div><div class="fact"><dt>Quote price used</dt><dd data-audit-quote-price>Unavailable</dd></div><div class="fact"><dt>Valuation observed</dt><dd data-audit-time>Unavailable</dd></div><div class="fact"><dt>Sources</dt><dd>Canonical curve events · Blockscout transfers · Robinhood RPC transaction sender/balance · GeckoTerminal current price</dd></div><div class="fact"><dt>Formula</dt><dd>Never sold = all bought tokens × current price; actual = current holdings × current price + realized quote × current quote price</dd></div></dl><div class="flow-list-head"><h3>Included wallet trades</h3><span class="eyebrow">Exact matched transactions</span></div><ol class="flow-events" data-audit-trades></ol></div>` +
    `<p class="terminal-disclosure">Historical counterfactual, not a prediction or recommendation. Gas is excluded. Partial, missing, dead, or illiquid data stays labeled and never becomes a zero-value claim.</p></section>`;
}

function tokenPage(token) {
  /**
   * Observed reserves, with the observation attached.
   *
   * A figure without a state and a time is a claim about now, and this feed
   * cannot make one — the reserve was read once, at a moment that has passed.
   * So the number never appears without when it was read and whether the curve
   * has graduated.
   */
  const rows=reserveRows(token),reserveMap=rows?Object.fromEntries(rows):null;
  const reserves=reserveMap
    ? `<div class="reserve-metric-grid"><article><span>Real quote reserve</span><strong>${esc(reserveMap['Real quote reserve'])}</strong><small>Observed ${esc(quoteName(token))}</small></article><article><span>Graduation threshold</span><strong>${esc(reserveMap['Graduation threshold'])}</strong><small>Protocol threshold</small></article></div><div class="curve-state-row"><span>Curve status</span><strong>${esc(reserveMap['Curve status'])}</strong><small>Observed at ${esc(reserveMap['Observed at'])}</small></div><p class="observation-note">A single reading, not a live figure. It was true at the observation above, and it is not extrapolated anywhere on this page.</p>`
    : `<p class="note"><strong>Curve reserves unavailable</strong>${esc(token.reserves?.reason || 'No verified reserve observation is published for this token.')}</p>`;
  const hasActivity=Number.isFinite(token.activity?.curveBuys)&&Number.isFinite(token.activity?.curveSells);
  const activity=hasActivity
    ? `<div class="observation-grid"><article><span>Verified activity</span><strong>${esc(plural(token.activity.curveBuys,'buy','buys'))} · ${esc(plural(token.activity.curveSells,'sell','sells'))}</strong><small>CurveBuy / CurveSell</small></article><article><span>Indexed coverage</span><strong>Through block ${esc(whole(token.activity.observedThroughBlock))}</strong><small>${token.activity?.sourceState==='complete'?'Complete observation':'Last-known observation'}</small></article></div>`
    : `<p class="note"><strong>Curve activity not published</strong>This feed publishes no verified buy/sell observation for this token.</p>`;

  const dossierRows=(items,start=1)=>`<dl class="dossier-rows">${items.map(([label,value],index)=>`<div class="dossier-row"><span class="dossier-index">${String(start+index).padStart(2,'0')}</span><div><dt>${esc(label)}</dt><dd>${value}</dd></div></div>`).join('')}</dl>`;
  const originRows=dossierRows([['Factory',addressCell(token.factory)],['Curve',addressCell(token.curve)],['Fee splitter',addressCell(token.splitter)],['Deployer',addressCell(token.deployer)],['Pair asset',esc(token.pairLabel)+(token.pairToken===ZERO?' · zero address':` · ${esc(shortAddress(token.pairToken))}`)]]);
  const launchRows=dossierRows([['Launch transaction',`<a class="text-link" href="${EXPLORER}/tx/${esc(token.transactionHash)}" target="_blank" rel="noopener noreferrer">${esc(shortAddress(token.transactionHash))}</a>`],['Block',blockCell(token.blockNumber)],['Event time',esc(eventTime(token.blockTimestamp))],['Launch fee',token.launchFeeEth?`${esc(token.launchFeeEth)} ETH`:'Not recorded']],6);
  const progress=curveProgress(token);
  const body =
    `<main data-token-address="${esc(token.token.toLowerCase())}">` +
    `<header class="token-identity-strip reveal">${tokenArt(token)}<div class="token-identity-main"><p class="eyebrow">Current V2 · ${esc(token.deploymentId)}</p><h1 class="metal">${esc(token.name)}</h1><p class="proof-symbol">${esc(token.symbol)}</p><p class="token-description" data-token-description>${esc(token.description || 'Token description unavailable.')}</p><p class="deployer">Deployed by <a href="${EXPLORER}/address/${esc(token.deployer)}" target="_blank" rel="noopener noreferrer">${esc(shortAddress(token.deployer))}</a>${token.creator && String(token.creator).toLowerCase() !== String(token.deployer).toLowerCase() ? ` &middot; creator <a href="${EXPLORER}/address/${esc(token.creator)}" target="_blank" rel="noopener noreferrer">${esc(shortAddress(token.creator))}</a>` : ''}</p><div class="identity-actions"><button class="ca-copy" type="button" data-copy-address="${esc(token.token)}" aria-label="Copy contract address ${esc(token.token)}"><span class="mono">${esc(shortAddress(token.token))}</span><span data-copy-label role="status" aria-live="polite">Copy CA</span></button><a class="btn btn-ghost" href="${EXPLORER}/address/${esc(token.token)}" target="_blank" rel="noopener noreferrer"><span>Explorer ↗</span></a><a class="btn btn-ghost" href="${EXPLORER}/tx/${esc(token.transactionHash)}" target="_blank" rel="noopener noreferrer"><span>Launch tx ↗</span></a></div></div><div class="identity-curve"><span>Curve progress</span><strong>${progress.toFixed(2)}%</strong><progress max="100" value="${progress.toFixed(2)}">${progress.toFixed(2)}%</progress><small>${esc(amountFromWei(token.reserves?.realQuoteReserveWei||0,6,quoteUnit(token)))} of ${esc(amountFromWei(token.graduationThreshold,2,quoteUnit(token)))} · observed ${esc(eventTime(token.reserves?.observedAt))}</small></div></header>` +
    statusStrip() +
    `<section class="section token-detail-flow">` + marketTerminalBlock(token) + curveActivityBlock(token) + whatIfBlock(token) +
    `<div class="inspect-grid token-dossier"><article class="panel reveal dossier-card provenance-card"><div class="dossier-head"><div><p class="eyebrow">Protocol dossier · provenance</p><h2>Where it came from</h2></div><span class="dossier-chip">Verified chain references</span></div><p class="dossier-intro">Immutable launch identity, contract ancestry, and authoritative creation record.</p><section class="dossier-group"><div class="dossier-group-head"><span>01</span><h3>Origin &amp; contracts</h3></div>${originRows}</section><section class="dossier-group"><div class="dossier-group-head"><span>02</span><h3>Launch record</h3></div>${launchRows}</section><section class="dossier-group verification-group"><div class="dossier-group-head"><span>03</span><h3>Verification scope</h3></div><div class="verification-grid"><article><span>Network</span><strong>Robinhood Chain · 4663</strong></article><article><span>Registry</span><strong>${esc(token.deploymentId)}</strong></article></div><p>Identifiers are abbreviated for scanning; linked references open their exact chain records.</p></section></article>` +
    `<article class="panel reveal dossier-card mechanics-card"><div class="dossier-head"><div><p class="eyebrow">Protocol dossier · mechanics</p><h2>A bonding curve, not a pool</h2></div><span class="dossier-chip state">Current V2 architecture</span></div><p class="dossier-intro">Current V2 sells into a bonding curve with ${esc(quoteName(token))} as the quote asset. ${token.pairToken===ZERO?'The zero pair address is intentional—not a Uniswap-style pool.':'The pair asset is an approved Robinhood Chain token, not a Uniswap-style pool.'}</p><section class="mechanics-state"><div><span>Last observed curve state</span><strong>${esc(reserveMap?.['Curve status']||'Unavailable')}</strong></div><p>${token.pairToken===ZERO?'Native ETH quote · zero pair address by design':`${esc(quoteName(token))} quote · approved pair asset`}</p></section><section class="dossier-group"><div class="dossier-group-head"><span>01</span><h3>Curve reserves</h3></div><div data-reserves data-reserve-metrics>${reserves}</div></section><section class="dossier-group"><div class="dossier-group-head"><span>02</span><h3>Observation</h3></div><div data-activity data-activity-observation>${activity}</div></section><section class="dossier-group fee-group"><div class="dossier-group-head"><span>03</span><h3>Creator fees</h3></div><div class="fee-status"><span class="state-badge">Claim path unvalidated</span><p>No end-to-end fee claim has been proven and no claim receipt is published here. Nothing here reports fee income.</p></div></section></article></div></section></main>`;

  return page({
    title: `${token.name} (${token.symbol}) — Ponsr`,
    description: `${token.symbol} on Robinhood Chain: factory, bonding curve, fee splitter, deployer, pair asset, launch transaction, block and authoritative event time — as recorded on chain.`,
    canonical: `https://ponsr.fun/token/${token.token.toLowerCase()}/`,
    socialImage: socialImages.tokens.get(token.token.toLowerCase()),
    body,
  });
}

/* -------------------------------------------------------------------------- */
/* Account — honest signed-out architecture                                    */
/* -------------------------------------------------------------------------- */

/**
 * Each module says what it actually is, rather than all six saying "Preview".
 *
 * They stopped being previews at different times and are still not the same
 * thing as each other. Creator fees collects real fees -- it did so on
 * 2026-09-01 -- while Wallet shows a verified address and can still not send or
 * swap anything. One word covering both is wrong about one of them whichever
 * word is chosen.
 *
 * The third element is that word. It is a claim about what the module DOES, so
 * changing a module's behaviour means changing it here in the same commit.
 */
const accountRoutes = [
  ['Overview', '/account', 'Live'],
  ['Launches', '/account/launches', 'Live'],
  ['Creator fees', '/account/fees', 'Live'],
  ['Wallet', '/account/wallet', 'Read-only'],
  ['What-if lab', '/account/simulator', 'Public'],
  ['Security', '/account/security', 'Reference'],
];

const unavailableAction = (label) => `<button class="btn btn-disabled" type="button" disabled aria-disabled="true" title="Requires verified account connection">${esc(label)}</button>`;
/**
 * An absent value is MARKED absent, not typeset as one.
 *
 * `.account-stat strong` is bright silver at the value size, so "Unavailable"
 * arrived in exactly the voice a real figure would use. Four of those on one
 * page is why it read as broken rather than as not-yet: the design was shouting
 * an absence in the register reserved for facts. The class lets the stylesheet
 * say it quietly instead.
 */
const unavailableValue = (label, detail) => `<article class="account-stat is-unavailable"><p>${esc(label)}</p><strong>Unavailable</strong><span>${esc(detail)}</span></article>`;

function accountNav(current) {
  return `<div class="account-nav-wrap"><nav class="account-nav" aria-label="Account sections">${accountRoutes.map(([label, href, status],index) => `<a href="${href}/"${href===current?' aria-current="page"':''}><i>${String(index+1).padStart(2,'0')}</i><span>${esc(label)}<small>${esc(status)}</small></span></a>`).join('')}</nav><span class="account-nav-cue" aria-hidden="true">Swipe modules →</span></div>`;
}

function accountSidebar(current) {
  return `<aside class="account-sidebar"><a class="account-sidebar-brand" href="/account/"><img src="/logo-transparent.png" alt="" width="36" height="36"><span><strong>PONSR</strong><small>Command center</small></span></a>${accountNav(current)}<div class="account-sidebar-state"><span class="terminal-source-dot"></span><div><small>Session state</small><strong>Signed out</strong></div></div><a class="sidebar-explore" href="/explore/">Explore public launches <i>→</i></a></aside>`;
}

function accountConnection() {
  return `<section class="custody-boundary" role="status" data-account-connection><span class="account-lock" aria-hidden="true">◇</span><div><span class="signed-out-label" data-account-session-label>Custody boundary · account not connected</span><strong data-account-session-title>Private account data is locked</strong><p data-account-session-detail>Account connection unavailable until the authenticated backend reports ready. Numeric X identity must map to the exact existing Ponsr embedded wallet without creating another wallet.</p></div><div class="connection-actions"><button class="btn btn-disabled" type="button" disabled aria-disabled="true" data-account-signin>Sign-in not available</button><button class="btn btn-ghost" type="button" hidden data-account-logout>Sign out</button><a class="btn btn-ghost" href="/explore/"><span>Explore public records</span></a></div></section>`;
}

/**
 * THE OVERVIEW, WHICH USED TO ANSWER FOUR QUESTIONS WITH "UNAVAILABLE".
 *
 * All four were answerable. The wallet card printed the verified address and
 * captioned it "Requires verified account binding"; Launches said "No verified
 * identity is connected" to a reader whose identity was connected; Creator fees
 * said no account scope existed while the fees page beneath it collected real
 * money.
 *
 * Each cell now names where its answer comes from, and each is filled by the
 * client from a source it can actually read. A cell that cannot be read stays
 * unavailable and says why -- it is never quietly rendered as a zero, which on
 * a balance would be a claim that somebody has nothing.
 */
function accountOverview() {
  const cell = (label, hint, key) =>
    `<article class="account-stat is-unavailable" data-overview="${key}"><p>${esc(label)}</p><strong>Unavailable</strong><span>${esc(hint)}</span></article>`;
  return `<div class="account-grid"><section class="panel account-primary"><p class="eyebrow">Command center</p><h2>Your Ponsr account</h2><p class="lede">Launches, creator trading fees, wallet access and security, once your X identity and its existing wallet are verified.</p><div class="account-stats">${cell('Embedded wallet','Sign in to resolve your existing wallet.','wallet')}${cell('Native balance','Read from chain once an address is known.','balance')}${cell('Creator fees','Waiting in escrow for your launches.','fees')}${cell('Launches','Tokens launched by your X identity.','launches')}</div></section><aside class="panel account-side"><p class="eyebrow">Availability</p><h2>What works now</h2><ul class="account-status-list"><li><span class="status-readonly">Read-only</span>Public current-V2 launch records</li><li><span class="status-readonly">Live</span>X sign-in, resolving your existing wallet</li><li><span class="status-readonly">Live</span>Collecting creator fees, gas paid by Ponsr</li><li><span class="status-disabled">Disabled</span>Send, swap, and any signing by this site</li></ul><a class="btn btn-ghost" href="/explore/"><span>Browse public launches</span></a></aside></div>`;
}

/**
 * Every launch, as the public record already holds it.
 *
 * The route above is honest and empty: it will list launches bound to a signed-in
 * identity, and there is no sign-in yet. That left a page with nothing on it about
 * launches, which is the one subject where the record is completely public.
 *
 * This is not a filtered view and does not pretend to be. Someone who launched a
 * token can confirm it is recorded, with the same block and event time anyone else
 * would read, before an account exists to claim it with.
 */
function accountPublicLaunches() {
  return `<section class="panel account-module public-launches" data-account-public-launches><div class="account-module-head"><div><p class="eyebrow">Public record &middot; no account required</p><h2>Every verified launch</h2></div><span class="state-badge status-readonly">Public read-only</span></div><p class="lede">The complete current-V2 record, unfiltered. Signing in will narrow this to the launches bound to your identity; it will not reveal anything that is not already here.</p><div class="public-launch-rows" data-public-launch-rows><p class="note-inline">Reading the launch feed&hellip;</p></div></section>`;
}

function accountLaunches() {
  return `<section class="panel account-module"><div class="account-module-head"><div><p class="eyebrow">Your launches</p><h2>Launch records by verified identity</h2></div><span class="state-badge">Identity required</span></div><p class="lede">This view will list tokens whose immutable launch record maps to the signed-in numeric X identity. Public launches remain available without an account.</p><div class="account-empty" data-account-launches><strong>No authenticated launch scope</strong><p>Nothing is inferred from a handle, browser wallet, or public address. Authenticated records are keyed only by immutable numeric X identity.</p><a class="btn btn-ghost" href="/explore/"><span>Open public record</span></a></div></section>`;
}

/**
 * The escrow's own record, which needs no account at all.
 *
 * The page said "Unavailable" in every box -- accrued, claimable, queued, paid --
 * and read as broken rather than as not-yet. It was neither: the numbers exist,
 * they are public, and they were 0.02052 NVDA and 0.00944 SPCX when this was
 * written. What is genuinely account-scoped stays in the panel above; this is
 * the part that was never private.
 */
function accountFeeEscrow() {
  return `<section class="panel account-module fee-escrow" data-account-fee-escrow><div class="account-module-head"><div><p class="eyebrow">Public record &middot; no account required</p><h2>Waiting in escrow</h2></div><span class="state-badge status-readonly">Public read-only</span></div><p class="lede">What the deployment&rsquo;s escrow has credited to each launch&rsquo;s fee splitter, read from chain. Anyone can verify it, and anyone can trigger the split &mdash; the creator&rsquo;s share is pushed to the creator&rsquo;s own wallet, never to the caller.</p><div class="fee-escrow-rows" data-fee-escrow-rows><p class="note-inline">Reading the escrow&hellip;</p></div><p class="footer-note">Escrow credit per launch, not account-scoped and not a claim of ownership. A balance that cannot be read is shown as unavailable, never as zero.</p></section>`;
}

/**
 * WHAT THE FEES ACTUALLY ARE, SUMMED, FROM THE SAME READ AS THE DETAIL BELOW.
 *
 * This panel used to carry four boxes reading "Unavailable" -- accrued,
 * claimable, queued, paid -- above a badge saying "Account unavailable" and a
 * dead button captioned "Claim execution is deferred". Every one of those became
 * false on 2026-09-01, when the owner signed in and collected two launches'
 * fees from this page. A panel that says a feature is deferred, directly above
 * the working control for that feature, is worse than no panel.
 *
 * The three figures kept are the three that can be READ: what the escrow holds,
 * and how the splitter's own constants divide it. Queued and Paid are gone
 * rather than reworded -- neither is readable from chain without indexing past
 * events, and this repository does not display what it cannot read.
 *
 * The values are painted by the client from the same payload that fills the
 * per-launch rows, so a summary can never disagree with the detail under it.
 */
function accountFees() {
  const cell = (label, hint, key) =>
    `<article class="account-stat is-unavailable" data-fee-total="${key}"><p>${esc(label)}</p><strong>Unavailable</strong><span>${esc(hint)}</span></article>`;
  return `<section class="panel account-module" data-account-fee-summary><div class="account-module-head"><div><p class="eyebrow">Creator trading fees</p><h2>Receipt-backed accounting</h2></div><span class="state-badge status-readonly" data-fee-summary-scope>Public record</span></div><p class="lede">Read from the deployment&rsquo;s fee escrow and divided by the splitter&rsquo;s own constants. Fees are earned by trading; they are not dividends or guaranteed earnings.</p><div class="account-stats">${cell('Waiting in escrow','Across every Ponsr launch.','accrued')}${cell('Creator share','95% &mdash; paid to the creator&rsquo;s own wallet.','creator')}${cell('Ponsr share','5% &mdash; what the treasury keeps.','treasury')}</div><p class="note"><strong>Collecting needs no signature</strong>Anyone may trigger a split; the creator&rsquo;s share is pushed to the creator&rsquo;s own wallet, never to whoever called. Ponsr sends it for you and pays the gas.</p></section>`;
}

function accountWallet() {
  return `<div class="account-grid"><section class="panel account-primary"><p class="eyebrow">Embedded wallet</p><h2>Exact wallet continuity</h2><p class="lede">The website must recover access to the exact existing embedded-wallet address associated with the verified account. It must never create a replacement wallet or expose a private key.</p><div class="wallet-address-shell"><span>Wallet address</span><strong>Unavailable until account verification</strong><p data-wallet-hint>The verified address appears here once the authenticated account endpoint returns it.</p><div class="wallet-address-actions" data-wallet-actions hidden><button class="btn btn-ghost" type="button" data-wallet-copy>Copy address</button><a class="btn btn-ghost" data-wallet-explorer href="#" target="_blank" rel="noopener noreferrer">View on explorer &#8599;</a></div></div><div class="account-actions account-action-row">${unavailableAction('Receive')}${unavailableAction('Send')}${unavailableAction('Swap')}</div></section><aside class="panel account-side"><p class="eyebrow">Linked wallets</p><h2>No linking session</h2><p>External wallets require a domain-bound signed challenge with nonce, chain, expiry, and replay protection.</p>${unavailableAction('Link external wallet')}</aside></div>`;
}

function accountSimulator() {
  return `<section class="panel account-module simulator-directory"><div class="account-module-head"><div><p class="eyebrow">Read-only What-if lab</p><h2>Historical counterfactuals by launch</h2></div><span class="status-readonly state-badge">Public read-only</span></div><p class="lede">Choose a verified Ponsr launch, then explicitly select or paste a wallet on its token page. No X identity, embedded-wallet lookup, signature, approval, or transaction is used.</p><div class="card-grid" data-account-simulator-launches>${launches.map((token)=>`<a class="token-card" href="/token/${esc(token.token.toLowerCase())}/#what-if"><div class="top"><div><p class="eyebrow">What-if simulator</p><h3>${esc(token.name)}</h3><p class="proof-symbol">${esc(token.symbol)}</p></div><span class="go">OPEN LAB →</span></div><p class="footer-note">Canonical curve events · chain Transfer logs · RPC balance · GeckoTerminal price</p></a>`).join('')}</div><p class="note"><strong>Nothing here executes anything</strong>The lab reads history and does arithmetic on it. Receive, send and swap remain unavailable; collecting creator fees has moved to the fees page and needs no signature.</p></section>`;
}

/**
 * The security facts that need no account at all.
 *
 * The panel above is about ACCOUNT security -- identity binding, wallet
 * continuity, session controls -- and every one of those genuinely waits for a
 * sign-in. That left a security page with four "Unavailable" rows and nothing a
 * visitor could check, on the subject where checking is the whole point.
 *
 * These are the boundaries a stranger can verify without trusting a word of it:
 * which factory Ponsr launches through, which escrow credits creator fees, which
 * address deploys, and whether the public gate is open. Every one is an on-chain
 * fact with an explorer link beside it.
 */
function accountVerifiableNow() {
  const fact = (label, value, kind, note) =>
    `<article class="verifiable-fact"><span>${esc(label)}</span><strong>${kind ? `<a class="text-link" href="${EXPLORER}/${kind}/${esc(value)}" target="_blank" rel="noopener noreferrer">${esc(value)}</a>` : esc(value)}</strong><small>${esc(note)}</small></article>`;
  return `<section class="panel account-module verifiable-now"><div class="account-module-head"><div><p class="eyebrow">Public record &middot; no account required</p><h2>What anyone can verify</h2></div><span class="state-badge status-readonly">Public read-only</span></div><p class="lede">The boundaries this bot operates inside, as addresses rather than assurances. Follow any of them to the explorer and check.</p><div class="verifiable-facts">` +
    fact('Chain', 'Robinhood Chain · 4663', null, 'Every launch, fee and balance named on this site is on this chain.') +
    fact('Launch factory', feed.deployment.factory, 'address', 'The only contract Ponsr launches through. A launch from any other factory is not ours.') +
    fact('Fee escrow', ESCROW_ADDRESS, 'address', 'Where creator fees are credited before a splitter claims them.') +
    fact('Deployer', DEPLOYER_ADDRESS, 'address', 'The on-chain deployer of every Ponsr launch. The creator receives their share through a per-launch splitter, not from this address.') +
    `</div><div class="verifiable-gate" data-public-gate><span>Public launching</span><strong>Reading&hellip;</strong><small>Whether anyone can currently trigger a launch by mentioning the bot.</small></div></section>`;
}

function accountSecurity() {
  return `<section class="panel account-module"><div class="account-module-head"><div><p class="eyebrow">Security &amp; recovery</p><h2>Authority must be proven, not assumed</h2></div><span class="state-badge status-readonly">Verified</span></div><div class="security-list"><article><strong>Identity binding</strong><p>The stable numeric X user ID, verified server-side. A handle can be changed or reused; the number cannot.</p><span>Active</span></article><article><strong>Wallet continuity</strong><p>Sign-in resolves the exact existing Privy embedded wallet. It never creates a replacement, and a duplicate-creation race is refused rather than raced.</p><span>Active</span></article><article><strong>Session controls</strong><p>Host-prefixed cookies, a CSRF token matched on every write, expiry, and logout that revokes server-side rather than only clearing a cookie.</p><span>Active</span></article><article><strong>Signing authority</strong><p>The website holds no key and asks you for no signature &mdash; a test fails the build if any signing surface appears in it. Collecting fees needs neither: the split pays your wallet whoever sends it, so Ponsr sends it and pays the gas.</p><span>None, by design</span></article></div><p class="note"><strong>What this page is</strong>A description of the mechanisms, not a report on your session. Nothing here changes with who is reading it.</p></section>`;
}

function accountPage(route='/account') {
  const content = route==='/account/launches' ? accountLaunches() + accountPublicLaunches() : route==='/account/fees' ? accountFees() + accountFeeEscrow() : route==='/account/wallet' ? accountWallet() : route==='/account/simulator' ? accountSimulator() : route==='/account/security' ? accountSecurity() + accountVerifiableNow() : accountOverview();
  const title = accountRoutes.find(([,href])=>href===route)?.[0] || 'Overview';
  const routeIntro = {
    '/account':['Creator operations','One command center for launches, fees, wallet continuity, and account authority.'],
    '/account/launches':['Launch ownership','Exact creator-to-launch records after verified identity binding.'],
    '/account/fees':['Receipt-backed fees','Accrued, claimable, queued or processing, and paid or claimed remain distinct accounting groups.'],
    '/account/wallet':['Wallet continuity','Recover the exact existing embedded wallet—never create a replacement.'],
    '/account/simulator':['Read-only laboratory','Explore historical wallet counterfactuals without signing authority.'],
    '/account/security':['Authority & recovery','Identity, sessions, custody, and signing boundaries in one place.'],
  }[route] || ['Creator operations','Verified private account workspace.'];
  const body=`<main class="account-shell" data-auth-state="signed-out" data-identity-state="unavailable" data-private-data-state="locked" data-execution-authority="NO_WALLET_AUTHORITY" data-can-sign="false" data-can-send="false" data-can-swap="false" data-can-claim="false"><div class="account-command-shell">${accountSidebar(route)}<section class="account-workspace" data-account-route="${esc(route)}"><header class="account-route-head"><div><p class="eyebrow">${esc(routeIntro[0])}</p><h1 class="metal">${esc(title)}</h1><p class="lede">${esc(routeIntro[1])}</p></div><span class="workspace-mode" data-account-mode><i></i>Account · not connected</span></header>${accountConnection()}<div class="account-workspace-body">${content}</div></section></div></main>`;
  return page({title:`${title} — Ponsr account`,description:'The Ponsr account command center architecture, with honest unavailable states until verified X identity and existing-wallet continuity are wired.',canonical:`https://ponsr.fun${route}/`,socialImage:socialImages.account,body});
}

/* -------------------------------------------------------------------------- */

/**
 * Progressive inspector for launches discovered after the last static build.
 * Known snapshot launches retain pre-rendered token-specific HTML and metadata;
 * Netlify falls through to this shell only when no exact prebuilt page exists.
 */
function dynamicTokenPage() {
  return page({
    title: 'Inspect a Ponsr launch',
    description: 'Inspect an exact current V2 Ponsr launch address from the canonical live feed.',
    canonical: 'https://ponsr.fun/token/',
    noindex: true,
    body: `<main class="section dynamic-token" data-dynamic-token-page>` +
      `<div class="section-head"><p class="eyebrow">Current V2 launch</p>` +
      `<h1 class="metal" data-dynamic-token-title>Reading the record…</h1>` +
      `<p class="lede" data-dynamic-token-message>The exact address is being checked against the canonical Ponsr feed.</p></div>` +
      statusStrip() +
      `<div data-dynamic-token-content></div>` +
      `<p class="inline-links"><a class="btn btn-ghost" href="/explore/"><span>Explore launches</span></a></p>` +
      `</main>`,
  });
}

/**
 * True not-found, as its own state.
 *
 * `/token/<address>` resolves through a Netlify splat to a prebuilt directory,
 * so an address Ponsr never launched has no page. That is a genuinely different
 * answer from "the source failed" or "nothing has launched", and the brief asks
 * for the three to be distinguishable. Netlify serves this for any unmatched
 * path, so the distinction survives a direct navigation or a refresh.
 */
function notFound() {
  return page({
    title: 'Not on the record — Ponsr',
    description: 'This address is not a current V2 launch recorded by Ponsr.',
    canonical: 'https://ponsr.fun/404',
    body: `<main class="section">` +
      `<div class="section-head">` +
        `<p class="eyebrow">Not on the record</p>` +
        `<h1 class="metal">Nothing here.</h1>` +
        `<p class="lede">This page is not a current V2 launch recorded by Ponsr. That is different from a launch we could not read — ` +
        `if the source were failing, the record page would say so rather than showing you this.</p>` +
      `</div>` +
      `<p class="inline-links"><a class="btn btn-primary" href="/explore/"><span>Browse the record</span></a>` +
      `<a class="btn btn-ghost" href="/"><span>Home</span></a></p></main>`,
  });
}

/**
 * Terms.
 *
 * The legal body is a hand-written fragment under `website/content/`; only the
 * chrome is generated. It used to be a standalone file carrying its own copy of
 * the navigation, and that copy had already drifted — it linked to "Monitor",
 * a page name nothing else used, and styled itself with class names this
 * redesign renames. Generating the chrome means the drift cannot come back,
 * while the wording that actually carries obligations stays under review as a
 * file someone edits deliberately.
 */
async function terms() {
  const body = await fs.readFile(path.join(site, 'content/terms.body.html'), 'utf8');
  return page({
    title: 'Terms & Disclaimer — Ponsr',
    description: 'Ponsr terms, current V2 fee mechanics, and risk disclaimer.',
    canonical: 'https://ponsr.fun/terms',
    body: `<main>` +
      `<header class="token-hero reveal"><p class="eyebrow">Terms · 28 August 2026</p>` +
      `<h1 class="metal">Use the record. Understand the risk.</h1></header>` +
      `<section class="section">${body}</section></main>`,
  });
}

await fs.writeFile(path.join(site, 'index.html'), home());
await fs.writeFile(path.join(site, '404.html'), notFound());
await fs.writeFile(path.join(site, 'terms.html'), await terms());
await fs.mkdir(path.join(site, 'explore'), { recursive: true });
await fs.writeFile(path.join(site, 'explore/index.html'), explore());
await fs.mkdir(path.join(site, 'token'), { recursive: true });
await fs.writeFile(path.join(site, 'token/index.html'), dynamicTokenPage());
for (const [, route] of accountRoutes) {
  const directory = path.join(site, route.slice(1));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'index.html'), accountPage(route));
}

for (const token of launches) {
  const address = token.token.toLowerCase();
  const directory = path.join(site, 'token', address);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'index.html'), tokenPage(token));
}

const routes = ['', 'explore', 'terms', ...accountRoutes.map(([, route]) => route.slice(1)), ...launches.map((token) => `token/${token.token.toLowerCase()}`)];
/**
 * THE SITEMAP LISTS THE URL THAT SERVES 200, NOT ONE THAT REDIRECTS.
 *
 * Measured live: `/explore` answers 301 to `/explore/`, while `/terms` answers
 * 200 and `/terms/` answers 301 the other way. The rule is not "always add a
 * slash" -- it is how the page was WRITTEN. A page written as `terms.html` is
 * served at `/terms`; one written as `explore/index.html` at `/explore/`. A
 * blanket trailing slash would have broken the two file-backed pages, which is
 * why this is derived from the layout rather than decreed.
 *
 * It matters twice over: a canonical tag naming a redirecting URL points away
 * from itself, and every crawl of every page paid for a round trip carrying no
 * content.
 */
const FILE_BACKED = new Set(['terms', '404']);
const canonicalPath = (route) => (route === '' || FILE_BACKED.has(route) ? route : `${route}/`);
const urls = routes.map((route) => `  <url><loc>https://ponsr.fun/${canonicalPath(route)}</loc></url>`).join('\n');
await fs.writeFile(
  path.join(site, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
);

console.log(`Built ${routes.length} routes with ${feed.launches.length} canonical token page(s).`);
