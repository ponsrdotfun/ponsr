import { Db } from './db';
import { RejectionReason } from './types';
import { config } from './config';
import {
  HotWalletAssessment,
  TreasuryPolicy,
  assessHotWallet,
  describeSweep,
  describeTopUp,
  formatEth,
  treasuryPolicyFromConfig,
} from './treasuryPolicy';

/**
 * Part 5 mitigation #5 -- real-time spend-rate monitoring and alerting.
 *
 * The other mitigations already *stop* an attack: the circuit breaker caps daily
 * spend, the rate limiter caps per-user launches, the anti-Sybil checks turn away
 * fresh accounts. What none of them do is tell anyone it happened. Part 5 is
 * explicit that the Sybil drain is cheapest and most attractive precisely while
 * the bot is new, unmonitored and holding a full treasury -- so a guard that
 * fires silently is only half a defence.
 *
 * This module is the other half. It never blocks anything and never touches the
 * launch path's outcome; it only observes and raises alerts.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';

export type AlertKind =
  | 'VOLUME_SPIKE'
  | 'SYBIL_ATTEMPT'
  | 'CIRCUIT_BREAKER_TRIPPED'
  | 'FEE_CEILING_EXCEEDED'
  | 'TREASURY_LOW'
  /** A launch completed but the person who asked for it could not be told. The token exists
   *  and the fee is spent, so this needs a human to answer them by hand. */
  | 'REPLY_FAILED'
  /** The reply went out without the token address or the transaction hash, because X
   *  refuses crypto addresses from a newly authenticated account. Expected at first;
   *  the way we learn the restriction has lifted is that these stop arriving. */
  | 'REPLY_DEGRADED'
  /** pons has switched launching off on their factory, so no launch can succeed. It is
   *  their switch, not ours, and nothing else reports it: the process stays up, /health
   *  answers ok, and a bot with no mentions looks identical to a bot that cannot launch. */
  | 'LAUNCHPAD_CLOSED'
  | 'LAUNCHPAD_REOPENED'
  /** X's own timeline shows mentions the bot never handled. The sweep is succeeding
   *  and returning nothing, which is indistinguishable from silence without a second
   *  source -- so this is the only alert that can catch a bot gone deaf. */
  | 'MENTION_MISSED'
  /** The mention sweep has failed repeatedly. Nothing else reports this: the process stays
   *  up, /health keeps returning 200, and the bot simply stops hearing anyone. Running out of
   *  twitterapi.io credit looks exactly like this. */
  | 'MENTION_SWEEP_FAILING'
  /** The sweep started working again, so the operator knows the fix took. */
  | 'MENTION_SWEEP_RECOVERED'
  /** Part 5 mitigation #7: the hot wallet needs a cold -> hot transfer. */
  | 'TOP_UP_REQUIRED'
  /** Part 5 mitigation #7: the hot wallet holds more than the bot can ever spend,
   *  so the excess is exposure with no operational benefit. Sweep it to cold. */
  | 'TREASURY_OVERFUNDED'
  /** The hot wallet came back to a healthy level -- confirms a top-up landed,
   *  which is the one thing the operator is actually waiting to hear. */
  | 'TREASURY_RECOVERED'
  | 'LAUNCH_FAILED';

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
  detail?: Record<string, unknown>;
  at: string;
}

/** Where alerts go. Following the project's convention, this is an interface with
 *  a Mock for tests, so a real transport (Telegram, email, PagerDuty) can be
 *  dropped in without touching any of the detection logic below. */
export interface Notifier {
  send(alert: Alert): Promise<void>;
}

/** Default transport. Part 5's own wording -- "monitoring/alerting actually wired
 *  to something you'll see (not just logs no one reads)" -- means this is a
 *  starting point, not the finished job: replace it before mainnet. */
export class ConsoleNotifier implements Notifier {
  async send(alert: Alert): Promise<void> {
    const line = `[ALERT/${alert.severity.toUpperCase()}] ${alert.kind}: ${alert.message}`;
    if (alert.severity === 'critical') console.error(line, alert.detail ?? '');
    else console.warn(line, alert.detail ?? '');
  }
}

