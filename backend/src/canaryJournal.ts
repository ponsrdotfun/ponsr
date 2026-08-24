import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A durable record of every irreversible thing the canary is about to do.
 *
 * The canary broadcasts two transactions that cannot be taken back: a splitter deployment
 * and a token launch. Between `sendTransaction` returning and the receipt being read, the
 * only evidence that anything was attempted lives in a local variable. A crash there
 * leaves an operator who cannot answer the one question that matters -- did it land? --
 * and whose cheapest way to find out is to run it again, which is precisely the thing
 * that must not happen.
 *
 * WHY THE DETERMINISTIC SALT IS NOT ENOUGH
 * ---------------------------------------
 * The salt makes a duplicate launch REVERT rather than succeed. That is a good backstop
 * and a poor record: the revert arrives after a second fee has been spent on gas, and it
 * says `PoolAlreadyExists` whether the first attempt was this operator thirty seconds ago
 * or somebody else last week. It prevents the worst outcome without telling anybody what
 * happened.
 *
 * WHY IT IS NOT THE PRODUCTION LAUNCH TABLE
 * -----------------------------------------
 * That table is keyed on X user ids and tweet ids. Reusing it would mean inventing a fake
 * user and a fake tweet for an operator exercise, which puts fiction into the ledger the
 * bot reads to decide what it has already done. Separate store, separate lifecycle.
 *
 * WHERE IT LIVES
 * --------------
 * On the operator's own machine. The Fly filesystem outside /data is ephemeral: a deploy
 * would erase the journal describing transactions that are still on chain, which is worse
 * than having no journal, because the absence would look like "nothing was attempted".
 */

export type CanaryOp = 'splitter_deploy' | 'token_launch';

export type CanaryState =
  | 'prepared'
  | 'broadcast'
  | 'receipt_success'
  | 'receipt_reverted'
  | 'confirmed'
  | 'confirmed_incident';

/** States nobody needs to look at again. Everything else is unresolved by definition. */
const TERMINAL: ReadonlySet<CanaryState> = new Set<CanaryState>(['receipt_reverted', 'confirmed']);

export interface PreparedCanary {
  runId: string;
  op: CanaryOp;
  deploymentId: string;
  chainId: number;
  /** '' for a contract creation, which is exactly how the policy expresses it too. */
  to: string;
  value: bigint;
  calldata: string;
  tokenName?: string;
  tokenSymbol?: string;
  salt?: string;
  pairToken?: string;
  splitterAddress?: string;
}

export interface CanaryRow extends PreparedCanary {
  id: number;
  state: CanaryState;
  txHash: string | null;
  token: string | null;
  problems: string[];
  feeRecordedWei: bigint | null;
  preparedAt: string;
  updatedAt: string;
}

/**
 * Paths a deploy can erase.
 *
 * Not a blocklist of every wrong answer -- there is no such list. It catches the specific
 * mistake somebody makes when they run the canary from inside the container out of
 * convenience, where the journal would vanish with the next `fly deploy` while the
 * transactions it describes stayed on chain forever.
 */
const EPHEMERAL_PREFIXES = ['/app', '/tmp', '/var/tmp', '/run'];

export class CanaryJournal {
  private db: Database.Database;

