import { ethers } from 'ethers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CanaryJournal } from '../src/canaryJournal';
import { signAndPersist } from '../src/signedTxFlow';
import { gasAllowanceForNext, receiptBindingProblem } from '../src/canaryGasBudget';
import { recoverCanary, CanaryRecoveryDeps } from '../src/canaryRecovery';
import { executableDeployment } from '../src/deployments';

/**
 * Two ways the combined gas budget could still be spent twice.
 *
 * ONE: a reverted transaction burns gas. Evidence was recorded only for status 1, and
 * `actualGasSpentWei` excluded `receipt_reverted` rows, so a reverted splitter cost real money,
 * became terminal, and was accounted as zero -- and a retry under the same deterministic run id
 * was handed the whole reserve again. The double-authority defect returning through the failure
 * path instead of the success one.
 *
 * TWO: the gas figures were attributed on the strength of nothing. `recordGasEvidence` compared
 * the row's hash against an argument the caller had copied FROM the row's hash -- a value
 * against itself, which cannot disagree. Asking a provider for the receipt of hash A is not
 * proof that the object it returns describes hash A, and neither receipt surface carried its
 * own hash to check.
 */

const D = executableDeployment();
const KEY = '0x' + 'c3'.repeat(32);
const TOTAL = 2_000_000_000_000_000n; // 0.002 ETH, the one combined reserve
const RUN = 'reverted-run';

function tmpJournal(): CanaryJournal {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-rev-'));
  return new CanaryJournal(path.join(dir, 'canary.sqlite'), { allowEphemeral: true });
}

const INTENT = {
  chainId: D.chainId,
  to: null as string | null,
  data: '0x60806040' + 'ef'.repeat(32),
  value: 0n,
  ceilings: { maxValueWei: 0n, maxGasCostWei: TOTAL },
};

function signerAndBroadcaster(gasLimit: bigint, maxFeePerGas: bigint, nonce = 5) {
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
      getTransactionCount: async () => nonce,
      estimateGas: async () => gasLimit,
      getFeeData: async () => ({ maxFeePerGas, maxPriorityFeePerGas: 1n, gasPrice: null }),
      broadcastTransaction: async () => {
        state.broadcastCount += 1;
        throw new Error('these tests never broadcast');
      },
    },
  };
}

function prepareSplitter(journal: CanaryJournal) {
  return journal.prepare({
    runId: RUN,
    op: 'splitter_deploy',
    deploymentId: D.id,
    chainId: D.chainId,
    to: '',
    value: 0n,
    calldata: INTENT.data,
  });
}

/** Signs a splitter row and settles it as REVERTED with the given gas cost. */
async function revertedSplitter(journal: CanaryJournal, gasUsed: bigint, gasPriceWei: bigint) {
  const { signer, broadcaster } = signerAndBroadcaster(100_000n, 2_000_000_000n);
  const id = prepareSplitter(journal);
  const signed = await signAndPersist({ signer, broadcaster }, journal, id, INTENT);
  journal.recordGasEvidence(id, { txHash: signed.hash, gasUsed, gasPriceWei });
  journal.recordReceipt(id, { status: 0 });
  return { id, hash: signed.hash };
}

