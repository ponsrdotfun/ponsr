import { ethers } from 'ethers';
import { preflightEnv } from './preflightEnv';

/**
 * Part 5 mitigation #7 -- hot/cold treasury split.
 *
 * Part 5 §3.6 is blunt about the shape of the risk: one treasury wallet funding
 * every launch means one leaked key drains the whole operation in a single
 * transaction. The mitigation is not a smarter key -- that is mitigation #6, and
 * it is a different piece of work (Turnkey). This one is about *bounding the
 * loss* when #6 fails anyway: hold a small operating float in the hot wallet the
 * bot spends from, keep the rest somewhere the bot cannot touch, and top the
 * float up on a schedule.
 *
 * What this module deliberately does NOT do is move funds. An automated cold ->
 * hot transfer needs a cold signer, and the cold side is meant to be a hardware
 * wallet or multisig precisely so that no online process can spend from it. A
 * bot that could refill itself from cold storage would have re-created the
 * single point of failure the split exists to remove. So the sweep and the
 * top-up are both operator actions; this module's job is to decide when they are
 * needed, say so in terms the operator can act on immediately, and -- the part
 * that actually protects money -- refuse launches the hot wallet cannot fund.
 *
 * Everything here is pure. Balances and fees are read by the caller and passed
 * in, which is what makes the whole policy testable without a chain.
 */

export interface TreasuryPolicy {
  /** The circuit breaker's 24h spend cap (Part 5 mitigation #2). The ceiling is
   *  derived from this rather than being its own invented number -- see below. */
  dailyCapWei: bigint;
  /**
   * Hot balance ceiling, as a multiple of the daily spend cap.
   *
   * This is the argument that sets the ceiling, and it is worth stating because
   * it is easy to over-fund a hot wallet "just to be safe": the circuit breaker
   * already refuses to spend more than `dailyCapWei` in any rolling 24h window.
   * Any balance above a couple of days' cap therefore cannot be spent by the bot
   * no matter what happens -- but it can absolutely be stolen. It is pure
   * downside. Part 5's own wording is "a day or two of expected launch volume",
   * which is exactly this number.
   */
  maxDailyCaps: number;
  /** Below this many launches' worth of headroom, ask the operator to top up.
   *  Sized so a top-up has time to arrive: Part 6 §2 measured canonical bridging
   *  at ~10 minutes, so the floor must cover more than 10 minutes of traffic. */
  floorLaunches: number;
  /** A top-up should restore the hot wallet to roughly this many launches. */
  targetLaunches: number;
  /** At or below this, the situation is no longer "top up soon" but "top up now
   *  or the next few users get turned away". */
  criticalLaunches: number;
  /** Never counted as available for launch fees. The launch flow sends two
   *  transactions (splitter deployment, then the launch itself) and gas for both
   *  comes out of this same wallet -- a balance of exactly one launch fee is not
   *  enough to complete one launch. */
  gasReserveWei: bigint;
}

export function treasuryPolicyFromConfig(): TreasuryPolicy {
  return {
    dailyCapWei: preflightEnv().DAILY_SPEND_CAP_WEI,
    maxDailyCaps: preflightEnv().HOT_WALLET_MAX_DAILY_CAPS,
    floorLaunches: preflightEnv().HOT_WALLET_FLOOR_LAUNCHES,
    targetLaunches: preflightEnv().HOT_WALLET_TARGET_LAUNCHES,
    criticalLaunches: preflightEnv().HOT_WALLET_CRITICAL_LAUNCHES,
    gasReserveWei: preflightEnv().TREASURY_GAS_RESERVE_WEI,
  };
}

export type HotWalletState =
  /** Cannot fund even one launch. Launches are refused. */
  | 'EMPTY'
  /** Can fund a handful. Top up now. */
  | 'CRITICAL'
  /** Below the operating floor. Top up soon. */
  | 'LOW'
  | 'HEALTHY'
  /** Above the ceiling -- more exposure than the bot can ever spend. Sweep to cold. */
  | 'OVERFUNDED';

