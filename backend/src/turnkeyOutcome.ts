/**
 * Whether Turnkey refused, allowed, or was never able to answer.
 *
 * WHY THIS IS NOT A REGEX
 * -----------------------
 * The verifier used to decide this by matching `/permission|policy|not authorized/i`
 * against the error message. On 2026-08-20 Turnkey disabled signing org-wide over a
 * quota; the message mentions neither word in a load-bearing way, but every Turnkey
 * error carries a link to `docs.turnkey.com/concepts/policies/...`, and the run reported
 * four denials that had not happened. The operator was sent to fix a policy created
 * correctly minutes earlier.
 *
 * That is the failure mode worth designing against. A wrong guess here does not surface
 * as an error -- it surfaces as a confident, wrong verdict about a security control, in
 * the one tool whose job is to be trusted about security controls.
 *
 * So classification reads structured fields only. From real responses:
 *
 *   code 7  + details[].@type ending PolicyEnginePermissionError   -> a real denial
 *   code 8                                                          -> quota, unknown
 *   code 16                                                         -> unauthenticated, unknown
 *   anything else, or no code at all                                -> unknown
 *
 * The codes are gRPC status codes, which is what Turnkey's API returns underneath.
 *
 * "Unknown" is a real answer and the report must say so. Nothing here says the policy is
 * wrong, and nothing says it is right.
 */

/** gRPC PERMISSION_DENIED. The only code that can establish a denial. */
const PERMISSION_DENIED = 7;

export type Outcome =
  | { kind: 'allowed' }
  | { kind: 'denied'; detail: string }
  | { kind: 'unknown'; detail: string };

interface TurnkeyDetail {
  '@type'?: string;
  message?: string;
  policyEvaluations?: Array<{ policyId?: string; outcome?: string }>;
}

function detailsOf(err: unknown): TurnkeyDetail[] {
  const raw = (err as { details?: unknown })?.details;
  return Array.isArray(raw) ? (raw as TurnkeyDetail[]) : [];
}

/** The policy engine's own error type, not a phrase that happens to appear in prose. */
function hasPolicyEngineDetail(details: TurnkeyDetail[]): boolean {
  return details.some((d) => String(d?.['@type'] ?? '').endsWith('PolicyEnginePermissionError'));
}

/**
 * Every error in the `.cause` chain, outermost first.
 *
 * `@turnkey/ethers` catches the SDK's `TurnkeyRequestError` and rethrows a
 * `TurnkeyActivityError` carrying it as `.cause`. The outer one has no `code` and no
 * `details` -- just a stringified message -- so inspecting only the thrown object sees
 * nothing structured and reports "could not ask" for a refusal that really happened.
 *
 * Measured 2026-08-21: a genuine denial classified correctly through the raw client and
 * came back INCONCLUSIVE through the signer. Same refusal, different wrapper.
 *
 * Bounded, and it tracks what it has already seen: an error whose `cause` is itself is
 * unusual but free to construct, and a classifier that hangs on one is a worse failure
 * than the one it was written to fix.
 */
function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let cur = err;
  while (cur && typeof cur === 'object' && !seen.has(cur) && chain.length < 8) {
    seen.add(cur);
    chain.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return chain;
}

export function classifyTurnkeyOutcome(err: unknown): Outcome {
  const chain = causeChain(err);

  // The innermost link that actually carries structure wins. A denial is a denial no
  // matter how many wrappers it arrived through.
  for (const link of chain) {
    const linkCode = (link as { code?: unknown })?.code;
    if (linkCode === PERMISSION_DENIED && hasPolicyEngineDetail(detailsOf(link))) {
      const evaluated = detailsOf(link)
        .flatMap((d) => d.policyEvaluations ?? [])
        .map((e) => `${e.policyId ?? 'unknown policy'}:${e.outcome ?? 'unknown outcome'}`)
        .join(', ');
      return {
        kind: 'denied',
        detail: evaluated ? `policy engine refused (${evaluated})` : 'policy engine refused',
      };
    }
  }

  // Not a denial. Report what IS known, so an unknown is still traceable: the activity
  // status from the wrapper and the status code from whichever link carries one.
  const status = chain
    .map((l) => (l as { activityStatus?: unknown }).activityStatus)
    .find((v) => typeof v === 'string');
  const code = chain.map((l) => (l as { code?: unknown }).code).find((v) => v !== undefined);
  const message = String((err as { message?: unknown })?.message ?? err).slice(0, 200);
  if (status !== undefined || code !== undefined) {
    const parts = [
      status !== undefined ? String(status) : null,
      code !== undefined ? `Turnkey code ${String(code)}` : null,
      message,
    ].filter(Boolean);
    return { kind: 'unknown', detail: parts.join(' | ') };
  }

  // Nothing structured anywhere in the chain. Quota, credentials, network, a shape
  // nobody anticipated -- all of it means the question was not answered, which is a
  // different thing from being answered no.
  return { kind: 'unknown', detail: message };
}

/** How an outcome reads in a report, with an unknown never dressed as a verdict. */
/**
 * What a probe was hoping for.
 *
 * `residual` is not a weaker `denied`. It marks a capability that a chosen design
 * knowingly leaves open, so that the report says so in as many words instead of
 * printing a red cross next to an outcome nobody intends to change.
 *
 * The distinction is the whole point. Option A binds `eth.tx.value` on the creation
 * clause and deliberately does NOT bind initcode, so a zero-value deploy of arbitrary
 * code stays possible -- it costs gas, not treasury. Reporting that as a FAILURE
 * teaches the operator that a correct run looks broken, and an operator who has learned
 * to expect a red mark is one who will not notice a real one.
 *
 * It cannot be used to launder the funded-creation finding: that case is asserted as
 * `denied`, gates the verdict, and is never expressed as a residual.
 */
export type OutcomeExpectation = 'allowed' | 'denied' | 'residual';

export function describeOutcome(o: Outcome, expected: OutcomeExpectation): string {
  if (o.kind === 'unknown') return 'UNKNOWN -- not asked: ' + o.detail.slice(0, 90);
  if (expected === 'residual') {
    // Denied is strictly better than the design promised, so it is not a failure either.
    return o.kind === 'allowed'
      ? 'ALLOWED -- accepted residual, not a failure'
      : 'denied ✅ -- residual closed, better than required';
  }
  if (o.kind === expected) return o.kind === 'allowed' ? 'ALLOWED ✅' : 'denied ✅';
  return o.kind === 'allowed' ? 'ALLOWED ❌' : 'denied ❌';
}
