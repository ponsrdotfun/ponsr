import { PonsDeployment } from './deployments';

/**
 * Which launch a splitter's fees belong to, and whether the split came out right.
 *
 * WHY THE SPLITTER CANNOT ANSWER THE FIRST QUESTION
 * -------------------------------------------------
 * `orchestrator.ts` deploys every splitter with `ZeroAddress` as its token, and it has
 * no choice: the launched token does not exist yet, because the launch that creates it
 * is the NEXT transaction. `FeeSplitter` stores that immutably as an indexing hint.
 *
 * `collect-and-split-v2.ts` read `splitter.token()` and treated it as the launched
 * token. For every splitter the bot has ever deployed that value is zero, so the
 * documented fee-recovery tool could not recover fees from any bot launch. The failure
 * surfaces the day a creator asks where their money is.
 *
 * So the token comes from somewhere durable -- the launch record, or an operator who
 * states it -- and the factory is then asked to confirm the whole lineage before
 * anything is claimed.
 */

/** The factory's own record of a launch, as `getLaunchedToken` returns it. */
export interface LaunchRecord {
  token: string;
  curve: string;
  deployer: string;
  creatorFeeRecipient: string;
  pairToken: string;
  exists: boolean;
}

export interface TokenCandidates {
  /** `splitter.token()`. Zero for anything the bot deployed. */
  splitterTokenField?: string;
  /** Stated on the command line by an operator who knows the launch. */
  explicitToken?: string;
  /** From this repository's own launch records. */
  provenanceToken?: string | null;
}

const ZERO = '0x0000000000000000000000000000000000000000';
const isZero = (a?: string | null) => !a || a.toLowerCase() === ZERO;
const same = (a?: string | null, b?: string | null) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/**
 * Resolves the launched token, refusing rather than guessing.
 *
 * Order is deliberate: an operator naming a token is making a claim they can be held to;
 * the launch record is this repository's own memory; the splitter's field is a fallback
 * that only ever helps for a splitter deployed by hand outside the bot.
 */
export function resolveLaunchedToken(c: TokenCandidates): {
  token: string;
  source: 'operator' | 'provenance' | 'splitter-field';
} {
  // Two sources that disagree are worse than one missing source: one of them describes a
  // different launch, and claiming on a coin flip moves real money.
  if (
    !isZero(c.explicitToken) &&
    !isZero(c.provenanceToken) &&
    !same(c.explicitToken, c.provenanceToken)
  ) {
    throw new Error(
      `the token given on the command line (${c.explicitToken}) and the one in this launch's ` +
        `record (${c.provenanceToken}) disagree. One of them is about a different launch; ` +
        'refusing to pick.'
    );
  }

  if (!isZero(c.explicitToken)) return { token: c.explicitToken as string, source: 'operator' };
  if (!isZero(c.provenanceToken)) return { token: c.provenanceToken as string, source: 'provenance' };
  if (!isZero(c.splitterTokenField)) {
    return { token: c.splitterTokenField as string, source: 'splitter-field' };
  }

  throw new Error(
    'cannot tell which token this splitter is for. `splitter.token()` is zero, which is ' +
      'normal -- the bot deploys the splitter before the token exists, so that field is a ' +
      'placeholder, not a record.\n' +
      'Pass the launched token explicitly, or run this where the launch records live.'
  );
}

/**
 * Confirms the factory agrees that this splitter is this token's creator fee recipient.
 *
 * Each check answers a different way of being wrong, so each is separate and named:
 * a token this factory never launched, a record that exists but is empty, and -- the
 * expensive one -- a real launch whose creator fees were assigned to somebody else's
 * splitter.
 */
export function assertLaunchLineage(
  record: LaunchRecord,
  splitterAddress: string,
  expectedToken: string,
  deployment: PonsDeployment
): void {
  const where = `${deployment.id} (${deployment.factory})`;

  if (!record.exists) {
    throw new Error(
      `${where} has no launch record for ${expectedToken} (exists = false). ` +
        'Either this token was launched through a different deployment, or it was never ' +
        'launched at all. Refusing to claim against it.'
    );
  }

  if (!same(record.token, expectedToken)) {
    throw new Error(
      `${where} returned a record for token ${record.token}, not ${expectedToken}. Refusing.`
    );
  }

  if (isZero(record.curve)) {
    throw new Error(
      `${where} reports ${expectedToken} as existing but with a zero curve. An empty record ` +
        'is not a launch; refusing to claim against it.'
    );
  }

  // The one that stops money reaching the wrong person. The factory pays creator fees to
  // whatever it recorded at launch, and if that is not this splitter then claiming here
  // either reverts or -- worse -- pays a stranger's creator.
  if (!same(record.creatorFeeRecipient, splitterAddress)) {
    throw new Error(
      `${where} records ${record.creatorFeeRecipient} as the creator fee recipient for ` +
        `${expectedToken}, not this splitter (${splitterAddress}). These fees are not ours ` +
        'to claim. Refusing.'
    );
  }
}

