const PHOTO_HOST = 'pbs.twimg.com';
const PHOTO_PATH = /^\/media\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/i;
const MAX_URL_LENGTH = 512;

/** Reads provider-owned media fields only. Tweet text is intentionally not inspected. */
export function structuredPhotoUrls(tweet: any): string[] {
  const candidates = [tweet?.media, tweet?.extendedEntities?.media, tweet?.entities?.media]
    .find((value) => Array.isArray(value)) ?? [];
  return candidates.flatMap((item: any) => {
    if (String(item?.type ?? '').toLowerCase() !== 'photo') return [];
    const value = item?.media_url_https ?? item?.url ?? item?.mediaUrl;
    return typeof value === 'string' && value ? [value] : [];
  });
}

/** Accepts only one structured X photo entity. Tweet text and arbitrary URLs never enter here. */
export function trustedPhotoUrl(urls: readonly string[] | null | undefined): string | null {
  if (!Array.isArray(urls) || urls.length === 0) return null;
  if (urls.length !== 1) return null;
  const raw = String(urls[0] ?? '');
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== PHOTO_HOST || url.username || url.password || url.port) return null;
    if (!PHOTO_PATH.test(url.pathname)) return null;
    for (const key of url.searchParams.keys()) if (!['format', 'name'].includes(key)) return null;
    const format = url.searchParams.get('format');
    if (format && !/^(?:jpe?g|png|webp)$/i.test(format)) return null;
    const name = url.searchParams.get('name');
    if (name && !/^(?:small|medium|large|orig)$/i.test(name)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}
