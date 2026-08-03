import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { LaunchRecord, ResolvedWallet } from './types';

/**
 * All persistence for the bot. Deliberately SQLite for local dev/testnet -- the schema below
 * is simple enough to port to Postgres unchanged when the project moves to production/shared
 * infra (see Part 3 of the master doc, data model section). The two things that MUST remain
 * true under any backend swap:
 *   1. `processed_tweets.tweet_id` has a UNIQUE constraint enforced at the database level,
 *      not just checked in application code -- this is what makes idempotency atomic and
 *      immune to the race-condition class of bug flagged in Part 5's audit (duplicate
 *      webhook delivery must never cause a double-spend).
 *   2. All spend-affecting writes (recording a launch, updating daily spend) happen inside
 *      the same transaction as the idempotency check, for the same reason.
 */
export class Db {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_tweets (
        tweet_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        x_user_id TEXT PRIMARY KEY,
        x_handle TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        wallet_provider_ref TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS launches (
        id TEXT PRIMARY KEY,
        source_tweet_id TEXT NOT NULL UNIQUE,
        x_user_id TEXT NOT NULL,
        token_name TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        splitter_address TEXT,
        token_address TEXT,
        tx_hash TEXT,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        fee_wei_paid TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (source_tweet_id) REFERENCES processed_tweets(tweet_id)
      );

      CREATE TABLE IF NOT EXISTS treasury_spend_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        launch_id TEXT NOT NULL,
        amount_wei TEXT NOT NULL,
        spent_at TEXT NOT NULL
      );

