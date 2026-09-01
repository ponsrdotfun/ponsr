/**
 * THE LAUNCHPAD CARD, DESCRIBED ONCE.
 *
 * This component was written twice -- once in `scripts/build-website.mjs` and
 * once in `website/assets/app.mjs` -- and the two copies had drifted in four
 * ways by the time they were compared:
 *
 *   - the cover link named the redirecting URL in one and the served one in
 *     the other, so the main clickable target of every card cost a 301;
 *   - one credited the creator and the other still said "by <treasury>";
 *   - the graduation percentage was labelled in one and bare in the other;
 *   - the progress arithmetic existed twice, in two spellings.
 *
 * Only the last of those was ever going to be found by reading the code. The
 * others were found by opening the page.
 *
 * VALUES ARE INPUTS, STRUCTURE IS NOT
 * -----------------------------------
 * The two producers legitimately differ about what they KNOW. The client can
 * show a market cap the static build has never observed, and it anchors
 * relative time against a clock the build does not have. Forcing those to
 * agree would be unifying the wrong half. So the caller passes what it knows
 * and this file owns the shape -- which is the half that was drifting.
 */
import { h } from './markup.mjs';
import { shortAddress } from './format.mjs';

/**
 * The only image host this site will load from, and the only shapes of URL.
 *
 * Byte-identical in both producers before this: same regex, same allowlist,
 * same query-parameter rule. Two copies of a security check are two chances to
 * relax one of them.
 */
export function trustedLogoUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'pbs.twimg.com' ||
      url.username ||
      url.password ||
      url.port ||
      !/^\/media\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(url.pathname)
    ) {
      return null;
    }
    for (const key of url.searchParams.keys()) if (!['format', 'name'].includes(key)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * THE ARTWORK BLOCK, AND WHY AN ABSENT LOGO IS NOT A BROKEN CARD.
 *
 * The placeholder used to be a radar pattern, three dots and the words TOKEN
 * IMAGE UNAVAILABLE across the middle -- which reads as a failure every time,
 * on a card whose token is perfectly fine. Two of three launches have no image,
 * so that was most of the board announcing a problem that does not exist.
 *
 * The token's own ticker is the art instead: identity rather than absence. The
 * accessible label still says the image is missing, because the screen-reader
 * user is the one who does need telling.
 *
 * The length goes in a data attribute and never an inline style: this site
 * keeps a strict CSP and a test guards it. CSS cannot measure text, so the
 * stylesheet carries one static rule per length.
 */
export function tokenArt(token) {
  const logo = trustedLogoUrl(token.logo);
  if (logo) {
    return h(
      'div',
      { class: 'token-art has-image' },
      h('img', { src: logo, alt: `${token.name} token image`, loading: 'lazy', decoding: 'async' })
    );
  }
  const symbol = String(token.symbol || '?');
  return h(
    'div',
    { class: 'token-art unavailable', role: 'img', 'aria-label': `Token image unavailable for ${token.symbol}` },
    h('span', { class: 'art-grid' }),
    h('span', { class: 'art-symbol', 'data-art-len': String(Math.min(12, symbol.length)) }, symbol.toUpperCase())
  );
}

/**
 * How far a launch has moved toward graduation, as a percentage.
 *
 * Shared because it existed twice: the build script had `curveProgress` and the
 * client recomputed the same ratio inline, in a different spelling. Two
 * implementations of one arithmetic is a divergence waiting for a rounding
 * change to reveal it.
 *
 * Returns 0 when the threshold is unreadable rather than guessing -- an
 * unknown denominator is not a full bar.
 */
export function curveProgress(token) {
  try {
    const reserve = BigInt(token?.reserves?.realQuoteReserveWei ?? 0);
    const threshold = BigInt(token?.graduationThreshold ?? 0);
    if (threshold <= 0n) return 0;
    return Number((reserve * 100000n) / threshold) / 1000;
  } catch {
    return 0;
  }
}

/**
 * The canonical path for a token page.
 *
 * With the trailing slash, because the page is written as
 * `token/<address>/index.html` and only that form is served directly. The
 * client's copy of this card omitted it, so every card's cover link redirected.
 */
export function tokenHref(token) {
  return `/token/${String(token.token).toLowerCase()}/`;
}

/**
 * @param token           a launch from the public feed
 * @param art             a description of the artwork block, from the caller
 * @param marketCapLabel  what the caller knows about market cap, already worded
 * @param relativeTime    the caller's own rendering of "how long ago"
 */
export function launchpadCard({ token, art, marketCapLabel, relativeTime }) {
  const progress = curveProgress(token);
  const percent = `${progress.toFixed(2)}%`;

  return h(
    'article',
    { class: 'launchpad-card' },
    h('a', { class: 'launchpad-card-link', href: tokenHref(token), 'aria-label': `Inspect ${token.name}` }),
    h(
      'div',
      { class: 'launchpad-media' },
      art,
      h('span', { class: 'protocol-badge', 'data-protocol-badge': '' }, 'V2')
    ),
    h(
      'div',
      { class: 'launchpad-card-body' },
      h('h3', {}, token.name),
      h('p', { class: 'launchpad-symbol' }, `$${token.symbol}`),
      h('p', { class: 'launchpad-mcap', 'data-card-market-cap': '' }, h('strong', {}, marketCapLabel)),
      h(
        'div',
        { class: 'launchpad-progress' },
        // Named on screen and to a screen reader. A bare percentage sitting
        // under "market cap unavailable" reads as a price change, and this site
        // hides the 24h change rather than inventing one.
        h('span', {}, `${percent} to graduation`),
        h(
          'progress',
          { max: '100', value: String(progress), 'aria-label': 'Bonding curve progress to graduation' },
          percent
        )
      ),
      // The treasury sends every launch, so crediting it made three tokens look
      // like one anonymous wallet's on a product that sells "launch YOUR token".
      h(
        'p',
        { class: 'launchpad-deployer' },
        token.creator ? `creator ${shortAddress(token.creator)}` : `deployer ${shortAddress(token.deployer)}`
      ),
      h(
        'div',
        { class: 'launchpad-bottom' },
        h(
          'button',
          { type: 'button', 'data-copy-address': token.token, 'aria-label': `Copy contract address ${token.token}` },
          h('span', {}, shortAddress(token.token)),
          h('i', { 'data-copy-label': '', role: 'status', 'aria-live': 'polite' }, 'Copy')
        ),
        h('time', { datetime: token.blockTimestamp || '', 'data-card-relative-time': '' }, relativeTime)
      )
    )
  );
}
