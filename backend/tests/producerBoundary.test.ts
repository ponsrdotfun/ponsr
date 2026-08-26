import express from 'express';
import type { AddressInfo } from 'net';
import { buildCoreEvidence, CoreDeps, CORE_PROBLEMS } from '../src/statusCore';
import { assembleCore, assembleStatus, AcquiredSession, StatusPool } from '../src/statusSession';
import { StatusDeps } from '../src/statusReport';
import { statusHandler, statusCoreHandler, coreFailureBody } from '../src/statusRoutes';
import { validateCoreEvidence } from '../src/coreValidator';
import { parseTimestamp } from '../src/strictParse';
import { executableDeployment } from '../src/deployments';

/**
 * THE PRODUCER'S OWN TRUST BOUNDARY.
 *
 * Two claims turned out to be false at exactly the place they were most confidently made.
 *
 * `buildCoreEvidence` documented "never throws", and only the synchronous rolling-spend
 * callback had been wrapped. The other six dependencies are INVOKED SYNCHRONOUSLY when
 * their promises are constructed, so an implementation that throws before returning one
 * escaped the core entirely -- and the legacy `/status` catch then published the raw
 * message. One synchronous integration bug was enough to leak an internal path through a
 * public endpoint.
 *
 * And the core called itself authoritative while publishing `ok: true` beside
 * `canLaunchOnChain: false`, relying on the separate validator to repair it. An
 * authoritative endpoint has to be internally valid before anybody reads it: a second
 * opinion is not a substitute for being right.
 */

const D = executableDeployment();
const ETH = 10n ** 18n;
const FEE = 500000000000000n;
const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';

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

const DEPENDENCY_FUNCTIONS = [
  ['getChainId', 'chain-unreadable'],
  ['getBlockNumber', 'chain-unreadable'],
  ['getLiveFeeWei', 'fee-unreadable'],
  ['getTreasuryBalanceWei', 'treasury-unreadable'],
  ['getLaunchReadiness', 'readiness-unreadable'],
  ['getDeploymentIdentity', 'identity-unreadable'],
] as const;

