/**
 * A social card for a token the last build had never heard of.
 *
 * The site renders a card for every token in the committed snapshot, and that
 * is enough right up to the moment it matters most: a launch is shared within
 * seconds of happening, and the site does not rebuild when someone launches. So
 * the first person to paste a fresh token link got the generic site card, with
 * no name, no symbol and no evidence — measured on Microduck's page an hour
 * after it launched, which unfurled as "Inspect a Ponsr launch".
 *
 * This renders the same card the build renders, from the same module, for any
 * address the canonical feed can verify. It refuses to draw one for an address
 * the feed does not know, because a card is an assertion that the token is a
 * real Ponsr launch and this endpoint must not make that claim on its own.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import snapshot from '../../website/data/launches.json' with { type: 'json' };
import { tokenCardSvg } from './lib/socialCard.mjs';
import { useVendoredFonts } from './lib/fonts.mjs';

// The Lambda runtime ships no fonts at all. Without this every glyph renders as
// a tofu box, which is exactly what the first deployed card did.
const fontsReady = useVendoredFonts();

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

let mascotPromise = null;
/** Read once per container, and never fail the card because the art is missing. */
function mascot() {
  mascotPromise ??= fs
    .readFile(path.join(process.cwd(), 'website', 'logo-transparent.png'))
    .then((buffer) => `data:image/png;base64,${buffer.toString('base64')}`)
    .catch(() => '');
  return mascotPromise;
}

/**
 * The verified launch, from the snapshot first and the live feed second.
 *
 * `answered` separates "the feed says this is not a Ponsr launch" from "the
 * feed could not be reached". Collapsing those was a real defect: a cold start
 * pushed the feed past the deadline and the card answered 404, which a crawler
 * reads as a permanent absence and a CDN is entitled to keep. A card that
 * cannot be verified RIGHT NOW is a retry, not a verdict.
 */
async function findLaunch(address, request) {
  const known = snapshot.launches.find((l) => String(l.token).toLowerCase() === address);
  if (known) return { launch: known, answered: true };
  try {
    const feed = await fetch(new URL('/.netlify/functions/launch-feed', request.url), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(9000),
    });
    if (!feed.ok) return { launch: null, answered: false };
    const body = await feed.json();
    if (!Array.isArray(body?.launches)) return { launch: null, answered: false };
    return {
      launch: body.launches.find((l) => String(l.token).toLowerCase() === address) ?? null,
      answered: true,
    };
  } catch {
    return { launch: null, answered: false };
  }
}

export default async (request) => {
  const address = String(new URL(request.url).pathname.split('/').pop() ?? '')
    .replace(/\.png$/i, '')
    .toLowerCase();
  if (!ADDRESS.test(address)) return new Response('Not found', { status: 404 });

  const { launch, answered } = await findLaunch(address, request);
  // Unreachable feed: say so, and say it in a way nothing keeps. A 404 here
  // would outlive the outage that caused it.
  if (!answered) {
    return new Response('Card temporarily unavailable', {
      status: 503,
      headers: { 'cache-control': 'no-store', 'retry-after': '30' },
    });
  }
  // No card for an unverified address. The generic site card is the honest
  // fallback, and the page's own metadata already says what is known.
  if (!launch) return new Response('Not found', { status: 404 });

  const svg = tokenCardSvg({
    symbol: launch.symbol,
    name: launch.name,
    pairLabel: launch.pairLabel,
    address: launch.token,
    mascotHref: await mascot(),
  });

  if (!fontsReady) return new Response('Card fonts unavailable', { status: 503 });

  const png = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();

  return new Response(png, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      // Crawlers refetch these constantly and the inputs are immutable once a
      // token exists, so a long cache costs nothing and keeps unfurls fast.
      'cache-control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
      'x-content-type-options': 'nosniff',
    },
  });
};
