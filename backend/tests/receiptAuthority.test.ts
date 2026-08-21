import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ethers } from 'ethers';
import { handleMention } from '../src/orchestrator';
import { Db } from '../src/db';
import { executableDeployment } from '../src/deployments';
import { PONS_V2_CURRENT_ABI, buildCurrentV2LaunchCalldata, launchSalt } from '../src/ponsV2CurrentEncoder';
import { LaunchTarget } from '../src/launchTarget';

/**
 * Which log in a receipt is allowed to name the launched token.
 *
 * A transaction touches many contracts and the receipt carries every log each of them
 * raised. `TokenLaunched(address,address,address,address,uint256,uint256)` is not unique
 * to pons -- it is a common enough shape that any contract may emit it, deliberately or
 * otherwise -- so decoding "the first log that parses" reads whatever came first.
 *
 * The orchestrator did exactly that: `launchTarget.extractToken(receipt.logs)` ran first
 * and its answer became the persisted token, the success reply, and the address a
 * creator would later be told to claim fees against. The correctly scoped decoder ran
 * afterwards and could only complain about a record already written.
 *
 * A foreign log ordered before the real one therefore decided what Ponsr believed it had
 * launched.
 */

const D = executableDeployment();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-receipt-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const SPLITTER = '0x9999999999999999999999999999999999999999';
const REAL_TOKEN = '0x1111111111111111111111111111111111111111';
const REAL_CURVE = '0x2222222222222222222222222222222222222222';
const FOREIGN_TOKEN = ethers.getAddress('0x' + 'ba'.repeat(20));
const IMPOSTOR = '0x6666666666666666666666666666666666666666';
const LIVE_FEE = 500_000_000_000_000n;

const iface = new ethers.Interface(PONS_V2_CURRENT_ABI);

function launchedLog(emitter: string, token: string, curve: string, pair: string) {
  const enc = iface.encodeEventLog('TokenLaunched', [token, curve, TREASURY, pair, 0n, 0n]);
  return { address: emitter, topics: enc.topics, data: enc.data };
}

/** The real current-V2 target, building real calldata, so this exercises production
 *  encoding rather than a stub that returns a string. */
function realTarget(): LaunchTarget {
  return {
    version: 'v2-current',
    deployment: D,
    factoryAddress: D.factory,
    supportsPairing: true,
    build: async (req: any) =>
      buildCurrentV2LaunchCalldata(
        {
          tokenName: req.tokenName,
          tokenSymbol: req.tokenSymbol,
          logo: '',
          description: '',
          socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
          feeWallet: req.splitterAddress,
          launchConfigId: 0n,
          pairToken: req.pairAsset.address,
          creatorTaxBps: 0,
          buybackEnabled: false,
          expectedEconomics: '0x' + 'cd'.repeat(32),
          salt: launchSalt(D, req.tweetId),
        },
        LIVE_FEE,
        D
      ),
    // The unscoped extractor, exactly as the real CurrentV2Target has it. Its presence
    // is the point: the orchestrator must not use it for current V2.
    extractToken: (logs: readonly ethers.Log[]) => {
      for (const l of logs) {
        try {
          const p = iface.parseLog({ topics: [...l.topics], data: l.data });
          if (p?.name === 'TokenLaunched') return String((p.args as any).token);
        } catch {
          /* not ours */
        }
      }
      return null;
    },
  } as unknown as LaunchTarget;
}

function depsWithLogs(db: Db, logs: unknown[], replies: string[]) {
  return {
    db,
    parser: {
      parse: async () => ({
        isLaunchIntent: true,
        confidence: 'high',
        tokenName: 'Moon Coin',
        tokenSymbol: 'MOON',
        description: null,
        pairWith: null,
      }),
    },
    walletResolver: { resolve: async () => ({ xUserId: 'u1', walletAddress: '0x' + '11'.repeat(20) }) },
    xClient: {
      postReply: async (_id: string, text: string) => {
        replies.push(text);
        return { tweetId: 'r1' };
      },
      getAccountSignals: async () => ({
        followersCount: 5000,
        accountCreatedAt: '2019-01-01T00:00:00.000Z',
      }),
    },
    treasurySigner: {
      address: async () => TREASURY,
      sendTransaction: async (tx: { to?: string }) => ({
        hash: '0x' + 'ab'.repeat(32),
        wait: async () =>
          tx.to === ''
            ? { status: 1, logs: [], contractAddress: SPLITTER }
            : { status: 1, logs },
      }),
    },
    provider: {} as never,
    launchTarget: realTarget(),
    verifyIdentity: async () => {},
    // The factory's post-receipt record, agreeing with the selected factory's own event.
    // These tests are about WHICH log names the token; the confirmation gate has its own
    // file. Supplying a matching record says that plainly rather than leaving the real
    // read to fail against a stubbed provider and call every case an incident.
    readLaunchRecord: async (_d: unknown, token: string) => ({
      token,
      curve: REAL_CURVE,
      deployer: TREASURY,
      creatorFeeRecipient: SPLITTER,
      pairToken: '0x' + '00'.repeat(20),
      exists: true,
    }),
    getLiveFeeWei: async () => LIVE_FEE,
    getTreasuryBalanceWei: async () => 50_000_000_000_000_000n,
    getLaunchReadiness: async () => ({ canLaunch: true, launchConfigUsable: true }),
  };
}

