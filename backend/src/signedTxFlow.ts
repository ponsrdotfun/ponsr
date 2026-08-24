import { ethers } from 'ethers';
import { CanaryJournal, SignedIdentity } from './canaryJournal';

/**
 * Sign, persist the identity, then broadcast exactly those bytes.
 *
 * THE WINDOW THIS CLOSES
 * ----------------------
 * Both irreversible canary operations used to be:
 *
 *     persist intent -> signer.sendTransaction() -> persist the returned hash
 *
 * `sendTransaction` signs AND broadcasts inside one call. If the process died after the
 * provider accepted the bytes but before the call returned, the journal held `prepared` with
 * no hash, no nonce, no sender and no bytes -- a row describing a transaction that may well
 * be on chain, with nothing to identify it by. The only remedy was searching an explorer,
 * which is containment, not recovery, and the cheapest-looking way out was to run it again.
 *
 * Splitting the two makes the identity exist BEFORE the irreversible step. After
 * `signAndPersist` returns, the exact transaction is known by canonical hash whatever happens
 * next, and recovery becomes a question the chain can answer.
 *
 * WHY THE HASH IS RECOMPUTED AND NOT ACCEPTED
 * -------------------------------------------
 * The hash is derived here from the signed bytes with `ethers.Transaction.from`. A hash
 * supplied by a provider or a signer is that party's claim about what it did; the bytes are
 * the transaction. Where those two disagree the bytes win, and the disagreement itself is a
 * blocking incident rather than a detail to reconcile later.
 *
 * WHY THE DECODED FIELDS ARE CHECKED AGAINST THE INTENT
 * ----------------------------------------------------
 * A signer is asked for a signature over a request; what comes back is bytes. Decoding them
 * and comparing destination, value, calldata, nonce and chain against what was journalled is
 * the only way to know the signature covers the transaction that was intended. A mismatch is
 * refused before anything is persisted, so nothing broadcastable is ever written for a
 * transaction nobody asked for.
 *
 * OPERATIONAL SENSITIVITY
 * -----------------------
 * `rawTx` is broadcast-ready authority. Anyone holding those bytes can put the transaction on
 * chain from any machine; no key is needed, because the signature is already in them. They
 * live in the operator's journal file and must never appear in logs, reports, Telegram
 * messages or completion reports.
 */

/** A signer that can produce signed bytes WITHOUT broadcasting them. */
export interface PreSigningSigner {
  address(): Promise<string>;
  signTransaction(tx: ethers.TransactionRequest): Promise<string>;
}

/**
 * Narrows a signer to one that can sign without broadcasting, or refuses.
 *
 * The refusal matters more than the narrowing. A caller that quietly fell back to
 * `sendTransaction` when `signTransaction` was missing would reintroduce the exact crash
 * window the split exists to close, and would do it invisibly, on the one path where the
 * consequence is an unidentifiable irreversible transaction.
 *
 * It lives in THIS module rather than beside the signer classes because `treasurySigner.ts`
 * imports `./config`, whose module load runs dotenv and parses every credential. The canary's
 * preflight needs this helper and must not read a single credential to get it.
 */
export function requirePreSigning(signer: {
  address(): Promise<string>;
  signTransaction?(tx: ethers.TransactionRequest): Promise<string>;
}): PreSigningSigner {
  if (typeof signer.signTransaction !== 'function') {
    throw new Error(
      'this signer cannot sign without broadcasting, so a transaction could not be identified ' +
        'before it became irreversible. Refusing to fall back to sendTransaction.'
    );
  }
  const sign = signer.signTransaction.bind(signer);
  return { address: () => signer.address(), signTransaction: (tx) => sign(tx) };
}

/** The read/broadcast surface, narrowed to what this flow uses. */
export interface TxBroadcaster {
  getTransactionCount(address: string, blockTag?: string): Promise<number>;
  estimateGas(tx: ethers.TransactionRequest): Promise<bigint>;
  getFeeData(): Promise<{
    maxFeePerGas?: bigint | null;
    maxPriorityFeePerGas?: bigint | null;
    gasPrice?: bigint | null;
  }>;
  broadcastTransaction(raw: string): Promise<{ hash: string; wait: () => Promise<ethers.TransactionReceipt | null> }>;
}

