import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

/**
 * 5A: proving the dry run never reads a credential, by watching it run.
 *
 * The claim under test is narrow and was previously false. The canary dry run constructed no
 * signer and requested no signature -- both true -- and was described as "keyless". But
 * `import { config }` runs `dotenv.config()` at module load and parses every credential field,
 * so on a machine with a populated `backend/.env` the process read the Turnkey API private
 * key, the raw treasury key and every third-party token before doing anything.
 *
 * Source inspection cannot settle this. A transitive import four modules deep is invisible to
 * a reading, and so is a file opened by a dependency. So the dry run is SPAWNED with an
 * instrumented `fs` and `Module._load` (tests/fixtures/importProbe.cjs), against a `.env`
 * whose values are sentinels, and the evidence is what the process actually touched.
 *
 * Nothing here reaches a real network: RPC_URL points at a local mock on 127.0.0.1.
 */

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(__dirname, 'fixtures', 'importProbe.cjs');
/**
 * The tsx ESM loader, as an absolute file URL.
 *
 * A bare `--import tsx` is resolved against the child's CWD, which is a temporary directory
 * with no node_modules, so the process died before loading anything and the probe reported an
 * empty run. The URL form pins it to this repository's own installation.
 */
const TSX_ESM = pathToFileURL(
  path.join(ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
).href;
/**
 * The CJS half of tsx, needed as well.
 *
 * With only the ESM loader registered, the entrypoint was resolved through CommonJS `require`
 * and died on `Cannot find module '../src/preflightEnv'` -- TypeScript sources are invisible
 * to plain `require`. Both halves are registered so the script loads exactly as it does under
 * the normal `tsx` CLI, while staying in one process the probe can observe.
 */
const TSX_CJS = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cjs', 'index.cjs');

/**
 * A sentinel that must never be read. If the mixed .env is opened, these bytes enter the
 * process, and the file-open evidence below is what catches it.
 */
const SENTINEL = 'SENTINEL-CREDENTIAL-MUST-NEVER-BE-READ';

/** The treasury pin every run below uses, and the address the status envelope must bind to. */
const TEST_TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
/** Set explicitly rather than left to default, so the envelope and the canary agree. */
const STATUS_CAP_WEI = '10000000000000000'; // 0.01 ETH

/** Journal directories created outside the OS temp tree, removed when the suite ends. */
const journalDirs: string[] = [];
afterAll(() => {
  for (const d of journalDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* a leftover test directory is not worth failing a run over */
    }
  }
});

interface ProbeReport {
  opened: string[];
  loaded: string[];
}

/** A JSON-RPC endpoint that answers from canned values and touches no network. */
function startMockRpc(): Promise<{ url: string; close: () => Promise<void>; calls: string[] }> {
  const calls: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      /**
       * The bot's own /status, served beside the RPC.
       *
       * The preflight refuses to proceed on an unreadable bot ledger -- "an unknown ledger is
       * not an empty one" -- so a run that completes has to be given one. Every binding field
       * matches what the canary expects, because `readBotRollingSpend` checks the window,
       * chain, deployment, factory, treasury and freshness rather than trusting the number.
       */
      if (req.url === '/status') {
        calls.push('GET /status');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            state: 'degraded',
            at: new Date().toISOString(),
            checks: [{ name: 'public-launches', state: 'degraded', detail: 'paused by Ponsr' }],
            spend: {
              window: 'rolling-24h',
              rolling24hWei: '0',
              capWei: STATUS_CAP_WEI,
              currentUtcDayWei: '0',
              chainId: 4663,
              deploymentId: 'pons-v2-current-7ed',
              factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
              treasury: TEST_TREASURY,
              publicLaunchEnabled: false,
              generatedAt: new Date().toISOString(),
            },
          })
        );
        return;
      }

      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          payload = {};
        }
        const one = (m: { method?: string; id?: unknown }) => {
          calls.push(m.method ?? '?');
          const answers: Record<string, unknown> = {
            eth_chainId: '0x1237', // 4663
            net_version: '4663',
            eth_blockNumber: '0x2b0f2f4',
            eth_getBalance: '0x2386f26fc10000',
            eth_gasPrice: '0x3b9aca00',
            eth_getCode: '0x60006000',
            eth_getLogs: [],
            eth_call: '0x' + '0'.repeat(64),
            eth_estimateGas: '0x33450',
            eth_getTransactionCount: '0x7',
          };
          return { jsonrpc: '2.0', id: (m as { id?: unknown }).id ?? 1, result: answers[m.method ?? ''] ?? null };
        };
        const out = Array.isArray(payload) ? payload.map(one) : one(payload as { method?: string });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Runs the canary entrypoint in a throwaway working directory holding a sentinel `.env`.
 *
 * The cwd matters: `dotenv.config()` resolves `.env` relative to the working directory, so a
 * temporary one with a poisoned file is what makes "was it opened?" a meaningful question.
 */
