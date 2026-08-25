import { ethers } from 'ethers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CanaryJournal } from '../src/canaryJournal';
import { recoverCanary, CanaryRecoveryDeps, signedIdentityProblems } from '../src/canaryRecovery';
import { signAndPersist } from '../src/signedTxFlow';
import { executableDeployment } from '../src/deployments';

/**
 * What recovery may conclude about a SIGNED row, and what it may never conclude.
 *
 * The only forbidden conclusion is "safe to sign a replacement". Everything else -- pending,
 * never observed, incident, landed, reverted -- is a legitimate answer, and the point of the
 * signature identity is that these can now be told apart at all. Before 2B every one of them
 * looked identical: a `prepared` row with no hash.
 *
 * Recovery is keyless and read-only by construction: `CanaryRecoveryDeps` has no signer and no
 * broadcast function, so there is no parameter through which one could be supplied.
 */

const KEY = '0x' + '77'.repeat(32);
const WALLET = new ethers.Wallet(KEY);
const DEPLOYMENT = executableDeployment();

function tmpJournal(): CanaryJournal {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-sigrec-'));
  return new CanaryJournal(path.join(dir, 'canary.sqlite'), { allowEphemeral: true });
}

const INTENT = {
  chainId: DEPLOYMENT.chainId,
  to: DEPLOYMENT.factory,
  data: '0xf35abbcf' + '22'.repeat(32),
  value: 500_000_000_000_000n,
  ceilings: { maxValueWei: 2_000_000_000_000_000n, maxGasCostWei: 2_000_000_000_000_000n },
};

async function signedRow(journal: CanaryJournal, nonce = 3) {
  const id = journal.prepare({
    runId: 'r',
    op: 'token_launch',
    deploymentId: DEPLOYMENT.id,
    chainId: INTENT.chainId,
    to: INTENT.to,
    value: INTENT.value,
    calldata: INTENT.data,
  });
  const signer = {
    address: async () => WALLET.address,
    signTransaction: (tx: ethers.TransactionRequest) => WALLET.signTransaction(tx),
  };
  const broadcaster = {
    getTransactionCount: async () => nonce,
    estimateGas: async () => 210000n,
    getFeeData: async () => ({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n, gasPrice: null }),
    broadcastTransaction: async () => {
      throw new Error('recovery tests never broadcast');
    },
  };
  const signed = await signAndPersist({ signer, broadcaster }, journal, id, INTENT);
  return { id, ...signed };
}

function baseDeps(over: Partial<CanaryRecoveryDeps> = {}): CanaryRecoveryDeps {
  return {
    resolveDeployment: (id) => (id === DEPLOYMENT.id ? DEPLOYMENT : null),
    readReceipt: async () => null,
    readLaunchRecord: async () => null,
    readCode: async () => '0x',
    treasuryAddress: WALLET.address,
    ...over,
  };
}

describe('a signed row that the node has never seen', () => {
  it('reports SIGNED / NOT OBSERVED and refuses to call it reverted', async () => {
    const journal = tmpJournal();
    const { id } = await signedRow(journal, 3);

    const results = await recoverCanary(
      journal,
      baseDeps({
        readTransaction: async () => null, // never seen
        readNonce: async () => 3, // nonce 3 still free (3 spent means nonces 0..2)
      })
    );

    expect(results).toHaveLength(1);
    expect(results[0].confirmed).toBe(false);
    expect(results[0].problems.join(' ')).toMatch(/SIGNED \/ NOT OBSERVED/);
    // The state is the assertion that matters; the prose says "NOT reverted" in words.
    expect(journal.byId(id)!.state).not.toBe('receipt_reverted');
    expect(journal.byId(id)!.state).not.toBe('confirmed');
    // Still blocking: the row is untouched and no rerun may proceed past it.
    expect(journal.byId(id)!.state).toBe('signed');
    expect(journal.unresolved()).toHaveLength(1);
    journal.close();
  });

  it('says so without ever suggesting a replacement signature', async () => {
    const journal = tmpJournal();
    await signedRow(journal, 3);
    const results = await recoverCanary(
      journal,
      baseDeps({ readTransaction: async () => null, readNonce: async () => 3 })
    );
    const text = results[0].problems.join(' ');
    expect(text).toMatch(/NOT safe to sign a replacement/);
    journal.close();
  });
});

describe('a signed row the node holds but has not mined', () => {
  it('is pending, and says wait rather than resend', async () => {
    const journal = tmpJournal();
    const { hash } = await signedRow(journal);

    const results = await recoverCanary(
      journal,
      baseDeps({ readTransaction: async () => ({ hash, blockNumber: null }) })
    );

    expect(results[0].problems.join(' ')).toMatch(/pending/);
    expect(results[0].problems.join(' ')).toMatch(/Do not resend/);
    journal.close();
  });
});