/**
 * Two ceilings, deliberately separate.
 *
 * They bound different things and must not be added together or substituted for one another.
 * `maxValueWei` is what the transaction CARRIES -- for a launch that is the protocol's launch
 * fee, and for a contract creation it is zero, because a funded creation is the finding that
 * was closed in the Turnkey policy on 2026-08-22. `maxGasCostWei` is what the transaction may
 * COST to execute. Folding them into one number would let a large gas budget silently
 * authorise a value transfer, or a value ceiling refuse an ordinary gas price.
 *
 * Both are REQUIRED. The previous ceiling was optional and neither call site supplied it, so
 * the check existed and protected nothing.
 */
export interface TxCeilings {
  /** Maximum wei the transaction may carry as `value`. Zero for a contract creation. */
  maxValueWei: bigint;
  /** Maximum wei the transaction may cost in gas: gasLimit x the highest per-gas price. */
  maxGasCostWei: bigint;
}

export interface TxIntent {
  chainId: number;
  /** null for a contract creation. Never a placeholder address. */
  to: string | null;
  data: string;
  value: bigint;
  ceilings: TxCeilings;
}

/** The exact fee shape that was populated, kept so the signed bytes can be held to it. */
interface PopulatedFees {
  type: number;
  gasLimit: bigint;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  gasPrice: bigint | null;
}

export interface SignedTx {
  raw: string;
  hash: string;
  sender: string;
  nonce: number;
}

/** Normalises the journal's `to` convention ('' for creation) to the EVM's (null). */
export function creationAware(to: string | null | undefined): string | null {
  if (to === null || to === undefined || to === '') return null;
  return to;
}

/**
 * Builds, signs once, verifies the bytes against the intent, and persists the identity.
 *
 * Ordering is the whole point and is not an implementation detail: nothing here may broadcast,
 * and the caller cannot broadcast until this has returned, because the raw bytes are what the
 * broadcast step consumes and they do not exist anywhere else until they are written down.
 */
