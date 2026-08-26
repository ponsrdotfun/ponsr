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

  it('is referenced by exactly one module in the whole shipped tree', () => {
    // Stronger than checking where the calls sit inside index.ts. A source-position test
    // cannot see a use added later in the file, an alias assigned to another name, or a
    // second module importing the pool entirely. This enumerates every shipped file that
    // mentions RpcPool at all and holds the list to an explicit allowlist.
    const roots = ['src', 'scripts'];
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        // code(), not read(): config.ts mentions rpcPool.ts in a doc comment explaining
        // why RPC_FALLBACK_URLS is dangerous, which is documentation rather than a use.
        // A rule satisfied or broken by prose about the rule is not a rule.
        else if (/\.ts$/.test(entry.name) && /RpcPool|rpcPool/.test(code(rel))) found.push(rel);
      }
    };
    roots.forEach(walk);

    // rpcPool.ts defines it; statusSession.ts assembles one bounded /status response from
    // it; index.ts wires those together. Nothing else in the shipped tree may touch it.
    expect(found.sort()).toEqual(['src/index.ts', 'src/rpcPool.ts', 'src/statusSession.ts']);
  });

  it('is reached only from the status path, never from the launch or orchestrator wiring', () => {
    // Positional "after app.get('/status')" was the old rule and it is no longer the right
    // one: the dependency builder is shared by BOTH status routes and is declared above
    // them. The property that matters is unchanged -- the pool is reachable only from the
    // status path -- so the rule now names that path instead of a line number.
    const builderAt = src.indexOf('const statusDepsFor');
    const statusAt = src.indexOf("app.get('/status'");
    const coreAt = src.indexOf("app.get('/status/core'");
    expect(builderAt).toBeGreaterThan(-1);
    expect(statusAt).toBeGreaterThan(builderAt);
    expect(coreAt).toBeGreaterThan(statusAt);

    const importAt = src.indexOf("from './rpcPool'");
    const construction = src.indexOf('const rpcPool = new RpcPool');
    expect(importAt).toBeGreaterThan(-1);
    expect(construction).toBeGreaterThan(-1);
    const isDeclaration = (u: number) =>
      (u > importAt - 60 && u < importAt + 20) || (u > construction - 5 && u < construction + 40);

    const uses: number[] = [];
    let at = src.indexOf('rpcPool');
    while (at !== -1) {
      uses.push(at);
      at = src.indexOf('rpcPool', at + 1);
    }
    const operational = uses.filter((u) => !isDeclaration(u));
    expect(operational.length).toBeGreaterThan(0);
    // Every actual USE sits inside the shared status dependency builder or below it, which
    // is the status path and nothing else.
    for (const u of operational) expect(u).toBeGreaterThan(builderAt);

    // The builder itself is consumed only by the two status routes.
    const consumers = [...src.matchAll(/statusDepsFor/g)].map((m) => m.index!);
    expect(consumers.length).toBe(3); // the declaration plus the two routes
    for (const c of consumers.slice(1)) expect(c).toBeGreaterThan(statusAt);

    // And no alias escapes under a different name.
    expect(src).not.toMatch(/const\s+\w+\s*=\s*rpcPool\s*;/);
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

/**
 * The core endpoint and its consumer are readers. Asserted against the shipped sources,
 * because "it does not sign" is the kind of claim that stays true only while someone keeps
 * checking.
 */
describe('the core evidence path imports nothing that can spend', () => {
  const FORBIDDEN = [
    '@turnkey',
    'treasurySigner',
    'signedTxFlow',
    'canaryJournal',
    'createTreasurySigner',
    'broadcastTransaction',
    'sendTransaction',
    'signTransaction',
  ];

  it.each([
    'src/statusCore.ts',
    'src/coreValidator.ts',
    'src/dependencyTiming.ts',
    'src/strictParse.ts',
    'src/sampleGuards.ts',
  ])(
    '%s imports no signer, credential loader or broadcast path',
    (file) => {
      const src = code(file);
      for (const forbidden of FORBIDDEN) expect(src).not.toContain(forbidden);
      // src/config calls dotenv at module load and parses every credential field, so
      // importing it IS reading the credentials whether or not they are used.
      expect(src).not.toMatch(/from '\.\/config'/);
    }
  );

  it.each(['scripts/check-core-readiness.ts', 'scripts/sample-status-latency.ts'])(
    '%s is a reader: no signer, no credential, no write to the chain',
    (file) => {
      const src = code(file);
      for (const forbidden of FORBIDDEN) expect(src).not.toContain(forbidden);
      expect(src).not.toContain('--execute');
      expect(src).not.toMatch(/from '\.\.\/src\/config'/);
    }
  );

  it('the production status route resolves the treasury WITHOUT the signer', () => {
    // The leaf modules were always clean, but the deployed route called
    // `treasurySigner.address()`, which resolves through the Turnkey client. That signs
    // nothing, yet it made a read-only endpoint depend on the signer path -- and made the
    // claim "loads no Turnkey credential" false at the composition boundary.
    const src = code('src/index.ts');
    const builderAt = src.indexOf('const statusDepsFor');
    const routesEnd = src.indexOf("app.get('/status/core'");
    expect(builderAt).toBeGreaterThan(-1);
    expect(routesEnd).toBeGreaterThan(builderAt);

    const statusPath = src.slice(builderAt, routesEnd);
    expect(statusPath).not.toContain('treasurySigner');
    expect(statusPath).toContain('statusTreasuryAddress');

    // And exactly one signer is CONSTRUCTED in the whole file: no second one was added.
    // Counted on the call, not on the identifier -- the import mentions it too, and an
    // assertion that cannot tell an import from a construction is not measuring the thing
    // it names.
    const constructions = [...src.matchAll(/createTreasurySigner\s*\(/g)];
    expect(constructions.length).toBe(1);
  });

  it('the core route asks the endpoint for its chain id rather than reading configuration', () => {
    // `getNetwork()` answers from the configured value under staticNetwork, which is how
    // the pool's admission gate came to compare a constant to itself.
    const src = code('src/index.ts');
    const builderAt = src.indexOf('const statusDepsFor');
    const routesEnd = src.indexOf("app.get('/status/core'");
    const statusPath = src.slice(builderAt, routesEnd);
    expect(statusPath).toContain("send('eth_chainId'");
    expect(statusPath).not.toContain('getNetwork()');
  });

  it('the launch path does not import the core validator as a substitute for its own checks', () => {
    // The endpoint may become an ADDITIONAL gate. It must never become a weaker one: an
    // endpoint that says yes is easier to satisfy than a chain that does.
    const launch = code('scripts/phase-b-launch.ts');
    expect(launch).not.toContain('coreValidator');
    expect(launch).not.toContain('fetchAndValidateCore');
    expect(launch).not.toContain('/status/core');
  });

  it('phase-b-launch still performs its own live preflight, unchanged', () => {
    const launch = code('scripts/phase-b-launch.ts');
    // The direct checks that must not be replaced by a status endpoint.
    expect(launch).toContain('assertDeploymentIdentity');
    expect(launch).toContain('getLaunchReadiness');
    expect(launch).toContain('getLiveFeeWei');
  });
});
