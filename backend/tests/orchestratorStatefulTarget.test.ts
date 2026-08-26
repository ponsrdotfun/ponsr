import * as fs from 'fs';
import { ethers } from 'ethers';
import { Db } from '../src/db';
import { MockXClient } from '../src/xClient';
import { TreasurySigner } from '../src/treasurySigner';
import { handleMention, OrchestratorDeps } from '../src/orchestrator';
import { InboundMention, ParsedIntent } from '../src/types';
import { deploymentById, executableDeployment } from '../src/deployments';
import { EMPTY_SOCIALS } from '../src/ponsEncoder';
import {
  buildCurrentV2LaunchCalldata,
  extractCurrentV2LaunchDetails,
  launchSalt,
} from '../src/ponsV2CurrentEncoder';

/**
 * A TARGET THAT LIES ONLY ON THE SECOND CALL.
 *
 * The previous design built twice: once dry, inspected before the splitter deploy, and
 * once for real, inspected after it. `build()` belongs to an injected object and nothing
 * requires it to be pure or stable. So a STATEFUL target could answer honestly the first
 * time and name v1 the second -- and the splitter deploy, a signer request costing real
 * gas, sat between the two inspections. The launch was refused correctly, AFTER money had
 * already moved.
 *
 * My own report called that "caught before the splitter". True only for a target that
 * lies consistently. Two inspections of two different byte strings is a race, not a check.
 *
 * There is ONE build now, before the first signature, and those exact bytes are what get
 * sent. These tests assert the CALL COUNT, so "a second call cannot happen" is measured
 * rather than described.
 */

const TEST_DB_PATH = './data/test-orchestrator-stateful.sqlite';
const LIVE_FEE = 500_000_000_000_000n;
const FUNDED_TREASURY = 50_000_000_000_000_000n;
const D = executableDeployment();
const ECON = '0x' + 'ab'.repeat(32);
const NONCE = 7;

function fakeAddress(seed: string): string {
  return ethers.getAddress('0x' + ethers.id(seed).slice(2, 42));
}

const TREASURY = fakeAddress('treasury');
const predicted = (): string => ethers.getCreateAddress({ from: TREASURY, nonce: NONCE });

function freshDb(): Db {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  return new Db(TEST_DB_PATH);
}

const TWEET = 'tweet_stateful_1';

function makeMention(): InboundMention {
  return {
    tweetId: TWEET,
    text: '@ponsrdotfun launch Moon Coin MOON',
    authorXUserId: 'user_1',
    authorHandle: 'someone',
    createdAt: new Date().toISOString(),
  } as InboundMention;
}

const INTENT: ParsedIntent = {
  isLaunchIntent: true,
  confidence: 'high',
  tokenName: 'Moon Coin',
  tokenSymbol: 'MOON',
  description: null,
  pairWith: null,
};

/** Refuses every signature, and records that it was asked. */
class CountingSigner implements TreasurySigner {
  public sent: { to: string; data: string; value: bigint }[] = [];
  async address(): Promise<string> {
    return TREASURY;
  }
  async sendTransaction(tx: { to: string; data: string; value: bigint }): Promise<never> {
    this.sent.push(tx);
    throw new Error('a signer request must never happen in these tests');
  }
}

/** Honest calldata for whatever recipient it is handed. */
function honest(req: any, fee: bigint, over: Record<string, unknown> = {}) {
  return buildCurrentV2LaunchCalldata(
    {
      tokenName: req.tokenName,
      tokenSymbol: req.tokenSymbol,
      logo: '',
      description: '',
      socials: EMPTY_SOCIALS,
      feeWallet: req.splitterAddress,
      launchConfigId: 0n,
      pairToken: req.pairAsset.address,
      creatorTaxBps: 0,
      buybackEnabled: false,
      expectedEconomics: ECON,
      salt: launchSalt(D, req.tweetId),
      ...over,
    } as never,
    fee,
    D
  );
}

