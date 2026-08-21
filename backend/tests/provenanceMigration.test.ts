import * as fs from 'fs';
import { Db } from '../src/db';

/**
 * Opening a database that predates the provenance columns.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 * -------------------------------
 * The first version of this test was a false green, and it is worth recording as one.
 * It built the fixture with the CURRENT `Db` class -- which creates the new schema --
 * and then tried to remove a column with:
 *
 *     (older as any).raw?.exec?.('ALTER TABLE launch_provenance DROP COLUMN splitter');
 *
 * There is no `raw` property on `Db`. The optional chain evaluated to `undefined`, the
 * ALTER never ran, and the test opened a modern database with modern code and asserted
 * that it worked. It proved nothing about migration and passed every time.
 *
 * Optional chaining on a property nobody verified turns "this step did not happen" into
 * silence, and in a test silence is indistinguishable from success. That is the general
 * lesson; the specific one is that a migration test whose fixture is built by the code
 * under test is not testing a migration.
 *
 * So the fixture below is raw SQL -- the exact pre-migration schema, with rows inserted
 * through it -- and the new code only ever sees it as a file on disk.
 */

const LEGACY_PATH = './data/test-legacy-provenance.sqlite';
const BACKUP_PATH = LEGACY_PATH + '.bak';

/** The schema exactly as it stood before splitter/selector/version were added. */
const LEGACY_SCHEMA = [
  'CREATE TABLE processed_tweets (tweet_id TEXT PRIMARY KEY, processed_at TEXT NOT NULL);',
  `CREATE TABLE launches (
     id TEXT PRIMARY KEY, source_tweet_id TEXT NOT NULL, x_user_id TEXT NOT NULL,
     token_name TEXT, token_symbol TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
     splitter_address TEXT, token_address TEXT, tx_hash TEXT, rejection_reason TEXT,
     fee_wei_paid TEXT);`,
  `CREATE TABLE launch_provenance (
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
     recorded_at TEXT NOT NULL);`,
].join('\n');

const LEGACY_SALT = '0x' + 'ee'.repeat(32);

