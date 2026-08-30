import { ethers } from 'ethers';
import * as fs from 'fs';
import { Db } from '../src/db';
import { config } from '../src/config';
import { executableDeployment } from '../src/deployments';
import { EMPTY_SOCIALS } from '../src/ponsEncoder';
import {
  PONS_V2_CURRENT_ABI,
  buildCurrentV2LaunchCalldata,
  extractCurrentV2LaunchDetails,
  launchSalt,
} from '../src/ponsV2CurrentEncoder';
import { MockParser } from '../src/parser';
import { MockWalletResolver } from '../src/walletResolver';
import { MockXClient } from '../src/xClient';
import { TreasurySigner } from '../src/treasurySigner';
import { handleMention, OrchestratorDeps } from '../src/orchestrator';
import { reconcileOnce, startReconciliation, DEFAULT_RECONCILER_OPTIONS } from '../src/reconciler';
import { MockNotifier } from '../src/monitor';
import { InboundMention, ParsedIntent } from '../src/types';
import { PONS_FACTORY_ABI } from '../src/ponsEncoder';

/** The nonce the splitter is predicted and deployed at, so the fakes stay consistent. */
const SPLITTER_NONCE = 0;
const ECONOMICS = '0x' + 'ab'.repeat(32);

const TEST_DB_PATH = './data/test-reconciler.sqlite';
const LIVE_FEE = 500_000_000_000_000n;

function fakeAddress(seed: string): string {
  return ethers.getAddress('0x' + ethers.keccak256(ethers.toUtf8Bytes(seed)).slice(-40));
}

class FakeTreasurySigner implements TreasurySigner {
  public sentTransactions: { to: string; data: string; value: bigint }[] = [];
  private nonce = 0;
  async address(): Promise<string> {
    return fakeAddress('fake-treasury');
  }
  async sendTransaction(tx: { to: string; data: string; value: bigint }) {
    this.sentTransactions.push(tx);
    this.nonce++;
    const hash = `0x${this.nonce.toString().padStart(64, '0')}`;
    if (tx.to === '') {
      // The address a plain CREATE actually produces, so the fake stays self-consistent
      // with the prediction the orchestrator makes before anything is signed.
      return {
        hash,
        wait: async () => ({
          status: 1,
          contractAddress: ethers.getCreateAddress({ from: fakeAddress('fake-treasury'), nonce: SPLITTER_NONCE }),
          logs: [],
        } as any),
      };
    }
    // The CURRENT factory's event, because that is the deployment the injected target
    // names and the shape its calldata is built in.
    const iface = new ethers.Interface(PONS_V2_CURRENT_ABI);
    const log = iface.encodeEventLog('TokenLaunched', [
      fakeAddress('token' + this.nonce),
      fakeAddress('curve' + this.nonce),
      fakeAddress('fake-treasury'),
      fakeAddress('pairToken'),
      0n,
      42n,
    ]);
    // `address` matters: the orchestrator scopes the receipt to the SELECTED factory
    // before reading it, so a log from nowhere is correctly read as no launch at all.
    return {
      hash,
      wait: async () => ({
        status: 1,
        logs: [{ address: executableDeployment().factory, topics: log.topics, data: log.data }],
      } as any),
    };
  }
}

function freshDb(): Db {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  return new Db(TEST_DB_PATH);
}

const GOOD_INTENT: ParsedIntent = {
  isLaunchIntent: true,
  confidence: 'high',
  tokenName: 'Moon Coin',
  tokenSymbol: 'MOON',
  description: null,
  pairWith: null,
};

function mention(id: string, createdAt: Date): InboundMention {
  return {
    tweetId: id,
    authorXUserId: 'user_' + id,
    authorHandle: 'user' + id,
    text: 'launch Moon Coin MOON',
    createdAt: createdAt.toISOString(),
  };
}

