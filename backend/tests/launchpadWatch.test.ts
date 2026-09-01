import { startLaunchpadWatch } from '../src/launchpadWatch';

/**
 * pons switched launching off on 2026-08-12 at 19:42 UTC, on both factories, and
 * nothing on our side noticed for three days. Every test here is a property that
 * absence depended on.
 */

function harness(readiness: Array<{ launchEnabled: boolean; whitelisted: boolean } | Error>) {
  const sent: Array<{ kind: string; severity: string }> = [];
  let i = 0;
  const w = startLaunchpadWatch(
    {
      getLaunchReadiness: async () => {
        const r = readiness[Math.min(i++, readiness.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      },
    },
    { send: async (a: any) => { sent.push({ kind: a.kind, severity: a.severity }); } } as any,
    999
  );
  return { w, sent };
}

const OPEN = { launchEnabled: true, whitelisted: false };
const CLOSED = { launchEnabled: false, whitelisted: false };

describe('startLaunchpadWatch', () => {
  afterEach(() => jest.restoreAllMocks());

  it('says nothing while launching is enabled', async () => {
    const { w, sent } = harness([OPEN, OPEN]);
    await w.check();
    await w.check();
    w.stop();
    expect(sent).toEqual([]);
  });

  it('raises a critical alert when pons closes the launchpad', async () => {
    const { w, sent } = harness([CLOSED]);
    await w.check();
    w.stop();
    expect(sent).toEqual([{ kind: 'LAUNCHPAD_CLOSED', severity: 'critical' }]);
  });

  // A closure lasts days. Repeating every interval is how a channel gets muted,
  // including on the morning something else breaks.
  it('alerts once, not on every cycle', async () => {
    const { w, sent } = harness([CLOSED]);
    await w.check();
    await w.check();
    await w.check();
    w.stop();
    expect(sent).toHaveLength(1);
  });

  it('reports the reopening, and can alert again if it closes twice', async () => {
    const { w, sent } = harness([CLOSED, OPEN, CLOSED]);
    await w.check();
    await w.check();
    await w.check();
    w.stop();
    expect(sent.map((s) => s.kind)).toEqual([
      'LAUNCHPAD_CLOSED',
      'LAUNCHPAD_REOPENED',
      'LAUNCHPAD_CLOSED',
    ]);
  });

  // Whitelisting exists precisely for this: it applies only while launching is
  // globally off, so a whitelisted treasury is not in an outage.
  it('does not call a disabled launchpad an outage when this treasury is whitelisted', async () => {
    const { w, sent } = harness([{ launchEnabled: false, whitelisted: true }]);
    await w.check();
    w.stop();
    expect(sent).toEqual([]);
  });

  // An unreadable factory is an RPC problem. Guessing "closed" pages someone for
  // somebody else's network; guessing "open" hides a real closure.
  it('holds its previous belief when the factory cannot be read', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { w, sent } = harness([CLOSED, new Error('ECONNREFUSED'), CLOSED]);
    await w.check();
    await w.check();
    await w.check();
    w.stop();
    expect(sent).toHaveLength(1); // no spurious reopen, no duplicate closure
  });

  it('never throws out of a cycle', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { w } = harness([new Error('boom')]);
    await expect(w.check()).resolves.toBeUndefined();
    w.stop();
  });
});

/**
 * Two factories are watched, because the whitelist actually being waited on is a v2
 * grant while the bot still runs v1. A watch that only read v1 would miss the exact
 * event it was put there to catch.
 */
describe('watching more than one factory', () => {
  function harnessLabelled(readiness: { launchEnabled: boolean; whitelisted: boolean }, label: string) {
    const sent: Array<{ kind: string; message: string }> = [];
    const w = startLaunchpadWatch(
      { getLaunchReadiness: async () => readiness },
      { send: async (a: any) => { sent.push({ kind: a.kind, message: a.message }); } } as any,
      999,
      label
    );
    return { w, sent };
  }

  it('names the factory in the alert, so nobody checks the wrong contract', async () => {
    const a = harnessLabelled({ launchEnabled: false, whitelisted: false }, 'the v1 factory');
    const b = harnessLabelled({ launchEnabled: false, whitelisted: false }, 'the v2 factory');
    await a.w.check();
    await b.w.check();
    a.w.stop(); b.w.stop();
    expect(a.sent[0].message).toContain('the v1 factory');
    expect(b.sent[0].message).toContain('the v2 factory');
  });

  // The grant we asked for arrives while launching stays globally off, so it must be
  // recognisable as the thing that was requested rather than a generic recovery.
  it('recognises a whitelist grant as the answer to the request', async () => {
    let state = { launchEnabled: false, whitelisted: false };
    const sent: Array<{ kind: string; message: string }> = [];
    const w = startLaunchpadWatch(
      { getLaunchReadiness: async () => state },
      { send: async (a: any) => { sent.push({ kind: a.kind, message: a.message }); } } as any,
      999,
      'the v2 factory'
    );
    await w.check();
    state = { launchEnabled: false, whitelisted: true };
    await w.check();
    w.stop();
    expect(sent.map((s) => s.kind)).toEqual(['LAUNCHPAD_CLOSED', 'LAUNCHPAD_REOPENED']);
    expect(sent[1].message).toContain('whitelisted on the v2 factory');
    expect(sent[1].message).toContain('grant that was asked for');
  });
});

