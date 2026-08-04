import { validateLaunchRequest, sanitizeName, sanitizeSymbol, sanitizeDescription } from '../src/validator';
import { Db } from '../src/db';
import { ParsedIntent, AccountSignals } from '../src/types';
import * as fs from 'fs';

const TEST_DB_PATH = './data/test-validator.sqlite';

function freshDb(): Db {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  return new Db(TEST_DB_PATH);
}

const OLD_ACCOUNT: AccountSignals = {
  xUserId: 'user1',
  accountCreatedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
  followerCount: 100,
};

const NEW_ACCOUNT: AccountSignals = {
  xUserId: 'user2',
  accountCreatedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
  followerCount: 100,
};

const LOW_FOLLOWER_ACCOUNT: AccountSignals = {
  xUserId: 'user3',
  accountCreatedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
  followerCount: 1,
};

function goodIntent(overrides: Partial<ParsedIntent> = {}): ParsedIntent {
  return {
    isLaunchIntent: true,
    confidence: 'high',
    tokenName: 'Moon Coin',
    tokenSymbol: 'MOON',
    description: 'a fun community token',
    ...overrides,
  };
}

describe('sanitizeName', () => {
  it('accepts a clean name', () => {
    expect(sanitizeName('Moon Coin')).toBe('Moon Coin');
  });
  it('collapses internal whitespace', () => {
    expect(sanitizeName('Star   Fox')).toBe('Star Fox');
  });
  it('rejects names over the max length', () => {
    expect(sanitizeName('A'.repeat(100))).toBeNull();
  });
  it('rejects names with unsafe characters', () => {
    expect(sanitizeName('Evil<script>Coin')).toBeNull();
  });
  it('rejects empty/whitespace-only names', () => {
    expect(sanitizeName('   ')).toBeNull();
  });
});

describe('sanitizeSymbol', () => {
  it('accepts a clean symbol', () => {
    expect(sanitizeSymbol('MOON')).toBe('MOON');
  });
  it('strips a leading $ and uppercases', () => {
    expect(sanitizeSymbol('$moon')).toBe('MOON');
  });
  it('rejects symbols with special characters', () => {
    expect(sanitizeSymbol('MO#ON')).toBeNull();
  });
  it('rejects symbols over the max length', () => {
    expect(sanitizeSymbol('A'.repeat(20))).toBeNull();
  });
});

describe('sanitizeDescription', () => {
  it('passes through a normal description', () => {
    expect(sanitizeDescription('a fun token')).toBe('a fun token');
  });
  it('returns null for null input', () => {
    expect(sanitizeDescription(null)).toBeNull();
  });
  it('truncates to 280 characters', () => {
    const long = 'a'.repeat(400);
    expect(sanitizeDescription(long)!.length).toBe(280);
  });
});

