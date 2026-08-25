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
    /** Canonical gas evidence. Absent leaves the cost UNKNOWN, which blocks rather than zeroes. */
    gasUsed?: bigint | null;
    gasPriceWei?: bigint | null;
  } | null>;
  readLaunchRecord: (
    deployment: PonsDeployment,
    token: string
  ) => Promise<FactoryLaunchRecord | null>;
  /** Deployed runtime code, for proving a landed splitter is actually a splitter. */
  readCode: (address: string) => Promise<string>;
  /** The splitter's own view of its immutables, read through the EVM rather than the bytes. */
  readSplitterBindings?: (
    address: string,
    deployment: PonsDeployment
  ) => Promise<{ creator: string; treasury: string; token: string; escrow?: string } | null>;
  /**
   * Is this exact transaction visible to the node, mined or pending?
   *
   * Distinct from `readReceipt`, and the distinction is the whole point for a signed row: no
   * receipt means "not mined yet, or the node cannot say"; no TRANSACTION means the node has
   * never seen these bytes at all. The first is ambiguous, the second is a different and more
   * answerable state -- signed, never observed.
   */
  readTransaction?: (txHash: string) => Promise<{ hash: string; blockNumber: number | null } | null>;
  /** Confirmed transaction count for an address: how many of its nonces are spent. */
  readNonce?: (address: string) => Promise<number>;
  treasuryAddress: string;
}

/**
 * Holds the persisted bytes to the persisted intent, without asking anybody.
 *
 * Entirely local: it decodes `raw_tx` and checks that the transaction it describes is the one
 * the journal says was signed. A mismatch here is not a chain problem to be retried, it is a
 * corrupt or substituted record, and the row must never be advanced or resumed on the strength
 * of it.
 */