function makeLegacy(path: string): void {
  if (fs.existsSync(path)) fs.unlinkSync(path);
  const Database = require('better-sqlite3');
  const raw = new Database(path);
  raw.exec(LEGACY_SCHEMA);
  raw
    .prepare(
      `INSERT INTO launch_provenance
         (launch_id, deployment_id, factory, fee_escrow, chain_id, original_deployer,
          pair_token, launch_config_id, salt, economics_digest, curve, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'legacy-1',
      'pons-v2-legacy-7e1',
      '0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8',
      '0xbc39B6502E1a6Ab36E4A5c5026A35F08342A0A9c',
      4663,
      '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa',
      '0x0000000000000000000000000000000000000000',
      '0',
      LEGACY_SALT,
      null,
      null,
      '2026-08-01T00:00:00.000Z'
    );
  raw.close();
}

function columnsOf(path: string): string[] {
  const Database = require('better-sqlite3');
  const raw = new Database(path, { readonly: true });
  const cols = raw
    .prepare('PRAGMA table_info(launch_provenance)')
    .all()
    .map((c: { name: string }) => c.name);
  raw.close();
  return cols;
}

describe('provenance migration against a real pre-migration database', () => {
  beforeEach(() => makeLegacy(LEGACY_PATH));
  afterEach(() => {
    for (const f of [LEGACY_PATH, BACKUP_PATH]) if (fs.existsSync(f)) fs.unlinkSync(f);
  });

  /**
   * Guards the guard.
   *
   * If the fixture ever starts out with the new columns, every test below passes
   * vacuously -- which is precisely how the previous version failed.
   */
  it('the fixture genuinely lacks the new columns', () => {
    const before = columnsOf(LEGACY_PATH);
    expect(before).toContain('deployment_id');
    expect(before).not.toContain('splitter');
    expect(before).not.toContain('launch_selector');
    expect(before).not.toContain('token_params_version');
  });

  it('adds all three columns on first open', () => {
    new Db(LEGACY_PATH).close();
    const after = columnsOf(LEGACY_PATH);
    expect(after).toContain('splitter');
    expect(after).toContain('launch_selector');
    expect(after).toContain('token_params_version');
  });

  it('leaves the existing row intact', () => {
    const db = new Db(LEGACY_PATH);
    try {
      const row = db.getLaunchProvenance('legacy-1');
      expect(row).toBeTruthy();
      expect(row!.deploymentId).toBe('pons-v2-legacy-7e1');
      expect(row!.salt).toBe(LEGACY_SALT);
      expect(row!.chainId).toBe(4663);
    } finally {
      db.close();
    }
  });

  it('reports the new fields as null rather than backfilling a guess', () => {
    // A launch made before this column existed genuinely has no splitter recorded.
    // Writing the current deployment's in would be inventing a fact about money -- and
    // the splitter is the only address that can claim that launch's fees.
    const db = new Db(LEGACY_PATH);
    try {
      const row = db.getLaunchProvenance('legacy-1')!;
      expect(row.splitter ?? null).toBeNull();
      expect(row.launchSelector ?? null).toBeNull();
      expect(row.tokenParamsVersion ?? null).toBeNull();
    } finally {
      db.close();
    }
  });

  it('is idempotent: opening repeatedly neither duplicates a column nor errors', () => {
    for (let i = 0; i < 3; i++) new Db(LEGACY_PATH).close();
    const cols = columnsOf(LEGACY_PATH);
    expect(cols.filter((c) => c === 'splitter')).toHaveLength(1);
    expect(cols.filter((c) => c === 'launch_selector')).toHaveLength(1);
    expect(cols.filter((c) => c === 'token_params_version')).toHaveLength(1);
  });

  it('still writes and reads a new row on the migrated file', () => {
    const db = new Db(LEGACY_PATH);
    try {
      db.claimTweetForProcessing('tw-new');
      db.insertLaunch({
        id: 'new-1', sourceTweetId: 'tw-new', xUserId: 'u1',
        tokenName: 'N', tokenSymbol: 'NNN', status: 'pending', createdAt: new Date().toISOString(),
        splitterAddress: null, tokenAddress: null, txHash: null, rejectionReason: null, feeWeiPaid: null,
      } as never);
      db.recordLaunchProvenance('new-1', {
        deploymentId: 'pons-v2-current-7ed',
        factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
        feeEscrow: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
        chainId: 4663,
        originalDeployer: '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa',
        pairToken: '0x0000000000000000000000000000000000000000',
        launchConfigId: '0',
        salt: '0x' + '11'.repeat(32),
        economicsDigest: null,
        curve: null,
        splitter: '0x2222222222222222222222222222222222222222',
        launchSelector: '0xf35abbcf',
        tokenParamsVersion: 'v2-salt',
      });
      expect(db.getLaunchProvenance('new-1')!.splitter).toBe(
        '0x2222222222222222222222222222222222222222'
      );
      // And the old row is still there beside it.
      expect(db.getLaunchProvenance('legacy-1')!.deploymentId).toBe('pons-v2-legacy-7e1');
    } finally {
      db.close();
    }
  });

  /**
   * The rollback story, as a test rather than a paragraph.
   *
   * The migration is additive and in-place, so there is nothing to undo -- recovering
   * the previous shape means restoring a file copied beforehand. An operator needs to
   * know that the copy is the plan, because "roll back the migration" has no meaning
   * here and discovering that mid-incident is the wrong time.
   */
  it('a copy taken before opening restores the legacy schema exactly', () => {
    fs.copyFileSync(LEGACY_PATH, BACKUP_PATH);

    new Db(LEGACY_PATH).close();
    expect(columnsOf(LEGACY_PATH)).toContain('splitter');

    fs.copyFileSync(BACKUP_PATH, LEGACY_PATH);
    expect(columnsOf(LEGACY_PATH)).not.toContain('splitter');

    // And the restored file still holds its row.
    const Database = require('better-sqlite3');
    const raw = new Database(LEGACY_PATH, { readonly: true });
    try {
      expect(raw.prepare('SELECT COUNT(*) c FROM launch_provenance').get().c).toBe(1);
    } finally {
      raw.close();
    }
  });

  /**
   * What the OLD binary does with a migrated file -- the question an operator actually
   * has during a rollback, and the one nothing answered.
   *
   * SQLite ignores columns a statement does not name, and every pre-migration statement
   * named its columns explicitly. So old code reads a migrated database without noticing
   * the additions. Asserted by running a pre-migration query shape against the new file
   * rather than reasoning about it.
   */
  it('pre-migration queries still work against a migrated database', () => {
    new Db(LEGACY_PATH).close();

    const Database = require('better-sqlite3');
    const raw = new Database(LEGACY_PATH, { readonly: true });
    try {
      const row = raw
        .prepare(
          `SELECT launch_id, deployment_id, factory, fee_escrow, chain_id,
                  original_deployer, pair_token, launch_config_id, salt,
                  economics_digest, curve, recorded_at
             FROM launch_provenance WHERE launch_id = ?`
        )
        .get('legacy-1');
      expect(row.deployment_id).toBe('pons-v2-legacy-7e1');
      expect(row.salt).toBe(LEGACY_SALT);
    } finally {
      raw.close();
    }
  });
});
