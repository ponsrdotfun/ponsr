/**
 * A keyless latency and invariant sampler for `/health`, `/status/core` and `/status`.
 *
 * READ-ONLY. Three HTTP GETs per sample, no credentials, no config, no signer, no writes.
 *
 * WHY IT REFUSES TO BE HELPFUL IN THE WRONG WAY
 * ---------------------------------------------
 * It never discards a failed sample and never loops until a clean set appears. Both would
 * turn a measurement into a way of proving whatever you hoped. Every sample -- including
 * failures, timeouts and non-200s -- is written out, and the pass/fail arithmetic is
 * printed alongside so it can be checked rather than trusted.
 *
 * AN IGNORED FLAG IS A LIE WITH A COMMAND LINE ATTACHED
 * ----------------------------------------------------
 * The previous version looked up the flag names it knew and ignored everything else. A
 * production deploy brief ran it with `--expect-endpoint 78ccdeee5ef1`; that pin was never
 * checked, and the report recorded a command line asserting a property nothing had
 * measured. It is the same shape as the wrong-chain gate that asked `getNetwork()` under
 * `staticNetwork` and compared a constant to itself.
 *
 * So: UNKNOWN FLAGS ARE A USAGE ERROR, not a no-op. Every expectation is a required,
 * caller-supplied pin, and a mismatch FAILS the run rather than being printed. A response
 * field is never its own expected value -- that is a limit acting as evidence about itself.
 *
 * Exit codes:  0 = every acceptance check passed   1 = sampling ran, acceptance failed
 *              2 = usage error (nothing was sampled)
 *
 * Usage:
 *   npx tsx scripts/sample-status-latency.ts --url <base> --samples 10 --interval-ms 3000 \
 *     --expect-endpoint <fingerprint> --expect-chain 4663 \
 *     --expect-deployment pons-v2-current-7ed --expect-factory 0x... \
 *     --expect-fee-wei 500000000000000 --expect-cap-wei 10000000000000000 \
 *     --expect-treasury 0x... --expect-public-gate false \
 *     [--out samples.jsonl] [--csv samples.csv]
 */
import * as fs from 'fs';
import { csvRow, safeChecks, safeDependencies } from '../src/sampleGuards';
import { parseArgInteger, parseArgWei } from '../src/strictParse';
import { validateCoreEvidence } from '../src/coreValidator';

/** Flags taking a value. Anything else is a usage error, never a silent no-op. */
const VALUE_FLAGS = new Set([
  '--url',
  '--samples',
  '--interval-ms',
  '--timeout-ms',
  '--core-budget-ms',
  '--core-path',
  '--out',
  '--csv',
  '--expect-endpoint',
  '--expect-chain',
  '--expect-deployment',
  '--expect-factory',
  '--expect-fee-wei',
  '--expect-cap-wei',
  '--expect-treasury',
  '--expect-public-gate',
  '--require-balance-wei',
  '--max-age-ms',
  '--max-identity-age-ms',
  '--warmup-samples',
]);

/** The pins without which no run can be PASS-capable. */
const REQUIRED = [
  '--url',
  '--expect-endpoint',
  '--expect-chain',
  '--expect-deployment',
  '--expect-factory',
  '--expect-fee-wei',
  '--expect-cap-wei',
  '--expect-treasury',
  '--expect-public-gate',
  '--require-balance-wei',
];

