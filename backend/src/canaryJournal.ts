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
  /** Immutable. Written once with the fee; never moved by a later update. */
  feeRecordedAt: string | null;
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

  /**
   * @param opts.allowEphemeral bypasses the durability check. Tests only.
   *
   * It exists because the guard below caught this project's own test suite: on Linux
   * `os.tmpdir()` IS `/tmp`, so every journal test failed in CI while passing on Windows.
   * That is the guard working, not a reason to remove it -- a journal under /tmp on an
   * operator's machine is very nearly as bad as one inside the container.
   *
   * Named rather than inferred. A check that quietly relaxed itself when it detected a
   * test runner would relax itself in production the first time something looked like
   * one, and nothing would say so. `tests/canaryScriptAuthority.test.ts` asserts the
   * canary script never passes it.
   */
  constructor(private file: string, opts: { allowEphemeral?: boolean } = {}) {
    const resolved = path.resolve(file);
    // Both the raw string and the resolved one. `path.resolve` prepends a drive letter on
    // Windows, so an operator who typed a container path like /app/canary.sqlite would
    // have it silently rewritten to C:/app/canary.sqlite and sail past a check that only
    // inspected the resolved form.
    const candidates = [file, resolved].map((c) => c.replace(/\\/g, '/'));
    const isEphemeral = (c: string) => EPHEMERAL_PREFIXES.some((e) => c === e || c.startsWith(e + '/'));
    if (!opts.allowEphemeral && candidates.some(isEphemeral)) {
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
        fee_recorded_at TEXT,
        prepared_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS canary_tx_run ON canary_tx(run_id, op);
    `);

    /**
     * Migration for journals created before the fee clock existed.
     *
     * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so an
     * operator's journal from an earlier run had no `fee_recorded_at` and every read of it
     * failed with "no such column" -- which surfaced, correctly, as the canary refusing to
     * start at all.
     *
     * Old rows keep NULL. That is honest: their fee was recorded at a time nothing wrote
     * down, and inventing one would place real money in a window it may not belong to.
     * `recordedFeeTotalWei` handles that explicitly rather than letting NULL silently drop
     * out of a comparison.
     */
    const columns = (this.db.pragma('table_info(canary_tx)') as Array<{ name: string }>).map((c) => c.name);
    if (!columns.includes('fee_recorded_at')) {
      this.db.exec('ALTER TABLE canary_tx ADD COLUMN fee_recorded_at TEXT');
    }
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
      feeRecordedAt: r.fee_recorded_at ?? null,
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

  /**
   * Records a receipt, and refuses to invent one.
   *
   * `status: null` means no receipt was obtained -- `sent.wait()` can return null, and an
   * RPC can simply fail to answer. That is NOT a revert. The first version of this method
   * took `{ status: number }` and the caller passed `receipt ? status : 0`, so a missing
   * receipt became terminal `receipt_reverted`, which dropped the row out of
   * `unresolved()`, which unblocked the next run -- reintroducing, one line below the
   * journal call, the exact failure the journal exists to prevent.
   *
   * A launch may have landed while the RPC blinked. Absence of evidence is not evidence of
   * absence, and this is the place that distinction has to be mechanical.
   */
  recordReceipt(id: number, receipt: { status: number | null }): void {
    if (receipt.status === null) return; // still `broadcast`: hash held, still blocking.
    const next: CanaryState = receipt.status === 1 ? 'receipt_success' : 'receipt_reverted';
    const info = this.db
      .prepare(
        `UPDATE canary_tx SET state = ?, updated_at = ?
         WHERE id = ? AND state IN ('prepared','broadcast')`
      )
      .run(next, new Date().toISOString(), id);
    if (info.changes === 0) {
      const row = this.byId(id);
      // Terminal rows are legitimately unchanged on a repeat pass; anything else is a
      // transition that silently did not happen, which used to continue as if it had.
      if (!row || !['receipt_success', 'receipt_reverted', 'confirmed', 'confirmed_incident'].includes(row.state)) {
        throw new Error(`recordReceipt(${id}) changed no row; state is ${row?.state ?? 'missing'}`);
      }
    }
  }

  /** Records the reason a row is still open, so it survives the terminal it was printed on. */
  recordProblems(id: number, problems: string[]): void {
    this.db
      .prepare('UPDATE canary_tx SET problems = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(problems), new Date().toISOString(), id);
  }

  /**
   * Confirms from ANY non-terminal state.
   *
   * Recovery can arrive at a row sitting in prepared, broadcast, receipt_success or
   * confirmed_incident. The narrower markConfirmed only accepted receipt_success, which is
   * why a crash at any other point wedged the run permanently. Still conditional -- a row
   * already terminal is left alone, so repeated passes change nothing.
   */
  markConfirmedAnyState(id: number, r: { token: string | null; splitterAddress?: string }): void {
    this.db
      .prepare(
        `UPDATE canary_tx SET state = 'confirmed', token = COALESCE(?, token),
           splitter_address = COALESCE(?, splitter_address), problems = '[]', updated_at = ?
         WHERE id = ? AND state NOT IN ('confirmed','receipt_reverted')`
      )
      .run(r.token, r.splitterAddress ?? null, new Date().toISOString(), id);
  }

  /** As above, for the landed-but-unreconciled outcome. */
  markIncidentAnyState(id: number, r: { problems: string[]; token: string | null }): void {
    this.db
      .prepare(
        `UPDATE canary_tx SET state = 'confirmed_incident', token = COALESCE(?, token),
           problems = ?, updated_at = ?
         WHERE id = ? AND state NOT IN ('confirmed','receipt_reverted')`
      )
      .run(r.token, JSON.stringify(r.problems), new Date().toISOString(), id);
  }

  markConfirmed(id: number, r: { token: string | null; splitterAddress?: string }): void {
    this.db
      .prepare(
        `UPDATE canary_tx SET state = 'confirmed', token = ?,
           splitter_address = COALESCE(?, splitter_address), updated_at = ?
         WHERE id = ? AND state = 'receipt_success'`
      )
      .run(r.token, r.splitterAddress ?? null, new Date().toISOString(), id);
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
    const row = this.byId(id);
    if (!row) throw new Error(`recordFee(${id}): no such row`);
    if (row.op !== 'token_launch') {
      throw new Error(`recordFee(${id}): only a token_launch consumes the launch fee, not ${row.op}`);
    }
    // A landed launch spent the fee whether or not it reconciled. Anything else did not:
    // an ambiguous receipt has not been shown to have landed, and a revert consumed gas.
    if (!['receipt_success', 'confirmed', 'confirmed_incident'].includes(row.state)) {
      throw new Error(`recordFee(${id}): state ${row.state} has not been shown to have landed`);
    }
    if (wei !== row.value) {
      throw new Error(`recordFee(${id}): ${wei} does not match the journalled value ${row.value}`);
    }
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE canary_tx SET fee_recorded_wei = ?, fee_recorded_at = ?, updated_at = ?
         WHERE id = ? AND fee_recorded_wei IS NULL`
      )
      .run(wei.toString(), now, now, id);
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

  /**
   * Total fee recorded, filtered on the IMMUTABLE fee timestamp.
   *
   * It filtered on `updated_at`, which every later transition rewrites. Recovering a
   * week-old incident therefore dragged its fee back into the current 24-hour window and
   * could refuse launches the cap actually permits. Fails safe financially, but the
   * accounting was not canonical, and an accounting clock that moves is not a clock.
   */
  recordedFeeTotalWei(sinceIso?: string): bigint {
    const rows = (
      sinceIso
        ? // NULL fee_recorded_at means a row written before the fee clock existed. Counted
          // IN, deliberately: it overstates the window and can only refuse a launch the cap
          // would allow. Excluding it would understate real spending, which is the direction
          // that costs money.
          this.db
            .prepare(
              `SELECT fee_recorded_wei FROM canary_tx
               WHERE fee_recorded_wei IS NOT NULL
                 AND (fee_recorded_at IS NULL OR fee_recorded_at >= ?)`
            )
            .all(sinceIso)
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
