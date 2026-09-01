/**
 * Sends ONE test alert and reports whether it was actually delivered.
 *
 *   npx ts-node scripts/alert-probe.ts --send
 *
 * WHY THIS EXISTS
 * ---------------
 * The alert transport was configured and had never been proven to deliver.
 * `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` being set is not evidence that a
 * message arrives -- it is evidence that two strings exist.
 *
 * This repository has paid for that distinction more than once. The Turnkey
 * policy is verified by SIGNING rather than by trusting a config flag, and
 * `REPLY_INCLUDE_LINK` is published on /status because a clean boot says
 * nothing about a setting's value. An alert path is the same shape and the
 * stakes are higher now: with the public gate open, the treasury spends on
 * strangers' requests, and the alerts are what say when that goes wrong.
 *
 * What would be missed if the path were quietly broken:
 *
 *   CIRCUIT_BREAKER_TRIPPED    the daily cap is reached and launches stopped
 *   FEE_CEILING_EXCEEDED       the network fee moved above what is allowed
 *   TREASURY_EXHAUSTED         the hot wallet cannot fund another launch
 *   MENTION_SWEEP_FAILING      the bot has stopped hearing X at all
 *   LAUNCHPAD_CLOSED           pons closed the factory underneath us
 *
 * The last one and the sweep failure are the likely ones. If X credits run out
 * the sweep starts failing, and that is exactly the moment an operator needs to
 * be told by something other than the thing that just stopped working.
 *
 * REFUSES TO RUN WITHOUT `--send`, because it posts a real message to a real
 * chat. A probe that fires by accident teaches an operator to ignore it.
 */
import { config } from '../src/config';
import { TelegramNotifier, ConsoleNotifier, Alert } from '../src/monitor';

const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(26)} ${value}`);

(async () => {
  const send = process.argv.includes('--send');

  console.log('=== ALERT DELIVERY PROBE ===');
  line('transport', config.TELEGRAM_BOT_TOKEN ? 'Telegram' : 'console only');
  line('chat id set', config.TELEGRAM_CHAT_ID ? 'yes' : 'NO');

  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    console.log('');
    console.log('=== NOT CONFIGURED === alerts would go to the log, where nobody reads them.');
    process.exitCode = 1;
    return;
  }

  if (!send) {
    console.log('');
    console.log('Dry run. This posts a real message to a real chat, so pass --send to do it.');
    return;
  }

  /**
   * Marked as a test in the first line, not only in the body.
   *
   * An operator glancing at a notification sees the first line and nothing
   * else. A probe that looks like a genuine CIRCUIT_BREAKER_TRIPPED is worse
   * than no probe: it trains somebody to distrust the one channel that has to
   * be trusted.
   */
  const alert: Alert = {
    kind: 'MENTION_SWEEP_RECOVERED',
    severity: 'info',
    message:
      'Delivery probe — this is a test, nothing is wrong. ' +
      'Sent by scripts/alert-probe.ts to prove the Telegram path works while the public gate is open.',
    detail: { probe: true, sentBy: 'alert-probe.ts' },
    at: new Date().toISOString(),
  };

  /**
   * The fallback is replaced so a silent failure cannot look like a success.
   *
   * `TelegramNotifier` catches a delivery failure and writes to its fallback,
   * which is what production wants -- an alert that cannot reach Telegram
   * should still reach the log rather than throw inside the monitor. But for a
   * probe that behaviour is exactly wrong: the process would exit 0 having
   * delivered nothing.
   */
  let fellBack = false;
  const witness = {
    async send() {
      fellBack = true;
    },
  };

  const notifier = new TelegramNotifier(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID, witness);

  const startedAt = Date.now();
  try {
    await notifier.send(alert);
  } catch (error: any) {
    console.log('');
    line('threw', String(error?.message ?? error).slice(0, 120));
    console.log('=== INCONCLUSIVE === the send threw, which is not the same as Telegram refusing.');
    process.exitCode = 2;
    return;
  }

  line('elapsed', `${Date.now() - startedAt} ms`);
  console.log('');

  if (fellBack) {
    console.log('=== NOT DELIVERED === Telegram did not accept it and the notifier fell back.');
    console.log('    Check the token, the chat id, and that the bot has been started by that chat.');
    process.exitCode = 1;
    return;
  }

  console.log('=== DELIVERED === Telegram accepted the message.');
  console.log('    Confirm it actually appeared in the chat. An API that accepts is not an');
  console.log('    inbox that shows -- a wrong chat id can be accepted and land nowhere you look.');
  void ConsoleNotifier;
})().catch((err) => {
  console.error('FAILED:', err?.message ?? err);
  process.exit(1);
});
