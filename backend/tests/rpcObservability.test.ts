import { ethers } from 'ethers';
import { describeRpcEndpoint, fingerprintUrl, isIdentified, summariseRpcEndpoint } from '../src/rpcIdentity';
import { IdentityWatch, summariseIdentity } from '../src/identityWatch';
import { parseEndpointList } from '../src/rpcPool';
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

  it('recognises IPv6 loopback, brackets and all', () => {
    // new URL(...).hostname is `[::1]` WITH the brackets, so a plain `::1` comparison
    // silently never matches and an unreachable endpoint reports as reachable.
    expect(isIdentified(describeRpcEndpoint('http://[::1]:8545')) &&
      (describeRpcEndpoint('http://[::1]:8545') as any).loopback).toBe(true);
  });

  it('recognises the whole 127.0.0.0/8 block, not just 127.0.0.1', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '127.1.2.3']) {
      const d = describeRpcEndpoint(`http://${host}:8545`);
      expect(isIdentified(d) && d.loopback).toBe(true);
    }
    // And does not over-claim: 128.x is a perfectly ordinary public address.
    const public_ = describeRpcEndpoint('http://128.0.0.1:8545');
    expect(isIdentified(public_) && public_.loopback).toBe(false);
  });

  it('flags userinfo credentials and never echoes them', () => {
    const d = describeRpcEndpoint('https://alice:hunter2@rpc.example.com/v1/mainnet');
    expect(isIdentified(d)).toBe(true);
    if (!isIdentified(d)) return;
    expect(d.credentialed).toBe(true);
    const published = JSON.stringify(d) + summariseRpcEndpoint(d);
    expect(published).not.toContain('hunter2');
    expect(published).not.toContain('alice');
    // The origin must be the bare host, not `alice:hunter2@rpc.example.com`.
    expect(d.origin).toBe('https://rpc.example.com');
  });

  it('reports no port when the URL relies on the scheme default', () => {
    const d = describeRpcEndpoint('https://rpc.example.com');
    expect(isIdentified(d) && d.port).toBeNull();
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

/**
 * The pool's admission tests USED to live here, against a hand-made provider object whose
 * `getNetwork()` returned whatever the test asked for. Every one of them passed while the
 * gate did nothing at all: with `staticNetwork: true`, `getNetwork()` answers from the
 * configured value and sends no request, so the check compared 4663 to 4663 and admitted a
 * testnet endpoint. Measured: zero methods reached the transport.
 *
 * They were deleted rather than repaired. Adding a `send` stub to the fake would have made
 * them pass again and restored exactly the false comfort that hid the defect -- a mock
 * placed above the layer under test can only report the author's expectations back.
 *
 * The same properties, and considerably more, are now asserted in
 * tests/rpcPoolTransport.test.ts against a real JsonRpcProvider talking to a real local
 * JSON-RPC server, with assertions on the methods that server was actually asked for.
 */

const MATCHING_CODE = '0x' + '60'.repeat(D.runtimeBytecodeLength);
const REAL_CODE = MATCHING_CODE;
const REAL_HASH = ethers.sha256(REAL_CODE).slice(2);

/** Two distinct endpoint fingerprints, so cache binding can be exercised. */
const FP_A = 'aaaaaaaaaaaa';
const FP_B = 'bbbbbbbbbbbb';

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

    const first = await watch.check(chain, FP_A);
    expect(first.result!.ok).toBe(true);
    await watch.check(chain, FP_A);
    await watch.check(chain, FP_A);
    expect(chain.getCodeCalls).toBe(1);

    clock.t = 2000;
    await watch.check(chain, FP_A);
    expect(chain.getCodeCalls).toBe(2);
    chain.destroy();
  });

  it('collapses concurrent checks into one download', async () => {
    const clock = { t: 0 };
    const watch = new IdentityWatch(MATCHING, 1000, () => new Date(clock.t));
    const chain = new FakeChain(5);

    // Otherwise the cache removes the cost for one caller and multiplies it for ten.
    await Promise.all([watch.check(chain, FP_A), watch.check(chain, FP_A), watch.check(chain, FP_A)]);
    expect(chain.getCodeCalls).toBe(1);
    chain.destroy();
  });

  it('never caches a MISMATCH, so a fixed deployment is noticed immediately', async () => {
    const clock = { t: 0 };
    const watch = new IdentityWatch({ ...D, runtimeBytecodeSha256: 'deadbeef' }, 1000, () => new Date(clock.t));
    const chain = new FakeChain();

    const first = await watch.check(chain, FP_A);
    const second = await watch.check(chain, FP_A);
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

    const fresh = await watch.check(chain, FP_A);
    expect(fresh.fromCache).toBe(false);
    expect(summariseIdentity(fresh)).toContain('measured just now');

    clock.t = 30_000;
    const cached = await watch.check(chain, FP_A);
    expect(cached.fromCache).toBe(true);
    expect(cached.ageMs).toBe(30_000);
    expect(summariseIdentity(cached)).toContain('cached, measured 30s ago');
    chain.destroy();
  });

  it('treats an unreadable chain as unreadable, not as a mismatch', async () => {
    const clock = { t: 0 };
    const watch = new IdentityWatch(MATCHING, 1000, () => new Date(clock.t));
    const chain = new FakeChain();

    const good = await watch.check(chain, FP_A);
    expect(good.result!.ok).toBe(true);

    chain.reachable = false;
    clock.t = 5000;
    const stale = await watch.check(chain, FP_A);

    // The previous verdict stands, with its true age, and the failure is reported
    // separately. Reporting it as drift sends an operator hunting an upgrade that never
    // happened -- the exact false alarm this project has already paid for once.
    expect(stale.result!.ok).toBe(true);
    expect(stale.unreadable).toBeDefined();
    expect(stale.ageMs).toBe(5000);
    expect(summariseIdentity(stale)).toContain('latest attempt failed');
    chain.destroy();
  });

  it('does NOT reuse a pass measured through a different endpoint', async () => {
    const clock = { t: 0 };
    const watch = new IdentityWatch(MATCHING, 60_000, () => new Date(clock.t));
    const chain = new FakeChain();

    await watch.check(chain, FP_A);
    expect(chain.getCodeCalls).toBe(1);

    // Well inside the TTL, but a different node is answering now. The read pool can fail
    // over between two status requests, so an unbound cache would let the page say
    // "matches the registry" about an endpoint it had never asked.
    clock.t = 1000;
    const viaB = await watch.check(chain, FP_B);
    expect(viaB.fromCache).toBe(false);
    expect(chain.getCodeCalls).toBe(2);
    expect(viaB.measuredThrough).toContain(FP_B);
  });

  it('does NOT reuse a pass measured against a different deployment', async () => {
    const clock = { t: 0 };
    const chain = new FakeChain();
    const watch = new IdentityWatch(MATCHING, 60_000, () => new Date(clock.t));
    await watch.check(chain, FP_A);

    // A separate watch over a different expected runtime must not be able to inherit the
    // first one's answer -- the key carries chain, deployment, factory and runtime hash.
    const other = new IdentityWatch({ ...MATCHING, id: 'pons-v2-superseded' }, 60_000, () => new Date(clock.t));
    const chain2 = new FakeChain();
    const r = await other.check(chain2, FP_A);
    expect(r.fromCache).toBe(false);
    expect(chain2.getCodeCalls).toBe(1);
  });

  it('does not merge concurrent checks that are asking different questions', async () => {
    const clock = { t: 0 };
    const watch = new IdentityWatch(MATCHING, 60_000, () => new Date(clock.t));
    const chain = new FakeChain(5);

    // In-flight sharing is an optimisation for identical questions only. Sharing across
    // endpoints would reintroduce the same defect through the concurrency path.
    await Promise.all([watch.check(chain, FP_A), watch.check(chain, FP_B)]);
    expect(chain.getCodeCalls).toBe(2);
  });

  it('says "not verified yet" rather than passing before anything was measured', () => {
    expect(summariseIdentity({ result: null, checkedAt: null, ageMs: null, fromCache: false })).toBe(
      'not verified yet'
    );
  });
});
