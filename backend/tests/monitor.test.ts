import * as fs from 'fs';
import { Db } from '../src/db';
import { MockNotifier, TelegramNotifier, Notifier, TreasuryMonitor, DEFAULT_THRESHOLDS, MonitorThresholds } from '../src/monitor';
import { TreasuryPolicy } from '../src/treasuryPolicy';
import { LaunchRecord } from '../src/types';

const TEST_DB_PATH = './data/test-monitor.sqlite';

function freshDb(): Db {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  return new Db(TEST_DB_PATH);
}

/** Inserts a launch at a chosen timestamp so rate windows can be exercised
 *  without waiting real time. Mirrors the real flow: claim, then insert. */
function seedLaunch(db: Db, id: string, createdAt: Date) {
  db.claimTweetForProcessing(id);
  const record: LaunchRecord = {
    id: 'launch_' + id,
    sourceTweetId: id,
    xUserId: 'user_' + id,
    tokenName: 'T',
    tokenSymbol: 'T',
    splitterAddress: null,
    tokenAddress: null,
    txHash: null,
    status: 'confirmed',
    rejectionReason: null,
    feeWeiPaid: null,
    createdAt: createdAt.toISOString(),
  };
  db.insertLaunch(record);
}

const FAST: MonitorThresholds = { ...DEFAULT_THRESHOLDS, spikeMinLaunches: 3, sybilDistinctUsers: 3 };

describe('TreasuryMonitor -- volume spike detection (Part 5 mitigation #5)', () => {
  let db: Db;
  let notifier: MockNotifier;

  beforeEach(() => {
    db = freshDb();
    notifier = new MockNotifier();
  });
  afterEach(() => db.close());

  it('stays quiet on a normal launch rate', async () => {
    const now = new Date('2026-08-01T12:00:00Z');
    // a steady week of traffic, then one launch in the recent window
    for (let i = 0; i < 200; i++) {
      seedLaunch(db, 'old' + i, new Date(now.getTime() - (i + 2) * 60 * 60 * 1000));
    }
    seedLaunch(db, 'recent1', new Date(now.getTime() - 60 * 1000));

    const monitor = new TreasuryMonitor(db, notifier, FAST);
    await monitor.onLaunchRecorded(now);

    expect(notifier.sent).toHaveLength(0);
  });

  it('CRITICAL: raises a spike alert when the recent rate is a large multiple of baseline', async () => {
    const now = new Date('2026-08-01T12:00:00Z');
    // sparse baseline: 20 launches spread over the past week
    for (let i = 0; i < 20; i++) {
      seedLaunch(db, 'old' + i, new Date(now.getTime() - (i + 2) * 6 * 60 * 60 * 1000));
    }
    // then a burst inside the recent window -- the Sybil drain shape from Part 5
    for (let i = 0; i < 25; i++) {
      seedLaunch(db, 'burst' + i, new Date(now.getTime() - i * 20 * 1000));
    }

    const monitor = new TreasuryMonitor(db, notifier, FAST);
    await monitor.onLaunchRecorded(now);

    expect(notifier.kinds()).toContain('VOLUME_SPIKE');
    expect(notifier.sent[0].severity).toBe('critical');
    expect(notifier.sent[0].detail!.recent).toBe(25);
  });

  it('does not divide by zero when there is no baseline history at all', async () => {
    const now = new Date('2026-08-01T12:00:00Z');
    for (let i = 0; i < 8; i++) {
      seedLaunch(db, 'first' + i, new Date(now.getTime() - i * 30 * 1000));
    }
    const monitor = new TreasuryMonitor(db, notifier, FAST);
    await expect(monitor.onLaunchRecorded(now)).resolves.not.toThrow();
    expect(notifier.kinds()).toContain('VOLUME_SPIKE'); // 8 >= spikeMinLaunches * 2
  });

  it('deduplicates repeat spike alerts inside the cooldown, so one incident is not a hundred pages', async () => {
    const now = new Date('2026-08-01T12:00:00Z');
    for (let i = 0; i < 25; i++) {
      seedLaunch(db, 'burst' + i, new Date(now.getTime() - i * 20 * 1000));
    }
    const monitor = new TreasuryMonitor(db, notifier, FAST, 30);

    await monitor.onLaunchRecorded(now);
    await monitor.onLaunchRecorded(new Date(now.getTime() + 60 * 1000));
    await monitor.onLaunchRecorded(new Date(now.getTime() + 120 * 1000));

    expect(notifier.sent.filter((a) => a.kind === 'VOLUME_SPIKE')).toHaveLength(1);

    // A spike that has already passed must not re-alert either: half an hour on,
    // with no new launches, the recent window is empty and there is nothing to say.
    const later = new Date(now.getTime() + 31 * 60 * 1000);
    await monitor.onLaunchRecorded(later);
    expect(notifier.sent.filter((a) => a.kind === 'VOLUME_SPIKE')).toHaveLength(1);

    // ...but a genuinely NEW burst after the cooldown does alert again.
    for (let i = 0; i < 25; i++) {
      seedLaunch(db, 'burst2_' + i, new Date(later.getTime() - i * 20 * 1000));
    }
    await monitor.onLaunchRecorded(later);
    expect(notifier.sent.filter((a) => a.kind === 'VOLUME_SPIKE')).toHaveLength(2);
  });
});