describe('a reverted attempt still spends the budget', () => {
  it('counts reverted gas, so a retry gets only what is left', async () => {
    const journal = tmpJournal();
    // 0.0015 ETH burned by a reverted splitter.
    await revertedSplitter(journal, 750_000n, 2_000_000_000n);
    expect(journal.actualGasSpentWei(RUN)).toBe(1_500_000_000_000_000n);

    // A retry whose worst case is 0.0010 ETH cannot be signed: only 0.0005 remains.
    const { signer, broadcaster, state } = signerAndBroadcaster(500_000n, 2_000_000_000n, 6);
    const retryId = prepareSplitter(journal);
    expect(() =>
      gasAllowanceForNext(
        'splitter retry',
        { totalWei: TOTAL, spentWei: journal.actualGasSpentWei(RUN) },
        1_000_000_000_000_000n
      )
    ).toThrow(/exceeds the remaining combined budget 500000000000000/);

    expect(state.signCount).toBe(0);
    expect(state.broadcastCount).toBe(0);
    expect(journal.byId(retryId)!.state).toBe('prepared');
    void signer;
    void broadcaster;
    journal.close();
  });

  it('leaves nothing at all after a revert that consumed the whole reserve', async () => {
    const journal = tmpJournal();
    await revertedSplitter(journal, 1_000_000n, 2_000_000_000n); // exactly 0.002 ETH
    expect(journal.actualGasSpentWei(RUN)).toBe(TOTAL);

    expect(() =>
      gasAllowanceForNext('anything after this', { totalWei: TOTAL, spentWei: TOTAL }, 1n)
    ).toThrow(/exceeds the remaining combined budget 0/);
    journal.close();
  });

  it('counts a reverted LAUNCH\'s gas while leaving its fee unrecorded', async () => {
    const journal = tmpJournal();
    const { signer, broadcaster } = signerAndBroadcaster(100_000n, 2_000_000_000n);
    const id = journal.prepare({
      runId: RUN,
      op: 'token_launch',
      deploymentId: D.id,
      chainId: D.chainId,
      to: D.factory,
      value: 500_000_000_000_000n,
      calldata: '0xf35abbcf' + '11'.repeat(32),
    });
    const signed = await signAndPersist({ signer, broadcaster }, journal, id, {
      chainId: D.chainId,
      to: D.factory,
      data: '0xf35abbcf' + '11'.repeat(32),
      value: 500_000_000_000_000n,
      ceilings: { maxValueWei: 2_000_000_000_000_000n, maxGasCostWei: TOTAL },
    });
    journal.recordGasEvidence(id, { txHash: signed.hash, gasUsed: 60_000n, gasPriceWei: 2_000_000_000n });
    journal.recordReceipt(id, { status: 0 });

    // Gas counted...
    expect(journal.actualGasSpentWei(RUN)).toBe(120_000_000_000_000n);
    // ...and the FEE is not, because a reverted launch bought no launch.
    expect(journal.byId(id)!.feeRecordedWei).toBeNull();
    expect(journal.recordedFeeTotalWei()).toBe(0n);
    journal.close();
  });

  it('makes the run UNKNOWN when a mined attempt has no usable gas fields', async () => {
    const journal = tmpJournal();
    const { signer, broadcaster } = signerAndBroadcaster(100_000n, 2_000_000_000n);
    const id = prepareSplitter(journal);
    await signAndPersist({ signer, broadcaster }, journal, id, INTENT);
    journal.recordReceipt(id, { status: 0 }); // reverted, no gas evidence recorded

    expect(journal.actualGasSpentWei(RUN)).toBeNull();
    expect(() =>
      gasAllowanceForNext('retry', { totalWei: TOTAL, spentWei: journal.actualGasSpentWei(RUN) }, 1n)
    ).toThrow(/UNKNOWN/);
    journal.close();
  });

  it('sums several settled attempts exactly once each', async () => {
    const journal = tmpJournal();
    await revertedSplitter(journal, 100_000n, 2_000_000_000n); // 0.0002
    // A second settled attempt in the same run.
    const { signer, broadcaster } = signerAndBroadcaster(100_000n, 2_000_000_000n, 6);
    const id2 = prepareSplitter(journal);
    const s2 = await signAndPersist({ signer, broadcaster }, journal, id2, INTENT);
    journal.recordGasEvidence(id2, { txHash: s2.hash, gasUsed: 150_000n, gasPriceWei: 2_000_000_000n });
    journal.recordReceipt(id2, { status: 0 }); // 0.0003

    expect(journal.actualGasSpentWei(RUN)).toBe(500_000_000_000_000n);
    // Recording the same evidence again changes nothing.
    journal.recordGasEvidence(id2, { txHash: s2.hash, gasUsed: 150_000n, gasPriceWei: 2_000_000_000n });
    expect(journal.actualGasSpentWei(RUN)).toBe(500_000_000_000_000n);
    journal.close();
  });
});

describe('a receipt must prove it describes this transaction', () => {
  const MINE = '0x' + 'aa'.repeat(32);

  it('accepts a receipt whose own hash matches', () => {
    expect(receiptBindingProblem(MINE, MINE)).toBeNull();
    expect(receiptBindingProblem(MINE, MINE.toUpperCase().replace('0X', '0x'))).toBeNull();
  });

  it('refuses a receipt for a different transaction', () => {
    const other = '0x' + 'bb'.repeat(32);
    expect(receiptBindingProblem(MINE, other)).toMatch(/is for 0xbb/);
  });

  it('refuses a missing or malformed receipt hash rather than assuming', () => {
    expect(receiptBindingProblem(MINE, null)).toMatch(/no usable transaction hash/);
    expect(receiptBindingProblem(MINE, undefined)).toMatch(/no usable transaction hash/);
    expect(receiptBindingProblem(MINE, '0xabc')).toMatch(/no usable transaction hash/);
  });

  it('refuses when the row has no signed hash to bind to', () => {
    expect(receiptBindingProblem(null, MINE)).toMatch(/no signed transaction hash/);
  });
});

