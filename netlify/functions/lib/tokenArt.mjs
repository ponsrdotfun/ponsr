/**
 * THE TOKEN'S OWN PICTURE, ON ITS OWN CARD.
 *
 * A launch carries an image: the photo attached to the tweet that asked for it
 * travels as the `logo` string in the launch calldata and is readable back from
 * the token's own getter. Until now every card drew the Ponsr robot, so a
 * hundred launches would have unfurled as a hundred identical robots.
 *
 * FETCHING A PICTURE SOMEBODY ELSE CHOSE IS THE DANGEROUS PART, and this is a
 * server making that request, so the rules are not stylistic.
 *
 *   - **Only pbs.twimg.com, re-checked here.** `trustedTokenLogo` already
 *     narrowed it when the feed was built, and it is applied AGAIN at the point
 *     of use. A value that travelled through a snapshot, a JSON body and two
 *     functions is not the value that was validated; it is a string that
 *     resembles it.
 *   - **Redirects are refused, not followed.** An allow-list on the URL means
 *     nothing if the host is permitted to forward the request somewhere else.
 *   - **Bounded bytes, bounded pixels, bounded time.** A response is capped
 *     before it is decoded, and the decoder is capped before it allocates --
 *     an image can be small on the wire and enormous once expanded.
 *   - **Re-encoded, never passed through.** The bytes that reach the card are
 *     the ones this process wrote, so nothing rides along inside a file that
 *     merely claims to be a picture.
 *   - **It never throws and never fails a card.** Anything unexpected returns
 *     null and the robot is drawn, because a card that renders is worth more
 *     than a card that is perfect.
 *
 * What this does NOT do is judge what the picture shows. The image is whatever
 * the person who launched the token attached to their tweet, re-served from
 * ponsr.fun. That is the feature working as asked, and it is worth knowing.
 */
import sharp from 'sharp';
import { trustedTokenLogo } from './collector.mjs';

/** Plenty for a 320px card portrait; small enough that nothing large is decoded. */
const MAX_BYTES = 3_000_000;
const MAX_PIXELS = 40_000_000;
const TIMEOUT_MS = 3500;
const RENDER_PX = 320;

/**
 * A data URI for the token's picture, or null.
 *
 * A data URI rather than a URL because the rasteriser does not fetch remote
 * hrefs at all -- an `<image href="https://...">` renders as nothing, which is
 * the sort of failure that looks like a styling bug for a week.
 */
export async function tokenArtDataUri(logo, { fetchImpl = fetch } = {}) {
  const url = trustedTokenLogo(logo);
  if (!url) return null;

  try {
    const response = await fetchImpl(url, {
      // Following a redirect would hand the destination back to the host.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'image/*' },
    });
    if (!response.ok) return null;
    if (!String(response.headers?.get?.('content-type') ?? '').startsWith('image/')) return null;

    // Cap before decoding: a declared length is a hint, so the real bytes are
    // measured too.
    const declared = Number(response.headers?.get?.('content-length') ?? 0);
    if (declared > MAX_BYTES) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) return null;

    /**
     * How a picture meets a round frame depends on its shape.
     *
     * `cover` fills the circle and is right for the ordinary case. Measured by
     * rendering real images: a 16:9 photo -- the commonest shape a camera
     * produces -- looks best filling the frame, and letterboxing every one of
     * them would waste it. But against a 3:1 banner `cover` was plainly wrong:
     * most of the picture was thrown away and the crop sliced a word in half,
     * which reads as a broken card rather than a tight one.
     *
     * So only an unusually long picture is fitted whole, on the card's own
     * ground. Something is lost either way; losing the frame's tidiness beats
     * losing the picture.
     */
    const source = sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false });
    const { width = 0, height = 0 } = await source.metadata();
    const ratio = width && height ? width / height : 1;
    const elongated = ratio > 2.0 || ratio < 1 / 2.0;

    const png = await source
      .resize(RENDER_PX, RENDER_PX, {
        fit: elongated ? 'contain' : 'cover',
        position: 'attention',
        background: '#0A0D11',
      })
      .png({ compressionLevel: 9 })
      .toBuffer();

    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
}