async function runCanary(opts: {
  rpcUrl: string;
  execute?: boolean;
  envCanary?: string;
  extraEnv?: Record<string, string>;
  /**
   * Runs the harness that supplies bounded read-only substitutes for the four chain reads a
   * mock cannot satisfy, so the preflight can run to completion. Same process, same
   * instrumentation, same module graph -- see tests/fixtures/dryRunHarness.ts.
   */
  complete?: boolean;
}): Promise<{ report: ProbeReport; stdout: string; stderr: string; status: number | null; envPath: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-5a-'));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(
    envPath,
    [
      `TURNKEY_API_PRIVATE_KEY=${SENTINEL}`,
      `TREASURY_SIGNER_PRIVATE_KEY=${SENTINEL}`,
      `OPENROUTER_API_KEY=${SENTINEL}`,
      `TELEGRAM_BOT_TOKEN=${SENTINEL}`,
      `X_API_SECRET=${SENTINEL}`,
      '',
    ].join('\n'),
    'utf8'
  );
  if (opts.envCanary !== undefined) {
    fs.writeFileSync(path.join(dir, '.env.canary'), opts.envCanary, 'utf8');
  }
  const probeOut = path.join(dir, 'probe.json');

  /**
   * The journal cannot live under the OS temp directory on Linux.
   *
   * `os.tmpdir()` IS `/tmp` there, and the journal refuses ephemeral container storage on
   * purpose -- a deploy would erase the record of transactions that are still on chain. That
   * guard is correct and stays; the test was putting the file in the one place it forbids,
   * which passed on Windows (whose temp path is not /tmp) and failed on CI. Somewhere durable
   * under the home directory satisfies both.
   */
  const journalDir = fs.mkdtempSync(path.join(os.homedir(), '.ponsr-canary-test-'));
  journalDirs.push(journalDir);

  /**
   * The probe is preloaded through argv rather than NODE_OPTIONS.
   *
   * NODE_OPTIONS took the Windows path with escaped backslashes and the child failed before
   * printing anything, which read as "the dry run produced no output" rather than "the
   * harness is broken" -- an instrumentation bug that would have looked like evidence.
   */
  /**
   * `--import tsx` keeps the script in THIS process; the `tsx` CLI spawns its own child.
   *
   * With the CLI, the `-r` preload attached to the wrapper and the real script ran in a
   * grandchild the probe never saw, so the report came back empty -- which every assertion
   * below would have read as "touched nothing at all". Registering tsx in-process is what
   * makes the instrumentation observe the code under test rather than its launcher.
   */
  const entry = opts.complete
    ? path.join(__dirname, 'fixtures', 'dryRunHarness.ts')
    : path.join(ROOT, 'scripts', 'phase-b-launch.ts');
  const args = ['-r', PROBE, '-r', TSX_CJS, '--import', TSX_ESM, entry];
  if (opts.execute) args.push('--execute');

  /**
   * ASYNCHRONOUS, and that is not a style choice.
   *
   * `spawnSync` blocks this process's event loop, so the in-process mock RPC below could
   * never answer and the child waited for a reply that could not arrive. Every run timed out
   * with an empty probe file, which read as "the dry run touched nothing" -- a broken harness
   * producing what looked like perfect evidence. The `produced runtime evidence at all` test
   * exists because of it.
   */
  const child = spawn(process.execPath, args, {
    cwd: dir,
    env: {
      ...process.env,
      PONSR_PROBE_OUT: probeOut,
      RPC_URL: opts.rpcUrl,
      CHAIN_ID: '4663',
      PONS_FACTORY_VERSION: 'v2',
      TREASURY_ADDRESS: TEST_TREASURY,
      CANARY_JOURNAL: path.join(journalDir, 'canary.sqlite'),
      DAILY_SPEND_CAP_WEI: STATUS_CAP_WEI,
      /**
       * The permanent identity, explicit because mainnet refuses a default. A dry run that
       * could not name the token would abort before the stages this test exists to observe.
       */
      PHASE_B_NAME: 'PONSR STONKS',
      PHASE_B_SYMBOL: 'PSTONKS',
      /** The bot's ledger. Unreadable is a blocking condition, and correctly so. */
      BOT_STATUS_URL: `${opts.rpcUrl}/status`,
      // Not inherited from the developer's own shell.
      TURNKEY_API_PRIVATE_KEY: '',
      TURNKEY_SIGN_WITH: '',
      TREASURY_SIGNER_PRIVATE_KEY: '',
      ...opts.extraEnv,
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));

  const status = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, 90000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  const report: ProbeReport = fs.existsSync(probeOut)
    ? JSON.parse(fs.readFileSync(probeOut, 'utf8'))
    : { opened: [], loaded: [] };
  return { report, stdout, stderr, status, envPath };
}

