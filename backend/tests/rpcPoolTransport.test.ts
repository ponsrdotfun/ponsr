import { RpcPool } from '../src/rpcPool';
import { executableDeployment } from '../src/deployments';
import {
  startFakeChain,
  FakeChain,
  MATCHING_CODE,
  MATCHING_SHA256,
  FORKED_CODE,
} from './fixtures/jsonRpcServer';

/**
 * The pool, tested through a REAL JsonRpcProvider against a REAL local JSON-RPC server.
 *
 * The previous suite used a hand-made provider object, and every wrong-chain assertion in
 * it passed while the gate did nothing at all. `new JsonRpcProvider(url, chainId,
 * { staticNetwork: true })` answers `getNetwork()` from the configured value without
 * sending a request, so the admission check compared 4663 to 4663 and admitted a testnet
 * endpoint serving matching bytecode. Measured: zero methods reached the transport.
 *
 * So every test here asserts on `chain.methods` -- what the endpoint was ACTUALLY asked --
 * as well as on the outcome. An admission gate that reaches the right verdict without
 * asking the question is not a gate.
 */

const D = { ...executableDeployment(), runtimeBytecodeSha256: MATCHING_SHA256 };
const open: FakeChain[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function chain(opts: Parameters<typeof startFakeChain>[0] = {}): Promise<FakeChain> {
  const c = await startFakeChain(opts);
  open.push(c);
  return c;
}

function pool(urls: string[], extra: Record<string, unknown> = {}) {
  return new RpcPool(urls, { deployment: D, admissionTimeoutMs: 1500, ...extra });
}

describe('admission actually asks the endpoint what chain it is', () => {
  it('sends eth_chainId to the transport', async () => {
    const c = await chain();
    await pool([c.url]).run(async () => 'ok');
    // The assertion the old suite could not make, and the one that catches staticNetwork
    // answering from configuration.
    expect(c.methods).toContain('eth_chainId');
  });

  it('REFUSES a testnet endpoint that serves matching bytecode', async () => {
    // The exact PoC from the audit: right bytecode, wrong chain. Previously ADMITTED.
    const c = await chain({ chainId: 46630, code: MATCHING_CODE });
    let ran = false;
    await expect(
      pool([c.url]).run(async () => {
        ran = true;
        return 'used it';
      })
    ).rejects.toThrow();
    // Refused BEFORE the operation callback, not after it did something.
    expect(ran).toBe(false);
    expect(c.methods).toContain('eth_chainId');
  });

  it('REFUSES an endpoint on the right chain serving forked bytecode', async () => {
    const c = await chain({ chainId: D.chainId, code: FORKED_CODE });
    let ran = false;
    await expect(pool([c.url]).run(async () => { ran = true; return 'x'; })).rejects.toThrow();
    expect(ran).toBe(false);
  });

  it('REFUSES an endpoint with no contract at the factory address', async () => {
    const c = await chain({ chainId: D.chainId, code: '0x' });
    await expect(pool([c.url]).run(async () => 'x')).rejects.toThrow();
  });

  it.each([
    ['non-hex', 'not-a-chain-id'],
    ['empty string', ''],
    ['null', null],
    ['a number rather than a hex quantity', 4663],
    ['overflowing 2^53', '0x' + (2n ** 64n).toString(16)],
    ['negative', '-0x1'],
  ])('fails closed on a malformed chain id: %s', async (_label, raw) => {
    const c = await chain({ rawChainId: raw, code: MATCHING_CODE });
    let ran = false;
    await expect(pool([c.url]).run(async () => { ran = true; return 'x'; })).rejects.toThrow();
    expect(ran).toBe(false);
  });

  it('fails closed when eth_chainId returns an RPC error', async () => {
    const c = await chain({ errors: { eth_chainId: { code: -32000, message: 'unsupported' } } });
    await expect(pool([c.url]).run(async () => 'x')).rejects.toThrow();
  });

  it('fails closed when eth_getCode returns an RPC error', async () => {
    const c = await chain({ errors: { eth_getCode: { code: -32000, message: 'unsupported' } } });
    await expect(pool([c.url]).run(async () => 'x')).rejects.toThrow();
  });
});

/**
 * Secrets, from every direction an error can arrive.
 *
 * ethers puts the request URL into its own error text, so copying a provider message into
 * `refusedBecause` publishes the API key that was in the path. Every field the pool exposes
 * is concatenated and checked, not just the one the author happened to think of.
 */
describe('no RPC URL or credential ever reaches a published field', () => {
  const SECRET = 'SECRETKEY123456789abcdef';

  /** Everything a caller or an operator can see, as one string. */
  function published(p: RpcPool, thrown: unknown): string {
    return JSON.stringify(p.status()) + String((thrown as any)?.message ?? thrown) + String(thrown);
  }

  async function leakCheck(p: RpcPool): Promise<string> {
    let thrown: unknown;
    try {
      await p.run(async () => 'x');
    } catch (err) {
      thrown = err;
    }
    return published(p, thrown);
  }

  it('does not leak when the provider constructor throws with the URL in it', async () => {
    const url = `https://rpc.example.com/v2/${SECRET}`;
    const p = new RpcPool([url], {
      deployment: D,
      makeProvider: () => {
        throw new Error(`cannot construct provider for ${url}`);
      },
    });
    const out = await leakCheck(p);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(SECRET.slice(0, 8));
  });

  it('does not leak when the admission read rejects with the URL in it', async () => {
    const url = `https://rpc.example.com/v2/${SECRET}`;
    const p = new RpcPool([url], {
      deployment: D,
      makeProvider: () =>
        ({
          send: async () => {
            throw new Error(`request failed for ${url}`);
          },
          getCode: async () => MATCHING_CODE,
          getNetwork: async () => ({ chainId: BigInt(D.chainId) }),
          destroy() {},
        }) as any,
    });
    const out = await leakCheck(p);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(SECRET.slice(0, 8));
  });

  it('does not leak from a nested cause, shortMessage, or request body', async () => {
    const url = `https://rpc.example.com/v2/${SECRET}`;
    const p = new RpcPool([url], {
      deployment: D,
      makeProvider: () =>
        ({
          send: async () => {
            const e: any = new Error('server error');
            e.shortMessage = `failed for ${url}`;
            e.cause = new Error(`socket to ${url}`);
            e.request = { url };
            e.body = `POST ${url}`;
            throw e;
          },
          getCode: async () => MATCHING_CODE,
          getNetwork: async () => ({ chainId: BigInt(D.chainId) }),
          destroy() {},
        }) as any,
    });
    const out = await leakCheck(p);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(SECRET.slice(0, 8));
  });

  it('does not leak when the OPERATION callback rejects with the URL in it', async () => {
    const c = await chain();
    const p = pool([c.url]);
    let thrown: unknown;
    try {
      await p.run(async () => {
        throw new Error(`request failed for https://rpc.example.com/v2/${SECRET}`);
      });
    } catch (err) {
      thrown = err;
    }
    const out = published(p, thrown);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(SECRET.slice(0, 8));
  });

  it('still says something useful about WHY, from a bounded set of categories', async () => {
    const c = await chain({ chainId: 46630 });
    const p = pool([c.url]);
    await expect(p.run(async () => 'x')).rejects.toThrow();
    const why = p.status().endpoints[0].refusedBecause ?? '';
    // A category, and the observed chain -- which is public and is the whole point of the
    // refusal -- but nothing copied verbatim out of a provider.
    expect(why).toMatch(/chain/i);
    expect(why).toContain('46630');
  });
});

/**
 * The most common real RPC failure is a stall, not a rejection. A fallback that only
 * engages on rejection does not engage at all on the failure it was bought for.
 */
describe('a hung endpoint fails over, bounded', () => {
  it('moves to the fallback when the primary operation never resolves', async () => {
    const a = await chain();
    const b = await chain();
    const p = pool([a.url, b.url], { operationTimeoutMs: 200 });

    // Which endpoint is which is decided by attempt order, not by inspecting the
    // provider: reaching into ethers internals to identify a connection would couple the
    // test to a private shape and tell us nothing about the pool.
    let attempt = 0;
    const value = await p.run(async () => {
      attempt += 1;
      if (attempt === 1) await new Promise(() => {});
      return 'from the fallback';
    });

    expect(value).toBe('from the fallback');
    expect(p.status().activeIndex).toBe(1);
  }, 20_000);

  it('refuses in bounded time when every endpoint hangs', async () => {
    const a = await chain();
    const b = await chain();
    const p = pool([a.url, b.url], { operationTimeoutMs: 150 });

    const started = Date.now();
    await expect(p.run(async () => new Promise(() => {}))).rejects.toThrow();
    // Two endpoints x 150ms, plus admission. Generous, but far below "forever".
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);

  it('a late primary resolution does not overwrite the fallback result or active endpoint', async () => {
    const a = await chain();
    const b = await chain();
    const p = pool([a.url, b.url], { operationTimeoutMs: 120 });

    let call = 0;
    const value = await p.run(async () => {
      call += 1;
      if (call === 1) {
        await new Promise((r) => setTimeout(r, 600));
        return 'the late primary';
      }
      return 'the fallback';
    });

    expect(value).toBe('the fallback');
    expect(p.status().activeIndex).toBe(1);
    await new Promise((r) => setTimeout(r, 800));
    // The abandoned operation resolved in the background by now; it must not have
    // reassigned `active` behind the caller's back.
    expect(p.status().activeIndex).toBe(1);
  }, 20_000);

  it('a rejecting primary still fails over', async () => {
    const a = await chain();
    const b = await chain();
    const p = pool([a.url, b.url], { operationTimeoutMs: 500 });
    let call = 0;
    const value = await p.run(async () => {
      call += 1;
      if (call === 1) throw new Error('upstream 503');
      return 'the fallback';
    });
    expect(value).toBe('the fallback');
  }, 20_000);

  it('the operation-timeout message names the origin but never the path', async () => {
    const c = await chain();
    // A secret in the path, on an endpoint that will time out: the timeout message is a
    // place a URL is very likely to be pasted for debugging.
    const p = pool([`${c.url}/v2/SECRETKEY123456789`], { operationTimeoutMs: 100 });
    let thrown: unknown;
    try {
      await p.run(async () => new Promise(() => {}));
    } catch (err) {
      thrown = err;
    }
    const out = String((thrown as any)?.message) + JSON.stringify(p.status());

    expect(out).not.toContain('SECRETKEY123456789');
    expect(out).not.toContain('/v2/');
    // The origin IS published, deliberately: it is what an operator needs in order to say
    // "that is not the endpoint I tested", and anyone watching egress already sees it.
    // Forbidding it would be forbidding the feature rather than the leak.
    expect(out).toContain('127.0.0.1');
    expect(out).toContain('did not answer within 100ms');
  }, 20_000);
});

/**
 * A successful admission was remembered for the lifetime of the process, so an endpoint
 * that later forked or fell behind kept being used without ever being re-checked.
 */
describe('an admission PASS expires', () => {
  it('re-admits after the TTL and notices the endpoint changed underneath it', async () => {
    const c = await chain();
    const p = pool([c.url], { admissionTtlMs: 100 });

    await p.run(async () => 'ok');
    expect(p.status().endpoints[0].admitted).toBe(true);

    // The endpoint forks. Nothing about the pool has changed; the world has.
    c.options.code = FORKED_CODE;
    await new Promise((r) => setTimeout(r, 150));

    await expect(p.run(async () => 'still using it')).rejects.toThrow();
    expect(p.status().endpoints[0].admitted).toBe(false);
  }, 20_000);

  it('publishes the age of an admission, so a remembered pass is visible as one', async () => {
    const c = await chain();
    const p = pool([c.url], { admissionTtlMs: 60_000 });
    await p.run(async () => 'ok');

    const s = p.status().endpoints[0];
    expect(s.admitted).toBe(true);
    expect(typeof s.ageMs).toBe('number');
    expect(s.checkedAt).toBeTruthy();
  });

  it('does not re-probe within the TTL', async () => {
    const c = await chain();
    const p = pool([c.url], { admissionTtlMs: 60_000 });
    await p.run(async () => 'ok');
    const after = c.methods.filter((m) => m === 'eth_chainId').length;
    await p.run(async () => 'ok');
    await p.run(async () => 'ok');
    expect(c.methods.filter((m) => m === 'eth_chainId').length).toBe(after);
  });

  it('collapses concurrent admissions of the same endpoint into one probe', async () => {
    const c = await chain({ delays: { eth_chainId: 60, eth_getCode: 60 } });
    const p = pool([c.url]);
    await Promise.all([p.run(async () => 1), p.run(async () => 2), p.run(async () => 3)]);
    expect(c.methods.filter((m) => m === 'eth_getCode').length).toBe(1);
  }, 20_000);
});