export interface HotWalletAssessment {
  state: HotWalletState;
  balanceWei: bigint;
  /** Balance minus the gas reserve: what can actually go towards launch fees. */
  spendableWei: bigint;
  /** Carried through from the policy so alert and rejection text can quote it
   *  without the caller having to hold onto the policy too. */
  gasReserveWei: bigint;
  launchesRemaining: number;
  floorWei: bigint;
  targetWei: bigint;
  ceilingWei: bigint;
  /** > 0 when the operator should move this much cold -> hot. */
  topUpWei: bigint;
  /** > 0 when the operator should move this much hot -> cold. */
  sweepWei: bigint;
}

/**
 * Turns a balance reading into a decision. Thresholds are expressed in
 * *launches*, not in ETH, and converted here using the live fee -- the launch
 * fee is owner-settable on pons's side and has no business being frozen into a
 * threshold (see `docs/pons-v2-findings.md`; both v1 and v2 read 0.0005 ETH
 * today, and neither promises to tomorrow).
 *
 * A `feeWei` of zero is treated as "cannot fund anything" rather than "launches
 * are free". A zero fee read back from the factory almost certainly means the
 * call failed or the ABI is wrong, and the safe reading of a broken fee oracle
 * is to stop spending, not to spend freely.
 */
export function assessHotWallet(
  balanceWei: bigint,
  feeWei: bigint,
  policy: TreasuryPolicy
): HotWalletAssessment {
  const reserve = policy.gasReserveWei;
  const spendableWei = balanceWei > reserve ? balanceWei - reserve : 0n;
  const launchesRemaining = feeWei > 0n ? Number(spendableWei / feeWei) : 0;

  const ceilingWei = policy.dailyCapWei * BigInt(policy.maxDailyCaps) + reserve;
  const floorWei = feeWei * BigInt(policy.floorLaunches) + reserve;
  // A target above the ceiling would tell the operator to top up into a balance
  // the very next reading calls over-funded, and they would bounce between two
  // alerts forever. Clamp instead of oscillating.
  const rawTargetWei = feeWei * BigInt(policy.targetLaunches) + reserve;
  const targetWei = rawTargetWei > ceilingWei ? ceilingWei : rawTargetWei;

  let state: HotWalletState;
  if (launchesRemaining < 1) state = 'EMPTY';
  else if (launchesRemaining <= policy.criticalLaunches) state = 'CRITICAL';
  else if (balanceWei < floorWei) state = 'LOW';
  else if (balanceWei > ceilingWei) state = 'OVERFUNDED';
  else state = 'HEALTHY';

  const needsTopUp = state === 'EMPTY' || state === 'CRITICAL' || state === 'LOW';
  const topUpWei = needsTopUp && targetWei > balanceWei ? targetWei - balanceWei : 0n;
  const sweepWei = state === 'OVERFUNDED' ? balanceWei - ceilingWei : 0n;

  return {
    state,
    balanceWei,
    spendableWei,
    gasReserveWei: reserve,
    launchesRemaining,
    floorWei,
    targetWei,
    ceilingWei,
    topUpWei,
    sweepWei,
  };
}

export type AdmissionDecision = { ok: true } | { ok: false; detail: string };

/**
 * The hard gate. Everything else in this module is advice to a human; this is
 * the part that stops the bot from spending money it does not have.
 *
 * Without it the flow deploys a splitter, builds the launch calldata and sends a
 * transaction that reverts for insufficient funds -- the user gets a confusing
 * failure and the treasury still pays gas for the attempt. Refusing up front
 * costs nothing and produces a reply that says something true.
 */
export function canAdmitLaunch(assessment: HotWalletAssessment): AdmissionDecision {
  if (assessment.launchesRemaining >= 1) return { ok: true };
  return {
    ok: false,
    detail:
      `Hot wallet holds ${formatEth(assessment.balanceWei)} ETH, which does not cover one launch ` +
      `fee on top of the ${formatEth(assessment.gasReserveWei)} ETH gas reserve.`,
  };
}

