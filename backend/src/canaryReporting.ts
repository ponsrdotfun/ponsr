/**
 * What the canary is allowed to say about a launch, and when.
 *
 * `phase-b-launch.ts` printed `=== LAUNCHED ===` immediately after a status=1 receipt and
 * called `confirmCanaryLaunch` thirteen lines later. A successful receipt is not a
 * successful launch: the factory record can name a different creator fee recipient, the
 * receipt can carry no event from the selected factory, and the record can be unreadable.
 * In every one of those the transaction has landed, the fee is spent, and nobody yet knows
 * what was launched.
 *
 * Announcing success there taught the operator to read the banner instead of the
 * reconciliation printed under it -- and the banner was the one line guaranteed to appear
 * whatever happened next.
 *
 * WHY THIS IS A FUNCTION AND NOT A SEQUENCE OF console.log CALLS
 * -------------------------------------------------------------
 * The property being protected is an ORDERING: no success language before a verdict
 * exists. A test that greps captured stdout proves the strings appear, not that they
 * cannot appear in the wrong order -- and the original defect was purely an ordering one,
 * with every individual string correct. Deciding the phase in one pure function makes the
 * ordering something a test can assert directly, and leaves the script with nothing to get
 * wrong except printing what it is handed.
 */

export const LANDED_BANNER = '=== TRANSACTION LANDED — RECONCILING ===';
export const RECONCILED_BANNER = '=== LAUNCHED AND RECONCILED ===';
export const INCIDENT_BANNER = '=== INCIDENT: LANDED ON CHAIN, NOT RECONCILED ===';
export const REVERTED_BANNER = '=== LAUNCH REVERTED — NOTHING WAS LAUNCHED ===';
/**
 * No receipt is not a revert.
 *
 * This case used to render as REVERTED. `sent.wait()` can return null and an RPC can fail
 * to answer; the transaction may have landed regardless. Telling the operator "nothing was
 * launched" there is not merely imprecise -- it is the sentence that makes retrying a
 * permanent, already-paid-for launch look reasonable.
 */
export const UNKNOWN_BANNER =
  '=== UNKNOWN: BROADCAST, NO RECEIPT SEEN — DO NOT RETRY ===';

export type CanaryPhase = 'landed' | 'reconciled' | 'incident' | 'reverted' | 'unknown';

export interface CanaryConfirmationSummary {
  ok: boolean;
  problems: string[];
  token: string | null;
}

export interface CanaryPhaseInput {
  /** 1, 0, or null when no receipt was obtained at all. */
  receiptStatus: number | null;
  txHash: string | null;
  /** Null until confirmation has actually been attempted. */
  confirmation: CanaryConfirmationSummary | null;
  outgoing?: { to: string; data: string; value: bigint };
}

export interface CanaryPhaseResult {
  phase: CanaryPhase;
  banner: string;
  /** True only for the one phase in which the launch may be described as successful. */
  final: boolean;
  evidence: {
    txHash: string | null;
    token: string | null;
    problems: string[];
    outgoing?: { to: string; data: string; value: bigint };
  };
}

/**
 * Decides what may be printed, from what is actually known.
 *
 * The receipt is checked FIRST and unconditionally. A confirmation verdict cannot promote
 * a transaction that never landed, which is the original defect inverted -- success
 * decided ahead of the fact it depends on.
 */
export function decideCanaryPhase(input: CanaryPhaseInput): CanaryPhaseResult {
  const evidence = {
    txHash: input.txHash,
    token: input.confirmation?.token ?? null,
    problems: input.confirmation?.problems ?? [],
    ...(input.outgoing ? { outgoing: input.outgoing } : {}),
  };

  if (input.receiptStatus === null) {
    // Broadcast, outcome unseen. Distinct from a revert in the only way that matters: a
    // revert is a fact, and this is the absence of one. The hash is the whole handle on
    // it, and the instruction is read-only recovery -- never a resend.
    return { phase: 'unknown', banner: UNKNOWN_BANNER, final: false, evidence };
  }

  if (input.receiptStatus !== 1) {
    return { phase: 'reverted', banner: REVERTED_BANNER, final: false, evidence };
  }

  if (!input.confirmation) {
    return { phase: 'landed', banner: LANDED_BANNER, final: false, evidence };
  }

  if (input.confirmation.ok) {
    return { phase: 'reconciled', banner: RECONCILED_BANNER, final: true, evidence };
  }

  // Landed but unreconciled. NOT a failure: the token may well exist and the fee is
  // certainly spent. Reporting it as failure invites a retry, and the deterministic salt
  // means a retry reverts with PoolAlreadyExists -- which reads like a second, unrelated
  // fault to whoever is holding the terminal at that point.
  return { phase: 'incident', banner: INCIDENT_BANNER, final: false, evidence };
}