describe('reconciler -- recovering mentions the webhook never delivered (Part 7 §5)', () => {
  let db: Db;
  let xClient: MockXClient;
  let treasurySigner: FakeTreasurySigner;
  let deps: OrchestratorDeps;

  beforeEach(() => {
    db = freshDb();
    xClient = new MockXClient();
    treasurySigner = new FakeTreasurySigner();
    deps = {
      db,
      publicLaunchEnabled: true,
      parser: new MockParser(new Map([['launch Moon Coin MOON', GOOD_INTENT]])),
      walletResolver: new MockWalletResolver(db),
      xClient,
      treasurySigner,
      provider: {} as any,
      // Read-only seams: the splitter address is predicted from the treasury's nonce
      // before anything is signed, and the economics digest is observed independently.
      getTreasuryNonce: async () => SPLITTER_NONCE,
      readLaunchEconomics: async () => ECONOMICS,
      verifyIdentity: async () => {},
      // Required once the injected target reports `supportsPairing: true`, which the
      // executable deployment genuinely does. A stub claiming otherwise would keep these
      // tests on a code path production no longer has.
      assertPairApproved: async () => {},
      getLiveFeeWei: async () => LIVE_FEE,
      getTreasuryBalanceWei: async () => 50_000_000_000_000_000n, // funded; not what these test
      getLaunchReadiness: async () => ({ canLaunch: true, launchConfigUsable: true }),
      // INJECTED rather than inherited.
      //
      // These tests are about the sweep -- which mentions get retried, which get
      // skipped, what happens when one fails -- and none of that depends on which
      // factory a launch goes to. Left ambient, a version setting decided it: with v1
      // they passed, and with v2 the launch build reached for previewLaunchEconomics on
      // a stubbed provider and two of them failed. A suite whose result depends on an
      // environment variable does not mean the same thing on two machines. The setting
      // is gone; injecting the target is the fix that outlives it.
      launchTarget: {
        version: 'v2-current' as const,
        // The deployment this stub addresses, stated. It is required on the interface
        // precisely so a target cannot be built without saying which contract it means --
        // the identity check reads it rather than a global. Bound to the EXECUTABLE
        // deployment: a stub naming a superseded factory would keep v1 alive in the
        // active path through the back door.
        deployment: executableDeployment(),
        factoryAddress: executableDeployment().factory,
        supportsPairing: true,
        // CURRENT-V2 shaped, because the deployment above is the current one.
        //
        // It built v1-shaped bytes while naming v1, which was consistent. Naming the
        // executable deployment and still building v1 bytes is not: the orchestrator
        // MANDATORILY decodes the calldata with the selected deployment's ABI and stops
        // if it cannot -- correctly, since bytes an ABI cannot read are not what anyone
        // thinks they are. A stub that lies about its deployment gets caught by the guard
        // that exists to catch exactly that.
        build: async (req: any, feeWei: bigint) =>
          buildCurrentV2LaunchCalldata(
            {
              tokenName: req.tokenName,
              tokenSymbol: req.tokenSymbol,
              logo: '',
              description: req.description ?? '',
              socials: EMPTY_SOCIALS,
              feeWallet: req.splitterAddress,
              launchConfigId: 0n,
              pairToken: req.pairAsset.address,
              creatorTaxBps: 0,
              buybackEnabled: false,
              expectedEconomics: ECONOMICS,
              salt: launchSalt(executableDeployment(), req.tweetId),
            },
            feeWei,
            executableDeployment()
          ),
        extractToken: (logs: any) => extractCurrentV2LaunchDetails(logs)?.token ?? null,
      },
    };
  });
  afterEach(() => db.close());

  it('recovers a mention the webhook dropped, and it launches normally', async () => {
    const now = new Date('2026-08-01T12:00:00Z');
    xClient.recentMentions = [mention('dropped_1', new Date(now.getTime() - 5 * 60 * 1000))];

    const result = await reconcileOnce(deps, DEFAULT_RECONCILER_OPTIONS, now);

    expect(result.polled).toBe(1);
    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(db.isTweetProcessed('dropped_1')).toBe(true);
    // splitter deploy + launch: the recovered mention went through the real pipeline
    expect(treasurySigner.sentTransactions).toHaveLength(2);
  });

  it('counts paused mentions as suppressed, not recovered, without touching the launch path', async () => {
    const now = new Date('2026-08-01T12:00:00Z');
    const m = mention('paused_1', new Date(now.getTime() - 10_000));
    xClient.recentMentions = [m];
    deps.publicLaunchEnabled = false;
    deps.parser = { parse: async () => { throw new Error('parser must not be called while paused'); } };
    deps.walletResolver = { resolve: async () => { throw new Error('wallet must not be called while paused'); } } as any;
    deps.getLiveFeeWei = async () => { throw new Error('chain must not be called while paused'); };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await reconcileOnce(deps, DEFAULT_RECONCILER_OPTIONS, now);

    expect(result.suppressedPaused).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.watermarkAdvanced).toBe(true);
    expect(db.isTweetProcessed(m.tweetId)).toBe(true);
    expect(treasurySigner.sentTransactions).toHaveLength(0);
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/recovered/i);
  });

  it('CRITICAL: never double-spends on a mention the webhook already handled', async () => {
    const now = new Date('2026-08-01T12:00:00Z');
    const m = mention('already_1', new Date(now.getTime() - 5 * 60 * 1000));

    // webhook path handles it first
    await handleMention(m, deps);
    const afterWebhook = treasurySigner.sentTransactions.length;
    expect(afterWebhook).toBe(2);

    // then the poll sees the same mention again
    xClient.recentMentions = [m];
    const result = await reconcileOnce(deps, DEFAULT_RECONCILER_OPTIONS, now);

    expect(result.alreadyHandled).toBe(1);
    expect(result.recovered).toBe(0);
    // the decisive assertion: not one extra transaction, so not one extra fee
    expect(treasurySigner.sentTransactions).toHaveLength(afterWebhook);
    expect(db.totalSpendLast24h()).toBe(LIVE_FEE);
  });

  it('holds the watermark when the poll fails, so the unread window is retried', async () => {
    const now = new Date('2026-08-01T12:00:00Z');
    xClient.failNextPoll = new Error('X API unreachable');

    const result = await reconcileOnce(deps, DEFAULT_RECONCILER_OPTIONS, now);

    expect(result.error).toMatch(/unreachable/);
    expect(result.watermarkAdvanced).toBe(false);
    expect(db.getState('reconciler:watermark')).toBeNull();
  });

  it('advances the watermark on a successful sweep', async () => {
    const now = new Date('2026-08-01T12:00:00Z');
    const result = await reconcileOnce(deps, DEFAULT_RECONCILER_OPTIONS, now);
    expect(result.watermarkAdvanced).toBe(true);
    expect(db.getState('reconciler:watermark')).toBe(now.toISOString());
  });

  it('re-polls slightly before the watermark, so a mention on the boundary is not missed', async () => {
    const now = new Date('2026-08-01T12:00:00Z');
    db.setState('reconciler:watermark', now.toISOString());

    let askedSince = '';
    xClient.getRecentMentions = async (since: string) => {
      askedSince = since;
      return [];
    };
    await reconcileOnce(deps, DEFAULT_RECONCILER_OPTIONS, now);

    expect(new Date(askedSince).getTime()).toBeLessThan(now.getTime());
    const overlapMs = now.getTime() - new Date(askedSince).getTime();
    expect(overlapMs).toBe(DEFAULT_RECONCILER_OPTIONS.overlapSeconds * 1000);
  });

  it('clamps the lookback after a long outage instead of replaying days of mentions', async () => {
    const now = new Date('2026-08-01T12:00:00Z');
    // watermark from a week ago -- the process was down a long time
    db.setState('reconciler:watermark', new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString());

    let askedSince = '';
    xClient.getRecentMentions = async (since: string) => {
      askedSince = since;
      return [];
    };
    await reconcileOnce(deps, DEFAULT_RECONCILER_OPTIONS, now);

    const hoursBack = (now.getTime() - new Date(askedSince).getTime()) / 3600000;
    expect(hoursBack).toBeLessThanOrEqual(DEFAULT_RECONCILER_OPTIONS.maxLookbackHours + 0.1);
  });

  it('one failing mention does not abort the sweep', async () => {
    const now = new Date('2026-08-01T12:00:00Z');
    const bad = mention('bad_1', new Date(now.getTime() - 6 * 60 * 1000));
    bad.text = 'text the mock parser does not know'; // MockParser throws on this
    const good = mention('good_1', new Date(now.getTime() - 5 * 60 * 1000));

    xClient.recentMentions = [bad, good];
    const result = await reconcileOnce(deps, DEFAULT_RECONCILER_OPTIONS, now);

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(1);
    expect(db.isTweetProcessed('good_1')).toBe(true);
  });

  it('startReconciliation returns a handle that actually stops the timer', () => {
    const handle = startReconciliation(deps, 5);
    expect(typeof handle.stop).toBe('function');
    expect(() => handle.stop()).not.toThrow();
  });
});

