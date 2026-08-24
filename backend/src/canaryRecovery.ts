import { CanaryJournal, CanaryRow } from './canaryJournal';
import { PonsDeployment } from './deployments';
import {
  extractLaunchFromReceipt,
  FactoryLaunchRecord,
  verifyLaunchConfirmation,
} from './launchAssertions';
import { decodeCurrentV2Launch } from './ponsV2CurrentEncoder';

/**
 * Reconciling a canary launch that landed while nobody was watching.
 *
 * When the receipt succeeded but reconciliation was unavailable or disagreed,
 * `phase-b-launch.ts` printed `ABORTING:` and exited 1. That is ordinary failure language
 * for a transaction that is on chain and paid for, and it points the reader at the one
 * action that must never be taken next: running it again. The deterministic salt would
 * make that second attempt revert, after paying gas, with `PoolAlreadyExists` -- which
 * reads like an unrelated second fault to whoever is holding the terminal by then.
 *
 * SHARED WITH PRODUCTION, DELIBERATELY
 * ------------------------------------
 * The reconciliation itself is `extractLaunchFromReceipt` and `verifyLaunchConfirmation`,
 * the same functions the bot uses and the same ones already under test. Only the store
 * differs: this reads the operator's canary journal rather than the production database,
 * so nothing here needs the Fly volume or production credentials. Writing a second,
 * canary-shaped verifier would have produced a weaker check that drifts from the real one,
 * and the two would disagree exactly when it mattered.
 *
 * READ-ONLY BY CONSTRUCTION
 * -------------------------
 * `CanaryRecoveryDeps` carries a receipt reader and a factory-record reader. There is no
 * signer, no send callback, no key and no Turnkey handle -- not as a convention anybody
 * has to remember, but because there is no parameter through which a broadcast could be
 * requested. A recovery path able to send is a recovery path able to launch a second
 * permanent token while trying to work out what happened to the first.
 */

export interface CanaryRecoveryDeps {
  resolveDeployment: (deploymentId: string) => PonsDeployment | null;
  readReceipt: (txHash: string) => Promise<{
    status: number | null;
    logs: readonly { address?: string; topics: readonly string[]; data: string }[];
  } | null>;
  readLaunchRecord: (
    deployment: PonsDeployment,
    token: string
  ) => Promise<FactoryLaunchRecord | null>;
  treasuryAddress: string;
}

export interface CanaryRecoveryResult {
  id: number;
  txHash: string | null;
  confirmed: boolean;
  problems: string[];
}

/** Only launches. A splitter deployment has no factory record to reconcile against. */
function openLaunchIncidents(journal: CanaryJournal): CanaryRow[] {
  return journal
    .unresolved()
    .filter((r) => r.state === 'confirmed_incident' && r.op === 'token_launch');
}

export async function recoverCanaryIncidents(
  journal: CanaryJournal,
  deps: CanaryRecoveryDeps
): Promise<CanaryRecoveryResult[]> {
  const results: CanaryRecoveryResult[] = [];

  for (const row of openLaunchIncidents(journal)) {
    const problems: string[] = [];
    const selected = deps.resolveDeployment(row.deploymentId);

    if (!selected) {
      problems.push(`unknown recorded deployment ${row.deploymentId}`);
    } else if (!row.txHash) {
      problems.push('no transaction hash was ever bound to this row');
    } else {
      let receipt: Awaited<ReturnType<CanaryRecoveryDeps['readReceipt']>> = null;
      try {
        receipt = await deps.readReceipt(row.txHash);
      } catch (err) {
        problems.push(`receipt could not be read: ${(err as Error)?.message ?? err}`);
      }

      if (!receipt) {
        // Unfetchable is not reverted. The transaction may be perfectly fine and the RPC
        // merely unreachable; recording it as reverted would erase a landed launch.
        problems.push('the receipt could not be fetched, so this remains unresolved');
      } else if (receipt.status !== 1) {
        problems.push(`the receipt reports status ${receipt.status}`);
      } else {
        // Scoped to the selected factory: a log with the same signature from any other
        // address proves nothing about our launch.
        const found = extractLaunchFromReceipt(receipt.logs, selected);
        if (!found) {
          problems.push('the receipt carries no launch event from the selected factory');
        } else {
          let record: FactoryLaunchRecord | null = null;
          try {
            record = await deps.readLaunchRecord(selected, found.token);
          } catch (err) {
            problems.push(`the factory record is unavailable: ${(err as Error)?.message ?? err}`);
          }

          if (record) {
            const verdict = verifyLaunchConfirmation({
              receipt: found,
              sent: decodeCurrentV2Launch(row.calldata, selected),
              record,
              splitterAddress: row.splitterAddress ?? '',
              treasuryAddress: deps.treasuryAddress,
            });
            if (verdict.ok) {
              // Conditional update inside the journal: a second pass finds the row already
              // confirmed and no longer open, so it cannot be promoted or counted twice.
              journal.markConfirmedFromIncident(row.id, { token: found.token });
              results.push({ id: row.id, txHash: row.txHash, confirmed: true, problems: [] });
              continue;
            }
            problems.push(...verdict.problems);
          }
        }
      }
    }

    // Still an incident. The row is left exactly as it was -- landed, hash intact, evidence
    // preserved -- because everything about it is still true and none of it is failure.
    results.push({ id: row.id, txHash: row.txHash, confirmed: false, problems });
  }

  return results;
}
