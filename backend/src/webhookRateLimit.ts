/**
 * A ceiling on how fast the webhook can be fed.
 *
 * The endpoint already requires a shared secret, so this is not the front door — it
 * is what stops a leaked secret being expensive. The interesting cost is not the
 * treasury, which the daily spend cap already bounds: it is the **parser**. Every
 * accepted mention is a paid API call, the balance is a fixed prepaid amount, and
 * exhausting it makes the bot unable to read anything from anyone until someone
 * notices and tops it up. That is a denial of service costing an attacker nothing
 * and needing no launch to succeed.
 *
 * Deliberately a fixed window rather than a token bucket or a sliding log. The
 * failure this guards against is a flood, and a flood is caught by any of them; the
 * difference between them only shows up in fairness at the boundary, which does not
 * matter when there is exactly one legitimate caller. Simple enough to be obviously
 * correct beats clever here.
 *
 * In memory on purpose, and the consequence is stated rather than hidden: a restart
 * clears the counter. A determined attacker who can also cause restarts gets a fresh
 * allowance each time. Persisting it would mean a database write per request on the
 * hot path to defend against an attacker who, at that point, has a much better attack
 * available.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Requests already counted in the current window, including this one. */
  count: number;
  /** Seconds until the window resets. Sent as Retry-After. */
  resetInSeconds: number;
}

export class FixedWindowRateLimit {
  private windowStart = 0;
  private count = 0;

  /**
   * @param max Requests permitted per window.
   * @param windowMs Window length.
   * @param now Injected so tests do not sleep.
   */
  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now
  ) {}

  check(): RateLimitResult {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.count = 0;
    }
    this.count++;
    const resetInSeconds = Math.max(0, Math.ceil((this.windowStart + this.windowMs - t) / 1000));
    return { allowed: this.count <= this.max, count: this.count, resetInSeconds };
  }
}
