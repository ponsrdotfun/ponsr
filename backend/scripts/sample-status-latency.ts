/**
 * A keyless latency sampler for `/status` and `/status/core`.
 *
 * READ-ONLY. Two HTTP GETs per sample, no credentials, no config, no signer, no writes.
 *
 * WHY IT REFUSES TO BE HELPFUL IN THE WRONG WAY
 * ---------------------------------------------
 * It never discards a failed sample and never loops until a clean set appears. Both would
 * turn a measurement into a way of proving whatever you hoped. Every sample -- including
 * failures, timeouts and non-200s -- is written out, and the pass/fail arithmetic is
 * printed alongside so it can be checked rather than trusted.
 *
 * The whole point of the core split is that `/status/core` should stay fast when `/status`
 * does not, so both are timed in the same sample and the difference is the evidence.
 *
 * Usage:
 *   npx tsx scripts/sample-status-latency.ts --url https://ponsr-backend.fly.dev
 *   npx tsx scripts/sample-status-latency.ts --url <base> --samples 10 --interval-ms 3000 \
 *       --out samples.jsonl --csv samples.csv
 */
import * as fs from 'fs';
import { csvRow, safeChecks, safeDependencies } from '../src/sampleGuards';
import { parseArgInteger } from '../src/strictParse';

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

interface Sample {
  n: number;
  utc: string;
  corePath: string;
  coreStatus: number | null;
  coreMs: number;
  coreOk: boolean | null;
  coreProblems: string[];
  coreElapsedMs: number | null;
  fullStatus: number | null;
  fullMs: number;
  fullState: string | null;
  fullNonOk: string[];
  slowestDependency: string | null;
  slowestDependencyMs: number | null;
  error: string | null;
}