/**
 * Sends alerts to a Telegram chat -- the operator's phone, which is the point.
 *
 * Part 5 asks for alerting "wired to something you'll see (not just logs no one reads)".
 * ConsoleNotifier was always a placeholder; on Fly its output goes to a log stream nobody is
 * watching at 3am, which is exactly when a treasury drain would matter.
 *
 * TWO DESIGN DECISIONS THAT LOOK LIKE OVERSIGHTS AND ARE NOT
 * ----------------------------------------------------------
 * 1. It never throws. An alert transport must not be able to break the thing it is watching,
 *    and `recordRejection` runs inside the launch path -- a throw there would turn "Telegram
 *    is briefly unreachable" into a failed launch for a user who did nothing wrong. On any
 *    failure it falls through to the console instead, so the alert still lands in the Fly log.
 *    Nothing is lost; only the delivery channel degrades.
 *
 * 2. No parse_mode. Telegram's Markdown and HTML modes reject messages containing unescaped
 *    special characters, and these alerts carry user-supplied token symbols and JSON detail.
 *    A symbol like `_MOON_` would make the API refuse the message -- an alert lost to
 *    formatting. Plain text always sends.
 */
export class TelegramNotifier implements Notifier {
  constructor(
    private token: string,
    private chatId: string,
    private fallback: Notifier = new ConsoleNotifier()
  ) {}

  private format(alert: Alert): string {
    const lines = [
      `${alert.severity.toUpperCase()} — ${alert.kind}`,
      '',
      alert.message,
    ];
    if (alert.detail && Object.keys(alert.detail).length > 0) {
      // Truncated: Telegram caps a message at 4096 characters, and a detail blob that pushes
      // past it would take the whole alert down with it.
      lines.push('', JSON.stringify(alert.detail, null, 2).slice(0, 1500));
    }
    lines.push('', alert.at);
    return lines.join('\n');
  }

