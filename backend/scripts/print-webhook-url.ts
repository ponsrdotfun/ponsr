/**
 * Prints the webhook URL to paste into twitterapi.io's dashboard.
 *
 *   npx ts-node scripts/print-webhook-url.ts
 *
 * The secret is carried as a QUERY PARAMETER rather than a header, because twitterapi.io's
 * dashboard takes a URL and nothing else -- there is no field for a custom header, and their
 * documentation describes no signature scheme. `webhookAuthorised` accepts either form for
 * exactly this reason: a check a provider cannot satisfy gets switched off rather than fixed.
 *
 * What that costs, stated plainly: the secret lives in twitterapi.io's configuration and
 * appears in the URL of every delivery, so it may sit in their request logs. It is a shared
 * secret with one job -- proving a caller is allowed to submit mentions -- and rotating it is
 * two steps: regenerate WEBHOOK_SECRET, then paste the new URL into the dashboard. It grants
 * nothing else and is not reused anywhere.
 *
 * This is printed by a script rather than written into any document because the URL contains
 * the secret. Run it, copy the line, and do not paste it into a chat or an issue.
 */
import { config } from '../src/config';

const base = process.env.PUBLIC_BASE_URL ?? 'https://ponsr-backend.fly.dev';

if (!config.WEBHOOK_SECRET) {
  console.error('WEBHOOK_SECRET is not set in backend/.env.');
  console.error('Without it the endpoint refuses every request by design, so there is no URL to give out.');
  process.exit(1);
}

console.log('\nPaste this as the webhook URL in twitterapi.io:\n');
console.log(`  ${base}/webhook/mention?secret=${config.WEBHOOK_SECRET}`);
console.log('\nIt contains the secret. Treat it like a password: not into chat, not into a commit.');
console.log('If it leaks, regenerate WEBHOOK_SECRET, run `fly secrets set WEBHOOK_SECRET=...`,');
console.log('and paste the new URL back into the dashboard.\n');
