import { ethers } from 'ethers';
import { Db } from './db';
import { PonsDeployment } from './deployments';
import {
  extractLaunchFromReceipt,
  FactoryLaunchRecord,
  verifyLaunchConfirmation,
} from './launchAssertions';
import { DecodedCurrentV2Launch } from './ponsV2CurrentEncoder';

export interface IncidentRecoveryDeps {
  db: Db;
  resolveDeployment: (deploymentId: string) => PonsDeployment | null;
  readReceipt: (txHash: string) => Promise<{
    status: number | null;
    logs: readonly { address?: string; topics: readonly string[]; data: string }[];
  } | null>;
  readLaunchRecord: (
    deployment: PonsDeployment,
    token: string
  ) => Promise<FactoryLaunchRecord | null>;
}

export interface IncidentRecoveryResult {
  launchId: string;
  confirmed: boolean;
  problems: string[];
}

/**
 * Reconciles landed incidents exclusively through injected reads. There is deliberately
 * no signer, transaction sender, private key, or spend write in this interface.
 */
export async function recoverLaunchIncidents(
  deps: IncidentRecoveryDeps
): Promise<IncidentRecoveryResult[]> {
  const results: IncidentRecoveryResult[] = [];

  for (const incident of deps.db.getLaunchIncidents()) {
    const problems: string[] = [];
    const selected = deps.resolveDeployment(incident.deploymentId);
    if (!selected) {
      problems.push(`unknown recorded deployment ${incident.deploymentId}`);
    } else if (
      selected.factory.toLowerCase() !==
      (deps.db.getLaunchProvenance(incident.launchId)?.factory ?? '').toLowerCase()
    ) {
      problems.push('the recorded factory does not match the selected deployment');
    }

    let receipt: Awaited<ReturnType<IncidentRecoveryDeps['readReceipt']>> = null;
    if (selected) {
      try {
        receipt = await deps.readReceipt(incident.txHash);
      } catch (err: any) {
        problems.push(`the receipt could not be read: ${err?.message ?? err}`);
      }
    }
    if (!receipt || receipt.status !== 1) {
      problems.push('the successful launch receipt is unavailable');
    }

    const scoped = selected && receipt?.status === 1
      ? extractLaunchFromReceipt(receipt.logs, selected)
      : null;
    if (selected && receipt?.status === 1 && !scoped) {
      problems.push('the receipt has no launch event from the selected factory');
    }

    if (selected && scoped) {
      const sent: DecodedCurrentV2Launch = {
        selector: incident.launchSelector,
        salt: incident.salt,
        expectedEconomics: incident.economicsDigest,
        launchConfigId: incident.launchConfigId,
        pairToken: incident.pairToken,
        creatorFeeRecipient: incident.splitter,
        tokenName: incident.tokenName,
        tokenSymbol: incident.tokenSymbol,
      };
      let record: FactoryLaunchRecord | null = null;
      try {
        record = await deps.readLaunchRecord(selected, scoped.token);
      } catch {
        // The full verifier preserves unavailable as an explicit failure reason.
      }
      const verdict = verifyLaunchConfirmation({
        receipt: scoped,
        sent,
        record,
        splitterAddress: incident.splitter,
        treasuryAddress: incident.originalDeployer,
      });
      problems.push(...verdict.problems);
    }

    if (problems.length === 0 && scoped) {
      const confirmed = deps.db.confirmLaunchIncident(incident.launchId, scoped.token, scoped.curve);
      results.push({ launchId: incident.launchId, confirmed, problems: [] });
    } else {
      const reason = problems.join('; ');
      deps.db.setIncidentReason(incident.launchId, reason);
      results.push({ launchId: incident.launchId, confirmed: false, problems });
    }
  }

  return results;
}
