import * as fs from 'fs';
import * as path from 'path';
import {
  ALL_PROBES,
  ProbeName,
  ProbeOutcomes,
  classifyPolicy,
  verdictExitCode,
} from '../src/turnkeyVerdict';

/**
 * THE VERIFIER COULD PRINT "PASSED" WHILE V1 WAS STILL ALLOWED.
 *
 * It asked the question, printed the answer, counted it toward the "could not ask" tally,
 * and then left it out of the verdict. The display even labelled v1's expected outcome as
 * `allowed`. v2-legacy was never asked about.
 *
 * The verdict lives in a pure module now so it can be driven with synthetic outcomes: the
 * script itself is SIGNER-ACTIVE and must not be executed to test its arithmetic.
 */

const ALLOW = { kind: 'allowed' } as const;
const DENY = { kind: 'denied', detail: 'policy' } as const;
const UNKNOWN = { kind: 'unknown', detail: 'over quota' } as const;

/** The state the ceremony is meant to end in. */
function healthy(over: Partial<ProbeOutcomes> = {}): ProbeOutcomes {
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

describe('the policy verdict counts every probe it asks', () => {
  it('passes only when all six agree', () => {
    const v = classifyPolicy(healthy());
    expect(v.kind).toBe('pass');
    expect(verdictExitCode(v)).toBe(0);
  });

  it('v1 still ALLOWED is NOT SAFE, however good everything else looks', () => {
    // The exact false green: current allowed, creation allowed, arbitrary and funded
    // denied -- the old predicate's four conditions, all satisfied.
    const v = classifyPolicy(healthy({ v1Factory: ALLOW }));
    expect(v.kind).toBe('not-safe');
    expect(verdictExitCode(v)).toBe(1);
    expect((v as any).problems.join(' ')).toMatch(/v1 factory is ALLOWED/i);
  });

  it('the superseded v2 still ALLOWED is NOT SAFE', () => {
    const v = classifyPolicy(healthy({ legacyFactory: ALLOW }));
    expect(v.kind).toBe('not-safe');
    expect((v as any).problems.join(' ')).toMatch(/superseded v2 factory is ALLOWED/i);
  });

  it.each(ALL_PROBES)('an unknown %s is INCONCLUSIVE, never a pass and never a failure', (probe) => {
    const v = classifyPolicy(healthy({ [probe]: UNKNOWN } as Partial<ProbeOutcomes>));
    expect(v.kind).toBe('inconclusive');
    expect((v as any).unknown).toEqual([probe]);
    // Not zero: an unanswered question is not success.
    expect(verdictExitCode(v)).toBe(1);
  });

  it('unknown wins over a real problem, so silence is never read as a refusal', () => {
    // A quota outage disables signing for everything. Reporting the resulting silence as
    // "denied" once sent an operator to fix a policy that was correct.
    const v = classifyPolicy(healthy({ v1Factory: ALLOW, currentFactory: UNKNOWN }));
    expect(v.kind).toBe('inconclusive');
  });

  it('the current factory DENIED is NOT SAFE', () => {
    const v = classifyPolicy(healthy({ currentFactory: DENY }));
    expect(v.kind).toBe('not-safe');
    expect((v as any).problems.join(' ')).toMatch(/current factory is DENIED/i);
  });

  it('zero-value creation DENIED is NOT SAFE -- the bot could not deploy a splitter', () => {
    const v = classifyPolicy(healthy({ zeroValueCreation: DENY }));
    expect(v.kind).toBe('not-safe');
    expect((v as any).problems.join(' ')).toMatch(/zero-value contract creation.*is DENIED/i);
  });

  it.each([['arbitraryDestination'], ['fundedCreation']] as Array<[ProbeName]>)(
    '%s ALLOWED is NOT SAFE',
    (probe) => {
      const v = classifyPolicy(healthy({ [probe]: ALLOW } as Partial<ProbeOutcomes>));
      expect(v.kind).toBe('not-safe');
    }
  );

  it('reports every problem, not just the first', () => {
    const v = classifyPolicy(healthy({ v1Factory: ALLOW, legacyFactory: ALLOW, fundedCreation: ALLOW }));
    expect((v as any).problems).toHaveLength(3);
  });
});

describe('the signer-active script wires the verdict rather than reimplementing it', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'turnkey-verify-policy.ts'),
    'utf8'
  );

  it('probes both superseded factories', () => {
    expect(source).toMatch(/legacyFactory/);
    expect(source).toMatch(/v1Factory/);
  });

  it('takes its verdict from classifyPolicy', () => {
    expect(source).toMatch(/classifyPolicy\(/);
    // Supporting evidence only -- the arithmetic itself is covered above. What this
    // catches is a second, weaker predicate being reintroduced beside the shared one.
    expect(source).not.toMatch(/const good\s*=/);
  });

  it('no longer claims a denied current factory is fine because the bot runs v1', () => {
    // There is no runtime v1 mode. A note saying otherwise tells an operator to accept a
    // signer that cannot launch.
    expect(source).not.toMatch(/fine while the bot runs v1/i);
  });

  it('refuses a non-executable --target-deployment before any signer is constructed', () => {
    // Ordering matters: the refusal must precede the Turnkey client, not follow four
    // signing requests.
    const refusal = source.indexOf('is not executable');
    const client = source.indexOf('new Turnkey(');
    expect(refusal).toBeGreaterThan(-1);
    expect(client).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(client);
  });
});