describe('validateLaunchRequest', () => {
  let db: Db;
  const getLiveFeeWei = async () => 500_000_000_000_000n; // 0.0005 ETH, matches Pons's documented fee
  // A comfortably funded hot wallet, so the Part 5 #7 admission check is not what
  // any of the other cases below are actually testing.
  const getTreasuryBalanceWei = async () => 50_000_000_000_000_000n; // 0.05 ETH
  // pons's factory is open and the configured launch config is live -- the normal case,
  // so it is not what any of the other cases below are testing.
  const getLaunchReadiness = async () => ({ canLaunch: true, launchConfigUsable: true });

  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  it('approves a well-formed, high-confidence request from a legitimate account', async () => {
    const result = await validateLaunchRequest(goodIntent(), 'user1', 'tweet1', {
      db,
      getAccountSignals: async () => OLD_ACCOUNT,
      getLiveFeeWei,
      getTreasuryBalanceWei,
      getLaunchReadiness,
    });
    expect(result.approved).toBe(true);
    expect(result.sanitized).toEqual({ tokenName: 'Moon Coin', tokenSymbol: 'MOON', description: 'a fun community token' });
  });

  it('rejects when isLaunchIntent is false -- eval case 013/014/015 style', async () => {
    const result = await validateLaunchRequest(
      goodIntent({ isLaunchIntent: false }),
      'user1',
      'tweet1',
      { db, getAccountSignals: async () => OLD_ACCOUNT, getLiveFeeWei, getTreasuryBalanceWei, getLaunchReadiness }
    );
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('NOT_LAUNCH_INTENT');
  });

  it('rejects low-confidence requests rather than guessing -- eval case 009/010/027/028 style', async () => {
    const result = await validateLaunchRequest(
      goodIntent({ confidence: 'low', tokenSymbol: null }),
      'user1',
      'tweet1',
      { db, getAccountSignals: async () => OLD_ACCOUNT, getLiveFeeWei, getTreasuryBalanceWei, getLaunchReadiness }
    );
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('LOW_CONFIDENCE');
  });

  it('rejects when tokenName is missing even at high confidence', async () => {
    const result = await validateLaunchRequest(
      goodIntent({ tokenName: null }),
      'user1',
      'tweet1',
      { db, getAccountSignals: async () => OLD_ACCOUNT, getLiveFeeWei, getTreasuryBalanceWei, getLaunchReadiness }
    );
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('MISSING_REQUIRED_FIELD');
  });

  it('rejects when tokenSymbol is missing even at high confidence', async () => {
    const result = await validateLaunchRequest(
      goodIntent({ tokenSymbol: null }),
      'user1',
      'tweet1',
      { db, getAccountSignals: async () => OLD_ACCOUNT, getLiveFeeWei, getTreasuryBalanceWei, getLaunchReadiness }
    );
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('MISSING_REQUIRED_FIELD');
  });

  it('rejects an account younger than MIN_ACCOUNT_AGE_DAYS -- anti-Sybil', async () => {
    const result = await validateLaunchRequest(goodIntent(), 'user2', 'tweet1', {
      db,
      getAccountSignals: async () => NEW_ACCOUNT,
      getLiveFeeWei,
      getTreasuryBalanceWei,
      getLaunchReadiness,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('ACCOUNT_TOO_NEW');
  });

  it('rejects an account below MIN_FOLLOWER_COUNT -- anti-Sybil', async () => {
    const result = await validateLaunchRequest(goodIntent(), 'user3', 'tweet1', {
      db,
      getAccountSignals: async () => LOW_FOLLOWER_ACCOUNT,
      getLiveFeeWei,
      getTreasuryBalanceWei,
      getLaunchReadiness,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('INSUFFICIENT_FOLLOWERS');
  });

  it('rejects once the per-user daily launch cap is reached', async () => {
    // MAX_LAUNCHES_PER_USER_PER_DAY defaults to 3 -- insert 3 prior launches for this user.
    for (let i = 0; i < 3; i++) {
      db.claimTweetForProcessing(`t${i}`); // real flow always claims before inserting a launch
      db.insertLaunch({
        id: `l${i}`,
        sourceTweetId: `t${i}`,
        xUserId: 'user1',
        tokenName: 'X',
        tokenSymbol: 'X',
        splitterAddress: null,
        tokenAddress: null,
        txHash: null,
        status: 'confirmed',
        rejectionReason: null,
        feeWeiPaid: null,
        createdAt: new Date().toISOString(),
      });
    }
    const result = await validateLaunchRequest(goodIntent(), 'user1', 'tweet_new', {
      db,
      getAccountSignals: async () => OLD_ACCOUNT,
      getLiveFeeWei,
      getTreasuryBalanceWei,
      getLaunchReadiness,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('RATE_LIMIT_USER');
  });

  it('rejects when the live fee exceeds the configured ceiling -- fee-spike protection', async () => {
    const result = await validateLaunchRequest(goodIntent(), 'user1', 'tweet1', {
      db,
      getAccountSignals: async () => OLD_ACCOUNT,
      getLiveFeeWei: async () => 999_000_000_000_000_000n, // absurdly high fee
      getTreasuryBalanceWei,
      getLaunchReadiness,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('FEE_EXCEEDS_CEILING');
  });

  it('rejects once the global daily spend cap would be exceeded -- circuit breaker', async () => {
    // DAILY_SPEND_CAP_WEI defaults to 0.05 ETH. Record spend that already consumes it.
    db.recordTreasurySpend('prior_launch', 50_000_000_000_000_000n);
    const result = await validateLaunchRequest(goodIntent(), 'user1', 'tweet1', {
      db,
      getAccountSignals: async () => OLD_ACCOUNT,
      getLiveFeeWei,
      getTreasuryBalanceWei,
      getLaunchReadiness,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('DAILY_SPEND_CAP_REACHED');
  });

  it('CRITICAL: refuses when the hot wallet cannot fund a launch -- Part 5 mitigation #7', async () => {
    // Without this gate the flow deploys a splitter, builds the calldata, sends a
    // transaction that reverts for insufficient funds, and still pays gas for the
    // attempt -- while telling the user something vague went wrong.
    const result = await validateLaunchRequest(goodIntent(), 'user1', 'tweet1', {
      db,
      getAccountSignals: async () => OLD_ACCOUNT,
      getLiveFeeWei,
      getTreasuryBalanceWei: async () => 0n,
      getLaunchReadiness,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('TREASURY_EXHAUSTED');
  });

  it('distinguishes an empty wallet from a policy pause -- they need different operator responses', async () => {
    // DAILY_SPEND_CAP_REACHED means "funds exist, we chose to stop".
    // TREASURY_EXHAUSTED means "the wallet is actually out". Merging them would
    // send the operator looking for the wrong problem.
    db.recordTreasurySpend('prior_launch', 50_000_000_000_000_000n);
    const capped = await validateLaunchRequest(goodIntent(), 'user1', 'tweet1', {
      db,
      getAccountSignals: async () => OLD_ACCOUNT,
      getLiveFeeWei,
      getTreasuryBalanceWei, // wallet is full; only the policy cap is hit
      getLaunchReadiness,
    });
    expect(capped.reason).toBe('DAILY_SPEND_CAP_REACHED');
  });

  it('still admits a launch while the wallet is low but fundable', async () => {
    // "Low" is a page for the operator, not a reason to turn away a user the
    // treasury can still pay for.
    const result = await validateLaunchRequest(goodIntent(), 'user1', 'tweet1', {
      db,
      getAccountSignals: async () => OLD_ACCOUNT,
      getLiveFeeWei,
      // gas reserve (0.002) + 2 launch fees
      getTreasuryBalanceWei: async () => 2_000_000_000_000_000n + 1_000_000_000_000_000n,
      getLaunchReadiness,
    });
    expect(result.approved).toBe(true);
  });

  it('CRITICAL: refuses when pons has launching switched off -- open question #23', async () => {
    // The factory's own guard is `if (!launchEnabled && !whitelistedLaunchers[msg.sender])
    // revert NotWhitelisted()`. Both sides are pons-controlled and can flip without notice.
    // Without reading them first, the bot finds out by sending a transaction that must
    // revert: the user gets a meaningless failure and the treasury still pays the gas.
    const result = await validateLaunchRequest(goodIntent(), 'user1', 'tweet1', {
      db,
      getAccountSignals: async () => OLD_ACCOUNT,
      getLiveFeeWei,
      getTreasuryBalanceWei,
      getLaunchReadiness: async () => ({
        canLaunch: false,
        launchConfigUsable: true,
        reason: 'launchEnabled is false and this launcher is not whitelisted',
      }),
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('LAUNCHPAD_UNAVAILABLE');
    expect(result.detail).toMatch(/whitelist/i);
  });

  it('refuses when the configured launch config has been disabled', async () => {
    // A separate factory guard (`LaunchConfigDisabled`), and a separate failure: launching
    // is open, but the specific config carrying the pair token and graduation threshold is
    // off. Same outcome for the user, different thing for the operator to go and fix.
    const result = await validateLaunchRequest(goodIntent(), 'user1', 'tweet1', {
      db,
      getAccountSignals: async () => OLD_ACCOUNT,
      getLiveFeeWei,
      getTreasuryBalanceWei,
      getLaunchReadiness: async () => ({
        canLaunch: true,
        launchConfigUsable: false,
        reason: 'launch config 0 is disabled',
      }),
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('LAUNCHPAD_UNAVAILABLE');
  });

  it('refuses when the DEX config has been disabled', async () => {
    // A third factory guard (`DexDisabled` / `InvalidDexId`), separate from the launch config.
    // Verified live on 2026-08-04: one dex config exists, id 0, "uniswap v3", enabled. pons
    // can turn it off, and the consequence is the same revert we would pay gas for.
    const result = await validateLaunchRequest(goodIntent(), 'user1', 'tweet1', {
      db,
      getAccountSignals: async () => OLD_ACCOUNT,
      getLiveFeeWei,
      getTreasuryBalanceWei,
      getLaunchReadiness: async () => ({
        canLaunch: true,
        launchConfigUsable: true,
        dexConfigUsable: false,
        reason: 'dex config 0 is disabled',
      }),
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('LAUNCHPAD_UNAVAILABLE');
  });

  it('treats an absent dexConfigUsable as usable, so older callers still approve', async () => {
    const result = await validateLaunchRequest(goodIntent(), 'user1', 'tweet1', {
      db,
      getAccountSignals: async () => OLD_ACCOUNT,
      getLiveFeeWei,
      getTreasuryBalanceWei,
      getLaunchReadiness: async () => ({ canLaunch: true, launchConfigUsable: true }),
    });
    expect(result.approved).toBe(true);
  });

  it('does not reach the launchpad check when a cheaper guard already rejected', async () => {
    // Ordering matters: the readiness read costs an RPC round trip, so everything
    // deterministic must reject first. A brand-new account should never cause a network call.
    let asked = false;
    const result = await validateLaunchRequest(goodIntent(), 'user2', 'tweet1', {
      db,
      getAccountSignals: async () => NEW_ACCOUNT,
      getLiveFeeWei,
      getTreasuryBalanceWei,
      getLaunchReadiness: async () => {
        asked = true;
        return { canLaunch: true, launchConfigUsable: true };
      },
    });
    expect(result.reason).toBe('ACCOUNT_TOO_NEW');
    expect(asked).toBe(false);
  });

  it('rejects and sanitizes-away unsafe characters rather than passing them through', async () => {
    const result = await validateLaunchRequest(
      goodIntent({ tokenName: 'Evil<img src=x>Coin' }),
      'user1',
      'tweet1',
      { db, getAccountSignals: async () => OLD_ACCOUNT, getLiveFeeWei, getTreasuryBalanceWei, getLaunchReadiness }
    );
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('FAILED_SANITIZATION');
  });
});
