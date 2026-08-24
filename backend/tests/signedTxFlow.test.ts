import { ethers } from 'ethers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CanaryJournal } from '../src/canaryJournal';
import { signAndPersist, broadcastPersisted, TxBroadcaster, PreSigningSigner } from '../src/signedTxFlow';

/**
 * 2B: a transaction that cannot be named after a crash.
 *
 * The old lifecycle was `persist intent -> signer.sendTransaction() -> persist the hash`.
 * `sendTransaction` signs AND broadcasts, so a process that died after the node accepted the
 * bytes but before the call returned left a row saying `prepared`, with no hash, no nonce, no
 * sender and no bytes. Something irreversible may have happened and nothing could say what.
 *
 * These tests drive the real modules -- a real `ethers.Wallet` producing real signatures over
 * real serialised transactions, and the real `CanaryJournal` on a real SQLite file. The only
 * fake is the broadcaster, because the one thing that must not happen here is a broadcast.
 */

const KEY = '0x' + '42'.repeat(32);
const CHAIN = 4663;

function tmpJournal(): { journal: CanaryJournal; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-2b-'));
  const file = path.join(dir, 'canary.sqlite');
  return { journal: new CanaryJournal(file, { allowEphemeral: true }), file };
}

/** A signer that genuinely signs and genuinely cannot broadcast. */
function realSigner(key = KEY): PreSigningSigner & { signCount: number } {
  const wallet = new ethers.Wallet(key);
  const s = {
    signCount: 0,
    address: async () => wallet.address,
    signTransaction: async (tx: ethers.TransactionRequest) => {
      s.signCount += 1;
      return wallet.signTransaction(tx);
    },
  };
  return s;
}

interface FakeBroadcaster extends TxBroadcaster {
  broadcastCount: number;
  nonceReads: number;
  accepted: string[];
}

function fakeBroadcaster(opts: { nonce?: number; onBroadcast?: (raw: string) => void } = {}): FakeBroadcaster {
  const b: FakeBroadcaster = {
    broadcastCount: 0,
    nonceReads: 0,
    accepted: [],
    async getTransactionCount() {
      b.nonceReads += 1;
      return opts.nonce ?? 7;
    },
    async estimateGas() {
      return 210000n;
    },
    async getFeeData() {
      return { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, gasPrice: null };
    },
    async broadcastTransaction(raw: string) {
      b.broadcastCount += 1;
      b.accepted.push(raw);
      opts.onBroadcast?.(raw);
      const decoded = ethers.Transaction.from(raw);
      return { hash: decoded.hash!, wait: async () => null };
    },
  };
  return b;
}

/** Gas at the fixture's own numbers: 210,000 x 2 gwei = 0.00042 ETH, well under the budget. */
const GAS_CEILING = 2_000_000_000_000_000n;

const LAUNCH_INTENT = {
  chainId: CHAIN,
  to: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  data: '0xf35abbcf' + '11'.repeat(64),
  value: 500_000_000_000_000n,
  ceilings: { maxValueWei: 2_000_000_000_000_000n, maxGasCostWei: GAS_CEILING },
};

/** A contract creation: no destination at all, which is the shape that must survive. */
const SPLITTER_INTENT = {
  chainId: CHAIN,
  to: null as string | null,
  data: '0x60806040' + 'ab'.repeat(40),
  value: 0n,
  /** A creation carries nothing: zero is the ceiling, not a starting point. */
  ceilings: { maxValueWei: 0n, maxGasCostWei: GAS_CEILING },
};

function prepareRow(journal: CanaryJournal, op: 'token_launch' | 'splitter_deploy', intent: typeof LAUNCH_INTENT | typeof SPLITTER_INTENT) {
  return journal.prepare({
    runId: 'run-1',
    op,
    deploymentId: 'pons-v2-current-7ed',
    chainId: intent.chainId,
    to: intent.to ?? '',
    value: intent.value,
    calldata: intent.data,
  });
}