describe('a stateful target cannot change its mind after the splitter is paid for', () => {
  let db: Db;
  let signer: CountingSigner;
  let xClient: MockXClient;

  beforeEach(() => {
    db = freshDb();
    signer = new CountingSigner();
    xClient = new MockXClient();
  });
  afterEach(() => db.close());

  /** Counts calls, so "there was only ever one build" is asserted, not assumed. */
  function statefulTarget(secondCall: (good: any, req: any) => any) {
    const state = { calls: 0, recipients: [] as string[], fees: [] as bigint[] };
    return {
      state,
      target: {
        version: 'v2-current',
        deployment: D,
        factoryAddress: D.factory,
        supportsPairing: true,
        build: async (req: any, fee: bigint) => {
          state.calls += 1;
          // Recorded so "the single build was the REAL one" can be asserted. Under the old
          // two-build design the first call received a placeholder recipient, so a test
          // that only counted calls would pass for the wrong reason whenever the second
          // build was never reached.
          state.recipients.push(String(req.splitterAddress));
          state.fees.push(fee);
          const good = honest(req, fee);
          return state.calls === 1 ? good : secondCall(good, req);
        },
        extractToken: (logs: readonly any[]) => extractCurrentV2LaunchDetails(logs)?.token ?? null,
      },
    };
  }

  function deps(target: any): OrchestratorDeps {
    return {
      db,
      publicLaunchEnabled: true,
      parser: { parse: async () => INTENT },
      walletResolver: { resolve: async () => ({ xUserId: 'user_1', walletAddress: fakeAddress('wallet') }) },
      xClient,
      treasurySigner: signer,
      provider: {} as never,
      launchTarget: target,
      // Read-only seams. Nothing here needs a chain, and nothing reserves a nonce.
      getTreasuryNonce: async () => NONCE,
      readLaunchEconomics: async () => ECON,
      verifyIdentity: async () => {},
      assertPairApproved: async () => {},
      getLiveFeeWei: async () => LIVE_FEE,
      getTreasuryBalanceWei: async () => FUNDED_TREASURY,
      getLaunchReadiness: async () => ({ canLaunch: true, launchConfigUsable: true }),
    } as never;
  }

  /** Rebuilds the calldata with one field poisoned, keeping everything else honest. */
  function poisoned(over: Record<string, unknown>): string {
    return buildCurrentV2LaunchCalldata(
      {
        tokenName: 'Moon Coin',
        tokenSymbol: 'MOON',
        logo: '',
        description: '',
        socials: EMPTY_SOCIALS,
        feeWallet: predicted(),
        launchConfigId: 0n,
        pairToken: '0x0000000000000000000000000000000000000000',
        creatorTaxBps: 0,
        buybackEnabled: false,
        expectedEconomics: ECON,
        salt: launchSalt(D, TWEET),
        ...over,
      } as never,
      LIVE_FEE,
      D
    ).data;
  }

  const SECOND_CALL_LIES: Array<[string, (good: any) => any]> = [
    ['names the v1 factory', (g) => ({ ...g, to: deploymentById('pons-v1').factory })],
    ['names the superseded v2 factory', (g) => ({ ...g, to: deploymentById('pons-v2-legacy-7e1').factory })],
    ['names an arbitrary address', (g) => ({ ...g, to: '0x000000000000000000000000000000000000dEaD' })],
    ['keeps the factory but changes the selector', (g) => ({ ...g, data: '0xdeadbeef' + g.data.slice(10) })],
    [
      'redirects the creator fee somewhere else',
      (g) => ({ ...g, data: poisoned({ feeWallet: '0x000000000000000000000000000000000000dEaD' }) }),
    ],
    ['changes the salt', (g) => ({ ...g, data: poisoned({ salt: launchSalt(D, 'another-request') }) })],
    ['changes the launch config', (g) => ({ ...g, data: poisoned({ launchConfigId: 9n }) })],
    [
      'changes the economics digest',
      (g) => ({ ...g, data: poisoned({ expectedEconomics: '0x' + 'cd'.repeat(32) }) }),
    ],
    ['overpays, which the factory reads as an initial buy', (g) => ({ ...g, value: LIVE_FEE * 2n })],
  ];

  it.each(SECOND_CALL_LIES)(
    'a target whose SECOND build %s never gets a second build',
    async (_label, lie) => {
      const { state, target } = statefulTarget(lie);
      const outcome: any = await handleMention(makeMention(), deps(target));

      /*
       * THE DECISIVE ASSERTION, and it is the call count.
       *
       * With one build the second answer is never asked for, so the lie cannot occur at
       * all -- which is stronger than detecting it. Asserting "zero signer requests" here
       * would be asserting the wrong thing: the single build is HONEST, so the flow
       * proceeds legitimately and the splitter deploy is correct behaviour. What must
       * never appear is a transaction carrying the lie.
       */
      expect(state.calls).toBe(1);
      expect(state.recipients).toEqual([predicted()]);

      // Nothing the second call would have produced ever reached the signer: no launch
      // transaction at all, and certainly none to a superseded or arbitrary destination.
      const launches = signer.sent.filter((t) => t.to !== '');
      expect(launches).toHaveLength(0);
      for (const t of signer.sent) {
        expect(t.to).not.toBe(deploymentById('pons-v1').factory);
        expect(t.to).not.toBe(deploymentById('pons-v2-legacy-7e1').factory);
      }
      expect(outcome.kind).not.toBe('launched');
      expect(db.totalSpendLast24h()).toBe(0n);
      expect(db.getLaunchProvenance(`launch_${TWEET}`)).toBeNull();
    }
  );

  it('an honest target is built exactly once, for the real recipient, before any signature', async () => {
    const { state, target } = statefulTarget((g) => g);
    await handleMention(makeMention(), deps(target));

    expect(state.calls).toBe(1);
    // THE ONE BUILD IS THE REAL ONE. Under the two-build design the first call received a
    // placeholder recipient and the second received the deployed splitter; counting calls
    // alone would pass whenever the second was never reached.
    expect(state.recipients).toEqual([predicted()]);
    expect(state.fees).toEqual([LIVE_FEE]);
    // The signer refuses everything here, so the splitter attempt is where it stops --
    // which is the proof the build had already happened.
    expect(signer.sent.length).toBeGreaterThan(0);
    expect(signer.sent[0].to).toBe('');
  });

  it('the exact bytes that were inspected are the exact bytes that are sent', async () => {
    // The other half of "build once": not merely that a second build cannot happen, but
    // that what went out is what was checked. Anything else would leave room for the
    // bytes to be rewritten between inspection and signature.
    const { state, target } = statefulTarget((g) => g);
    let builtBytes: { to: string; data: string; value: bigint } | null = null;
    const wrapped = {
      ...target,
      build: async (req: any, fee: bigint) => {
        const out = await target.build(req, fee);
        builtBytes = { to: out.to, data: out.data, value: out.value };
        return out;
      },
    };

    const sent: any[] = [];
    const d: any = deps(wrapped);
    d.treasurySigner = {
      async address() {
        return TREASURY;
      },
      async sendTransaction(tx: any) {
        sent.push(tx);
        if (tx.to === '') {
          return {
            hash: '0x' + '11'.repeat(32),
            wait: async () => ({ status: 1, contractAddress: predicted(), logs: [] }),
          };
        }
        // The launch. Stop here: what matters is the bytes, not the receipt.
        return { hash: '0x' + '22'.repeat(32), wait: async () => ({ status: 0, logs: [] }) };
      },
    };

    await handleMention(makeMention(), d);

    expect(state.calls).toBe(1);
    const launch = sent.find((t) => t.to !== '');
    expect(launch).toBeDefined();
    expect(builtBytes).not.toBeNull();
    expect(launch.to).toBe(builtBytes!.to);
    expect(launch.data).toBe(builtBytes!.data);
    expect(launch.value).toBe(builtBytes!.value);
  });

  it('a splitter deployed at an address the calldata does not name stops the launch', async () => {
    // The prediction is ASSERTED, never trusted. A nonce consumed elsewhere between the
    // read and the deploy gives a real splitter at an address the launch does not name,
    // and the creator's fees would be pushed to a contract nobody controls.
    const { target } = statefulTarget((g) => g);
    const d: any = deps(target);
    d.getTreasuryNonce = async () => NONCE + 1;
    const sent: any[] = [];
    d.treasurySigner = {
      sent,
      async address() {
        return TREASURY;
      },
      async sendTransaction(tx: any) {
        sent.push(tx);
        if (tx.to === '') {
          return {
            hash: '0x' + '11'.repeat(32),
            wait: async () => ({
              status: 1,
              // The address the flow did NOT predict.
              contractAddress: ethers.getCreateAddress({ from: TREASURY, nonce: NONCE }),
              logs: [],
            }),
          };
        }
        throw new Error('the launch must never be sent in this test');
      },
    };

    const outcome: any = await handleMention(makeMention(), d);
    expect(outcome.kind).not.toBe('launched');
    // The splitter went out -- it had to, for the mismatch to exist at all -- and the
    // launch did not follow it.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('');
    expect(db.totalSpendLast24h()).toBe(0n);
  });
});
