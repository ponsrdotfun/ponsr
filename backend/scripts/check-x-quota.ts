/**
 * Reads the X project's post quota, which OAuth 1.0a cannot see.
 *
 *   npx ts-node scripts/check-x-quota.ts
 *
 * /2/usage/tweets answers only to OAuth 2.0 App-Only, so this is the one place a bearer token
 * is used. The bot never writes with it: a reply has to come from the account, which needs
 * user context.
 *
 * Written after POST /2/tweets began returning a persistent 503 while reads succeeded and the
 * token reported READ AND WRITE. Quota and plan were the remaining explanations that could be
 * checked from outside the developer console.
 */
import { config } from '../src/config';

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

(async () => {
  if (!config.X_BEARER_TOKEN) {
    console.error('X_BEARER_TOKEN is not set in backend/.env.');
    process.exit(1);
  }
  console.log('=== X PROJECT QUOTA ===\n');

  const url = 'https://api.x.com/2/usage/tweets';
  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.X_BEARER_TOKEN}` } });
  const body: any = await res.json().catch(() => ({}));

  line('HTTP', res.status);
  if (!res.ok) {
    line('detail', JSON.stringify(body).slice(0, 300));
    console.log('\nA 403 here usually means the app is not attached to a project with an');
    console.log('active plan -- which is also what would make writes fail while reads work.');
    process.exit(1);
  }

  const d = body?.data ?? {};
  line('project id', d.project_id ?? '-');
  line('plan cap', d.project_cap ?? '-');
  line('used this period', d.project_usage ?? '-');
  line('cap reset day', d.cap_reset_day ?? '-');
  console.log('\nFull payload:');
  console.log(JSON.stringify(body, null, 2).slice(0, 1200));
})().catch((err) => {
  console.error('FAILED:', err?.message ?? err);
  process.exit(1);
});