const BOTH: Array<['token_launch' | 'splitter_deploy', typeof LAUNCH_INTENT | typeof SPLITTER_INTENT]> = [
  ['token_launch', LAUNCH_INTENT],
  ['splitter_deploy', SPLITTER_INTENT],
];

describe.each(BOTH)('2B for %s', (op, intent) => {
  /**
   * RED, against the shape the old code had.
   *
   * `bindHashLegacy` is exactly what the previous lifecycle could do: move a row to
   * `broadcast` with a hash, and only once `sendTransaction` had already returned. Crash
   * before that and the row is what this test asserts -- an intent, and nothing identifying.
   */
  it('RED: the pre-2B lifecycle leaves nothing that identifies the transaction', () => {
    const { journal } = tmpJournal();
    const id = prepareRow(journal, op, intent);
    // The process dies inside sendTransaction. Nothing else runs.
    const row = journal.byId(id)!;
    expect(row.state).toBe('prepared');
    expect(row.txHash).toBeNull();
    expect(row.sender).toBeNull();
    expect(row.nonce).toBeNull();
    expect(row.rawTx).toBeNull();
    journal.close();
  });

  it('GREEN: identity is durable before a broadcast is reachable', async () => {
    const { journal, file } = tmpJournal();
    const signer = realSigner();
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, op, intent);

    const signed = await signAndPersist({ signer, broadcaster }, journal, id, intent);

    // Nothing has been broadcast at this point, and the row can already name the transaction.
    expect(broadcaster.broadcastCount).toBe(0);
    const row = journal.byId(id)!;
    expect(row.state).toBe('signed');
    expect(row.txHash).toBe(signed.hash);
    expect(row.sender).toBe(new ethers.Wallet(KEY).address);
    expect(row.nonce).toBe(7);
    expect(row.rawTx).toBeTruthy();

    // Durable: a separate handle on the same file sees it, so it survives process death.
    journal.close();
    const reopened = new CanaryJournal(file, { allowEphemeral: true });
    const persisted = reopened.byId(id)!;
    expect(persisted.txHash).toBe(signed.hash);
    expect(persisted.rawTx).toBe(row.rawTx);
    reopened.close();
  });

  it('the persisted hash is recomputed from the bytes, not taken from anyone', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, op, intent);
    const signed = await signAndPersist({ signer, broadcaster }, journal, id, intent);

    expect(ethers.Transaction.from(journal.byId(id)!.rawTx!).hash).toBe(signed.hash);
    journal.close();
  });

  it('a persistence failure before broadcast means nothing is broadcast', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, op, intent);
    jest.spyOn(journal, 'recordSigned').mockImplementation(() => {
      throw new Error('disk full');
    });

    await expect(signAndPersist({ signer, broadcaster }, journal, id, intent)).rejects.toThrow('disk full');
    expect(broadcaster.broadcastCount).toBe(0);
    jest.restoreAllMocks();
    journal.close();
  });

  it('a crash immediately after the broadcast call still leaves the exact hash', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    const broadcaster = fakeBroadcaster({
      onBroadcast: () => {
        throw new Error('process died mid-broadcast');
      },
    });
    const id = prepareRow(journal, op, intent);
    const signed = await signAndPersist({ signer, broadcaster }, journal, id, intent);

    await expect(broadcastPersisted({ broadcaster }, journal, id)).rejects.toThrow('mid-broadcast');

    const row = journal.byId(id)!;
    expect(row.state).toBe('broadcast'); // marked before the call, deliberately
    expect(row.txHash).toBe(signed.hash);
    expect(row.rawTx).toBeTruthy();
    journal.close();
  });

  it('a broadcaster timeout does not cause a second signature or a second nonce', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    const broadcaster = fakeBroadcaster({
      onBroadcast: () => {
        throw new Error('ETIMEDOUT');
      },
    });
    const id = prepareRow(journal, op, intent);
    await signAndPersist({ signer, broadcaster }, journal, id, intent);
    await expect(broadcastPersisted({ broadcaster }, journal, id)).rejects.toThrow('ETIMEDOUT');

    expect(signer.signCount).toBe(1);
    expect(broadcaster.nonceReads).toBe(1);
    journal.close();
  });

  it('"already known" resolves to the SAME hash and never re-signs', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    const broadcaster = fakeBroadcaster({
      onBroadcast: () => {
        throw new Error('already known');
      },
    });
    const id = prepareRow(journal, op, intent);
    const signed = await signAndPersist({ signer, broadcaster }, journal, id, intent);

    const sent = await broadcastPersisted({ broadcaster }, journal, id);
    expect(sent.hash).toBe(signed.hash);
    expect(signer.signCount).toBe(1);
    journal.close();
  });

  it('broadcasts exactly the persisted bytes', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, op, intent);
    await signAndPersist({ signer, broadcaster }, journal, id, intent);
    const stored = journal.byId(id)!.rawTx!;

    await broadcastPersisted({ broadcaster }, journal, id);
    expect(broadcaster.accepted).toEqual([stored]);
    journal.close();
  });

  it('refuses to broadcast a row that was never signed', async () => {
    const { journal } = tmpJournal();
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, op, intent);

    await expect(broadcastPersisted({ broadcaster }, journal, id)).rejects.toThrow(/not signed/);
    expect(broadcaster.broadcastCount).toBe(0);
    journal.close();
  });

  it('refuses a second signature over an already-signed row', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, op, intent);
    await signAndPersist({ signer, broadcaster }, journal, id, intent);

    /**
     * Refused at the nonce check, which comes first and is the stronger of the two guards:
     * the row's own state would also have refused it, but only after a second signature had
     * been requested. Nothing broadcastable is created for an operation already signed.
     */
    await expect(signAndPersist({ signer, broadcaster }, journal, id, intent)).rejects.toThrow(
      /already used by canary row|not prepared|signed exactly once/
    );
    expect(signer.signCount).toBe(1);
    journal.close();
  });

  /**
   * A signer that signs something other than what it was asked to sign.
   *
   * Not a hypothetical: a signature is over bytes, and the only way to know those bytes are
   * the intended transaction is to decode them and look. The failure must happen before
   * anything is persisted, because a persisted signature is broadcastable by anyone.
   */
  it('fails closed when the returned bytes do not match the intent', async () => {
    const { journal } = tmpJournal();
    const wallet = new ethers.Wallet(KEY);
    const liar: PreSigningSigner = {
      address: async () => wallet.address,
      signTransaction: async (tx) =>
        wallet.signTransaction({ ...tx, value: (tx.value as bigint) + 1n }),
    };
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, op, intent);

    await expect(signAndPersist({ signer: liar, broadcaster }, journal, id, intent)).rejects.toThrow(
      /do not match the journalled intent/
    );
    const row = journal.byId(id)!;
    expect(row.state).toBe('prepared');
    expect(row.rawTx).toBeNull();
    expect(broadcaster.broadcastCount).toBe(0);
    journal.close();
  });

  it('refuses bytes signed for a different chain', async () => {
    const { journal } = tmpJournal();
    const wallet = new ethers.Wallet(KEY);
    const wrongChain: PreSigningSigner = {
      address: async () => wallet.address,
      signTransaction: async (tx) => wallet.signTransaction({ ...tx, chainId: 1 }),
    };
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, op, intent);

    await expect(signAndPersist({ signer: wrongChain, broadcaster }, journal, id, intent)).rejects.toThrow(
      /chainId/
    );
    journal.close();
  });

  it('does not let a second run prepare while this one is signed', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, op, intent);
    await signAndPersist({ signer, broadcaster }, journal, id, intent);

    expect(() => prepareRow(journal, op, intent)).toThrow(/unresolved/);
    expect(signer.signCount).toBe(1);
    expect(broadcaster.broadcastCount).toBe(0);
    journal.close();
  });
});

