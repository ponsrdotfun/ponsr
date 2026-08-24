import { ethers } from 'ethers';
import { CanaryJournal, CanaryRow } from './canaryJournal';
import { PonsDeployment } from './deployments';
import {
  extractLaunchFromReceipt,
  FactoryLaunchRecord,
  verifyLaunchConfirmation,
} from './launchAssertions';
import { decodeCurrentV2Launch } from './ponsV2CurrentEncoder';
import { verifyDeployedSplitter } from './splitterVerifier';

/**
 * Advancing a canary run that was interrupted, using reads alone.
 *
 * The first version handled exactly one state -- `confirmed_incident`, and only for
 * `token_launch`. Everything else the journal can hold (prepared, broadcast,
 * receipt_success, and any splitter row at all) had no path forward, while the script
 * refuses to start whenever anything is unresolved.
 *
 * So the journal preserved evidence perfectly and then wedged the operator permanently,
 * and the message it printed -- "recover it read-only" -- named no command, because none
 * existed. Evidence nobody can act on is a slower way of having none.
 *
 * READ-ONLY BY CONSTRUCTION
 * -------------------------
 * `CanaryRecoveryDeps` carries four readers and an address. There is no signer, no send
 * callback, no key and no Turnkey handle -- not as a rule to remember, but because there
 * is no parameter through which a broadcast could be requested. A recovery path able to
 * send is a recovery path able to create a second permanent token while establishing what
 * happened to the first.
 */

export interface CanaryRecoveryDeps {
  resolveDeployment: (deploymentId: string) => PonsDeployment | null;
  readReceipt: (txHash: string) => Promise<{
    status: number | null;
    logs: readonly { address?: string; topics: readonly string[]; data: string }[];
    contractAddress: string | null;
  } | null>;
  readLaunchRecord: (
    deployment: PonsDeployment,
    token: string
  ) => Promise<FactoryLaunchRecord | null>;
  /** Deployed runtime code, for proving a landed splitter is actually a splitter. */
  readCode: (address: string) => Promise<string>;
  treasuryAddress: string;
}

export interface CanaryRecoveryResult {
  id: number;
  op: CanaryRow['op'];
  txHash: string | null;
  confirmed: boolean;
  problems: string[];
}



/**
 * Everything still open. Terminal rows are skipped entirely -- not read, not re-verified --
 * so a second pass makes no chain calls and cannot double-count anything.
 */
function open(journal: CanaryJournal): CanaryRow[] {
  return journal.unresolved();
}

export async function recoverCanary(
  journal: CanaryJournal,
  deps: CanaryRecoveryDeps
): Promise<CanaryRecoveryResult[]> {
  const results: CanaryRecoveryResult[] = [];

  for (const row of open(journal)) {
    const problems: string[] = [];
    const selected = deps.resolveDeployment(row.deploymentId);

    if (!selected) {
      problems.push(`unknown recorded deployment ${row.deploymentId}`);
    } else if (!row.txHash) {
      /**
       * Prepared, never bound. The intent exists and nothing proves what became of it.
       *
       * Deliberately NOT classified. Calling it reverted would unblock a resend of a
       * launch that may have landed; calling it safe to resend would do the same thing
       * with more confidence. It stays open until a person decides, which is the correct
       * amount of automation for an ambiguity about a permanent artifact.
       */
      problems.push(
        'the transaction hash was never bound: the intent is recorded but nothing here ' +
          'proves whether it was broadcast. Do not resend. Search the explorer for a ' +
          'transaction from the treasury matching this exact destination, value and calldata.'
      );
    } else {
      let receipt: Awaited<ReturnType<CanaryRecoveryDeps['readReceipt']>> = null;
      try {
        receipt = await deps.readReceipt(row.txHash);
      } catch (err) {
        problems.push(`receipt could not be read: ${(err as Error)?.message ?? err}`);
      }

      if (!receipt || receipt.status === null) {
        // Unfetchable is not reverted. The row stays exactly where it is, hash intact.
        problems.push(
          'the receipt could not be read, so this stays ambiguous. The transaction may have ' +
            'landed. Retry the lookup rather than the transaction.'
        );
      } else if (receipt.status !== 1) {
        journal.recordReceipt(row.id, { status: 0 });
        results.push({ id: row.id, op: row.op, txHash: row.txHash, confirmed: false, problems: ['reverted on chain'] });
        continue;
      } else {
        journal.recordReceipt(row.id, { status: 1 });

        /**
         * The fee is consumed by LANDING, not by reconciling.
         *
         * Ordinary execution recorded it right after receipt success; recovery advanced
         * rows all the way to confirmed and never recorded it at all. So a crash between
         * those two points spent real money and left the budget looking untouched.
         *
         * Recorded here, before the verdict, because it is true either way: a launch that
         * landed and did not reconcile spent exactly as much as one that did. Idempotent
         * in the journal, so repeated passes add nothing.
         */
        if (row.op === 'token_launch') journal.recordFee(row.id, row.value);

        const verdict =
          row.op === 'splitter_deploy'
            ? await verifySplitter(row, receipt, selected, deps)
            : await verifyLaunch(row, receipt, selected, deps);

        if (verdict.ok) {
          journal.markConfirmedAnyState(row.id, { token: verdict.token, splitterAddress: verdict.splitter });
          results.push({ id: row.id, op: row.op, txHash: row.txHash, confirmed: true, problems: [] });
          continue;
        }
        problems.push(...verdict.problems);
        journal.markIncidentAnyState(row.id, { problems, token: verdict.token });
        results.push({ id: row.id, op: row.op, txHash: row.txHash, confirmed: false, problems });
        continue;
      }
    }

    // Still open, and the reason is written down rather than only printed. A reason that
    // exists solely on a terminal somebody has closed is not a record of anything.
    journal.recordProblems(row.id, problems);
    results.push({ id: row.id, op: row.op, txHash: row.txHash, confirmed: false, problems });
  }

  return results;
}