describe('a synchronous throw from any dependency cannot escape the producer', () => {
  it.each(DEPENDENCY_FUNCTIONS)(
    '%s throwing synchronously resolves to a closed problem',
    async (fn, problem) => {
      const secret = `SECRET_SYNC_${fn}`;
      const core = await buildCoreEvidence(
        coreDeps({
          [fn]: () => {
            throw new Error(secret);
          },
        } as Partial<CoreDeps>),
        { budgetMs: 400 }
      );

      // Resolved, not rejected. Before this, every one of these threw out of the function.
      expect(core.ok).toBe(false);
      expect(core.problems).toContain(problem);
      // And nothing from the thrown value reaches the document.
      expect(JSON.stringify(core)).not.toContain(secret);
      expect(JSON.stringify(core)).not.toContain('SECRET_SYNC');
    }
  );

  it('all six throwing at once still resolves, with every secret absent', async () => {
    const throwing: Record<string, () => never> = {};
    for (const [fn] of DEPENDENCY_FUNCTIONS) {
      throwing[fn] = () => {
        throw new Error(`SECRET_SYNC_${fn}`);
      };
    }
    const core = await buildCoreEvidence(coreDeps(throwing as Partial<CoreDeps>), { budgetMs: 400 });
    expect(core.ok).toBe(false);
    const serialised = JSON.stringify(core);
    for (const [fn] of DEPENDENCY_FUNCTIONS) expect(serialised).not.toContain(`SECRET_SYNC_${fn}`);
    // Only codes from the version 1 vocabulary.
    for (const p of core.problems) expect(CORE_PROBLEMS).toContain(p);
  });

  it('a dependency returning a non-promise is a broken implementation, not a value', async () => {
    const core = await buildCoreEvidence(
      coreDeps({ getLiveFeeWei: (() => 42) as unknown as CoreDeps['getLiveFeeWei'] }),
      { budgetMs: 400 }
    );
    expect(core.ok).toBe(false);
    expect(core.problems).toContain('fee-unreadable');
  });

  it('ASYNCHRONOUS rejection still behaves exactly as before', async () => {
    const core = await buildCoreEvidence(
      coreDeps({
        getLiveFeeWei: async () => {
          throw new Error('SECRET_ASYNC');
        },
      }),
      { budgetMs: 400 }
    );
    expect(core.ok).toBe(false);
    expect(core.problems).toContain('fee-unreadable');
    expect(JSON.stringify(core)).not.toContain('SECRET_ASYNC');
  });

  it('dependencies still start concurrently and are each invoked once', async () => {
    const calls: Record<string, number> = {};
    const bump = (k: string) => {
      calls[k] = (calls[k] ?? 0) + 1;
    };
    const slow = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 120));

    const started = Date.now();
    const core = await buildCoreEvidence(
      coreDeps({
        getChainId: () => (bump('chain'), slow(D.chainId)),
        getBlockNumber: () => (bump('block'), slow(1234)),
        getLiveFeeWei: () => (bump('fee'), slow(FEE)),
        getTreasuryBalanceWei: () => (bump('balance'), slow(ETH / 50n)),
        getLaunchReadiness: () =>
          (bump('readiness'),
          slow({ launchEnabled: true, whitelisted: false, canLaunch: true, canLaunchOnChain: true })),
        getDeploymentIdentity: () =>
          (bump('identity'), slow({ result: { ok: true }, ageMs: 0, fromCache: false })),
      }),
      { budgetMs: 2000 }
    );

    expect(core.ok).toBe(true);
    // Six dependencies at 120 ms each: serialized would be 720 ms. The rejection-safe
    // boundary wraps the call, it does not defer it.
    expect(Date.now() - started).toBeLessThan(400);
    for (const k of ['chain', 'block', 'fee', 'balance', 'readiness', 'identity']) {
      expect(calls[k]).toBe(1);
    }
  }, 20_000);

  /**
   * A CORRECTED TEST ORACLE.
   *
   * The previous version caught the rejection and asserted
   * `JSON.stringify(error).not.toContain('SECRET')`. But `JSON.stringify(new Error('x'))`
   * is `{}` -- Error's own properties are not enumerable -- so that assertion passed while
   * the function was still rejecting with the secret sitting in `error.message`. It proved
   * nothing at all, which is worse than having no test: it reported the boundary as closed.
   *
   * The oracle is `resolves`, plus `error.message`, `String(error)` and the stack read
   * directly.
   */
  it.each([
    ['throws on the first read', () => { throw new Error('SECRET_CLOCK_RAW'); }],
    ['NaN', () => NaN],
    ['Infinity', () => Infinity],
    ['negative', () => -1],
    ['moves backward', (() => { let t = 1_000_000; return () => (t -= 1000); })()],
  ])('a clock that %s fails closed and never rejects', async (_label, now) => {
    const started = Date.now();
    // `resolves`, not `.catch(Error)`. The old shape could not tell a rejection from a pass.
    const core = await buildCoreEvidence(coreDeps(), { budgetMs: 300, now: now as () => number });

    // Bounded real wall time, whatever the injected clock claims.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(core.ok).toBe(false);
    expect(core.problems).toContain('clock-unusable');
    // Timings from an unusable clock are not published as if they were real.
    expect(Number.isFinite(core.elapsedMs)).toBe(true);
    expect(core.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(core)).not.toContain('SECRET_CLOCK');
  });

  it('a clock that throws MID-request still resolves fail-closed', async () => {
    let reads = 0;
    let thrown: unknown;
    const core = await buildCoreEvidence(coreDeps(), {
      budgetMs: 300,
      now: () => {
        reads += 1;
        if (reads > 2) throw new Error('SECRET_CLOCK_MID');
        return Date.now();
      },
    }).catch((e) => {
      thrown = e;
      return null;
    });

    // Asserted on the real surfaces, not on JSON.stringify of an Error.
    expect(thrown).toBeUndefined();
    expect(core).not.toBeNull();
    expect(core!.ok).toBe(false);
    expect(core!.problems).toContain('clock-unusable');
    expect(JSON.stringify(core)).not.toContain('SECRET_CLOCK_MID');
  });

  it('a deterministic fake clock still works, so the test seam survives', async () => {
    let t = 1_700_000_000_000;
    const core = await buildCoreEvidence(coreDeps(), { budgetMs: 5000, now: () => (t += 10) });
    expect(core.problems).not.toContain('clock-unusable');
    expect(core.ok).toBe(true);
    expect(core.generatedAt.startsWith('2023-')).toBe(true);
  });

  it.each([
    ['not a bigint', 42 as unknown as bigint],
    ['a throwing object', { toString() { throw new Error('SECRET_CAP'); } } as unknown as bigint],
    ['null', null as unknown as bigint],
  ])('a cap that is %s fails closed rather than becoming zero', async (_label, capWei) => {
    const core = await buildCoreEvidence(coreDeps({ capWei }), { budgetMs: 300 });
    expect(core.ok).toBe(false);
    expect(core.problems).toContain('cap-unreadable');
    // Zero is the most PERMISSIVE reading of a field whose whole job is to refuse.
    expect(core.capWei).not.toBe('0');
    expect(JSON.stringify(core)).not.toContain('SECRET_CAP');
  });
});