/**
 * The economics of the transaction, which were built and then never checked.
 *
 * Measured against the previous code: a signer returning gasLimit 999,999 instead of 21,000
 * and maxFeePerGas 999,999,999,999 instead of 2 was accepted, and the row was persisted as
 * `signed`. Gas comes out of the same hot wallet the ceilings exist to protect, so "only the
 * fee changed" is not a smaller problem than a changed destination -- it is a spend nobody
 * authorised, attached to bytes that are already broadcastable.
 */
describe.each(BOTH)('signer-mutated gas and fee bytes are refused for %s', (op, intent) => {
  const mutating = (change: (tx: ethers.TransactionRequest) => ethers.TransactionRequest) => {
    const wallet = new ethers.Wallet(KEY);
    return {
      address: async () => wallet.address,
      signTransaction: async (tx: ethers.TransactionRequest) => wallet.signTransaction(change({ ...tx })),
    } as PreSigningSigner;
  };

  const refuses = async (
    change: (tx: ethers.TransactionRequest) => ethers.TransactionRequest,
    pattern: RegExp
  ) => {
    const { journal } = tmpJournal();
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, op, intent);
    await expect(
      signAndPersist({ signer: mutating(change), broadcaster }, journal, id, intent)
    ).rejects.toThrow(pattern);
    // Refused BEFORE persistence, so nothing broadcastable was written down.
    const row = journal.byId(id)!;
    expect(row.state).toBe('prepared');
    expect(row.rawTx).toBeNull();
    expect(broadcaster.broadcastCount).toBe(0);
    journal.close();
  };

  it('refuses an inflated gasLimit', () =>
    refuses((tx) => ({ ...tx, gasLimit: 999_999n }), /gasLimit .* != populated/));

  it('refuses an inflated maxFeePerGas', () =>
    refuses((tx) => ({ ...tx, maxFeePerGas: 999_999_999_999n }), /maxFeePerGas .* != populated/));

  it('refuses a changed maxPriorityFeePerGas', () =>
    refuses(
      (tx) => ({ ...tx, maxPriorityFeePerGas: 999_999_999n }),
      /maxPriorityFeePerGas .* != populated/
    ));

  /** Type 0 reinterprets the fee fields entirely: gasPrice replaces the 1559 pair. */
  it('refuses a downgrade to a legacy transaction', () =>
    refuses(
      (tx) => ({
        ...tx,
        type: 0,
        gasPrice: 3_000_000_000n,
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
      }),
      /transaction type 0 != populated 2|gasPrice/
    ));

  it('refuses an access list nobody asked for', () =>
    refuses(
      (tx) => ({
        ...tx,
        type: 2,
        accessList: [{ address: '0x' + '4'.repeat(40), storageKeys: ['0x' + '0'.repeat(64)] }],
      }),
      /access list/
    ));
});

