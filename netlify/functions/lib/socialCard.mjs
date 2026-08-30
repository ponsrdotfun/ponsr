/**
 * ONE CARD DESIGN, TWO CALLERS.
 *
 * The build renders a card for every token it knows about; the on-demand
 * endpoint renders one for a token launched since that build. If those two ever
 * drew different cards, a link's preview would change the moment the site
 * happened to redeploy — so the drawing lives here and neither caller owns it.
 *
 * WHY A TOKEN CARD IS NOT THE PAGE CARD
 * -------------------------------------
 * A shared link is read at a glance, in a feed, by someone who has never heard
 * of the token. The three things that earn that glance are the symbol, the fact
 * that it is real, and what it trades against. So the symbol is the largest
 * object on the card, the name sits under it, and the pair asset and contract
 * fingerprint sit on the baseline as evidence rather than decoration.
 *
 * The visual language is production's: the void ground, an emerald bloom, the
 * brushed-metal gradient on the display face, hairline rules, and the robot.
 * Nothing on this card is a number that could be mistaken for a price.
 */

/**
 * The renderer has no font fallback worth trusting.
 *
 * A bare `monospace` family silently resolved to a SERIF in the build
 * container, so the contract line came out in a different design language from
 * the row beside it. Worse, the Lambda runtime has NO fonts at all and drew
 * every character as a tofu box. The faces are vendored now (see `fonts.mjs`)
 * and named first; the system stacks remain only as a last resort.
 */
import { FONT_MONO, FONT_SANS, FONT_SERIF } from './fonts.mjs';

const MONO = `${FONT_MONO},DejaVu Sans Mono,Menlo,Consolas,monospace`;
const SANS = `${FONT_SANS},DejaVu Sans,Arial,Helvetica,sans-serif`;
const SERIF = `${FONT_SERIF},Georgia,Times New Roman,serif`;

