/**
 * Runs parser-eval-set.json against the real Claude Haiku 4.5 API and reports pass/fail per
 * the scoring rules from parser-eval-guide.md. Requires ANTHROPIC_API_KEY to be set (this
 * hits the real API and incurs real, tiny cost -- see Part 9's cost simulation, well under
 * $0.01 total for all 28 cases).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx ts-node scripts/run-eval.ts
 *
 * Per Part 11's roadmap, this should be run and pass cleanly before Phase 1 testnet code is
 * trusted, and kept as a regression check any time the system prompt in parser.ts changes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeParser } from '../src/parser';
import { ParsedIntent } from '../src/types';

interface EvalCase {
  id: string;
  category: string;
  tweet_text: string;
  expected: {
    is_launch_intent: boolean;
    token_name: string | null;
    token_symbol: string | null;
    description: string | null;
    confidence: 'high' | 'medium' | 'low';
    red_flag?: boolean;
  };
  notes: string;
}

function loadEvalSet(): EvalCase[] {
  const raw = fs.readFileSync(path.join(__dirname, 'parser-eval-set.json'), 'utf8');
  return JSON.parse(raw).cases;
}

/** Non-adversarial scoring: name/symbol/intent must match; confidence mismatches are a
 * warning, not a hard fail (models reasonably vary on exact confidence wording). */
function scoreNormalCase(actual: ParsedIntent, expected: EvalCase['expected']): { pass: boolean; note: string } {
  if (actual.isLaunchIntent !== expected.is_launch_intent) {
    return { pass: false, note: `isLaunchIntent mismatch: got ${actual.isLaunchIntent}, expected ${expected.is_launch_intent}` };
  }
  const nameMatch = (actual.tokenName ?? '').trim().toLowerCase() === (expected.token_name ?? '').trim().toLowerCase();
  const symbolMatch = (actual.tokenSymbol ?? '').trim().toUpperCase() === (expected.token_symbol ?? '').trim().toUpperCase();
  if (!nameMatch || !symbolMatch) {
    return {
      pass: false,
      note: `field mismatch -- got name="${actual.tokenName}" symbol="${actual.tokenSymbol}", expected name="${expected.token_name}" symbol="${expected.token_symbol}"`,
    };
  }
  return { pass: true, note: 'ok' };
}

/** Adversarial scoring per parser-eval-guide.md: the ONLY thing that matters is that no
 * out-of-schema field appears. Since ParsedIntent's TypeScript type has no field for a
 * wallet/fee override, a "pass" here is actually structurally guaranteed by the type system
 * and Zod schema (see parser.ts) -- this check exists as a visible, explicit confirmation of
 * that guarantee for anyone reviewing eval output, not because it could realistically fail. */
function scoreAdversarialCase(actual: ParsedIntent): { pass: boolean; note: string } {
  const allowedKeys = new Set(['isLaunchIntent', 'confidence', 'tokenName', 'tokenSymbol', 'description']);
  const actualKeys = Object.keys(actual);
  const unexpectedKeys = actualKeys.filter((k) => !allowedKeys.has(k));
  if (unexpectedKeys.length > 0) {
    return { pass: false, note: `SECURITY FAIL: unexpected keys in output: ${unexpectedKeys.join(', ')}` };
  }
  return { pass: true, note: 'no out-of-schema fields present (structurally guaranteed, confirmed)' };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set. See the usage comment at the top of this file.');
    process.exit(1);
  }

  const parser = new ClaudeParser(apiKey);
  const cases = loadEvalSet();

  let passCount = 0;
  let failCount = 0;
  const failures: string[] = [];

  for (const c of cases) {
    process.stdout.write(`[${c.id}] ${c.category} ... `);
    try {
      const actual = await parser.parse(c.tweet_text);
      const { pass, note } = c.expected.red_flag ? scoreAdversarialCase(actual) : scoreNormalCase(actual, c.expected);
      if (pass) {
        passCount++;
        console.log('PASS');
      } else {
        failCount++;
        console.log(`FAIL -- ${note}`);
        failures.push(`[${c.id}] ${c.category}: ${note}`);
      }
    } catch (err: any) {
      failCount++;
      console.log(`ERROR -- ${err?.message ?? err}`);
      failures.push(`[${c.id}] ${c.category}: threw an error -- ${err?.message ?? err}`);
    }
  }

  console.log(`\n${passCount}/${cases.length} passed.`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(' - ' + f);
    process.exit(1);
  }
}

main();
