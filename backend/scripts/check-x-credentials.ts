/**
 * Verifies the X credentials, including the part that usually goes wrong.
 *
 *   npx ts-node scripts/check-x-credentials.ts              # nothing is posted
 *   npx ts-node scripts/check-x-credentials.ts --post-test  # posts, then deletes
 *
 * TWO SEPARATE QUESTIONS
 * ----------------------
 *   1. Are the credentials valid?          -> GET /2/users/me
 *   2. Do they have WRITE permission?      -> see below
 *
 * The second is the one that bites. X's developer console generates an access token with
 * whatever permission the app had *at that moment*, and the default is read-only. A
 * read-only token authenticates perfectly, passes every "are my credentials working" check,
 * and then fails the first time the bot tries to reply -- in production, to a real user.
 *
 * Write permission is established without posting: send a deliberately invalid create-tweet
 * request and read the status code.
 *
 *   403 -> the token may not write at all      (permission problem)
 *   400 -> the token may write; the body was bad (permission fine)
 *
 * The distinction is the whole test. `--post-test` posts a real reply-less tweet and deletes
 * it immediately, for anyone who would rather see it than infer it -- it is briefly public on
 * @ponsrdotfun, which is why it is opt-in.
 */
import * as crypto from 'crypto';
import { config } from '../src/config';

const POST_TEST = process.argv.includes('--post-test');

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

function oauthHeader(method: string, url: string): string {
  const params: Record<string, string> = {
    oauth_consumer_key: config.X_API_KEY!,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: config.X_ACCESS_TOKEN!,
    oauth_version: '1.0',
  };
  const enc = (s: string) =>
    encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join('&');
  const base = [method.toUpperCase(), enc(url), enc(paramString)].join('&');
  const signingKey = `${enc(config.X_API_SECRET!)}&${enc(config.X_ACCESS_TOKEN_SECRET!)}`;
  params.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  return (
    'OAuth ' +
    Object.keys(params)
      .sort()
      .map((k) => `${enc(k)}="${enc(params[k])}"`)
      .join(', ')
  );
}

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: oauthHeader(method, url),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, text };
}

(async () => {
  console.log('=== X CREDENTIALS ===');
  const missing = (['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'] as const)
    .filter((k) => !config[k]);
  for (const k of ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'] as const) {
    line(k, config[k] ? `set (${config[k]!.length} chars)` : '>>> MISSING');
  }
  if (missing.length) {
    console.error('\nFill these in backend/.env first.');
    process.exit(1);
  }

  // --- 1. Valid at all? ---
  console.log('\n1. Authentication');
  const me = await call('GET', 'https://api.x.com/2/users/me');
  if (me.status !== 200) {
    console.error(`  FAILED (${me.status}): ${me.text.slice(0, 200)}`);
    console.error('\n  401 usually means one of the four values is wrong or was truncated on');
    console.error('  copy. 403 here can mean the app is not attached to a project.');
    process.exit(1);
  }
  const account = JSON.parse(me.text)?.data;
  line('authenticated as', `@${account?.username} (${account?.id})`);
  if (account?.username && account.username.toLowerCase() !== config.BOT_X_HANDLE.toLowerCase()) {
    console.warn(`  ⚠️  BOT_X_HANDLE is "${config.BOT_X_HANDLE}" but these credentials post as`);
    console.warn(`      "@${account.username}". The bot would watch one account and reply from`);
    console.warn('      another, which nobody would notice until the first reply went out.');
  }

  // --- 2. Write permission, without posting ---
  console.log('\n2. Write permission');
  const probe = await call('POST', 'https://api.x.com/2/tweets', {});
  if (probe.status === 403) {
    line('result', 'READ-ONLY ❌');
    console.error('\n  The token cannot post. This is the common trap: X generates the access');
    console.error('  token with whatever permission the app had at that moment, and the default');
    console.error('  is read-only. Changing the app permission afterwards does NOT upgrade an');
    console.error('  existing token.');
    console.error('\n  Fix: developer console -> your app -> User authentication settings ->');
    console.error('  App permissions = "Read and write" -> save -> then REGENERATE the access');
    console.error('  token. The regeneration is the step people skip.');
    process.exit(1);
  }
  if (probe.status === 400) {
    line('result', 'READ AND WRITE ✅');
    console.log('  (400 = the empty body was rejected, not the permission. A read-only token');
    console.log('   never gets that far -- it is refused with 403 before the body is read.)');
  } else if (probe.status === 402) {
    line('result', 'NO CREDITS ⚠️');
    console.log('  X returned "credits depleted". The credentials are fine -- X moved to');
    console.log('  pay-per-use and the account has no balance, so nothing can be posted yet.');
    console.log('');
    console.log('  Buy credits: console.x.com -> Billing -> Credits.');
    console.log('  At $0.015 a reply, $10 is roughly 660 replies. A reply containing a URL is');
    console.log('  $0.200, which is why REPLY_INCLUDE_LINK defaults to off.');
    console.log('');
    console.log('  NOTE: this does NOT confirm write permission. Billing was checked before the');
    console.log('  scope was, so a read-only token would look identical here. Once credits are');
    console.log('  loaded, re-run: a 400 confirms write, a 403 means the token is read-only and');
    console.log('  must be regenerated after setting the app to Read and write.');
    process.exit(2);
  } else {
    line('result', `inconclusive (HTTP ${probe.status})`);
    console.log('  ' + probe.text.slice(0, 160));
    console.log('  Re-run with --post-test to settle it by actually posting.');
  }

  // --- 3. Optional: prove it by doing it ---
  if (POST_TEST) {
    console.log('\n3. Post test (will be deleted immediately)');
    const text = `ponsr credential check ${Date.now()}`;
    const posted = await call('POST', 'https://api.x.com/2/tweets', { text });
    if (posted.status !== 201 && posted.status !== 200) {
      console.error(`  POST FAILED (${posted.status}): ${posted.text.slice(0, 200)}`);
      process.exit(1);
    }
    const id = JSON.parse(posted.text)?.data?.id;
    line('posted', id);
    const del = await call('DELETE', `https://api.x.com/2/tweets/${id}`);
    line('deleted', del.status === 200 ? 'yes' : `FAILED (${del.status}) -- delete ${id} by hand`);
  }

  console.log('\n=== PASSED ===');
  console.log('Reads go to twitterapi.io; this account is what replies come from.');
})().catch((err) => {
  console.error('FAILED:', err?.message ?? err);
  process.exit(1);
});
