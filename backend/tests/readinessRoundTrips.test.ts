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
        return { id: p.id, jsonrpc: '2.0', error: { code: 3, message: String(err?.message ?? err) } };
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
        if (!name) throw new Error('execution reverted: InvalidLaunchConfigId');
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
});
