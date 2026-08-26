import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type { AddressInfo } from 'net';

/**
 * A FLAG THAT IS SILENTLY IGNORED LOOKS LIKE AN ASSERTION AND IS NOT ONE.
 *
 * A production deploy brief specified:
 *
 *   npx tsx scripts/sample-status-latency.ts ... --expect-endpoint 78ccdeee5ef1 ...
 *
 * The sampler's argument reader looked up the names it knew and ignored everything else,
 * so that pin was NEVER CHECKED. The command line recorded in the deploy report claimed a
 * property nothing had measured -- the same shape as the wrong-chain gate that asked
 * `getNetwork()` under `staticNetwork` and compared a constant to itself.
 *
 * The sampler also never requested `/health`, and recorded no chain, block, deployment,
 * fee, cap, treasury or gate value, so three of the brief's acceptance items could not be
 * evidenced from its output at all.
 *
 * These tests run the REAL CLI as a child process against a REAL HTTP server, and assert
 * on the exit code, the files written, and the requests the server actually received. A
 * test that imported the module and called an exported helper could not tell whether the
 * shipped entry point wires any of it up.
 */

const CLI = path.join(__dirname, '..', 'scripts', 'sample-status-latency.ts');
/**
 * Node plus tsx's own JS entry, never the `.bin` shim and never `shell: true`.
 *
 * The shim is a `.cmd` on Windows, which `spawnSync` refuses with EINVAL unless a shell is
 * involved -- and a shell would interpret the arguments, which is unacceptable in a file
 * that deliberately passes a secret-shaped value on the command line to prove it is not
 * echoed back. It also matters that a failure to LAUNCH is not mistaken for a refusal:
 * without this, every `expect(status).not.toBe(0)` passed while the CLI never ran.
 */
const TSX_CLI = path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

const ENDPOINT = '78ccdeee5ef1';
const CHAIN = 4663;
const DEPLOYMENT = 'pons-v2-current-7ed';
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const FEE = '500000000000000';
const CAP = '10000000000000000';
const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';

interface ServerHandle {
  url: string;
  paths: string[];
  close: () => Promise<void>;
}

function coreBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'ponsr.status-core',
    version: 1,
    expectedChainId: CHAIN,
    capWei: CAP,
    publicLaunchEnabled: false,
    observedThrough: ENDPOINT,
    endpointOrigin: 'https://rpc.example.com',
    deploymentId: DEPLOYMENT,
    factory: FACTORY,
    treasuryAddress: TREASURY,
    chainId: CHAIN,
    block: 46_600_000,
    identity: { ok: true, ageMs: 0, fromCache: false, unreadable: false },
    launchFeeWei: FEE,
    readiness: { ready: true, launchEnabled: true, whitelisted: false, canLaunchOnChain: true, complete: true },
    treasuryBalanceWei: '26030650325023000',
    rolling24hWei: '0',
    ok: true,
    generatedAt: new Date().toISOString(),
    elapsedMs: 70,
    problems: [],
    dependencies: [
      { name: 'chain', outcome: 'ok', ms: 70, startedAtMs: 0, shared: false },
      { name: 'launch-fee', outcome: 'ok', ms: 60, startedAtMs: 5, shared: false },
    ],
    ...over,
  };
}

function fullBody(): Record<string, unknown> {
  return {
    state: 'degraded',
    at: new Date().toISOString(),
    checks: [
      { name: 'public-launches', state: 'degraded', detail: 'paused by Ponsr' },
      { name: 'rpc', state: 'ok', detail: 'chain 4663' },
    ],
    spend: { window: 'rolling-24h', rolling24hWei: '0', capWei: CAP, chainId: CHAIN },
    dependencies: [{ name: 'read-credits', outcome: 'ok', ms: 300, startedAtMs: 0, shared: false }],
  };
}

