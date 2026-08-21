import { ethers } from 'ethers';
import { config } from '../src/config';
import { createLaunchTarget, LaunchTarget } from '../src/launchTarget';
import { deploymentById, executableDeployment } from '../src/deployments';
import { splitterEscrowFor } from '../src/splitterDeployer';

/**
 * One selected deployment, threaded through everything that acts on it.
 *
 * The launch path had two independent notions of "which deployment":
 *
 *   - `createLaunchTarget()` picked the target, and it can return V1 (rollback) or be
 *     replaced entirely by an injected `deps.launchTarget`;
 *   - the identity check and the splitter deployer both called `executableDeployment()`,
 *     a global, and verified THAT.
 *
 * So the guard could verify the current V2 factory -- hashes, escrow, chain, all green --
 * while the transaction that followed was built for something else. A check for one
 * deployment authorising a transaction to another is not a weaker guard, it is a guard
 * pointed at the wrong thing, which is the exact failure this whole migration exists to
 * fix, one level up.
 *
 * The fix is that every target carries its own deployment and everything downstream
 * reads it from the target rather than from module state.
 */
describe('every launch target names its own deployment', () => {
  const realVersion = config.PONS_FACTORY_VERSION;
  afterEach(() => {
    (config as any).PONS_FACTORY_VERSION = realVersion;
  });

  it('the current V2 target carries the executable deployment', () => {
    (config as any).PONS_FACTORY_VERSION = 'v2';
    const t = createLaunchTarget({} as ethers.Provider);
    expect(t.deployment.id).toBe(executableDeployment().id);
  });

  /**
   * V1 rollback, represented rather than smuggled.
   *
   * `pons-v1` is `executable: false` -- correctly, since it is not the launch target --
   * and V1Target used to carry no deployment at all. That left rollback as a path with
   * no identity to verify, so the guard silently fell back to the global one and checked
   * the V2 factory before sending a V1 transaction.
   */
  it('the v1 target carries the v1 deployment, not the executable one', () => {
    (config as any).PONS_FACTORY_VERSION = 'v1';
    const t = createLaunchTarget({} as ethers.Provider);
    expect(t.deployment.id).toBe('pons-v1');
    expect(t.deployment.id).not.toBe(executableDeployment().id);
  });

  it('the v1 target addresses the v1 factory', () => {
    (config as any).PONS_FACTORY_VERSION = 'v1';
    const t = createLaunchTarget({} as ethers.Provider);
    expect(t.factoryAddress.toLowerCase()).toBe(t.deployment.factory.toLowerCase());
  });

  it('every target agrees with itself about which factory it addresses', () => {
    for (const version of ['v1', 'v2'] as const) {
      (config as any).PONS_FACTORY_VERSION = version;
      const t: LaunchTarget = createLaunchTarget({} as ethers.Provider);
      expect(t.factoryAddress.toLowerCase()).toBe(t.deployment.factory.toLowerCase());
      expect(t.deployment.chainId).toBe(4663);
    }
  });
});

describe('the splitter binds the escrow of the deployment it was given', () => {
  it('uses the passed deployment rather than module state', () => {
    const legacy = deploymentById('pons-v2-legacy-7e1');
    expect(splitterEscrowFor(legacy).toLowerCase()).toBe(legacy.feeEscrow.toLowerCase());
    expect(splitterEscrowFor(legacy).toLowerCase()).not.toBe(
      executableDeployment().feeEscrow.toLowerCase()
    );
  });

  it('still defaults to the executable deployment when given nothing', () => {
    expect(splitterEscrowFor().toLowerCase()).toBe(
      executableDeployment().feeEscrow.toLowerCase()
    );
  });
});

/**
 * The orchestrator verifies the deployment it is about to use, not a global one.
 *
 * The failure being pinned: `handleMention` called
 * `assertDeploymentIdentity(executableDeployment(), provider)` while the calldata came
 * from `createLaunchTarget()` or from an injected `deps.launchTarget`. Under rollback,
 * or in any flow that injects a target, the guard checked the current V2 factory's
 * hashes and escrow and then sent a V1 transaction -- four green ticks about a contract
 * the launch never touched.
 */
