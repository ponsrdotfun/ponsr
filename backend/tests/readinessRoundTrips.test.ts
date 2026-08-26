import * as http from 'http';
import { ethers } from 'ethers';
import { executableDeployment } from '../src/deployments';
import { readCurrentReadiness, describeReadiness } from '../src/currentReadiness';
import { probeLaunchPermission, summariseTimings } from '../src/readinessProbe';
import { PONS_V2_CURRENT_ABI } from '../src/ponsV2CurrentEncoder';

/**
 * The regression this whole change exists for: HOW MANY TIMES the readiness check goes to
 * the network.
 *
 * Wall-clock assertions would be flaky and would also measure the wrong thing -- the check
 * did not fail because any single call was slow, it failed because it made four sequential
 * calls inside one deadline. The round-trip count is the property that caused the outage,
 * it is deterministic, and it needs no network to assert.
 */

const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const ZERO = '0x0000000000000000000000000000000000000000';
const D = executableDeployment();

/**
 * A provider that answers from a fixed table and records each HTTP payload it is handed.
 *
 * Deliberately implements the JSON-RPC layer rather than mocking `ethers.Contract`: the
 * batching being asserted is done by JsonRpcProvider itself, so a mock above that line
 * would report whatever the test wanted to see.
 */
class RecordingProvider extends ethers.JsonRpcProvider {
  trips: string[][] = [];
  constructor(private readonly answers: (method: string, params: any[]) => string) {
    super('http://127.0.0.1:1/never-dialled', D.chainId, { staticNetwork: true });
  }
  async _send(payload: any): Promise<any> {
    const batch = Array.isArray(payload) ? payload : [payload];
    this.trips.push(batch.map((p: any) => p.method));
    // Per-request errors, not a thrown batch. Throwing here would fail all seven calls
    // together, which is a different failure from the one being tested and would let a
    // "one call reverted" test pass for entirely the wrong reason.
    return batch.map((p: any) => {
      try {
        return { id: p.id, jsonrpc: '2.0', result: this.answers(p.method, p.params ?? []) };
      } catch (err: any) {
        // The CODE decides how ethers classifies it, and the two classes mean opposite
        // things here. 3 is `execution reverted` -- the contract answering -- which ethers
        // surfaces as CALL_EXCEPTION. Anything else is the call not arriving. Hardcoding 3
        // for every error made a "socket hang up" fixture indistinguishable from a revert,
        // so a test for transport silence was actually exercising the revert path.
        // Revert DATA is what distinguishes the contract answering from the node failing.
        // Measured: with ethers 6.17 every eth_call failure is CALL_EXCEPTION, and a revert
        // carrying no data is byte-for-byte indistinguishable from `-32000 server
        // overloaded` -- both report shortMessage "missing revert data". Only data proves a
        // revert, so a fixture that wants revert semantics must supply it.
        const code = typeof err?.jsonRpcCode === 'number' ? err.jsonRpcCode : -32000;
        const error: Record<string, unknown> = { code, message: String(err?.message ?? err) };
        if (err?.revertData) error.data = err.revertData;
        return { id: p.id, jsonrpc: '2.0', error };
      }
    });
  }
}

// The factory's real ABI, so encodings match the shapes the code decodes. A hand-written
// subset had `getLaunchConfig` returning three values while the contract returns a
// seven-member struct whose LAST member is `enabled` -- so `cfg.enabled` decoded as
// garbage and the mock quietly reported every launch config disabled.
const abi = new ethers.Interface(PONS_V2_CURRENT_ABI as ethers.InterfaceAbi);

/** A plausible healthy factory. The bytecode is padded to the registry's exact length so
 *  the identity path downloads a realistically sized body. */
function healthy(method: string, params: any[]): string {
  if (method === 'eth_chainId') return '0x' + D.chainId.toString(16);
  if (method === 'eth_getCode') return '0x' + '60'.repeat(D.runtimeBytecodeLength);
  if (method !== 'eth_call') throw new Error(`unexpected method ${method}`);
  const data: string = params[0].data;
  const selector = data.slice(0, 10);
  const name = abi.getFunction(selector)?.name;
  switch (name) {
    case 'launchEnabled':
    case 'canLaunch':
      return abi.encodeFunctionResult(name, [true]);
    case 'whitelistedLaunchers':
      return abi.encodeFunctionResult(name, [false]);
    case 'launchConfigCount':
      return abi.encodeFunctionResult(name, [1n]);
    case 'launchFee':
      return abi.encodeFunctionResult(name, [500000000000000n]);
    case 'feeEscrow':
      return abi.encodeFunctionResult(name, [D.feeEscrow]);
    case 'approvedPairTokens':
      return abi.encodeFunctionResult(name, [true]);
    case 'getLaunchConfig':
      // Encoded through the real ABI, so `enabled` lands in the member the code reads.
      return abi.encodeFunctionResult(name, [[1n, 100n, 0n, 4200000000000000000n, 10000, 200, true]]);
    default:
      throw new Error(`unexpected call ${name ?? selector}`);
  }
}