export async function signAndPersist(
  deps: { signer: PreSigningSigner; broadcaster: TxBroadcaster },
  journal: CanaryJournal,
  rowId: number,
  intent: TxIntent
): Promise<SignedTx> {
  const sender = ethers.getAddress(await deps.signer.address());
  const to = creationAware(intent.to);

  /**
   * The nonce is RESERVED, from pending, and recorded with the signature.
   *
   * 'pending' rather than 'latest' so a transaction this operator already has in flight is
   * counted. Reading 'latest' would hand out a nonce that is already spoken for, and the
   * second transaction would sit unmineable behind the first while looking perfectly signed.
   */
  const nonce = await deps.broadcaster.getTransactionCount(sender, 'pending');

  /**
   * Refuse BEFORE signing if this journal has already used the nonce.
   *
   * A provider answering with a stale or wrong pending count would otherwise have us sign
   * bytes at a nonce that is already spoken for -- unmineable from the moment they exist,
   * while looking like a perfectly good signed transaction waiting to land. Checked against
   * the journal rather than the chain because the journal is the thing that knows what this
   * operator signed, including transactions the node has not seen yet.
   */
  const clash = journal.nonceAlreadyUsed(sender, nonce);
  if (clash) {
    throw new Error(
      `nonce ${nonce} for ${sender} is already used by canary row ${clash.id} (${clash.op}, ` +
        `state ${clash.state}). Refusing to sign a transaction that could never land. The ` +
        'provider may be reporting a stale pending count.'
    );
  }

  const request: ethers.TransactionRequest = {
    chainId: intent.chainId,
    from: sender,
    nonce,
    to,
    data: intent.data,
    value: intent.value,
  };

  const gasLimit = await deps.broadcaster.estimateGas({ ...request });
  const fee = await deps.broadcaster.getFeeData();

  /**
   * EIP-1559 where the chain offers it, explicit legacy pricing where it does not.
   *
   * Left unpopulated, a signer or provider would fill these in later from its own view of the
   * chain -- which means the bytes signed here would not be the bytes anybody predicted, and
   * the hash persisted below would describe a transaction that never existed.
   */
  const maxFeePerGas = fee.maxFeePerGas ?? null;
  const maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? null;
  const populated: PopulatedFees =
    maxFeePerGas !== null && maxPriorityFeePerGas !== null
      ? { type: 2, gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasPrice: null }
      : fee.gasPrice != null
        ? { type: 0, gasLimit, maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: fee.gasPrice }
        : (() => {
            throw new Error(
              'provider offered neither EIP-1559 fees nor a gas price -- refusing to sign a ' +
                'transaction whose fee the chain would fill in later'
            );
          })();

  request.type = populated.type;
  request.gasLimit = populated.gasLimit;
  if (populated.type === 2) {
    request.maxFeePerGas = populated.maxFeePerGas!;
    request.maxPriorityFeePerGas = populated.maxPriorityFeePerGas!;
  } else {
    request.gasPrice = populated.gasPrice!;
  }

  /**
   * Both ceilings, checked BEFORE a signature is requested.
   *
   * Refusing here costs nothing. Refusing after signing would still leave broadcastable bytes
   * in existence, which is the thing this module is organised around not doing.
   */
  const perGas = populated.type === 2 ? populated.maxFeePerGas! : populated.gasPrice!;
  const worstCaseGas = populated.gasLimit * perGas;
  if (worstCaseGas > intent.ceilings.maxGasCostWei) {
    throw new Error(
      `worst-case gas cost ${worstCaseGas} wei exceeds the gas ceiling ` +
        `${intent.ceilings.maxGasCostWei} wei -- not signed`
    );
  }
  if (intent.value > intent.ceilings.maxValueWei) {
    throw new Error(
      `transaction value ${intent.value} wei exceeds the value ceiling ` +
        `${intent.ceilings.maxValueWei} wei -- not signed`
    );
  }

  // ONE signature, over exactly these populated bytes.
  const raw = await deps.signer.signTransaction(request);

  /**
   * Decode what came back and hold it to the intent.
   *
   * Everything below is read out of the signed bytes. Nothing is taken on trust from the
   * signer, and the failures are deliberately loud: a signature over the wrong destination or
   * the wrong value is not a smaller problem than no signature at all, it is a larger one,
   * because it is broadcastable.
   */
  let decoded: ethers.Transaction;
  try {
    decoded = ethers.Transaction.from(raw);
  } catch (e) {
    throw new Error(`signer returned bytes that do not decode as a transaction: ${(e as Error).message}`);
  }
  if (!decoded.signature) throw new Error('signer returned an unsigned transaction');

  const mismatches: string[] = [];
  const eqAddr = (a: string | null, b: string | null) =>
    (a === null && b === null) || (a !== null && b !== null && a.toLowerCase() === b.toLowerCase());

  if (!eqAddr(decoded.to, to)) {
    mismatches.push(`to ${decoded.to ?? '(creation)'} != intended ${to ?? '(creation)'}`);
  }
  if (decoded.value !== intent.value) mismatches.push(`value ${decoded.value} != ${intent.value}`);
  if ((decoded.data ?? '0x').toLowerCase() !== intent.data.toLowerCase()) mismatches.push('calldata differs');
  if (decoded.nonce !== nonce) mismatches.push(`nonce ${decoded.nonce} != reserved ${nonce}`);
  if (Number(decoded.chainId) !== intent.chainId) {
    mismatches.push(`chainId ${decoded.chainId} != ${intent.chainId}`);
  }
  let recovered: string;
  try {
    recovered = ethers.getAddress(decoded.from!);
  } catch {
    recovered = '';
  }
  if (recovered.toLowerCase() !== sender.toLowerCase()) {
    mismatches.push(`recovered signer ${recovered || '(none)'} != ${sender}`);
  }

  /**
   * The economics of the transaction, held to what was populated.
   *
   * These were built above and then never checked, so a signer could return bytes with a
   * different gasLimit and a different fee and be believed. Measured: 21,000 -> 999,999 and
   * maxFeePerGas 2 -> 999,999,999,999 was accepted and persisted as `signed`.
   *
   * It matters because gas is spent from the same hot wallet the ceilings exist to protect,
   * and because a transaction type change silently reinterprets the fee fields: type 2's
   * maxFeePerGas and type 0's gasPrice are different promises about what the sender will pay.
   */
  if (decoded.type !== populated.type) {
    mismatches.push(`transaction type ${decoded.type} != populated ${populated.type}`);
  }
  if (decoded.gasLimit !== populated.gasLimit) {
    mismatches.push(`gasLimit ${decoded.gasLimit} != populated ${populated.gasLimit}`);
  }
  if (populated.type === 2) {
    if (decoded.maxFeePerGas !== populated.maxFeePerGas) {
      mismatches.push(`maxFeePerGas ${decoded.maxFeePerGas} != populated ${populated.maxFeePerGas}`);
    }
    if (decoded.maxPriorityFeePerGas !== populated.maxPriorityFeePerGas) {
      mismatches.push(
        `maxPriorityFeePerGas ${decoded.maxPriorityFeePerGas} != populated ${populated.maxPriorityFeePerGas}`
      );
    }
  } else if (decoded.gasPrice !== populated.gasPrice) {
    mismatches.push(`gasPrice ${decoded.gasPrice} != populated ${populated.gasPrice}`);
  }

  /**
   * Nothing was asked for beyond a plain transfer of authority.
   *
   * An access list changes what the transaction may touch and what it costs; blob fields
   * belong to a transaction type this flow never populates. Neither was requested, so their
   * presence means the returned bytes are not the transaction that was built -- refused
   * rather than tolerated, because "we did not ask for it" is exactly when a field is
   * interesting.
   */
  const accessList = (decoded as unknown as { accessList?: unknown[] | null }).accessList;
  if (Array.isArray(accessList) && accessList.length > 0) {
    mismatches.push(`signed bytes carry an access list of ${accessList.length} entr(ies), none was requested`);
  }
  const blobs = (decoded as unknown as { maxFeePerBlobGas?: bigint | null }).maxFeePerBlobGas;
  if (blobs !== undefined && blobs !== null) {
    mismatches.push('signed bytes carry blob fee fields, none was requested');
  }

  // Re-checked from the DECODED bytes, not from what was populated: the ceilings must bind
  // what will actually be broadcast.
  const decodedPerGas = decoded.type === 2 ? (decoded.maxFeePerGas ?? 0n) : (decoded.gasPrice ?? 0n);
  const decodedGasCost = decoded.gasLimit * decodedPerGas;
  if (decodedGasCost > intent.ceilings.maxGasCostWei) {
    mismatches.push(
      `signed worst-case gas cost ${decodedGasCost} exceeds the ceiling ${intent.ceilings.maxGasCostWei}`
    );
  }
  if (decoded.value > intent.ceilings.maxValueWei) {
    mismatches.push(`signed value ${decoded.value} exceeds the ceiling ${intent.ceilings.maxValueWei}`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      'signed bytes do not match the journalled intent, refusing to persist or broadcast: ' +
        mismatches.join('; ')
    );
  }

  const hash = decoded.hash;
  if (!hash) throw new Error('signed transaction has no canonical hash');

  const identity: SignedIdentity = { sender, nonce, chainId: intent.chainId, txHash: hash, rawTx: raw };
  journal.recordSigned(rowId, identity);

  return { raw, hash, sender, nonce };
}

