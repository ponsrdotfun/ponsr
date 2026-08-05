/**
 * Exercises the twitterapi.io read path against the real service.
 *
 *   npx ts-node scripts/check-twitterapi.ts
 *
 * WHY THIS IS NOT OPTIONAL
 * ------------------------
 * The endpoint paths and field names in `TwitterApiIoReader` were written from inference,
 * not from twitterapi.io's documentation. They typecheck, and typechecking proves nothing
 * about a third party's JSON.
 *
 * Two things depend on getting them right, and both fail quietly rather than loudly:
 *
 *   - `getAccountSignals` feeds the anti-Sybil thresholds. If the follower count or the
 *     creation date come back under a different key, every account looks brand new with no
 *     followers, and the bot rejects everyone with a message about their account being too
 *     young. That fails closed, which is the right direction, but it looks like a policy
 *     decision rather than a bug.
 *   - `getRecentMentions` is the reconciler's safety net for dropped webhooks. If it silently
 *     returns nothing, the net is gone and nobody finds out until a user's request vanishes.
 *
 * So this calls both and prints what actually came back.
 */
import { config } from '../src/config';
import { TwitterApiIoReader } from '../src/xClient';

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

(async () => {
  if (!config.TWITTERAPI_IO_KEY) {
    console.error('TWITTERAPI_IO_KEY is not set in backend/.env.');
    process.exit(1);
  }
  const reader = new TwitterApiIoReader(config.TWITTERAPI_IO_KEY, config.BOT_X_HANDLE);

  console.log('=== twitterapi.io ===');
  line('key', `set (${config.TWITTERAPI_IO_KEY.length} chars)`);
  line('watching', '@' + config.BOT_X_HANDLE);

  // 1. Account signals -- the anti-Sybil inputs.
  console.log('\n1. getAccountSignals (feeds the anti-Sybil thresholds)');
  const selfId = '2082527429504172032'; // @ponsrdotfun, from the X credential check
  let signalsOk = false;
  try {
    const s = await reader.getAccountSignals(selfId, config.BOT_X_HANDLE);
    const ageDays = Math.floor((Date.now() - new Date(s.accountCreatedAt).getTime()) / 86400000);
    line('accountCreatedAt', `${s.accountCreatedAt}  (~${ageDays} days old)`);
    line('followerCount', s.followerCount);

    // A response that parsed but produced nonsense is the failure worth catching: the
    // thresholds would then be applied to numbers that mean nothing.
    const sane = !Number.isNaN(ageDays) && ageDays >= 0 && Number.isFinite(s.followerCount);
    line('values are sane', sane ? 'yes ✅' : '>>> NO — parsed, but the numbers are wrong');
    signalsOk = sane;
    console.log(`\n  Against the configured thresholds (${config.MIN_ACCOUNT_AGE_DAYS} days, ` +
      `${config.MIN_FOLLOWER_COUNT} followers): this account would ` +
      `${ageDays >= config.MIN_ACCOUNT_AGE_DAYS && s.followerCount >= config.MIN_FOLLOWER_COUNT ? 'PASS' : 'be REJECTED'}.`);
  } catch (err: any) {
    console.error('  FAILED:', String(err?.message ?? err).slice(0, 300));
    console.error('\n  If this is a 404, the endpoint path is wrong. If it parsed but found no');
    console.error('  fields, the key names differ -- the error above lists what the payload');
    console.error('  actually contained, which is what to map to.');
  }

  // 2. Mentions -- the reconciler's safety net.
  console.log('\n2. getRecentMentions (the dropped-webhook safety net)');
  let mentionsOk = false;
  try {
    const since = new Date(Date.now() - 90 * 86400000).toISOString();
    const mentions = await reader.getRecentMentions(since);
    line('window', 'last 90 days');
    line('mentions returned', mentions.length);
    mentionsOk = true;

    if (mentions.length === 0) {
      console.log('\n  Zero is plausible -- the account is new and nobody has tagged it. But it is');
      console.log('  also exactly what a wrong endpoint returns, and the two are indistinguishable');
      console.log('  from here. Tag @' + config.BOT_X_HANDLE + ' from any account and re-run: if it');
      console.log('  still reads zero, the query is wrong rather than the world being quiet.');
    } else {
      const m = mentions[0];
      console.log('\n  Most recent, with the fields the pipeline needs:');
      line('  tweetId', m.tweetId || '>>> EMPTY');
      line('  authorXUserId', m.authorXUserId || '>>> EMPTY');
      line('  authorHandle', m.authorHandle || '(empty)');
      line('  createdAt', m.createdAt);
      line('  text', JSON.stringify(m.text.slice(0, 70)));
      // tweetId is the idempotency key and authorXUserId resolves the wallet. Either being
      // empty means the launch pipeline cannot run, however healthy the call looked.
      const usable = Boolean(m.tweetId && m.authorXUserId);
      line('  usable by the bot', usable ? 'yes ✅' : '>>> NO — a required field is empty');
      mentionsOk = usable;
    }
  } catch (err: any) {
    console.error('  FAILED:', String(err?.message ?? err).slice(0, 300));
  }

  console.log('\n=== RESULT ===');
  line('account signals', signalsOk ? 'OK ✅' : 'needs mapping ❌');
  line('mention polling', mentionsOk ? 'OK ✅' : 'needs mapping ❌');
  process.exit(signalsOk && mentionsOk ? 0 : 1);
})().catch((err) => {
  console.error('FAILED:', err?.message ?? err);
  process.exit(1);
});
