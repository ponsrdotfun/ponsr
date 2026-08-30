/**
 * One set of formatters, shared by the build and the browser.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The static build and the runtime both render the same facts, and for a while
 * both owned their own copy of the formatting. The copies drifted immediately:
 * a pluralisation fix landed in the build, the page still read "1 sells",
 * because `app.mjs` overwrote the corrected markup with its own string. The bug
 * was not the plural — it was that the same sentence had two authors.
 *
 * This repository has hit that shape repeatedly under a different name: a
 * correct function beside a composition that ignores it. The cure is the same
 * every time — delete one of the two, do not synchronise them.
 *
 * Everything here returns PLAIN TEXT. Nothing returns markup, so neither caller
 * can be tempted to inject: the build escapes what it interpolates, and the
 * runtime assigns through `textContent`.
 */

export const shortAddress = (value) => (value
  ? `${String(value).slice(0, 8)}…${String(value).slice(-6)}`
  : 'Unknown');

export const whole = (value) => Number(value || 0).toLocaleString('en-US');

/**
 * An event time, or an honest absence.
 *
 * `Intl.DateTimeFormat().format(new Date('not-a-date'))` THROWS RangeError, it
 * does not return a placeholder. This function is called while rendering token
 * cards and the token page, so one malformed timestamp in the feed would have
 * taken the whole render down — and a page that fails to draw is a worse
 * failure than a page that admits it cannot date one launch.
 *
 * An unparseable time is treated exactly like a missing one: unavailable. It is
 * never silently replaced with now, which `feed-model.mjs` guards on its own
 * side too.
 */
export const eventTime = (value) => {
  if (!value) return 'Event time unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Event time unavailable';
  return `${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`;
};

export const plural = (count, one, many) => `${whole(count)} ${Number(count) === 1 ? one : many}`;

/**
 * Wei to ETH through BigInt, never a float.
 *
 * `Number(BigInt(wei)) / 1e18` loses precision above 2^53 and quietly invents
 * trailing digits, which is the one thing this site must not do with a number
 * it claims came off the chain.
 */
export function ethFromWei(wei, decimals = 6) {
  const value = BigInt(wei ?? 0);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const units = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${units}${frac ? `.${frac}` : ''} ETH`;
}

/** Exact cumulative quote flow into the curve; buys add, sells subtract. */
export function curveFlowSeries(activity) {
  if (!Array.isArray(activity?.events)) return [];
  let net = 0n;
  return activity.events
    .slice()
    .sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex))
    .map((event) => {
      const quote = BigInt(event.quoteWei ?? 0);
      net += event.kind === 'sell' ? -quote : quote;
      return { ...event, netQuoteWei: net.toString() };
    });
}

/** The observed-activity sentence, or null when nothing was observed. */
export function activityLine(activity) {
  if (activity?.state !== 'observed') return null;
  return `${plural(activity.curveBuys, 'buy', 'buys')} · ` +
    `${plural(activity.curveSells, 'sell', 'sells')} · ` +
    `observed through block ${whole(activity.observedThroughBlock)}`;
}

/**
 * Observed reserves as label/value rows, or null when nothing was observed.
 *
 * The observation time is part of the reading, not a footnote to it: a reserve
 * figure without a timestamp is a claim about now, and this feed read it once,
 * at a moment that has already passed.
 */
export function reserveRows(token) {
  if (token?.reserves?.state !== 'observed') return null;
  return [
    ['Real quote reserve', ethFromWei(token.reserves.realQuoteReserveWei)],
    ['Graduation threshold', ethFromWei(token.graduationThreshold, 2)],
    ['Curve status', token.reserves.graduated ? 'Graduated' : 'On the curve'],
    ['Observed at', eventTime(token.reserves.observedAt)],
  ];
}
