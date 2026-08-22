import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  createBackup,
  loadAndValidateManifest,
  rehearseRestore,
  restoreBackup,
} from '../src/maintenanceBackup';

const SCHEMA = 'ponsr.sqlite-maintenance';

function makeDb(file: string, count = 1): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE processed_tweets (tweet_id TEXT PRIMARY KEY);
    CREATE TABLE launches (
      id TEXT PRIMARY KEY,
      source_tweet_id TEXT NOT NULL REFERENCES processed_tweets(tweet_id)
    );
  `);
  const insert = db.transaction((n: number) => {
    for (let i = 0; i < n; i += 1) {
      db.prepare('INSERT INTO processed_tweets VALUES (?)').run(`tweet-${i}`);
      db.prepare('INSERT INTO launches VALUES (?, ?)').run(`launch-${i}`, `tweet-${i}`);
    }
  });
  insert(count);
  return db;
}

/** The OS minimum, and deliberately nothing the maintenance CLI itself reads. */
const BARE_ENV: NodeJS.ProcessEnv =
  process.platform === 'win32'
    ? {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        COMSPEC: process.env.COMSPEC,
        TEMP: process.env.TEMP,
      }
    : {};

/**
 * How to actually start `tsx` from a test.
 *
 * Spawning `node_modules/.bin/tsx` failed on Windows twice over. The extensionless file is
 * a shell script Windows cannot execute, giving ENOENT; and since the fix for
 * CVE-2024-27980, Node refuses to spawn the `.cmd` shim at all without `shell: true`,
 * giving EINVAL. Either way `stdout` and `stderr` came back undefined, so the assertions
 * below reported "received value must be a string" instead of anything about the CLI.
 *
 * The CLI was correct throughout -- run by hand it exits 2 and names `--offline`. Only the
 * way the test launched it was wrong, which is the failure mode worth naming: a test that
 * cannot start the thing it tests reports a defect in the wrong place.
 *
 * So spawn the real JS entrypoint under this same Node binary. No shim, no shell, and
 * therefore no argument-quoting hazard on a path that already contains a space.
 */
const TSX = path.join(__dirname, '../node_modules/tsx/dist/cli.mjs');
const runCli = (args: string[]) =>
  spawnSync(process.execPath, [TSX, ...args], {
    encoding: 'utf8',
    env: BARE_ENV,
    cwd: path.join(__dirname, '..'),
  });

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-maintenance-'));
  return {
    dir,
    source: path.join(dir, 'bot.sqlite'),
    backup: path.join(dir, 'backups', 'bot.sqlite.backup'),
    manifest: path.join(dir, 'backups', 'manifest.json'),
  };
}

describe('keyless maintenance CLI', () => {
  it('is present in the production build and package script uses no development runtime', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    expect(packageJson.scripts['maintenance:db']).toBe('node dist/maintenanceBackup.js');
  });

  it('backs up and rehearses using explicit arguments without environment or network', () => {
    const p = tempPaths();
    makeDb(p.source, 4).close();
    const cli = path.join(__dirname, '../scripts/maintenance-db.ts');
    const backup = runCli([cli, 'backup', '--source', p.source, '--backup', p.backup, '--manifest', p.manifest]);
    expect(backup.status).toBe(0);
    expect(JSON.parse(backup.stdout)).toEqual(expect.objectContaining({ schema: SCHEMA, backupPath: path.resolve(p.backup) }));

    const rehearsal = path.join(p.dir, 'rehearsal.sqlite');
    const rehearse = runCli([cli, 'rehearse', '--manifest', p.manifest, '--destination', rehearsal, '--offline']);
    expect(rehearse.status).toBe(0);
    expect(JSON.parse(rehearse.stdout)).toEqual(expect.objectContaining({ launchCount: 4, integrity: 'ok' }));
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it('fails closed when restore omits --offline', () => {
    const p = tempPaths();
    makeDb(p.source).close();
    const cli = path.join(__dirname, '../scripts/maintenance-db.ts');
    const result = runCli([cli, 'restore', '--manifest', p.manifest, '--destination', p.source]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--offline/);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });
});

describe('SQLite maintenance backup', () => {
  it('uses an online WAL-consistent snapshot while a writer continues committing', async () => {
    const p = tempPaths();
    const writer = makeDb(p.source, 20);
    let writes = 20;
    const timer = setInterval(() => {
      writer.prepare('INSERT INTO processed_tweets VALUES (?)').run(`tweet-${writes}`);
      writer.prepare('INSERT INTO launches VALUES (?, ?)').run(`launch-${writes}`, `tweet-${writes}`);
      writes += 1;
    }, 1);

    try {
      const manifest = await createBackup({
        sourcePath: p.source,
        backupPath: p.backup,
        manifestPath: p.manifest,
      });
      expect(writes).toBeGreaterThan(20);
      expect(manifest).toEqual(expect.objectContaining({
        schema: SCHEMA,
        version: 1,
        sourcePath: path.resolve(p.source),
        backupPath: path.resolve(p.backup),
      }));
      expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.size).toBeGreaterThan(0);
      expect(Number.isInteger(manifest.mode)).toBe(true);
      expect(Number.isInteger(manifest.uid)).toBe(true);
      expect(Number.isInteger(manifest.gid)).toBe(true);
      expect(new Date(manifest.timestamp).toISOString()).toBe(manifest.timestamp);
      expect(JSON.parse(fs.readFileSync(p.manifest, 'utf8'))).toEqual(manifest);

      const snapshot = new Database(p.backup, { readonly: true });
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(snapshot.pragma('foreign_key_check')).toEqual([]);
      const count = (snapshot.prepare('SELECT COUNT(*) AS count FROM launches').get() as any).count;
      expect(count).toBeGreaterThanOrEqual(20);
      expect(count).toBeLessThanOrEqual(writes);
      snapshot.close();
    } finally {
      clearInterval(timer);
      writer.close();
      fs.rmSync(p.dir, { recursive: true, force: true });
    }
  });
});

describe('manifest validation and offline restore', () => {
  it('rejects malformed, stale, wrong-path, and artifact-mismatch manifests', async () => {
    const p = tempPaths();
    const db = makeDb(p.source);
    db.close();
    const manifest = await createBackup({ sourcePath: p.source, backupPath: p.backup, manifestPath: p.manifest });

    const malformed = { ...manifest, surprise: true };
    fs.writeFileSync(p.manifest, JSON.stringify(malformed));
    expect(() => loadAndValidateManifest(p.manifest, { expectedSourcePath: p.source })).toThrow(/fields/i);

    fs.writeFileSync(p.manifest, JSON.stringify({ ...manifest, timestamp: '2000-01-01T00:00:00.000Z' }));
    expect(() => loadAndValidateManifest(p.manifest, { expectedSourcePath: p.source, maxAgeMs: 1000 })).toThrow(/stale/i);

    fs.writeFileSync(p.manifest, JSON.stringify(manifest));
    expect(() => loadAndValidateManifest(p.manifest, { expectedSourcePath: path.join(p.dir, 'other.sqlite') })).toThrow(/source path/i);

    fs.appendFileSync(p.backup, 'tamper');
    expect(() => loadAndValidateManifest(p.manifest, { expectedSourcePath: p.source })).toThrow(/size|checksum/i);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it('requires an explicit offline acknowledgement for rehearsal and restore', async () => {
    const p = tempPaths();
    makeDb(p.source).close();
    await createBackup({ sourcePath: p.source, backupPath: p.backup, manifestPath: p.manifest });
    await expect(rehearseRestore({ manifestPath: p.manifest, destinationPath: path.join(p.dir, 'rehearsal.sqlite'), offline: false })).rejects.toThrow(/offline/i);
    await expect(restoreBackup({ manifestPath: p.manifest, destinationPath: p.source, offline: false })).rejects.toThrow(/offline/i);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it('rehearses validation and reports the application launch count without touching live data', async () => {
    const p = tempPaths();
    makeDb(p.source, 3).close();
    await createBackup({ sourcePath: p.source, backupPath: p.backup, manifestPath: p.manifest });
    const rehearsal = path.join(p.dir, 'rehearsal.sqlite');
    const result = await rehearseRestore({ manifestPath: p.manifest, destinationPath: rehearsal, offline: true });
    expect(result).toEqual(expect.objectContaining({ integrity: 'ok', foreignKeyViolations: 0, launchCount: 3 }));
    expect(fs.existsSync(p.source)).toBe(true);
    expect(fs.existsSync(rehearsal)).toBe(true);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it('preserves the current database and WAL sidecars before restoring and validates the result', async () => {
    const p = tempPaths();
    makeDb(p.source, 2).close();
    await createBackup({ sourcePath: p.source, backupPath: p.backup, manifestPath: p.manifest });

    const current = new Database(p.source);
    current.pragma('journal_mode = WAL');
    current.prepare('INSERT INTO processed_tweets VALUES (?)').run('new-tweet');
    current.prepare('INSERT INTO launches VALUES (?, ?)').run('new-launch', 'new-tweet');
    current.close();
    fs.writeFileSync(`${p.source}-wal`, 'wal-evidence');
    fs.writeFileSync(`${p.source}-shm`, 'shm-evidence');

    const result = await restoreBackup({ manifestPath: p.manifest, destinationPath: p.source, offline: true });
    expect(result.launchCount).toBe(2);
    expect(result.integrity).toBe('ok');
    expect(result.foreignKeyViolations).toBe(0);
    expect(fs.existsSync(result.preserved.database)).toBe(true);
    expect(fs.readFileSync(result.preserved.wal!, 'utf8')).toBe('wal-evidence');
    expect(fs.readFileSync(result.preserved.shm!, 'utf8')).toBe('shm-evidence');
    const restored = new Database(p.source, { readonly: true });
    expect((restored.prepare('SELECT COUNT(*) AS count FROM launches').get() as any).count).toBe(2);
    restored.close();
    fs.rmSync(p.dir, { recursive: true, force: true });
  });
});
