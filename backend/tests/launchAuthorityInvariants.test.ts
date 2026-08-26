import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

/**
 * The invariants that must survive this change, asserted against the real files rather
 * than described in a comment.
 *
 * The readiness work made the STATUS path faster by batching reads, moving the bytecode
 * check onto its own cadence, and adding a fallback pool. Every one of those is a way to
 * accidentally weaken the LAUNCH path, which is the one that spends money:
 *
 *   - a cached identity answer must never satisfy the pre-spend identity assertion;
 *   - the launch path must keep ONE pinned provider, because failing over mid-launch
 *     reserves a nonce on one node and broadcasts through another, and the canary's
 *     ambiguity model assumes a single view of the chain;
 *   - the read-only diagnostic must stay read-only.
 *
 * These are checked by reading the shipped sources and by running the diagnostic under
 * instrumentation, not by trusting that the author remembered.
 */

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Comments stripped: a rule that can be satisfied by prose about the rule is not a rule. */
function code(p: string): string {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the launch path keeps its uncached identity assertion', () => {
  it('phase-b-launch asserts deployment identity before spending', () => {
    const src = code('scripts/phase-b-launch.ts');
    expect(src).toContain('assertDeploymentIdentity');
  });

  it('phase-b-launch does not import the cached identity watch', () => {
    // IdentityWatch caches a PASS. On a status page that is a considered trade; ahead of a
    // splitter deployment and a launch fee it would mean spending money on the strength of
    // a bytecode read that happened up to ten minutes ago, through possibly another node.
    const src = code('scripts/phase-b-launch.ts');
    expect(src).not.toContain('identityWatch');
    expect(src).not.toContain('IdentityWatch');
  });

  it('the launch path does not import the fallback pool', () => {
    for (const file of ['scripts/phase-b-launch.ts', 'src/splitterDeployer.ts', 'src/orchestrator.ts']) {
      const src = code(file);
      expect(src).not.toContain('RpcPool');
      expect(src).not.toContain('rpcPool');
    }
  });

  it('assertDeploymentIdentity itself still reads the chain every time', () => {
    // The throwing wrapper must delegate to the live verifier, not to anything holding a
    // previous answer.
    const src = code('src/deploymentIdentity.ts');
    expect(src).toMatch(/export async function assertDeploymentIdentity[\s\S]*verifyDeploymentIdentity\(/);
    expect(src).not.toContain('cache');
  });
});

describe('the fallback pool is wired to the read path only', () => {
  const src = code('src/index.ts');

  it('constructs one pinned provider and hands THAT to the signer and orchestrator', () => {
    expect(src).toContain('const provider = createProvider()');
    expect(src).toContain('createTreasurySigner(provider)');
  });

  it('uses the pool only for status reads', () => {
    // Every rpcPool.run in index.ts must be inside the /status handler. Checked by
    // position: the pool may not be reached before the route is declared.
    const statusAt = src.indexOf("app.get('/status'");
    expect(statusAt).toBeGreaterThan(-1);

    const uses: number[] = [];
    let at = src.indexOf('rpcPool.run');
    while (at !== -1) {
      uses.push(at);
      at = src.indexOf('rpcPool.run', at + 1);
    }
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toBeGreaterThan(statusAt);
  });

  it('does not pass a pooled provider into the treasury signer or the launch target', () => {
    expect(src).not.toMatch(/createTreasurySigner\(\s*rpcPool/);
    expect(src).not.toMatch(/createLaunchTarget\([^)]*rpcPool/);
  });
});

describe('RPC_FALLBACK_URLS is empty until an operator sets it', () => {
  it('defaults to no fallback, so one endpoint remains the behaviour', () => {
    expect(code('src/config.ts')).toContain("RPC_FALLBACK_URLS: z.string().default('')");
  });
});

/**
 * The diagnostic, observed rather than described.
 *
 * Run under the same instrumentation the keyless dry run uses. The RPC points at a port
 * nothing is listening on: every import in the file is top-level, so the entire module
 * graph is loaded before `main()` reaches the network, which is exactly the evidence
 * wanted. The run failing is expected and irrelevant.
 */
describe('rpc-diagnose loads no credential or signer module', () => {
  const PROBE = path.join(__dirname, 'fixtures', 'importProbe.cjs');
  const TSX_ESM = pathToFileURL(
    path.join(ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
  ).href;
  const TSX_CJS = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cjs', 'index.cjs');

  let report: { opened: string[]; loaded: string[] };
  let stdout = '';

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-diag-'));
    const probeOut = path.join(dir, 'probe.json');

    await new Promise<void>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          '-r', PROBE,
          '-r', TSX_CJS,
          '--import', TSX_ESM,
          path.join(ROOT, 'scripts', 'rpc-diagnose.ts'),
          '--rpc', 'http://127.0.0.1:1/nothing-is-listening',
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            PONSR_PROBE_OUT: probeOut,
            // Not inherited from the developer's own shell.
            TURNKEY_API_PRIVATE_KEY: '',
            TURNKEY_SIGN_WITH: '',
            TREASURY_SIGNER_PRIVATE_KEY: '',
          },
        }
      );
      child.stdout.on('data', (d) => (stdout += String(d)));
      child.stderr.on('data', (d) => (stdout += String(d)));
      child.on('exit', () => resolve());
    });

    report = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
  }, 60_000);

  it('observed a real run', () => {
    expect(report.loaded.length).toBeGreaterThan(10);
  });

  it('never loaded a signer, a Turnkey client, or the full credential config', () => {
    const loaded = report.loaded.map((m) => m.replace(/\\/g, '/'));
    expect(loaded.some((m) => /@turnkey/.test(m))).toBe(false);
    expect(loaded.some((m) => /src\/treasurySigner/.test(m))).toBe(false);
    expect(loaded.some((m) => /src\/signedTxFlow/.test(m))).toBe(false);
    // `src/config` calls dotenv at module load and parses every credential field, so
    // importing it IS reading the credentials, whether or not they are used.
    expect(loaded.some((m) => /src\/config\.ts$/.test(m))).toBe(false);
    expect(loaded.some((m) => /node_modules\/dotenv/.test(m))).toBe(false);
  });

  it('never opened backend/.env', () => {
    const opened = report.opened.map((f) => f.replace(/\\/g, '/'));
    expect(opened.some((f) => /\/backend\/\.env$/.test(f))).toBe(false);
    expect(opened.some((f) => /\/backend\/\.env\.canary$/.test(f))).toBe(false);
  });

  it('cannot broadcast: the source sends only reads', () => {
    const src = code('scripts/rpc-diagnose.ts');
    for (const forbidden of [
      'broadcastTransaction',
      'sendTransaction',
      'signTransaction',
      'getSigner',
      '--execute',
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });

  it('prints an endpoint identity and never the URL it was given', () => {
    // The run is pointed at a URL with a path; the output must carry the origin and the
    // fingerprint and drop the rest.
    expect(stdout).toContain('read-only, nothing is signed or broadcast');
    expect(stdout).toContain('http://127.0.0.1:1');
    expect(stdout).not.toContain('nothing-is-listening');
  });
});
