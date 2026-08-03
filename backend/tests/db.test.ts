import { Db } from '../src/db';
import * as fs from 'fs';

const TEST_DB_PATH = './data/test-db.sqlite';

function freshDb(): Db {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  return new Db(TEST_DB_PATH);
}

describe('Db idempotency', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  it('claims a tweet ID successfully the first time', () => {
    expect(db.claimTweetForProcessing('tweet_abc')).toBe(true);
  });

  it('CRITICAL: refuses to claim the same tweet ID twice -- this is what closes the duplicate-webhook race condition from Part 5s audit', () => {
    expect(db.claimTweetForProcessing('tweet_abc')).toBe(true);
    expect(db.claimTweetForProcessing('tweet_abc')).toBe(false);
    expect(db.claimTweetForProcessing('tweet_abc')).toBe(false); // still false on a third attempt
  });

  it('allows different tweet IDs to be claimed independently', () => {
    expect(db.claimTweetForProcessing('tweet_1')).toBe(true);
    expect(db.claimTweetForProcessing('tweet_2')).toBe(true);
  });

  it('simulates concurrent duplicate webhook delivery -- only one of many simultaneous claims for the same ID succeeds', () => {
    // Simulates N "concurrent" webhook deliveries for the same tweet arriving in a tight
    // loop (SQLite is single-writer, so this is a reasonable proxy for the real-world
    // scenario of a provider retrying/duplicating a webhook under network conditions).
    const attempts = Array.from({ length: 10 }, () => db.claimTweetForProcessing('tweet_race'));
    const successCount = attempts.filter(Boolean).length;
    expect(successCount).toBe(1);
  });
});

describe('Db spend tracking', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  it('starts at zero spend', () => {
    expect(db.totalSpendLast24h()).toBe(0n);
  });

  it('accumulates spend correctly across multiple records', () => {
    db.recordTreasurySpend('l1', 500_000_000_000_000n);
    db.recordTreasurySpend('l2', 500_000_000_000_000n);
    expect(db.totalSpendLast24h()).toBe(1_000_000_000_000_000n);
  });

  it('handles large bigint values without precision loss', () => {
    const large = 123_456_789_012_345_678n;
    db.recordTreasurySpend('l1', large);
    expect(db.totalSpendLast24h()).toBe(large);
  });
});

describe('Db user resolution', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  it('returns null for an unknown user', () => {
    expect(db.getUser('nobody')).toBeNull();
  });

  it('persists and retrieves a user wallet mapping', () => {
    db.upsertUser('user1', 'jess', { xUserId: 'user1', walletAddress: '0xabc', providerRef: 'privy:1' });
    const found = db.getUser('user1');
    expect(found).toEqual({ xUserId: 'user1', walletAddress: '0xabc', providerRef: 'privy:1' });
  });

  it('does not overwrite wallet address on re-upsert of an existing user (wallet is permanent once assigned)', () => {
    db.upsertUser('user1', 'jess', { xUserId: 'user1', walletAddress: '0xabc', providerRef: 'privy:1' });
    db.upsertUser('user1', 'jess_new_handle', { xUserId: 'user1', walletAddress: '0xDIFFERENT', providerRef: 'privy:2' });
    const found = db.getUser('user1');
    // Wallet address must stay stable even if somehow called again -- ON CONFLICT clause
    // only updates x_handle, never wallet_address, precisely to prevent a bug elsewhere
    // from accidentally reassigning a user's resolved wallet.
    expect(found!.walletAddress).toBe('0xabc');
  });
});
