import * as http from 'http';
import { ethers } from 'ethers';
import { executableDeployment } from '../../src/deployments';

/**
 * A real local JSON-RPC endpoint, for tests that must not be able to dictate the answer.
 *
 * WHY THIS EXISTS, AND WHY THE OLD FAKE WAS WORSE THAN NOTHING
 * -----------------------------------------------------------
 * `rpcPool`'s admission gate was tested with a hand-made object whose `getNetwork()`
 * returned whatever the test asked for. Every wrong-chain test passed. The gate did not
 * work at all: `new JsonRpcProvider(url, chainId, { staticNetwork: true })` answers
 * `getNetwork()` from the CONFIGURED value without sending a single request, so the check
 * compared a constant to itself and the transport was never touched.
 *
 * A mock placed above the layer under test reports whatever the author expected. So this
 * is an actual HTTP server speaking actual JSON-RPC, and it records every method it is
 * asked for -- which is the evidence that separates "the endpoint said 4663" from "nobody
 * ever asked".
 */

export interface FakeChainOptions {
  /** What the endpoint answers to eth_chainId. Defaults to the executable deployment's. */
  chainId?: number;
  /** Raw result for eth_chainId, for malformed/overflow/non-hex cases. Overrides chainId. */
  rawChainId?: unknown;
  /** Runtime bytecode served for eth_getCode. Defaults to bytes matching `runtimeSha256`. */
  code?: string;
  /** Per-method JSON-RPC error, instead of a result. */
  errors?: Record<string, { code: number; message: string }>;
  /** Per-method delay in ms, for hang and timeout tests. */
  delays?: Record<string, number>;
  /** Methods that never answer at all. The socket is simply left open. */
  hang?: string[];
  /**
   * `eth_call` results, keyed by the 4-byte selector of the calldata (with `0x`).
   *
   * Needed so a launch can be BUILT against a real transport rather than a stand-in. A
   * target that only reports `factoryAddress` proves what the object says about itself;
   * driving `build()` through an actual provider proves what ends up in `to`, which is
   * the field that decides where money goes. Anything not listed falls through to the
   * default empty result, exactly as before.
   */
  calls?: Record<string, string>;
}

export interface FakeChain {
  url: string;
  /** Every JSON-RPC method the server was actually asked for, in order. */
  methods: string[];
  /** Mutable, so a test can change the endpoint's view after admission. */
  options: FakeChainOptions;
  /**
   * Answers every request currently held open by `hang`, and stops hanging.
   *
   * Needed to prove that a waiter giving up does not POISON a shared probe: without a way
   * to release the stall, "the first caller can still complete" is untestable, and the
   * difference between abandoning a wait and cancelling the work would go unasserted.
   */
  release(): void;
  /** How many requests are being held open right now. */
  pending(): number;
  close(): Promise<void>;
}

const D = executableDeployment();

/** Bytecode whose sha256 is a stable, known value the tests can expect. */
export const MATCHING_CODE = '0x' + '60'.repeat(D.runtimeBytecodeLength);
export const MATCHING_SHA256 = ethers.sha256(MATCHING_CODE).slice(2);
/** Right length, wrong bytes: a fork, or a lagging archive node. */
export const FORKED_CODE = '0x' + 'ab'.repeat(D.runtimeBytecodeLength);

export async function startFakeChain(options: FakeChainOptions = {}): Promise<FakeChain> {
  const methods: string[] = [];
  const state: FakeChainOptions = { ...options };

  const answerOne = (p: any): any => {
    const m = p.method as string;
    const err = state.errors?.[m];
    if (err) return { id: p.id, jsonrpc: '2.0', error: err };

    if (m === 'eth_chainId') {
      const raw =
        'rawChainId' in state && state.rawChainId !== undefined
          ? state.rawChainId
          : '0x' + (state.chainId ?? D.chainId).toString(16);
      return { id: p.id, jsonrpc: '2.0', result: raw };
    }
    if (m === 'eth_getCode') {
      return { id: p.id, jsonrpc: '2.0', result: state.code ?? MATCHING_CODE };
    }
    if (m === 'eth_blockNumber') return { id: p.id, jsonrpc: '2.0', result: '0x10' };
    if (m === 'eth_call' && state.calls) {
      const data = String(p.params?.[0]?.data ?? '');
      const hit = state.calls[data.slice(0, 10)];
      if (hit !== undefined) return { id: p.id, jsonrpc: '2.0', result: hit };
    }
    return { id: p.id, jsonrpc: '2.0', result: '0x' };
  };

  const held: Array<() => void> = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      for (const p of batch) methods.push(p.method);

      // A method listed in `hang` never answers until released. The request is simply held
      // open, which is the common real failure -- a stall, not a rejection.
      if (batch.some((p: any) => state.hang?.includes(p.method))) {
        held.push(() => {
          const out = batch.map(answerOne);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
        });
        return;
      }

      const out = batch.map(answerOne);
      const delay = Math.max(0, ...batch.map((p: any) => state.delays?.[p.method] ?? 0));
      const send = () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
      };
      if (delay > 0) setTimeout(send, delay);
      else send();
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;

  return {
    url: `http://127.0.0.1:${port}`,
    methods,
    options: state,
    release() {
      state.hang = [];
      while (held.length) held.pop()!();
    },
    pending: () => held.length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
