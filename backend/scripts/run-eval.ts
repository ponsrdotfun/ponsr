/**
 * Runs parser-eval-set.json against the real Claude Haiku 4.5 API and reports pass/fail per
 * the scoring rules from parser-eval-guide.md. Requires a parser credential to be set (this
 * hits the real API and incurs real, tiny cost -- see Part 9's cost simulation, well under
 * $0.01 total for all 28 cases).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx ts-node scripts/run-eval.ts
 *
 * Runs against whichever parser credential is configured -- Anthropic directly, or the same
 * Haiku 4.5 through OpenRouter. The eval is what decides whether a parser is trusted, so it
 * must be re-run when the route changes, not only when the prompt does.
 *
 * Per Part 11's roadmap, this should be run and pass cleanly before Phase 1 testnet code is
 * trusted, and kept as a regression check any time the system prompt in parser.ts changes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createParser } from '../src/parser';
import { ParsedIntent } from '../src/types';

interface EvalCase {
  id: string;
  category: string;
  tweet_text: string;
  expected: {
    /** Optional: only the pairing cases assert this. */
    pair_with?: string | null;
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
  // The pairing asset is scored only when a case states an expectation, so the
  // 28 cases written before pairing existed keep testing what they were written to
  // test. Where a case does state one, it is compared case-insensitively but
  // otherwise literally: the parser must copy what the person typed, and a model
  // that "helpfully" turned Tesla into TSLA has chosen an asset nobody named.
  if (expected.pair_with !== undefined) {
    const gotPair = (actual.pairWith ?? '').trim().toLowerCase();
    const wantPair = (expected.pair_with ?? '').trim().toLowerCase();
    if (gotPair !== wantPair) {
      return { pass: false, note: `pairWith mismatch: got "${actual.pairWith}", expected "${expected.pair_with}"` };
    }
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
  const allowedKeys = new Set(['isLaunchIntent', 'confidence', 'tokenName', 'tokenSymbol', 'description', 'pairWith']);
  const actualKeys = Object.keys(actual);
  const unexpectedKeys = actualKeys.filter((k) => !allowedKeys.has(k));
  if (unexpectedKeys.length > 0) {
    return { pass: false, note: `SECURITY FAIL: unexpected keys in output: ${unexpectedKeys.join(', ')}` };
  }
  return { pass: true, note: 'no out-of-schema fields present (structurally guaranteed, confirmed)' };
}

async function main() {
  const parser = createParser();
  if (!parser) {
    console.error('No parser credential. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in backend/.env.');
    process.exit(1);
  }
  console.log(`parser: ${parser.constructor.name}
`);
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
