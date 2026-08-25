import { ethers } from 'ethers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CanaryJournal } from '../src/canaryJournal';
import { signAndPersist } from '../src/signedTxFlow';
import {
  gasAllowanceForNext,
  remainingGasBudgetWei,
  reconcileCombinedGas,
} from '../src/canaryGasBudget';

/**
 * ONE gas reserve for the whole run, enforced once.
 *
 * `TREASURY_GAS_RESERVE_WEI` was handed to BOTH irreversible operations as `maxGasCostWei`,
 * independently. Measured against the baseline, `grep -n maxGasCostWei scripts/phase-b-launch.ts`
 * returned two lines, both `preflightEnv().TREASURY_GAS_RESERVE_WEI`. So one canary run could
 * sign 0.0005 ETH of value plus up to 0.002 ETH of splitter gas plus up to 0.002 ETH of launch
 * gas -- 0.0045 ETH against a reserve authorised as 0.002 ETH for the complete run. The
 * ceiling was enforced twice and therefore bounded nothing anybody had agreed to.
 *
 * The launch now receives the total minus the splitter's PERSISTED actual cost, and an unknown
 * splitter cost blocks rather than defaulting to the full budget again.
 */

const TOTAL = 2_000_000_000_000_000n; // 0.002 ETH
const KEY = '0x' + '9a'.repeat(32);
const CHAIN = 4663;

function tmpJournal(): CanaryJournal {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-gas-'));
  return new CanaryJournal(path.join(dir, 'canary.sqlite'), { allowEphemeral: true });
}

const SPLITTER_INTENT = {
  chainId: CHAIN,
  to: null as string | null,
  data: '0x60806040' + 'cd'.repeat(32),
  value: 0n,
  ceilings: { maxValueWei: 0n, maxGasCostWei: TOTAL },
};

function prepare(journal: CanaryJournal, op: 'splitter_deploy' | 'token_launch') {
  return journal.prepare({
    runId: 'gas-run',
    op,
    deploymentId: 'pons-v2-current-7ed',
    chainId: CHAIN,
    to: op === 'splitter_deploy' ? '' : '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
    value: op === 'splitter_deploy' ? 0n : 500_000_000_000_000n,
    calldata: SPLITTER_INTENT.data,
  });
}

/** Signs for real with a throwaway key; the broadcaster is a fake that never sends. */
function signerAndBroadcaster(gasLimit: bigint, maxFeePerGas: bigint) {
  const wallet = new ethers.Wallet(KEY);
  const state = { signCount: 0, broadcastCount: 0 };
  return {
    state,
    signer: {
      address: async () => wallet.address,
      signTransaction: async (tx: ethers.TransactionRequest) => {
        state.signCount += 1;
        return wallet.signTransaction(tx);
      },
    },
    broadcaster: {
      getTransactionCount: async () => 11,
      estimateGas: async () => gasLimit,
      getFeeData: async () => ({ maxFeePerGas, maxPriorityFeePerGas: 1n, gasPrice: null }),
      broadcastTransaction: async () => {
        state.broadcastCount += 1;
        throw new Error('these tests never broadcast');
      },
    },
  };
}