/**
 * A landed splitter counts only if the thing at that address IS a splitter.
 *
 * A receipt proves a contract was created. It says nothing about what the contract is, and
 * this project has already deployed the wrong splitter once -- a stale artifact whose fees
 * are stranded forever. So the runtime code is read and searched for the selectors the
 * interface requires, which is the one check a stale build cannot pass.
 */
async function verifySplitter(
  row: CanaryRow,
  receipt: { status: number | null; contractAddress: string | null },
  selected: PonsDeployment,
  deps: CanaryRecoveryDeps
): Promise<{ ok: boolean; problems: string[]; token: string | null; splitter?: string }> {
  let code = '0x';
  if (receipt.contractAddress) {
    try {
      code = await deps.readCode(receipt.contractAddress);
    } catch (err) {
      return {
        ok: false,
        token: null,
        problems: [`could not read code at ${receipt.contractAddress}: ${(err as Error)?.message ?? err}`],
      };
    }
  }
  // ONE verifier, shared with the direct execution path. Two checks for one question
  // disagree eventually, and the disagreement surfaces on the day somebody relies on them.
  const verdict = verifyDeployedSplitter({
    receiptStatus: receipt.status,
    contractAddress: receipt.contractAddress,
    deployedCode: code,
    deployment: selected,
  });
  return { ok: verdict.ok, problems: verdict.problems, token: null, splitter: verdict.splitterAddress };
}

/** The launch verifier, shared with production rather than reimplemented. */
async function verifyLaunch(
  row: CanaryRow,
  receipt: { logs: readonly { address?: string; topics: readonly string[]; data: string }[] },
  selected: PonsDeployment,
  deps: CanaryRecoveryDeps
): Promise<{ ok: boolean; problems: string[]; token: string | null; splitter?: string }> {
  const found = extractLaunchFromReceipt(receipt.logs, selected);
  if (!found) {
    return { ok: false, token: null, problems: ['the receipt carries no launch event from the selected factory'] };
  }

  let record: FactoryLaunchRecord | null = null;
  try {
    record = await deps.readLaunchRecord(selected, found.token);
  } catch (err) {
    return { ok: false, token: found.token, problems: [`the factory record is unavailable: ${(err as Error)?.message ?? err}`] };
  }
  if (!record) {
    return { ok: false, token: found.token, problems: ['the factory has no record of this token'] };
  }

  const verdict = verifyLaunchConfirmation({
    receipt: found,
    sent: decodeCurrentV2Launch(row.calldata, selected),
    record,
    splitterAddress: row.splitterAddress ?? '',
    treasuryAddress: deps.treasuryAddress,
  });
  return { ok: verdict.ok, problems: verdict.problems, token: found.token };
}