/** One bounded GET. A timeout is recorded, never retried. */
async function get(url: string, timeoutMs: number): Promise<{ status: number | null; ms: number; body: any; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, ms: Date.now() - started, body, error: null };
  } catch {
    // The thrown value is not recorded: a fetch error carries the URL, and a base URL can
    // carry credentials.
    return { status: null, ms: Date.now() - started, body: null, error: 'request-failed-or-timed-out' };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const base = flag('--url');
  if (!base) {
    console.error('usage: sample-status-latency.ts --url <base-url> [--samples N] [--interval-ms N]');
    console.error('       [--timeout-ms N] [--out file.jsonl] [--csv file.csv] [--budget-ms N]');
    process.exit(2);
  }
  // Strict parsing. `--samples NaN` and `--timeout-ms -1` are refused rather than silently
  // becoming a nonsense bound, and the offending value is never echoed back.
  const arg = (name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    const raw = flag(name);
    if (raw === undefined) return fallback;
    const v = parseArgInteger(raw, min, max);
    if (v === null) {
      console.error(`sample-status-latency: ${name} must be an integer between ${min} and ${max}`);
      process.exit(2);
    }
    return v;
  };
  const n = arg('--samples', 10, 1, 1000);
  const interval = arg('--interval-ms', 3000, 0, 3_600_000);
  const timeoutMs = arg('--timeout-ms', 20_000, 1, 600_000);
  const budget = arg('--budget-ms', 5000, 1, 600_000);
  const corePath = flag('--core-path') ?? '/status/core';
  const root = base.replace(/\/+$/, '');

  const samples: Sample[] = [];
  for (let i = 1; i <= n; i++) {
    const core = await get(`${root}${corePath}`, timeoutMs);
    const full = await get(`${root}/status`, timeoutMs);
    // Shape-validated before anything is read off it. A null row or a wrong-typed element
    // used to be dereferenced directly, so one odd response could abort the whole run --
    // turning "the endpoint answered something strange" into "we have no data", which is
    // the worst outcome for a measurement tool.
    const deps = safeDependencies(full.body?.dependencies);
    const checks = safeChecks(full.body?.checks);
    const slowest = deps.length ? deps.reduce((a, b) => (b.ms > a.ms ? b : a)) : null;

    const s: Sample = {
      n: i,
      utc: new Date().toISOString(),
      corePath,
      coreStatus: core.status,
      coreMs: core.ms,
      coreOk: typeof core.body?.ok === 'boolean' ? core.body.ok : null,
      coreProblems: Array.isArray(core.body?.problems)
        ? core.body.problems.filter((p: unknown): p is string => typeof p === 'string').slice(0, 20)
        : [],
      coreElapsedMs:
        typeof core.body?.elapsedMs === 'number' && Number.isFinite(core.body.elapsedMs)
          ? core.body.elapsedMs
          : null,
      fullStatus: full.status,
      fullMs: full.ms,
      fullState: typeof full.body?.state === 'string' ? full.body.state : null,
      fullNonOk: checks.filter((c) => c.state !== 'ok').map((c) => c.name),
      slowestDependency: slowest?.name ?? null,
      slowestDependencyMs: slowest?.ms ?? null,
      error: core.error ?? full.error,
    };
    samples.push(s);
    console.log(
      `  sample ${String(i).padStart(2)}  core ${String(s.coreStatus).padStart(3)} ${String(s.coreMs).padStart(6)}ms ok=${s.coreOk}` +
        `   full ${String(s.fullStatus).padStart(3)} ${String(s.fullMs).padStart(6)}ms  non-ok ${s.fullNonOk.join(',') || '-'}` +
        `   slowest ${s.slowestDependency ?? '-'} ${s.slowestDependencyMs ?? '-'}ms`
    );
    if (i < n) await new Promise((r) => setTimeout(r, interval));
  }

  const out = flag('--out');
  if (out) fs.writeFileSync(out, samples.map((s) => JSON.stringify(s)).join('\n') + '\n');
  const csv = flag('--csv');
  if (csv) {
    // RFC 4180 quoting, and a leading apostrophe on anything a spreadsheet would execute
    // as a formula. Joining raw strings with commas shifts every column after a field that
    // contains one, and `=cmd()` arriving in a public response becomes code in whatever the
    // operator opens the file with.
    const cols = Object.keys(samples[0]) as (keyof Sample)[];
    const rows = [csvRow(cols)].concat(
      samples.map((s) => csvRow(cols.map((c) => (Array.isArray(s[c]) ? (s[c] as string[]).join('|') : s[c]))))
    );
    fs.writeFileSync(csv, rows.join('\n') + '\n');
  }

  // The arithmetic, printed so it can be checked rather than taken on faith.
  const coreOk = samples.filter((s) => s.coreStatus === 200 && s.coreOk === true).length;
  const fullOk = samples.filter((s) => s.fullStatus === 200).length;
  const coreUnder = samples.filter((s) => s.coreMs < budget).length;
  const fullUnder = samples.filter((s) => s.fullMs < budget).length;
  const onlyPause = samples.filter(
    (s) => s.fullNonOk.length === 1 && s.fullNonOk[0] === 'public-launches'
  ).length;

  console.log(`\n  samples                     ${samples.length}`);
  console.log(`  core 200 and ok             ${coreOk}/${samples.length}`);
  console.log(`  core under ${budget}ms            ${coreUnder}/${samples.length}   max ${Math.max(...samples.map((s) => s.coreMs))}ms`);
  console.log(`  full 200                    ${fullOk}/${samples.length}`);
  console.log(`  full under ${budget}ms            ${fullUnder}/${samples.length}   max ${Math.max(...samples.map((s) => s.fullMs))}ms`);
  console.log(`  full: only public-launches  ${onlyPause}/${samples.length}`);
  const tally: Record<string, number> = {};
  for (const s of samples) if (s.slowestDependency) tally[s.slowestDependency] = (tally[s.slowestDependency] ?? 0) + 1;
  if (Object.keys(tally).length) {
    console.log('  slowest dependency, tallied:');
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(20)} ${v}/${samples.length}`);
    }
  }
  console.log('\n  No sample was discarded and nothing was retried.');
}

main().catch(() => {
  console.error('sample-status-latency: sampling could not be completed');
  process.exit(2);
});
