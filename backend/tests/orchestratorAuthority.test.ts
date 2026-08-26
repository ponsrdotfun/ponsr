import * as fs from 'fs';
import { ethers } from 'ethers';
import { Db } from '../src/db';
import { MockParser } from '../src/parser';
import { MockWalletResolver } from '../src/walletResolver';
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
 * THE INJECTION SEAM, WHICH MY OWN REPORT OVERSTATED.
 *
 * `createLaunchTarget` resolves from the registry and cannot produce a superseded target.
 * I wrote that as "no financial path can construct a v1 or v2-legacy `to`". That was too
 * broad: `OrchestratorDeps.launchTarget` is EXPORTED, and the orchestrator checked only
 * that the injected target NAMED a deployment -- not that it named the executable one.
 *
 * A target naming `pons-v1` passed. Every guard downstream then verified the identity of
 * the deployment it named, which is a guard aimed exactly where the caller pointed it.
 *
 * These tests drive the real `handleMention` and assert on EFFECTS, not on messages: no
 * signer request, no wallet, no parse, no database row, no spend, no reply. The first
 * durable or paid boundary must not be crossed.
 */

const TEST_DB_PATH = './data/test-orchestrator-authority.sqlite';
const LIVE_FEE = 500_000_000_000_000n;
const FUNDED_TREASURY = 50_000_000_000_000_000n;

function fakeAddress(seed: string): string {
  return ethers.getAddress('0x' + ethers.id(seed).slice(2, 42));
}

function freshDb(): Db {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  return new Db(TEST_DB_PATH);
}