/** A real server. `blocks` advances the reported height so progression can be proven. */
async function startServer(opts: { core?: () => unknown; coreStatus?: number; blocks?: number[] } = {}): Promise<ServerHandle> {
  const paths: string[] = [];
  let call = 0;
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? '');
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', env: 'test' }));
      return;
    }
    if (req.url === '/status/core') {
      // The default ADVANCES, because a live chain does. A static height would make every
      // happy-path case fail on block progression -- correctly, which is the point: the
      // frozen case below has to opt in with `blocks: [100, 100]` rather than being the
      // accidental default nobody noticed.
      const height = opts.blocks ? opts.blocks[Math.min(call, opts.blocks.length - 1)] : 46_600_000 + call;
      call += 1;
      const body = opts.core ? opts.core() : coreBody({ block: height });
      res.writeHead(opts.coreStatus ?? 200, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
      return;
    }
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fullBody()));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function pins(url: string, extra: string[] = []): string[] {
  return [
    '--url', url,
    '--samples', '2',
    '--interval-ms', '0',
    '--expect-endpoint', ENDPOINT,
    '--expect-chain', String(CHAIN),
    '--expect-deployment', DEPLOYMENT,
    '--expect-factory', FACTORY,
    '--expect-fee-wei', FEE,
    '--expect-cap-wei', CAP,
    '--expect-treasury', TREASURY,
    '--expect-public-gate', 'false',
    ...extra,
  ];
}

/**
 * ASYNC, and that is not a style preference.
 *
 * `spawnSync` blocks this process's event loop -- and the HTTP server the child is talking
 * to lives in THIS process. The server could never answer while the parent was blocked, so
 * every request timed out and each case took 80 seconds to fail: two samples, two 20-second
 * timeouts each. The tests were red for a reason that had nothing to do with the sampler.
 */
