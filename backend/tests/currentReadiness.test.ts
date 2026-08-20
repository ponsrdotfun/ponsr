import { describeReadiness, CurrentReadiness } from '../src/currentReadiness';

/**
 * Why this is separate from `getLaunchReadiness`.
 *
 * The old helper answers "can we launch" by inferring `launchEnabled || whitelisted`.
 * The current factory publishes `canLaunch(address)` as its own predicate, and the
 * two are equivalent only for as long as pons chooses to keep them so. Ponsr already
 * spent a week confidently wrong about this contract's state; deriving a permission
 * the contract will state directly is how that happens again.
 *
 * The three facts are also reported separately, because they mean different things to
 * an operator: a public gate can close, a whitelist is durable, and the effective
 * answer is what actually decides a launch.
 */
describe('current readiness', () => {
  const base: CurrentReadiness = {
    launchEnabled: true,
    whitelisted: false,
    canLaunch: true,
    launchConfigUsable: true,
    pairApproved: true,
    feeWei: 500_000_000_000_000n,
    escrowMatches: true,
  };

  it('reports the effective answer from the contract, not from an inference', () => {
    // The case that separates them: the helper says no while the parts say yes.
    const d = describeReadiness({ ...base, canLaunch: false });
    expect(d.canLaunch).toBe(false);
    expect(d.reason).toMatch(/canLaunch/i);
  });

  it('keeps the public gate and the whitelist visible separately', () => {
    const d = describeReadiness(base);
    expect(d.launchEnabled).toBe(true);
    expect(d.whitelisted).toBe(false);
    expect(d.canLaunch).toBe(true);
    // Open to everyone is not the same as granted to us, and an operator planning
    // around continuity needs to see which one is carrying the launch.
    expect(d.detail).toMatch(/public gate/i);
  });

  it('says so when permission rests only on the public gate', () => {
    expect(describeReadiness(base).durable).toBe(false);
  });

  it('calls permission durable once the whitelist is granted', () => {
    const d = describeReadiness({ ...base, whitelisted: true, launchEnabled: false });
    expect(d.durable).toBe(true);
    expect(d.canLaunch).toBe(true);
  });

  // Each of these blocks a launch on its own, and each has a different fix.
  it('refuses on a disabled launch config', () => {
    expect(describeReadiness({ ...base, launchConfigUsable: false }).canLaunch).toBe(false);
  });

  it('refuses on an unapproved pair', () => {
    const d = describeReadiness({ ...base, pairApproved: false });
    expect(d.canLaunch).toBe(false);
    expect(d.reason).toMatch(/pair/i);
  });

  // The escrow is not a launch permission, but launching with the wrong one loses
  // money permanently, so it fails closed here rather than at signing time.
  it('refuses on an escrow mismatch even when everything else is open', () => {
    const d = describeReadiness({ ...base, escrowMatches: false });
    expect(d.canLaunch).toBe(false);
    expect(d.reason).toMatch(/escrow/i);
  });
});
