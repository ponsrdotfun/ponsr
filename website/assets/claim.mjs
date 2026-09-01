/**
 * WHO MAY BE OFFERED A COLLECT BUTTON, AND FOR WHICH BALANCE.
 *
 * This is a pure function on purpose. The rule it encodes -- offer the control
 * only where the splitter's own `creator()` is the signed-in wallet, and only
 * where something has actually accrued -- is the kind that is easy to get right
 * once and then quietly break while rearranging a painter. Held here, it can be
 * tested with real values rather than asserted against the shape of some markup.
 *
 * It is a COURTESY, not a permission. The server re-derives ownership from the
 * session and re-reads `creator()` from chain before it spends any gas, and it
 * would refuse a forged click regardless of what this returned. What this
 * prevents is a button that can only fail: offering a reader a control over
 * somebody else's fees is a worse answer than not offering one.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const sameAddress = (a, b) =>
  ADDRESS.test(String(a ?? '')) &&
  ADDRESS.test(String(b ?? '')) &&
  String(a).toLowerCase() === String(b).toLowerCase();

/**
 * @param {{creator?: string|null}} launch  a launch from the public escrow record
 * @param {{state?: string, accruedWei?: string}} asset  one escrow cell of that launch
 * @param {{state?: string, wallet?: {address?: string}}} session  the signed-in reader
 */
export function claimableBy(launch, asset, session) {
  if (session?.state !== 'authenticated') return false;
  if (!sameAddress(launch?.creator, session?.wallet?.address)) return false;

  // An unread balance is not a zero balance, and it is not a claimable one
  // either: a button offered over a figure nobody could read would spend gas to
  // discover what a free read failed to answer.
  if (asset?.state !== 'observed') return false;

  try {
    return BigInt(asset.accruedWei ?? '0') > 0n;
  } catch {
    return false;
  }
}

/**
 * THE THREE SUMMARY FIGURES, AS ARITHMETIC OVER CELLS THAT WERE ACTUALLY READ.
 *
 * Pure, and separate from the painting, for the same reason `claimableBy` is:
 * these are money figures, and the rules that decide them deserve tests with
 * real values rather than an assertion about some markup.
 *
 * Two rules do the work.
 *
 * An unreadable cell is EXCLUDED and counted, never treated as zero. A total
 * that quietly swallows a balance nobody could read understates what is owed,
 * and on a money figure that is the expensive direction to be wrong in.
 *
 * And amounts are summed only when they are the SAME asset. NVDA and SPCX are
 * both 18 decimals, so adding them yields a number that formats perfectly and
 * means nothing -- the same shape as the bug that printed a Microduck sell in
 * ETH. With more than one unit in play there is no common currency to report.
 */
export function feeTotals(launches, session) {
  const rows = Array.isArray(launches) ? launches : [];
  const mine =
    session?.state === 'authenticated' && ADDRESS.test(String(session.wallet?.address ?? ''))
      ? String(session.wallet.address).toLowerCase()
      : null;
  const scoped = mine ? rows.filter((l) => String(l?.creator ?? '').toLowerCase() === mine) : rows;

  let accrued = 0n;
  let unreadable = 0;
  const units = new Set();
  for (const launch of scoped) {
    for (const asset of launch?.assets ?? []) {
      if (asset?.state !== 'observed') { unreadable += 1; continue; }
      let wei;
      try { wei = BigInt(asset.accruedWei ?? '0'); } catch { unreadable += 1; continue; }
      // Only a NON-ZERO balance names a unit. A zero cell adds nothing, so
      // letting it claim the unit would make two empty assets look like a
      // conflict and hide a figure that is perfectly well defined.
      if (wei > 0n) units.add(String(asset.label ?? ''));
      accrued += wei;
    }
  }

  const creator = (accrued * 9500n) / 10000n;
  return {
    scope: mine ? 'mine' : 'public',
    launches: scoped.length,
    accrued,
    creator,
    treasury: accrued - creator,
    unreadable,
    // Empty means nothing has accrued anywhere, which is a number without a
    // unit rather than a conflict between units.
    unit: units.size === 1 ? [...units][0] : null,
    mixed: units.size > 1,
  };
}
