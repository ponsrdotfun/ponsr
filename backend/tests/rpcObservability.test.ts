import { ethers } from 'ethers';
import { describeRpcEndpoint, fingerprintUrl, isIdentified, summariseRpcEndpoint } from '../src/rpcIdentity';
import { IdentityWatch, summariseIdentity } from '../src/identityWatch';
import { RpcPool, parseEndpointList } from '../src/rpcPool';
import { executableDeployment } from '../src/deployments';

const D = executableDeployment();

describe('RPC endpoint identity', () => {
  it('publishes where traffic goes without publishing the URL', () => {
    const d = describeRpcEndpoint('https://rpc.mainnet.chain.robinhood.com');
    expect(isIdentified(d)).toBe(true);
    if (!isIdentified(d)) return;
    expect(d.origin).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(d.host).toBe('rpc.mainnet.chain.robinhood.com');
    expect(d.credentialed).toBe(false);
  });

  it('never leaks the key out of a credentialed URL, in any field', () => {
    const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const d = describeRpcEndpoint(`https://eth-mainnet.example.com/v2/${secret}?apikey=${secret}`);
    expect(isIdentified(d)).toBe(true);
    if (!isIdentified(d)) return;

    // The whole point. Every published field, concatenated, must not contain the secret --
    // including a partially redacted form, which would still reveal the provider and the
    // shape of the key.
    const published = JSON.stringify(d) + summariseRpcEndpoint(d);
    expect(published).not.toContain(secret);
    expect(published).not.toContain(secret.slice(0, 8));
    expect(d.credentialed).toBe(true);
  });

  it('flags a key in the path even when there is no query string', () => {
    const d = describeRpcEndpoint('https://rpc.example.com/v3/9f2c1d4e8a7b6c5d4e3f2a1b');
    expect(isIdentified(d) && d.credentialed).toBe(true);
  });

  it('does not flag an ordinary route as a credential', () => {
    const d = describeRpcEndpoint('https://rpc.example.com/v1/mainnet');
    expect(isIdentified(d) && d.credentialed).toBe(false);
  });

  it('fingerprints let two endpoints be compared without either being revealed', () => {
    const a = 'https://rpc.mainnet.chain.robinhood.com';
    expect(fingerprintUrl(a)).toBe(fingerprintUrl(a));
    expect(fingerprintUrl(a)).not.toBe(fingerprintUrl(a + '/'));
    expect(fingerprintUrl(a)).toHaveLength(12);
  });

  it('reports an unparseable URL as unparseable rather than inventing an identity', () => {
    const d = describeRpcEndpoint('not a url');
    expect(isIdentified(d)).toBe(false);
    // Still fingerprinted, so two backends can be compared even when both are misconfigured.
    expect(d.fingerprint).toHaveLength(12);
    expect(JSON.stringify(d)).not.toContain('not a url');
  });

  it('says when an endpoint is loopback, which no other machine can reach', () => {
    const d = describeRpcEndpoint('http://localhost:8545');
    expect(isIdentified(d) && d.loopback).toBe(true);
    expect(isIdentified(d) && d.port).toBe(8545);
  });
});

describe('endpoint list parsing', () => {
  it('ignores empty entries from trailing commas and stray spaces', () => {
    expect(parseEndpointList('https://a.example', ' https://b.example , , https://c.example ')).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
  });

  it('de-duplicates, so a pool cannot look more redundant than it is', () => {
    expect(parseEndpointList('https://a.example', 'https://a.example')).toEqual(['https://a.example']);
  });

  it('survives an absent fallback setting', () => {
    expect(parseEndpointList('https://a.example', undefined)).toEqual(['https://a.example']);
    expect(parseEndpointList('https://a.example', '')).toEqual(['https://a.example']);
  });
});

/** A provider whose chain id and factory bytecode are dictated by the test. */
function fakeProvider(chainId: number, code: string): any {
  return {
    getNetwork: async () => ({ chainId: BigInt(chainId) }),
    getCode: async () => code,
    marker: `${chainId}:${code.slice(0, 10)}`,
  };
}

