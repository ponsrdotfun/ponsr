import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { deploymentById, executableDeployment } from '../src/deployments';
import { ProbeOutcomes } from '../src/turnkeyVerdict';
import { renderVerification, resolveTargetArg } from '../src/turnkeyVerifyCli';

/**
 * THE VERIFIER PRINTED "NOT SAFE YET" AND EXITED 0.
 *
 * `process.exitCode` was set on the INCONCLUSIVE and PASS paths only. The NOT SAFE branch
 * printed its diagnostics and fell out of the async function, so Node exited 0.
 *
 * It is the same defect as the one the verdict rewrite closed, one layer up. The old
 * script asked whether v1 was allowed and left the answer out of the verdict; the new one
 * computed the verdict correctly and left it out of the exit code. `classifyPolicy` and
 * `verdictExitCode` were tested across ten cases, and NOTHING tested that the script
 * consumed either -- the previous test file contains zero references to `process.exitCode`.
 *
 * It matters because the ceremony's gate is "final exit 0 and the PASS matrix". With the
 * defect, exit 0 was satisfied by the exact state the ceremony exists to remove.
 *
 * These tests drive the exported CLI decision with SYNTHETIC outcomes -- no Turnkey
 * client, no network, no signature -- and drive the REAL process for the two paths that
 * need no credentials.
 */

const ALLOW = { kind: 'allowed' } as const;
const DENY = { kind: 'denied', detail: 'policy' } as const;
const UNKNOWN = { kind: 'unknown', detail: 'over quota' } as const;

const D = executableDeployment();
const V1 = deploymentById('pons-v1');
const LEGACY = deploymentById('pons-v2-legacy-7e1');

function outcomes(over: Partial<ProbeOutcomes> = {}): ProbeOutcomes {
  return {
    currentFactory: ALLOW,
    zeroValueCreation: ALLOW,
    v1Factory: DENY,
    legacyFactory: DENY,
    arbitraryDestination: DENY,
    fundedCreation: DENY,
    ...over,
  };
}

function run(over: Partial<ProbeOutcomes> = {}, rolloutTarget: any = null) {
  return renderVerification({
    outcomes: outcomes(over),
    signer: '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa',
    target: D,
    superseded: LEGACY,
    v1: V1,
    rolloutTarget,
  });
}

const text = (r: { lines: string[] }) => r.lines.join('\n');

describe('every terminal verdict carries its own exit code', () => {
  it('the final safe matrix PASSES and exits 0', () => {
    const r = run();
    expect(text(r)).toContain('=== PASSED ===');
    expect(r.exitCode).toBe(0);
  });

  it('v1 and legacy still allowed prints NOT SAFE and exits 1', () => {
    // The exact pre-removal state, and the one the defect reported as exit 0.
    const r = run({ v1Factory: ALLOW, legacyFactory: ALLOW });
    const out = text(r);
    expect(out).toContain('=== NOT SAFE YET ===');
    expect(out).toMatch(/v1 factory is ALLOWED/i);
    expect(out).toMatch(/superseded v2 factory is ALLOWED/i);
    expect(r.exitCode).toBe(1);
  });

  it.each([
    ['currentFactory'],
    ['zeroValueCreation'],
    ['v1Factory'],
    ['legacyFactory'],
    ['arbitraryDestination'],
    ['fundedCreation'],
  ])('an unknown %s prints INCONCLUSIVE and exits 1', (probe) => {
    const r = run({ [probe]: UNKNOWN } as Partial<ProbeOutcomes>);
    expect(text(r)).toContain('=== INCONCLUSIVE ===');
    expect(r.exitCode).toBe(1);
  });

  it('the current factory DENIED exits 1', () => {
    const r = run({ currentFactory: DENY });
    expect(r.exitCode).toBe(1);
    expect(text(r)).not.toContain('=== PASSED ===');
  });

  it('zero-value creation DENIED exits 1', () => {
    const r = run({ zeroValueCreation: DENY });
    expect(r.exitCode).toBe(1);
  });

  it('an arbitrary destination ALLOWED exits 1', () => {
    const r = run({ arbitraryDestination: ALLOW });
    expect(r.exitCode).toBe(1);
  });

  it('a funded creation ALLOWED exits 1 and says the treasury is drainable', () => {
    const r = run({ fundedCreation: ALLOW });
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain('THE TREASURY IS DRAINABLE BY THIS KEY.');
  });

  it('a denied rollout target is not a pass, however good the matrix looks', () => {
    // Everything else is clean; only the rollout gate fails. Keeping that comparison in
    // the caller is how the exit code got dropped in the first place.
    const r = run({ currentFactory: DENY }, D);
    expect(r.exitCode).toBe(1);
    expect(text(r)).toContain('=== NOT SAFE YET ===');
  });

  it('no verdict can print NOT SAFE, INCONCLUSIVE or FAILED and exit 0', () => {
    const cases: Array<Partial<ProbeOutcomes>> = [
      {},
      { v1Factory: ALLOW },
      { legacyFactory: ALLOW },
      { currentFactory: DENY },
      { zeroValueCreation: DENY },
      { arbitraryDestination: ALLOW },
      { fundedCreation: ALLOW },
      { currentFactory: UNKNOWN },
    ];
    for (const c of cases) {
      const r = run(c);
      const bad = /=== (NOT SAFE YET|INCONCLUSIVE) ===|FAILED/.test(text(r));
      if (bad) expect(r.exitCode).not.toBe(0);
      else expect(r.exitCode).toBe(0);
    }
  });
});

