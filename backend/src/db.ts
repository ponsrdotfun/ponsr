import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { LaunchRecord, ResolvedWallet , LaunchProvenance } from './types';

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

      /*
       * Which pons deployment a launch was actually made through.
       *
       * A separate table rather than columns on the launches table, for one reason:
       * the rows
       * that already exist predate every pons migration, and adding NOT NULL columns
       * would either refuse to migrate or invent values for launches made through
       * contracts that did not exist yet. A missing row here means "we do not know",
       * which is the truth about those launches and is not the same as "the current
       * deployment".
       *
       * Ponsr has now launched through three deployments with different ABIs, event
       * shapes and escrows. Reading a token's history back means knowing which
       * contract to ask, and after the next migration nobody will remember.
       */
      CREATE TABLE IF NOT EXISTS launch_provenance (
        launch_id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        factory TEXT NOT NULL,
        fee_escrow TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        original_deployer TEXT NOT NULL,
        pair_token TEXT NOT NULL,
        launch_config_id TEXT NOT NULL,
        salt TEXT NOT NULL,
        economics_digest TEXT,
        curve TEXT,
        -- The creator's fee recipient for this launch. It is the ONLY address that can
        -- claim from the escrow -- claims pay msg.sender and there is no claimFor -- so
        -- a row without it can only be recovered by re-deriving the address from a
        -- transaction receipt, which is the archaeology nobody does when it matters.
        splitter TEXT,
        -- How the calldata was built. Two deployments in the registry already take
        -- different calldata for the same nominal function, so a row that cannot say
        -- which encoding produced it cannot be replayed or audited.
        launch_selector TEXT,
        token_params_version TEXT,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (launch_id) REFERENCES launches(id)
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

      CREATE INDEX IF NOT EXISTS idx_spend_launch ON treasury_spend_log(launch_id);
      CREATE INDEX IF NOT EXISTS idx_spend_at ON treasury_spend_log(spent_at);
      CREATE INDEX IF NOT EXISTS idx_launch_created ON launches(created_at);
      CREATE INDEX IF NOT EXISTS idx_rejected_at ON rejection_log(rejected_at);
    `);

    // Runs after the schema on every open, and does nothing when there is nothing to
    // do. `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so a
    // column added above would never reach a database created before it -- every
    // existing deployment would start writing to columns that are not there.
    this.migrateProvenanceColumns();
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

  /**
   * Gives the idempotency slot back, so the mention can be tried again.
   *
   * The claim is taken before anything else runs, which is what makes duplicate
   * webhook deliveries harmless. The cost is that a failure *between* the claim and
   * any real work burns the mention permanently: the sweep will not retry it,
   * because as far as the database is concerned it was handled.
   *
   * That is the right trade only while nothing can fail in between. A parser that
   * throws -- an exhausted API balance, a network blip, an upstream outage -- is a
   * transient failure that would otherwise silently consume a genuine launch request
   * and answer it with nothing at all.
   *
   * ⚠️ ONLY safe before a transaction has been sent. Releasing a mention whose launch
   * may have reached the chain invites launching the same request twice and paying
   * the fee twice. Every caller must be certain no money has moved.
   */
  releaseTweetClaim(tweetId: string): void {
    this.db.prepare('DELETE FROM processed_tweets WHERE tweet_id = ?').run(tweetId);
  }

  /**
   * Records which deployment a launch was built for, at the time it was built.
   *
   * Written before the transaction is sent, so a launch that reverts still leaves
   * evidence of what was attempted -- which is the case where knowing the deployment
   * matters most.
   */
  /**
   * Adds provenance columns to a database created before they existed.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that is already there, so a
   * schema change alone would leave every existing deployment writing to columns that
   * are not present. Additive and idempotent: each column is added only if missing, and
   * existing rows get NULL rather than a backfilled guess. A launch made before this
   * column existed genuinely has no recorded splitter, and writing one in would be
   * inventing a fact about money.
   */
  private migrateProvenanceColumns(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(launch_provenance)').all() as any[]).map((c) => c.name)
    );
    const additions: Array<[string, string]> = [
      ['splitter', 'TEXT'],
      ['launch_selector', 'TEXT'],
      ['token_params_version', 'TEXT'],
    ];
    for (const [name, type] of additions) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE launch_provenance ADD COLUMN ${name} ${type}`);
      }
    }
  }

  recordLaunchProvenance(launchId: string, p: LaunchProvenance): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO launch_provenance
         (launch_id, deployment_id, factory, fee_escrow, chain_id, original_deployer,
          pair_token, launch_config_id, salt, economics_digest, curve,
          splitter, launch_selector, token_params_version, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        launchId,
        p.deploymentId,
        p.factory,
        p.feeEscrow,
        p.chainId,
        p.originalDeployer,
        p.pairToken,
        p.launchConfigId,
        p.salt,
        p.economicsDigest ?? null,
        p.curve ?? null,
        p.splitter ?? null,
        p.launchSelector ?? null,
        p.tokenParamsVersion ?? null,
        new Date().toISOString()
      );
  }

  /**
   * The launch a splitter belongs to, looked up by the splitter's own address.
   *
   * This is what makes fee recovery possible at all. Every splitter the bot deploys
   * carries `token()` = zero -- it is deployed BEFORE the launch that creates the token,
   * so there is nothing else it could carry -- and the collector used to read that field
   * and treat it as the launched token. For every bot launch that value is zero, so the
   * documented recovery tool could not recover anything.
   *
   * The launch record is the durable answer, and this is how the collector reaches it.
   */
  getLaunchBySplitter(splitterAddress: string): {
    launchId: string;
    tokenAddress: string | null;
    deploymentId: string | null;
    factory: string | null;
    pairToken: string | null;
  } | null {
    const r: any = this.db
      .prepare(
        `SELECT l.id AS launch_id, l.token_address, p.deployment_id, p.factory, p.pair_token
           FROM launch_provenance p
           JOIN launches l ON l.id = p.launch_id
          WHERE lower(p.splitter) = lower(?)`
      )
      .get(splitterAddress);
    if (!r) return null;
    return {
      launchId: String(r.launch_id),
      tokenAddress: r.token_address ?? null,
      deploymentId: r.deployment_id ?? null,
      factory: r.factory ?? null,
      pairToken: r.pair_token ?? null,
    };
  }

  /**
   * Fills in the bonding curve once the launch has confirmed.
   *
   * The curve address does not exist until the transaction lands, so provenance is
   * written before the send with `curve: null` and completed here. Recording a guess
   * beforehand would put an address in a money-related record that no chain event ever
   * produced.
   *
   * Silently does nothing when there is no provenance row -- a v1 launch, or one made
   * before the table existed. Creating one here would invent lineage for a launch whose
   * lineage was never captured.
   */
  updateLaunchProvenanceCurve(launchId: string, curve: string): void {
    this.db
      .prepare('UPDATE launch_provenance SET curve = ? WHERE launch_id = ?')
      .run(curve, launchId);
  }

  /** Null for launches made before this was recorded. Not a default: those launches
   *  went through contracts that no longer decide anything, and naming the current
   *  deployment for them would be a guess written down as a fact. */
  getLaunchProvenance(launchId: string): LaunchProvenance | null {
    const r: any = this.db
      .prepare('SELECT * FROM launch_provenance WHERE launch_id = ?')
      .get(launchId);
    if (!r) return null;
    return {
      deploymentId: r.deployment_id,
      factory: r.factory,
      feeEscrow: r.fee_escrow,
      chainId: Number(r.chain_id),
      originalDeployer: r.original_deployer,
      pairToken: r.pair_token,
      launchConfigId: String(r.launch_config_id),
      salt: r.salt,
      economicsDigest: r.economics_digest,
      curve: r.curve,
      splitter: r.splitter ?? null,
      launchSelector: r.launch_selector ?? null,
      tokenParamsVersion: r.token_params_version ?? null,
    };
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

  /** Durable inputs for keyless reconciliation of landed-but-unconfirmed launches. */
  getLaunchIncidents(): Array<{
    launchId: string;
    txHash: string;
    deploymentId: string;
    tokenName: string;
    tokenSymbol: string;
    originalDeployer: string;
    pairToken: string;
    launchConfigId: string;
    salt: string;
    economicsDigest: string;
    splitter: string;
    launchSelector: string;
  }> {
    return this.db.prepare(
      `SELECT l.id AS launchId, l.tx_hash AS txHash, l.token_name AS tokenName,
              l.token_symbol AS tokenSymbol, p.deployment_id AS deploymentId,
              p.original_deployer AS originalDeployer, p.pair_token AS pairToken,
              p.launch_config_id AS launchConfigId, p.salt, p.economics_digest AS economicsDigest,
              p.splitter, p.launch_selector AS launchSelector
         FROM launches l JOIN launch_provenance p ON p.launch_id = l.id
        WHERE l.status = 'incident' AND l.tx_hash IS NOT NULL
          AND p.splitter IS NOT NULL AND p.launch_selector IS NOT NULL
          AND p.economics_digest IS NOT NULL
        ORDER BY l.created_at, l.id`
    ).all() as any;
  }

  /** Changes only an unresolved incident; concurrent/repeated recovery is a no-op. */
  confirmLaunchIncident(launchId: string, tokenAddress: string, curve: string): boolean {
    const confirm = this.db.transaction(() => {
      const changed = this.db.prepare(
        `UPDATE launches SET status = 'confirmed', token_address = ?, rejection_reason = NULL
          WHERE id = ? AND status = 'incident'`
      ).run(tokenAddress, launchId);
      if (changed.changes !== 1) return false;
      this.db.prepare('UPDATE launch_provenance SET curve = ? WHERE launch_id = ?').run(curve, launchId);
      return true;
    });
    return confirm();
  }

  setIncidentReason(launchId: string, reason: string): void {
    this.db.prepare(
      `UPDATE launches SET rejection_reason = ? WHERE id = ? AND status = 'incident'`
    ).run(reason, launchId);
  }

  getIncidentReason(launchId: string): string | null {
    const row = this.db.prepare('SELECT rejection_reason FROM launches WHERE id = ?').get(launchId) as any;
    return row?.rejection_reason ?? null;
  }

  /** Count of successful launches by this user in the last 24h, for the per-user rate cap. */
  countLaunchesLast24h(xUserId: string): number {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM launches
         WHERE x_user_id = ? AND status IN ('pending', 'confirmed', 'incident') AND created_at > ?`
      )
      .get(xUserId, cutoff) as any;
    return row.cnt as number;
  }

  /** Records a paid launch fee idempotently. Receipt reconciliation may be retried,
   * but one on-chain launch must consume the daily budget exactly once. */
  recordTreasurySpend(launchId: string, amountWei: bigint) {
    this.db
      .prepare(`INSERT INTO treasury_spend_log (launch_id, amount_wei, spent_at)
        SELECT ?, ?, ? WHERE NOT EXISTS (
          SELECT 1 FROM treasury_spend_log WHERE launch_id = ?
        )`)
      .run(launchId, amountWei.toString(), new Date().toISOString(), launchId);
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
         WHERE status IN ('pending', 'confirmed', 'incident') AND created_at > ? AND created_at <= ?`
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
