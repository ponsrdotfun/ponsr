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

/**
 * Asks the factory, right now, whether this pairing asset is still approved.
 *
 * `PairAssetRegistry` caches the approved set for an hour, and that is the right design:
 * discovery is a log sweep and pons rarely changes the list. But a cache is a statement
 * about the past, and the launch path resolved the pair from it and then deployed a
 * splitter -- gas spent, a contract that exists forever -- before asking whether the
 * asset was still approved.
 *
 * pons revokes assets. RIVN was approved and then revoked. A revocation inside the cache
 * window bought a splitter and then reverted the launch, leaving a paid-for contract
 * bound to a launch that never happened.
 *
 * One `eth_call`, immediately before the first durable side effect.
 */
export async function assertPairStillApproved(
  factory: { approvedPairTokens(addr: string): Promise<boolean> },
  pairToken: string,
  deployment: PonsDeployment
): Promise<void> {
  // Native ETH is exempt by the factory's own semantics: its gate short-circuits on the
  // zero address, so `approvedPairTokens(0x0)` is false and asking would refuse the one
  // pairing that always works.
  if (/^0x0+$/i.test(pairToken)) return;

  let approved: boolean;
  try {
    approved = Boolean(await factory.approvedPairTokens(pairToken));
  } catch (err: any) {
    // A read that failed is not an approval. The entire purpose here is to be sure, and
    // "I could not check" is the one answer that must not proceed.
    throw new Error(
      `could not read the live approval for ${pairToken} on ${deployment.id}: ` +
        `${err?.message ?? err}. Refusing before anything is deployed.`
    );
  }

  if (!approved) {
    throw new Error(
      `${pairToken} is no longer approved on ${deployment.id} (${deployment.factory}). ` +
        'It was approved when the pair list was last scanned, so pons has revoked it since. ' +
        'Refusing before the splitter is deployed -- launching would spend the fee on a ' +
        'transaction that must revert.'
    );
  }
}

/** The factory's post-receipt record of a launch. */
export interface FactoryLaunchRecord {
  token: string;
  curve: string;
  deployer: string;
  creatorFeeRecipient: string;
  pairToken: string;
  exists: boolean;
}

export interface ConfirmationVerdict {
  /** True only when every source agrees. Anything else is an incident. */
  ok: boolean;
  problems: string[];
}

/**
 * Whether a landed transaction may be called confirmed.
 *
 * The row used to be marked `confirmed` the moment a `TokenLaunched` from the selected
 * factory decoded; reconciliation ran afterwards, logged on disagreement, and the
 * success reply went out regardless. So "confirmed" meant "an event of the right shape
 * came from the right address" -- not that the token matched the calldata, not that the
 * factory agreed who the creator fee recipient is. Reading the database, a clean launch
 * and an unreconciled one looked identical.
 *
 * Three sources have to agree before that word is used:
 *
 *   the CALLDATA   what we asked for
 *   the RECEIPT    what the factory announced
 *   the RECORD     what the factory will tell anyone who asks later
 *
 * The third matters most for money: `creatorFeeRecipient` in the record is what pays
 * fees for the life of the token, and it is the field a creator's share depends on.
 *
 * A disagreement does NOT mean the token is imaginary -- the transaction landed and the
 * fee is spent. It means nobody can yet say what was launched, which is an incident with
 * evidence worth preserving.
 */
export function verifyLaunchConfirmation(params: {
  receipt: ReceiptLaunch;
  sent: DecodedCurrentV2Launch;
  record: FactoryLaunchRecord | null;
  splitterAddress: string;
  treasuryAddress: string;
}): ConfirmationVerdict {
  const { receipt, sent, record, splitterAddress, treasuryAddress } = params;
  const problems: string[] = [];
  const eq = (a?: string, b?: string) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
  const zero = (a?: string) => !a || /^0x0+$/i.test(a);

  // --- the receipt, on its own -------------------------------------------------------
  if (zero(receipt.token)) problems.push('the factory announced a zero token address');
  if (zero(receipt.curve)) {
    // A launch without a curve has nowhere to trade. Whatever happened, it is not the
    // thing this bot set out to do.
    problems.push('the factory announced a zero curve address');
  }

  // --- the receipt against what we sent ----------------------------------------------
  problems.push(...reconcileReceipt(receipt, sent, treasuryAddress));

  // --- the record ---------------------------------------------------------------------
  if (!record) {
    // Unknown is not the same as fine. Saying so plainly is the whole point: the
    // alternative is a row that claims more than anybody checked.
    problems.push(
      'the factory record could not be read, so nothing about this launch is confirmed ' +
        'beyond the transaction landing'
    );
    return { ok: false, problems };
  }
  if (!record.exists) {
    problems.push('the factory has no record of this token, yet its own event announced one');
  }
  if (!eq(record.token, receipt.token)) {
    problems.push(`record token ${record.token} does not match the announced ${receipt.token}`);
  }
  if (!eq(record.curve, receipt.curve)) {
    problems.push(`record curve ${record.curve} does not match the announced ${receipt.curve}`);
  }
  if (!eq(record.pairToken, receipt.pairToken)) {
    problems.push(
      `record pair token ${record.pairToken} does not match the announced ${receipt.pairToken}`
    );
  }
  if (record.deployer && !eq(record.deployer, treasuryAddress)) {
    problems.push(
      `record deployer ${record.deployer} is not the treasury ${treasuryAddress}. Through the ` +
        'direct path these must be the same address.'
    );
  }

  // The one the creator's money depends on, checked against BOTH the splitter that was
  // deployed and the calldata that named it.
  if (!eq(record.creatorFeeRecipient, splitterAddress)) {
    problems.push(
      `record creator fee recipient ${record.creatorFeeRecipient} is not the splitter deployed ` +
        `for this launch (${splitterAddress}). These fees are not ours to claim.`
    );
  }
  if (!eq(record.creatorFeeRecipient, sent.creatorFeeRecipient)) {
    problems.push(
      `record creator fee recipient ${record.creatorFeeRecipient} is not the one the calldata ` +
        `named (${sent.creatorFeeRecipient})`
    );
  }

  return { ok: problems.length === 0, problems };
}