  async send(alert: Alert): Promise<void> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: this.format(alert),
          disable_web_page_preview: true,
        }),
      });
      // Telegram answers 200 only on success, but check the body too: it returns ok:false with
      // a description for things like a bot blocked by the user, which is a delivery failure
      // that a status check alone would read as delivered.
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok !== true) {
        throw new Error(`telegram ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      }
    } catch (err: any) {
      console.error(`[notifier] Telegram delivery failed, falling back to log: ${err?.message ?? err}`);
      await this.fallback.send(alert);
    }
  }
}

/**
 * Picks the alert transport from configuration, preferring Telegram.
 *
 * Falls back to the console rather than refusing to boot: no alerting is bad, but a bot that
 * will not start is worse, and the console path still records everything.
 */
export function createNotifier(): Notifier {
  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    return new TelegramNotifier(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID);
  }
  console.warn('[notifier] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set -- alerts go to the log only.');
  return new ConsoleNotifier();
}

/** Collects alerts in memory so tests can assert on them. */
export class MockNotifier implements Notifier {
  public sent: Alert[] = [];
  async send(alert: Alert): Promise<void> {
    this.sent.push(alert);
  }
  kinds(): AlertKind[] {
    return this.sent.map((a) => a.kind);
  }
  clear() {
    this.sent = [];
  }
}

export interface MonitorThresholds {
  /** Recent window used for the "is this a spike" question. */
  spikeWindowMinutes: number;
  /** Baseline window the recent rate is compared against. */
  baselineWindowHours: number;
  /** How many times the baseline rate counts as a spike. Part 5 says 10x. */
  spikeMultiplier: number;
  /** Minimum launches in the recent window before a spike can be declared, so a
   *  quiet bot going from 0 to 2 launches doesn't page anyone at 3am. */
  spikeMinLaunches: number;
  /** Distinct accounts turned away by an anti-Sybil check inside the spike
   *  window that constitutes an attempt worth reporting. */
  sybilDistinctUsers: number;
}

export const DEFAULT_THRESHOLDS: MonitorThresholds = {
  spikeWindowMinutes: 15,
  baselineWindowHours: 24 * 7,
  spikeMultiplier: 10,
  spikeMinLaunches: 5,
  sybilDistinctUsers: 5,
};

/** Hot/cold split inputs (Part 5 mitigation #7). Separate from the thresholds
 *  above because they answer a different question: those detect an attack in
 *  progress, these describe how much money is standing in front of one. */
export interface TreasuryOptions {
  policy?: TreasuryPolicy;
  hotAddress?: string;
  coldAddress?: string | null;
}

/** Persisted so a restart does not re-page about a state the operator already
 *  saw. A bot that redeploys twice an hour would otherwise alert twice an hour
 *  about the same untouched balance, which trains the operator to ignore it. */
const TREASURY_STATE_KEY = 'treasury:lastAlertedState';

/** Rejection reasons that indicate someone is probing the guards rather than
 *  simply mistyping a tweet. Only these are treated as attack signal. */
const SYBIL_REASONS: RejectionReason[] = ['ACCOUNT_TOO_NEW', 'INSUFFICIENT_FOLLOWERS'];

export class TreasuryMonitor {
  private lastSpikeAlertAt = 0;
  private lastSybilAlertAt = 0;
  /** Alerts are deduplicated inside this window so one incident doesn't produce
   *  a hundred pages -- an alert channel that cries wolf gets muted, which is
   *  the same outcome as having no alerting at all. */
  private readonly cooldownMs: number;

  constructor(
    private db: Db,
    private notifier: Notifier,
    private thresholds: MonitorThresholds = DEFAULT_THRESHOLDS,
    cooldownMinutes = 30,
    private treasury: TreasuryOptions = {}
  ) {
    this.cooldownMs = cooldownMinutes * 60 * 1000;
  }

  /** The hot address comes from an async signer call, so it usually is not known
   *  at construction time. Set it once the signer has answered. */
  setTreasuryAddresses(hotAddress: string, coldAddress?: string | null): void {
    this.treasury = { ...this.treasury, hotAddress, coldAddress };
  }

  /** Called after a launch is recorded. Compares the recent launch rate against
   *  the longer-run baseline and reports a sustained spike. */
  async onLaunchRecorded(now: Date = new Date()): Promise<void> {
    const t = this.thresholds;
    const windowMs = t.spikeWindowMinutes * 60 * 1000;
    const recentFrom = new Date(now.getTime() - windowMs).toISOString();
    const recent = this.db.countLaunchesBetween(recentFrom, now.toISOString());
    if (recent < t.spikeMinLaunches) return;

    const baselineFrom = new Date(now.getTime() - t.baselineWindowHours * 3600 * 1000).toISOString();
    const baselineTotal = this.db.countLaunchesBetween(baselineFrom, recentFrom);
    const baselineWindows = Math.max(1, (t.baselineWindowHours * 60) / t.spikeWindowMinutes - 1);
    const expected = baselineTotal / baselineWindows;

    // With no history at all there is nothing to be a multiple *of*; treat the
    // minimum-launches floor as the bar instead of dividing by zero.
    const isSpike = expected <= 0 ? recent >= t.spikeMinLaunches * 2 : recent >= expected * t.spikeMultiplier;
    if (!isSpike) return;
    if (!this.cooled(this.lastSpikeAlertAt, now)) return;
    this.lastSpikeAlertAt = now.getTime();

    await this.notifier.send({
      kind: 'VOLUME_SPIKE',
      severity: 'critical',
      message:
        `${recent} launches in the last ${t.spikeWindowMinutes} minutes, against a baseline of ` +
        `${expected.toFixed(2)}. Treat as a security event until proven otherwise.`,
      detail: { recent, expectedPerWindow: Number(expected.toFixed(3)), windowMinutes: t.spikeWindowMinutes },
      at: now.toISOString(),
    });
  }

  /** Called on every rejection. Persists it, then reports the patterns that mean
   *  something: a guard actually firing, or many fresh accounts being turned away. */
  async onRejected(
    tweetId: string,
    xUserId: string,
    reason: RejectionReason,
    now: Date = new Date()
  ): Promise<void> {
    this.db.recordRejection(tweetId, xUserId, reason);

    if (reason === 'DAILY_SPEND_CAP_REACHED') {
      await this.notifier.send({
        kind: 'CIRCUIT_BREAKER_TRIPPED',
        severity: 'critical',
        message:
          'Daily treasury spend cap reached -- launches are paused. This is the circuit ' +
          'breaker doing its job; confirm it was real demand and not a drain attempt.',
        detail: { spentLast24hWei: this.db.totalSpendLast24h().toString(), capWei: config.DAILY_SPEND_CAP_WEI.toString() },
        at: now.toISOString(),
      });
      return;
    }

    if (reason === 'FEE_EXCEEDS_CEILING') {
      await this.notifier.send({
        kind: 'FEE_CEILING_EXCEEDED',
        severity: 'warning',
        message:
          'Live launch fee is above the configured ceiling, so launches are being refused. ' +
          'Pons may have raised its fee -- check before raising the ceiling.',
        detail: { ceilingWei: config.TREASURY_MAX_FEE_WEI.toString() },
        at: now.toISOString(),
      });
      return;
    }

    if (SYBIL_REASONS.indexOf(reason) === -1) return;

    const since = new Date(now.getTime() - this.thresholds.spikeWindowMinutes * 60 * 1000).toISOString();
    const distinct = this.db.countDistinctRejectedUsersSince(reason, since);
    if (distinct < this.thresholds.sybilDistinctUsers) return;
    if (!this.cooled(this.lastSybilAlertAt, now)) return;
    this.lastSybilAlertAt = now.getTime();

    await this.notifier.send({
      kind: 'SYBIL_ATTEMPT',
      severity: 'critical',
      message:
        `${distinct} distinct accounts rejected for ${reason} in the last ` +
        `${this.thresholds.spikeWindowMinutes} minutes. The anti-Sybil guard held, but ` +
        'someone is probing it.',
      detail: { reason, distinctAccounts: distinct, windowMinutes: this.thresholds.spikeWindowMinutes },
      at: now.toISOString(),
    });
  }

  /**
   * Called with the hot treasury wallet's on-chain balance and the current launch
   * fee -- Part 5 mitigation #7's reporting half.
   *
   * Alerts fire on *state changes*, not on every reading. The watch runs on a
   * timer, so alerting on every below-floor reading would send the same page
   * every fifteen minutes until the operator acted, and the fastest way to make
   * someone stop reading treasury alerts is to send them ninety of them.
   *
   * Returns the assessment so callers can log the numbers without recomputing.
   */
  async checkTreasuryBalance(
    balanceWei: bigint,
    feeWei: bigint,
    now: Date = new Date()
  ): Promise<HotWalletAssessment> {
    const policy = this.treasury.policy ?? treasuryPolicyFromConfig();
    const a = assessHotWallet(balanceWei, feeWei, policy);
    const addresses = {
      hot: this.treasury.hotAddress ?? '(hot treasury wallet)',
      cold: this.treasury.coldAddress,
    };

    const previous = this.db.getState(TREASURY_STATE_KEY);
    if (previous === a.state) return a;

    const base = {
      balanceWei: balanceWei.toString(),
      feeWei: feeWei.toString(),
      launchesRemaining: a.launchesRemaining,
      state: a.state,
    };

    let alert: Alert | null = null;

    if (a.state === 'EMPTY') {
      alert = {
        kind: 'TREASURY_LOW',
        severity: 'critical',
        message:
          `Hot wallet cannot fund a launch (${formatEth(balanceWei)} ETH). Launch requests are ` +
          `being refused right now. ${describeTopUp(a, addresses)}`,
        detail: { ...base, topUpWei: a.topUpWei.toString() },
        at: now.toISOString(),
      };
    } else if (a.state === 'CRITICAL' || a.state === 'LOW') {
      alert = {
        kind: 'TOP_UP_REQUIRED',
        severity: a.state === 'CRITICAL' ? 'critical' : 'warning',
        message:
          `Hot wallet is ${a.state === 'CRITICAL' ? 'nearly empty' : 'below its operating floor'} ` +
          `(${formatEth(balanceWei)} ETH, ~${a.launchesRemaining} launch(es) left). ` +
          describeTopUp(a, addresses),
        detail: { ...base, floorWei: a.floorWei.toString(), topUpWei: a.topUpWei.toString() },
        at: now.toISOString(),
      };
    } else if (a.state === 'OVERFUNDED') {
      alert = {
        kind: 'TREASURY_OVERFUNDED',
        severity: 'warning',
        message:
          `Hot wallet holds ${formatEth(balanceWei)} ETH, above its ${formatEth(a.ceilingWei)} ETH ` +
          `ceiling. ${describeSweep(a, addresses)}`,
        detail: { ...base, ceilingWei: a.ceilingWei.toString(), sweepWei: a.sweepWei.toString() },
        at: now.toISOString(),
      };
    } else if (previous !== null) {
      // HEALTHY, following a problem. A first reading on a fresh process is not news.
      alert = {
        kind: 'TREASURY_RECOVERED',
        severity: 'info',
        message:
          `Hot wallet is back to a healthy level: ${formatEth(balanceWei)} ETH, ` +
          `~${a.launchesRemaining} launch(es) of headroom.`,
        detail: { ...base, previousState: previous },
        at: now.toISOString(),
      };
    }

    // Send BEFORE recording the state, never after. Recording first means a
    // transient notifier failure -- one timed-out Telegram call -- marks the
    // state as reported and the alert is never retried, so an empty treasury
    // goes unannounced forever. This ordering can at worst duplicate an alert,
    // which is the strictly better failure of the two.
    if (alert) await this.notifier.send(alert);
    this.db.setState(TREASURY_STATE_KEY, a.state);
    return a;
  }

  /** Called when a launch reaches the chain and fails. Every one of these costs
   *  real gas, so a run of them is both a bug signal and a spend leak. */
  /**
   * A reply could not be posted.
   *
   * Severity is critical when a launch already succeeded: the token is on-chain, the treasury
   * paid for it, and the only person who does not know is the one who asked. Nothing in the
   * system will retry it, so it needs a human. For a rejection the stakes are lower -- nobody
   * is owed a token -- but it still means someone was ignored.
   */
  /**
   * The reply went out, but stripped of the token address and the transaction hash.
   *
   * X blocks crypto addresses for the first seven days after an account
   * authenticates, so this is expected at first and then should stop. It is worth
   * an alert rather than a log line for exactly that reason: the reply people
   * actually want has never once been delivered, and the only way to learn that
   * the window has closed is to notice this alert no longer arriving.
   */
  async onReplyDegraded(tweetId: string, detail: string, now: Date = new Date()): Promise<void> {
    await this.notifier.send({
      kind: 'REPLY_DEGRADED',
      severity: 'warning',
      message:
        'X refused the reply for containing a crypto address, so it was answered without the ' +
        'token address or the transaction hash. The person was told their token exists but not ' +
        'where to find it. This stops once X lifts the new-account restriction.',
      detail: { tweetId, error: detail.slice(0, 300) },
      at: now.toISOString(),
    });
  }

  async onReplyFailed(
    tweetId: string,
    detail: string,
    context: Record<string, unknown> = {},
    now: Date = new Date()
  ): Promise<void> {
    const launched = context.stage === 'launched';
    await this.notifier.send({
      kind: 'REPLY_FAILED',
      severity: launched ? 'critical' : 'warning',
      message: launched
        ? 'A token launched but the reply failed, so the person who asked has not been told. ' +
          'The token exists and the fee is spent. Answer them by hand.'
        : 'Could not reply to a mention. Nobody was launched anything, but they were left without an answer.',
      detail: { tweetId, error: detail.slice(0, 300), ...context },
      at: now.toISOString(),
    });
  }

  async onLaunchFailed(tweetId: string, detail: string, now: Date = new Date()): Promise<void> {
    await this.notifier.send({
      kind: 'LAUNCH_FAILED',
      severity: 'warning',
      message: `On-chain launch failed for tweet ${tweetId}: ${detail}`,
      detail: { tweetId, reason: detail },
      at: now.toISOString(),
    });
  }

  private cooled(lastAt: number, now: Date): boolean {
    return now.getTime() - lastAt >= this.cooldownMs;
  }
}

/** No-op monitor, for tests and local runs that don't care about alerting. */
export class NullMonitor extends TreasuryMonitor {
  constructor(db: Db) {
    super(db, { async send() {} });
  }
}