const openedMixedEnv = (r: ProbeReport, envPath: string) =>
  r.opened.some((p) => path.resolve(p) === path.resolve(envPath));

const loadedMatching = (r: ProbeReport, re: RegExp) => r.loaded.filter((m) => re.test(m));

describe('the keyless dry run never reads a credential', () => {
  let rpc: Awaited<ReturnType<typeof startMockRpc>>;
  let run: Awaited<ReturnType<typeof runCanary>>;

  beforeAll(async () => {
    rpc = await startMockRpc();
    run = await runCanary({ rpcUrl: rpc.url });
  }, 180000);

  afterAll(async () => {
    await rpc?.close();
  });

  it('produced runtime evidence at all', () => {
    // A probe that recorded nothing would make every assertion below vacuously true.
    expect(run.report.loaded.length).toBeGreaterThan(10);
    expect(run.report.opened.length).toBeGreaterThan(0);
  });

  /** The finding itself: the mixed credential file must never be opened. */
  it('never opens the mixed backend/.env', () => {
    expect(openedMixedEnv(run.report, run.envPath)).toBe(false);
  });

  it('never loads the dotenv bootstrap', () => {
    expect(loadedMatching(run.report, /(^|[\\/])dotenv([\\/]|$)/)).toEqual([]);
  });

  it('never loads the full credential config module', () => {
    expect(loadedMatching(run.report, /[\\/]src[\\/]config\.ts$|[\\/]src[\\/]config\.js$/)).toEqual([]);
  });

  it('never loads the treasury signer or the Turnkey SDK', () => {
    expect(loadedMatching(run.report, /treasurySigner/)).toEqual([]);
    expect(loadedMatching(run.report, /@turnkey/)).toEqual([]);
  });

  it('never prints a sentinel credential value', () => {
    expect(run.stdout).not.toContain(SENTINEL);
    expect(run.stderr).not.toContain(SENTINEL);
  });

  /**
   * The dry run still does its job on secret-free input.
   *
   * Without this, "reads no credentials" could be satisfied by a process that does nothing at
   * all. It must reach the preflight and answer from the non-secret environment.
   */
  it('still reaches the preflight using only non-secret settings', () => {
    expect(run.stdout).toContain('DRY RUN');
    expect(run.stdout).toContain('Chain');
    expect(run.stdout).toContain(rpc.url);
    expect(run.stdout).toContain('Treasury');
    // The pinned treasury came from TREASURY_ADDRESS, with no signer anywhere.
    expect(run.stdout).toContain('0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa');
    expect(run.stdout).toContain('no signer loaded');
  });

  it('made real RPC calls, so the preflight was genuinely exercised', () => {
    expect(rpc.calls).toContain('eth_chainId');
    expect(rpc.calls.length).toBeGreaterThan(1);
  });
});