describe('TreasuryMonitor -- guard-fired alerts', () => {
  let db: Db;
  let notifier: MockNotifier;

  beforeEach(() => {
    db = freshDb();
    notifier = new MockNotifier();
  });
  afterEach(() => db.close());

  it('CRITICAL: reports when the daily spend circuit breaker trips', async () => {
    const monitor = new TreasuryMonitor(db, notifier, FAST);
    await monitor.onRejected('t1', 'u1', 'DAILY_SPEND_CAP_REACHED');

    expect(notifier.kinds()).toEqual(['CIRCUIT_BREAKER_TRIPPED']);
    expect(notifier.sent[0].severity).toBe('critical');
  });

  it('reports a fee-ceiling rejection as a warning -- Pons may have raised its fee', async () => {
    const monitor = new TreasuryMonitor(db, notifier, FAST);
    await monitor.onRejected('t1', 'u1', 'FEE_EXCEEDS_CEILING');

    expect(notifier.kinds()).toEqual(['FEE_CEILING_EXCEEDED']);
    expect(notifier.sent[0].severity).toBe('warning');
  });

  it('CRITICAL: reports a Sybil attempt when many DISTINCT accounts are turned away', async () => {
    const monitor = new TreasuryMonitor(db, notifier, FAST);
    for (let i = 0; i < 4; i++) {
      await monitor.onRejected('t' + i, 'attacker' + i, 'ACCOUNT_TOO_NEW');
    }
    expect(notifier.kinds()).toContain('SYBIL_ATTEMPT');
    expect(notifier.sent[0].detail!.distinctAccounts).toBeGreaterThanOrEqual(3);
  });

  it('does NOT report one account retrying repeatedly -- that is a confused user, not an attack', async () => {
    const monitor = new TreasuryMonitor(db, notifier, FAST);
    for (let i = 0; i < 10; i++) {
      await monitor.onRejected('t' + i, 'same_user', 'ACCOUNT_TOO_NEW');
    }
    expect(notifier.kinds()).not.toContain('SYBIL_ATTEMPT');
  });

  it('ignores ordinary rejections -- a mistyped tweet is not a security event', async () => {
    const monitor = new TreasuryMonitor(db, notifier, FAST);
    await monitor.onRejected('t1', 'u1', 'MISSING_REQUIRED_FIELD');
    await monitor.onRejected('t2', 'u2', 'NOT_LAUNCH_INTENT');
    await monitor.onRejected('t3', 'u3', 'LOW_CONFIDENCE');
    expect(notifier.sent).toHaveLength(0);
  });

  it('records every rejection regardless, so the guards leave an audit trail', async () => {
    const monitor = new TreasuryMonitor(db, notifier, FAST);
    await monitor.onRejected('t1', 'u1', 'NOT_LAUNCH_INTENT');
    await monitor.onRejected('t2', 'u2', 'ACCOUNT_TOO_NEW');
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(db.countDistinctRejectedUsersSince('ACCOUNT_TOO_NEW', since)).toBe(1);
    expect(db.countDistinctRejectedUsersSince('NOT_LAUNCH_INTENT', since)).toBe(1);
  });
});