function mention(id: string) {
  return {
    tweetId: id,
    authorXUserId: 'u1',
    authorHandle: 'someone',
    text: 'launch Moon Coin MOON',
    createdAt: new Date().toISOString(),
  };
}

function freshDb(name: string): Db {
  const p = path.join(TMP, name + '.sqlite');
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return new Db(p);
}

describe('only the selected factory may name the launched token', () => {
  /**
   * The adversarial ordering: a foreign contract's identically shaped event arrives
   * FIRST in the receipt.
   */
  it('ignores a foreign same-signature log placed before the real one', async () => {
    const db = freshDb('foreign-first');
    const replies: string[] = [];
    try {
      const logs = [
        launchedLog(IMPOSTOR, FOREIGN_TOKEN, REAL_CURVE, '0x' + '00'.repeat(20)),
        launchedLog(D.factory, REAL_TOKEN, REAL_CURVE, '0x' + '00'.repeat(20)),
      ];
      const outcome: any = await handleMention(mention('t-foreign'), depsWithLogs(db, logs, replies) as never);

      expect(outcome.kind).toBe('launched');
      expect(outcome.tokenAddress.toLowerCase()).toBe(REAL_TOKEN.toLowerCase());
      expect(outcome.tokenAddress.toLowerCase()).not.toBe(FOREIGN_TOKEN.toLowerCase());
    } finally {
      db.close();
    }
  });

  it('persists the selected factory’s token, not the foreign one', async () => {
    const db = freshDb('persist');
    const replies: string[] = [];
    try {
      const logs = [
        launchedLog(IMPOSTOR, FOREIGN_TOKEN, REAL_CURVE, '0x' + '00'.repeat(20)),
        launchedLog(D.factory, REAL_TOKEN, REAL_CURVE, '0x' + '00'.repeat(20)),
      ];
      await handleMention(mention('t-persist'), depsWithLogs(db, logs, replies) as never);

      const row: any = (db as any).db
        .prepare('SELECT token_address FROM launches WHERE id = ?')
        .get('launch_t-persist');
      expect(String(row.token_address).toLowerCase()).toBe(REAL_TOKEN.toLowerCase());
    } finally {
      db.close();
    }
  });

  // The reply is the artefact a person keeps. Telling somebody a stranger's contract is
  // their token is worse than telling them nothing.
  it('never replies with the foreign token address', async () => {
    const db = freshDb('reply');
    const replies: string[] = [];
    try {
      const logs = [
        launchedLog(IMPOSTOR, FOREIGN_TOKEN, REAL_CURVE, '0x' + '00'.repeat(20)),
        launchedLog(D.factory, REAL_TOKEN, REAL_CURVE, '0x' + '00'.repeat(20)),
      ];
      await handleMention(mention('t-reply'), depsWithLogs(db, logs, replies) as never);
      expect(replies.join(' ')).not.toContain(FOREIGN_TOKEN);
    } finally {
      db.close();
    }
  });

  /**
   * A receipt with ONLY a foreign log is not a launch anybody can account for. It must
   * not be recorded as confirmed against a token this factory never mentioned.
   */
  it('refuses to confirm when the selected factory raised nothing', async () => {
    const db = freshDb('none');
    const replies: string[] = [];
    try {
      const logs = [launchedLog(IMPOSTOR, FOREIGN_TOKEN, REAL_CURVE, '0x' + '00'.repeat(20))];
      const outcome: any = await handleMention(mention('t-none'), depsWithLogs(db, logs, replies) as never);

      expect(outcome.kind).not.toBe('launched');
      const row: any = (db as any).db
        .prepare('SELECT status, token_address FROM launches WHERE id = ?')
        .get('launch_t-none');
      expect(row.status).not.toBe('confirmed');
      expect(String(row.token_address ?? '').toLowerCase()).not.toBe(FOREIGN_TOKEN.toLowerCase());
    } finally {
      db.close();
    }
  });

  it('records the curve from the selected factory’s own event', async () => {
    const db = freshDb('curve');
    const replies: string[] = [];
    try {
      const logs = [
        launchedLog(IMPOSTOR, FOREIGN_TOKEN, '0x' + '77'.repeat(20), '0x' + '00'.repeat(20)),
        launchedLog(D.factory, REAL_TOKEN, REAL_CURVE, '0x' + '00'.repeat(20)),
      ];
      await handleMention(mention('t-curve'), depsWithLogs(db, logs, replies) as never);
      const p = db.getLaunchProvenance('launch_t-curve');
      expect(String(p?.curve).toLowerCase()).toBe(REAL_CURVE.toLowerCase());
    } finally {
      db.close();
    }
  });

  /**
   * The pair token in the event must match what was actually sent. A factory event
   * naming a different pairing means the launch trades against something nobody asked
   * for -- permanently.
   */
  it('flags a pair token that disagrees with the calldata', async () => {
    const db = freshDb('pair');
    const replies: string[] = [];
    const errors: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...a) => {
      errors.push(a.join(' '));
    });
    try {
      const logs = [
        launchedLog(D.factory, REAL_TOKEN, REAL_CURVE, '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9'),
      ];
      await handleMention(mention('t-pair'), depsWithLogs(db, logs, replies) as never);
      expect(errors.join(' ')).toMatch(/pair token/i);
    } finally {
      spy.mockRestore();
      db.close();
    }
  });
});