describe('the ceilings are required and bind before signing', () => {
  it('refuses a gas cost above the gas ceiling, without asking for a signature', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    // 210,000 gas x 2 gwei = 4.2e14 wei. A ceiling below that must refuse.
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, 'token_launch', LAUNCH_INTENT);
    await expect(
      signAndPersist({ signer, broadcaster }, journal, id, {
        ...LAUNCH_INTENT,
        ceilings: { maxValueWei: LAUNCH_INTENT.ceilings.maxValueWei, maxGasCostWei: 1_000n },
      })
    ).rejects.toThrow(/worst-case gas cost .* exceeds the gas ceiling/);
    expect(signer.signCount).toBe(0);
    journal.close();
  });

  /**
   * The two ceilings are separate, and this is the case that proves it. A generous gas budget
   * must never authorise carrying value: a splitter creation may cost gas and must carry zero.
   */
  it('refuses value on a creation however large the gas budget is', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, 'splitter_deploy', SPLITTER_INTENT);
    await expect(
      signAndPersist({ signer, broadcaster }, journal, id, {
        ...SPLITTER_INTENT,
        value: 1_000_000_000_000_000_000n, // 1 ETH into a contract creation
        ceilings: { maxValueWei: 0n, maxGasCostWei: 10n ** 18n },
      })
    ).rejects.toThrow(/value .* exceeds the value ceiling 0/);
    expect(signer.signCount).toBe(0);
    journal.close();
  });

  it('accepts a transaction inside both ceilings', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, 'token_launch', LAUNCH_INTENT);
    await signAndPersist({ signer, broadcaster }, journal, id, LAUNCH_INTENT);
    expect(journal.byId(id)!.state).toBe('signed');
    journal.close();
  });
});