describe('TreasuryMonitor -- hot/cold treasury split (Part 5 mitigation #7)', () => {
  let db: Db;
  let notifier: MockNotifier;
  const FEE = 500_000_000_000_000n; // 0.0005 ETH
  const RESERVE = 2_000_000_000_000_000n; // 0.002 ETH
  const DAILY_CAP = 50_000_000_000_000_000n; // 0.05 ETH
  const HOT = '0x1111111111111111111111111111111111111111';
  const COLD = '0x2222222222222222222222222222222222222222';

  const POLICY: TreasuryPolicy = {
    dailyCapWei: DAILY_CAP,
    maxDailyCaps: 2,
    floorLaunches: 20,
    targetLaunches: 60,
    criticalLaunches: 3,
    gasReserveWei: RESERVE,
  };

  const forLaunches = (n: number) => FEE * BigInt(n) + RESERVE;
  const makeMonitor = () =>
    new TreasuryMonitor(db, notifier, FAST, 30, { policy: POLICY, hotAddress: HOT, coldAddress: COLD });

  beforeEach(() => {
    db = freshDb();
    notifier = new MockNotifier();
  });
  afterEach(() => db.close());

  it('stays quiet on a first healthy reading -- a normal balance is not news', async () => {
    await makeMonitor().checkTreasuryBalance(forLaunches(50), FEE);
    expect(notifier.sent).toHaveLength(0);
  });

  it('asks for a top-up below the floor, with the amount and both addresses in the message', async () => {
    await makeMonitor().checkTreasuryBalance(forLaunches(10), FEE);
    expect(notifier.kinds()).toEqual(['TOP_UP_REQUIRED']);
    expect(notifier.sent[0].severity).toBe('warning');
    // An alert that only says "low" makes the operator go and work out the rest.
    expect(notifier.sent[0].message).toContain(HOT);
    expect(notifier.sent[0].message).toContain(COLD);
  });

  it('escalates to critical when only a couple of launches are left', async () => {
    await makeMonitor().checkTreasuryBalance(forLaunches(2), FEE);
    expect(notifier.kinds()).toEqual(['TOP_UP_REQUIRED']);
    expect(notifier.sent[0].severity).toBe('critical');
  });

  it('reports an empty wallet as launches actively being refused', async () => {
    await makeMonitor().checkTreasuryBalance(RESERVE, FEE);
    expect(notifier.kinds()).toEqual(['TREASURY_LOW']);
    expect(notifier.sent[0].severity).toBe('critical');
    expect(notifier.sent[0].message.toLowerCase()).toContain('refused');
  });

  it('CRITICAL: reports an over-funded hot wallet -- unspendable balance is pure exposure', async () => {
    // Above two days of the circuit breaker's cap, the bot cannot spend the
    // excess no matter what happens. An attacker can still take all of it.
    await makeMonitor().checkTreasuryBalance(DAILY_CAP * 3n, FEE);
    expect(notifier.kinds()).toEqual(['TREASURY_OVERFUNDED']);
    // Deliberately NOT the cold address. The Turnkey policy permits the pons factory
    // and contract creation and refuses every other destination, so the balance cannot
    // be moved there -- naming it would send the operator after an impossible action.
    expect(notifier.sent[0].message).toMatch(/cannot be swept/i);
  });

  it('alerts on state changes, not on every reading', async () => {
    const monitor = makeMonitor();
    await monitor.checkTreasuryBalance(forLaunches(10), FEE);
    await monitor.checkTreasuryBalance(forLaunches(9), FEE);
    await monitor.checkTreasuryBalance(forLaunches(8), FEE);
    // The watch runs every 15 minutes. Three pages for one unchanged problem is
    // how an alert channel gets muted.
    expect(notifier.sent).toHaveLength(1);
  });

  it('escalates when the state worsens, and confirms when it recovers', async () => {
    const monitor = makeMonitor();
    await monitor.checkTreasuryBalance(forLaunches(10), FEE); // LOW
    await monitor.checkTreasuryBalance(forLaunches(2), FEE); // CRITICAL
    await monitor.checkTreasuryBalance(forLaunches(60), FEE); // HEALTHY again

    expect(notifier.kinds()).toEqual(['TOP_UP_REQUIRED', 'TOP_UP_REQUIRED', 'TREASURY_RECOVERED']);
    expect(notifier.sent[0].severity).toBe('warning');
    expect(notifier.sent[1].severity).toBe('critical');
    // Confirming the top-up landed is the one thing the operator is waiting for.
    expect(notifier.sent[2].severity).toBe('info');
  });

  it('CRITICAL: dedupe survives a restart -- a redeploy loop must not re-page', async () => {
    await makeMonitor().checkTreasuryBalance(forLaunches(10), FEE);
    expect(notifier.sent).toHaveLength(1);

    // Fresh instance, same database: exactly what a process restart looks like.
    // In-memory dedupe alone would page again on every deploy.
    await makeMonitor().checkTreasuryBalance(forLaunches(10), FEE);
    expect(notifier.sent).toHaveLength(1);
  });

  it('CRITICAL: a failed alert send is retried on the next reading, not silently dropped', async () => {
    // The state is recorded only after the notifier accepts the alert. Recording
    // first would mean one timed-out Telegram call marks an empty treasury as
    // "already reported" and it is never mentioned again.
    let attempts = 0;
    const flaky: Notifier = {
      send: async (alert) => {
        attempts++;
        if (attempts === 1) throw new Error('notifier timed out');
        await notifier.send(alert);
      },
    };
    const monitor = new TreasuryMonitor(db, flaky, FAST, 30, { policy: POLICY, hotAddress: HOT, coldAddress: COLD });

    await expect(monitor.checkTreasuryBalance(forLaunches(10), FEE)).rejects.toThrow('timed out');
    expect(notifier.sent).toHaveLength(0);

    // Second reading, same state: because the first was never recorded, this one
    // still alerts rather than being deduplicated away.
    await monitor.checkTreasuryBalance(forLaunches(10), FEE);
    expect(notifier.kinds()).toEqual(['TOP_UP_REQUIRED']);
  });

  it('does not throw on a zero fee, and treats it as unfundable rather than free', async () => {
    const monitor = makeMonitor();
    const assessment = await monitor.checkTreasuryBalance(forLaunches(100), 0n);
    expect(assessment.state).toBe('EMPTY');
    expect(notifier.kinds()).toEqual(['TREASURY_LOW']);
  });
});

