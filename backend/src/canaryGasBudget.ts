/**
 * ONE gas reserve for the whole canary run, not one per transaction.
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * `TREASURY_GAS_RESERVE_WEI` was passed as `maxGasCostWei` to BOTH irreversible operations
 * independently:
 *
 *     splitter creation   maxGasCostWei = 0.002 ETH
 *     token launch        maxGasCostWei = 0.002 ETH
 *
 * so the maximum signed authority for one run was 0.0005 ETH of value plus up to 0.004 ETH of
 * gas -- 0.0045 ETH in total, against a reserve that was chosen and authorised as 0.002 ETH
 * for the complete two-transaction run. The ceiling was enforced twice and therefore bounded
 * nothing that anybody had agreed to.
 *
 * WHY THE SECOND TRANSACTION GETS ONLY THE REMAINDER
 * -------------------------------------------------
 * The splitter mines first and its real cost is knowable before the launch is signed. So the
 * launch is allowed the total minus what the splitter actually cost, computed from persisted
 * canonical receipt evidence rather than from an estimate or from anything a caller carried
 * across.
 *
 * WHY UNKNOWN IS BLOCKING
 * -----------------------
 * If the splitter's actual cost cannot be proven, the remaining budget is unknown, and an
 * unknown remainder is not a large one. Signing on the assumption that it is would reproduce
 * the original defect exactly -- the launch would receive the full budget a second time.
 */

export interface CombinedGasBudget {
  /** The one reserve for the complete run. */
  totalWei: bigint;
  /** Actual gas already spent by settled operations in this run, or null when UNKNOWN. */
  spentWei: bigint | null;
}

/** What is left. Null when anything already spent is unknown. */
export function remainingGasBudgetWei(budget: CombinedGasBudget): bigint | null {
  if (budget.spentWei === null) return null;
  const left = budget.totalWei - budget.spentWei;
  return left > 0n ? left : 0n;
}

/**
 * The allowance for the NEXT signature, or a refusal explaining exactly why.
 *
 * Throws rather than returning a flag: every caller is about to ask for a signature, and a
 * number a caller can ignore is not a ceiling.
 */
export function gasAllowanceForNext(
  label: string,
  budget: CombinedGasBudget,
  worstCaseWei: bigint
): bigint {
  if (budget.totalWei <= 0n) {
    throw new Error(
      `${label}: the combined gas budget is ${budget.totalWei} wei, which authorises nothing. ` +
        'Set TREASURY_GAS_RESERVE_WEI deliberately before signing anything.'
    );
  }
  if (budget.spentWei === null) {
    throw new Error(
      `${label}: gas already spent by this run is UNKNOWN, so the remaining budget cannot be ` +
        'computed. Refusing to sign. Recover the missing receipt evidence first -- an unknown ' +
        'remainder is not a full one.'
    );
  }
  const remaining = remainingGasBudgetWei(budget)!;
  if (worstCaseWei > remaining) {
    throw new Error(
      `${label}: worst-case gas ${worstCaseWei} wei exceeds the remaining combined budget ` +
        `${remaining} wei (total ${budget.totalWei}, already spent ${budget.spentWei}). ` +
        'Refusing to sign.'
    );
  }
  return remaining;
}

/**
 * The closing reconciliation: what the run actually cost, against what it was allowed.
 *
 * An over-budget ACTUAL result is not a failure to prevent -- by then the money is gone -- but
 * it is a contradiction between what was authorised and what happened, and it is reported as
 * an incident rather than folded into a success.
 */
export function reconcileCombinedGas(
  totalWei: bigint,
  actualWei: bigint | null
): { ok: boolean; detail: string } {
  if (actualWei === null) {
    return {
      ok: false,
      detail:
        'combined actual gas is UNKNOWN: at least one settled operation has no canonical ' +
        'receipt evidence. Not reconciled.',
    };
  }
  if (actualWei > totalWei) {
    return {
      ok: false,
      detail:
        `INCIDENT: combined actual gas ${actualWei} wei exceeds the authorised budget ` +
        `${totalWei} wei. Do not retry; establish how the ceiling was passed.`,
    };
  }
  return {
    ok: true,
    detail: `combined actual gas ${actualWei} wei is within the budget ${totalWei} wei.`,
  };
}