describe('the journal is not readable by anyone but its owner', () => {
  /**
   * `raw_tx` is a complete signed transaction: whoever reads it can broadcast it, from any
   * machine, with no key. Under an ordinary umask the journal was created 0644.
   *
   * WAL and SHM are checked too, and they are the interesting ones -- SQLite writes the newest
   * pages there before checkpointing, so the rows most likely to be unresolved live in the
   * sidecar first.
   */
  const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

  it('creates the database and its sidecars owner-only', async () => {
    const previous = typeof process.umask === 'function' ? process.umask(0o022) : null;
    try {
      const { journal, file } = tmpJournal();
      const signer = realSigner();
      const broadcaster = fakeBroadcaster();
      const id = prepareRow(journal, 'token_launch', LAUNCH_INTENT);
      // Forces the WAL into existence, and is the write that puts raw bytes on disk.
      await signAndPersist({ signer, broadcaster }, journal, id, LAUNCH_INTENT);

      const present = [file, `${file}-wal`, `${file}-shm`].filter((p) => fs.existsSync(p));
      expect(present).toContain(file);

      if (process.platform !== 'win32') {
        for (const p of present) {
          expect(modeOf(p) & 0o077).toBe(0);
        }
      } else {
        // Windows reports a synthesised mode; the real control is the ACL, which the journal
        // sets and verifies on open. Reaching here at all means that verification passed.
        expect(fs.existsSync(file)).toBe(true);
      }
      journal.close();
    } finally {
      if (previous !== null) process.umask(previous);
    }
  });

  it('tightens an existing world-readable journal before writing raw bytes', async () => {
    if (process.platform === 'win32') return; // mode bits are not the mechanism here
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-2b-mode-'));
    const file = path.join(dir, 'canary.sqlite');

    // A journal from before this guard existed.
    const Database = require('better-sqlite3');
    const raw = new Database(file);
    raw.exec('CREATE TABLE t (a INTEGER)');
    raw.close();
    fs.chmodSync(file, 0o644);
    expect(modeOf(file) & 0o077).not.toBe(0);

    const journal = new CanaryJournal(file, { allowEphemeral: true });
    expect(modeOf(file) & 0o077).toBe(0);
    journal.close();
  });
});

describe('contract creation keeps creation semantics', () => {
  it('signs a true creation, with no destination invented', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, 'splitter_deploy', SPLITTER_INTENT);

    await signAndPersist({ signer, broadcaster }, journal, id, SPLITTER_INTENT);
    const decoded = ethers.Transaction.from(journal.byId(id)!.rawTx!);

    expect(decoded.to).toBeNull();
    expect(decoded.data).toBe(SPLITTER_INTENT.data);
    journal.close();
  });

  /**
   * The journal stores '' for a creation and the EVM wants null. A transaction signed to the
   * zero address is a call to a real, reachable contract slot -- not a creation -- so the
   * conversion has to be explicit in both directions.
   */
  it('never signs a creation as a call to the zero address', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    const broadcaster = fakeBroadcaster();
    const id = prepareRow(journal, 'splitter_deploy', SPLITTER_INTENT);

    await signAndPersist({ signer, broadcaster }, journal, id, SPLITTER_INTENT);
    const decoded = ethers.Transaction.from(journal.byId(id)!.rawTx!);
    expect(decoded.to).not.toBe(ethers.ZeroAddress);
    journal.close();
  });
});