describe('the producer enforces the factory predicate itself', () => {
  const withReadiness = (r: Record<string, unknown>) =>
    buildCoreEvidence(coreDeps({ getLaunchReadiness: async () => r as never }), { budgetMs: 400 });

  it('canLaunchOnChain FALSE fails the core', async () => {
    const core = await withReadiness({
      launchEnabled: true,
      whitelisted: false,
      canLaunch: true,
      canLaunchOnChain: false,
    });
    // The consumer already rejected this; the producer published HTTP 200 for it.
    expect(core.ok).toBe(false);
    expect(core.problems).toContain('readiness-refused');
    expect(statusCoreHttpCode(core.ok)).toBe(503);
  });

  it.each([
    ['missing', {}],
    ['null', { canLaunchOnChain: null }],
  ])('canLaunchOnChain %s is INCOMPLETE evidence, not a refusal', async (_l, extra) => {
    const core = await withReadiness({
      launchEnabled: true,
      whitelisted: false,
      canLaunch: true,
      ...extra,
    });
    expect(core.ok).toBe(false);
    // Semantics pinned once: missing is incomplete, false is the chain refusing.
    expect(core.problems).toContain('readiness-incomplete');
    expect(core.problems).not.toContain('readiness-refused');
  });

  it('ready with neither the public gate nor the whitelist is inconsistent', async () => {
    const core = await withReadiness({
      launchEnabled: false,
      whitelisted: false,
      canLaunch: true,
      canLaunchOnChain: true,
    });
    expect(core.ok).toBe(false);
    expect(core.problems).toContain('readiness-inconsistent');
  });

  it('accepts a launch permitted by the public gate', async () => {
    const core = await withReadiness({
      launchEnabled: true,
      whitelisted: false,
      canLaunch: true,
      canLaunchOnChain: true,
    });
    expect(core.problems).toEqual([]);
    expect(core.ok).toBe(true);
  });

  it('accepts a launch permitted by the whitelist alone', async () => {
    const core = await withReadiness({
      launchEnabled: false,
      whitelisted: true,
      canLaunch: true,
      canLaunchOnChain: true,
    });
    expect(core.problems).toEqual([]);
    expect(core.ok).toBe(true);
  });

  it('reads booleans as booleans, not as truthy values', async () => {
    const core = await withReadiness({
      launchEnabled: 1,
      whitelisted: 'yes',
      canLaunch: true,
      canLaunchOnChain: true,
    });
    // `1` and `'yes'` are truthy and would have become `true` under coercion.
    expect(core.ok).toBe(false);
    expect(core.problems).toContain('readiness-incomplete');
  });
});

/** The route's own rule, mirrored so the HTTP code is asserted rather than assumed. */
function statusCoreHttpCode(ok: boolean): number {
  return ok ? 200 : 503;
}

/**
 * REAL ROUTES, not helpers.
 *
 * The leaf tests above prove the producer resolves. These prove that what a client actually
 * receives over HTTP is a closed shape with no exception text in it -- which is where the
 * leak was.
 */
