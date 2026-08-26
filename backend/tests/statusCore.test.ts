import { assembleCore, assembleStatus, AcquiredSession, StatusPool } from '../src/statusSession';
import { StatusDeps, buildStatus } from '../src/statusReport';
import { buildCoreEvidence, CoreDeps, CORE_SCHEMA, CORE_VERSION, CORE_PROBLEMS } from '../src/statusCore';
import { validateCoreEvidence, fetchAndValidateCore } from '../src/coreValidator';
import { TimingRecorder, DEPENDENCY_NAMES } from '../src/dependencyTiming';
import { executableDeployment } from '../src/deployments';
import { RpcPool } from '../src/rpcPool';
import { startFakeChain, FakeChain, MATCHING_SHA256 } from './fixtures/jsonRpcServer';

/**
 * The authoritative core must not wait for optional telemetry.
 *
 * v36 answers `/status` truthfully, and usually in 0.4 s. The tail is the problem: sampled
 * 25 times against production, three responses took 3 s or more, and on TWO of those the
 * non-ok check was `read-credits` -- a balance lookup at twitterapi.io that has nothing to
 * do with whether a launch may proceed. On the third, the readiness read itself took
 * 3 012 ms. Two contributors, one of them not chain-authoritative at all.
 *
 * These tests are written so the fix does not depend on WHICH dependency is slow: the core
 * is bounded regardless, because it runs first and under its own deadline.
 */

const D = executableDeployment();
const ETH = 10n ** 18n;
const FEE = 500000000000000n;
const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';

const hang = () => new Promise<never>(() => {});

/** The registry a local fixture chain genuinely satisfies. */
const D2 = { ...D, runtimeBytecodeSha256: MATCHING_SHA256 };
const openChains: FakeChain[] = [];
afterEach(async () => {
  while (openChains.length) await openChains.pop()!.close();
});
async function chain(opts: Parameters<typeof startFakeChain>[0] = {}): Promise<FakeChain> {
  const c = await startFakeChain(opts);
  openChains.push(c);
  return c;
}

/** Deps that depend on the SESSION, exactly as the route builds them. */
function sessionDeps(session: any, over: Partial<StatusDeps> = {}): StatusDeps {
  const unavailable = () => {
    throw new Error('no admitted RPC endpoint is available to serve this status request');
  };
  return deps({
    getChainId: async () => (session ? D.chainId : unavailable()),
    getBlockNumber: async () => (session ? 1234 : unavailable()),
    getLiveFeeWei: async () => (session ? FEE : unavailable()),
    getTreasuryBalanceWei: async () => (session ? ETH / 50n : unavailable()),
    getLaunchReadiness: async () =>
      session ? { launchEnabled: true, whitelisted: false, canLaunch: true, canLaunchOnChain: true } : unavailable(),
    ...over,
  });
}
const slow = <T>(v: T, ms: number) => new Promise<T>((r) => setTimeout(() => r(v), ms));

function deps(over: Partial<StatusDeps> = {}): StatusDeps {
  return {
    expectedChainId: D.chainId,
    getChainId: async () => D.chainId,
    getBlockNumber: async () => 1234,
    getTreasuryBalanceWei: async () => ETH / 50n,
    getLiveFeeWei: async () => FEE,
    getLaunchReadiness: async () => ({
      launchEnabled: true,
      whitelisted: false,
      canLaunch: true,
      canLaunchOnChain: true,
    }),
    getDeploymentIdentity: async () => ({
      result: { ok: true, mismatches: [] },
      ageMs: 0,
      fromCache: false,
    }),
    spentTodayWei: () => 0n,
    rollingSpendLast24hWei: () => 0n,
    dailyCapWei: ETH / 100n,
    launchesToday: () => 0,
    coldAddressSet: true,
    parserRoute: 'OpenRouter',
    alertsRoute: 'Telegram',
    crossCheckHours: 6,
    publicLaunchEnabled: false,
    factoryVersion: 'v2',
    deploymentId: D.id,
    deploymentFactory: D.factory,
    treasuryAddress: TREASURY,
    ...over,
  };
}

function coreDeps(over: Partial<CoreDeps> = {}): CoreDeps {
  return {
    expectedChainId: D.chainId,
    capWei: ETH / 100n,
    publicLaunchEnabled: false,
    deploymentId: D.id,
    deploymentFactory: D.factory,
    treasuryAddress: TREASURY,
    observedThrough: 'aaaaaaaaaaaa',
    endpointOrigin: 'https://rpc.example.com',
    endpointAvailable: true,
    getChainId: async () => D.chainId,
    getBlockNumber: async () => 1234,
    getLiveFeeWei: async () => FEE,
    getTreasuryBalanceWei: async () => ETH / 50n,
    getLaunchReadiness: async () => ({
      launchEnabled: true,
      whitelisted: false,
      canLaunch: true,
      canLaunchOnChain: true,
    }),
    getDeploymentIdentity: async () => ({ result: { ok: true }, ageMs: 0, fromCache: false }),
    rollingSpendLast24hWei: () => 0n,
    ...over,
  };
}

