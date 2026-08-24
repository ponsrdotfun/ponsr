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
 * What has to be true before a launch is called confirmed.
 *
 * The row was marked `confirmed` the moment a `TokenLaunched` from the selected factory
 * decoded. Reconciliation ran afterwards and, on disagreement, logged and notified --
 * then the success reply went out regardless.
 *
 * So "confirmed" meant "an event of the right shape came from the right address". It did
 * not mean the token matched the calldata, that the factory agreed who the creator fee
 * recipient is, or that the record and the receipt described the same launch. A person
 * reading the database could not tell a clean launch from one nobody had reconciled.
 *
 * The distinction that matters throughout: a mismatch does NOT mean the token is
 * imaginary. The transaction confirmed and the fee is spent. It means nobody can yet say
 * what was launched -- which is an incident with evidence to preserve, not a failure to
 * report and not a success to celebrate.
 */

const D = executableDeployment();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ponsr-confirm-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const SPLITTER = '0x9999999999999999999999999999999999999999';
const TOKEN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const OTHER = '0x7777777777777777777777777777777777777777';
const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
const NATIVE = '0x0000000000000000000000000000000000000000';
const LIVE_FEE = 500_000_000_000_000n;

const iface = new ethers.Interface(PONS_V2_CURRENT_ABI);

function launchedLog(token: string, curve: string, deployer: string, pair: string) {
  const enc = iface.encodeEventLog('TokenLaunched', [token, curve, deployer, pair, 0n, 0n]);
  return { address: D.factory, topics: enc.topics, data: enc.data };
}

/** The factory's own record, as `getLaunchedToken` returns it. */
function factoryRecord(over: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    curve: CURVE,
    deployer: TREASURY,
    creatorFeeRecipient: SPLITTER,
    pairToken: NATIVE,
    exists: true,
    ...over,
  };
}

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
    extractToken: () => TOKEN,
  } as unknown as LaunchTarget;
}

interface Scenario {
  logs: unknown[];
  record?: Record<string, unknown> | null;
  recordThrows?: boolean;
}

function deps(db: Db, sc: Scenario, replies: string[]) {
  return {
    db,
    publicLaunchEnabled: true,
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
            : { status: 1, logs: sc.logs },
      }),
    },
    provider: {} as never,
    launchTarget: realTarget(),
    verifyIdentity: async () => {},
    assertPairApproved: async () => {},
    /** The factory's post-receipt record, injected like every other chain read here. */
    readLaunchRecord: async () => {
      if (sc.recordThrows) throw new Error('RPC unavailable');
      return sc.record ?? null;
    },
    getLiveFeeWei: async () => LIVE_FEE,
    getTreasuryBalanceWei: async () => 50_000_000_000_000_000n,
    getLaunchReadiness: async () => ({ canLaunch: true, launchConfigUsable: true }),
  };
}

const mention = (id: string) => ({
  tweetId: id,
  authorXUserId: 'u1',
  authorHandle: 'someone',
  text: 'launch Moon Coin MOON',
  createdAt: new Date().toISOString(),
});

function freshDb(name: string): Db {
  const p = path.join(TMP, name + '.sqlite');
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return new Db(p);
}

function row(db: Db, id: string): { status: string; token_address: string | null; tx_hash: string | null } {
  return (db as never as { db: { prepare(q: string): { get(x: string): never } } }).db
    .prepare('SELECT status, token_address, tx_hash FROM launches WHERE id = ?')
    .get('launch_' + id) as never;
}

async function run(name: string, sc: Scenario) {
  const db = freshDb(name);
  const replies: string[] = [];
  try {
    const outcome = await handleMention(mention(name), deps(db, sc, replies) as never);
    return { outcome, replies, row: row(db, name), db };
  } finally {
    db.close();
  }
}

