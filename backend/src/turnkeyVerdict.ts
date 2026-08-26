import { Outcome } from './turnkeyOutcome';

/**
 * THE VERDICT, SEPARATED FROM THE SIGNING.
 *
 * `turnkey-verify-policy.ts` asks Turnkey to sign, so it cannot be unit-tested without
 * spending signing quota against a live organisation. The classification it performs can
 * be, and it was wrong in a way no amount of careful reading had caught: the script ASKED
 * whether the v1 factory was still allowed, PRINTED the answer, counted it toward the
 * "could not ask" tally -- and then left it out of the verdict entirely.
 *
 * So it could print
 *
 *     === PASSED ===
 *     Safe to set TURNKEY_POLICY_CONFIRMED=true
 *
 * while v1 was still an allowed destination. That is the exact permission the removal
 * ceremony exists to take away, reported as fine by the tool written to check it. The
 * display made it worse: v1 was rendered with an expected label of `allowed`.
 *
 * v2-legacy was never asked about at all.
 *
 * Six probes now, and each one is either a MUST-ALLOW or a MUST-DENY. Nothing is asked
 * and then ignored.
 */

export const MUST_ALLOW = ['currentFactory', 'zeroValueCreation'] as const;
export const MUST_DENY = [
  'v1Factory',
  'legacyFactory',
  'arbitraryDestination',
  'fundedCreation',
] as const;

export type ProbeName = (typeof MUST_ALLOW)[number] | (typeof MUST_DENY)[number];

export const ALL_PROBES: readonly ProbeName[] = [...MUST_ALLOW, ...MUST_DENY];

export type ProbeOutcomes = Record<ProbeName, Outcome>;

/** What each probe is for, in words an operator reading a refusal can act on. */
export const PROBE_LABELS: Record<ProbeName, string> = {
  currentFactory: 'the current factory',
  zeroValueCreation: 'zero-value contract creation (the splitter deploy)',
  v1Factory: 'the v1 factory',
  legacyFactory: 'the superseded v2 factory',
  arbitraryDestination: 'an arbitrary destination',
  fundedCreation: 'a contract creation carrying funds',
};

export type PolicyVerdict =
  | { kind: 'pass' }
  | { kind: 'inconclusive'; unknown: ProbeName[] }
  | { kind: 'not-safe'; problems: string[] };

/**
 * Three outcomes, never two.
 *
 * INCONCLUSIVE is not a failure of the policy and must never be reported as one. On
 * 2026-08-20 the organisation went over its signing quota, every request failed for a
 * reason unrelated to policy, and a script that guessed reported them all as denied --
 * sending the operator to fix a policy created correctly minutes earlier. A failure to
 * ask is not a refusal, and it is not a pass either.
 */
export function classifyPolicy(outcomes: ProbeOutcomes): PolicyVerdict {
  const unknown = ALL_PROBES.filter((p) => outcomes[p]?.kind === 'unknown');
  // Checked FIRST. An unanswered question cannot contribute to either verdict, and
  // deciding "not safe" from silence is the same defect pointing the other way.
  if (unknown.length > 0) return { kind: 'inconclusive', unknown };

  const problems: string[] = [];
  for (const p of MUST_ALLOW) {
    if (outcomes[p]?.kind !== 'allowed') problems.push(`${PROBE_LABELS[p]} is DENIED and must be allowed`);
  }
  for (const p of MUST_DENY) {
    if (outcomes[p]?.kind !== 'denied') problems.push(`${PROBE_LABELS[p]} is ALLOWED and must be denied`);
  }
  return problems.length === 0 ? { kind: 'pass' } : { kind: 'not-safe', problems };
}

/** 0 only for a pass. Inconclusive is not success. */
export function verdictExitCode(v: PolicyVerdict): number {
  return v.kind === 'pass' ? 0 : 1;
}