const REAL_CODE = '0x' + '60'.repeat(D.runtimeBytecodeLength);
const REAL_HASH = ethers.sha256(REAL_CODE).slice(2);

/** A pool whose deployment expects exactly the bytecode the fake serves. */
function poolWith(urls: string[], providers: Record<string, any>) {
  return new RpcPool(urls, {
    deployment: { ...D, runtimeBytecodeSha256: REAL_HASH },
    makeProvider: (url) => providers[url],
  });
}

describe('bounded fallback with consistency admission', () => {
  it('uses the primary when it is consistent, and never probes the fallback', async () => {
    const fallback = fakeProvider(D.chainId, REAL_CODE);
    const pool = poolWith(['https://a.example', 'https://b.example'], {
      'https://a.example': fakeProvider(D.chainId, REAL_CODE),
      'https://b.example': fallback,
    });

    const seen = await pool.run(async (p: any) => p.marker);
    expect(seen).toBe(`${D.chainId}:${REAL_CODE.slice(0, 10)}`);
    expect(pool.status().activeIndex).toBe(0);
    // Not probed at all: admission is lazy, so a healthy primary costs nothing extra.
    expect(pool.status().endpoints[1].refusedBecause).toBe('not probed yet');
  });

  it('REFUSES a fallback on the wrong chain instead of quietly using it', async () => {
    // The likeliest misconfiguration by far: backend/.env already holds a testnet URL, and
    // on testnet this factory address holds no contract and the treasury has no funds.
    const pool = poolWith(['https://bad.example'], {
      'https://bad.example': fakeProvider(46630, REAL_CODE),
    });

    await expect(pool.run(async () => 'used it')).rejects.toThrow(/chain id is 46630/);
    expect(pool.status().endpoints[0].admitted).toBe(false);
    expect(pool.status().activeIndex).toBeNull();
  });

  it('REFUSES an endpoint serving different bytecode at the factory address', async () => {
    // A fork, or an archive node lagging behind a redeployment. Right chain, wrong state.
    const pool = poolWith(['https://fork.example'], {
      'https://fork.example': fakeProvider(D.chainId, '0x' + 'ab'.repeat(D.runtimeBytecodeLength)),
    });

    await expect(pool.run(async () => 'used it')).rejects.toThrow(/runtime bytecode hashes to/);
    expect(pool.status().endpoints[0].admitted).toBe(false);
  });

  it('REFUSES an endpoint with no contract at the factory address', async () => {
    const pool = poolWith(['https://empty.example'], {
      'https://empty.example': fakeProvider(D.chainId, '0x'),
    });
    await expect(pool.run(async () => 'used it')).rejects.toThrow(/no contract at/);
  });

  it('falls over to a consistent fallback when the primary call fails', async () => {
    const good = fakeProvider(D.chainId, REAL_CODE);
    good.marker = 'the fallback';
    const bad = fakeProvider(D.chainId, REAL_CODE);

    const pool = poolWith(['https://a.example', 'https://b.example'], {
      'https://a.example': bad,
      'https://b.example': good,
    });

    let attempt = 0;
    const value = await pool.run(async (p: any) => {
      attempt += 1;
      if (p === bad) throw new Error('upstream 503');
      return p.marker;
    });

    expect(value).toBe('the fallback');
    expect(attempt).toBe(2);
    expect(pool.status().activeIndex).toBe(1);
  });

  it('sticks to the endpoint that worked, rather than re-paying for the broken one', async () => {
    const bad = fakeProvider(D.chainId, REAL_CODE);
    const good = fakeProvider(D.chainId, REAL_CODE);
    const pool = poolWith(['https://a.example', 'https://b.example'], {
      'https://a.example': bad,
      'https://b.example': good,
    });

    const tried: any[] = [];
    const op = async (p: any) => {
      tried.push(p);
      if (p === bad) throw new Error('upstream 503');
      return 'ok';
    };
    await pool.run(op);
    tried.length = 0;
    await pool.run(op);

    // Second call goes straight to the survivor: one attempt, not two.
    expect(tried).toEqual([good]);
  });

  it('is BOUNDED: each endpoint is tried at most once and then it gives up', async () => {
    const a = fakeProvider(D.chainId, REAL_CODE);
    const b = fakeProvider(D.chainId, REAL_CODE);
    const pool = poolWith(['https://a.example', 'https://b.example'], {
      'https://a.example': a,
      'https://b.example': b,
    });

    let attempts = 0;
    await expect(
      pool.run(async () => {
        attempts += 1;
        throw new Error('upstream 503');
      })
    ).rejects.toThrow(/no RPC endpoint could serve the request/);

    // Two endpoints, two attempts. A caller with a deadline gets a refusal inside it
    // instead of a retry loop spending the whole budget failing repeatedly.
    expect(attempts).toBe(2);
  });

  it('does not put a URL into the error it throws', async () => {
    const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const url = `https://rpc.example.com/v2/${secret}`;
    const pool = poolWith([url], { [url]: fakeProvider(46630, REAL_CODE) });

    // The failure path is exactly where a URL tends to get logged for debugging.
    await expect(pool.run(async () => 'x')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) })
    );
  });

  it('remembers a wrong chain but not an outage', async () => {
    let reachable = false;
    const flaky: any = {
      getNetwork: async () => {
        if (!reachable) throw new Error('ECONNREFUSED');
        return { chainId: BigInt(D.chainId) };
      },
      getCode: async () => REAL_CODE,
      marker: 'recovered',
    };
    const pool = poolWith(['https://flaky.example'], { 'https://flaky.example': flaky });

    await expect(pool.run(async () => 'x')).rejects.toThrow(/could not be probed/);
    reachable = true;
    // An endpoint that was down at boot has to be able to come back without a restart --
    // unlike a wrong chain, which is a permanent property and stays refused.
    await expect(pool.run(async (p: any) => p.marker)).resolves.toBe('recovered');
  });
});

