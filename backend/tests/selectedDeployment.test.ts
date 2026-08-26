import { ethers } from 'ethers';
import { config } from '../src/config';
import { createLaunchTarget, LaunchTarget } from '../src/launchTarget';
import { deploymentById, executableDeployment } from '../src/deployments';
import { splitterEscrowFor } from '../src/splitterDeployer';
import { EMPTY_SOCIALS } from '../src/ponsEncoder';
import { buildCurrentV2LaunchCalldata, launchSalt } from '../src/ponsV2CurrentEncoder';

/** The nonce the splitter is predicted and deployed at, so the fakes stay consistent. */
const SPLITTER_NONCE = 0;
const TREASURY_ADDR = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const ECONOMICS = '0x' + 'ab'.repeat(32);

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
  it('the target carries the executable deployment', () => {
    const t = createLaunchTarget({} as ethers.Provider);
    expect(t.deployment.id).toBe(executableDeployment().id);
    expect(t.deployment.executable).toBe(true);
  });

  /**
   * The two cases that stood here asserted V1Target carried `pons-v1` rather than falling
   * back to the executable deployment -- a real bug at the time, since a guard that
   * verifies one deployment before sending to another is aimed at the wrong contract.
   *
   * V1Target was deleted on 2026-08-26, so the property is now stronger and simpler: there
   * is one target and it carries the one executable deployment. That it can never carry a
   * superseded one is proved behaviourally, against a real transport, in
   * `v1NonExecutable.test.ts`; that v1 remains READABLE is proved in
   * `v1HistoricalReader.test.ts`.
   */
  it('never carries a superseded deployment', () => {
    const t = createLaunchTarget({} as ethers.Provider);
    expect(t.deployment.id).not.toBe('pons-v1');
    expect(t.deployment.id).not.toBe('pons-v2-legacy-7e1');
  });

  it('agrees with itself about which factory it addresses', () => {
    const t: LaunchTarget = createLaunchTarget({} as ethers.Provider);
    expect(t.factoryAddress.toLowerCase()).toBe(t.deployment.factory.toLowerCase());
    expect(t.deployment.chainId).toBe(4663);
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
      version: 'v2-current',
      deployment,
      factoryAddress: deployment.factory,
      supportsPairing: true,
      // REAL calldata for the deployment it names. `0xdeadbeef` was decodable by nothing,
      // which was fine while nobody read the bytes -- the orchestrator now re-checks the
      // built destination and selector immediately before the signer, so a stub that
      // cannot be decoded is a stub that would never have been sent.
      build: async (req: any) =>
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
            expectedEconomics: ECONOMICS,
            salt: launchSalt(deployment, req.tweetId),
          },
          LIVE_FEE,
          deployment
        ),
      extractToken: () => '0x' + '44'.repeat(20),
    } as unknown as LaunchTarget;
  }

  function depsFor(db: any, deployment: any, seen: any[]) {
    return {
      db,
      publicLaunchEnabled: true,
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
        address: async () => TREASURY_ADDR,
        // A creation (`to: ''`) must come back with a contractAddress or deploySplitter
        // refuses -- correctly, since a splitter it cannot name is one nobody can claim
        // from. The first version of this stub returned neither, so every launch failed
        // before provenance was written and the assertion below saw an empty table.
        sendTransaction: async (tx: { to?: string }) => ({
          hash: '0x' + 'ab'.repeat(32),
          wait: async () => ({
            status: 1,
            logs: [],
            contractAddress: tx.to === '' ? ethers.getCreateAddress({ from: TREASURY_ADDR, nonce: SPLITTER_NONCE }) : null,
          }),
        }),
      },
      provider: {} as never,
      launchTarget: targetFor(deployment),
      // Read-only seams: the splitter address is predicted from the treasury's nonce
      // before anything is signed, and the economics digest is observed independently so
      // the calldata is never its own witness.
      getTreasuryNonce: async () => SPLITTER_NONCE,
      readLaunchEconomics: async () => ECONOMICS,
      // Records which deployment the guard was actually given.
      verifyIdentity: async () => { seen.push(deployment.id); },
      getLiveFeeWei: async () => LIVE_FEE,
      getTreasuryBalanceWei: async () => FUNDED,
      getLaunchReadiness: async () => ({ canLaunch: true, launchConfigUsable: true }),
    };
  }

  /*
   * The two cases that stood here INJECTED a v1 target and asserted the guards followed
   * it. They were right about the property -- a guard must verify the deployment being
   * used, not a global -- and wrong about the example, which is now refused outright.
   *
   * A target naming a superseded deployment cannot reach a guard at all: it is rejected
   * before the parser is billed. That is proved behaviourally in
   * `orchestratorAuthority.test.ts`. What survives here is the same property asked with
   * the only deployment that may execute.
   */
  it('checks the SELECTED deployment, twice, and names no other', async () => {
    const db = freshDb();
    const seen: string[] = [];
    try {
      await handleMention(
        { tweetId: 't-sel', authorXUserId: 'u1', authorHandle: 'someone', text: 'launch Moon Coin MOON', createdAt: new Date().toISOString() },
        depsFor(db, executableDeployment(), seen)
      );
    } finally {
      db.close();
    }
    // Twice, deliberately: once before the pair read and once with nothing between it
    // and the splitter deploy. Both must name the SELECTED deployment.
    expect(seen).toEqual([executableDeployment().id, executableDeployment().id]);
    expect(seen).not.toContain('pons-v1');
  });

  it('records the selected deployment in provenance', async () => {
    const db = freshDb();
    const seen: string[] = [];
    try {
      await handleMention(
        { tweetId: 't-prov', authorXUserId: 'u1', authorHandle: 'someone', text: 'launch Moon Coin MOON', createdAt: new Date().toISOString() },
        depsFor(db, executableDeployment(), seen)
      );
      const rows = (db as any).db.prepare('SELECT deployment_id, factory FROM launch_provenance').all();
      expect(rows).toHaveLength(1);
      expect(rows[0].deployment_id).toBe(executableDeployment().id);
      expect(String(rows[0].factory).toLowerCase()).toBe(executableDeployment().factory.toLowerCase());
    } finally {
      db.close();
    }
  });

  // The refusal case: a drifted SELECTED deployment stops the launch, and nothing about
  // the executable deployment being fine can rescue it.
  it('a drift on the selected deployment stops the launch', async () => {
    const db = freshDb();
    try {
      const deps: any = depsFor(db, executableDeployment(), []);
      deps.verifyIdentity = async () => {
        throw new Error('the factory is not the contract the registry describes. Nothing was deployed.');
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

/**
 * The splitter TYPE follows the deployment's fee model, not a global flag.
 *
 * `splitterArtifact()` used to choose FeeSplitterV2 from a global version flag. That is a
 * different question from which deployment this launch is going to, and the two could
 * disagree. The flag is gone, but the property is still worth asserting: the artifact must
 * follow the deployment it is HANDED, including a historical one, because that is what a
 * fee-collection tool passes when it reads an old launch back.
 *
 * Getting it wrong is not a degraded launch. A plain `FeeSplitter` named as
 * `creatorFeeRecipient` on a v2 launch is credited correctly and forever, with no
 * transaction in existence able to move the money -- the escrow pays `msg.sender` and
 * a v1 splitter cannot call it at all. Fees stranded from the first trade.
 */
describe('splitter type follows the deployment it is handed', () => {
  const { splitterArtifactFor } = require('../src/splitterDeployer');

  it('an escrow-credit deployment gets FeeSplitterV2', () => {
    expect(splitterArtifactFor(executableDeployment()).name).toBe('FeeSplitterV2');
  });

  it('a push-from-locker deployment gets FeeSplitter', () => {
    // Handed `pons-v1` explicitly, which is what a HISTORICAL reader does. Nothing can
    // select v1 as a launch target any more, and nothing here is trying to.
    expect(splitterArtifactFor(deploymentById('pons-v1')).name).toBe('FeeSplitter');
  });

  it('the superseded v2 still gets the escrow-capable splitter', () => {
    // It credits an escrow too, so a v1 splitter would strand its fees identically.
    expect(splitterArtifactFor(deploymentById('pons-v2-legacy-7e1')).name).toBe('FeeSplitterV2');
  });

  it('every registry deployment resolves to an artifact that exists', () => {
    for (const d of [deploymentById('pons-v1'), deploymentById('pons-v2-legacy-7e1'), executableDeployment()]) {
      const a = splitterArtifactFor(d);
      expect(typeof a.bytecode).toBe('string');
      expect(a.bytecode.length).toBeGreaterThan(2);
    }
  });
});

/**
 * For a current-V2 launch, the outgoing bytes must be readable before they are sent.
 *
 * Provenance decoding was best-effort: a failure logged and fell back to recomputed
 * intentions. That is the wrong direction. If the encoder produced calldata this
 * deployment's own ABI cannot decode, the bytes are not what anyone thinks they are --
 * and the response to "I cannot read what I am about to send" is to stop, not to write
 * down what I meant instead.
 */
describe('current-V2 sends only calldata it can read back', () => {
  const { assertOutgoingLaunch } = require('../src/launchAssertions');
  const { buildCurrentV2LaunchCalldata, launchSalt } = require('../src/ponsV2CurrentEncoder');

  const D = executableDeployment();
  const SPLITTER = '0x2222222222222222222222222222222222222222';
  const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';
  const ECON = '0x' + 'cd'.repeat(32);

  function good() {
    return buildCurrentV2LaunchCalldata(
      {
        tokenName: 'Moon', tokenSymbol: 'MOON', logo: '', description: '',
        socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
        feeWallet: SPLITTER, launchConfigId: 0n, pairToken: AAPL,
        creatorTaxBps: 0, buybackEnabled: false, expectedEconomics: ECON,
        salt: launchSalt(D, 'tw-1'),
      },
      500_000_000_000_000n,
      D
    );
  }

  it('accepts calldata that decodes and matches', () => {
    const built = good();
    expect(() => assertOutgoingLaunch(built, SPLITTER, D)).not.toThrow();
  });

  it('refuses when the destination is not the selected factory', () => {
    const built = { ...good(), to: deploymentById('pons-v2-legacy-7e1').factory };
    expect(() => assertOutgoingLaunch(built, SPLITTER, D)).toThrow(/destination|factory/i);
  });

  /**
   * The one that would send a creator's fees to the wrong contract: calldata naming a
   * splitter other than the one just deployed and paid for.
   */
  it('refuses when the encoded fee recipient is not the deployed splitter', () => {
    const built = good();
    expect(() => assertOutgoingLaunch(built, '0x' + '77'.repeat(20), D)).toThrow(/recipient|splitter/i);
  });

  it('refuses calldata it cannot decode at all', () => {
    const built = { ...good(), data: '0xf35abbcf' + 'ff'.repeat(64) };
    expect(() => assertOutgoingLaunch(built, SPLITTER, D)).toThrow(/decode|read/i);
  });

  it('refuses a foreign selector rather than falling back', () => {
    const built = good();
    const foreign = { ...built, data: '0xa41d5f2b' + built.data.slice(10) };
    expect(() => assertOutgoingLaunch(foreign, SPLITTER, D)).toThrow(/selector|decode|read/i);
  });

  it('returns the decoded fields, so provenance records bytes rather than intentions', () => {
    const decoded = assertOutgoingLaunch(good(), SPLITTER, D);
    expect(decoded.salt).toBe(launchSalt(D, 'tw-1'));
    expect(decoded.expectedEconomics).toBe(ECON);
    expect(decoded.pairToken.toLowerCase()).toBe(AAPL.toLowerCase());
  });
});

/**
 * Receipt logs are accepted only from the factory that was addressed.
 *
 * A transaction touches many contracts and a receipt carries every log any of them
 * raised. `TokenLaunched` has one signature across both V2 deployments, so a log from
 * ANY contract that emits that shape would decode cleanly -- and be read as this
 * launch's token.
 */
describe('receipt decoding is scoped to the selected factory', () => {
  const { extractLaunchFromReceipt } = require('../src/launchAssertions');
  const { ethers } = require('ethers');
  const { PONS_V2_CURRENT_ABI } = require('../src/ponsV2CurrentEncoder');

  const D = executableDeployment();
  const TOKEN = '0x3333333333333333333333333333333333333333';
  const CURVE = '0x4444444444444444444444444444444444444444';
  const DEPLOYER = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
  const AAPL = '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9';

  function launchedLog(address: string) {
    const enc = new ethers.Interface(PONS_V2_CURRENT_ABI).encodeEventLog('TokenLaunched', [
      TOKEN, CURVE, DEPLOYER, AAPL, 0n, 0n,
    ]);
    return { address, topics: enc.topics, data: enc.data };
  }

  it('reads a launch from the selected factory', () => {
    const r = extractLaunchFromReceipt([launchedLog(D.factory)], D);
    expect(r?.token).toBe(TOKEN);
    expect(r?.curve).toBe(CURVE);
  });

  it('ignores an identically shaped event from another contract', () => {
    const impostor = '0x' + '99'.repeat(20);
    expect(extractLaunchFromReceipt([launchedLog(impostor)], D)).toBeNull();
  });

  it('matches the factory address case-insensitively', () => {
    const upper = D.factory.toUpperCase().replace('0X', '0x');
    expect(extractLaunchFromReceipt([launchedLog(upper)], D)?.token).toBe(TOKEN);
  });

  it('tolerates a log with no address field rather than crashing', () => {
    const l: any = launchedLog(D.factory);
    delete l.address;
    expect(extractLaunchFromReceipt([l], D)).toBeNull();
  });
});

/**
 * The canary resolves the deployment ONCE.
 *
 * `phase-b-launch.ts` answered "which deployment" six separate times: identity from
 * `executableDeployment()`, readiness and fee from global defaults, the target created
 * partway down, pair scanning from another global read, and the receipt decoded from a
 * third. Six answers to one question, each free to differ -- in the run that spends real
 * money for the first time.
 *
 * Static, because executing this script signs and broadcasts. What a test can do is
 * refuse to let the single answer be split apart again.
 */
describe('the canary threads one selected deployment', () => {
  const fs = require('fs');
  const path = require('path');
  const raw: string = fs.readFileSync(path.join(__dirname, '../scripts/phase-b-launch.ts'), 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l: string) => !l.trim().startsWith('//'))
    .join('\n');

  it('never calls executableDeployment() in executable code', () => {
    // The registry's default is a different question from "which deployment is THIS run
    // using", and conflating them is what produced six answers.
    expect(code).not.toMatch(/executableDeployment\(\)/);
  });

  it('creates exactly one launch target', () => {
    expect((code.match(/createLaunchTarget\(/g) ?? []).length).toBe(1);
  });

  it('derives the selected deployment from that target', () => {
    expect(code).toMatch(/const selected = target\.deployment/);
  });

  /**
   * The dry-run path calls these through the `*Fn` bindings, which resolve to the real
   * implementations unless bounded read-only substitutes were supplied for a dry run (and
   * they are dropped entirely under --execute). The property being guarded is unchanged: the
   * SELECTED deployment is what identity, readiness and fee are asked about, never a global.
   */
  it('passes the selected deployment to identity, readiness and fee', () => {
    expect(code).toMatch(/assertIdentityFn\(selected, provider\)/);
    expect(code).toMatch(/readReadinessFn\([\s\S]{0,200}selected/);
    expect(code).toMatch(/readFeeFn\(provider,\s*selected\)/);
    // The executing path keeps the real identity check, by name.
    expect(code).toMatch(/await assertDeploymentIdentity\(selected, provider\)/);
  });

  /** A substitute must never be reachable from a run that spends money. */
  it('drops dry-run substitutes under --execute', () => {
    expect(code).toMatch(/const sub: DryRunOverrides = EXECUTE \? \{\} : overrides;/);
  });

  it('scans pair approvals against the selected deployment', () => {
    expect(code).toMatch(/deployment:\s*selected/);
  });

  it('decides the v1/v2 branch from the deployment, not a global flag', () => {
    // A global version flag used to answer this, and it could name a different contract
    // from the one selected. The branch must follow the deployment actually selected.
    expect(code).toMatch(/const isV2 = selected\.tokenParamsVersion/);
  });

  it('fully confirms the receipt and factory record against the selected deployment', () => {
    // Shared confirmation performs selected-factory receipt extraction plus
    // getLaunchedToken reconciliation; requiring the old direct extractor here would
    // regress the canary back to receipt-only authority.
    expect(code).toMatch(/confirmCanaryLaunch\(\{[\s\S]{0,120}selected,/);
    expect(code).toMatch(/readLaunchRecord:[\s\S]{0,220}getLaunchedToken/);
  });
});

/**
 * Identity is checked twice, and the second time is the one that counts.
 *
 * The orchestrator verifies identity, then deploys the splitter. Between those two lines
 * is an interval -- short, but not zero -- and a factory upgrade or a repointed RPC
 * landing inside it produces a splitter bound to a deployment that has already moved.
 *
 * The provider was withheld from `deploySplitter` on the reasoning that the answer was
 * already known. It was; "already" is not "still". Two reads of the same answer cost one
 * RPC round trip, and the artifact they protect cannot be undone.
 */
describe('the splitter deployer runs its own identity check', () => {
  const fs = require('fs');
  const path = require('path');
  const code: string = fs
    .readFileSync(path.join(__dirname, '../src/orchestrator.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l: string) => !l.trim().startsWith('//'))
    .join('\n');

  it('verifies identity a second time immediately before the deploy', () => {
    // Two calls, and the second must sit directly above deploySplitter with nothing
    // between them. One check plus an interval is one check.
    expect((code.match(/await verifyIdentity\(/g) ?? []).length).toBe(2);
    expect(code).toMatch(/await verifyIdentity\(deps\.provider\);\s*const \{ splitterAddress/);
  });

  it('still passes the selected deployment alongside it', () => {
    expect(code).toMatch(/deploySplitter\([\s\S]{0,400}selected/);
  });
});
