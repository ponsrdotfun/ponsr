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