/**
 * A cached approval is a statement about the past.
 *
 * `PairAssetRegistry` caches the approved set for an hour, which is right: the scan is
 * a log sweep and pons rarely changes the list. But the launch path resolved the pair
 * from that cache and then deployed a splitter -- gas spent, a contract that exists
 * forever -- before ever asking the factory whether the asset is still approved.
 *
 * pons can revoke an asset at any moment, and has: RIVN was approved and then revoked.
 * A revocation inside the cache window therefore bought a splitter and then reverted the
 * launch, leaving a paid-for contract bound to a launch that never happened.
 *
 * The check costs one `eth_call` and happens before the first durable side effect.
 */
describe('the pair is re-checked live before anything durable', () => {
  const { assertPairStillApproved } = require('../src/launchAssertions');
  const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
  const NATIVE = '0x0000000000000000000000000000000000000000';

  function factoryWhere(approved: boolean) {
    return {
      approvedPairTokens: async () => approved,
    } as never;
  }

  it('passes when the factory still approves the asset', async () => {
    await expect(assertPairStillApproved(factoryWhere(true), AAPL, D)).resolves.toBeUndefined();
  });

  /** The revocation case, which is the reason this exists. */
  it('refuses when the asset was revoked since the cache was filled', async () => {
    await expect(assertPairStillApproved(factoryWhere(false), AAPL, D)).rejects.toThrow(
      /no longer approved|revoked|approval/i
    );
  });

  it('names the asset and the deployment in the refusal', async () => {
    try {
      await assertPairStillApproved(factoryWhere(false), AAPL, D);
      throw new Error('should have refused');
    } catch (e: any) {
      expect(e.message).toContain(AAPL);
      expect(e.message).toContain(D.id);
    }
  });

  /**
   * Native ETH is exempt by the factory's own semantics: the gate short-circuits on the
   * zero address, and `approvedPairTokens(0x0)` returns false. Asking would refuse the
   * one pairing that always works.
   */
  it('does not ask about native ETH, which is always valid', async () => {
    let asked = false;
    const factory = {
      approvedPairTokens: async () => {
        asked = true;
        return false;
      },
    } as never;
    await expect(assertPairStillApproved(factory, NATIVE, D)).resolves.toBeUndefined();
    expect(asked).toBe(false);
  });

  // A read that fails is not an approval. The whole point is to be sure.
  it('refuses when the approval cannot be read at all', async () => {
    const factory = {
      approvedPairTokens: async () => {
        throw new Error('RPC unavailable');
      },
    } as never;
    await expect(assertPairStillApproved(factory, AAPL, D)).rejects.toThrow(/could not|unavailable|approval/i);
  });
});

describe('a revoked pair stops the launch before the splitter is deployed', () => {
  it('deploys nothing and spends nothing', async () => {
    const db = freshDb('revoked');
    const replies: string[] = [];
    const sent: unknown[] = [];
    try {
      const deps: any = depsWithLogs(db, [], replies);
      // The registry still believes it is approved -- that is the cached state.
      deps.pairAssets = {
        resolve: async () => ({
          ok: true,
          asset: {
            address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
            symbol: 'AAPL',
            name: 'Apple',
            decimals: 18,
            graduationThreshold: null,
          },
        }),
      };
      // The chain says otherwise.
      deps.assertPairApproved = async () => {
        throw new Error(
          'AAPL (0xaF3D…) is no longer approved on pons-v2-current-7ed. Refusing before anything is deployed.'
        );
      };
      deps.treasurySigner = {
        address: async () => TREASURY,
        sendTransaction: async (tx: unknown) => {
          sent.push(tx);
          return { hash: '0x' + 'ab'.repeat(32), wait: async () => ({ status: 1, logs: [], contractAddress: SPLITTER }) };
        },
      };

      const outcome: any = await handleMention(
        { ...mention('t-revoked'), text: 'launch Moon Coin MOON paired with AAPL' },
        deps
      );

      expect(outcome.kind).not.toBe('launched');
      // Nothing signed at all: not the splitter, not the launch.
      expect(sent).toHaveLength(0);
      expect(db.totalSpendLast24h()).toBe(0n);
    } finally {
      db.close();
    }
  });
});
