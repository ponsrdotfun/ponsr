import * as crypto from 'crypto';

/**
 * Shared-secret gate for the mention webhook.
 *
 * WHY THIS EXISTS
 * ---------------
 * Without it, `/webhook/mention` is an unauthenticated way to spend the treasury. A POST of
 * `{id, author_id, text}` is indistinguishable from a real mention, so anyone who finds the
 * URL can make the bot launch tokens and pay the fee for each one.
 *
 * The caller does not even need the X account they claim. The anti-Sybil checks look the
 * handle up at twitterapi.io, so naming any established account satisfies the account-age and
 * follower thresholds. Per-user limits are keyed on the claimed author id, which the caller
 * also chooses, so varying it defeats them too. The daily spend cap is the only real bound:
 * one day's cap, per day, for as long as it goes unnoticed -- while replies are posted
 * publicly from @ponsrdotfun until it is suspended for spam.
 *
 * It lives in its own module so it can be tested. index.ts opens the database and starts the
 * server as import side effects, so a test that imported the guard from there would boot the
 * whole bot.
 */

/** The subset of an express request this needs. Kept structural so tests need no HTTP server. */
export interface AuthorisableRequest {
  header(name: string): string | undefined;
  query: Record<string, unknown>;
}

export function webhookAuthorised(req: AuthorisableRequest, expected: string | undefined): boolean {
  // Fails CLOSED. With no secret configured the endpoint refuses everything rather than
  // falling back to accepting everything -- the reconciliation sweep still delivers mentions,
  // so a misconfiguration costs five minutes of latency rather than the treasury.
  if (!expected) return false;

  // A header or a query parameter, because webhook providers differ in what they let you
  // configure and a check that cannot be satisfied gets disabled rather than fixed.
  const fromHeader = req.header('x-webhook-secret');
  const fromQuery = typeof req.query.secret === 'string' ? req.query.secret : undefined;
  const provided = fromHeader || fromQuery;
  if (!provided) return false;

  // Constant time, so a caller cannot recover the secret one character at a time by measuring
  // how long the comparison takes. timingSafeEqual throws on length mismatch, so length is
  // checked first -- that leaks the length, which is not the secret.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