/** A pool that always admits, with no network. */
function fakePool(): StatusPool {
  const session: AcquiredSession = {
    provider: {} as any,
    endpoint: { origin: 'https://rpc.example.com', fingerprint: 'aaaaaaaaaaaa' } as any,
    index: 0,
  };
  return {
    acquire: async () => session,
    status: () => ({
      endpoints: [
        {
          identity: session.endpoint as any,
          admitted: true,
          probeMs: 1,
          checkedAt: null,
          ageMs: null,
        },
      ],
      activeIndex: 0,
    }),
  };
}

describe('RED: the composition waits on optional telemetry', () => {
  it('buildStatus alone sits near its deadline when only readCredits is slow', async () => {
    // The characterisation of the defect, kept as a test so the reason for the split stays
    // visible: every core dependency answers instantly and the page still takes the budget.
    const started = Date.now();
    const report = await buildStatus(deps({ readCredits: hang }), 600);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThan(500);
    // And it is honest about it rather than reporting green.
    expect(report.checks.find((c) => c.name === 'read-credits')!.state).not.toBe('ok');
  }, 20_000);
});

describe('GREEN: the core is bounded regardless of which dependency is slow', () => {
  it('completes fast when readCredits hangs', async () => {
    const started = Date.now();
    const core = await assembleCore(fakePool(), () => deps({ readCredits: hang }), {
      totalBudgetMs: 3000,
      coreBudgetMs: 1000,
    });
    const elapsed = Date.now() - started;

    // The core never starts the credits call at all, so a third party cannot delay it.
    expect(elapsed).toBeLessThan(300);
    expect(core.ok).toBe(true);
    expect(core.dependencies.map((d) => d.name)).not.toContain('read-credits');
  }, 20_000);

  it('completes fast when pair discovery hangs, for a native-ETH check', async () => {
    const started = Date.now();
    const core = await assembleCore(fakePool(), () => deps({ listPairAssets: hang }), {
      totalBudgetMs: 3000,
      coreBudgetMs: 1000,
    });
    expect(Date.now() - started).toBeLessThan(300);
    expect(core.ok).toBe(true);
    // Native ETH does not consult the approval map; making core wait on a log scan for it
    // would be inventing a dependency.
    expect(core.dependencies.map((d) => d.name)).not.toContain('pair-assets');
  }, 20_000);

  it('inside /status, optional telemetry cannot delay the core evidence', async () => {
    const report = await assembleStatus(fakePool(), () => deps({ readCredits: hang }), {
      totalBudgetMs: 1200,
      coreBudgetMs: 400,
    });
    expect(report.core).toBeDefined();
    expect(report.core!.ok).toBe(true);
    // The core's own elapsed time is its own, not the page's.
    expect(report.core!.elapsedMs).toBeLessThan(300);
    // And the slow optional check is still reported truthfully, not omitted or greened.
    expect(report.checks.find((c) => c.name === 'read-credits')!.state).not.toBe('ok');
  }, 20_000);

  it.each([
    ['launch readiness', { getLaunchReadiness: hang }, 'readiness-unreadable'],
    ['deployment identity', { getDeploymentIdentity: hang }, 'identity-unreadable'],
    ['chain', { getChainId: hang }, 'chain-unreadable'],
    ['live fee', { getLiveFeeWei: hang }, 'fee-unreadable'],
    ['treasury balance', { getTreasuryBalanceWei: hang }, 'treasury-unreadable'],
  ])('fails CLOSED within its own deadline when %s hangs', async (_label, over, problem) => {
    const started = Date.now();
    const core = await buildCoreEvidence(coreDeps(over as Partial<CoreDeps>), { budgetMs: 250 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(700);
    expect(core.ok).toBe(false);
    expect(core.problems).toContain(problem);
  }, 20_000);

  it('starts every core dependency concurrently; instrumentation does not serialize', async () => {
    // Five dependencies, each 120 ms. Serialized that is 600 ms; concurrent it is ~120 ms.
    const core = await buildCoreEvidence(
      coreDeps({
        getChainId: () => slow(D.chainId, 120),
        getBlockNumber: () => slow(1234, 120),
        getLiveFeeWei: () => slow(FEE, 120),
        getTreasuryBalanceWei: () => slow(ETH / 50n, 120),
        // canLaunchOnChain included: the producer now requires the factory's own predicate,
        // so a fixture omitting it is incomplete evidence rather than a passing core.
        getLaunchReadiness: () =>
          slow({ launchEnabled: true, whitelisted: false, canLaunch: true, canLaunchOnChain: true }, 120),
        getDeploymentIdentity: () => slow({ result: { ok: true }, ageMs: 0, fromCache: false }, 120),
      }),
      { budgetMs: 2000 }
    );
    expect(core.ok).toBe(true);
    expect(core.elapsedMs).toBeLessThan(400);
    // Every dependency began at roughly the same offset, which is what concurrency means.
    const starts = core.dependencies.map((d) => d.startedAtMs);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(80);
  }, 20_000);

  it('late optional completion cannot mutate a returned report', async () => {
    let release!: (v: { credits: number; bonus: number } | null) => void;
    const report = await assembleStatus(
      fakePool(),
      () => deps({ readCredits: () => new Promise((r) => (release = r)) }),
      { totalBudgetMs: 700, coreBudgetMs: 300 }
    );
    const before = JSON.stringify(report);
    release({ credits: 1, bonus: 0 });
    await new Promise((r) => setTimeout(r, 80));
    // The document is a record of what was true when it was produced.
    expect(JSON.stringify(report)).toBe(before);
  }, 20_000);

  it('concurrent requests do not stack duplicate work into one ledger', async () => {
    const pool = fakePool();
    const [a, b] = await Promise.all([
      assembleStatus(pool, () => deps(), { totalBudgetMs: 2000 }),
      assembleStatus(pool, () => deps(), { totalBudgetMs: 2000 }),
    ]);
    for (const r of [a, b]) {
      const names = r.dependencies!.map((d) => d.name);
      // One row per dependency per response, never two responses sharing a recorder.
      expect(new Set(names).size).toBe(names.length);
    }
  }, 20_000);
});

describe('the core contract refuses missing evidence rather than defaulting it', () => {
  it('an unreadable fee is not a free launch', async () => {
    const core = await buildCoreEvidence(
      coreDeps({ getLiveFeeWei: async () => { throw new Error('boom'); } }),
      { budgetMs: 500 }
    );
    expect(core.launchFeeWei).toBeNull();
    expect(core.problems).toContain('fee-unreadable');
    expect(core.ok).toBe(false);
  });

  it('an unknown rolling spend is not headroom', async () => {
    const core = await buildCoreEvidence(coreDeps({ rollingSpendLast24hWei: undefined }), { budgetMs: 500 });
    expect(core.rolling24hWei).toBeNull();
    expect(core.problems).toContain('spend-unknown');
    expect(core.ok).toBe(false);
  });

  it('an exhausted rolling cap fails', async () => {
    const core = await buildCoreEvidence(coreDeps({ rollingSpendLast24hWei: () => ETH / 100n }), { budgetMs: 500 });
    expect(core.problems).toContain('spend-exhausted');
  });

  it('readiness reached with gaps is not complete', async () => {
    const core = await buildCoreEvidence(
      coreDeps({
        getLaunchReadiness: async () => ({
          launchEnabled: true,
          whitelisted: false,
          canLaunch: true,
          incomplete: 'answered with gaps: launchConfigCount',
        }),
      }),
      { budgetMs: 500 }
    );
    expect(core.readiness!.complete).toBe(false);
    expect(core.problems).toContain('readiness-incomplete');
    expect(core.ok).toBe(false);
  });

  it('a stale cached identity pass is not fresh evidence', async () => {
    const core = await buildCoreEvidence(
      coreDeps({
        getDeploymentIdentity: async () => ({ result: { ok: true }, ageMs: 60 * 60 * 1000, fromCache: true }),
      }),
      { budgetMs: 500, identityMaxAgeMs: 15 * 60 * 1000 }
    );
    expect(core.problems).toContain('identity-stale');
    expect(core.identity!.fromCache).toBe(true);
    expect(core.identity!.ageMs).toBe(3600000);
  });

  it('an identity mismatch is distinct from an unreadable one', async () => {
    const mismatch = await buildCoreEvidence(
      coreDeps({ getDeploymentIdentity: async () => ({ result: { ok: false }, ageMs: 0, fromCache: false }) }),
      { budgetMs: 500 }
    );
    expect(mismatch.problems).toContain('identity-mismatch');
    expect(mismatch.problems).not.toContain('identity-unreadable');
  });

  it('a wrong chain fails, and does not silently pass the expected one through', async () => {
    const core = await buildCoreEvidence(coreDeps({ getChainId: async () => 46630 }), { budgetMs: 500 });
    expect(core.chainId).toBe(46630);
    expect(core.expectedChainId).toBe(D.chainId);
    expect(core.problems).toContain('chain-mismatch');
  });

  it('no admitted endpoint is said once, not fabricated around', async () => {
    const core = await buildCoreEvidence(coreDeps({ endpointAvailable: false }), { budgetMs: 500 });
    expect(core.problems).toEqual(['no-admitted-endpoint']);
    expect(core.chainId).toBeNull();
    expect(core.launchFeeWei).toBeNull();
    // Every core dependency is still listed, as not-configured, so none looks forgotten.
    expect(core.dependencies.length).toBeGreaterThanOrEqual(5);
  });
});

describe('timing evidence carries no secret', () => {
  it('refuses to publish a dependency name that is not on the allowlist', () => {
    const rec = new TimingRecorder();
    expect(() => rec.track('twitterapi-key' as any, Promise.resolve(1))).toThrow(/unlisted dependency/);
  });

  it('never carries provider error text, however the failure is shaped', async () => {
    const secret = 'SECRETKEY123456789abcdef';
    const core = await buildCoreEvidence(
      coreDeps({
        getLiveFeeWei: async () => {
          const e: any = new Error(`request failed for https://rpc.example.com/v2/${secret}`);
          e.shortMessage = `failed for https://rpc.example.com/v2/${secret}`;
          e.cause = new Error(`socket to https://rpc.example.com/v2/${secret}`);
          throw e;
        },
      }),
      { budgetMs: 500 }
    );
    const published = JSON.stringify(core);
    expect(published).not.toContain(secret);
    expect(published).not.toContain(secret.slice(0, 8));
    expect(published).not.toContain('/v2/');
    // The outcome category still says what happened.
    expect(core.dependencies.find((d) => d.name === 'launch-fee')!.outcome).toBe('failed');
  });

  it('every published dependency name is on the fixed allowlist', async () => {
    const core = await buildCoreEvidence(coreDeps(), { budgetMs: 1000 });
    for (const d of core.dependencies) expect(DEPENDENCY_NAMES).toContain(d.name);
  });

  it('marks the batched readiness read as shared rather than as its own cost', async () => {
    const core = await buildCoreEvidence(coreDeps(), { budgetMs: 1000 });
    expect(core.dependencies.find((d) => d.name === 'launch-readiness')!.shared).toBe(true);
    expect(core.dependencies.find((d) => d.name === 'chain')!.shared).toBe(false);
  });
});

describe('the keyless validator', () => {
  const good = () =>
    buildCoreEvidence(coreDeps(), { budgetMs: 1000 });
  // Every quantity is CALLER-PINNED. None of it is read from the body being judged.
  const opts = {
    expectedChainId: D.chainId,
    expectedDeploymentId: D.id,
    expectedFactory: D.factory,
    expectedLaunchFeeWei: FEE,
    expectedCapWei: ETH / 100n,
    expectedTreasury: TREASURY,
    requiredTreasuryBalanceWei: FEE,
    expectedEndpointFingerprint: 'aaaaaaaaaaaa',
  };

  it('passes on complete, fresh, correct evidence -- and says it grants nothing', async () => {
    const r = validateCoreEvidence(await good(), opts);
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.authority).toMatch(/grants no signing or financial authority/);
  });

  it('ACCEPTS the public gate being false, because the pause is not the canary authority', async () => {
    const core = await good();
    expect(core.publicLaunchEnabled).toBe(false);
    expect(validateCoreEvidence(core, opts).pass).toBe(true);
    // And an unexpectedly OPEN gate is a failure, so the check is real in both directions.
    expect(
      validateCoreEvidence({ ...core, publicLaunchEnabled: true }, opts).failures
    ).toContain('public-gate-unexpected');
  });

  it.each([
    ['wrong chain', (c: any) => ({ ...c, chainId: 46630 }), 'chain-mismatch'],
    ['wrong factory', (c: any) => ({ ...c, factory: '0x' + '11'.repeat(20) }), 'factory-mismatch'],
    ['wrong deployment', (c: any) => ({ ...c, deploymentId: 'pons-v1' }), 'deployment-mismatch'],
    ['missing block', (c: any) => ({ ...c, block: null }), 'block-missing'],
    ['no endpoint provenance', (c: any) => ({ ...c, observedThrough: null }), 'endpoint-missing'],
    ['unreadable fee', (c: any) => ({ ...c, launchFeeWei: null }), 'fee-mismatch'],
    ['wrong fee', (c: any) => ({ ...c, launchFeeWei: '1' }), 'fee-mismatch'],
    ['incomplete readiness', (c: any) => ({ ...c, readiness: { ...c.readiness, complete: false } }), 'readiness-incomplete'],
    ['not ready', (c: any) => ({ ...c, readiness: { ...c.readiness, ready: false } }), 'readiness-not-ready'],
    ['identity not ok', (c: any) => ({ ...c, identity: { ...c.identity, ok: false } }), 'identity-not-fresh'],
    ['identity unreadable', (c: any) => ({ ...c, identity: { ...c.identity, unreadable: true } }), 'identity-not-fresh'],
    ['unknown spend', (c: any) => ({ ...c, rolling24hWei: null }), 'spend-unknown'],
    ['exhausted spend', (c: any) => ({ ...c, rolling24hWei: c.capWei }), 'spend-exhausted'],
    ['unreadable treasury', (c: any) => ({ ...c, treasuryBalanceWei: null }), 'treasury-unreadable'],
    ['wrong treasury', (c: any) => ({ ...c, treasuryAddress: '0x' + '22'.repeat(20) }), 'treasury-mismatch'],
    ['zero balance', (c: any) => ({ ...c, treasuryBalanceWei: '0' }), 'treasury-insufficient'],
    ['balance one wei short', (c: any) => ({ ...c, treasuryBalanceWei: (FEE - 1n).toString() }), 'treasury-insufficient'],
    ['inflated cap', (c: any) => ({ ...c, capWei: '999999999999999999999' }), 'cap-mismatch'],
    ['missing cap', (c: any) => { const x = { ...c }; delete x.capWei; return x; }, 'cap-mismatch'],
    ['ok true with problems', (c: any) => ({ ...c, problems: ['chain-mismatch'] }), 'core-not-ok'],
    ['unknown problem code', (c: any) => ({ ...c, problems: ['not-a-real-code'] }), 'unknown-problem-code'],
    ['ready with nothing permitting it', (c: any) => ({ ...c, readiness: { ...c.readiness, launchEnabled: false, whitelisted: false } }), 'readiness-inconsistent'],
    ['canLaunchOnChain false', (c: any) => ({ ...c, readiness: { ...c.readiness, canLaunchOnChain: false } }), 'readiness-inconsistent'],
    ['identity age negative', (c: any) => ({ ...c, identity: { ...c.identity, ageMs: -5 } }), 'identity-not-fresh'],
    ['identity age far in the past', (c: any) => ({ ...c, identity: { ...c.identity, ageMs: 3600000 } }), 'identity-stale'],
    ['block zero', (c: any) => ({ ...c, block: 0 }), 'block-missing'],
    ['block negative', (c: any) => ({ ...c, block: -1 }), 'block-missing'],
    ['origin carrying a path', (c: any) => ({ ...c, endpointOrigin: 'https://rpc.example.com/v2/KEY' }), 'malformed-field'],
    ['fingerprint of the wrong shape', (c: any) => ({ ...c, observedThrough: 'not-hex' }), 'endpoint-missing'],
    ['ok not a boolean', (c: any) => ({ ...c, ok: 'true' }), 'malformed-field'],
    ['gate not a boolean', (c: any) => ({ ...c, publicLaunchEnabled: 0 }), 'malformed-field'],
    ['dependency row of the wrong shape', (c: any) => ({ ...c, dependencies: [{ name: 'nope', outcome: 'ok', ms: 1, startedAtMs: 0, shared: false }] }), 'malformed-field'],
  ])('fails on %s', async (_label, mutate, code) => {
    const r = validateCoreEvidence(mutate(await good()), opts);
    expect(r.pass).toBe(false);
    expect(r.failures).toContain(code);
  });

  it('fails on a stale document, and on one dated in the future', async () => {
    const core = await good();
    const stale = validateCoreEvidence(core, { ...opts, now: () => Date.parse(core.generatedAt) + 120_000 });
    expect(stale.failures).toContain('stale');
    const ahead = validateCoreEvidence(core, { ...opts, now: () => Date.parse(core.generatedAt) - 60_000 });
    expect(ahead.failures).toContain('clock-ahead');
  });

  it('rejects an unknown schema or version rather than reading fields it does not understand', () => {
    expect(validateCoreEvidence({ schema: 'something.else', version: 1 }, opts).failures).toContain('schema-unknown');
    expect(validateCoreEvidence({ schema: CORE_SCHEMA, version: 99 }, opts).failures).toContain('version-unknown');
  });

  it('rejects an endpoint fingerprint the caller did not expect', async () => {
    const r = validateCoreEvidence(await good(), { ...opts, expectedEndpointFingerprint: 'bbbbbbbbbbbb' });
    expect(r.failures).toContain('endpoint-mismatch');
  });

  it('fails a non-200 without reading the body, and never retries', async () => {
    let calls = 0;
    const r = await fetchAndValidateCore('https://example.test', {
      ...opts,
      fetchImpl: (async () => {
        calls += 1;
        return { status: 503, json: async () => ({}) } as any;
      }) as any,
    });
    expect(r.pass).toBe(false);
    expect(r.failures).toEqual(['http-not-200']);
    expect(calls).toBe(1);
  });

  it('never leaks a credentialed base URL through a failed request', async () => {
    const secret = 'SECRETKEY123456789abcdef';
    const r = await fetchAndValidateCore(`https://user:${secret}@example.test`, {
      ...opts,
      fetchImpl: (async () => {
        throw new Error(`fetch failed for https://user:${secret}@example.test/status/core`);
      }) as any,
    });
    const published = JSON.stringify(r);
    expect(published).not.toContain(secret);
    expect(r.failures).toEqual(['request-failed']);
  });
});

describe('/status stays compatible while gaining the core', () => {
  it('keeps the spend envelope exactly where canarySpend reads it', async () => {
    const report = await assembleStatus(fakePool(), () => deps(), { totalBudgetMs: 2000 });
    expect(report.spend).toBeDefined();
    expect(report.spend!.window).toBe('rolling-24h');
    expect(report.spend!.chainId).toBe(D.chainId);
    expect(report.spend!.publicLaunchEnabled).toBe(false);
    expect(report.spend!.observedThrough).toBe('aaaaaaaaaaaa');
  }, 20_000);

  it('publishes the core with its stable schema alongside the human checks', async () => {
    const report = await assembleStatus(fakePool(), () => deps(), { totalBudgetMs: 2000 });
    expect(report.core!.schema).toBe(CORE_SCHEMA);
    expect(report.core!.version).toBe(CORE_VERSION);
    expect(report.checks.length).toBeGreaterThan(5);
    expect(report.dependencies!.length).toBeGreaterThan(0);
  }, 20_000);

  it('does not turn a failed optional check into a green lie', async () => {
    const report = await assembleStatus(
      fakePool(),
      () => deps({ readCredits: async () => { throw new Error('402 Credits is not enough'); } }),
      { totalBudgetMs: 2000 }
    );
    const credits = report.checks.find((c) => c.name === 'read-credits')!;
    expect(credits.state).not.toBe('ok');
    // The core is unaffected: an exhausted credits balance says nothing about the chain.
    expect(report.core!.ok).toBe(true);
  }, 20_000);
});

/**
 * HOSTILE PUBLIC JSON.
 *
 * The body is untrusted. An earlier version called BigInt() on it directly, so a field of
 * "not-a-bigint" made the validator THROW a SyntaxError -- and the CLI's outer catch then
 * exited 2 with the failure category discarded. A validator that throws has no closed
 * vocabulary at the one moment it needs one.
 */
describe('the validator never throws, whatever the body contains', () => {
  const opts = {
    expectedChainId: D.chainId,
    expectedDeploymentId: D.id,
    expectedFactory: D.factory,
    expectedLaunchFeeWei: FEE,
    expectedCapWei: ETH / 100n,
    expectedTreasury: TREASURY,
    requiredTreasuryBalanceWei: FEE,
    expectedEndpointFingerprint: 'aaaaaaaaaaaa',
  };

  const wellFormed = () => ({
    schema: CORE_SCHEMA,
    version: CORE_VERSION,
    ok: true,
    generatedAt: new Date().toISOString(),
    elapsedMs: 1,
    observedThrough: 'aaaaaaaaaaaa',
    endpointOrigin: 'https://rpc.example.com',
    chainId: D.chainId,
    expectedChainId: D.chainId,
    block: 1,
    deploymentId: D.id,
    factory: D.factory,
    identity: { ok: true, ageMs: 0, fromCache: false, unreadable: false },
    launchFeeWei: FEE.toString(),
    readiness: { ready: true, launchEnabled: true, whitelisted: false, canLaunchOnChain: true, complete: true },
    treasuryAddress: TREASURY,
    treasuryBalanceWei: (ETH / 50n).toString(),
    rolling24hWei: '0',
    capWei: (ETH / 100n).toString(),
    publicLaunchEnabled: false,
    problems: [],
    dependencies: [],
  });

  it('a production-shaped, paused core still PASSES', () => {
    const r = validateCoreEvidence(wellFormed(), opts);
    expect(r.failures).toEqual([]);
    expect(r.pass).toBe(true);
  });

  /** Every shape a numeric string field must refuse, and none of them may throw. */
  const HOSTILE = ['not-a-bigint', '', ' 12 ', '+12', '-1', '1.0', '1e3', '0x0a', '007', '9'.repeat(60)];

  it.each(['launchFeeWei', 'rolling24hWei', 'capWei', 'treasuryBalanceWei'])(
    'refuses every malformed shape of %s without throwing',
    (field) => {
      for (const bad of HOSTILE) {
        let r!: ReturnType<typeof validateCoreEvidence>;
        expect(() => {
          r = validateCoreEvidence({ ...wellFormed(), [field]: bad }, opts);
        }).not.toThrow();
        expect(r.pass).toBe(false);
        // The raw value never appears in what the validator publishes.
        expect(JSON.stringify(r)).not.toContain('9'.repeat(60));
      }
    }
  );

  it.each([
    ['null body', null],
    ['a string body', 'hello'],
    ['an array body', [1, 2, 3]],
    ['a number body', 42],
    ['an empty object', {}],
  ])('refuses %s without throwing', (_label, body) => {
    let r!: ReturnType<typeof validateCoreEvidence>;
    expect(() => {
      r = validateCoreEvidence(body, opts);
    }).not.toThrow();
    expect(r.pass).toBe(false);
  });

  it.each(['identity', 'readiness'])('refuses a %s that is not an object, without throwing', (field) => {
    for (const bad of [null, 'x', 42, []]) {
      let r!: ReturnType<typeof validateCoreEvidence>;
      expect(() => {
        r = validateCoreEvidence({ ...wellFormed(), [field]: bad }, opts);
      }).not.toThrow();
      expect(r.pass).toBe(false);
    }
  });

  it.each(['elapsedMs', 'chainId'])('refuses a malformed %s without throwing', (field) => {
    for (const bad of [NaN, Infinity, -1, 1.5, '3', null]) {
      let r!: ReturnType<typeof validateCoreEvidence>;
      expect(() => {
        r = validateCoreEvidence({ ...wellFormed(), [field]: bad }, opts);
      }).not.toThrow();
      expect(r.pass).toBe(false);
    }
  });

  it('never returns evidence alongside a failure', () => {
    const r = validateCoreEvidence({ ...wellFormed(), launchFeeWei: 'not-a-bigint' }, opts);
    expect(r.pass).toBe(false);
    // Reading `evidence` after a failure would be reading a document just judged unfit.
    expect(r.evidence).toBeNull();
  });

  it('compares spend against the CALLER pin, not the body cap', () => {
    // The exact reproduced defect: cap inflated in the body, real cap exhausted.
    const r = validateCoreEvidence(
      { ...wellFormed(), rolling24hWei: (ETH / 100n).toString(), capWei: '999999999999999999999' },
      opts
    );
    expect(r.pass).toBe(false);
    expect(r.failures).toEqual(expect.arrayContaining(['cap-mismatch', 'spend-exhausted']));
  });
});

describe('the producer never throws, and never leaks', () => {
  it('a SYNCHRONOUS rolling-spend throw becomes spend-unknown, not a rejection', async () => {
    const core = await buildCoreEvidence(
      coreDeps({
        rollingSpendLast24hWei: () => {
          throw new Error('DB path /secret/path failed');
        },
      }),
      { budgetMs: 500 }
    );

    expect(core.ok).toBe(false);
    expect(core.problems).toContain('spend-unknown');
    expect(core.rolling24hWei).toBeNull();
    // The path never reaches the document.
    expect(JSON.stringify(core)).not.toContain('/secret/path');
  });

  it('an unreadable identity refresh fails core even with a cached prior pass', async () => {
    const core = await buildCoreEvidence(
      coreDeps({
        getDeploymentIdentity: async () => ({
          result: { ok: true },
          ageMs: 660_000,
          fromCache: true,
          unreadable: 'ECONNRESET',
        }),
      }),
      { budgetMs: 500, identityMaxAgeMs: 15 * 60 * 1000 }
    );
    // Keeping a good verdict standing is right for a status page and wrong for spend
    // evidence: the bytecode check could not be performed, so nobody just measured it.
    expect(core.ok).toBe(false);
    expect(core.problems).toContain('identity-unreadable');
  });

  it('a readable ZERO balance is not funding', async () => {
    const core = await buildCoreEvidence(
      coreDeps({ getLiveFeeWei: async () => 10n, getTreasuryBalanceWei: async () => 0n }),
      { budgetMs: 500 }
    );
    expect(core.ok).toBe(false);
    expect(core.problems).toContain('treasury-insufficient');
  });

  it.each([
    ['one wei short', 9n, true],
    ['exactly the fee', 10n, false],
    ['more than the fee', 11n, false],
  ])('balance %s of a 10 wei fee', async (_label, balance, shouldFail) => {
    const core = await buildCoreEvidence(
      coreDeps({ getLiveFeeWei: async () => 10n, getTreasuryBalanceWei: async () => balance as bigint }),
      { budgetMs: 500 }
    );
    expect(core.problems.includes('treasury-insufficient')).toBe(shouldFail);
  });

  it('honours a caller-pinned balance floor above the fee', async () => {
    const core = await buildCoreEvidence(
      coreDeps({ getLiveFeeWei: async () => 10n, getTreasuryBalanceWei: async () => 50n }),
      { budgetMs: 500, requiredBalanceWei: 100n }
    );
    expect(core.problems).toContain('treasury-insufficient');
  });

  it('publishes only problem codes from the version 1 vocabulary', async () => {
    const core = await buildCoreEvidence(
      coreDeps({
        getChainId: async () => 46630,
        getLiveFeeWei: async () => {
          throw new Error('x');
        },
        rollingSpendLast24hWei: undefined,
      }),
      { budgetMs: 500 }
    );
    expect(core.problems.length).toBeGreaterThan(0);
    for (const p of core.problems) expect(CORE_PROBLEMS).toContain(p);
  });
});

describe('the client deadline covers the body, not only the headers', () => {
  const opts = {
    expectedChainId: D.chainId,
    expectedDeploymentId: D.id,
    expectedFactory: D.factory,
    expectedLaunchFeeWei: FEE,
    expectedCapWei: ETH / 100n,
    expectedTreasury: TREASURY,
    requiredTreasuryBalanceWei: FEE,
    expectedEndpointFingerprint: 'aaaaaaaaaaaa',
  };

  it('returns FAIL when json() never settles, rather than hanging forever', async () => {
    let fetches = 0;
    const started = Date.now();
    const r = await fetchAndValidateCore('https://example.test', {
      ...opts,
      timeoutMs: 60,
      fetchImpl: (async () => {
        fetches += 1;
        return {
          status: 200,
          headers: { get: () => null },
          // A body stream that never ends. AbortSignal on the fetch does not settle this.
          json: () => new Promise(() => {}),
        } as any;
      }) as any,
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(r.pass).toBe(false);
    expect(r.failures).toEqual(['request-failed']);
    // Still exactly one fetch. Bounding must never become retrying.
    expect(fetches).toBe(1);
  }, 20_000);

  it('refuses a body larger than the bound without reading it', async () => {
    const r = await fetchAndValidateCore('https://example.test', {
      ...opts,
      maxBodyBytes: 1024,
      fetchImpl: (async () =>
        ({
          status: 200,
          headers: { get: (h: string) => (h === 'content-length' ? '5000000' : null) },
          json: async () => {
            throw new Error('should not be read');
          },
        }) as any) as any,
    });
    expect(r.failures).toEqual(['response-too-large']);
  });

  it('survives a fetch implementation that returns nonsense', async () => {
    const r = await fetchAndValidateCore('https://example.test', {
      ...opts,
      fetchImpl: (async () => ({}) as any) as any,
    });
    expect(r.pass).toBe(false);
    expect(r.failures).toEqual(['request-failed']);
  });
});

/**
 * ONE RESPONSE, ONE OBSERVATION.
 *
 * `assembleStatus` built the core and then handed the same dependency set to `buildStatus`,
 * which started FRESH chain, fee, readiness, balance and identity reads. So a single
 * document could embed core evidence from observation A beside human checks describing
 * observation B, with nothing on the page able to say so. Sharing a function definition is
 * not sharing an observation.
 */
describe('one /status response describes one world', () => {
  function countingDeps(counts: Record<string, number>) {
    const bump = (k: string) => {
      counts[k] = (counts[k] ?? 0) + 1;
    };
    return deps({
      getChainId: async () => {
        bump('chain');
        return D.chainId;
      },
      getBlockNumber: async () => {
        bump('block');
        return 1234;
      },
      getLiveFeeWei: async () => {
        bump('fee');
        return FEE;
      },
      getTreasuryBalanceWei: async () => {
        bump('balance');
        return ETH / 50n;
      },
      getLaunchReadiness: async () => {
        bump('readiness');
        return { launchEnabled: true, whitelisted: false, canLaunch: true, canLaunchOnChain: true };
      },
      getDeploymentIdentity: async () => {
        bump('identity');
        return { result: { ok: true, mismatches: [] }, ageMs: 0, fromCache: false };
      },
      rollingSpendLast24hWei: () => 0n,
    });
  }

  it('invokes each core dependency exactly ONCE per full status request', async () => {
    const counts: Record<string, number> = {};
    await assembleStatus(fakePool(), () => countingDeps(counts), { totalBudgetMs: 3000 });
    // Two reads of the same fact in one document is how two worlds get presented as one.
    for (const key of ['chain', 'block', 'fee', 'balance', 'readiness', 'identity']) {
      expect(counts[key]).toBe(1);
    }
  }, 20_000);

  it('the human checks agree with the embedded core, value for value', async () => {
    const report = await assembleStatus(fakePool(), () => deps(), { totalBudgetMs: 3000 });
    const rpc = report.checks.find((c) => c.name === 'rpc')!;
    const fee = report.checks.find((c) => c.name === 'launch-fee')!;

    expect(report.core!.chainId).toBe(D.chainId);
    expect(rpc.detail).toContain(String(report.core!.block));
    expect(rpc.detail).toContain(String(report.core!.chainId));
    // The fee line and the core's fee are the same observation, not two reads that happened
    // to agree.
    expect(report.core!.launchFeeWei).toBe(FEE.toString());
    expect(fee.state).toBe('ok');
    expect(report.spend!.observedThrough).toBe(report.core!.observedThrough);
  }, 20_000);

  it('a chain fact that changes AFTER the core is read cannot appear in the same document', async () => {
    let chain = D.chainId;
    const report = await assembleStatus(
      fakePool(),
      () =>
        deps({
          getChainId: async () => {
            const v = chain;
            // The world moves the instant the core has looked at it.
            chain = 46630;
            return v;
          },
          rollingSpendLast24hWei: () => 0n,
        }),
      { totalBudgetMs: 3000 }
    );
    // Whatever the page says, it says once. Before this, the core carried 4663 while the
    // human `rpc` check re-read and reported 46630 in the same response.
    expect(report.core!.chainId).toBe(D.chainId);
    expect(report.checks.find((c) => c.name === 'rpc')!.detail).toContain(String(D.chainId));
  }, 20_000);

  it('a core axis that failed is reported as unobserved, not retried into a green check', async () => {
    const report = await assembleStatus(
      fakePool(),
      () => deps({ getLiveFeeWei: hang, rollingSpendLast24hWei: () => 0n }),
      { totalBudgetMs: 1500, coreBudgetMs: 250 }
    );
    expect(report.core!.problems).toContain('fee-unreadable');
    // A page where core.ok is false while launch-fee is green would be the same
    // contradiction in the other direction.
    expect(report.checks.find((c) => c.name === 'launch-fee')!.state).not.toBe('ok');
  }, 20_000);
});

/**
 * The one absolute deadline is never re-issued.
 *
 * `Math.max(REPORTING_FLOOR_MS, deadline - now())` was applied twice -- once for the core
 * and once for the full report -- so an exhausted budget was granted a fresh 250 ms each
 * time. Measured with a zero total budget and hanging dependencies: ~690 ms elapsed against
 * a bound of zero.
 */
describe('exhausted budget is not topped up', () => {
  it('does not manufacture time after the deadline has passed', async () => {
    const a = await chain({ hang: ['eth_chainId'] });
    const pool = new RpcPool([a.url], { deployment: D2, admissionTimeoutMs: 4000 });

    const started = Date.now();
    const report = await assembleStatus(
      pool,
      (session) =>
        sessionDeps(session, {
          getChainId: hang,
          getBlockNumber: hang,
          getLiveFeeWei: hang,
          getLaunchReadiness: hang,
          getTreasuryBalanceWei: hang,
          getDeploymentIdentity: hang,
          listPairAssets: hang,
          readCredits: hang,
        }),
      { totalBudgetMs: 0 }
    );
    const elapsed = Date.now() - started;

    // Was ~690 ms. Zero budget plus scheduling slack, not two fresh floors.
    expect(elapsed).toBeLessThan(300);
    // And a body is still returned: the reserve is taken BEFORE acquisition, not after.
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.core).toBeDefined();
  }, 20_000);

  it('a tight budget with a stalled pool still answers inside it', async () => {
    const a = await chain({ hang: ['eth_chainId'] });
    const b = await chain({ hang: ['eth_chainId'] });
    const pool = new RpcPool([a.url, b.url], { deployment: D2, admissionTimeoutMs: 4000 });

    const started = Date.now();
    const report = await assembleStatus(pool, (session) => sessionDeps(session), {
      totalBudgetMs: 600,
    });
    // 600 ms of budget plus 300 ms of CI scheduling slack. Not a multiple.
    expect(Date.now() - started).toBeLessThan(900);
    expect(report.core!.ok).toBe(false);
    expect(report.core!.problems).toContain('no-admitted-endpoint');
  }, 20_000);
});