      -- Rejections were previously not persisted at all: insertLaunch only runs
      -- after validation passes, so a Sybil attempt that the guards correctly
      -- blocked left no trace anywhere. Part 5's monitoring requirement needs
      -- exactly that trace -- a burst of anti-Sybil rejections across many
      -- distinct accounts is the attack signature, and it is invisible without
      -- this table.
      CREATE TABLE IF NOT EXISTS rejection_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tweet_id TEXT NOT NULL,
        x_user_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        rejected_at TEXT NOT NULL
      );

      -- Small key/value store for operational state that must survive a restart.
      -- Currently just the reconciler's watermark: without it, a restart either
      -- re-polls from the beginning of time or silently skips the outage window.
      CREATE TABLE IF NOT EXISTS bot_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_spend_at ON treasury_spend_log(spent_at);
      CREATE INDEX IF NOT EXISTS idx_launch_created ON launches(created_at);
      CREATE INDEX IF NOT EXISTS idx_rejected_at ON rejection_log(rejected_at);
    `);
  }

  /** Atomically claims a tweet ID for processing. Returns false if it was already claimed --
   * this is the single line of code that closes the duplicate-webhook race condition from
   * Part 5's audit. Must be called and checked BEFORE any treasury-affecting work begins. */
  claimTweetForProcessing(tweetId: string): boolean {
    try {
      this.db
        .prepare('INSERT INTO processed_tweets (tweet_id, processed_at) VALUES (?, ?)')
        .run(tweetId, new Date().toISOString());
      return true;
    } catch (err: any) {
      if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return false; // already claimed by a concurrent/duplicate delivery
      }
      throw err;
    }
  }

  getUser(xUserId: string): ResolvedWallet | null {
    const row = this.db
      .prepare('SELECT x_user_id, wallet_address, wallet_provider_ref FROM users WHERE x_user_id = ?')
      .get(xUserId) as any;
    if (!row) return null;
    return { xUserId: row.x_user_id, walletAddress: row.wallet_address, providerRef: row.wallet_provider_ref };
  }

  upsertUser(xUserId: string, xHandle: string, wallet: ResolvedWallet) {
    this.db
      .prepare(
        `INSERT INTO users (x_user_id, x_handle, wallet_address, wallet_provider_ref, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(x_user_id) DO UPDATE SET x_handle = excluded.x_handle`
      )
      .run(xUserId, xHandle, wallet.walletAddress, wallet.providerRef, new Date().toISOString());
  }

  insertLaunch(record: LaunchRecord) {
    this.db
      .prepare(
        `INSERT INTO launches
          (id, source_tweet_id, x_user_id, token_name, token_symbol, splitter_address,
           token_address, tx_hash, status, rejection_reason, fee_wei_paid, created_at)
         VALUES (@id, @sourceTweetId, @xUserId, @tokenName, @tokenSymbol, @splitterAddress,
           @tokenAddress, @txHash, @status, @rejectionReason, @feeWeiPaid, @createdAt)`
      )
      .run(record as any);
  }

  updateLaunchStatus(
    id: string,
    status: LaunchRecord['status'],
    fields: Partial<Pick<LaunchRecord, 'tokenAddress' | 'txHash' | 'feeWeiPaid'>> = {}
  ) {
    this.db
      .prepare(
        `UPDATE launches SET status = ?, token_address = COALESCE(?, token_address),
         tx_hash = COALESCE(?, tx_hash), fee_wei_paid = COALESCE(?, fee_wei_paid) WHERE id = ?`
      )
      .run(status, fields.tokenAddress ?? null, fields.txHash ?? null, fields.feeWeiPaid ?? null, id);
  }

  /** Count of successful launches by this user in the last 24h, for the per-user rate cap. */
  countLaunchesLast24h(xUserId: string): number {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM launches
         WHERE x_user_id = ? AND status IN ('pending', 'confirmed') AND created_at > ?`
      )
      .get(xUserId, cutoff) as any;
    return row.cnt as number;
  }

  recordTreasurySpend(launchId: string, amountWei: bigint) {
    this.db
      .prepare('INSERT INTO treasury_spend_log (launch_id, amount_wei, spent_at) VALUES (?, ?, ?)')
      .run(launchId, amountWei.toString(), new Date().toISOString());
  }

  /** Total treasury wei spent in the last 24h -- backs the global circuit breaker from
   * Part 5's audit. This is a real gate: the orchestrator must check this BEFORE sending any
   * transaction and refuse (with a clear reply) if adding this launch's fee would exceed the
   * configured DAILY_SPEND_CAP_WEI. */
  totalSpendLast24h(): bigint {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare('SELECT amount_wei FROM treasury_spend_log WHERE spent_at > ?')
      .all(cutoff) as any[];
    return rows.reduce((sum, r) => sum + BigInt(r.amount_wei), 0n);
  }

  // -- Windowed queries backing the spend-rate monitor (Part 5 mitigation #5) --

  /** Launches started inside an arbitrary window. The monitor compares a short
   *  recent window against a long baseline window to detect a volume spike. */
  countLaunchesBetween(fromIso: string, toIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM launches
         WHERE status IN ('pending', 'confirmed') AND created_at > ? AND created_at <= ?`
      )
      .get(fromIso, toIso) as any;
    return row.cnt as number;
  }

  /** Treasury wei spent inside an arbitrary window. */
  totalSpendBetween(fromIso: string, toIso: string): bigint {
    const rows = this.db
      .prepare('SELECT amount_wei FROM treasury_spend_log WHERE spent_at > ? AND spent_at <= ?')
      .all(fromIso, toIso) as any[];
    return rows.reduce((sum, r) => sum + BigInt(r.amount_wei), 0n);
  }

  /** Records a blocked request. Cheap, and it is the only evidence that the
   *  guards did anything -- a rejected request otherwise leaves no trace. */
  recordRejection(tweetId: string, xUserId: string, reason: string) {
    this.db
      .prepare('INSERT INTO rejection_log (tweet_id, x_user_id, reason, rejected_at) VALUES (?, ?, ?, ?)')
      .run(tweetId, xUserId, reason, new Date().toISOString());
  }

  /** How many *distinct accounts* were rejected for a given reason since a
   *  cutoff. Distinct accounts is the number that matters: one account hitting
   *  its own rate limit repeatedly is normal, fifty fresh accounts being turned
   *  away inside a minute is a Sybil attempt. */
  countDistinctRejectedUsersSince(reason: string, sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT x_user_id) as cnt FROM rejection_log
         WHERE reason = ? AND rejected_at > ?`
      )
      .get(reason, sinceIso) as any;
    return row.cnt as number;
  }

  // -- Operational state (reconciler watermark) --

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as any;
    return row ? (row.value as string) : null;
  }

  setState(key: string, value: string) {
    this.db
      .prepare(
        `INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, new Date().toISOString());
  }

  /** True if this tweet has already been claimed. Read-only -- unlike
   *  `claimTweetForProcessing`, this does NOT take the claim, so the reconciler
   *  can check cheaply without consuming the idempotency slot. */
  isTweetProcessed(tweetId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM processed_tweets WHERE tweet_id = ?').get(tweetId);
    return !!row;
  }

  close() {
    this.db.close();
  }
}