const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** Rough advance width, so a long name is trimmed rather than escaping the card. */
const fit = (text, max) => {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const DEFS = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#050607"/><stop offset="0.58" stop-color="#0A0D11"/><stop offset="1" stop-color="#10261C"/>
    </linearGradient>
    <radialGradient id="glow"><stop stop-color="#46C88C" stop-opacity=".26"/><stop offset="1" stop-color="#46C88C" stop-opacity="0"/></radialGradient>
    <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#FDFEFF"/><stop offset=".48" stop-color="#C4CDDA"/><stop offset="1" stop-color="#8D98A7"/>
    </linearGradient>
    <linearGradient id="emerald" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#EAF6EF"/><stop offset=".44" stop-color="#82E3B3"/><stop offset="1" stop-color="#2E9A67"/>
    </linearGradient>
    <!-- userSpaceOnUse: a horizontal line has a zero-height bounding box, and an
         objectBoundingBox gradient collapses to nothing across it. -->
    <linearGradient id="rule" gradientUnits="userSpaceOnUse" x1="76" y1="0" x2="1124" y2="0">
      <stop stop-color="#C4CDDA" stop-opacity="0"/><stop offset=".5" stop-color="#82E3B3" stop-opacity=".55"/><stop offset="1" stop-color="#C4CDDA" stop-opacity="0"/>
    </linearGradient>
  </defs>`;

const CHROME = (mascot) => `
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="965" cy="255" r="330" fill="url(#glow)"/>
  <path d="M70 72H1130M70 558H1130" stroke="#C4CDDA" stroke-opacity=".14"/>
  <circle cx="91" cy="91" r="18" fill="none" stroke="#82E3B3" stroke-width="3"/>
  <circle cx="91" cy="91" r="5" fill="#82E3B3"/>
  <text x="125" y="104" fill="#F1F5FA" font-family="${SANS}" font-size="28" font-weight="700" letter-spacing="8">PONSR</text>
  ${mascot}`;

/** The generic page card: eyebrow, one or two display lines, a detail, a badge. */
export function socialSvg({ eyebrow, title, detail, badge, detailSize = 25, mascotHref = '' }) {
  const titleLines = String(title).split('\n').slice(0, 2);
  const mascot = mascotHref
    ? `<image href="${mascotHref}" x="825" y="95" width="300" height="300" preserveAspectRatio="xMidYMid meet"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">${DEFS}
    ${CHROME(mascot)}
    <text x="76" y="190" fill="#82E3B3" font-family="${MONO}" font-size="20" letter-spacing="4">${esc(String(eyebrow).toUpperCase())}</text>
    ${titleLines.map((line, index) => `<text x="72" y="${285 + index * 76}" fill="url(#metal)" font-family="${SERIF}" font-size="68">${esc(line)}</text>`).join('')}
    <text x="76" y="${titleLines.length > 1 ? 455 : 375}" fill="#C4CDDA" font-family="${SANS}" font-size="${detailSize}">${esc(detail)}</text>
    <rect x="76" y="500" width="${Math.max(190, String(badge).length * 15 + 48)}" height="48" rx="24" fill="#46C88C" fill-opacity=".10" stroke="#46C88C" stroke-opacity=".7"/>
    <text x="100" y="531" fill="#82E3B3" font-family="${MONO}" font-size="17" letter-spacing="2">${esc(String(badge).toUpperCase())}</text>
  </svg>`;
}

/**
 * A card for one token.
 *
 * The symbol carries the card because it is what a reader recognises in a feed.
 * Everything else is evidence: the name, what it is paired against, and a
 * shortened contract address so the reader can tell two tokens with the same
 * symbol apart — which has already happened here twice in one day.
 */
export function tokenCardSvg({ symbol, name, pairLabel, address, mascotHref = '', artHref = '' }) {
  /**
   * The token's own picture takes the robot's place when it has one.
   *
   * A launch carries the photo attached to the tweet that asked for it, so a
   * card can show what the token actually is rather than the same robot a
   * hundred times. It is framed rather than dropped in: a circular mask so any
   * aspect ratio composes, and an emerald ring so a picture with a dark edge
   * does not dissolve into the background.
   *
   * The robot remains the fallback, and is what a launch with no image gets.
   */
  // Only the shape this file's own producer emits. The value is written into an
  // href attribute, and "the caller always passes something safe" is a property
  // of today's callers, not of this function.
  const art = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(artHref)) ? String(artHref) : '';
  // Raised off the baseline: at cy 445 the outer ring crossed the hairline at
  // y 558, which reads as a mistake rather than a frame.
  const portrait = art
    ? `<clipPath id="art"><circle cx="995" cy="428" r="115"/></clipPath>
       <circle cx="995" cy="428" r="126" fill="#050607" fill-opacity=".55"/>
       <image href="${art}" x="880" y="313" width="230" height="230" preserveAspectRatio="xMidYMid slice" clip-path="url(#art)"/>
       <circle cx="995" cy="428" r="115" fill="none" stroke="url(#emerald)" stroke-width="3" stroke-opacity=".85"/>
       <circle cx="995" cy="428" r="126" fill="none" stroke="#C4CDDA" stroke-opacity=".16"/>`
    : '';
  const mascot = art
    ? portrait
    : mascotHref
      ? `<image href="${mascotHref}" x="880" y="330" width="230" height="230" preserveAspectRatio="xMidYMid meet" opacity="0.92"/>`
      : '';
  const ticker = fit(String(symbol || 'TOKEN').toUpperCase(), 12);
  // Stepped by length rather than measured: the renderer gives us no text
  // metrics, and a ticker that overruns the card is worse than one slightly small.
  const tickerSize = ticker.length > 8 ? 96 : ticker.length > 6 ? 116 : 132;
  const short = String(address || '');
  const fingerprint = short ? `${short.slice(0, 10)}…${short.slice(-8)}` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">${DEFS}
    ${CHROME(mascot)}
    <text x="76" y="196" fill="#82E3B3" font-family="${MONO}" font-size="20" letter-spacing="4">LAUNCHED VIA PONSR</text>

    <text x="72" y="330" fill="url(#emerald)" font-family="${SANS}" font-weight="700" font-size="${tickerSize}" letter-spacing="-2">$${esc(ticker)}</text>
    <text x="76" y="392" fill="url(#metal)" font-family="${SERIF}" font-size="46">${esc(fit(name || 'Unnamed token', 30))}</text>

    <rect x="76" y="437" width="${art ? 769 : 1048}" height="2" fill="url(#rule)"/>

    <text x="76" y="486" fill="#8B94A1" font-family="${MONO}" font-size="17" letter-spacing="2">PAIRED WITH</text>
    <text x="76" y="522" fill="#F1F5FA" font-family="${SANS}" font-size="30" font-weight="600">${esc(fit(pairLabel || 'native ETH', 22))}</text>

    <text x="420" y="486" fill="#8B94A1" font-family="${MONO}" font-size="17" letter-spacing="2">CONTRACT</text>
    <text x="420" y="520" fill="#C4CDDA" font-family="${MONO}" font-size="24">${esc(fingerprint)}</text>

    <rect x="76" y="556" width="330" height="42" rx="21" fill="#46C88C" fill-opacity=".10" stroke="#46C88C" stroke-opacity=".55"/>
    <text x="100" y="583" fill="#82E3B3" font-family="${MONO}" font-size="16" letter-spacing="2">VERIFIED CURRENT V2 RECORD</text>
  </svg>`;
}