  constructor(private file: string) {
    const resolved = path.resolve(file);
    // Both the raw string and the resolved one. `path.resolve` prepends a drive letter on
    // Windows, so an operator who typed a container path like /app/canary.sqlite would
    // have it silently rewritten to C:/app/canary.sqlite and sail past a check that only
    // inspected the resolved form.
    const candidates = [file, resolved].map((c) => c.replace(/\\/g, '/'));
    const isEphemeral = (c: string) => EPHEMERAL_PREFIXES.some((e) => c === e || c.startsWith(e + '/'));
    if (candidates.some(isEphemeral)) {
      throw new Error(
        `${file} is ephemeral container storage. The canary journal must be durable operator ` +
          'state: a deploy would erase the record of transactions that are still on chain, and ' +
          'an absent journal reads as "nothing was attempted".'
      );
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS canary_tx (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        op TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        to_address TEXT NOT NULL,
        value_wei TEXT NOT NULL,
        calldata TEXT NOT NULL,
        token_name TEXT,
        token_symbol TEXT,
        salt TEXT,
        pair_token TEXT,
        splitter_address TEXT,
        state TEXT NOT NULL,
        tx_hash TEXT,
        token TEXT,
        problems TEXT NOT NULL DEFAULT '[]',
        fee_recorded_wei TEXT,
        prepared_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS canary_tx_run ON canary_tx(run_id, op);
    `);
  }

  private row(r: any): CanaryRow {
    return {
      id: r.id,
      runId: r.run_id,
      op: r.op as CanaryOp,
      deploymentId: r.deployment_id,
      chainId: r.chain_id,
      to: r.to_address,
      value: BigInt(r.value_wei),
      calldata: r.calldata,
      tokenName: r.token_name ?? undefined,
      tokenSymbol: r.token_symbol ?? undefined,
      salt: r.salt ?? undefined,
      pairToken: r.pair_token ?? undefined,
      splitterAddress: r.splitter_address ?? undefined,
      state: r.state as CanaryState,
      txHash: r.tx_hash ?? null,
      token: r.token ?? null,
      problems: JSON.parse(r.problems),
      feeRecordedWei: r.fee_recorded_wei === null ? null : BigInt(r.fee_recorded_wei),
      preparedAt: r.prepared_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Writes the intent, and refuses if anything is still open.
   *
   * Two refusals, and they are different. An UNRESOLVED row means a previous attempt may
   * still be in flight or may have landed unobserved -- allocating a second transaction
   * there is how one crash becomes two on-chain artifacts. A previously CONFIRMED row for
   * the same run and operation means the work is already done; the deterministic salt
   * would make the retry revert, but only after paying gas to discover it.
   */
  prepare(p: PreparedCanary): number {
    const open = this.unresolved();
    if (open.length > 0) {
      const o = open[0];
      throw new Error(
        `canary journal has an unresolved ${o.op} (id ${o.id}, state ${o.state}` +
          (o.txHash ? `, tx ${o.txHash}` : ', never broadcast') +
          '). Resolve it before preparing another transaction: recover the receipt and ' +
          'reconcile it read-only. Do not send a replacement because polling timed out.'
      );
    }
    const done = this.db
      .prepare("SELECT id, tx_hash FROM canary_tx WHERE run_id = ? AND op = ? AND state = 'confirmed'")
      .get(p.runId, p.op) as { id: number; tx_hash: string | null } | undefined;
    if (done) {
      throw new Error(
        `run ${p.runId} already completed ${p.op} (id ${done.id}, tx ${done.tx_hash}). ` +
          'Launching again would create a second permanent artifact, or revert after paying gas.'
      );
    }

    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO canary_tx (run_id, op, deployment_id, chain_id, to_address, value_wei, calldata,
           token_name, token_symbol, salt, pair_token, splitter_address, state, problems, prepared_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'prepared', '[]', ?, ?)`
      )
      .run(
        p.runId, p.op, p.deploymentId, p.chainId, p.to, p.value.toString(), p.calldata,
        p.tokenName ?? null, p.tokenSymbol ?? null, p.salt ?? null, p.pairToken ?? null,
        p.splitterAddress ?? null, now, now
      );
    return Number(info.lastInsertRowid);
  }

  /** Bound the instant `sendTransaction` returns, before the receipt is awaited. */
  bindHash(id: number, txHash: string): void {
    this.db
      .prepare(
        `UPDATE canary_tx SET tx_hash = ?, state = 'broadcast', updated_at = ?
         WHERE id = ? AND state = 'prepared'`
      )
      .run(txHash, new Date().toISOString(), id);
  }

  /** Conditional on the current state, so a second recovery pass changes nothing. */
  recordReceipt(id: number, receipt: { status: number }): void {
    const next: CanaryState = receipt.status === 1 ? 'receipt_success' : 'receipt_reverted';
    this.db
      .prepare(
        `UPDATE canary_tx SET state = ?, updated_at = ?
         WHERE id = ? AND state IN ('prepared','broadcast')`
      )
      .run(next, new Date().toISOString(), id);
  }

  markConfirmed(id: number, r: { token: string | null }): void {
    this.db
      .prepare(
        `UPDATE canary_tx SET state = 'confirmed', token = ?, updated_at = ?
         WHERE id = ? AND state = 'receipt_success'`
      )
      .run(r.token, new Date().toISOString(), id);
  }

  /**
   * Promotes an incident to confirmed, and only from that state.
   *
   * Separate from `markConfirmed` because the source states differ: a first-pass
   * confirmation comes from `receipt_success`, while recovery starts from an incident that
   * has already been written down. Conditional either way, so a second recovery pass finds
   * nothing to change rather than rewriting a settled row.
   */
  markConfirmedFromIncident(id: number, r: { token: string | null }): void {
    this.db
      .prepare(
        `UPDATE canary_tx SET state = 'confirmed', token = ?, updated_at = ?
         WHERE id = ? AND state = 'confirmed_incident'`
      )
      .run(r.token, new Date().toISOString(), id);
  }

  markIncident(id: number, r: { problems: string[]; token: string | null }): void {
    this.db
      .prepare(
        `UPDATE canary_tx SET state = 'confirmed_incident', token = ?, problems = ?, updated_at = ?
         WHERE id = ? AND state = 'receipt_success'`
      )
      .run(r.token, JSON.stringify(r.problems), new Date().toISOString(), id);
  }

  /**
   * Records the launch fee against this row, exactly once.
   *
   * Conditional on `fee_recorded_wei IS NULL`, so a repeated recovery pass cannot
   * double-count. See canarySpend.ts for why the accounting matters.
   */
  recordFee(id: number, wei: bigint): boolean {
    const info = this.db
      .prepare(`UPDATE canary_tx SET fee_recorded_wei = ?, updated_at = ? WHERE id = ? AND fee_recorded_wei IS NULL`)
      .run(wei.toString(), new Date().toISOString(), id);
    return info.changes > 0;
  }

  /** Everything a person still has to look at. Incidents included, by design. */
  unresolved(): CanaryRow[] {
    const rows = this.db.prepare('SELECT * FROM canary_tx ORDER BY id').all() as any[];
    return rows.map((r) => this.row(r)).filter((r) => !TERMINAL.has(r.state));
  }

  byId(id: number): CanaryRow | null {
    const r = this.db.prepare('SELECT * FROM canary_tx WHERE id = ?').get(id) as any;
    return r ? this.row(r) : null;
  }

  /** Total fee already recorded by this journal, for the daily-cap arithmetic. */
  recordedFeeTotalWei(sinceIso?: string): bigint {
    const rows = (
      sinceIso
        ? this.db.prepare('SELECT fee_recorded_wei FROM canary_tx WHERE fee_recorded_wei IS NOT NULL AND updated_at >= ?').all(sinceIso)
        : this.db.prepare('SELECT fee_recorded_wei FROM canary_tx WHERE fee_recorded_wei IS NOT NULL').all()
    ) as Array<{ fee_recorded_wei: string }>;
    return rows.reduce((acc, r) => acc + BigInt(r.fee_recorded_wei), 0n);
  }

  integrityOk(): boolean {
    return this.db.pragma('integrity_check', { simple: true }) === 'ok';
  }

  close(): void {
    this.db.close();
  }
}