describe('the combined budget is one reserve, not one per transaction', () => {
  it('refuses a splitter whose worst case already exceeds the whole budget', async () => {
    const journal = tmpJournal();
    // 200,000 gas x 20 gwei = 0.004 ETH, twice the reserve.
    const { signer, broadcaster, state } = signerAndBroadcaster(200_000n, 20_000_000_000n);
    const id = prepare(journal, 'splitter_deploy');

    await expect(
      signAndPersist({ signer, broadcaster }, journal, id, {
        ...SPLITTER_INTENT,
        ceilings: {
          maxValueWei: 0n,
          maxGasCostWei: gasAllowanceForNext(
            'splitter creation',
            { totalWei: TOTAL, spentWei: journal.actualGasSpentWei('gas-run') },
            0n
          ),
        },
      })
    ).rejects.toThrow(/exceeds the gas ceiling/);

    expect(state.signCount).toBe(0);
    expect(state.broadcastCount).toBe(0);
    journal.close();
  });

  /**
   * The scenario the reviewer named. Under the old code both signatures were allowed, because
   * each was measured against the full reserve on its own.
   */
  it('refuses a launch whose worst case exceeds what the splitter LEFT', () => {
    const splitterActual = 1_500_000_000_000_000n; // 0.0015 ETH
    const launchWorstCase = 1_500_000_000_000_000n; // 0.0015 ETH

    expect(remainingGasBudgetWei({ totalWei: TOTAL, spentWei: splitterActual })).toBe(
      500_000_000_000_000n
    );

    let message = '';
    try {
      gasAllowanceForNext('token launch', { totalWei: TOTAL, spentWei: splitterActual }, launchWorstCase);
    } catch (e) {
      message = (e as Error).message;
    }
    // The refusal names all four numbers, so an operator is not left guessing which one moved.
    expect(message).toMatch(/worst-case gas 1500000000000000/);
    expect(message).toMatch(/remaining combined budget 500000000000000/);
    expect(message).toMatch(/total 2000000000000000/);
    expect(message).toMatch(/already spent 1500000000000000/);
  });

  it('allows a launch that fits in the remainder', () => {
    const allowance = gasAllowanceForNext(
      'token launch',
      { totalWei: TOTAL, spentWei: 800_000_000_000_000n },
      1_200_000_000_000_000n
    );
    expect(allowance).toBe(1_200_000_000_000_000n);
    // Exactly the budget when both are added: 0.0008 + 0.0012 = 0.002.
    expect(800_000_000_000_000n + 1_200_000_000_000_000n).toBe(TOTAL);
  });

  it('accepts the exact boundary and refuses one wei above it', () => {
    const spent = 1_000_000_000_000_000n;
    expect(() =>
      gasAllowanceForNext('token launch', { totalWei: TOTAL, spentWei: spent }, TOTAL - spent)
    ).not.toThrow();
    expect(() =>
      gasAllowanceForNext('token launch', { totalWei: TOTAL, spentWei: spent }, TOTAL - spent + 1n)
    ).toThrow(/exceeds the remaining combined budget/);
  });

  /** An unknown remainder is not a full one. */
  it('refuses to sign at all while any settled cost is UNKNOWN', () => {
    expect(() =>
      gasAllowanceForNext('token launch', { totalWei: TOTAL, spentWei: null }, 1n)
    ).toThrow(/UNKNOWN/);
  });
});