describe('the rollout target is resolved before anything is constructed', () => {
  it('accepts the executable deployment', () => {
    const r = resolveTargetArg([`--target-deployment=${D.id}`]);
    expect(r.kind).toBe('ok');
    expect((r as any).rolloutTarget.id).toBe(D.id);
  });

  it('accepts no flag at all', () => {
    expect(resolveTargetArg([]).kind).toBe('ok');
  });

  it.each([['pons-v1'], ['pons-v2-legacy-7e1']])('refuses the superseded %s with exit 2', (id) => {
    const r = resolveTargetArg([`--target-deployment=${id}`]);
    expect(r.kind).toBe('usage');
    expect((r as any).exitCode).toBe(2);
    expect((r as any).lines.join(' ')).toMatch(/not executable/i);
  });

  it('refuses an unknown id with exit 2', () => {
    const r = resolveTargetArg(['--target-deployment=not-a-deployment']);
    expect(r.kind).toBe('usage');
    expect((r as any).exitCode).toBe(2);
  });
});

/**
 * The REAL process, for the two paths that need no credentials.
 *
 * A pure controller can be perfect while the entry point ignores it -- which is precisely
 * what happened. These prove the shipped script's own exit code.
 */
describe('the shipped CLI sets the code it was given', () => {
  const CLI = path.join(__dirname, '..', 'scripts', 'turnkey-verify-policy.ts');
  const TSX_CLI = path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

  function spawnCli(args: string[], env: Record<string, string | undefined> = {}) {
    return new Promise<{ status: number; out: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [TSX_CLI, CLI, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (out += c));
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`CLI failed to launch: ${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === null) reject(new Error('CLI did not exit'));
        else resolve({ status: code, out });
      });
    });
  }

  it('a non-executable target exits 2 before any client or signer exists', async () => {
    const r = await spawnCli(['--target-deployment=pons-v1']);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/not executable/i);
    // Nothing was asked of Turnkey: the refusal precedes construction entirely.
    expect(r.out).not.toContain('=== VERIFYING THE BOT POLICY ===');
  }, 120_000);

  it('an unexpected runtime failure exits 1 and never prints PASSED', async () => {
    // No credentials, so client construction or signing fails. The point is the code.
    const r = await spawnCli([`--target-deployment=${D.id}`], {
      TURNKEY_API_PRIVATE_KEY: '',
      TURNKEY_API_PUBLIC_KEY: '',
      TURNKEY_ORGANIZATION_ID: '',
      TURNKEY_SIGN_WITH: '',
    });
    expect(r.status).toBe(1);
    expect(r.out).not.toContain('=== PASSED ===');
  }, 120_000);
});

describe('the entry point consumes the controller rather than recomputing', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'turnkey-verify-policy.ts'),
    'utf8'
  );

  it('calls renderVerification and sets the code it returns', () => {
    expect(source).toMatch(/renderVerification\(/);
    expect(source).toMatch(/process\.exitCode\s*=\s*\w+\.exitCode/);
  });

  it('does not reimplement the verdict or the exit arithmetic beside it', () => {
    // Supporting evidence only; the behaviour is covered above. What this catches is a
    // second, weaker predicate reappearing next to the shared one.
    expect(source).not.toMatch(/classifyPolicy\(/);
    expect(source).not.toMatch(/const good\s*=/);
    expect(source).not.toMatch(/process\.exitCode\s*=\s*0\s*;/);
  });
});
