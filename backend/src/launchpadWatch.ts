import { Notifier } from './monitor';

/**
 * Watches the one switch that is not ours to hold.
 *
 * `launchEnabled` lives on pons's factory and pons can flip it at any time. On
 * 2026-08-12 at 19:42 UTC they did, on both v1 and v2, and nothing on our side
 * noticed for three days: the process stayed up, /health kept answering ok, the
 * treasury kept its balance, and every launch request would have been correctly
 * refused with a message nobody was watching for.
 *
 * The bot already behaves well when this happens -- the readiness check runs
 * before any money moves, so the fee is never spent into a revert and the person
 * is told plainly that the cause is upstream. What was missing was anyone finding
 * out. That is what this is for, and it deliberately does not wait for traffic:
 * a bot with no mentions and a closed launchpad looks exactly like a bot with no
 * mentions.
 *
 * Alerts once on the way down and once on the way back, because a repeat every
 * interval for a condition that lasts days teaches everyone to mute the channel.
 */

export interface LaunchpadWatchDeps {
  getLaunchReadiness(): Promise<{ launchEnabled: boolean; whitelisted: boolean }>;
}

export interface LaunchpadWatchHandle {
  stop(): void;
  /** Exposed for tests: runs one cycle immediately. */
  check(): Promise<void>;
}

export function startLaunchpadWatch(
  deps: LaunchpadWatchDeps,
  notifier: Notifier,
  intervalMinutes = 15,
  /** Named in the alert. Two factories are watched -- the one the bot launches
   *  through and the one a whitelist is being requested on -- and an alert that
   *  did not say which would send someone to check the wrong contract. */
  label = 'the launchpad'
): LaunchpadWatchHandle {
  let closed = false;
  let running = false;

  const check = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const r = await deps.getLaunchReadiness();
      // Whitelisting is what the switch is for: it only applies while launching is
      // globally off, so a whitelisted treasury can still launch and this is not an
      // outage for us.
      const blocked = !r.launchEnabled && !r.whitelisted;

      if (blocked && !closed) {
        closed = true;
        await notifier.send({
          kind: 'LAUNCHPAD_CLOSED',
          severity: 'critical',
          message:
            `pons has switched launching off on ${label} and this treasury is not whitelisted, so ` +
            'no launch can succeed there. Requests are refused before any money moves and the ' +
            'person is told the cause is upstream -- but the bot cannot launch anything until ' +
            'this changes, and nothing else would have reported it.',
          at: new Date().toISOString(),
        });
      } else if (!blocked && closed) {
        closed = false;
        await notifier.send({
          kind: 'LAUNCHPAD_REOPENED',
          severity: 'info',
          message: r.launchEnabled
            ? `pons has switched launching back on for ${label}. The bot can launch again there.`
            : `This treasury is now whitelisted on ${label}, so it can launch there even with ` +
              'launching globally off. This is the grant that was asked for.',
          at: new Date().toISOString(),
        });
      }
    } catch (err) {
      // An unreadable factory is an RPC problem, reported by /status and by the
      // sweep's own failure alerts. Guessing "closed" here would page someone for
      // somebody else's network, and guessing "open" would hide a real closure --
      // so this holds its previous belief rather than inventing a new one.
      console.error('[launchpad] could not read readiness:', (err as Error)?.message ?? err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(check, Math.max(1, intervalMinutes) * 60_000);
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }
  return { stop: () => clearInterval(timer), check };
}