function makeMention(over: Partial<InboundMention> = {}): InboundMention {
  return {
    tweetId: 'tweet_authority_1',
    text: '@ponsrdotfun launch Moon Coin MOON',
    authorXUserId: 'user_1',
    authorHandle: 'someone',
    createdAt: new Date().toISOString(),
    ...over,
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

/** Counts every effect that costs money, creates state, or reaches a third party. */
class CountingSigner implements TreasurySigner {
  public sent: { to: string; data: string; value: bigint }[] = [];
  async address(): Promise<string> {
    return fakeAddress('treasury');
  }
  async sendTransaction(tx: { to: string; data: string; value: bigint }): Promise<never> {
    this.sent.push(tx);
    throw new Error('a signer request must never happen in these tests');
  }
}

class CountingParser {
  public calls = 0;
  async parse(): Promise<ParsedIntent> {
    this.calls += 1;
    return INTENT;
  }
}

class CountingWalletResolver {
  public calls = 0;
  async resolve(): Promise<{ walletAddress: string }> {
    this.calls += 1;
    return { walletAddress: fakeAddress('wallet') };
  }
}

/** A target that is whatever the test says it is. That is the point. */
function targetFor(over: Record<string, unknown> = {}): any {
  const d = executableDeployment();
  const deployment = (over.deployment as any) ?? d;
  return {
    version: 'v2-current',
    deployment,
    factoryAddress: deployment.factory,
    supportsPairing: true,
    build: async (req: any, fee: bigint) =>
      buildCurrentV2LaunchCalldata(
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
          expectedEconomics: '0x' + 'ab'.repeat(32),
          salt: launchSalt(d, req.tweetId),
        },
        fee,
        d
      ),
    extractToken: (logs: readonly any[]) => extractCurrentV2LaunchDetails(logs)?.token ?? null,
    ...over,
  };
}

describe('an injected launch target cannot aim the treasury at a superseded factory', () => {
  let db: Db;
  let signer: CountingSigner;
  let parser: CountingParser;
  let wallets: CountingWalletResolver;
  let xClient: MockXClient;

  beforeEach(() => {
    db = freshDb();
    signer = new CountingSigner();
    parser = new CountingParser();
    wallets = new CountingWalletResolver();
    xClient = new MockXClient();
  });
  afterEach(() => db.close());

  function deps(target: any): OrchestratorDeps {
    return {
      db,
      publicLaunchEnabled: true,
      parser: parser as never,
      walletResolver: wallets as never,
      xClient,
      treasurySigner: signer,
      provider: {} as never,
      launchTarget: target,
      verifyIdentity: async () => {},
      assertPairApproved: async () => {},
      getLiveFeeWei: async () => LIVE_FEE,
      getTreasuryBalanceWei: async () => FUNDED_TREASURY,
      getLaunchReadiness: async () => ({ canLaunch: true, launchConfigUsable: true }),
    } as never;
  }

  /** Nothing was spent, created, recorded or said. */
  function expectNothingHappened(tweetId: string) {
    expect(signer.sent).toHaveLength(0);
    expect(wallets.calls).toBe(0);
    // The parser is BILLED. The target is resolvable without it, so refusal precedes it.
    expect(parser.calls).toBe(0);
    expect(xClient.sentReplies).toHaveLength(0);
    expect(db.totalSpendLast24h()).toBe(0n);
    expect(db.getLaunchProvenance(`launch_${tweetId}`)).toBeNull();
    // The claim is released, so a correct target can handle the same mention later.
    expect(db.isTweetProcessed(tweetId)).toBe(false);
  }

  const HOSTILE: Array<[string, Record<string, unknown>]> = [
    ['names pons-v1', { deployment: deploymentById('pons-v1') }],
    ['names the superseded v2', { deployment: deploymentById('pons-v2-legacy-7e1') }],
    ['names no deployment at all', { deployment: undefined }],
    [
      'claims the current deployment but addresses the v1 factory',
      { factoryAddress: deploymentById('pons-v1').factory },
    ],
    [
      'claims the current deployment but addresses an arbitrary contract',
      { factoryAddress: '0x000000000000000000000000000000000000dEaD' },
    ],
    [
      'claims the current id while carrying a different escrow',
      { deployment: { ...executableDeployment(), feeEscrow: '0x000000000000000000000000000000000000dEaD' } },
    ],
    [
      'claims the current id while carrying a different selector',
      { deployment: { ...executableDeployment(), launchSelector: '0xdeadbeef' } },
    ],
    [
      'claims the current id while carrying a different runtime hash',
      { deployment: { ...executableDeployment(), runtimeBytecodeSha256: 'f'.repeat(64) } },
    ],
    [
      'is the current deployment with executable flipped off',
      { deployment: { ...executableDeployment(), executable: false } },
    ],
  ];

  it.each(HOSTILE)('a target that %s is refused before anything is spent', async (_label, over) => {
    const mention = makeMention();
    await expect(handleMention(mention, deps(targetFor(over)))).rejects.toThrow();
    expectNothingHappened(mention.tweetId);
  });

  it('a target whose build() addresses somewhere else is refused before the signer', async () => {
    // It declares the right factory, so the pre-spend check passes -- and then builds a
    // transaction to somewhere else. Only the bytes can reveal that, so the bytes are
    // checked too, immediately before the signer is asked.
    const target = targetFor({
      build: async () => ({
        to: deploymentById('pons-v1').factory,
        data: executableDeployment().launchSelector + '00'.repeat(32),
        value: LIVE_FEE,
      }),
    });
    const mention = makeMention();
    const outcome: any = await handleMention(mention, deps(target));
    expect(outcome.detail).toMatch(/addressed to a contract that is not/i);
    // THE DECISIVE ASSERTION. The splitter deploy is itself a signer request, so a target
    // caught only after it would have been caught after money moved.
    expect(signer.sent).toHaveLength(0);
    expect(db.totalSpendLast24h()).toBe(0n);
  });

  it('a target whose build() calls a different selector is refused before the signer', async () => {
    const target = targetFor({
      build: async () => ({
        to: executableDeployment().factory,
        data: '0xdeadbeef' + '00'.repeat(32),
        value: LIVE_FEE,
      }),
    });
    const mention = makeMention();
    const outcome: any = await handleMention(mention, deps(target));
    expect(outcome.detail).toMatch(/selector/i);
    expect(signer.sent).toHaveLength(0);
    expect(db.totalSpendLast24h()).toBe(0n);
  });

  it('the exact current target is NOT refused by the authority check', async () => {
    // It passes every authority gate and only then fails for an unrelated reason -- the
    // signer in this suite refuses everything by design. What matters is that it reached
    // the signer at all, which is the proof the gate is a gate and not a wall.
    const mention = makeMention();
    const outcome = await handleMention(mention, deps(targetFor()));
    expect(outcome.kind).toBe('onchain_failure');
    expect(parser.calls).toBe(1);
    expect(wallets.calls).toBe(1);
    expect(signer.sent.length).toBeGreaterThan(0);
  });
});
