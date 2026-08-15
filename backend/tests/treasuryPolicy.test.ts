import {
  TreasuryPolicy,
  assessHotWallet,
  canAdmitLaunch,
  checkTreasurySetup,
  describeSweep,
  describeTopUp,
  formatEth,
  startTreasuryWatch,
} from '../src/treasuryPolicy';

/**
 * Part 5 mitigation #7 -- hot/cold treasury split.
 *
 * The numbers below are chosen so the arithmetic is checkable by hand: a
 * 0.0005 ETH fee (what both pons v1 and v2 read today), a 0.002 ETH gas reserve,
 * and a 0.05 ETH daily cap.
 */
const FEE = 500_000_000_000_000n; // 0.0005 ETH
const RESERVE = 2_000_000_000_000_000n; // 0.002 ETH
const DAILY_CAP = 50_000_000_000_000_000n; // 0.05 ETH

const POLICY: TreasuryPolicy = {
  dailyCapWei: DAILY_CAP,
  maxDailyCaps: 2,
  floorLaunches: 20,
  targetLaunches: 60,
  criticalLaunches: 3,
  gasReserveWei: RESERVE,
};

/** balance for exactly n launches, plus the untouchable gas reserve */
const forLaunches = (n: number) => FEE * BigInt(n) + RESERVE;

const HOT = '0x1111111111111111111111111111111111111111';
const COLD = '0x2222222222222222222222222222222222222222';

describe('assessHotWallet -- state classification', () => {
  it('HEALTHY between the floor and the ceiling', () => {
    const a = assessHotWallet(forLaunches(50), FEE, POLICY);
    expect(a.state).toBe('HEALTHY');
    expect(a.launchesRemaining).toBe(50);
    expect(a.topUpWei).toBe(0n);
    expect(a.sweepWei).toBe(0n);
  });

  it('LOW below the operating floor, and asks for exactly enough to reach target', () => {
    const a = assessHotWallet(forLaunches(10), FEE, POLICY);
    expect(a.state).toBe('LOW');
    expect(a.launchesRemaining).toBe(10);
    // target is 60 launches, we hold 10 -> top up the 50-launch difference
    expect(a.topUpWei).toBe(FEE * 50n);
  });

  it('CRITICAL at or below the critical threshold', () => {
    expect(assessHotWallet(forLaunches(3), FEE, POLICY).state).toBe('CRITICAL');
    expect(assessHotWallet(forLaunches(4), FEE, POLICY).state).toBe('LOW');
  });

  it('EMPTY when the balance cannot cover one fee on top of the reserve', () => {
    const a = assessHotWallet(RESERVE, FEE, POLICY);
    expect(a.state).toBe('EMPTY');
    expect(a.launchesRemaining).toBe(0);
  });

  it('OVERFUNDED above the ceiling, and asks for exactly the excess', () => {
    const excess = 3_000_000_000_000_000n; // 0.003 ETH over
    const ceiling = DAILY_CAP * 2n + RESERVE;
    const a = assessHotWallet(ceiling + excess, FEE, POLICY);
    expect(a.state).toBe('OVERFUNDED');
    expect(a.sweepWei).toBe(excess);
    expect(a.topUpWei).toBe(0n);
  });

  it('CRITICAL: the gas reserve is never counted as available for fees', () => {
    // Exactly one fee's worth of ETH, with no reserve on top. One launch is two
    // transactions out of this wallet -- treating this as fundable is precisely
    // the bug that leaves a splitter deployed and the launch unpaid.
    const a = assessHotWallet(FEE, FEE, POLICY);
    expect(a.spendableWei).toBe(0n);
    expect(a.launchesRemaining).toBe(0);
    expect(a.state).toBe('EMPTY');
  });

  it('CRITICAL: a zero fee reading fails closed rather than treating launches as free', () => {
    // A 0 fee back from the factory means the call failed or the ABI is wrong --
    // see docs/pons-v2-findings.md. Spending freely on a broken fee oracle is the
    // one outcome that must not happen.
    const a = assessHotWallet(forLaunches(100), 0n, POLICY);
    expect(a.launchesRemaining).toBe(0);
    expect(a.state).toBe('EMPTY');
    expect(canAdmitLaunch(a).ok).toBe(false);
  });

  it('thresholds move with the live fee rather than being frozen in ETH', () => {
    // Same balance, fee doubled: headroom halves. Nothing in the policy is
    // denominated in ETH, so a pons fee change needs no config edit.
    const balance = forLaunches(40);
    expect(assessHotWallet(balance, FEE, POLICY).launchesRemaining).toBe(40);
    expect(assessHotWallet(balance, FEE * 2n, POLICY).launchesRemaining).toBe(20);
  });

  it('clamps a target that would exceed the ceiling instead of oscillating', () => {
    // A fee high enough that 60 launches costs more than the ceiling allows. If
    // the target were not clamped, the operator would top up to the target and
    // the next reading would immediately call it over-funded, forever.
    const bigFee = 10_000_000_000_000_000n; // 0.01 ETH -> 60 launches = 0.6 ETH
    const a = assessHotWallet(forLaunches(1), bigFee, POLICY);
    expect(a.targetWei).toBe(a.ceilingWei);
    expect(a.balanceWei + a.topUpWei).toBeLessThanOrEqual(a.ceilingWei);
  });
});