describe('the two operations hold independent identities', () => {
  it('a splitter creation and a launch never share a hash or a nonce', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    const id1 = prepareRow(journal, 'splitter_deploy', SPLITTER_INTENT);
    await signAndPersist(
      { signer, broadcaster: fakeBroadcaster({ nonce: 7 }) },
      journal,
      id1,
      SPLITTER_INTENT
    );
    // Settle it so the next operation may be prepared.
    journal.recordReceipt(id1, { status: 1 });
    journal.markConfirmedAnyState(id1, { token: null, splitterAddress: '0x' + '9'.repeat(40) });

    const id2 = prepareRow(journal, 'token_launch', LAUNCH_INTENT);
    await signAndPersist(
      { signer, broadcaster: fakeBroadcaster({ nonce: 8 }) },
      journal,
      id2,
      LAUNCH_INTENT
    );

    const a = journal.byId(id1)!;
    const b = journal.byId(id2)!;
    expect(a.txHash).not.toBe(b.txHash);
    expect(a.nonce).toBe(7);
    expect(b.nonce).toBe(8);
    journal.close();
  });

  /**
   * A spent nonce is gone forever, including one spent by a transaction that already landed.
   *
   * This test originally expected the partial unique index to catch it and was wrong: the
   * index excludes settled rows deliberately, so a CONFIRMED row at nonce 7 did not block a
   * second signature at nonce 7. The bytes would have been unmineable from the moment they
   * existed, while looking like a perfectly good signed transaction. The refusal belongs in
   * the flow, before a signature is requested, and that is where it now lives.
   */
  it('refuses to sign at a nonce this journal has already used, even a settled one', async () => {
    const { journal } = tmpJournal();
    const signer = realSigner();
    const id1 = prepareRow(journal, 'splitter_deploy', SPLITTER_INTENT);
    await signAndPersist({ signer, broadcaster: fakeBroadcaster({ nonce: 7 }) }, journal, id1, SPLITTER_INTENT);
    journal.recordReceipt(id1, { status: 1 });
    journal.markConfirmedAnyState(id1, { token: null, splitterAddress: '0x' + '9'.repeat(40) });

    // A provider reporting a stale pending count hands back 7 again.
    const id2 = prepareRow(journal, 'token_launch', LAUNCH_INTENT);
    await expect(
      signAndPersist({ signer, broadcaster: fakeBroadcaster({ nonce: 7 }) }, journal, id2, LAUNCH_INTENT)
    ).rejects.toThrow(/already used by canary row/);

    // Refused BEFORE the signature: exactly one signature exists across both operations.
    expect(signer.signCount).toBe(1);
    expect(journal.byId(id2)!.state).toBe('prepared');
    journal.close();
  });
});

describe('journals written before signature identity existed', () => {
  /**
   * Backward compatibility, tested rather than asserted. An operator's existing journal has
   * no sender/nonce/raw_tx columns at all; opening it must migrate in place and leave the old
   * rows readable and honest about what they lack.
   */
  it('migrates an old journal and reports old rows as carrying no identity', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-2b-old-'));
    const file = path.join(dir, 'old.sqlite');

    // A journal exactly as the pre-2B schema wrote it.
    const Database = require('better-sqlite3');
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE canary_tx (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL, op TEXT NOT NULL, deployment_id TEXT NOT NULL,
        chain_id INTEGER NOT NULL, to_address TEXT NOT NULL, value_wei TEXT NOT NULL,
        calldata TEXT NOT NULL, token_name TEXT, token_symbol TEXT, salt TEXT,
        pair_token TEXT, splitter_address TEXT, state TEXT NOT NULL, tx_hash TEXT,
        token TEXT, problems TEXT NOT NULL DEFAULT '[]', fee_recorded_wei TEXT,
        prepared_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO canary_tx (run_id, op, deployment_id, chain_id, to_address, value_wei,
        calldata, state, tx_hash, problems, prepared_at, updated_at)
      VALUES ('old-run','token_launch','pons-v2-current-7ed',4663,'0xabc','0','0x','broadcast',
              '0xdead', '[]', '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
    `);
    raw.close();

    const journal = new CanaryJournal(file, { allowEphemeral: true });
    const rows = journal.unresolved();
    expect(rows).toHaveLength(1);
    expect(rows[0].txHash).toBe('0xdead');
    // Honest about what it never had.
    expect(rows[0].sender).toBeNull();
    expect(rows[0].nonce).toBeNull();
    expect(rows[0].rawTx).toBeNull();
    expect(journal.integrityOk()).toBe(true);
    journal.close();
  });
});
