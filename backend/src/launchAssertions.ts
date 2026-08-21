import { ethers } from 'ethers';
import { PonsDeployment } from './deployments';
import {
  PONS_V2_CURRENT_ABI,
  decodeCurrentV2Launch,
  DecodedCurrentV2Launch,
} from './ponsV2CurrentEncoder';

/**
 * The last checks before a launch goes out, and the first after it comes back.
 *
 * WHY DECODING IS MANDATORY RATHER THAN BEST-EFFORT
 * -------------------------------------------------
 * Provenance decoded the outgoing calldata inside a try/catch and, on failure, fell back
 * to recomputing what the code MEANT to build. That is the wrong direction. If the
 * encoder produced bytes this deployment's own ABI cannot decode, then the bytes are not
 * what anyone thinks they are -- and the response to "I cannot read what I am about to
 * send" is to stop, not to write down my intentions instead and send it anyway.
 *
 * By this point a splitter has been deployed and paid for, so stopping is not free. It
 * is still far cheaper than a launch whose calldata nobody could read, whose record says
 * something different from what went out, and whose fees may be assigned to a contract
 * nobody deployed.
 */

export interface OutgoingLaunch {
  to: string;
  data: string;
  value: bigint;
}

/**
 * Checks the transaction about to be signed against the deployment it claims to be for.
 *
 * Returns the DECODED fields so the caller records bytes rather than intentions. A
 * caller that has these has no reason to recompute anything.
 */
export function assertOutgoingLaunch(
  tx: OutgoingLaunch,
  deployedSplitter: string,
  deployment: PonsDeployment
): DecodedCurrentV2Launch {
  const where = `${deployment.id} (${deployment.factory})`;

  // Destination first: everything below is about the CONTENT of a call, and content
  // aimed at the wrong contract is not a smaller problem.
  if (tx.to.toLowerCase() !== deployment.factory.toLowerCase()) {
    throw new Error(
      `refusing to send: the transaction is addressed to ${tx.to}, but the selected ` +
        `deployment is ${where}. A launch built for one factory and sent to another is ` +
        'gas spent on a revert at best.'
    );
  }

  let decoded: DecodedCurrentV2Launch;
  try {
    decoded = decodeCurrentV2Launch(tx.data, deployment);
  } catch (err: any) {
    throw new Error(
      `refusing to send: cannot read back the calldata built for ${where} -- ` +
        `${err?.message ?? err}\n` +
        'The bytes are not what this deployment\'s ABI describes, so nothing about this ' +
        'launch is known. The splitter is already deployed; stopping here costs its gas ' +
        'and nothing else.'
    );
  }

  // The one that decides where a creator's fees go for the life of the token. The
  // splitter was deployed moments ago and paid for; calldata naming a different one
  // would assign the fees to a contract nobody controls.
  if (decoded.creatorFeeRecipient.toLowerCase() !== deployedSplitter.toLowerCase()) {
    throw new Error(
      `refusing to send: the calldata names ${decoded.creatorFeeRecipient} as the creator ` +
        `fee recipient, but the splitter just deployed is ${deployedSplitter}. These fees ` +
        'would go somewhere nobody here can claim from.'
    );
  }

  return decoded;
}

export interface ReceiptLaunch {
  token: string;
  curve: string;
  deployer: string;
  pairToken: string;
}

/**
 * Reads the launch out of a receipt, accepting logs only from the factory addressed.
 *
 * A transaction touches many contracts and the receipt carries every log any of them
 * raised. `TokenLaunched` has one signature across both V2 deployments, so a log of that
 * shape from ANY contract decodes cleanly -- and would be read as this launch's token,
 * curve and pairing. Filtering by emitter is what makes the decode mean something.
 *
 * Returns null rather than throwing: "no launch event from the factory we called" is a
 * result the caller must handle explicitly, and it already does.
 */
export function extractLaunchFromReceipt(
  logs: readonly { address?: string; topics: readonly string[]; data: string }[],
  deployment: PonsDeployment
): ReceiptLaunch | null {
  const iface = new ethers.Interface(PONS_V2_CURRENT_ABI);
  const factory = deployment.factory.toLowerCase();

  for (const log of logs) {
    // A log with no emitter cannot be attributed, and an unattributable log is exactly
    // what this filter exists to reject.
    if (!log.address || log.address.toLowerCase() !== factory) continue;
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name !== 'TokenLaunched') continue;
      const a = parsed.args as unknown as Record<string, unknown>;
      return {
        token: String(a.token),
        curve: String(a.curve),
        deployer: String(a.deployer ?? a.originalDeployer ?? ''),
        pairToken: String(a.pairToken),
      };
    } catch {
      /* Some other event from the same factory. */
    }
  }
  return null;
}

/**
 * Reconciles what came back against what went out.
 *
 * Returns the mismatches rather than throwing, because by the time this runs the launch
 * has CONFIRMED: the token exists, the fee is spent, and none of that becomes untrue
 * because the record disagrees. What a disagreement means is that the record is wrong or
 * the event is not ours -- an incident for a person to read, not a reason to pretend the
 * launch failed.
 */
export function reconcileReceipt(
  receipt: ReceiptLaunch,
  sent: DecodedCurrentV2Launch,
  treasuryAddress: string
): string[] {
  const problems: string[] = [];
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  if (!eq(receipt.pairToken, sent.pairToken)) {
    problems.push(
      `pair token: sent ${sent.pairToken}, the factory recorded ${receipt.pairToken}. ` +
        'The launch trades against something other than what was asked for.'
    );
  }
  if (receipt.deployer && !eq(receipt.deployer, treasuryAddress)) {
    problems.push(
      `deployer: expected the treasury ${treasuryAddress}, the factory recorded ` +
        `${receipt.deployer}. Through the direct path these must be the same address.`
    );
  }
  if (!receipt.token || /^0x0+$/.test(receipt.token)) {
    problems.push('the factory reported a zero token address for a confirmed launch');
  }
  return problems;
}
