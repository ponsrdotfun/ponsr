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
