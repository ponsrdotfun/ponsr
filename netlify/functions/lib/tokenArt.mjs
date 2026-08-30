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
export const TIMEOUT_MS = 2500;
const RENDER_PX = 320;

/**
 * The token's picture as a data URI, with the proportions it kept, or null.
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
     * THE PICTURE IS NOT ALTERED. IT IS PLACED IN A FRAME.
     *
     * Three things were quietly changing it, and each looked reasonable on its
     * own. `cover` filled the frame and threw away whatever did not fit. The
     * circular mask cut the corners off every square picture -- and a meme-coin
     * PFP is square, with its horns and ears in exactly those corners. Then
     * `contain` fixed the cropping by PADDING the picture with dark bars until
     * it was square, which is not cropping but is still handing back something
     * the launcher did not make.
     *
     * `inside` only scales. No crop, no padding, no letterbox, no distortion --
     * the same picture, smaller. The frame is then built to the picture's own
     * proportions rather than the picture being reshaped to the frame's, which
     * is the whole of the rule: put it in the object, do not make it fit.
     *
     * What remains, and cannot be removed: the bytes are re-encoded here and
     * scaled to the card's size. That is the safety rule above -- nothing may
     * ride onto the page inside a file that merely claims to be a picture. No
     * pixel is added, removed or moved; only the container changes.
     */
    const resized = await sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false })
      .resize(RENDER_PX, RENDER_PX, { fit: 'inside' })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    const png = resized.data;
    const aspect = resized.info.height ? resized.info.width / resized.info.height : 1;

    return { href: `data:image/png;base64,${png.toString('base64')}`, aspect };
  } catch {
    return null;
  }
}
