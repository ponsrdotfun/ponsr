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
  /**
   * Signed, not yet known to be broadcast.
   *
   * The state that closes the crash window. `prepared` says an intent existed; `signed` says
   * a specific transaction exists, by canonical hash, with its exact bytes on disk. A process
   * that dies between here and `broadcast` is recoverable by asking the chain about a hash
   * this journal already holds, rather than by searching an explorer and guessing.
   */
  | 'signed'
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

/**
 * The identity of one specific signed transaction.
 *
 * Every field is derived from the signed bytes themselves, never from a provider's account of
 * them. `rawTx` is broadcast-ready authority: anyone holding it can put this transaction on
 * chain. It belongs in the operator's journal and nowhere else -- not in logs, reports,
 * Telegram messages or completion reports.
 */
export interface SignedIdentity {
  sender: string;
  nonce: number;
  chainId: number;
  txHash: string;
  rawTx: string;
}

export interface CanaryRow extends PreparedCanary {
  id: number;
  state: CanaryState;
  txHash: string | null;
  sender: string | null;
  nonce: number | null;
  /** Broadcast-ready authority. Never log, print or transmit this. */
  rawTx: string | null;
  signedAt: string | null;
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

/**
 * The journal holds raw signed transactions. Anyone who can read it can broadcast them.
 *
 * That is not a theoretical concern about a database of metadata: `raw_tx` is a complete,
 * already-signed transaction. No key is needed to send it, from any machine. A journal
 * created under the ordinary umask is mode 0644 -- world readable -- so every local account
 * could spend the treasury's launch fee and create permanent artifacts in its name.
 *
 * SQLite in WAL mode writes two sidecars, `-wal` and `-shm`, and pages containing raw
 * transactions live in the WAL before they are checkpointed. Securing only the main database
 * would leave the newest rows -- the ones most likely to be unresolved and therefore most
 * useful to an attacker -- readable beside it.
 *
 * Fails closed. If owner-only access cannot be established and verified, the journal refuses
 * to open, because the alternative is writing broadcastable authority into a file this code
 * has just discovered it cannot protect.
 */
/**
 * One ACE, parsed out of an SDDL string.
 *
 * SDDL is the locale-independent form: trustees appear as SIDs, or as two-letter well-known
 * abbreviations like `SY` and `BA`. Neither is translated, which is the whole reason for
 * reading it instead of `icacls`'s display output.
 */
export interface WindowsAce {
  /** The raw ACE body, e.g. `A;ID;FA;;;SY`. */
  raw: string;
  /** ACE flags field: `ID` marks an inherited entry. */
  flags: string;
  /** SID or well-known abbreviation the ACE applies to. */
  trustee: string;
  inherited: boolean;
}

/**
 * Extracts the DACL's ACEs from an SDDL security descriptor.
 *
 * Deliberately ignores `O:` and `G:` (owner and group) and stops at `S:` (the SACL), so only
 * entries that actually grant or deny access are enumerated.
 */
export function parseDaclAces(sddl: string): WindowsAce[] {
  const dacl = sddl.indexOf('D:');
  if (dacl < 0) return [];
  let section = sddl.slice(dacl + 2);
  const sacl = section.indexOf('S:');
  if (sacl >= 0) section = section.slice(0, sacl);
  const aces: WindowsAce[] = [];
  for (const m of section.matchAll(/\(([^)]*)\)/g)) {
    const body = m[1];
    const parts = body.split(';');
    aces.push({
      raw: body,
      flags: parts[1] ?? '',
      trustee: (parts[5] ?? '').trim(),
      inherited: (parts[1] ?? '').toUpperCase().includes('ID'),
    });
  }
  return aces;
}

/**
 * The decision itself: does this DACL grant access to anyone but the given SID?
 *
 * Separated from the process plumbing so it can be tested directly, including against
 * descriptors that are awkward to produce on a real filesystem.
 *
 * The entries handed to it must already be RESOLVED TO SIDS. That is not a detail: Windows
 * renders well-known accounts in SDDL as two-letter abbreviations, and on the GitHub runner
 * the account we had just granted came back as `LA` -- the local Administrator, whose SID ends
 * in -500. Comparing spellings failed a file that was correctly locked down. Comparing SIDs
 * cannot, because a SID has one spelling.
 */