describe('recovery refuses a receipt that is not this transaction', () => {
  const wallet = new ethers.Wallet(KEY);

  async function signedLaunchRow(journal: CanaryJournal) {
    const { signer, broadcaster } = signerAndBroadcaster(100_000n, 2_000_000_000n);
    const id = journal.prepare({
      runId: RUN,
      op: 'token_launch',
      deploymentId: D.id,
      chainId: D.chainId,
      to: D.factory,
      value: 500_000_000_000_000n,
      calldata: '0xf35abbcf' + '11'.repeat(32),
    });
    const signed = await signAndPersist({ signer, broadcaster }, journal, id, {
      chainId: D.chainId,
      to: D.factory,
      data: '0xf35abbcf' + '11'.repeat(32),
      value: 500_000_000_000_000n,
      ceilings: { maxValueWei: 2_000_000_000_000_000n, maxGasCostWei: TOTAL },
    });
    return { id, hash: signed.hash };
  }

  const deps = (over: Partial<CanaryRecoveryDeps> = {}): CanaryRecoveryDeps => ({
    resolveDeployment: (id) => (id === D.id ? D : null),
    readReceipt: async () => null,
    readLaunchRecord: async () => null,
    readCode: async () => '0x',
    treasuryAddress: wallet.address,
    ...over,
  });

  /**
   * Requested hash A, returned a receipt for hash B. Under the old code the gas figures on
   * that object would have been attributed to A, because nothing carried B to compare.
   */
  it('refuses before recording anything when the receipt is for another hash', async () => {
    const journal = tmpJournal();
    const { id } = await signedLaunchRow(journal);
    const foreign = '0x' + 'bb'.repeat(32);

    const out = await recoverCanary(
      journal,
      deps({
        readReceipt: async () => ({
          status: 1,
          logs: [],
          contractAddress: null,
          hash: foreign,
          gasUsed: 90_000n,
          gasPriceWei: 2_000_000_000n,
        }),
      })
    );

    expect(out[0].problems.join(' ')).toMatch(/not bound to the signed transaction/);
    const row = journal.byId(id)!;
    expect(row.state).toBe('confirmed_incident');
    // Nothing was accounted from a receipt that could not be shown to be this one.
    expect(row.actualGasCostWei).toBeNull();
    expect(row.feeRecordedWei).toBeNull();
    journal.close();
  });

  it('refuses a mined receipt with no hash at all', async () => {
    const journal = tmpJournal();
    const { id } = await signedLaunchRow(journal);
    const out = await recoverCanary(
      journal,
      deps({
        readReceipt: async () => ({ status: 1, logs: [], contractAddress: null, gasUsed: 1n, gasPriceWei: 1n }),
      })
    );
    expect(out[0].problems.join(' ')).toMatch(/no usable transaction hash/);
    expect(journal.byId(id)!.actualGasCostWei).toBeNull();
    journal.close();
  });

  it('records gas from a correctly bound receipt, idempotently', async () => {
    const journal = tmpJournal();
    const { id, hash } = await signedLaunchRow(journal);
    const receipt = {
      status: 0,
      logs: [],
      contractAddress: null,
      hash,
      gasUsed: 50_000n,
      gasPriceWei: 2_000_000_000n,
    };
    await recoverCanary(journal, deps({ readReceipt: async () => receipt }));
    expect(journal.byId(id)!.actualGasCostWei).toBe(100_000_000_000_000n);

    // A second pass sees a terminal row, re-reads nothing, and double-counts nothing.
    await recoverCanary(journal, deps({ readReceipt: async () => receipt }));
    expect(journal.actualGasSpentWei(RUN)).toBe(100_000_000_000_000n);
    journal.close();
  });

  it('never invents gas for a null receipt', async () => {
    const journal = tmpJournal();
    const { id } = await signedLaunchRow(journal);
    await recoverCanary(journal, deps({ readReceipt: async () => null }));
    const row = journal.byId(id)!;
    expect(row.actualGasCostWei).toBeNull();
    expect(row.state).not.toBe('receipt_reverted');
    /**
     * Zero, not UNKNOWN -- and the difference is the point. This row is `signed`: it was never
     * handed to a broadcaster, so it has burned nothing. UNKNOWN is reserved for a row that
     * WAS mined and whose cost cannot be read, which is the case that must block.
     */
    expect(row.state).toBe('signed');
    expect(journal.actualGasSpentWei(RUN)).toBe(0n);
    journal.close();
  });
});

/**
 * The provider adapters must pass the receipt's OWN hash through. Source sentinels, because a
 * regression here is invisible: everything still runs, and the binding check silently compares
 * a value with itself again.
 */
describe('the provider adapters carry the receipt hash', () => {
  it('recover-canary maps ethers receipt.hash explicitly', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'recover-canary.ts'), 'utf8');
    expect(src).toMatch(/hash:\s*r\.hash/);
  });

  it('the splitter deployer forwards the receipt hash rather than the requested one', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'splitterDeployer.ts'), 'utf8');
    expect(src).toMatch(/hash:\s*receipt\s*\?\s*receipt\.hash\s*:\s*null/);
  });

  it('the canary script binds both receipts before accounting them', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'phase-b-launch.ts'), 'utf8');
    expect(src.split('receiptBindingProblem(').length - 1).toBeGreaterThanOrEqual(2);
  });
});