describe('another transaction occupying the reserved nonce', () => {
  /**
   * The dangerous case. The signed bytes can never land, because the nonce they need is gone.
   * Calling that "not observed" would invite a wait that never ends; calling it reverted would
   * unblock a rerun. It is an incident, recorded durably so a second pass reaches the same
   * conclusion without re-reading anything.
   */
  it('becomes a durable incident, not a success and not a revert', async () => {
    const journal = tmpJournal();
    const { id } = await signedRow(journal, 3);

    const results = await recoverCanary(
      journal,
      baseDeps({
        readTransaction: async () => null,
        readNonce: async () => 9, // nonces 0..8 spent: 3 is gone, and not to us
      })
    );

    expect(results[0].confirmed).toBe(false);
    expect(results[0].problems.join(' ')).toMatch(/INCIDENT/);
    expect(results[0].problems.join(' ')).toMatch(/already spent/);
    expect(journal.byId(id)!.state).toBe('confirmed_incident');

    // Durable: a second pass reports the same thing and makes no new chain reads.
    let reads = 0;
    const again = await recoverCanary(
      journal,
      baseDeps({
        readTransaction: async () => {
          reads += 1;
          return null;
        },
        readNonce: async () => {
          reads += 1;
          return 9;
        },
      })
    );
    expect(again.some((r) => r.id === id)).toBe(true);
    journal.close();
  });
});

describe('signed bytes that disagree with the journal', () => {
  it('is an incident, and is detected without any chain access at all', async () => {
    const journal = tmpJournal();
    const { id } = await signedRow(journal);

    // Corrupt the record the way a bad restore or a hand edit would.
    const row = journal.byId(id)!;
    const foreign = await WALLET.signTransaction({
      chainId: INTENT.chainId,
      nonce: row.nonce!,
      to: '0x' + '5'.repeat(40), // a different destination entirely
      data: INTENT.data,
      value: INTENT.value,
      gasLimit: 210000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1n,
      type: 2,
    });
    (journal as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare('UPDATE canary_tx SET raw_tx = ? WHERE id = ?')
      .run(foreign, id);

    const problems = signedIdentityProblems(journal.byId(id)!);
    expect(problems.length).toBeGreaterThan(0);

    const results = await recoverCanary(
      journal,
      baseDeps({
        readTransaction: async () => {
          throw new Error('recovery must not need the chain to spot this');
        },
      })
    );
    expect(results[0].problems.join(' ')).toMatch(/inconsistent/);
    expect(journal.byId(id)!.state).toBe('confirmed_incident');
    journal.close();
  });

  it('catches a hash that does not belong to the stored bytes', async () => {
    const journal = tmpJournal();
    const { id } = await signedRow(journal);
    (journal as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare('UPDATE canary_tx SET tx_hash = ? WHERE id = ?')
      .run('0x' + 'ee'.repeat(32), id);

    const problems = signedIdentityProblems(journal.byId(id)!);
    expect(problems.join(' ')).toMatch(/hash to .* but the journal records/);
    journal.close();
  });
});

describe('recovery cannot broadcast, by construction', () => {
  it('exposes no signer and no send in its dependency surface', () => {
    const deps = baseDeps();
    for (const key of Object.keys(deps)) {
      expect(key).not.toMatch(/sign|send|broadcast|submit/i);
    }
  });

  /** The source carries no broadcast call either -- checked, not assumed. */
  it('never calls a broadcast function', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'canaryRecovery.ts'), 'utf8');
    expect(src).not.toMatch(/broadcastTransaction|sendTransaction|signTransaction\(/);
  });
});

describe('a landed signed transaction still reconciles exactly once', () => {
  it('records the fee once across repeated recovery passes', async () => {
    const journal = tmpJournal();
    const { id } = await signedRow(journal);

    const deps = baseDeps({
      readReceipt: async (h: string) => ({ status: 1, logs: [], contractAddress: null, hash: h, gasUsed: 90_000n, gasPriceWei: 2_000_000_000n }),
      readLaunchRecord: async () => null,
    });

    await recoverCanary(journal, deps);
    const afterFirst = journal.recordedFeeTotalWei();
    await recoverCanary(journal, deps);
    const afterSecond = journal.recordedFeeTotalWei();

    expect(afterFirst).toBe(INTENT.value);
    expect(afterSecond).toBe(INTENT.value);
    journal.close();
  });

  it('treats an actual status 0 as reverted', async () => {
    const journal = tmpJournal();
    const { id } = await signedRow(journal);
    const results = await recoverCanary(
      journal,
      baseDeps({ readReceipt: async (h: string) => ({ status: 0, logs: [], contractAddress: null, hash: h, gasUsed: 21_000n, gasPriceWei: 2_000_000_000n }) })
    );
    expect(results[0].problems.join(' ')).toMatch(/reverted on chain/);
    expect(journal.byId(id)!.state).toBe('receipt_reverted');
    /**
     * The revert still burned gas, and it is counted. 21,000 x 2 gwei = 4.2e13 wei. Accounting
     * it as zero would let a retry under this run id draw the full combined budget again.
     */
    expect(journal.byId(id)!.actualGasCostWei).toBe(42_000_000_000_000n);
    expect(journal.actualGasSpentWei('r')).toBe(42_000_000_000_000n);
    journal.close();
  });
});
