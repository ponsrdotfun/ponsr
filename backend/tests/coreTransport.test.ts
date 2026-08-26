import { ethers } from 'ethers';
import { RpcPool, parseChainId } from '../src/rpcPool';
import { buildCoreEvidence } from '../src/statusCore';
import { executableDeployment } from '../src/deployments';
import { startFakeChain, FakeChain, MATCHING_SHA256 } from './fixtures/jsonRpcServer';

/**
 * The core's chain id must be a FRESH TRANSPORT OBSERVATION, not configured metadata.
 *
 * The pool builds providers with `staticNetwork: true`, and `getNetwork()` then answers from
 * the CONFIGURED value without sending anything -- the same property that made the pool's
 * admission gate inert until it was rewritten to send an explicit `eth_chainId`. Admission
 * does check the transport, but an admission PASS is cached for up to five minutes, so a
 * core response could look freshly chain-bound while nothing had asked the endpoint anything
 * during that response.
 *
 * These tests drive a real `JsonRpcProvider` against a real local JSON-RPC server and assert
 * on the methods that server was ACTUALLY asked for.
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

/** Reads the chain id the way the production route does. */
async function readChainId(provider: ethers.JsonRpcProvider): Promise<number> {
  const raw = await provider.send('eth_chainId', []);
  const observed = parseChainId(raw);
  if (observed === null) throw new Error('the endpoint did not return a valid hex chain id');
  return observed;
}

function coreOver(provider: ethers.JsonRpcProvider) {
  return {
    expectedChainId: D.chainId,
    capWei: 10n ** 16n,
    publicLaunchEnabled: false,
    deploymentId: D.id,
    deploymentFactory: D.factory,
    treasuryAddress: '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa',
    observedThrough: 'aaaaaaaaaaaa',
    endpointOrigin: 'https://rpc.example.com',
    endpointAvailable: true,
    getChainId: () => readChainId(provider),
    getBlockNumber: async () => 1234,
    getLiveFeeWei: async () => 500000000000000n,
    getTreasuryBalanceWei: async () => 10n ** 18n,
    getLaunchReadiness: async () => ({
      launchEnabled: true,
      whitelisted: false,
      canLaunch: true,
      canLaunchOnChain: true,
    }),
    getDeploymentIdentity: async () => ({ result: { ok: true }, ageMs: 0, fromCache: false }),
    rollingSpendLast24hWei: () => 0n,
  };
}

describe('core chain id comes off the wire, not out of configuration', () => {
  it('sends eth_chainId to the transport for every core response', async () => {
    const c = await chain();
    const pool = new RpcPool([c.url], { deployment: D, admissionTimeoutMs: 2000 });
    const session = await pool.acquire();
    expect(session).not.toBeNull();

    const before = c.methods.filter((m) => m === 'eth_chainId').length;
    await buildCoreEvidence(coreOver(session!.provider), { budgetMs: 2000 });
    const after = c.methods.filter((m) => m === 'eth_chainId').length;

    // Strictly more than admission asked. `getNetwork()` would have added none.
    expect(after).toBeGreaterThan(before);
  }, 20_000);

  it('fails when the endpoint FLIPS chain after being admitted', async () => {
    // Admission passes at 4663 and is cached. The world then changes underneath it.
    const c = await chain({ chainId: D.chainId });
    const pool = new RpcPool([c.url], { deployment: D, admissionTimeoutMs: 2000, admissionTtlMs: 60_000 });
    const session = await pool.acquire();
    expect(session).not.toBeNull();

    const first = await buildCoreEvidence(coreOver(session!.provider), { budgetMs: 2000 });
    expect(first.chainId).toBe(D.chainId);
    expect(first.problems).not.toContain('chain-mismatch');

    c.options.chainId = 46630;

    const second = await buildCoreEvidence(coreOver(session!.provider), { budgetMs: 2000 });
    // Before this, the core would have published 4663 from configured metadata while the
    // endpoint was answering 46630.
    expect(second.chainId).toBe(46630);
    expect(second.problems).toContain('chain-mismatch');
    expect(second.ok).toBe(false);
  }, 20_000);

  it('fails closed when the endpoint returns a malformed chain id', async () => {
    const c = await chain({ rawChainId: 'not-a-chain-id' });
    const pool = new RpcPool([c.url], { deployment: D, admissionTimeoutMs: 2000 });
    // Admission itself refuses it, so there is no session at all -- which is the strongest
    // possible outcome and is asserted rather than assumed.
    const session = await pool.acquire();
    expect(session).toBeNull();
  }, 20_000);

  it('a malformed chain id inside a core read is unreadable, never coerced', async () => {
    const c = await chain();
    const pool = new RpcPool([c.url], { deployment: D, admissionTimeoutMs: 2000 });
    const session = await pool.acquire();
    c.options.rawChainId = '';

    const core = await buildCoreEvidence(coreOver(session!.provider), { budgetMs: 2000 });
    // `Number('')` is 0 and would have compared as a real chain id.
    expect(core.problems).toContain('chain-unreadable');
    expect(core.chainId).toBeNull();
  }, 20_000);

  it('every core observation goes through the ONE pinned endpoint', async () => {
    const a = await chain();
    const b = await chain();
    const pool = new RpcPool([a.url, b.url], { deployment: D, admissionTimeoutMs: 2000 });
    const session = await pool.acquire();

    const beforeB = b.methods.length;
    await buildCoreEvidence(coreOver(session!.provider), { budgetMs: 2000 });
    // The fallback was never probed for this response, let alone read from.
    expect(b.methods.length).toBe(beforeB);
  }, 20_000);
});