/**
 * A real JsonRpcProvider whose transport is the test.
 *
 * A hand-rolled `{ getCode, getNetwork }` object is not enough here:
 * `verifyDeploymentIdentity` also calls `feeEscrow()` through an `ethers.Contract`, which
 * needs a working provider underneath. A fake that cannot answer it makes the identity
 * check report `fee escrow: unreadable` -- a MISMATCH -- and mismatches are deliberately
 * never cached, so every caching assertion would fail for a reason unrelated to caching.
 */
class FakeChain extends ethers.JsonRpcProvider {
  getCodeCalls = 0;
  reachable = true;
  code = REAL_CODE;
  private delayMs = 0;
  constructor(delayMs = 0) {
    super('http://127.0.0.1:1/never-dialled', D.chainId, { staticNetwork: true });
    this.delayMs = delayMs;
  }
  /**
   * Counted HERE rather than in the transport, and that is not a shortcut.
   *
   * ethers keeps its own short-lived cache for `eth_getCode` -- measured in this build,
   * three `getCode` calls reach the transport once -- and this build exposes no
   * `cacheTimeout` to switch it off. Counting at the transport would therefore have tested
   * ethers' cache while claiming to test IdentityWatch's. This counts the question
   * IdentityWatch actually asks.
   */
  async getCode(address: string): Promise<string> {
    this.getCodeCalls += 1;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (!this.reachable) throw new Error('ECONNRESET');
    return this.code;
  }

  async _send(payload: any): Promise<any> {
    const batch = Array.isArray(payload) ? payload : [payload];
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return batch.map((p: any) => {
      if (p.method === 'eth_chainId') {
        return { id: p.id, jsonrpc: '2.0', result: '0x' + D.chainId.toString(16) };
      }
      // feeEscrow(), the only contract read the identity check makes.
      return {
        id: p.id,
        jsonrpc: '2.0',
        result: ethers.AbiCoder.defaultAbiCoder().encode(['address'], [D.feeEscrow]),
      };
    });
  }
}

