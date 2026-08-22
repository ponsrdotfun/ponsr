import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const MAINTENANCE_MANIFEST_SCHEMA = 'ponsr.sqlite-maintenance';
export const MAINTENANCE_MANIFEST_VERSION = 1;
export const DEFAULT_MAX_MANIFEST_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface MaintenanceManifest {
  schema: typeof MAINTENANCE_MANIFEST_SCHEMA;
  version: typeof MAINTENANCE_MANIFEST_VERSION;
  sourcePath: string;
  backupPath: string;
  sha256: string;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  timestamp: string;
}

export interface ValidationResult {
  integrity: 'ok';
  foreignKeyViolations: number;
  launchCount: number;
}

const MANIFEST_FIELDS = [
  'schema', 'version', 'sourcePath', 'backupPath', 'sha256', 'size',
  'mode', 'uid', 'gid', 'timestamp',
].sort();

function ensureAbsolute(file: string, label: string): string {
  if (!path.isAbsolute(file)) throw new Error(`${label} must be absolute`);
  return path.normalize(file);
}

function sha256(file: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function atomicWrite(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}

export async function createBackup(options: {
  sourcePath: string;
  backupPath: string;
  manifestPath: string;
  now?: Date;
}): Promise<MaintenanceManifest> {
  const sourcePath = path.resolve(options.sourcePath);
  const backupPath = path.resolve(options.backupPath);
  const manifestPath = path.resolve(options.manifestPath);
  if (sourcePath === backupPath) throw new Error('backup path must differ from source path');
  if (!fs.statSync(sourcePath).isFile()) throw new Error('source database is not a file');
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  if (fs.existsSync(backupPath)) throw new Error(`backup already exists: ${backupPath}`);

  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    // better-sqlite3 delegates to SQLite's online backup API. It copies a coherent
    // snapshot even when another WAL connection commits while this promise is active.
    await source.backup(backupPath, { progress: () => 1 });
  } finally {
    source.close();
  }

  const validation = validateDatabase(backupPath);
  if (validation.integrity !== 'ok' || validation.foreignKeyViolations !== 0) {
    fs.rmSync(backupPath, { force: true });
    throw new Error('backup database failed validation');
  }

  const sourceStat = fs.statSync(sourcePath);
  const backupStat = fs.statSync(backupPath);
  const manifest: MaintenanceManifest = {
    schema: MAINTENANCE_MANIFEST_SCHEMA,
    version: MAINTENANCE_MANIFEST_VERSION,
    sourcePath,
    backupPath,
    sha256: sha256(backupPath),
    size: backupStat.size,
    mode: sourceStat.mode & 0o7777,
    uid: sourceStat.uid,
    gid: sourceStat.gid,
    timestamp: (options.now ?? new Date()).toISOString(),
  };
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function loadAndValidateManifest(manifestPath: string, options: {
  expectedSourcePath?: string;
  maxAgeMs?: number;
  now?: Date;
} = {}): MaintenanceManifest {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error: any) {
    throw new Error(`malformed manifest JSON: ${error?.message ?? error}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest must be a JSON object');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join('\n') !== MANIFEST_FIELDS.join('\n')) {
    throw new Error('manifest fields are missing or unexpected');
  }
  if (raw.schema !== MAINTENANCE_MANIFEST_SCHEMA || raw.version !== MAINTENANCE_MANIFEST_VERSION) {
    throw new Error('unsupported manifest schema or version');
  }
  const sourcePath = ensureAbsolute(String(raw.sourcePath), 'manifest source path');
  const backupPath = ensureAbsolute(String(raw.backupPath), 'manifest backup path');
  if (sourcePath === backupPath) throw new Error('manifest source path and backup path must differ');
  if (options.expectedSourcePath && sourcePath !== path.resolve(options.expectedSourcePath)) {
    throw new Error('manifest source path mismatch');
  }
  if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) throw new Error('invalid manifest checksum');
  for (const field of ['size', 'mode', 'uid', 'gid'] as const) {
    if (!Number.isSafeInteger(raw[field]) || Number(raw[field]) < 0) throw new Error(`invalid manifest ${field}`);
  }
  if (Number(raw.size) <= 0) throw new Error('invalid manifest size');
  if (Number(raw.mode) > 0o7777) throw new Error('invalid manifest mode');
  if (typeof raw.timestamp !== 'string' || Number.isNaN(Date.parse(raw.timestamp)) || new Date(raw.timestamp).toISOString() !== raw.timestamp) {
    throw new Error('invalid manifest timestamp');
  }
  const age = (options.now ?? new Date()).getTime() - Date.parse(raw.timestamp);
  const maxAge = options.maxAgeMs ?? DEFAULT_MAX_MANIFEST_AGE_MS;
  if (!Number.isFinite(maxAge) || maxAge < 0) throw new Error('invalid maximum manifest age');
  if (age < 0 || age > maxAge) throw new Error('manifest is stale or dated in the future');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(backupPath);
  } catch {
    throw new Error('manifest backup path does not exist');
  }
  if (!stat.isFile() || stat.size !== raw.size) throw new Error('backup size mismatch');
  if (sha256(backupPath) !== raw.sha256) throw new Error('backup checksum mismatch');

  return {
    schema: MAINTENANCE_MANIFEST_SCHEMA,
    version: MAINTENANCE_MANIFEST_VERSION,
    sourcePath,
    backupPath,
    sha256: raw.sha256,
    size: Number(raw.size),
    mode: Number(raw.mode),
    uid: Number(raw.uid),
    gid: Number(raw.gid),
    timestamp: raw.timestamp,
  };
}

export function validateDatabase(file: string): ValidationResult {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`integrity_check failed: ${String(integrity)}`);
    const foreignKeyViolations = (db.pragma('foreign_key_check') as unknown[]).length;
    if (foreignKeyViolations !== 0) throw new Error(`foreign_key_check found ${foreignKeyViolations} violation(s)`);
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='launches'").get();
    if (!table) throw new Error('application table launches is missing');
    const launchCount = Number((db.prepare('SELECT COUNT(*) AS count FROM launches').get() as { count: number }).count);
    if (!Number.isSafeInteger(launchCount) || launchCount < 0) throw new Error('invalid application launch count');
    return { integrity: 'ok', foreignKeyViolations, launchCount };
  } finally {
    db.close();
  }
}

function requireOffline(offline: boolean): void {
  if (offline !== true) throw new Error('offline acknowledgement is required; stop/fence the application writer first');
}

export async function rehearseRestore(options: {
  manifestPath: string;
  destinationPath: string;
  offline: boolean;
  maxAgeMs?: number;
}): Promise<ValidationResult> {
  requireOffline(options.offline);
  const manifest = loadAndValidateManifest(options.manifestPath, { maxAgeMs: options.maxAgeMs });
  const destination = path.resolve(options.destinationPath);
  if (destination === manifest.sourcePath) throw new Error('rehearsal destination must not be the live source path');
  if (fs.existsSync(destination)) throw new Error(`rehearsal destination already exists: ${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(manifest.backupPath, destination, fs.constants.COPYFILE_EXCL);
  return validateDatabase(destination);
}

export async function restoreBackup(options: {
  manifestPath: string;
  destinationPath: string;
  offline: boolean;
  maxAgeMs?: number;
}): Promise<ValidationResult & { preserved: { database: string; wal?: string; shm?: string } }> {
  requireOffline(options.offline);
  const destination = path.resolve(options.destinationPath);
  const manifest = loadAndValidateManifest(options.manifestPath, {
    expectedSourcePath: destination,
    maxAgeMs: options.maxAgeMs,
  });
  const staging = `${destination}.restore-staging-${process.pid}-${Date.now()}`;
  fs.copyFileSync(manifest.backupPath, staging, fs.constants.COPYFILE_EXCL);
  try {
    validateDatabase(staging);
    fs.chmodSync(staging, manifest.mode);
    fs.chownSync(staging, manifest.uid, manifest.gid);

    const suffix = `.failed-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}`;
    const preserved: { database: string; wal?: string; shm?: string } = { database: `${destination}${suffix}` };
    if (!fs.existsSync(destination)) throw new Error('current database is missing; refusing an unpreserved restore');
    fs.renameSync(destination, preserved.database);
    for (const sidecar of ['wal', 'shm'] as const) {
      const current = `${destination}-${sidecar}`;
      if (fs.existsSync(current)) {
        const saved = `${current}${suffix}`;
        fs.renameSync(current, saved);
        preserved[sidecar] = saved;
      }
    }
    fs.renameSync(staging, destination);
    const result = validateDatabase(destination);
    const stat = fs.statSync(destination);
    if ((stat.mode & 0o7777) !== manifest.mode || stat.uid !== manifest.uid || stat.gid !== manifest.gid) {
      throw new Error('restored ownership or mode mismatch');
    }
    return { ...result, preserved };
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

function cliUsage(message?: string): never {
  if (message) process.stderr.write(`maintenance-db: ${message}\n`);
  process.stderr.write('usage: maintenance-db backup --source ABS --backup ABS --manifest ABS\n' +
    '       maintenance-db rehearse|restore --manifest ABS --destination ABS --offline [--max-age-ms N]\n');
  process.exit(2);
}

export async function runMaintenanceCli(argv: string[]): Promise<void> {
  const command = argv.shift();
  if (!command || !['backup', 'rehearse', 'restore'].includes(command)) cliUsage('unknown or missing command');
  const values = new Map<string, string>();
  let offline = false;
  while (argv.length) {
    const key = argv.shift()!;
    if (key === '--offline') {
      if (offline) cliUsage('duplicate option: --offline');
      offline = true;
      continue;
    }
    if (!['--source', '--backup', '--manifest', '--destination', '--max-age-ms'].includes(key)) cliUsage(`unknown option: ${key}`);
    if (values.has(key)) cliUsage(`duplicate option: ${key}`);
    const value = argv.shift();
    if (!value || value.startsWith('--')) cliUsage(`missing value for ${key}`);
    values.set(key, value);
  }
  const required = (key: string): string => values.get(key) ?? cliUsage(`missing ${key}`);
  const ageRaw = values.get('--max-age-ms');
  if (ageRaw && (!/^\d+$/.test(ageRaw) || !Number.isSafeInteger(Number(ageRaw)))) cliUsage('--max-age-ms must be a non-negative safe integer');
  const maxAgeMs = ageRaw ? Number(ageRaw) : DEFAULT_MAX_MANIFEST_AGE_MS;
  if (command === 'backup') {
    if (offline || values.has('--destination') || values.has('--max-age-ms')) cliUsage('invalid backup option');
    const result = await createBackup({ sourcePath: required('--source'), backupPath: required('--backup'), manifestPath: required('--manifest') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (!offline) cliUsage('--offline is required; fence/stop the application writer before restore work');
  if (values.has('--source') || values.has('--backup')) cliUsage(`invalid ${command} option`);
  const options = { manifestPath: required('--manifest'), destinationPath: required('--destination'), offline: true, maxAgeMs } as const;
  const result = command === 'rehearse' ? await rehearseRestore(options) : await restoreBackup(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  runMaintenanceCli(process.argv.slice(2)).catch((error: any) => {
    process.stderr.write(`maintenance-db: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
