import { PonsDeployment } from './deployments';
import {
  assertOutgoingLaunch,
  ConfirmationVerdict,
  extractLaunchFromReceipt,
  FactoryLaunchRecord,
  OutgoingLaunch,
  ReceiptLaunch,
  verifyLaunchConfirmation,
} from './launchAssertions';

export interface CanaryConfirmationInput {
  selected: PonsDeployment;
  outgoing: OutgoingLaunch;
  splitterAddress: string;
  treasuryAddress: string;
  receipt: {
    status: number | null;
    logs: readonly { address?: string; topics: readonly string[]; data: string }[];
  };
  readLaunchRecord: (
    deployment: PonsDeployment,
    token: string
  ) => Promise<FactoryLaunchRecord | null>;
}

export interface CanaryConfirmationResult {
  token: string | null;
  receipt: ReceiptLaunch | null;
  record: FactoryLaunchRecord | null;
  verdict: ConfirmationVerdict;
}

/** Read-only, selected-deployment-bound full confirmation for the one-shot canary. */
export async function confirmCanaryLaunch(
  input: CanaryConfirmationInput
): Promise<CanaryConfirmationResult> {
  const sent = assertOutgoingLaunch(input.outgoing, input.splitterAddress, input.selected);

  if (input.receipt.status !== 1) {
    return {
      token: null,
      receipt: null,
      record: null,
      verdict: { ok: false, problems: ['the launch receipt is not successful'] },
    };
  }

  const receipt = extractLaunchFromReceipt(input.receipt.logs, input.selected);
  if (!receipt) {
    return {
      token: null,
      receipt: null,
      record: null,
      verdict: {
        ok: false,
        problems: ['the receipt has no launch event from the selected factory'],
      },
    };
  }

  let record: FactoryLaunchRecord | null = null;
  try {
    record = await input.readLaunchRecord(input.selected, receipt.token);
  } catch {
    // verifyLaunchConfirmation treats an unavailable record as unconfirmed.
  }

  return {
    token: receipt.token,
    receipt,
    record,
    verdict: verifyLaunchConfirmation({
      receipt,
      sent,
      record,
      splitterAddress: input.splitterAddress,
      treasuryAddress: input.treasuryAddress,
    }),
  };
}