describe('the real routes publish a closed shape and no raw text', () => {
  const SECRET = 'SECRET_ROUTE_/var/secrets/db.sqlite';

  function poisonedPool(): StatusPool {
    const session: AcquiredSession = {
      provider: {} as never,
      endpoint: { origin: 'https://rpc.example.com', fingerprint: 'aaaaaaaaaaaa' } as never,
      index: 0,
    };
    return {
      acquire: async () => session,
      status: () => ({
        endpoints: [
          { identity: session.endpoint as never, admitted: true, probeMs: 1, checkedAt: null, ageMs: null },
        ],
        activeIndex: 0,
      }),
    };
  }

  /** Deps whose every chain function throws SYNCHRONOUSLY, carrying a secret. */
  function poisonedDeps(): StatusDeps {
    const boom = () => {
      throw new Error(SECRET);
    };
    return {
      expectedChainId: D.chainId,
      getChainId: boom as never,
      getBlockNumber: boom as never,
      getTreasuryBalanceWei: boom as never,
      getLiveFeeWei: boom as never,
      getLaunchReadiness: boom as never,
      getDeploymentIdentity: boom as never,
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
    };
  }

  /**
   * The REAL handlers, imported -- not a mirrored copy.
   *
   * The previous version of this test built its own express app with a sanitised copy of
   * the core catch. It passed while `index.ts` still published `detail:
   * String(err.message)`. A test standing next to the thing instead of on it can only
   * confirm what its author already believed.
   */
  async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
    const app = express();
    const routeDeps = { pool: poisonedPool(), makeDeps: poisonedDeps, options: { totalBudgetMs: 800 } };
    app.get('/status', statusHandler(routeDeps));
    app.get('/status/core', statusCoreHandler(routeDeps));

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      return await run(`http://127.0.0.1:${port}`);
    } finally {
      server.close();
    }
  }

  it('/status/core answers 503 with a closed body and no secret', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/status/core`);
      const body = await res.text();
      expect(res.status).toBe(503);
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain('/var/secrets');
      const parsed = JSON.parse(body);
      expect(parsed.schema).toBe('ponsr.status-core');
      expect(parsed.ok).toBe(false);
      for (const p of parsed.problems) expect(CORE_PROBLEMS).toContain(p);
    });
  }, 20_000);

  it('legacy /status answers without any exception text', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/status`);
      const body = await res.text();
      // This is where the leak was: `error: String(err.message)`.
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain('/var/secrets');
      expect(res.status).toBeGreaterThanOrEqual(200);
    });
  }, 20_000);

  it('a /status/core body from the real route validates as a closed document', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/status/core`);
      const body = await res.json();
      const r = validateCoreEvidence(body, {
        expectedChainId: D.chainId,
        expectedDeploymentId: D.id,
        expectedFactory: D.factory,
        expectedLaunchFeeWei: FEE,
        expectedCapWei: ETH / 100n,
        expectedTreasury: TREASURY,
        requiredTreasuryBalanceWei: FEE,
        expectedEndpointFingerprint: 'aaaaaaaaaaaa',
      });
      // It fails, correctly -- but through the closed vocabulary, not by throwing.
      expect(r.pass).toBe(false);
      expect(() => JSON.stringify(r)).not.toThrow();
      expect(JSON.stringify(r)).not.toContain(SECRET);
    });
  }, 20_000);
});

describe('the timestamp and origin contracts say what they do', () => {
  it('accepts only canonical ISO UTC', () => {
    const iso = new Date(1_700_000_000_000).toISOString();
    expect(parseTimestamp(iso)).toBe(1_700_000_000_000);
  });

  it.each([
    ['RFC 1123', new Date(1_700_000_000_000).toUTCString()],
    ['a bare date', '2026-08-26'],
    ['no milliseconds', '2026-08-26T03:00:00Z'],
    ['an offset instead of Z', '2026-08-26T03:00:00.000+00:00'],
    ['not a date', 'not-a-date'],
  ])('refuses %s', (_l, raw) => {
    // Date.parse accepts several of these. The contract says ISO, so a parser that quietly
    // takes four other spellings makes the contract false.
    expect(parseTimestamp(raw)).toBeNull();
  });

  it('requires an origin whenever a fingerprint is claimed', async () => {
    const core = await buildCoreEvidence(coreDeps(), { budgetMs: 400 });
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
    expect(validateCoreEvidence(core, opts).pass).toBe(true);
    // The schema narrative says an admitted endpoint carries both; accepting one without
    // the other would let the contract and the implementation disagree.
    const r = validateCoreEvidence({ ...core, endpointOrigin: null }, opts);
    expect(r.pass).toBe(false);
    expect(r.failures).toContain('endpoint-missing');
  });

  it('still rejects an origin carrying a path, query or userinfo', async () => {
    const core = await buildCoreEvidence(coreDeps(), { budgetMs: 400 });
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
    for (const bad of [
      'https://rpc.example.com/v2/KEY',
      'https://rpc.example.com/?k=1',
      'https://user:pass@rpc.example.com',
    ]) {
      expect(validateCoreEvidence({ ...core, endpointOrigin: bad }, opts).failures).toContain(
        'malformed-field'
      );
    }
  });
});
