/**
 * DEADLINES FOR EVERY CALL THE BOT MAKES TO X.
 *
 * None of them had one. `fetch` waits indefinitely by default, and the mention
 * sweep guards against overlapping runs with a `running` flag -- so a single
 * request that never returned would skip every later tick, record neither a
 * success nor a failure, and leave `/status` reading `degraded` ("no successful
 * poll yet since boot") rather than `down`. The alert is driven by consecutive
 * failures, so nobody would ever be told. The bot would stop hearing anybody
 * while every signal available said it was merely warming up.
 *
 * These live in one file because the value matters less than the fact that
 * every call has one, and a number sitting alone beside a `fetch` is the kind
 * that gets copied without its reasoning to the next call that is added.
 */

/** A read the sweep depends on. Well inside the sweep's own deadline. */
export const X_READ_TIMEOUT_MS = 15_000;

/**
 * A reply. Longer than a read because this call is billed: a retry costs real
 * money, so it is worth waiting a little longer before abandoning one.
 */
export const X_WRITE_TIMEOUT_MS = 20_000;