function usage(message: string): never {
  // The offending VALUE is never echoed. A base URL can carry credentials, and so can
  // anything an operator pastes next to one.
  console.error(`sample-status-latency: ${message}`);
  console.error('usage: --url <base> --expect-endpoint <fp> --expect-chain <n> --expect-deployment <id>');
  console.error('       --expect-factory <0x..> --expect-fee-wei <n> --expect-cap-wei <n>');
  console.error('       --expect-treasury <0x..> --expect-public-gate <true|false>');
  console.error('       [--samples N] [--interval-ms N] [--timeout-ms N] [--core-budget-ms N]');
  console.error('       [--core-path P] [--out file.jsonl] [--csv file.csv]');
  process.exit(2);
}

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!name.startsWith('--')) usage('positional arguments are not accepted');
    if (!VALUE_FLAGS.has(name)) usage(`unknown flag ${name}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) usage(`${name} requires a value`);
    if (out.has(name)) usage(`${name} given more than once`);
    out.set(name, value);
    i += 1;
  }
  for (const r of REQUIRED) if (!out.has(r)) usage(`${r} is required; without it nothing is being checked`);
  return out;
}

interface Sample {
  n: number;
  utc: string;
  healthStatus: number | null;
  healthMs: number;
  corePath: string;
  coreStatus: number | null;
  coreMs: number;
  coreOk: boolean | null;
  coreSchema: string | null;
  coreVersion: number | null;
  coreProblems: string[];
  coreElapsedMs: number | null;
  observedThrough: string | null;
  endpointOrigin: string | null;
  chainId: number | null;
  block: number | null;
  deploymentId: string | null;
  factory: string | null;
  launchFeeWei: string | null;
  treasuryAddress: string | null;
  treasuryBalanceWei: string | null;
  rolling24hWei: string | null;
  capWei: string | null;
  publicLaunchEnabled: boolean | null;
  coreDependencies: string[];
  fullStatus: number | null;
  fullMs: number;
  fullState: string | null;
  fullNonOk: string[];
  slowestDependency: string | null;
  slowestDependencyMs: number | null;
  /** Every core dependency row, name and outcome, never reduced to names alone. */
  coreDependencyOutcomes: string[];
  /** Closed codes from the STRICT core contract, the same one check-core-readiness uses. */
  coreValidationFailures: string[];
  coreValidationExplanations: string[];
  /** True for samples taken before the declared warm-up ended. */
  warmup: boolean;
  /** Why this sample failed, in closed labels. Empty means it satisfied every pin. */
  failures: string[];
  verdict: 'pass' | 'fail';
  error: string | null;
}

/** One bounded GET. A timeout is recorded, never retried. */
async function get(
  url: string,
  timeoutMs: number
): Promise<{ status: number | null; ms: number; body: any; malformed: boolean; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let body: any = null;
    let malformed = false;
    try {
      body = JSON.parse(text);
    } catch {
      // Recorded as a FAILURE, not as absence. "The endpoint answered something strange"
      // and "we have no data" are different facts and an operator acts on them differently.
      malformed = true;
    }
    return { status: res.status, ms: Date.now() - started, body, malformed, error: null };
  } catch {
    // The thrown value is not recorded: a fetch error carries the URL, and a base URL can
    // carry credentials.
    return { status: null, ms: Date.now() - started, body: null, malformed: false, error: 'request-failed-or-timed-out' };
  } finally {
    clearTimeout(timer);
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
/** Wei arrives as a decimal string. A number would lose precision above 2^53. */
const wei = (v: unknown): string | null => (typeof v === 'string' && /^\d+$/.test(v) ? v : null);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = args.get(name);
    if (raw === undefined) return fallback;
    const v = parseArgInteger(raw, min, max);
    if (v === null) usage(`${name} must be an integer between ${min} and ${max}`);
    return v;
  };

  const n = integer('--samples', 10, 1, 1000);
  const interval = integer('--interval-ms', 3000, 0, 3_600_000);
  const timeoutMs = integer('--timeout-ms', 20_000, 1, 600_000);
  const coreBudget = integer('--core-budget-ms', 3000, 1, 600_000);
  const corePath = args.get('--core-path') ?? '/status/core';
  const root = args.get('--url')!.replace(/\/+$/, '');

  const warmup = integer('--warmup-samples', 0, 0, 1000);
  const maxAgeMs = integer('--max-age-ms', 30_000, 1, 3_600_000);
  const maxIdentityAgeMs = integer('--max-identity-age-ms', 15 * 60 * 1000, 1, 24 * 3_600_000);
  const requireBalanceWei = parseArgWei(args.get('--require-balance-wei')!);
  if (requireBalanceWei === null) usage('--require-balance-wei must be a decimal wei amount');
  const expectedChain = parseArgInteger(args.get('--expect-chain')!, 1, Number.MAX_SAFE_INTEGER);
  if (expectedChain === null) usage('--expect-chain must be a positive integer');
  const gateRaw = args.get('--expect-public-gate')!.trim().toLowerCase();
  if (gateRaw !== 'true' && gateRaw !== 'false') usage('--expect-public-gate must be true or false');
  const expectedFeeWei = parseArgWei(args.get('--expect-fee-wei')!);
  const expectedCapWei = parseArgWei(args.get('--expect-cap-wei')!);
  if (expectedFeeWei === null) usage('--expect-fee-wei must be a decimal wei amount');
  if (expectedCapWei === null) usage('--expect-cap-wei must be a decimal wei amount');
  const expected = {
    endpoint: args.get('--expect-endpoint')!,
    chain: expectedChain,
    deployment: args.get('--expect-deployment')!,
    factory: args.get('--expect-factory')!.toLowerCase(),
    feeWei: args.get('--expect-fee-wei')!,
    capWei: args.get('--expect-cap-wei')!,
    treasury: args.get('--expect-treasury')!.toLowerCase(),
    gate: gateRaw === 'true',
  };

  const samples: Sample[] = [];
  for (let i = 1; i <= n; i++) {
    // Exactly once each, in order, no retries.
    const health = await get(`${root}/health`, timeoutMs);
    const core = await get(`${root}${corePath}`, timeoutMs);
    const full = await get(`${root}/status`, timeoutMs);

    const c = core.malformed ? null : core.body;

    /**
     * THE SAME STRICT CONTRACT `check-core-readiness.ts` USES, not a second weaker one.
     *
     * Pinning the top-level fields by hand was not enough: it accepted `ok: true` beside
     * contradictory readiness, an unreadable or stale identity, a treasury below the
     * canary floor, a rolling spend at the cap, a non-canonical timestamp, an origin
     * carrying a path, and a core dependency that had timed out. Every one of those is a
     * document the producer should never emit -- which is exactly the assumption a
     * validator exists to stop making.
     */
    const validation = validateCoreEvidence(
      c,
      {
        expectedChainId: expected.chain,
        expectedDeploymentId: expected.deployment,
        expectedFactory: expected.factory,
        expectedLaunchFeeWei: expectedFeeWei,
        expectedCapWei: expectedCapWei,
        expectedTreasury: expected.treasury,
        requiredTreasuryBalanceWei: requireBalanceWei,
        expectedEndpointFingerprint: expected.endpoint,
        expectPublicLaunchEnabled: expected.gate,
        maxAgeMs,
        maxIdentityAgeMs,
      },
      core.ms
    );
    const deps = safeDependencies(full.body?.dependencies);
    const checks = safeChecks(full.body?.checks);
    const slowest = deps.length ? deps.reduce((a, b) => (b.ms > a.ms ? b : a)) : null;

    const s: Sample = {
      n: i,
      utc: new Date().toISOString(),
      healthStatus: health.status,
      healthMs: health.ms,
      corePath,
      coreStatus: core.status,
      coreMs: core.ms,
      coreOk: bool(c?.ok),
      coreSchema: str(c?.schema),
      coreVersion: num(c?.version),
      coreProblems: Array.isArray(c?.problems)
        ? c.problems.filter((p: unknown): p is string => typeof p === 'string').slice(0, 20)
        : [],
      coreElapsedMs: num(c?.elapsedMs),
      observedThrough: str(c?.observedThrough),
      endpointOrigin: str(c?.endpointOrigin),
      chainId: num(c?.chainId),
      block: num(c?.block),
      deploymentId: str(c?.deploymentId),
      factory: str(c?.factory),
      launchFeeWei: wei(c?.launchFeeWei),
      treasuryAddress: str(c?.treasuryAddress),
      treasuryBalanceWei: wei(c?.treasuryBalanceWei),
      rolling24hWei: wei(c?.rolling24hWei),
      capWei: wei(c?.capWei),
      publicLaunchEnabled: bool(c?.publicLaunchEnabled),
      coreDependencies: Array.isArray(c?.dependencies)
        ? c.dependencies.map((d: any) => String(d?.name ?? '?')).slice(0, 30)
        : [],
      // Name AND outcome. Reducing rows to names before deciding PASS is how a core whose
      // `chain` row said `timed-out` sat beside `ok: true` and was accepted.
      coreDependencyOutcomes: Array.isArray(c?.dependencies)
        ? c.dependencies.map((d: any) => `${String(d?.name ?? '?')}=${String(d?.outcome ?? '?')}`).slice(0, 30)
        : [],
      coreValidationFailures: validation.failures.slice(0, 30),
      // Built from public facts only by the validator itself; no response value is echoed.
      coreValidationExplanations: validation.explanations.slice(0, 30),
      warmup: i <= warmup,
      fullStatus: full.status,
      fullMs: full.ms,
      fullState: str(full.body?.state),
      fullNonOk: checks.filter((ch) => ch.state !== 'ok').map((ch) => ch.name),
      slowestDependency: slowest?.name ?? null,
      slowestDependencyMs: slowest?.ms ?? null,
      failures: [],
      verdict: 'fail',
      error: health.error ?? core.error ?? full.error,
    };

    // Every pin, compared against the CALLER's value. Nothing here reads an expectation
    // out of the response it is judging.
    const f = s.failures;
    if (s.healthStatus !== 200) f.push('health-not-200');
    if (s.coreStatus !== 200) f.push('core-not-200');
    if (core.malformed) f.push('core-malformed');
    // The strict contract is the authority. The hand-written pins below stay because they
    // name the failure in this tool's own vocabulary, but nothing passes without this.
    if (!validation.pass) f.push('core-invalid');
    if (s.coreOk !== true) f.push('core-not-ok');
    if (s.coreProblems.length > 0) f.push('core-problems');
    if (s.coreSchema !== 'ponsr.status-core' || s.coreVersion !== 1) f.push('core-contract');
    if (s.coreMs >= coreBudget) f.push('core-over-budget');
    if (s.observedThrough !== expected.endpoint) f.push('endpoint-mismatch');
    if (!s.endpointOrigin) f.push('endpoint-origin-missing');
    if (s.chainId !== expected.chain) f.push('chain-mismatch');
    if (s.block === null || s.block <= 0) f.push('block-not-positive');
    if (s.deploymentId !== expected.deployment) f.push('deployment-mismatch');
    if ((s.factory ?? '').toLowerCase() !== expected.factory) f.push('factory-mismatch');
    if (s.launchFeeWei !== expected.feeWei) f.push('fee-mismatch');
    if (s.capWei !== expected.capWei) f.push('cap-mismatch');
    if ((s.treasuryAddress ?? '').toLowerCase() !== expected.treasury) f.push('treasury-mismatch');
    if (s.treasuryBalanceWei === null) f.push('treasury-balance-unreadable');
    if (s.rolling24hWei === null) f.push('rolling-spend-unknown');
    if (s.publicLaunchEnabled !== expected.gate) f.push('public-gate-mismatch');
    // Steady state, after any declared warm-up: only the intended pause may be degraded.
    if (!s.warmup && !(s.fullNonOk.length === 1 && s.fullNonOk[0] === 'public-launches')) {
      f.push('unexpected-degraded-check');
    }
    // The whole point of the core split: optional telemetry must not be in the core.
    if (s.coreDependencies.some((d) => d === 'read-credits' || d === 'pair-assets')) {
      f.push('core-carries-optional-telemetry');
    }
    if (s.fullStatus !== 200) f.push('full-not-200');
    s.verdict = f.length === 0 ? 'pass' : 'fail';

    samples.push(s);
    console.log(
      `  sample ${String(i).padStart(2)}  health ${String(s.healthStatus).padStart(3)} ${String(s.healthMs).padStart(5)}ms` +
        `  core ${String(s.coreStatus).padStart(3)} ${String(s.coreMs).padStart(6)}ms ok=${s.coreOk}` +
        `  full ${String(s.fullStatus).padStart(3)} ${String(s.fullMs).padStart(6)}ms` +
        `  non-ok ${s.fullNonOk.join(',') || '-'}` +
        `  slowest ${s.slowestDependency ?? '-'} ${s.slowestDependencyMs ?? '-'}ms` +
        `  ${s.verdict.toUpperCase()}${f.length ? ' ' + f.join(',') : ''}`
    );
    if (i < n) await new Promise((r) => setTimeout(r, interval));
  }

  const cols = Object.keys(samples[0]) as (keyof Sample)[];
  const out = args.get('--out');
  if (out) fs.writeFileSync(out, samples.map((s) => JSON.stringify(s)).join('\n') + '\n');
  const csv = args.get('--csv');
  if (csv) {
    // RFC 4180 quoting, and a leading apostrophe on anything a spreadsheet would execute
    // as a formula. Joining raw strings with commas shifts every column after a field that
    // contains one, and `=cmd()` arriving in a public response becomes code in whatever the
    // operator opens the file with.
    const rows = [csvRow(cols)].concat(
      samples.map((s) => csvRow(cols.map((c) => (Array.isArray(s[c]) ? (s[c] as string[]).join('|') : s[c]))))
    );
    fs.writeFileSync(csv, rows.join('\n') + '\n');
  }

  // The arithmetic, printed so it can be checked rather than taken on faith.
  const total = samples.length;
  const count = (p: (s: Sample) => boolean) => samples.filter(p).length;
  const healthOk = count((s) => s.healthStatus === 200);
  const coreOk = count((s) => s.coreStatus === 200 && s.coreOk === true);
  const coreUnder = count((s) => s.coreMs < coreBudget);
  const fullOk = count((s) => s.fullStatus === 200);
  const under45 = count((s) => s.fullMs < 4500);
  const under50 = count((s) => s.fullMs < 5000);
  const onlyPause = count((s) => s.fullNonOk.length === 1 && s.fullNonOk[0] === 'public-launches');
  const passed = count((s) => s.verdict === 'pass');

  // Continuity is about the pinned values holding for EVERY sample, not about the last one.
  const invariantOk = count((s) =>
    !s.failures.some((x) =>
      ['endpoint-mismatch', 'chain-mismatch', 'deployment-mismatch', 'factory-mismatch',
       'fee-mismatch', 'cap-mismatch', 'treasury-mismatch', 'public-gate-mismatch'].includes(x)
    )
  );

  /**
   * Progression, defined honestly.
   *
   * One response proves an observed block and nothing else. Requiring EVERY adjacent pair
   * to advance would fail a correct chain sampled faster than it produces blocks, so the
   * claim is the weaker true one: some later observation is higher than some earlier one.
   */
  const blocks = samples.map((s) => s.block).filter((b): b is number => b !== null && b > 0);
  const progressed = blocks.some((b, i) => blocks.slice(0, i).some((earlier) => b > earlier));

  console.log(`\n  samples                       ${total}`);
  console.log(`  /health 200                   ${healthOk}/${total}`);
  console.log(`  core 200 and ok               ${coreOk}/${total}`);
  console.log(`  core under ${coreBudget}ms              ${coreUnder}/${total}   max ${Math.max(...samples.map((s) => s.coreMs))}ms`);
  console.log(`  full status 200               ${fullOk}/${total}`);
  console.log(`  full under 4.5s               ${under45}/${total}`);
  console.log(`  full under 5.0s               ${under50}/${total}   max ${Math.max(...samples.map((s) => s.fullMs))}ms`);
  console.log(`  invariant continuity          ${invariantOk}/${total}`);
  console.log(`  block progression             ${progressed ? 'YES' : 'NO'}   observed ${blocks.length ? `${Math.min(...blocks)} -> ${Math.max(...blocks)}` : 'none'}`);
  console.log(`  full: only public-launches    ${onlyPause}/${total}`);
  console.log(`  samples satisfying every pin  ${passed}/${total}`);

  const tally: Record<string, number> = {};
  for (const s of samples) if (s.slowestDependency) tally[s.slowestDependency] = (tally[s.slowestDependency] ?? 0) + 1;
  if (Object.keys(tally).length) {
    console.log('  slowest dependency, tallied:');
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(20)} ${v}/${total}`);
    }
  }

  const failed = samples.flatMap((s) => s.failures);
  if (failed.length) {
    const reasons: Record<string, number> = {};
    for (const r of failed) reasons[r] = (reasons[r] ?? 0) + 1;
    console.log('\n  failures, tallied:');
    for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(34)} ${v}`);
    }
  }

  console.log('\n  No sample was discarded and nothing was retried.');

  /**
   * Warm-up is EXPLICIT, RECORDED, and discards nothing.
   *
   * A deploy-time run once failed the steady-state condition because pair discovery had
   * not finished, and the honest answer was to say so rather than to widen the gate. So a
   * warm-up may be DECLARED with `--warmup-samples`; those samples stay in the artifacts,
   * stay in every latency count, and simply do not carry the steady-state requirement.
   * With no flag the warm-up is zero and all ten samples must be clean.
   */
  const steady = samples.filter((x) => !x.warmup);
  const steadyOnlyPause = steady.filter(
    (x) => x.fullNonOk.length === 1 && x.fullNonOk[0] === 'public-launches'
  ).length;
  const coreValid = count((x) => x.coreValidationFailures.length === 0);

  console.log(`  strict core validation        ${coreValid}/${total}`);
  console.log(`  steady-state only public-launches  ${steadyOnlyPause}/${steady.length}` +
    (warmup > 0 ? `   (${warmup} declared warm-up sample(s), kept, not counted here)` : ''));

  const acceptance =
    passed === total &&
    healthOk === total &&
    coreOk === total &&
    coreValid === total &&
    coreUnder === total &&
    fullOk === total &&
    under50 === total &&
    under45 >= Math.ceil(total * 0.9) &&
    invariantOk === total &&
    steady.length > 0 &&
    steadyOnlyPause === steady.length &&
    progressed;
  console.log(`  VERDICT: ${acceptance ? 'PASS' : 'FAIL'}`);
  console.log('  This grants no signing or financial authority.');
  process.exitCode = acceptance ? 0 : 1;
}

main().catch(() => {
  console.error('sample-status-latency: sampling could not be completed');
  process.exit(2);
});