describe('handleMention verifies the SELECTED deployment', () => {
  const { handleMention } = require('../src/orchestrator');
  const { Db } = require('../src/db');
  const fs = require('fs');

  const LIVE_FEE = 500_000_000_000_000n;
  const FUNDED = 50_000_000_000_000_000n;
  const P = './data/test-selected-deployment.sqlite';

  function freshDb() {
    if (fs.existsSync(P)) fs.unlinkSync(P);
    return new Db(P);
  }

  /** A target for whichever deployment we want to prove is the one checked. */
  function targetFor(deployment: any): LaunchTarget {
    return {
      version: 'v1',
      deployment,
      factoryAddress: deployment.factory,
      supportsPairing: false,
      build: async () => ({ to: deployment.factory, data: '0xdeadbeef', value: LIVE_FEE }),
      extractToken: () => '0x' + '44'.repeat(20),
    } as unknown as LaunchTarget;
  }

  function depsFor(db: any, deployment: any, seen: any[]) {
    return {
      db,
      parser: {
        parse: async () => ({
          isLaunchIntent: true, confidence: 'high',
          tokenName: 'Moon Coin', tokenSymbol: 'MOON', description: null, pairWith: null,
        }),
      },
      walletResolver: { resolve: async () => ({ xUserId: 'u1', walletAddress: '0x' + '11'.repeat(20) }) },
      xClient: {
        postReply: async () => ({ tweetId: 'r1' }),
        // Comfortably past every anti-Sybil threshold: these tests are about which
        // deployment gets verified, not about the guard layer.
        getAccountSignals: async () => ({
          followersCount: 5000,
          accountCreatedAt: '2019-01-01T00:00:00.000Z',
        }),
      },
      treasurySigner: {
        address: async () => '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa',
        // A creation (`to: ''`) must come back with a contractAddress or deploySplitter
        // refuses -- correctly, since a splitter it cannot name is one nobody can claim
        // from. The first version of this stub returned neither, so every launch failed
        // before provenance was written and the assertion below saw an empty table.
        sendTransaction: async (tx: { to?: string }) => ({
          hash: '0x' + 'ab'.repeat(32),
          wait: async () => ({
            status: 1,
            logs: [],
            contractAddress: tx.to === '' ? '0x' + '99'.repeat(20) : null,
          }),
        }),
      },
      provider: {} as never,
      launchTarget: targetFor(deployment),
      // Records which deployment the guard was actually given.
      verifyIdentity: async () => { seen.push(deployment.id); },
      getLiveFeeWei: async () => LIVE_FEE,
      getTreasuryBalanceWei: async () => FUNDED,
      getLaunchReadiness: async () => ({ canLaunch: true, launchConfigUsable: true }),
    };
  }

  it('checks the v1 deployment when the target is v1', async () => {
    const db = freshDb();
    const seen: string[] = [];
    try {
      await handleMention(
        { tweetId: 't-v1', authorXUserId: 'u1', authorHandle: 'someone', text: 'launch Moon Coin MOON', createdAt: new Date().toISOString() },
        depsFor(db, deploymentById('pons-v1'), seen)
      );
    } finally {
      db.close();
    }
    expect(seen).toEqual(['pons-v1']);
    expect(seen).not.toContain(executableDeployment().id);
  });

  it('records the selected deployment in provenance, not the executable one', async () => {
    const db = freshDb();
    const seen: string[] = [];
    try {
      await handleMention(
        { tweetId: 't-prov', authorXUserId: 'u1', authorHandle: 'someone', text: 'launch Moon Coin MOON', createdAt: new Date().toISOString() },
        depsFor(db, deploymentById('pons-v1'), seen)
      );
      const rows = (db as any).db.prepare('SELECT deployment_id, factory FROM launch_provenance').all();
      expect(rows).toHaveLength(1);
      expect(rows[0].deployment_id).toBe('pons-v1');
      expect(String(rows[0].factory).toLowerCase()).toBe(deploymentById('pons-v1').factory.toLowerCase());
    } finally {
      db.close();
    }
  });

  // The refusal case: a drifted SELECTED deployment stops the launch, and nothing about
  // the executable deployment being fine can rescue it.
  it('a drift on the selected deployment stops the launch', async () => {
    const db = freshDb();
    try {
      const deps: any = depsFor(db, deploymentById('pons-v1'), []);
      deps.verifyIdentity = async () => {
        throw new Error('pons-v1 is not the contract the registry describes. Nothing was deployed.');
      };
      const outcome = await handleMention(
        { tweetId: 't-drift', authorXUserId: 'u1', authorHandle: 'someone', text: 'launch Moon Coin MOON', createdAt: new Date().toISOString() },
        deps
      );
      expect(outcome.kind).not.toBe('launched');
      expect(db.totalSpendLast24h()).toBe(0n);
    } finally {
      db.close();
    }
  });
});
