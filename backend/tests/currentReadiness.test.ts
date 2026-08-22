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
  // Identity holding is the precondition for these cases, not an assumption about
  // them: every test below is about permission, and a drifted contract short-circuits
  // permission entirely. The drift cases have their own describe block at the end.
  const base: CurrentReadiness = {
    identityMatches: true,
    identityMismatches: [],
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

/**
 * Identity drift, at the gate that runs before money moves.
 *
 * §3's drift requirement asks readiness to fail closed, and readiness is the right
 * place: it already runs before the splitter is deployed and before the fee is spent,
 * and it is the one report an operator reads when something looks wrong.
 *
 * Permission and identity are kept apart in the verdict on purpose. "pons will not let
 * you launch" and "this is not the contract we think it is" have nothing to do with
 * each other, and collapsing them into one boolean sends the reader to the wrong file.
 */
describe('readiness fails closed on identity drift', () => {
  const base = {
    launchEnabled: true,
    whitelisted: false,
    canLaunch: true,
    launchConfigUsable: true,
    pairApproved: true,
    feeWei: 500_000_000_000_000n,
    escrowMatches: true,
  };

  it('is ready when identity holds', () => {
    const v = describeReadiness({ ...base, identityMatches: true, identityMismatches: [] });
    expect(v.ready).toBe(true);
  });

  it('refuses when the contract is not the one the registry describes', () => {
    const v = describeReadiness({
      ...base,
      identityMatches: false,
      identityMismatches: ['runtime sha256: expected 226a04…, chain says ffff…'],
    });
    expect(v.ready).toBe(false);
    expect(v.reason).toMatch(/identity|registry describes/i);
  });

  it('names the axis that drifted, so the refusal is actionable', () => {
    const v = describeReadiness({
      ...base,
      identityMatches: false,
      identityMismatches: ['launch selector: expected 0xf35abbcf, chain/file says 0xa41d5f2b'],
    });
    expect(v.reason).toMatch(/launch selector/);
  });

  // A drifted contract that pons would happily let us launch on is the dangerous case:
  // every permission is green, and the bytes are wrong.
  it('refuses even when every permission is green', () => {
    const v = describeReadiness({
      ...base,
      whitelisted: true,
      identityMatches: false,
      identityMismatches: ['abi sha256: expected 1d424e…, chain/file says 000000…'],
    });
    expect(v.canLaunch).toBe(false);
    expect(v.ready).toBe(false);
  });

  it('treats identity as separate from permission in the detail line', () => {
    const v = describeReadiness({ ...base, identityMatches: false, identityMismatches: ['fee escrow: …'] });
    expect(v.detail).toMatch(/public gate/i);
  });
});
