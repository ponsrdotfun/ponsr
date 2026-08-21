import {
  resolveLaunchedToken,
  assertLaunchLineage,
  expectedSplit,
  reconcileClaim,
  LaunchRecord,
} from '../src/splitterLineage';
import { executableDeployment, deploymentById } from '../src/deployments';

/**
 * Establishing which token a splitter's fees belong to, before claiming them.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * `orchestrator.ts` deploys every splitter with `ethers.ZeroAddress` as its token: the
 * real address does not exist yet, because the launch that creates it happens in the
 * NEXT transaction. `FeeSplitter` stores that immutably as an indexing hint.
 *
 * `collect-and-split-v2.ts` then read `splitter.token()` and treated it as the launched
 * token. For every splitter the bot has ever deployed that value is zero. So the
 * documented fee-recovery tool could not recover fees from any bot launch -- and the
 * failure arrives when a creator asks where their money is.
 *
 * The token has to come from somewhere durable: the launch record the bot writes, or an
 * operator who states it. Never from a field that is zero by construction.
 */

const D = executableDeployment();
const SPLITTER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const CURVE = '0x4444444444444444444444444444444444444444';
const PAIR = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const ZERO = '0x0000000000000000000000000000000000000000';

function record(over: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    token: TOKEN,
    curve: CURVE,
    deployer: '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa',
    creatorFeeRecipient: SPLITTER,
    pairToken: PAIR,
    exists: true,
    ...over,
  };
}

describe('resolveLaunchedToken', () => {
  it('prefers what the operator stated', () => {
    const r = resolveLaunchedToken({ splitterTokenField: ZERO, explicitToken: TOKEN, provenanceToken: null });
    expect(r.token).toBe(TOKEN);
    expect(r.source).toBe('operator');
  });

  it('falls back to the durable launch record', () => {
    const r = resolveLaunchedToken({ splitterTokenField: ZERO, provenanceToken: TOKEN });
    expect(r.token).toBe(TOKEN);
    expect(r.source).toBe('provenance');
  });

  /** The whole point. */
  it('refuses when the only candidate is the splitter’s zero field', () => {
    expect(() => resolveLaunchedToken({ splitterTokenField: ZERO })).toThrow(/zero|which token/i);
  });

  it('refuses when nothing at all is known', () => {
    expect(() => resolveLaunchedToken({})).toThrow(/which token/i);
  });

  // Only a splitter deployed by hand, outside the bot, carries a real token here.
  it('accepts a nonzero splitter field when nothing better exists', () => {
    const r = resolveLaunchedToken({ splitterTokenField: TOKEN });
    expect(r.source).toBe('splitter-field');
  });

  it('refuses when the operator and the launch record disagree', () => {
    // One of the two is about a different launch, and claiming on a guess moves money.
    expect(() =>
      resolveLaunchedToken({ splitterTokenField: ZERO, explicitToken: TOKEN, provenanceToken: CURVE })
    ).toThrow(/disagree/i);
  });
});

describe('assertLaunchLineage', () => {
  it('passes when the factory record names this splitter', () => {
    expect(() => assertLaunchLineage(record(), SPLITTER, TOKEN, D)).not.toThrow();
  });

  it('refuses a record that does not exist', () => {
    expect(() => assertLaunchLineage(record({ exists: false }), SPLITTER, TOKEN, D)).toThrow(/exists/i);
  });

  it('refuses a zero curve even when exists is true', () => {
    expect(() => assertLaunchLineage(record({ curve: ZERO }), SPLITTER, TOKEN, D)).toThrow(/curve/i);
  });

  /**
   * The one that stops money going to the wrong place: this factory launched the token,
   * but the creator's fees were assigned to a DIFFERENT splitter. Claiming through ours
   * would either revert or pay somebody else's creator.
   */
  it('refuses when the creator fee recipient is a different splitter', () => {
    expect(() =>
      assertLaunchLineage(record({ creatorFeeRecipient: '0x' + '55'.repeat(20) }), SPLITTER, TOKEN, D)
    ).toThrow(/creatorFeeRecipient|recipient/i);
  });

  it('refuses when the record is for a different token', () => {
    expect(() => assertLaunchLineage(record({ token: CURVE }), SPLITTER, TOKEN, D)).toThrow(/token/i);
  });

  it('compares addresses case-insensitively', () => {
    const upper = SPLITTER.toUpperCase().replace('0X', '0x');
    expect(() => assertLaunchLineage(record({ creatorFeeRecipient: upper }), SPLITTER, TOKEN, D)).not.toThrow();
  });

  it('names the deployment in its refusal, so the operator knows what was asked', () => {
    try {
      assertLaunchLineage(record({ exists: false }), SPLITTER, TOKEN, D);
      throw new Error('should have refused');
    } catch (e: any) {
      expect(e.message).toContain(D.id);
    }
  });
});