/**
 * THE FIRST LINE IS THE WHOLE NOTIFICATION.
 *
 * A phone preview shows one line. The alert used to open
 * `WARNING — LAUNCHPAD_CLOSED` -- a log level and a code constant -- and close
 * with `2026-09-01T13:32:25.964Z`. It read as a log line pasted into a chat,
 * and it never answered the only question that matters at three in the morning:
 * do I have to get up?
 */
describe('the Telegram message is written for a person', () => {
  const format = (alert: any) => (new TelegramNotifier('t', 'c') as any).format(alert);
  const at = '2026-09-01T13:32:25.964Z';

  it('answers "do I act?" in the first line, before anything else', () => {
    const critical = format({ kind: 'CIRCUIT_BREAKER_TRIPPED', severity: 'critical', message: 'm', at });
    const warning = format({ kind: 'LAUNCHPAD_CLOSED', severity: 'warning', message: 'm', at });
    const info = format({ kind: 'MENTION_SWEEP_RECOVERED', severity: 'info', message: 'm', at });

    expect(critical.split('\n')[0]).toMatch(/ACTION NEEDED/);
    expect(warning.split('\n')[0]).toMatch(/Worth knowing/);
    expect(info.split('\n')[0]).toMatch(/No action needed/);

    // And the headline is readable, not a constant.
    expect(critical.split('\n')[0]).toMatch(/Circuit breaker tripped/);
    expect(critical.split('\n')[0]).not.toMatch(/CIRCUIT_BREAKER_TRIPPED/);
  });

  it('derives the headline rather than mapping it, so a new kind is never unlabelled', () => {
    const out = format({ kind: 'SOME_FUTURE_ALERT', severity: 'warning', message: 'm', at });
    expect(out.split('\n')[0]).toMatch(/Some future alert/);
  });

  it('keeps the constant searchable, at the end', () => {
    const out = format({ kind: 'LAUNCHPAD_CLOSED', severity: 'warning', message: 'm', at });
    const last = out.trim().split('\n').pop();
    expect(last).toMatch(/^LAUNCHPAD_CLOSED/);
    expect(last).toMatch(/13:32 UTC/);
    // The machine timestamp is gone: Telegram stamps every message itself and a
    // second clock with milliseconds is not something a person reads.
    expect(out).not.toContain('2026-09-01T13:32:25.964Z');
  });

  it('renders detail as lines a person can read, not a JSON blob', () => {
    const out = format({
      kind: 'CIRCUIT_BREAKER_TRIPPED',
      severity: 'critical',
      message: 'm',
      detail: { spentWei: '10000000000000000', launchesToday: 19 },
      at,
    });
    expect(out).toMatch(/^spentWei: 10000000000000000$/m);
    expect(out).toMatch(/^launchesToday: 19$/m);
    expect(out).not.toMatch(/[{}]/);
  });

  it('stays inside Telegram\'s limit however long the detail is', () => {
    const out = format({
      kind: 'LAUNCH_FAILED',
      severity: 'critical',
      message: 'm',
      detail: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`key${i}`, 'x'.repeat(400)])),
      at,
    });
    // A detail blob that pushed past 4096 would take the whole alert down.
    expect(out.length).toBeLessThan(4096);
  });

  it('carries no parse_mode syntax that a token symbol could break', () => {
    // `_MOON_` in Markdown mode makes the API refuse the message. Plain text
    // always sends, so the format must not start relying on markup.
    const out = format({ kind: 'LAUNCH_FAILED', severity: 'critical', message: 'Symbol _MOON_ failed', at });
    expect(out).toContain('_MOON_');
    expect(out).not.toMatch(/<\/?b>|\*\*/);
  });
});