describe('a launch is confirmed only after everything reconciles', () => {
  /** The clean case, so the failures below mean something. */
  it('confirms and replies normally when receipt and record agree', async () => {
    const r = await run('clean', {
      logs: [launchedLog(TOKEN, CURVE, TREASURY, NATIVE)],
      record: factoryRecord(),
    });
    expect(r.outcome.kind).toBe('launched');
    expect(r.row.status).toBe('confirmed');
    expect(r.row.token_address?.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(r.replies.join(' ')).toContain('MOON');
  });

  /**
   * The pairing decides what every buyer spends and what the creator is paid in, and it
   * is fixed forever at launch. A receipt naming a different one than the calldata means
   * nobody yet knows which is true.
   */
  it('does not confirm when the receipt pair differs from the calldata', async () => {
    const r = await run('pair', {
      logs: [launchedLog(TOKEN, CURVE, TREASURY, AAPL)],
      record: factoryRecord({ pairToken: AAPL }),
    });
    expect(r.row.status).not.toBe('confirmed');
    expect(r.outcome.kind).not.toBe('launched');
  });

  it('sends no normal success reply on a pair mismatch', async () => {
    const r = await run('pair-reply', {
      logs: [launchedLog(TOKEN, CURVE, TREASURY, AAPL)],
      record: factoryRecord({ pairToken: AAPL }),
    });
    // A success reply here would tell somebody their token is fine while nobody can say
    // what it trades against.
    expect(r.replies.join(' ')).not.toMatch(/is live/i);
  });

  /** Where the creator's fees go, for the life of the token. */
  it('does not confirm when the factory names a different fee recipient', async () => {
    const r = await run('recipient', {
      logs: [launchedLog(TOKEN, CURVE, TREASURY, NATIVE)],
      record: factoryRecord({ creatorFeeRecipient: OTHER }),
    });
    expect(r.row.status).not.toBe('confirmed');
    expect(r.outcome.kind).not.toBe('launched');
  });

  it('does not confirm when the factory record cannot be read', async () => {
    // Unknown is not the same as fine. The transaction landed; what it did is unproven.
    const r = await run('rpc', {
      logs: [launchedLog(TOKEN, CURVE, TREASURY, NATIVE)],
      recordThrows: true,
    });
    expect(r.row.status).not.toBe('confirmed');
  });

  it('does not confirm when the factory has no record of the token', async () => {
    const r = await run('missing', {
      logs: [launchedLog(TOKEN, CURVE, TREASURY, NATIVE)],
      record: factoryRecord({ exists: false }),
    });
    expect(r.row.status).not.toBe('confirmed');
  });

  it('does not confirm when the record token disagrees with the receipt', async () => {
    const r = await run('token', {
      logs: [launchedLog(TOKEN, CURVE, TREASURY, NATIVE)],
      record: factoryRecord({ token: OTHER }),
    });
    expect(r.row.status).not.toBe('confirmed');
  });

  it('does not confirm when the record curve disagrees with the receipt', async () => {
    const r = await run('curve', {
      logs: [launchedLog(TOKEN, CURVE, TREASURY, NATIVE)],
      record: factoryRecord({ curve: OTHER }),
    });
    expect(r.row.status).not.toBe('confirmed');
  });

  it('refuses a zero curve even when everything else lines up', async () => {
    const r = await run('zerocurve', {
      logs: [launchedLog(TOKEN, NATIVE, TREASURY, NATIVE)],
      record: factoryRecord({ curve: NATIVE }),
    });
    expect(r.row.status).not.toBe('confirmed');
  });

  /**
   * The token exists on chain and the fee is spent. Pretending otherwise would be a
   * second, larger error -- so the transaction hash must survive for recovery.
   */
  it('keeps the transaction hash so an incident can be investigated', async () => {
    const r = await run('evidence', {
      logs: [launchedLog(TOKEN, CURVE, TREASURY, AAPL)],
      record: factoryRecord({ pairToken: AAPL }),
    });
    expect(r.row.tx_hash).toBeTruthy();
  });

  it('records the token it saw, so recovery has somewhere to start', async () => {
    const r = await run('evidence-token', {
      logs: [launchedLog(TOKEN, CURVE, TREASURY, AAPL)],
      record: factoryRecord({ pairToken: AAPL }),
    });
    expect(r.row.token_address?.toLowerCase()).toBe(TOKEN.toLowerCase());
  });

  it('tells the person something happened rather than staying silent', async () => {
    const r = await run('speak', {
      logs: [launchedLog(TOKEN, CURVE, TREASURY, AAPL)],
      record: factoryRecord({ pairToken: AAPL }),
    });
    expect(r.replies.length).toBeGreaterThan(0);
  });

  it('reports an outcome the caller can distinguish from a plain failure', async () => {
    const r = await run('outcome', {
      logs: [launchedLog(TOKEN, CURVE, TREASURY, AAPL)],
      record: factoryRecord({ pairToken: AAPL }),
    });
    expect(r.outcome.kind).toBe('incident');
  });

  it('persists an explicit incident status instead of lying that the landed launch failed', async () => {
    const r = await run('incident-status', {
      logs: [launchedLog(TOKEN, CURVE, TREASURY, AAPL)],
      record: factoryRecord({ pairToken: AAPL }),
    });
    expect(r.row.status).toBe('incident');
  });

  it('accounts the paid fee exactly once when confirmation becomes an incident', async () => {
    const db = freshDb('incident-spend');
    const replies: string[] = [];
    try {
      const sc = {
        logs: [launchedLog(TOKEN, CURVE, TREASURY, AAPL)],
        record: factoryRecord({ pairToken: AAPL }),
      };
      const outcome = await handleMention(mention('incident-spend'), deps(db, sc, replies) as never);
      expect(outcome.kind).toBe('incident');
      expect(db.totalSpendLast24h()).toBe(LIVE_FEE);
    } finally {
      db.close();
    }
  });

  it('counts a landed incident against the user launch cap', async () => {
    const db = freshDb('incident-count');
    const replies: string[] = [];
    try {
      const sc = {
        logs: [launchedLog(TOKEN, CURVE, TREASURY, AAPL)],
        record: factoryRecord({ pairToken: AAPL }),
      };
      await handleMention(mention('incident-count'), deps(db, sc, replies) as never);
      expect(db.countLaunchesLast24h('u1')).toBe(1);
    } finally {
      db.close();
    }
  });
});