/**
 * What the split must come to.
 *
 * `FeeSplitter` floors the creator's share and gives the remainder to the treasury, so
 * the creator is 9500 bps rounded DOWN and the treasury gets whatever is left. Asserting
 * a clean 95/5 fails a correct split on any amount that does not divide evenly -- which
 * is almost all of them.
 */
describe('expectedSplit', () => {
  it('floors the creator share and gives the remainder to the treasury', () => {
    const { creator, treasury } = expectedSplit(171111111111111111n);
    expect(creator).toBe((171111111111111111n * 9500n) / 10000n);
    expect(creator + treasury).toBe(171111111111111111n);
  });

  it('always sums to exactly the claimed amount', () => {
    for (const amount of [1n, 2n, 3n, 9999n, 10000n, 10001n, 123456789n]) {
      const { creator, treasury } = expectedSplit(amount);
      expect(creator + treasury).toBe(amount);
    }
  });

  it('gives the treasury the odd wei rather than losing it', () => {
    // 1 wei cannot be split; the creator floors to 0 and the treasury takes it. Nothing
    // may vanish -- a splitter that keeps a remainder is a splitter with residue.
    expect(expectedSplit(1n)).toEqual({ creator: 0n, treasury: 1n });
  });
});

describe('reconcileClaim', () => {
  const base = {
    claimed: 1000n,
    creatorDelta: 950n,
    treasuryDelta: 50n,
    queuedCreator: 0n,
    queuedTreasury: 0n,
    escrowRemaining: 0n,
    splitterRemaining: 0n,
  };

  it('accepts an exact split with nothing left behind', () => {
    expect(reconcileClaim(base).ok).toBe(true);
  });

  it('rejects a creator short by one wei', () => {
    const r = reconcileClaim({ ...base, creatorDelta: 949n, treasuryDelta: 51n });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/creator/i);
  });

  it('rejects residue left in the splitter', () => {
    const r = reconcileClaim({ ...base, splitterRemaining: 7n });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/splitter/i);
  });

  it('rejects a balance still claimable in the escrow', () => {
    const r = reconcileClaim({ ...base, escrowRemaining: 7n });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/escrow/i);
  });

  /**
   * `FeeSplitter` queues a share it cannot deliver rather than reverting the whole
   * split -- a blacklisted recipient, for instance. That is deliberate, and it means the
   * delta alone will not add up. Counted explicitly, so a queued share reconciles while
   * a vanished one does not.
   */
  it('counts a queued share as delivered for reconciliation', () => {
    const r = reconcileClaim({ ...base, creatorDelta: 0n, queuedCreator: 950n });
    expect(r.ok).toBe(true);
  });

  it('still reports a queued share, because it is money not yet received', () => {
    const r = reconcileClaim({ ...base, creatorDelta: 0n, queuedCreator: 950n });
    expect(r.notes.join(' ')).toMatch(/queued/i);
  });

  it('rejects when a queued share does not cover the shortfall', () => {
    const r = reconcileClaim({ ...base, creatorDelta: 0n, queuedCreator: 900n });
    expect(r.ok).toBe(false);
  });

  it('allows an explicitly declared partial claim to leave escrow balance', () => {
    const r = reconcileClaim({ ...base, escrowRemaining: 500n, partialClaim: true });
    expect(r.ok).toBe(true);
    expect(r.notes.join(' ')).toMatch(/partial/i);
  });

  it('emits machine-readable evidence', () => {
    const r = reconcileClaim(base);
    expect(typeof r.evidence).toBe('object');
    expect(r.evidence.claimed).toBe('1000');
    expect(r.evidence.expectedCreator).toBe('950');
  });
});