function run(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    // A process that never started is a broken test, not a refusal. Surfaced loudly, because
    // silently returning -1 here made `.not.toBe(0)` pass for eight cases that never ran.
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`sampler CLI failed to launch: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === null) reject(new Error(`sampler CLI did not exit cleanly (signal ${signal})`));
      else resolve({ status: code, stdout, stderr });
    });
  });
}

describe('the sampler refuses flags it does not enforce', () => {
  let s: ServerHandle;
  beforeAll(async () => {
    s = await startServer();
  });
  afterAll(async () => {
    await s.close();
  });

  it('an unknown flag is refused with exit 2 rather than ignored', async () => {
    const r = await run(pins(s.url, ['--totally-unknown-flag', 'x']));
    expect(r.status).toBe(2);
    // The point of the whole file: it must not sample and claim success.
    expect(r.stdout).not.toContain('No sample was discarded');
  });

  it('a misspelled pin is refused, not silently unenforced', async () => {
    // `--expect-endpont` is one keystroke from the real thing, and under the old reader it
    // would have sampled happily while checking nothing.
    const r = await run([...pins(s.url), '--expect-endpont', ENDPOINT]);
    expect(r.status).toBe(2);
  });

  it('a flag given without a value is refused', async () => {
    const r = await run(['--url', s.url, '--expect-endpoint']);
    expect(r.status).toBe(2);
  });

  it('a usage refusal never echoes the value it was given', async () => {
    const secret = 'SECRET_SAMPLER_VALUE';
    const r = await run([...pins(s.url), '--unknown', secret]);
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).not.toContain(secret);
  });

  it('refuses to declare PASS when the invariant pins are absent', async () => {
    // Without pins there is nothing to compare a response against, and a response field
    // must never be its own expected value.
    const r = await run(['--url', s.url, '--samples', '1', '--interval-ms', '0']);
    expect(r.status).not.toBe(0);
  });
});

describe('the sampler measures what an operator is told it measures', () => {
  it('requests /health, /status/core and /status exactly once per sample', async () => {
    const s = await startServer();
    try {
      const r = await run(pins(s.url));
      expect(r.status).toBe(0);
      const count = (p: string) => s.paths.filter((x) => x === p).length;
      expect(count('/health')).toBe(2);
      expect(count('/status/core')).toBe(2);
      expect(count('/status')).toBe(2);
      expect(r.stdout).toContain('health');
    } finally {
      await s.close();
    }
  }, 120_000);

  it('a mismatched endpoint fingerprint FAILS the run rather than being printed', async () => {
    const s = await startServer({ core: () => coreBody({ observedThrough: 'ffffffffffff' }) });
    try {
      const r = await run(pins(s.url));
      expect(r.status).not.toBe(0);
      expect(r.stdout).toMatch(/endpoint/i);
    } finally {
      await s.close();
    }
  }, 120_000);

  it.each([
    ['chain', { chainId: 999 }],
    ['deployment', { deploymentId: 'pons-v1' }],
    ['factory', { factory: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB' }],
    ['fee', { launchFeeWei: '1' }],
    ['cap', { capWei: '1' }],
    ['treasury', { treasuryAddress: '0x000000000000000000000000000000000000dEaD' }],
    ['public gate', { publicLaunchEnabled: true }],
  ])('a mismatched %s FAILS the run', async (_label, over) => {
    const s = await startServer({ core: () => coreBody(over) });
    try {
      expect((await run(pins(s.url))).status).not.toBe(0);
    } finally {
      await s.close();
    }
  }, 120_000);

  it('proves block progression across the series, and fails a frozen chain', async () => {
    const moving = await startServer({ blocks: [100, 101] });
    try {
      const r = await run(pins(moving.url));
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/block progression/i);
    } finally {
      await moving.close();
    }

    const frozen = await startServer({ blocks: [100, 100] });
    try {
      expect((await run(pins(frozen.url))).status).not.toBe(0);
    } finally {
      await frozen.close();
    }
  }, 180_000);

  it('records malformed JSON as a failed sample and keeps sampling', async () => {
    const s = await startServer({ core: () => 'not json at all' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-sampler-'));
    const out = path.join(dir, 's.jsonl');
    try {
      const r = await run([...pins(s.url), '--out', out]);
      expect(r.status).not.toBe(0);
      // Both samples are still on disk: a measurement tool that stops on a strange answer
      // turns "the endpoint said something odd" into "we have no data".
      const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    } finally {
      await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('writes every invariant field and a formula-safe CSV', async () => {
    const s = await startServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-sampler-'));
    const out = path.join(dir, 's.jsonl');
    const csv = path.join(dir, 's.csv');
    try {
      expect((await run([...pins(s.url), '--out', out, '--csv', csv])).status).toBe(0);
      const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        for (const field of [
          'healthStatus', 'healthMs',
          'coreStatus', 'coreOk', 'coreSchema', 'coreVersion',
          'observedThrough', 'endpointOrigin',
          'chainId', 'block',
          'deploymentId', 'factory',
          'launchFeeWei', 'treasuryAddress', 'treasuryBalanceWei',
          'rolling24hWei', 'capWei', 'publicLaunchEnabled',
          'coreDependencies',
          'fullStatus', 'fullState', 'fullNonOk', 'fullMs', 'slowestDependency',
          'verdict',
        ]) {
          expect(Object.keys(row)).toContain(field);
        }
      }
      const header = fs.readFileSync(csv, 'utf8').split('\n')[0];
      expect(header).toContain('healthStatus');
      expect(header).toContain('verdict');
    } finally {
      await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('prints the acceptance arithmetic separately for 4.5s and 5.0s', async () => {
    const s = await startServer();
    try {
      const r = await run(pins(s.url));
      expect(r.stdout).toMatch(/4\.5/);
      expect(r.stdout).toMatch(/5\.0/);
      expect(r.stdout).toContain('No sample was discarded');
    } finally {
      await s.close();
    }
  }, 120_000);
});