/** Operator-facing instruction. Alerts that only say "something is wrong" get
 *  ignored; this one carries the numbers and addresses needed to act without
 *  opening the codebase. */
export function describeTopUp(
  assessment: HotWalletAssessment,
  addresses: { hot: string; cold?: string | null }
): string {
  const from = addresses.cold && addresses.cold.length > 0 ? addresses.cold : '(cold wallet -- TREASURY_COLD_ADDRESS is not set)';
  return (
    `Send ${formatEth(assessment.topUpWei)} ETH from ${from} to the hot wallet ${addresses.hot}. ` +
    `That restores it to ${formatEth(assessment.targetWei)} ETH, about ` +
    `${assessment.launchesRemaining} launch(es) remaining right now. ` +
    'Canonical bridging takes about 10 minutes (Part 6 §2), so start before it empties.'
  );
}

/** Operator-facing instruction for the opposite problem. */
/**
 * What to do about an overfunded hot wallet -- which is NOT "sweep it to cold".
 *
 * The Turnkey policy that guards this wallet permits transactions to the pons
 * factory and contract creation, and refuses every other destination. That is what
 * makes a leaked signing key cost launches rather than the treasury -- and it
 * applies just as firmly to a transfer out to cold storage. Funds in the hot wallet
 * can only leave as launch fees.
 *
 * So the hot wallet is a one-way valve, and cold storage is its SOURCE, not its
 * drain. Overfunding is corrected by not topping up again until the balance falls,
 * never by moving money back.
 *
 * This function used to instruct the operator to move the excess to cold. That was
 * impossible under the policy the same project had deliberately installed, and it
 * would have been discovered by someone trying to follow it during an incident.
 */
export function describeSweep(
  assessment: HotWalletAssessment,
  addresses: { hot: string; cold?: string | null }
): string {
  return (
    `The hot wallet ${addresses.hot} holds ${formatEth(assessment.balanceWei)} ETH, about ` +
    `${formatEth(assessment.sweepWei)} ETH more than the circuit breaker can ever spend ` +
    `(ceiling ${formatEth(assessment.ceilingWei)} ETH). ` +
    'This cannot be swept: the Turnkey policy allows only the pons factory and contract ' +
    'creation, so nothing can be transferred out. Stop topping this wallet up and let the ' +
    'balance fall, and keep the reserve in cold storage rather than sending it here.'
  );
}

export interface SetupProblem {
  level: 'error' | 'warning';
  message: string;
}

/**
 * Startup sanity checks. These catch the configurations where the split *looks*
 * set up and is not, which is worse than not having it: the operator believes
 * their exposure is bounded when it is not.
 */