describe('the secret-free source refuses to serve credentials', () => {
  it('throws rather than reading a credential name', async () => {
    const { preflightEnv, REFUSED_CREDENTIAL_NAMES } = await import('../src/preflightEnv');
    expect(REFUSED_CREDENTIAL_NAMES).toContain('TURNKEY_API_PRIVATE_KEY');
    // The schema itself contains no credential field, so a caller cannot reach one.
    const env = preflightEnv();
    for (const name of REFUSED_CREDENTIAL_NAMES) {
      expect(Object.keys(env)).not.toContain(name);
    }
  });

  /**
   * The denylist had already drifted, which is why there is no denylist any more.
   *
   * `X_API_KEY` and `X_ACCESS_TOKEN` are declared in `config.ts` and were missing from the
   * enumerated refusal list, so a file called secret-free could carry live X authentication
   * material and pass the guard. Every future credential would have had to be remembered by
   * hand, in a second place, forever.
   *
   * The allowlist inverts that: only the exact non-secret settings this module serves are
   * accepted, so a name nobody anticipated is refused rather than admitted.
   */
  it('refuses every credential name in config.ts, including the ones no denylist remembered', async () => {
    const { preflightEnv } = await import('../src/preflightEnv');
    const cfg = fs.readFileSync(path.join(ROOT, 'src', 'config.ts'), 'utf8');
    const declared = [...cfg.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
    const secretish = declared.filter((n) => /KEY|SECRET|TOKEN|PRIVATE|PASSWORD/.test(n));

    // The two the enumerated list had missed, named explicitly so a regression is legible.
    expect(secretish).toEqual(expect.arrayContaining(['X_API_KEY', 'X_ACCESS_TOKEN']));

    const served = Object.keys(preflightEnv());
    for (const name of secretish) {
      expect(served).not.toContain(name);
    }
  });

  it('refuses an unknown name in .env.canary, not just known credentials', async () => {
    const rpc = await startMockRpc();
    try {
      const run = await runCanary({
        rpcUrl: rpc.url,
        envCanary: 'SOME_FUTURE_CREDENTIAL=whatever\n',
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr + run.stdout).toMatch(/not one of the non-secret preflight settings/);
    } finally {
      await rpc.close();
    }
  }, 180000);

  it('accepts every documented non-secret field', async () => {
    const { preflightEnv } = await import('../src/preflightEnv');
    const names = Object.keys(preflightEnv());
    expect(names).toEqual(expect.arrayContaining(['RPC_URL', 'CHAIN_ID', 'PONS_FACTORY_VERSION']));
  });

  it('refuses a .env.canary that smuggles a credential in', async () => {
    const rpc = await startMockRpc();
    try {
      const run = await runCanary({
        rpcUrl: rpc.url,
        envCanary: `TURNKEY_API_PRIVATE_KEY=${SENTINEL}\n`,
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr + run.stdout).toMatch(/must hold no secrets|is a credential/);
    } finally {
      await rpc.close();
    }
  }, 180000);

  it('reads non-secret values from .env.canary when the process env is silent', async () => {
    const rpc = await startMockRpc();
    try {
      const run = await runCanary({
        rpcUrl: rpc.url,
        envCanary: 'PONS_FACTORY_VERSION=v2\n',
        extraEnv: { PONS_FACTORY_VERSION: '' },
      });
      expect(openedMixedEnv(run.report, run.envPath)).toBe(false);
      expect(run.stdout).toContain('DRY RUN');
    } finally {
      await rpc.close();
    }
  }, 180000);
});

/**
 * A COMPLETE dry run, not one that aborted early and looked clean.
 *
 * The earlier proof asserted the opening output and some RPC traffic, which a run that died
 * at the deployment-identity check also satisfies -- so the later preflight stages were never
 * exercised while the import evidence was presented as covering the whole run. This drives
 * the real entrypoint to its terminal line, under the same instrumentation, and requires exit
 * status 0.
 */
describe('the secret-free dry run runs to completion', () => {
  let rpc: Awaited<ReturnType<typeof startMockRpc>>;
  let run: Awaited<ReturnType<typeof runCanary>>;

  beforeAll(async () => {
    rpc = await startMockRpc();
    run = await runCanary({ rpcUrl: rpc.url, complete: true });
  }, 180000);

  afterAll(async () => {
    await rpc?.close();
  });

  it('exits 0', () => {
    expect(run.stderr).not.toMatch(/FAILED|BLOCKED/);
    expect(run.status).toBe(0);
  });

  it('reaches the terminal line', () => {
    expect(run.stdout).toContain('Dry run complete. Nothing was sent.');
  });

  it('ran every major preflight stage', () => {
    for (const stage of [
      'identity',
      'launchEnabled',
      'whitelisted',
      'launchFee (live)',
      'daily cap',
      'bot accounted spend',
      'canary journal spend',
      'paired against',
      'Preflight clean.',
      'Planned launch',
      'salt',
    ]) {
      expect(run.stdout).toContain(stage);
    }
  });

  it('bound the bot ledger rather than skipping it', () => {
    expect(rpc.calls).toContain('GET /status');
    expect(run.stdout).not.toContain('UNREADABLE');
  });

  it('printed a pairing the real resolver could have produced', () => {
    expect(run.stdout).toMatch(/paired against\s+ETH\s+\(default-eth\)/);
    expect(run.stdout).not.toContain('undefined');
  });

  /** With nothing requested, the approval map is not consulted either. */
  it('read the approval map zero times for the default ETH pair', () => {
    expect(run.stdout).toContain('[harness] approvalMapReads=0');
  });
});

/**
 * The mainnet failure of 2026-08-25, as a regression through the real orchestration.
 *
 * `PAIR_WITH=ETH` reached `isApprovedNow(0x0)`, which is false and always has been, and the
 * run refused with a revocation message about something nobody had revoked. It exited 1 having
 * spent nothing. Here the shipped resolver runs for real against bounded dependencies whose
 * approval reader would answer FALSE if it were asked -- so a run that completes is a run that
 * did not ask.
 */
describe('an explicitly requested ETH pair completes the dry run', () => {
  let rpc: Awaited<ReturnType<typeof startMockRpc>>;
  let run: Awaited<ReturnType<typeof runCanary>>;

  beforeAll(async () => {
    rpc = await startMockRpc();
    run = await runCanary({
      rpcUrl: rpc.url,
      complete: true,
      extraEnv: { PAIR_WITH: 'ETH' },
    });
  }, 180000);

  afterAll(async () => {
    await rpc?.close();
  });

  it('exits 0 and reaches the terminal line', () => {
    expect(run.stderr).not.toMatch(/no longer approved/);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Dry run complete. Nothing was sent.');
  });

  it('never reads the native approval map', () => {
    expect(run.stdout).toContain('[harness] approvalMapReads=0');
  });

  it('reports the pairing truthfully as an explicit choice', () => {
    expect(run.stdout).toMatch(/paired against\s+ETH\s+\(explicit-eth\)/);
    // Not dressed up as a registry approval that was never consulted.
    expect(run.stdout).not.toMatch(/paired against\s+ETH\s+\(registry\)/);
  });

  it('requests no signer, signature or broadcast', () => {
    expect(run.stdout).not.toContain('EXECUTING');
    expect(loadedMatching(run.report, /treasurySigner/)).toEqual([]);
    expect(loadedMatching(run.report, /@turnkey/)).toEqual([]);
    expect(run.stdout).toContain('no signer loaded');
  });

  /** The completion run is held to the same secret-free boundary as the plain one. */
  it('still never opened the mixed .env or loaded credential modules', () => {
    expect(run.report.loaded.length).toBeGreaterThan(10);
    expect(openedMixedEnv(run.report, run.envPath)).toBe(false);
    expect(loadedMatching(run.report, /(^|[\\/])dotenv([\\/]|$)/)).toEqual([]);
    expect(loadedMatching(run.report, /[\\/]src[\\/]config\.ts$|[\\/]src[\\/]config\.js$/)).toEqual([]);
    expect(loadedMatching(run.report, /treasurySigner/)).toEqual([]);
    expect(loadedMatching(run.report, /@turnkey/)).toEqual([]);
    expect(run.stdout).not.toContain(SENTINEL);
  });

  /**
   * The negative case, and the reason the completion requirement exists at all.
   *
   * Without substitutes the run aborts at the deployment-identity check -- and that aborted
   * run still satisfies every import and file-open assertion. Proving both here keeps the two
   * claims separate: "read no credentials" and "did the whole job" are different facts, and
   * only one of them used to be checked.
   */
  it('an early identity abort cannot pass as a completed dry run', async () => {
    const other = await startMockRpc();
    try {
      const aborted = await runCanary({ rpcUrl: other.url, complete: false });
      expect(aborted.status).not.toBe(0);
      expect(aborted.stdout).not.toContain('Dry run complete. Nothing was sent.');
      // ...while still being clean on the secret-free boundary, which is exactly the trap.
      expect(openedMixedEnv(aborted.report, aborted.envPath)).toBe(false);
    } finally {
      await other.close();
    }
  }, 180000);
});

/**
 * The other half of the boundary: the credentials must still be reachable AFTER the gate.
 *
 * A dry run that reads nothing is only half the requirement. If `--execute` could not load the
 * signer, the split would have been achieved by breaking the thing it protects.
 */
describe('the execute gate is where credential loading begins', () => {
  let rpc: Awaited<ReturnType<typeof startMockRpc>>;
  let run: Awaited<ReturnType<typeof runCanary>>;

  beforeAll(async () => {
    rpc = await startMockRpc();
    run = await runCanary({ rpcUrl: rpc.url, execute: true });
  }, 180000);

  afterAll(async () => {
    await rpc?.close();
  });

  it('fails without ever signing or broadcasting, because no credentials are present', () => {
    expect(run.status).not.toBe(0);
    // Whatever refused it, nothing was signed and nothing went out.
    expect(run.stdout + run.stderr).not.toMatch(/broadcast(ing)? transaction/i);
  });

  it('never leaks a sentinel even on the execute path', () => {
    expect(run.stdout).not.toContain(SENTINEL);
    expect(run.stderr).not.toContain(SENTINEL);
  });

  /**
   * The dry-run substitutes must be inert here, and this is the test that says so.
   *
   * A test seam that a spending run could reach would be worse than no seam at all: the
   * deployment-identity check is the guard that stopped this exact script launching against
   * the wrong factory. Run with `--execute`, the harness's substitutes are dropped and the
   * real check runs, so the run dies on identity rather than sailing past it.
   */
  it('drops the dry-run substitutes entirely under --execute', async () => {
    const other = await startMockRpc();
    try {
      const executed = await runCanary({ rpcUrl: other.url, complete: true, execute: true });
      expect(executed.status).not.toBe(0);
      // The substitute would have printed this line and suppressed the real check.
      expect(executed.stdout).not.toContain('[harness] deployment identity substituted');
      expect(executed.stdout + executed.stderr).toMatch(
        /is not the contract the registry describes|runtime sha256/
      );
    } finally {
      await other.close();
    }
  }, 180000);
});

/**
 * The regression guard the brief asks for: a transitive import of full config or signer
 * authority anywhere in the preflight graph must fail this test, not merely be noticed later.
 */
describe('no preflight dependency imports credential authority', () => {
  it('has no static import path from the canary entrypoint to config or the signer', () => {
    const seen = new Set<string>();
    const offenders: string[] = [];

    const staticImports = (file: string): string[] => {
      const src = fs.readFileSync(file, 'utf8');
      const out: string[] = [];
      /**
       * Static value imports only.
       *
       * `await import()` is excluded because that is exactly the mechanism the execute gate
       * uses. `import type` is excluded because TypeScript erases it: no module is loaded at
       * runtime, which the spawned-process evidence above independently confirms.
       */
      const re = /^[ \t]*import[ \t]+(?!type[ \t])[^;]*?from[ \t]*['"](\.[^'"]+)['"]/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const resolved = path.resolve(path.dirname(file), m[1]);
        if (fs.existsSync(resolved + '.ts')) out.push(resolved + '.ts');
      }
      return out;
    };

    const forbidden = [path.resolve(ROOT, 'src', 'config.ts')];

    const walk = (file: string, chain: string[]) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const dep of staticImports(file)) {
        const trail = [...chain, path.basename(file), path.basename(dep)];
        if (forbidden.includes(dep)) offenders.push(trail.join(' -> '));
        else walk(dep, [...chain, path.basename(file)]);
      }
    };

    walk(path.resolve(ROOT, 'scripts', 'phase-b-launch.ts'), []);
    expect(offenders).toEqual([]);
  });
});