export function assertOwnerOnlyDacl(label: string, aces: WindowsAce[], sid: string): void {
  if (aces.length === 0) {
    throw new Error(
      `${label} reports no access-control entries at all, which cannot be verified as ` +
        'owner-only. Refusing to store raw signed transactions.'
    );
  }
  const foreign = aces.filter((a) => a.trustee.toUpperCase() !== sid.toUpperCase());
  if (foreign.length > 0) {
    throw new Error(
      `${label} still grants access to ${foreign.map((a) => a.trustee).join(', ')} after being ` +
        `restricted to ${sid}. Refusing to store raw signed transactions.`
    );
  }
  const inherited = aces.filter((a) => a.inherited);
  if (inherited.length > 0) {
    throw new Error(
      `${label} still carries inherited access-control entries, so the parent directory can ` +
        're-grant access. Refusing to store raw signed transactions.'
    );
  }
}

/**
 * Replaces each file's DACL with exactly one entry: full control for the current user's SID.
 *
 * WHY NOT `icacls /inheritance:r /grant:r`. That was the previous approach and it left
 * explicit foreign ACEs in place -- `/grant:r` replaces only the entry for the named user, and
 * `/inheritance:r` removes inherited entries, neither of which touches an explicit ACE somebody
 * else added. Measured on this machine: an ACE granting `S-1-5-18` FULL control survived the
 * call and the verification step accepted it, because that step matched localized DISPLAY
 * NAMES -- `Everyone`, `BUILTIN\Users` -- and SYSTEM was not in the list. On a non-English
 * Windows even those names do not match, so the check would have passed over anything at all.
 *
 * Setting `D:P(A;;FA;;;<SID>)` is not a repair of the existing ACL; it is a replacement.
 * `P` marks it protected, so the parent directory cannot re-grant through inheritance, and no
 * entry survives that was not written here.
 *
 * The result is then read back and enumerated BY SID. Anything other than the current user --
 * any principal, inherited or explicit, known or unknown -- fails closed.
 */
function secureWindowsFiles(targets: string[]): void {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const present = targets.filter((t) => fs.existsSync(t));
  if (present.length === 0) return;

  /**
   * The identity comes from the process token, not from %USERNAME%.
   *
   * The environment variable is attacker-influenced and, on this machine, `whoami` resolves to
   * a Git Bash shim that does not understand `/user` at all. `WindowsIdentity.GetCurrent()` is
   * the account the file operations actually run as, which is the only account whose access
   * means anything here.
   */
  const env: NodeJS.ProcessEnv = { ...process.env };
  present.forEach((t, i) => {
    env[`PONSR_ACL_${i}`] = t;
  });

  /**
   * .NET statics, not the Get-Acl / Set-Acl cmdlets.
   *
   * Those live in Microsoft.PowerShell.Security, and on the GitHub Windows runner `Set-Acl`
   * failed to autoload at all -- `CouldNotAutoloadMatchingModule` -- so every journal open
   * refused there. `System.IO.File.SetAccessControl` and `GetAccessControl` are part of the
   * framework itself and need no module, which makes the behaviour the same on a developer
   * machine and on a bare runner.
   *
   * `AccessControlSections.Access` asks for the DACL alone, so the returned descriptor is not
   * padded with the owner and group fields the check does not use.
   */
  const script = [
    "$ErrorActionPreference='Stop'",
    '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$sec=[System.Security.AccessControl.AccessControlSections]::Access',
    '$sidType=[System.Security.Principal.SecurityIdentifier]',
    `foreach($i in 0..${present.length - 1}){`,
    "  $t=[Environment]::GetEnvironmentVariable('PONSR_ACL_'+$i)",
    '  if($t -and [System.IO.File]::Exists($t)){',
    '    $acl=New-Object System.Security.AccessControl.FileSecurity',
    "    $acl.SetSecurityDescriptorSddlForm('D:P(A;;FA;;;'+$sid+')', $sec)",
    '    [System.IO.File]::SetAccessControl($t, $acl)',
    '    $now=[System.IO.File]::GetAccessControl($t, $sec)',
    // Every rule, explicit and inherited, with the trustee TRANSLATED TO A SID rather than
    // rendered as a name or an SDDL abbreviation.
    '    foreach($r in $now.GetAccessRules($true, $true, $sidType)){',
    "      Write-Output ('ACE|'+$t+'|'+$r.IdentityReference.Value+'|'+$r.IsInherited+'|'+$r.AccessControlType)",
    '    }',
    "    Write-Output ('END|'+$t)",
    '  }',
    '}',
    "Write-Output ('SID|'+$sid)",
  ].join('; ');

  let out: string;
  try {
    out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', stdio: 'pipe', env }
    );
  } catch (e) {
    throw new Error(
      'failed to establish owner-only access to the canary journal on Windows: ' +
        `${(e as Error).message}. It holds broadcast-ready transactions and will not be opened ` +
        'without it.'
    );
  }

  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sid = lines.find((l) => l.startsWith('SID|'))?.slice(4);
  if (!sid || !/^S-1-[\d-]+$/.test(sid)) {
    throw new Error(
      'could not determine the current Windows account SID, so owner-only access to the ' +
        'canary journal cannot be verified. Refusing to store raw signed transactions.'
    );
  }

  const byFile = new Map<string, WindowsAce[]>();
  for (const line of lines) {
    if (line.startsWith('END|')) {
      const file = line.slice(4);
      if (!byFile.has(file)) byFile.set(file, []);
      continue;
    }
    if (!line.startsWith('ACE|')) continue;
    const [, file, trustee, inherited, kind] = line.split('|');
    const list = byFile.get(file) ?? [];
    list.push({
      raw: `${kind};${inherited};${trustee}`,
      flags: inherited === 'True' ? 'ID' : '',
      trustee: (trustee ?? '').trim(),
      inherited: inherited === 'True',
    });
    byFile.set(file, list);
  }

  const seen = new Set<string>();
  for (const [file, aces] of byFile) {
    seen.add(file);
    assertOwnerOnlyDacl(path.basename(file), aces, sid);
  }

  const missed = present.filter((t) => !seen.has(t));
  if (missed.length > 0) {
    throw new Error(
      `no access-control result was returned for ${missed
        .map((m) => path.basename(m))
        .join(', ')}. Refusing to store raw signed transactions on unverified files.`
    );
  }
}