/**
 * How much of a claim each side should receive.
 *
 * `FeeSplitter` floors the creator's share and hands the remainder to the treasury, so
 * asserting a clean 95/5 fails a CORRECT split on any amount that does not divide
 * evenly -- which is nearly all of them. The treasury taking the odd wei is not a
 * rounding bug; it is what stops a remainder accumulating in the splitter.
 */
export function expectedSplit(claimed: bigint): { creator: bigint; treasury: bigint } {
  const creator = (claimed * 9500n) / 10000n;
  return { creator, treasury: claimed - creator };
}

export interface ClaimReconciliation {
  claimed: bigint;
  creatorDelta: bigint;
  treasuryDelta: bigint;
  /** `FeeSplitter` queues a share it cannot deliver rather than reverting the whole
   *  split -- a blacklisted recipient, say. Queued money is owed, not lost. */
  queuedCreator?: bigint;
  queuedTreasury?: bigint;
  escrowRemaining: bigint;
  splitterRemaining: bigint;
  /** Set only when a partial claim was deliberately requested. */
  partialClaim?: boolean;
}

export interface ReconcileResult {
  ok: boolean;
  problems: string[];
  notes: string[];
  /** Machine-readable, for an operator to keep beside the transaction hash. */
  evidence: Record<string, string>;
}

/**
 * Checks that a claim actually landed where it should have.
 *
 * The collector used to print balances and continue. Printing is not checking: the
 * numbers scroll past, the exit code is zero, and a split that quietly shorted the
 * creator looks exactly like one that did not.
 */
export function reconcileClaim(r: ClaimReconciliation): ReconcileResult {
  const expected = expectedSplit(r.claimed);
  const queuedCreator = r.queuedCreator ?? 0n;
  const queuedTreasury = r.queuedTreasury ?? 0n;

  const creatorAccounted = r.creatorDelta + queuedCreator;
  const treasuryAccounted = r.treasuryDelta + queuedTreasury;

  const problems: string[] = [];
  const notes: string[] = [];

  if (creatorAccounted !== expected.creator) {
    problems.push(
      `creator received ${r.creatorDelta}` +
        (queuedCreator > 0n ? ` (+${queuedCreator} queued)` : '') +
        `, expected ${expected.creator}`
    );
  }
  if (treasuryAccounted !== expected.treasury) {
    problems.push(
      `treasury received ${r.treasuryDelta}` +
        (queuedTreasury > 0n ? ` (+${queuedTreasury} queued)` : '') +
        `, expected ${expected.treasury}`
    );
  }

  if (queuedCreator > 0n || queuedTreasury > 0n) {
    notes.push(
      `queued for later delivery: creator ${queuedCreator}, treasury ${queuedTreasury}. ` +
        'The split is correct but the money has not arrived; someone must release it.'
    );
  }

  if (r.splitterRemaining !== 0n) {
    problems.push(
      `${r.splitterRemaining} left unallocated in the splitter -- a split that leaves a ` +
        'balance behind has lost track of it'
    );
  }

  if (r.escrowRemaining !== 0n) {
    if (r.partialClaim) {
      notes.push(`partial claim: ${r.escrowRemaining} still claimable in the escrow, as requested`);
    } else {
      problems.push(
        `${r.escrowRemaining} still claimable in the escrow after a full claim -- either the ` +
          'claim did not take everything, or more was credited mid-run'
      );
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    notes,
    evidence: {
      claimed: r.claimed.toString(),
      expectedCreator: expected.creator.toString(),
      expectedTreasury: expected.treasury.toString(),
      creatorDelta: r.creatorDelta.toString(),
      treasuryDelta: r.treasuryDelta.toString(),
      queuedCreator: queuedCreator.toString(),
      queuedTreasury: queuedTreasury.toString(),
      escrowRemaining: r.escrowRemaining.toString(),
      splitterRemaining: r.splitterRemaining.toString(),
      partialClaim: String(Boolean(r.partialClaim)),
    },
  };
}
