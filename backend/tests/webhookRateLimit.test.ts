import { FixedWindowRateLimit } from '../src/webhookRateLimit';

/**
 * The webhook already requires a secret, so this is not the front door. It is what a
 * leaked secret costs: every accepted mention is a paid parser call against a fixed
 * prepaid balance, and exhausting that makes the bot deaf to everyone. A denial of
 * service needing no launch to succeed.
 */
describe('FixedWindowRateLimit', () => {
  let now = 0;
  const make = (max: number, windowMs = 60_000) => new FixedWindowRateLimit(max, windowMs, () => now);

  beforeEach(() => { now = 0; });

  it('allows up to the limit and refuses past it', () => {
    const rl = make(3);
    expect([rl.check().allowed, rl.check().allowed, rl.check().allowed]).toEqual([true, true, true]);
    expect(rl.check().allowed).toBe(false);
  });

  it('lets traffic through again once the window rolls', () => {
    const rl = make(2);
    rl.check(); rl.check();
    expect(rl.check().allowed).toBe(false);
    now += 60_000;
    expect(rl.check().allowed).toBe(true);
  });

  // Retry-After has to shrink as the window drains, or a caller told to wait 60s at
  // second 59 waits a minute longer than it needs to.
  it('reports how long is actually left, not the whole window', () => {
    const rl = make(1);
    rl.check();
    const early = rl.check().resetInSeconds;
    now += 30_000;
    const later = rl.check().resetInSeconds;
    expect(early).toBeGreaterThan(later);
    expect(later).toBeLessThanOrEqual(30);
  });

  it('counts every request, including the refused ones', () => {
    const rl = make(1);
    rl.check();
    expect(rl.check().count).toBe(2);
    expect(rl.check().count).toBe(3);
  });

  // A window that only resets on an allowed request would never reopen under sustained
  // load: the refusals would keep pushing the boundary out.
  it('reopens even while being hammered', () => {
    const rl = make(1);
    for (let i = 0; i < 50; i++) { now += 1000; rl.check(); }
    now += 60_000;
    expect(rl.check().allowed).toBe(true);
  });
});
