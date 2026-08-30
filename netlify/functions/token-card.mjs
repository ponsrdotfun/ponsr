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
import {
  collectPairSymbol,
  collectTokenMetadata,
  jsonRpc,
  parseBlockNumber,
  resolveVerifiedLaunch,
} from './lib/collector.mjs';
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

const RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const RPC_BUDGET_MS = 12000;

/**
 * The verified launch, from the snapshot first and the chain second.
 *
 * IT READS THE CHAIN DIRECTLY, rather than calling the launch feed over HTTP.
 * The hop was measured flapping: six consecutive requests for a token that
 * plainly exists returned 404, and the next six returned 200 — a function
 * calling another function through the CDN pays a second cold start, and a card
 * is fetched exactly once by a crawler that will not come back. `market-data`
 * and `what-if` already resolve a launch this way; this is that same path.
 *
 * `answered` separates "the chain says this is not a Ponsr launch" from "the
 * chain could not be read". Collapsing those was the other half of the defect:
 * a crawler reads 404 as a permanent absence, and a CDN is entitled to keep it.
 * A card that cannot be verified RIGHT NOW is a retry, not a verdict.
 */
async function findLaunch(address) {
  const known = snapshot.launches.find((l) => String(l.token).toLowerCase() === address);
  if (known) return { launch: known, answered: true };

  const deadline = Date.now() + RPC_BUDGET_MS;
  const rpc = (method, params) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('RPC request budget exhausted');
    return jsonRpc(RPC_URL, method, params, Math.min(8000, remaining));
  };

  try {
    const head = parseBlockNumber(await rpc('eth_blockNumber', []));
    const launch = await resolveVerifiedLaunch({ rpc, snapshot, token: address, head });
    // Discovery completed and this address is not one of ours. That is an answer.
    if (!launch) return { launch: null, answered: true };

    // The launch EVENT names neither the token nor the asset it trades against,
    // so a card drawn from it alone would read "$UNKNOWN / Metadata unavailable
    // / approved token". That is not a preview, it is a shrug — retry instead.
    const [metadata, pairSymbol] = await Promise.all([
      collectTokenMetadata({ rpc, token: launch.token, blockNumber: head }),
      collectPairSymbol({ rpc, pairToken: launch.pairToken, blockNumber: head }),
    ]);
    return {
      launch: { ...launch, ...metadata, pairLabel: pairSymbol || launch.pairLabel },
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

  const { launch, answered } = await findLaunch(address);
  // Unreadable chain: say so, and say it in a way nothing keeps. A 404 here
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