/**
 * Errors that mean "this exact transaction is already out there".
 *
 * Not failures. A node that answers "already known" is confirming the transaction it was
 * handed is the one it has; "nonce too low" means that nonce is already spent, which for THIS
 * hash means it landed. Treating either as a failure is how a caller talks itself into
 * signing a replacement, which is the one outcome that must never follow a broadcast.
 */
function isAlreadyOutThere(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('already known') ||
    m.includes('already exists') ||
    m.includes('nonce too low') ||
    m.includes('replacement transaction underpriced') ||
    m.includes('transaction already imported')
  );
}

/**
 * Broadcasts exactly the persisted bytes. Never rebuilds, resigns, or takes a new nonce.
 *
 * The row is moved to `broadcast` BEFORE the call, not after. If the process dies inside the
 * broadcast the journal already says the bytes were handed over, which is the honest reading:
 * the transaction may or may not have been accepted, and only the chain can say. Marking it
 * afterwards would leave the same blind window this whole module exists to remove.
 */
export async function broadcastPersisted(
  deps: { broadcaster: TxBroadcaster },
  journal: CanaryJournal,
  rowId: number
): Promise<{ hash: string; wait: () => Promise<ethers.TransactionReceipt | null> }> {
  const row = journal.byId(rowId);
  if (!row) throw new Error(`canary row ${rowId} does not exist`);
  if (row.state !== 'signed') {
    throw new Error(
      `canary row ${rowId} is ${row.state}, not signed -- broadcast is only reachable from a ` +
        'persisted signature identity.'
    );
  }
  if (!row.rawTx || !row.txHash) {
    throw new Error(`canary row ${rowId} is signed but carries no raw transaction -- refusing to broadcast`);
  }

  const raw = row.rawTx;
  const expected = row.txHash;

  journal.markBroadcast(rowId);

  try {
    const sent = await deps.broadcaster.broadcastTransaction(raw);
    if (sent.hash.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `broadcaster reported hash ${sent.hash} for bytes whose canonical hash is ${expected}`
      );
    }
    return sent;
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (isAlreadyOutThere(msg)) {
      // The transaction is out there under the hash already journalled. Resolve it by reading
      // the chain, never by sending anything else.
      return {
        hash: expected,
        wait: async () => null,
      };
    }
    throw e;
  }
}