/**
 * A CRITICAL ALARM THAT IS FALSE IS WORSE THAN NO ALARM.
 *
 * Both factories are watched, and this alert was written for the one the bot
 * launches through. So the v1 watch sent CRITICAL saying "the bot cannot launch
 * anything until this changes" while the bot was launching perfectly well
 * through v2 -- pons-v1 is `executable: false` and Ponsr left it on 2026-08-26.
 *
 * Three of those reached the owner's phone in four hours on 2026-09-01. That is
 * how somebody learns to ignore the channel, and then misses the real one.
 */
describe('a factory the bot does not launch through', () => {
  const closed = { getLaunchReadiness: async () => ({ launchEnabled: false, whitelisted: false }) };

  it('is a warning that says nothing is broken, not a critical outage', async () => {
    const sent: any[] = [];
    const watch = startLaunchpadWatch(closed, { send: async (a: any) => { sent.push(a); } }, 15, 'the v1 factory', {
      launchesThrough: false,
    });
    await watch.check();
    watch.stop();

    expect(sent).toHaveLength(1);
    expect(sent[0].severity).toBe('warning');
    expect(sent[0].message).toMatch(/does NOT launch through/);
    expect(sent[0].message).toMatch(/Nothing is broken/);
    // The sentence that was false.
    expect(sent[0].message).not.toMatch(/cannot launch anything/);
  });

  it('still says critical for the factory the bot does launch through', async () => {
    const sent: any[] = [];
    const watch = startLaunchpadWatch(closed, { send: async (a: any) => { sent.push(a); } }, 15, 'the current factory', {
      launchesThrough: true,
    });
    await watch.check();
    watch.stop();

    expect(sent[0].severity).toBe('critical');
    expect(sent[0].message).toMatch(/cannot launch anything/);
  });
});

/**
 * THE EDGE MUST OUTLIVE THE PROCESS, OR IT IS NOT AN EDGE.
 *
 * This file's own rule is to alert once on the way down and once on the way
 * back, "because a repeat every interval for a condition that lasts days
 * teaches everyone to mute the channel". The flag lived in memory, so every
 * restart forgot it and announced a standing condition again -- one identical
 * CRITICAL per deploy.
 *
 * A rule that only holds until the next deploy is not a rule.
 */
describe('the closed state survives a restart', () => {
  const closed = { getLaunchReadiness: async () => ({ launchEnabled: false, whitelisted: false }) };

  const makeStore = () => {
    const values = new Map<string, string>();
    return { get: (k: string) => values.get(k) ?? null, set: (k: string, v: string) => { values.set(k, v); }, values };
  };

  it('announces once across two process lifetimes', async () => {
    const store = makeStore();
    const sent: any[] = [];
    const notifier = { send: async (a: any) => { sent.push(a); } };

    const first = startLaunchpadWatch(closed, notifier, 15, 'the v1 factory', { launchesThrough: false, store });
    await first.check();
    first.stop();
    expect(sent).toHaveLength(1);

    // A deploy: brand new process, same database.
    const second = startLaunchpadWatch(closed, notifier, 15, 'the v1 factory', { launchesThrough: false, store });
    await second.check();
    second.stop();
    expect(sent).toHaveLength(1);
  });

  it('keys on the label, so one factory closing cannot silence the other', async () => {
    const store = makeStore();
    const sent: any[] = [];
    const notifier = { send: async (a: any) => { sent.push(a); } };

    const v1 = startLaunchpadWatch(closed, notifier, 15, 'the v1 factory', { launchesThrough: false, store });
    await v1.check();
    v1.stop();

    const current = startLaunchpadWatch(closed, notifier, 15, 'the current factory', { launchesThrough: true, store });
    await current.check();
    current.stop();

    expect(sent).toHaveLength(2);
    expect(sent.map((a) => a.severity).sort()).toEqual(['critical', 'warning']);
  });

  it('still announces the recovery, and then stays quiet about it', async () => {
    const store = makeStore();
    const sent: any[] = [];
    const notifier = { send: async (a: any) => { sent.push(a); } };
    let open = false;
    const deps = { getLaunchReadiness: async () => ({ launchEnabled: open, whitelisted: false }) };

    const watch = startLaunchpadWatch(deps, notifier, 15, 'the v1 factory', { launchesThrough: false, store });
    await watch.check();
    open = true;
    await watch.check();
    await watch.check();
    watch.stop();

    expect(sent.map((a) => a.kind)).toEqual(['LAUNCHPAD_CLOSED', 'LAUNCHPAD_REOPENED']);

    // And a restart after the recovery says nothing at all.
    const after = startLaunchpadWatch(deps, notifier, 15, 'the v1 factory', { launchesThrough: false, store });
    await after.check();
    after.stop();
    expect(sent).toHaveLength(2);
  });
});