describe('launch-readiness round trips', () => {
  it('records the four sequential trips the old path made, as the baseline being fixed', async () => {
    const p = new RecordingProvider(healthy);
    await readCurrentReadiness(p, TREASURY, 0n, ZERO, D);

    // Four, and the shape matters as much as the count: the 48 KB getCode is on its own
    // trip and everything else waits behind it.
    expect(p.trips.length).toBe(4);
    expect(p.trips[0]).toEqual(['eth_getCode']);
    expect(p.trips[p.trips.length - 1]).toEqual(['eth_call']);
  });

  it('asks the same questions in ONE round trip', async () => {
    const p = new RecordingProvider(healthy);
    const probe = await probeLaunchPermission(p, TREASURY, 0n, ZERO, D);

    expect(p.trips.length).toBe(1);
    // No bytecode download on the status path. This is the assertion that keeps the 48 KB
    // transfer from drifting back in behind a refactor.
    expect(p.trips.flat()).not.toContain('eth_getCode');
    expect(probe.verdict).not.toBeNull();
    expect(probe.verdict!.ready).toBe(true);
  });

  it('reaches the same verdict as the path it replaces', async () => {
    const a = new RecordingProvider(healthy);
    const b = new RecordingProvider(healthy);
    const before = await readCurrentReadiness(a, TREASURY, 0n, ZERO, D);
    const after = await probeLaunchPermission(b, TREASURY, 0n, ZERO, D);

    // `ready` cannot be compared directly, and the reason is the point of the change: the
    // old verdict folds deployment identity into it, so this mock -- whose bytecode is the
    // right LENGTH but not the right bytes -- makes the old path report not-ready for a
    // reason that has nothing to do with pons's permissions.
    expect(before.ready).toBe(false);
    expect(before.identityMatches).toBe(false);
    expect(before.reason).toContain('not the one the registry describes');

    // Identity was the old path's ONLY complaint, so with it held constant the two agree.
    // Rebuilt from the raw axes rather than by re-feeding `before` to describeReadiness:
    // that function narrows `canLaunch` to `canLaunch && !reason`, so its output is not a
    // valid input to itself and round-tripping it would carry the identity failure back in
    // disguised as a closed gate.
    const beforeWithoutIdentity = describeReadiness({
      ...before,
      canLaunch: before.canLaunchOnChain,
      identityMatches: true,
      identityMismatches: [],
    });
    expect(beforeWithoutIdentity.ready).toBe(true);
    expect(after.verdict!.ready).toBe(beforeWithoutIdentity.ready);
    expect(after.verdict!.canLaunch).toBe(beforeWithoutIdentity.canLaunch);
    expect(after.verdict!.launchEnabled).toBe(before.launchEnabled);
    expect(after.verdict!.whitelisted).toBe(before.whitelisted);
    expect(after.verdict!.launchConfigUsable).toBe(before.launchConfigUsable);
    expect(after.verdict!.pairApproved).toBe(before.pairApproved);
    expect(after.verdict!.escrowMatches).toBe(before.escrowMatches);
    expect(after.verdict!.feeWei).toBe(before.feeWei);
  });

  it('treats a reverting launch config as unusable rather than as a failed probe', async () => {
    // The old path avoided this call when the id was out of range. The new one issues it
    // unconditionally to save a round trip, so the revert has to be the answer.
    const p = new RecordingProvider((m, params) => {
      if (m === 'eth_call') {
        const name = abi.getFunction(params[0].data.slice(0, 10))?.name;
        if (!name) {
          const e: any = new Error('execution reverted: InvalidLaunchConfigId');
          e.jsonRpcCode = 3;
          // The selector of a custom error, which is what the real factory returns.
          e.revertData = '0x' + 'ab'.repeat(4);
          throw e;
        }
      }
      return healthy(m, params);
    });
    const probe = await probeLaunchPermission(p, TREASURY, 99n, ZERO, D);

    expect(probe.verdict).not.toBeNull();
    expect(probe.verdict!.launchConfigUsable).toBe(false);
    expect(probe.verdict!.ready).toBe(false);
    // A reverting config is a real answer about pons, not an unreadable endpoint, so it
    // must not be reported as a call that failed to respond.
    expect(probe.failure).toBeUndefined();
  });

  it('refuses to produce a verdict when a permission read did not answer', async () => {
    const p = new RecordingProvider((m, params) => {
      if (m === 'eth_call') {
        const name = abi.getFunction(params[0].data.slice(0, 10))?.name;
        if (name === 'canLaunch') throw new Error('upstream timeout');
      }
      return healthy(m, params);
    });
    const probe = await probeLaunchPermission(p, TREASURY, 0n, ZERO, D);

    // Partial data must not become a partial verdict. launchEnabled answered `true`, and
    // publishing that alone would read as "the gate is open".
    expect(probe.verdict).toBeNull();
    expect(probe.failure).toContain('canLaunch');
    // The timings survive the failure -- they are the evidence of why it was slow.
    expect(probe.timings.find((t) => t.name === 'canLaunch')!.ok).toBe(false);
  });

  it('marks batched timings as shared, and does not claim per-call attribution it lacks', async () => {
    const p = new RecordingProvider(healthy);
    const probe = await probeLaunchPermission(p, TREASURY, 0n, ZERO, D);

    expect(probe.batched).toBe(true);
    expect(probe.timings.every((t) => t.shared)).toBe(true);
    // Seven near-identical figures read as seven slow calls unless the summary says
    // otherwise. It has to say otherwise.
    expect(summariseTimings(probe.timings)).toContain('per-call figures shared');
  });

  it('serial mode really serialises, so its per-call figures mean what they say', async () => {
    const p = new RecordingProvider(healthy);
    const probe = await probeLaunchPermission(p, TREASURY, 0n, ZERO, D, { serial: true });

    expect(probe.batched).toBe(false);
    expect(probe.timings.every((t) => t.shared)).toBe(false);
    // One trip per read: that is the cost being paid in exchange for attribution.
    expect(p.trips.length).toBe(probe.timings.length);
    expect(p.trips.every((t) => t.length === 1)).toBe(true);
    expect(summariseTimings(probe.timings)).not.toContain('shared');
  });

  it('does not ask the approval map about native ETH', async () => {
    const p = new RecordingProvider(healthy);
    const probe = await probeLaunchPermission(p, TREASURY, 0n, ZERO, D, { serial: true });

    // The factory short-circuits on the zero address, so approvedPairTokens(0x0) is false
    // and asking it would refuse the one pairing that always works.
    expect(probe.timings.map((t) => t.name)).not.toContain('approvedPairTokens');
    expect(probe.verdict!.pairApproved).toBe(true);
  });

  /**
   * The causal claim, proved without the real network.
   *
   * Every assertion above is about trip COUNT. This one closes the last gap in the
   * argument: that the count is what breaks the budget. A local server delays every
   * response by a fixed amount, so the trip count is the only variable. At 1 300 ms per
   * trip the old path must exceed the 5 000 ms status deadline and the new one must not.
   *
   * Deterministic, and it is the reason no wall-clock claim here depends on a live
   * endpoint being slow on the day the suite runs.
   */
  it('the trip count, not the endpoint, is what breaks the 5000ms budget', async () => {
    const DELAY_MS = 1300;
    const BUDGET_MS = 5000;
    let trips = 0;

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        trips += 1;
        const parsed = JSON.parse(body);
        const one = (p: any) => ({ id: p.id, jsonrpc: '2.0', result: healthy(p.method, p.params ?? []) });
        const out = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
        setTimeout(() => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(out));
        }, DELAY_MS);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;

    const measure = async (run: (p: ethers.JsonRpcProvider) => Promise<unknown>) => {
      trips = 0;
      const p = new ethers.JsonRpcProvider(url, D.chainId, { staticNetwork: true });
      const started = Date.now();
      await run(p);
      const ms = Date.now() - started;
      p.destroy();
      return { ms, trips };
    };

    const before = await measure((p) => readCurrentReadiness(p, TREASURY, 0n, ZERO, D));
    const after = await measure((p) => probeLaunchPermission(p, TREASURY, 0n, ZERO, D));
    server.close();

    expect(before.trips).toBe(4);
    expect(after.trips).toBe(1);
    // The whole outage, reproduced from nothing but latency and arithmetic.
    expect(before.ms).toBeGreaterThan(BUDGET_MS);
    expect(after.ms).toBeLessThan(BUDGET_MS);
  }, 40_000);

  /**
   * Complete evidence, or no verdict.
   *
   * Every read below used to be allowed to fail into a default, and one default was
   * actively dangerous: an unreadable `launchFee` became 0n, nothing in the verdict
   * inspects the fee, so `/status` published `launchpad: ok` for a launch whose price
   * nobody had managed to read.
   */
  describe('a missing input is not a permissive input', () => {
    /** Fails one named call with a transport-shaped error: the call never arrived. */
    const transportFailure = (target: string) =>
      new RecordingProvider((m, params) => {
        if (m === 'eth_call') {
          const name = abi.getFunction(params[0].data.slice(0, 10))?.name;
          if (name === target) throw new Error('socket hang up');
        }
        return healthy(m, params);
      });

    it.each(['launchFee', 'feeEscrow', 'launchEnabled', 'whitelistedLaunchers', 'canLaunch'])(
      'produces NO verdict when %s did not answer',
      async (target) => {
        const probe = await probeLaunchPermission(transportFailure(target), TREASURY, 0n, ZERO, D);
        expect(probe.verdict).toBeNull();
        expect(probe.failure).toContain('UNKNOWN');
        expect(probe.failure).toContain(target);
      }
    );

    it('never synthesises an unreadable fee as zero', async () => {
      const probe = await probeLaunchPermission(transportFailure('launchFee'), TREASURY, 0n, ZERO, D);
      // The old code produced a verdict carrying feeWei 0n. A zero fee is a real, meaningful
      // value -- pons could set one -- so inventing it is worse than refusing to answer.
      expect(probe.verdict).toBeNull();
    });

    it('produces NO verdict when the launch config is unreadable for transport reasons', async () => {
      const probe = await probeLaunchPermission(transportFailure('getLaunchConfig'), TREASURY, 0n, ZERO, D);
      expect(probe.verdict).toBeNull();
      expect(probe.failure).toContain('launch config could not be read');
    });

    it('produces NO verdict when the pair approval is unreadable', async () => {
      // A non-native pair, so the approval map really is consulted.
      const probe = await probeLaunchPermission(
        transportFailure('approvedPairTokens'),
        TREASURY,
        0n,
        '0x1111111111111111111111111111111111111111',
        D
      );
      expect(probe.verdict).toBeNull();
      expect(probe.failure).toContain('pair-token approval');
    });

    it('still answers when only launchConfigCount is missing but the config itself read', async () => {
      // The count is corroboration, not the answer: getLaunchConfig succeeding IS the
      // config being readable and enabled.
      const probe = await probeLaunchPermission(transportFailure('launchConfigCount'), TREASURY, 0n, ZERO, D);
      expect(probe.verdict).not.toBeNull();
      expect(probe.verdict!.launchConfigUsable).toBe(true);
      // But the gap is reported rather than dropped, so the page can degrade on it.
      expect(probe.failure).toContain('answered with gaps');
      expect(probe.failure).toContain('launchConfigCount');
    });

    it('distinguishes a REVERT from silence, and only the revert is an answer', async () => {
      // A revert carries JSON-RPC code 3 with "execution reverted", which ethers surfaces
      // as CALL_EXCEPTION. That is the contract speaking; a dead socket is not.
      const reverting = new RecordingProvider((m, params) => {
        if (m === 'eth_call') {
          const name = abi.getFunction(params[0].data.slice(0, 10))?.name;
          if (name === 'getLaunchConfig') {
            const e: any = new Error('execution reverted: InvalidLaunchConfigId');
            e.jsonRpcCode = 3;
            e.revertData = '0x' + 'ab'.repeat(4);
            throw e;
          }
        }
        return healthy(m, params);
      });
      const probe = await probeLaunchPermission(reverting, TREASURY, 0n, ZERO, D);

      expect(probe.verdict).not.toBeNull();
      expect(probe.verdict!.launchConfigUsable).toBe(false);
      expect(probe.verdict!.ready).toBe(false);
      const t = probe.timings.find((x) => x.name === 'getLaunchConfig')!;
      expect(t.reverted).toBe(true);
    });
  });
});