describe('startReconciliation failure alerting', () => {
  // The sweep failing is invisible from outside: the process stays up, /health answers 200,
  // and mentions simply stop being seen. Running out of twitterapi.io credit produces exactly
  // this. Without an alert, the first symptom is somebody asking why the bot ignored them.
  //
  // A minimal deps is enough: reconcileOnce reads the watermark, then polls, and the poll is
  // what fails here.
  const failingDeps = (): any => ({
    db: { getState: () => undefined },
    xClient: {
      getRecentMentions: async () => {
        throw new Error('twitterapi.io 402: insufficient credit');
      },
    },
  });

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // Not on the first failure: a single failed poll is usually a blip, and an alert per blip
  // trains people to ignore alerts.
  it('alerts after three consecutive failures, not on the first', async () => {
    jest.useFakeTimers();
    const notifier = new MockNotifier();
    const handle = startReconciliation(failingDeps(), 1 / 60, DEFAULT_RECONCILER_OPTIONS, notifier);

    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    expect(notifier.kinds()).not.toContain('MENTION_SWEEP_FAILING');

    await jest.advanceTimersByTimeAsync(1000);
    expect(notifier.kinds()).toContain('MENTION_SWEEP_FAILING');

    handle.stop();
  });

  it('does not repeat the alert every tick while it stays broken', async () => {
    jest.useFakeTimers();
    const notifier = new MockNotifier();
    const handle = startReconciliation(failingDeps(), 1 / 60, DEFAULT_RECONCILER_OPTIONS, notifier);

    await jest.advanceTimersByTimeAsync(10000);
    expect(notifier.sent.filter((a) => a.kind === 'MENTION_SWEEP_FAILING')).toHaveLength(1);

    handle.stop();
  });

  /**
   * But it must speak again eventually, and this is why.
   *
   * Alerting exactly once per incident is correct for something that gets noticed. On
   * 2026-08-24 production had been failing every two minutes for days with `402 Credits is
   * not enough`, and the single alert had fired days earlier and scrolled out of the
   * operator's Telegram. One line, once, days ago, is indistinguishable from no line at all.
   */
  it('says it again after enough consecutive failures, so a deaf bot cannot stay quiet', async () => {
    jest.useFakeTimers();
    const notifier = new MockNotifier();
    const handle = startReconciliation(failingDeps(), 1 / 60, DEFAULT_RECONCILER_OPTIONS, notifier);

    // 3rd failure alerts; the next is due 60 failures later.
    await jest.advanceTimersByTimeAsync(62_000);
    expect(notifier.sent.filter((a) => a.kind === 'MENTION_SWEEP_FAILING')).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(2_000);
    const repeats = notifier.sent.filter((a) => a.kind === 'MENTION_SWEEP_FAILING');
    expect(repeats).toHaveLength(2);
    expect((repeats[1].detail as { repeated?: boolean })?.repeated).toBe(true);

    handle.stop();
  });

  /** The status page reads this. If it stayed empty, /status could not see the outage. */
  it('exposes live health rather than only logging it', async () => {
    jest.useFakeTimers();
    const handle = startReconciliation(failingDeps(), 1 / 60, DEFAULT_RECONCILER_OPTIONS);

    expect(handle.health().lastSuccessAt).toBeNull();
    await jest.advanceTimersByTimeAsync(3000);
    const h = handle.health();
    expect(h.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(h.lastError).toMatch(/402/);

    handle.stop();
  });

  // Recovery is the half operators actually wait for: it confirms the top-up or the key fix
  // took, without having to go and look.
  it('reports recovery once the sweep works again', async () => {
    jest.useFakeTimers();
    const notifier = new MockNotifier();
    let broken = true;
    const deps: any = {
      db: { getState: () => undefined, setState: () => undefined },
      xClient: {
        getRecentMentions: async () => {
          if (broken) throw new Error('twitterapi.io 402: insufficient credit');
          return [];
        },
      },
    };
    const handle = startReconciliation(deps, 1 / 60, DEFAULT_RECONCILER_OPTIONS, notifier);

    await jest.advanceTimersByTimeAsync(3000);
    expect(notifier.kinds()).toContain('MENTION_SWEEP_FAILING');

    broken = false;
    await jest.advanceTimersByTimeAsync(2000);
    expect(notifier.kinds()).toContain('MENTION_SWEEP_RECOVERED');

    handle.stop();
  });
});

/**
 * A SWEEP THAT HANGS MUST NOT LOOK LIKE A SWEEP THAT IS FINE.
 *
 * Every call the bot made to X was unbounded -- `fetch` waits indefinitely by
 * default -- and the sweep skips a tick while the previous one is still going.
 * One request that never returned therefore skipped every later tick and
 * recorded neither a success nor a failure, so `/status` read `degraded` ("no
 * successful poll yet since boot") rather than `down`, and the alert is driven
 * by consecutive failures, so nobody would ever be told.
 *
 * The bot stops hearing anybody, and every signal available says it is merely
 * warming up. These pin the deadline that closes that.
 */
describe('startReconciliation deadline', () => {
  const hangingDeps = (): any => ({
    db: { getState: () => undefined, setState: () => undefined },
    xClient: { getRecentMentions: () => new Promise(() => undefined) },
  });

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('records a hung sweep as a failure rather than as silence', async () => {
    jest.useFakeTimers();
    // A one-minute interval, so the deadline is 80% of it: 48s.
    const handle = startReconciliation(hangingDeps(), 1, DEFAULT_RECONCILER_OPTIONS);

    await jest.advanceTimersByTimeAsync(60_000);
    // The tick has started and is stuck. Nothing recorded yet, which is correct:
    // a sweep still inside its deadline has not failed.
    expect(handle.health().consecutiveFailures).toBe(0);

    await jest.advanceTimersByTimeAsync(47_000);
    expect(handle.health().consecutiveFailures).toBe(0);

    await jest.advanceTimersByTimeAsync(2_000);
    const health = handle.health();
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastSuccessAt).toBeNull();
    expect(String(health.lastError)).toMatch(/deadline/i);

    handle.stop();
  });

  it('a hung sweep still alerts, because it counts as a failure', async () => {
    jest.useFakeTimers();
    const notifier = new MockNotifier();
    const handle = startReconciliation(hangingDeps(), 1, DEFAULT_RECONCILER_OPTIONS, notifier);

    // Three whole cycles: each tick starts, hangs, and is abandoned 48s later.
    for (let i = 0; i < 3; i += 1) await jest.advanceTimersByTimeAsync(60_000 + 48_000);

    expect(handle.health().consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(notifier.kinds()).toContain('MENTION_SWEEP_FAILING');
    handle.stop();
  });

  it('the deadline lands before the next tick would have run', async () => {
    jest.useFakeTimers();
    const handle = startReconciliation(hangingDeps(), 5, DEFAULT_RECONCILER_OPTIONS);

    // A five-minute interval: the sweep must be reported failing before 300s,
    // or a hang is never distinguishable from a slow poll.
    await jest.advanceTimersByTimeAsync(300_000);
    await jest.advanceTimersByTimeAsync(299_000);
    expect(handle.health().consecutiveFailures).toBeGreaterThanOrEqual(1);
    handle.stop();
  });

  it('a sweep that finishes inside the deadline is still a success', async () => {
    jest.useFakeTimers();
    const deps: any = {
      db: { getState: () => undefined, setState: () => undefined },
      xClient: { getRecentMentions: async () => [] },
    };
    const handle = startReconciliation(deps, 1, DEFAULT_RECONCILER_OPTIONS);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(handle.health().consecutiveFailures).toBe(0);
    expect(handle.health().lastSuccessAt).not.toBeNull();
    handle.stop();
  });
});

/**
 * Every call to X carries a deadline.
 *
 * The watchdog above is the backstop; this is the thing it backs up. A number
 * sitting alone beside a `fetch` gets copied without its reasoning to the next
 * call somebody adds, so the values live in one file and every call site names
 * one.
 */
describe('X calls are bounded', () => {
  const read = (file: string) =>
    require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', file), 'utf8');

  it('no fetch on the X path is left unbounded', () => {
    for (const file of ['xClient.ts', 'mentionSources.ts']) {
      const source = read(file);
      const calls = source.match(/(?:await )?(?:this\.)?fetch(?:Impl)?\([\s\S]{0,600}?\n\s*\}\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).toMatch(/signal: AbortSignal\.timeout\(/);
      }
    }
  });

  it('the deadlines are named once, not spelled out at each call', () => {
    const deadlines = read('xDeadlines.ts');
    expect(deadlines).toMatch(/export const X_READ_TIMEOUT_MS/);
    expect(deadlines).toMatch(/export const X_WRITE_TIMEOUT_MS/);
    for (const file of ['xClient.ts', 'mentionSources.ts']) {
      const source = read(file);
      expect(source).toMatch(/from '\.\/xDeadlines'/);
      // A bare number here is the thing that gets copied without its reasoning.
      expect(source).not.toMatch(/AbortSignal\.timeout\(\d/);
    }
  });
});