describe('gas evidence is canonical, bound, and immutable', () => {
  const gasUsed = 150_000n;
  const gasPriceWei = 5_000_000_000n; // 0.00075 ETH product

  async function signedRow(journal: CanaryJournal) {
    const { signer, broadcaster } = signerAndBroadcaster(150_000n, 5_000_000_000n);
    const id = prepare(journal, 'splitter_deploy');
    const signed = await signAndPersist({ signer, broadcaster }, journal, id, SPLITTER_INTENT);
    journal.recordReceipt(id, { status: 1 });
    return { id, hash: signed.hash };
  }

  it('computes the product itself rather than trusting a total', async () => {
    const journal = tmpJournal();
    const { id, hash } = await signedRow(journal);
    journal.recordGasEvidence(id, { txHash: hash, gasUsed, gasPriceWei });

    const row = journal.byId(id)!;
    expect(row.gasUsed).toBe(gasUsed);
    expect(row.gasPriceWei).toBe(gasPriceWei);
    expect(row.actualGasCostWei).toBe(gasUsed * gasPriceWei);
    expect(row.gasReceiptHash).toBe(hash);
    journal.close();
  });

  it('refuses evidence bound to a different transaction', async () => {
    const journal = tmpJournal();
    const { id } = await signedRow(journal);
    expect(() =>
      journal.recordGasEvidence(id, { txHash: '0x' + 'ab'.repeat(32), gasUsed, gasPriceWei })
    ).toThrow(/Refusing to account gas against the wrong transaction/);
    expect(journal.byId(id)!.actualGasCostWei).toBeNull();
    journal.close();
  });

  it('refuses zero or negative readings rather than reading them as free', async () => {
    const journal = tmpJournal();
    const { id, hash } = await signedRow(journal);
    expect(() => journal.recordGasEvidence(id, { txHash: hash, gasUsed: 0n, gasPriceWei })).toThrow(
      /must both be positive/
    );
    expect(() =>
      journal.recordGasEvidence(id, { txHash: hash, gasUsed, gasPriceWei: -1n })
    ).toThrow(/must both be positive/);
    journal.close();
  });

  it('is idempotent for identical evidence and refuses a contradiction', async () => {
    const journal = tmpJournal();
    const { id, hash } = await signedRow(journal);
    journal.recordGasEvidence(id, { txHash: hash, gasUsed, gasPriceWei });
    // Same again: a no-op, not a second charge.
    journal.recordGasEvidence(id, { txHash: hash, gasUsed, gasPriceWei });
    expect(journal.byId(id)!.actualGasCostWei).toBe(gasUsed * gasPriceWei);

    expect(() =>
      journal.recordGasEvidence(id, { txHash: hash, gasUsed: gasUsed + 1n, gasPriceWei })
    ).toThrow(/A contradiction is an incident, not an update/);
    journal.close();
  });

  /** Unknown is contagious: one unrecorded settled row makes the run's total unknown. */
  it('reports the run total as UNKNOWN while any settled row lacks evidence', async () => {
    const journal = tmpJournal();
    const { id, hash } = await signedRow(journal);
    expect(journal.actualGasSpentWei('gas-run')).toBeNull();
    journal.recordGasEvidence(id, { txHash: hash, gasUsed, gasPriceWei });
    expect(journal.actualGasSpentWei('gas-run')).toBe(gasUsed * gasPriceWei);
    journal.close();
  });

  /** Old journals predate these columns entirely and must stay honest about it. */
  it('leaves pre-existing rows UNKNOWN rather than zero', async () => {
    const journal = tmpJournal();
    const { id } = await signedRow(journal);
    const row = journal.byId(id)!;
    expect(row.gasUsed).toBeNull();
    expect(row.actualGasCostWei).toBeNull();
    expect(row.gasRecordedAt).toBeNull();
    journal.close();
  });
});

describe('the closing reconciliation', () => {
  it('confirms a run inside its budget', () => {
    const r = reconcileCombinedGas(TOTAL, 1_900_000_000_000_000n);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/within the budget/);
  });

  it('calls an over-budget actual an INCIDENT, not a success', () => {
    const r = reconcileCombinedGas(TOTAL, TOTAL + 1n);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/INCIDENT/);
    expect(r.detail).toMatch(/Do not retry/);
  });

  it('does not reconcile when the actual total is unknown', () => {
    const r = reconcileCombinedGas(TOTAL, null);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/UNKNOWN/);
  });
});

/**
 * A source sentinel, not the proof -- the behavioural tests above are that. It exists because
 * the defect WAS two identical call sites, and a regression would look exactly like them.
 */
describe('the executable script never hands the full budget to both operations', () => {
  const CODE = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'phase-b-launch.ts'),
    'utf8'
  );

  it('passes no raw TREASURY_GAS_RESERVE_WEI as a per-transaction ceiling', () => {
    expect(CODE).not.toMatch(/maxGasCostWei:\s*preflightEnv\(\)\.TREASURY_GAS_RESERVE_WEI/);
  });

  it('derives both allowances through the shared budget helper', () => {
    const uses = CODE.split('gasAllowanceForNext(').length - 1;
    expect(uses).toBeGreaterThanOrEqual(2);
  });

  it('reconciles the combined actual cost at the end', () => {
    expect(CODE).toMatch(/reconcileCombinedGas\(/);
  });
});