describe('canAdmitLaunch -- the gate that actually stops a spend', () => {
  it('admits while at least one launch is fundable', () => {
    expect(canAdmitLaunch(assessHotWallet(forLaunches(1), FEE, POLICY)).ok).toBe(true);
  });

  it('refuses when the wallet cannot fund one, and says why in concrete terms', () => {
    const decision = canAdmitLaunch(assessHotWallet(RESERVE, FEE, POLICY));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.detail).toContain('0.002'); // quotes the gas reserve
      expect(decision.detail.toLowerCase()).toContain('hot wallet');
    }
  });

  it('CRITICAL: still refuses at CRITICAL-but-fundable? no -- CRITICAL is fundable by design', () => {
    // CRITICAL means "top up now", not "stop". Turning users away while the
    // wallet can still pay would be the guard doing damage the attack did not.
    const a = assessHotWallet(forLaunches(2), FEE, POLICY);
    expect(a.state).toBe('CRITICAL');
    expect(canAdmitLaunch(a).ok).toBe(true);
  });
});

describe('checkTreasurySetup -- catching a split that only looks real', () => {
  it('is clean on a correct setup', () => {
    const problems = checkTreasurySetup({
      hotAddress: HOT,
      coldAddress: COLD,
      policy: POLICY,
      isProduction: true,
    });
    expect(problems).toHaveLength(0);
  });

  it('CRITICAL: errors when cold and hot are the same address', () => {
    // Every balance check passes and every alert reads normally while the blast
    // radius is still 100% -- the failure is silent unless it is checked for.
    const problems = checkTreasurySetup({
      hotAddress: HOT,
      coldAddress: HOT.toUpperCase().replace('0X', '0x'), // case must not hide it
      policy: POLICY,
      isProduction: true,
    });
    expect(problems.some((p) => p.level === 'error' && /same address/i.test(p.message))).toBe(true);
  });

  it('errors on a missing cold address in production, warns in development', () => {
    const prod = checkTreasurySetup({ hotAddress: HOT, coldAddress: null, policy: POLICY, isProduction: true });
    const dev = checkTreasurySetup({ hotAddress: HOT, coldAddress: null, policy: POLICY, isProduction: false });
    expect(prod[0].level).toBe('error');
    expect(dev[0].level).toBe('warning');
  });

  it('errors when the floor is not below the target -- otherwise every top-up re-alerts', () => {
    const problems = checkTreasurySetup({
      hotAddress: HOT,
      coldAddress: COLD,
      policy: { ...POLICY, floorLaunches: 60, targetLaunches: 60 },
      isProduction: false,
    });
    expect(problems.some((p) => p.level === 'error' && /FLOOR_LAUNCHES/.test(p.message))).toBe(true);
  });

  it('warns when the ceiling sits below a single day of permitted spend', () => {
    const problems = checkTreasurySetup({
      hotAddress: HOT,
      coldAddress: COLD,
      policy: { ...POLICY, maxDailyCaps: 0 },
      isProduction: false,
    });
    expect(problems.some((p) => /MAX_DAILY_CAPS/.test(p.message))).toBe(true);
  });
});

describe('operator instructions', () => {
  it('a top-up message carries the amount, both addresses and the bridging delay', () => {
    const a = assessHotWallet(forLaunches(5), FEE, POLICY);
    const msg = describeTopUp(a, { hot: HOT, cold: COLD });
    expect(msg).toContain(HOT);
    expect(msg).toContain(COLD);
    expect(msg).toContain(formatEth(a.topUpWei));
    expect(msg).toMatch(/10 minutes/);
  });

  it('says so plainly when there is no cold wallet configured to name', () => {
    const a = assessHotWallet(forLaunches(5), FEE, POLICY);
    expect(describeTopUp(a, { hot: HOT, cold: null })).toContain('TREASURY_COLD_ADDRESS');
  });

  // This used to assert the message named the cold wallet as a destination. It was
  // asserting an impossible instruction: the Turnkey policy permits the pons factory
  // and contract creation and refuses every other destination, so nothing can be
  // transferred out of the hot wallet at all. Someone would have found that out
  // while following the alert during an incident.
  it('an over-funded message states the excess and does not tell anyone to move it', () => {
    const a = assessHotWallet(DAILY_CAP * 3n, FEE, POLICY);
    const msg = describeSweep(a, { hot: HOT, cold: COLD });
    expect(msg).toContain(formatEth(a.sweepWei));
    expect(msg).toMatch(/cannot be swept/i);
    expect(msg).not.toContain(COLD);
  });
});

describe('formatEth', () => {
  it('renders readable ETH rather than wei', () => {
    expect(formatEth(500_000_000_000_000n)).toBe('0.0005');
    expect(formatEth(1_000_000_000_000_000_000n)).toBe('1');
    expect(formatEth(0n)).toBe('0');
  });
});

describe('startTreasuryWatch', () => {
  it('reads once immediately rather than waiting a full interval', async () => {
    const seen: bigint[] = [];
    const handle = startTreasuryWatch(
      {
        getBalanceWei: async () => forLaunches(50),
        getLiveFeeWei: async () => FEE,
        report: async (balanceWei) => {
          seen.push(balanceWei);
        },
      },
      60
    );
    await new Promise((r) => setImmediate(r));
    handle.stop();
    // A process restarting into an empty wallet must say so now, not in an hour.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(forLaunches(50));
  });

  it('a failing RPC read is logged, not thrown -- a dead RPC must not kill the process', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const handle = startTreasuryWatch(
      {
        getBalanceWei: async () => {
          throw new Error('RPC unreachable');
        },
        getLiveFeeWei: async () => FEE,
        report: async () => {},
      },
      60
    );
    await new Promise((r) => setImmediate(r));
    handle.stop();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