/** The registry entry this fake chain genuinely satisfies. */
const MATCHING = { ...D, runtimeBytecodeSha256: REAL_HASH };

describe('deployment identity, on its own budget', () => {
  it('does not re-download 48 KB of bytecode on every status request', async () => {
    const clock = { t: 0 };
    const watch = new IdentityWatch(MATCHING, 1000, () => new Date(clock.t));
    const chain = new FakeChain();

    const first = await watch.check(chain);
    expect(first.result!.ok).toBe(true);
    await watch.check(chain);
    await watch.check(chain);
    expect(chain.getCodeCalls).toBe(1);

    clock.t = 2000;
    await watch.check(chain);
    expect(chain.getCodeCalls).toBe(2);
    chain.destroy();
  });

  it('collapses concurrent checks into one download', async () => {
    const clock = { t: 0 };
    const watch = new IdentityWatch(MATCHING, 1000, () => new Date(clock.t));
    const chain = new FakeChain(5);

    // Otherwise the cache removes the cost for one caller and multiplies it for ten.
    await Promise.all([watch.check(chain), watch.check(chain), watch.check(chain)]);
    expect(chain.getCodeCalls).toBe(1);
    chain.destroy();
  });

  it('never caches a MISMATCH, so a fixed deployment is noticed immediately', async () => {
    const clock = { t: 0 };
    const watch = new IdentityWatch({ ...D, runtimeBytecodeSha256: 'deadbeef' }, 1000, () => new Date(clock.t));
    const chain = new FakeChain();

    const first = await watch.check(chain);
    const second = await watch.check(chain);
    expect(first.result!.ok).toBe(false);
    expect(second.result!.ok).toBe(false);
    // Re-read, not remembered. A held mismatch would keep being reported after a fix, and
    // would mean a real drift was measured once and thereafter only repeated.
    expect(chain.getCodeCalls).toBe(2);
    expect(second.fromCache).toBe(false);
    chain.destroy();
  });

  it('publishes the age, so a cached pass is not mistaken for a fresh one', async () => {
    const clock = { t: 0 };
    const watch = new IdentityWatch(MATCHING, 60_000, () => new Date(clock.t));
    const chain = new FakeChain();

    const fresh = await watch.check(chain);
    expect(fresh.fromCache).toBe(false);
    expect(summariseIdentity(fresh)).toContain('measured just now');

    clock.t = 30_000;
    const cached = await watch.check(chain);
    expect(cached.fromCache).toBe(true);
    expect(cached.ageMs).toBe(30_000);
    expect(summariseIdentity(cached)).toContain('cached, measured 30s ago');
    chain.destroy();
  });

  it('treats an unreadable chain as unreadable, not as a mismatch', async () => {
    const clock = { t: 0 };
    const watch = new IdentityWatch(MATCHING, 1000, () => new Date(clock.t));
    const chain = new FakeChain();

    const good = await watch.check(chain);
    expect(good.result!.ok).toBe(true);

    chain.reachable = false;
    clock.t = 5000;
    const stale = await watch.check(chain);

    // The previous verdict stands, with its true age, and the failure is reported
    // separately. Reporting it as drift sends an operator hunting an upgrade that never
    // happened -- the exact false alarm this project has already paid for once.
    expect(stale.result!.ok).toBe(true);
    expect(stale.unreadable).toBeDefined();
    expect(stale.ageMs).toBe(5000);
    expect(summariseIdentity(stale)).toContain('latest attempt failed');
    chain.destroy();
  });

  it('says "not verified yet" rather than passing before anything was measured', () => {
    expect(summariseIdentity({ result: null, checkedAt: null, ageMs: null, fromCache: false })).toBe(
      'not verified yet'
    );
  });
});