export function signedIdentityProblems(row: CanaryRow): string[] {
  if (!row.rawTx) return [];
  const problems: string[] = [];
  let decoded: ethers.Transaction;
  try {
    decoded = ethers.Transaction.from(row.rawTx);
  } catch (e) {
    return [`the stored signed transaction does not decode: ${(e as Error).message}`];
  }
  if (!decoded.signature) problems.push('the stored transaction carries no signature');
  if (decoded.hash?.toLowerCase() !== (row.txHash ?? '').toLowerCase()) {
    problems.push(
      `the stored bytes hash to ${decoded.hash} but the journal records ${row.txHash}`
    );
  }
  const intendedTo = row.to === '' ? null : row.to;
  const decodedTo = decoded.to;
  const sameTo =
    (intendedTo === null && decodedTo === null) ||
    (intendedTo !== null && decodedTo !== null && intendedTo.toLowerCase() === decodedTo.toLowerCase());
  if (!sameTo) {
    problems.push(`signed destination ${decodedTo ?? '(creation)'} != journalled ${intendedTo ?? '(creation)'}`);
  }
  if (decoded.value !== row.value) problems.push(`signed value ${decoded.value} != journalled ${row.value}`);
  if ((decoded.data ?? '0x').toLowerCase() !== row.calldata.toLowerCase()) {
    problems.push('signed calldata differs from the journalled calldata');
  }
  if (row.nonce !== null && decoded.nonce !== row.nonce) {
    problems.push(`signed nonce ${decoded.nonce} != journalled ${row.nonce}`);
  }
  if (Number(decoded.chainId) !== row.chainId) {
    problems.push(`signed chainId ${decoded.chainId} != journalled ${row.chainId}`);
  }
  if (row.sender) {
    let recovered = '';
    try {
      recovered = ethers.getAddress(decoded.from!);
    } catch {
      /* left empty: reported below */
    }
    if (recovered.toLowerCase() !== row.sender.toLowerCase()) {
      problems.push(`signed by ${recovered || '(unrecoverable)'} != journalled sender ${row.sender}`);
    }
  }
  return problems;
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

    /**
     * Corrupt identity is terminal-ish, and checked before anything else.
     *
     * If the stored bytes do not describe the stored transaction, every later question --
     * "did this land?", "is the nonce spent?" -- is being asked about an object the journal
     * cannot correctly name. Recorded as a durable incident rather than left open, because no
     * amount of re-reading the chain will repair a record that disagrees with itself.
     */
    const identityProblems = selected ? signedIdentityProblems(row) : [];
    if (identityProblems.length > 0) {
      const all = ['stored signature identity is inconsistent', ...identityProblems];
      journal.markIncidentAnyState(row.id, { problems: all, token: null });
      results.push({ id: row.id, op: row.op, txHash: row.txHash, confirmed: false, problems: all });
      continue;
    }

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
        /**
         * No receipt. For a SIGNED row the chain can still narrow this considerably.
         *
         * Three distinguishable states hide behind "no receipt", and conflating them is how a
         * transaction gets sent twice:
         *
         *   the node has the transaction         -> pending; wait, do not resend
         *   the node has never seen it, nonce free -> SIGNED / NOT OBSERVED
         *   the node has never seen it, nonce spent by something else -> INCIDENT
         *
         * None of the three is "safe to sign a replacement", which is the only conclusion
         * that could cost a second permanent artifact.
         */
        let narrowed = false;
        if (row.rawTx && row.sender && row.nonce !== null && deps.readTransaction) {
          let seen: { hash: string; blockNumber: number | null } | null = null;
          let lookupFailed = false;
          try {
            seen = await deps.readTransaction(row.txHash);
          } catch (err) {
            lookupFailed = true;
            problems.push(`transaction lookup failed: ${(err as Error)?.message ?? err}`);
          }

          if (!lookupFailed && seen) {
            narrowed = true;
            problems.push(
              'the exact signed transaction is known to the node but has no receipt yet: it is ' +
                'pending. Wait for it. Do not resend and do not re-sign.'
            );
          } else if (!lookupFailed && !seen) {
            let spent: number | null = null;
            if (deps.readNonce) {
              try {
                spent = await deps.readNonce(row.sender);
              } catch (err) {
                problems.push(`nonce lookup failed: ${(err as Error)?.message ?? err}`);
              }
            }
            if (spent !== null && spent > row.nonce) {
              narrowed = true;
              const all = [
                'INCIDENT: nonce ' +
                  row.nonce +
                  ' for this sender is already spent, but not by this transaction. Something ' +
                  'else occupies it, so these signed bytes can never land. Do not re-sign: ' +
                  'establish what did land at that nonce first.',
              ];
              journal.markIncidentAnyState(row.id, { problems: all, token: null });
              results.push({ id: row.id, op: row.op, txHash: row.txHash, confirmed: false, problems: all });
              continue;
            }
            if (spent !== null) {
              narrowed = true;
              problems.push(
                'SIGNED / NOT OBSERVED: the node has never seen this transaction and its nonce ' +
                  'is still free. It is NOT reverted, and it is NOT safe to sign a replacement ' +
                  '-- the bytes are already signed and could still be broadcast by anyone ' +
                  'holding them. Rebroadcast the stored raw transaction under explicit ' +
                  'authorisation, or wait.'
              );
            }
          }
        }
        // Unfetchable is not reverted. The row stays exactly where it is, hash intact.
        if (!narrowed) {
          problems.push(
            'the receipt could not be read, so this stays ambiguous. The transaction may have ' +
              'landed. Retry the lookup rather than the transaction.'
          );
        }
      } else if (receipt.status !== 1) {
        journal.recordReceipt(row.id, { status: 0 });
        results.push({ id: row.id, op: row.op, txHash: row.txHash, confirmed: false, problems: ['reverted on chain'] });
        continue;
      } else {
        journal.recordReceipt(row.id, { status: 1 });

        /**
         * Gas evidence, recovered from the SAME canonical receipt.
         *
         * A crash between a landed receipt and this write used to leave the run's actual gas
         * cost unrecorded, and the combined budget subtracts that cost to decide what the
         * second transaction may spend. Recovering it here is what lets a later, separately
         * authorised continuation compute a remaining budget at all -- and its absence is
         * what correctly blocks one.
         *
         * Idempotent in the journal, and never invented: a receipt without both fields leaves
         * the row UNKNOWN rather than zero.
         */
        if (
          row.txHash &&
          receipt.gasUsed !== undefined &&
          receipt.gasUsed !== null &&
          receipt.gasPriceWei !== undefined &&
          receipt.gasPriceWei !== null
        ) {
          try {
            journal.recordGasEvidence(row.id, {
              txHash: row.txHash,
              gasUsed: receipt.gasUsed,
              gasPriceWei: receipt.gasPriceWei,
            });
          } catch (err) {
            problems.push(`gas evidence could not be recorded: ${(err as Error)?.message ?? err}`);
          }
        } else {
          problems.push(
            'the receipt carries no usable gas evidence, so this run\'s actual gas cost stays ' +
              'UNKNOWN. A later continuation cannot compute the remaining combined budget.'
          );
        }

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
  let bindings: Awaited<ReturnType<NonNullable<CanaryRecoveryDeps['readSplitterBindings']>>> = null;
  if (deps.readSplitterBindings && receipt.contractAddress) {
    try {
      bindings = await deps.readSplitterBindings(receipt.contractAddress, selected);
    } catch {
      // Reported by its absence below rather than treated as agreement.
      bindings = null;
    }
  }

  /**
   * The same verifier the direct path uses, with the same expectations.
   *
   * Self-dealt: creator and treasury are both the treasury, and the token placeholder is
   * the zero address the launch flow passes. Those are the values construction was meant
   * to bind, and binding them is what stops a splitter with foreign recipients passing an
   * "exact" comparison.
   */
  const verdict = verifyDeployedSplitter({
    receiptStatus: receipt.status,
    contractAddress: receipt.contractAddress,
    deployedCode: code,
    deployment: selected,
    expectedCreator: deps.treasuryAddress,
    expectedTreasury: deps.treasuryAddress,
    expectedTokenPlaceholder: '0x0000000000000000000000000000000000000000',
    expectedEscrow: selected.feeEscrow,
    bindings,
    // Authority path: the contract must agree, not merely fail to disagree.
    requireBindings: true,
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