function secureJournalFiles(dbPath: string): void {
  const targets = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];

  if (process.platform === 'win32') {
    secureWindowsFiles(targets);
    return;
  }

  for (const t of targets) {
    if (!fs.existsSync(t)) continue;
    fs.chmodSync(t, 0o600);
    const mode = fs.statSync(t).mode & 0o777;
    if (mode & 0o077) {
      throw new Error(
        `${path.basename(t)} is mode ${mode.toString(8)} after being restricted to 0600. The ` +
          'canary journal holds broadcast-ready transactions and will not be opened while it ' +
          'is readable by anyone but its owner.'
      );
    }
  }
}

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
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    this.db = new Database(resolved);
    secureJournalFiles(resolved);
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
      /**
       * At most ONE live row per (run, operation), enforced by the schema.
       *
       * The checks in prepare() and the INSERT were separate statements, so two operator
       * processes could both observe an empty unresolved set, both insert, and both go on
       * to broadcast something irreversible. A transaction narrows that window; a partial
       * unique index closes it, because the second INSERT cannot exist regardless of who
       * read what and when.
       *
       * Partial, on non-terminal states only: a run legitimately accumulates settled rows
       * over its lifetime, and a completed launch must not block the next operation.
       */
      CREATE UNIQUE INDEX IF NOT EXISTS canary_tx_one_live
        ON canary_tx(run_id, op)
        WHERE state NOT IN ('confirmed','receipt_reverted');
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

    /**
     * Migration for journals written before signature identity existed.
     *
     * Backward compatible by construction: old rows get NULL in all four columns, which reads
     * as "this row was never signed through the identity path". They cannot be resumed by
     * hash because they never had one -- that is a true statement about them, and the
     * recovery path says so rather than inventing an identity for a transaction whose bytes
     * nobody kept.
     */
    for (const [name, type] of [
      ['sender', 'TEXT'],
      ['nonce', 'INTEGER'],
      ['raw_tx', 'TEXT'],
      ['signed_at', 'TEXT'],
    ] as const) {
      if (!columns.includes(name)) {
        this.db.exec(`ALTER TABLE canary_tx ADD COLUMN ${name} ${type}`);
      }
    }

    /**
     * At most one row per (sender, nonce) that is not settled.
     *
     * A reserved nonce is a scarce, exclusive resource: two signed transactions sharing one
     * nonce means at most one can ever land, and the journal would be describing a race it
     * cannot see the end of. The partial index makes the second signature impossible to
     * record rather than merely discouraged.
     */
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS canary_tx_one_nonce
        ON canary_tx(sender, nonce)
        WHERE sender IS NOT NULL AND state NOT IN ('confirmed','receipt_reverted');
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
      sender: r.sender ?? null,
      nonce: r.nonce === null || r.nonce === undefined ? null : Number(r.nonce),
      rawTx: r.raw_tx ?? null,
      signedAt: r.signed_at ?? null,
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
    /**
     * BEGIN IMMEDIATE takes the write lock before the first read.
     *
     * Without it the open/completed checks and the INSERT are separate statements, and two
     * concurrent operator processes can interleave between them: both see nothing open,
     * both insert, both reach an irreversible broadcast. The partial unique index makes the
     * second INSERT impossible even so; this makes it fail early and legibly rather than as
     * a constraint violation halfway through.
     */
    return this.db.transaction(() => this.prepareLocked(p)).immediate();
  }

  private prepareLocked(p: PreparedCanary): number {
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

  /**
   * The pre-2B transition: straight from `prepared` to `broadcast`, hash supplied afterwards.
   *
   * LEGACY. It models journals written before signature identity existed, and exists so the
   * migration and back-compatibility paths can be tested against rows that genuinely lack a
   * sender, nonce and raw transaction. It must never be used by an executable canary path:
   * a row that reaches `broadcast` this way has no bytes to rebroadcast and no nonce to
   * reconcile, which is exactly the hole `recordSigned` closes.
   *
   * `tests/canaryScriptAuthority.test.ts` asserts no script calls it.
   */
  bindHashLegacy(id: number, txHash: string): void {
    this.db
      .prepare(
        `UPDATE canary_tx SET tx_hash = ?, state = 'broadcast', updated_at = ?
         WHERE id = ? AND state = 'prepared'`
      )
      .run(txHash, new Date().toISOString(), id);
  }

  /**
   * Persists the identity of a signed transaction, BEFORE any broadcast is reachable.
   *
   * This is the write that closes 2B. Everything it stores is derived from the signed bytes
   * by the caller -- the hash is recomputed locally from `rawTx`, never accepted from a
   * provider -- so after this returns, the exact transaction is identifiable whatever happens
   * next: mid-broadcast crash, timeout, disconnect, or a machine that never comes back.
   *
   * Immutable once written. A second call for the same row throws rather than overwriting,
   * because a changed hash or nonce would silently redefine which transaction the journal is
   * talking about, and every later reconciliation would be about a different object.
   */
  recordSigned(id: number, identity: SignedIdentity): void {
    /**
     * Re-secured at the moment broadcastable authority enters the file.
     *
     * SQLite creates `-wal` and `-shm` lazily, on first write, so the pass at open time can
     * run before they exist. This is the one write that puts a complete signed transaction on
     * disk, which makes it the right place to insist the sidecars are locked down too. It
     * throws rather than proceeding: writing raw bytes into a world-readable WAL is the
     * failure being prevented.
     */
    secureJournalFiles(path.resolve(this.file));

    const row = this.byId(id);
    if (!row) throw new Error(`canary row ${id} does not exist`);
    if (row.state !== 'prepared') {
      throw new Error(
        `canary row ${id} is ${row.state}, not prepared -- refusing to sign over an existing ` +
          'signature identity. A row is signed exactly once.'
      );
    }
    if (identity.chainId !== row.chainId) {
      throw new Error(
        `signed chainId ${identity.chainId} does not match journalled ${row.chainId} for row ${id}`
      );
    }
    const info = this.db
      .prepare(
        `UPDATE canary_tx
           SET state = 'signed', tx_hash = ?, sender = ?, nonce = ?, raw_tx = ?, signed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'prepared' AND tx_hash IS NULL`
      )
      .run(
        identity.txHash,
        identity.sender,
        identity.nonce,
        identity.rawTx,
        new Date().toISOString(),
        new Date().toISOString(),
        id
      );
    if (info.changes === 0) {
      throw new Error(`canary row ${id} could not be moved to signed -- it already carries an identity`);
    }
  }

  /**
   * Has this sender already signed something at this nonce, in ANY state?
   *
   * Deliberately not limited to live rows. A nonce consumed by a transaction that already
   * landed is gone forever: signing a second transaction at it produces bytes that can never
   * be mined, and the operator would be left waiting on a hash with no future. The partial
   * unique index cannot express this, because it excludes settled rows on purpose -- so the
   * check lives here, where "spent" and "live" can both be seen.
   */
  nonceAlreadyUsed(sender: string, nonce: number): CanaryRow | null {
    const r = this.db
      .prepare('SELECT * FROM canary_tx WHERE lower(sender) = lower(?) AND nonce = ?')
      .get(sender, nonce) as any;
    return r ? this.row(r) : null;
  }

  /**
   * Marks that the exact persisted bytes were handed to a broadcaster.
   *
   * Carries no hash argument on purpose. The hash was fixed at signing; accepting one here
   * would let a provider's answer redefine the row, which is the failure `recordSigned`
   * exists to prevent. Broadcasting is a fact ABOUT an already-identified transaction, not
   * the moment it acquires an identity.
   */
  markBroadcast(id: number): void {
    this.db
      .prepare(
        `UPDATE canary_tx SET state = 'broadcast', updated_at = ?
         WHERE id = ? AND state = 'signed'`
      )
      .run(new Date().toISOString(), id);
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
         WHERE id = ? AND state IN ('prepared','signed','broadcast')`
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