export function checkTreasurySetup(params: {
  hotAddress: string;
  coldAddress?: string | null;
  policy: TreasuryPolicy;
  isProduction: boolean;
}): SetupProblem[] {
  const problems: SetupProblem[] = [];
  const { hotAddress, coldAddress, policy, isProduction } = params;

  if (!coldAddress || coldAddress.length === 0) {
    problems.push({
      level: isProduction ? 'error' : 'warning',
      message:
        'TREASURY_COLD_ADDRESS is not set. Without a cold wallet there is no split, and the ' +
        'entire treasury balance is exposed to a hot-key compromise (Part 5 §3.6).',
    });
  } else if (hotAddress.toLowerCase() === coldAddress.toLowerCase()) {
    // The failure this catches is silent by nature: every balance check passes,
    // every alert reads normally, and the blast radius is still 100%.
    problems.push({
      level: 'error',
      message:
        'TREASURY_COLD_ADDRESS is the same address as the hot treasury wallet. The split is ' +
        'not real -- a hot-key compromise takes everything.',
    });
  }

  if (policy.floorLaunches >= policy.targetLaunches) {
    problems.push({
      level: 'error',
      message:
        `HOT_WALLET_FLOOR_LAUNCHES (${policy.floorLaunches}) must be below ` +
        `HOT_WALLET_TARGET_LAUNCHES (${policy.targetLaunches}), or every top-up lands straight ` +
        'back on the floor and alerts continuously.',
    });
  }

  if (policy.criticalLaunches >= policy.floorLaunches) {
    problems.push({
      level: 'warning',
      message:
        `HOT_WALLET_CRITICAL_LAUNCHES (${policy.criticalLaunches}) is not below ` +
        `HOT_WALLET_FLOOR_LAUNCHES (${policy.floorLaunches}), so the "top up soon" warning ` +
        'never fires before the "top up now" one -- there is no early warning.',
    });
  }

  if (policy.maxDailyCaps < 1) {
    problems.push({
      level: 'error',
      message:
        `HOT_WALLET_MAX_DAILY_CAPS (${policy.maxDailyCaps}) is below 1, which caps the hot ` +
        'wallet under a single day of permitted spend. The circuit breaker, not the balance, ' +
        'should be what limits daily volume.',
    });
  }

  if (policy.gasReserveWei <= 0n) {
    problems.push({
      level: 'warning',
      message:
        'TREASURY_GAS_RESERVE_WEI is zero. The launch flow sends two transactions and pays gas ' +
        'for both, so a balance of exactly one fee will fail partway through.',
    });
  }

  return problems;
}

// -- Periodic watch -------------------------------------------------------

export interface TreasuryWatchDeps {
  getBalanceWei: () => Promise<bigint>;
  /** Live, never cached -- same rule as everywhere else the fee is used. */
  getLiveFeeWei: () => Promise<bigint>;
  /**
   * Where a reading goes. In production this is `TreasuryMonitor.checkTreasuryBalance`.
   * It is a plain callback rather than the monitor type so that the policy module
   * stays free of any dependency on the alerting module (and free of the import
   * cycle that would otherwise create).
   */
  report: (balanceWei: bigint, feeWei: bigint, now: Date) => Promise<void>;
}

export interface TreasuryWatchHandle {
  stop(): void;
}

/**
 * Reads the hot wallet on a timer and reports it.
 *
 * The per-launch admission check only runs when someone tweets. A quiet bot with
 * a draining wallet -- or one whose balance was swept by an attacker -- would go
 * unnoticed until the next user was turned away, which is exactly the wrong time
 * to find out. This is the check that runs whether or not anyone is using the bot.
 */
export function startTreasuryWatch(
  deps: TreasuryWatchDeps,
  intervalMinutes = 15
): TreasuryWatchHandle {
  let running = false;

  const tick = async () => {
    if (running) return; // a slow RPC must not stack up overlapping reads
    running = true;
    try {
      const [balanceWei, feeWei] = await Promise.all([deps.getBalanceWei(), deps.getLiveFeeWei()]);
      await deps.report(balanceWei, feeWei, new Date());
    } catch (err: any) {
      // A failed read is not a reason to crash the process, but it is worth
      // seeing: if the RPC is down, the admission check ahead of every launch is
      // failing too, and every launch is being refused.
      console.error('[treasury] balance check failed:', err?.message ?? err);
    } finally {
      running = false;
    }
  };

  // Read once at startup rather than waiting a full interval -- a process that
  // restarts into an empty wallet should say so immediately.
  void tick();

  const timer = setInterval(tick, intervalMinutes * 60 * 1000);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** Short, human-readable ETH for alert text. Wei strings are unreadable at 3am. */
export function formatEth(wei: bigint): string {
  const s = ethers.formatEther(wei);
  // Trim to 6dp without rounding surprises, then strip trailing zeros.
  const [whole, frac = ''] = s.split('.');
  const trimmed = frac.slice(0, 6).replace(/0+$/, '');
  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole;
}
