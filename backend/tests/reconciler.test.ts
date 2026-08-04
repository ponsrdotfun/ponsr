import { ethers } from 'ethers';
import * as fs from 'fs';
import { Db } from '../src/db';
import { MockParser } from '../src/parser';
import { MockWalletResolver } from '../src/walletResolver';
import { MockXClient } from '../src/xClient';
import { TreasurySigner } from '../src/treasurySigner';
import { handleMention, OrchestratorDeps } from '../src/orchestrator';
import { reconcileOnce, startReconciliation, DEFAULT_RECONCILER_OPTIONS } from '../src/reconciler';
import { InboundMention, ParsedIntent } from '../src/types';
import { PONS_FACTORY_ABI } from '../src/ponsEncoder';

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
      return { hash, wait: async () => ({ status: 1, contractAddress: fakeAddress('splitter' + this.nonce), logs: [] } as any) };
    }
    const iface = new ethers.Interface(PONS_FACTORY_ABI);
    const decoded = iface.decodeFunctionData('launchToken', tx.data);
    // Real TokenLaunched: token, deployer, dexFactory, pairToken, pool, dexId,
    // launchConfigId, positionId, restrictionsEndBlock, initialBuyAmount.
    const log = iface.encodeEventLog('TokenLaunched', [
      fakeAddress('token' + this.nonce),
      fakeAddress('fake-treasury'),
      fakeAddress('dexFactory'),
      fakeAddress('pairToken'),
      fakeAddress('pool' + this.nonce),
      decoded[2], // dexId
      decoded[1], // launchConfigId
      1n,
      0n,
      0n,
    ]);
    return { hash, wait: async () => ({ status: 1, logs: [{ topics: log.topics, data: log.data }] } as any) };
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
      parser: new MockParser(new Map([['launch Moon Coin MOON', GOOD_INTENT]])),
      walletResolver: new MockWalletResolver(db),
      xClient,
      treasurySigner,
      provider: {} as any,
      getLiveFeeWei: async () => LIVE_FEE,
      getTreasuryBalanceWei: async () => 50_000_000_000_000_000n, // funded; not what these test
      getLaunchReadiness: async () => ({ canLaunch: true, launchConfigUsable: true }),
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
