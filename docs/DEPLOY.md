# Deploying the backend

The website deploys itself — Netlify builds from `main` on every push. This document is only
about `backend/`, the listener that has to run continuously.

Target is **Fly.io**. `backend/fly.toml` and `backend/Dockerfile` carry the reasoning inline;
this is the operator's runbook.

---

## Why not the simpler options

Two requirements rule out most one-click hosts, and both are about the database rather than
about traffic.

**A persistent disk is mandatory.** `processed_tweets` is the idempotency key for every
mention the bot has handled, and `treasury_spend_log` is what the daily circuit breaker counts
against. On an ephemeral filesystem, a redeploy re-opens every handled mention for
reprocessing *and* resets the day's spend to zero. Nothing errors — the bot relaunches tokens
it has already launched, paying the fee again, with the cap that was meant to bound the damage
freshly cleared.

**Exactly one instance may run.** This is not a stateless request/response service. It sweeps
for dropped webhooks every 5 minutes and checks the treasury balance every 15. Two copies race
on the same mentions, and since each Fly machine gets its own volume, the second copy shares
none of the first's idempotency state. **Never `fly scale count 2`.**

---

## First deploy

Run everything from `backend/`, which is where `fly.toml` and the `Dockerfile` live.

**Do not use the dashboard's "Launch from GitHub".** It builds from the repository root, where
there is no Dockerfile, and it generates its own `fly.toml` — discarding the volume, the
`auto_stop_machines = false` and the `min_machines_running = 1` that the two constraints above
depend on. It also wires auto-deploy on every push to `main`. That suits the website, which is
static; this process holds the treasury, and when it redeploys should be a decision.

`fly launch` is avoided for the same reason: it rewrites `fly.toml`. Creating the app directly
never touches it.

```bash
fly auth login
fly apps create ponsr-backend
```

Then the volume the database lives on. Without it the deploy fails, which is the intended
behaviour: better a failed deploy than a running bot with a disposable database.

The region must match `primary_region` in `fly.toml` (`iad`). A machine cannot mount a volume
from a different region, and the symptom is a deploy whose machine never places rather than an
error naming the region.

```bash
fly volumes create ponsr_data --region iad --size 1 -a ponsr-backend
```

Set the secrets. These never enter the image — an image layer is readable by anyone who can
pull it, and `.env` is in `.dockerignore` for that reason.

```bash
fly secrets set \
  OPENROUTER_API_KEY=... \
  TWITTERAPI_IO_KEY=... \
  PRIVY_APP_ID=... \
  PRIVY_APP_SECRET=... \
  TURNKEY_ORGANIZATION_ID=... \
  TURNKEY_API_PUBLIC_KEY=... \
  TURNKEY_API_PRIVATE_KEY=... \
  TURNKEY_SIGN_WITH=... \
  X_API_KEY=... \
  X_API_SECRET=... \
  X_ACCESS_TOKEN=... \
  X_ACCESS_TOKEN_SECRET=...
```

Then the non-secret configuration, which differs from the development `.env` in ways that
matter:

```bash
fly secrets set \
  RPC_URL=https://rpc.mainnet.chain.robinhood.com \
  CHAIN_ID=4663 \
  PONS_FACTORY_ADDRESS=... \
  PONS_LOCKER_ADDRESS=... \
  TURNKEY_POLICY_CONFIRMED=true \
  TREASURY_COLD_ADDRESS=... \
  BOT_X_HANDLE=ponsrdotfun \
  SITE_BASE_URL=https://ponsr.fun \
  DAILY_SPEND_CAP_WEI=... \
  TREASURY_MAX_FEE_WEI=... \
  TREASURY_GAS_RESERVE_WEI=... \
  MIN_ACCOUNT_AGE_DAYS=... \
  MIN_FOLLOWER_COUNT=... \
  MAX_LAUNCHES_PER_USER_PER_DAY=...
```

Copy the anti-abuse thresholds from the local `.env` rather than inventing them — each maps to
a scenario in Part 5's audit.

```bash
fly deploy
```

The image is verified to build and run (2026-08-06): it starts as the non-root `node` user,
carries no compiler, and contains no `.env`, `scripts/` or `tests/`. It refuses to start on a
read-only mount, boots on a writable volume, and the database survives across containers.

### Live since 2026-08-11

Deployed and running. The boot log is clean end to end:

```
Database at /data/bot.sqlite (configured, not the default).
Ponsr backend listening on port 8080 (production)
Hot treasury wallet 0x08e0…74Fa; cold 0x1148…431d.
[ALERT/INFO] TREASURY_RECOVERED: 0.027668 ETH, ~51 launch(es) of headroom.
```

No `[treasury/error]`, no `[storage/error]`, health check passing, `/health` returning 200.
`checkTreasurySetup` reports no problems — the first time it has.

An earlier deploy the same morning was scaled to zero on purpose, before the hot wallet held
anything: deploying makes the bot answer real people, and it would have been answering
requests it could not complete. Stopping the machine is not enough on its own, because
`auto_start_machines = true` lets Fly's proxy restart it on any inbound HTTP request and the
hostname is public. Scaling to zero is the state that holds; keep that in mind if the bot ever
needs taking off the air in a hurry.

### Two variables that must NOT be set

- **`TREASURY_SIGNER_PRIVATE_KEY`.** Production signs through Turnkey, with a policy that
  refuses any destination but the factory. `RawKeyTreasurySigner` already refuses to construct
  itself under `NODE_ENV=production`, so setting this cannot enable it — it would only place a
  key with unrestricted authority in an environment that has no use for it. It stays local,
  for the operator scripts (`phase-b-launch.ts`, `collect-and-split.ts`).
- **`ANTHROPIC_API_KEY`**, unless one is actually obtained. Empty is fine; `createParser()`
  falls through to OpenRouter. Setting it to an empty string is not the same as leaving it
  unset in some shells — leave it out entirely.

`NODE_ENV`, `PORT` and `DATABASE_PATH` come from `fly.toml` and should not be set as secrets.

---

## Verifying the deploy

Watch the boot log, which is where the checks that matter announce themselves:

```bash
fly logs
```

Three lines to look for, all of them written specifically so a broken deploy is loud:

- `Database at /data/bot.sqlite (configured, not the default).` — the wording is deliberate:
  nothing can portably verify that a path is a real mount, so the line reports what was
  configured and claims nothing more. If it instead reports `[storage/error]`, the process
  **exits rather than starting** — a bot that listens with an unwritable database spends the
  launch fee and then cannot record that it did, so the next sweep launches the same request
  again. A production deploy still on the development default is reported as an error too.
- `Hot treasury wallet 0x… ; cold 0x… .` — anything at `[treasury/error]` means the hot/cold
  split is not real. A missing cold address, or one equal to the hot wallet, is a split that
  looks configured and is not.
- No parser error. A missing parser credential now refuses to boot rather than failing on the
  first mention.

Then confirm the service answers:

```bash
fly status
curl https://ponsr-backend.fly.dev/health
```

---

## Redeploying

```bash
fly deploy
```

The process handles `SIGTERM` by stopping the reconciler and treasury watch, then closing the
database, so an in-flight launch is not cut off mid-transaction. Deploys are safe to run
during quiet periods without further ceremony.

---

## What still has to happen before this is a live bot

Deploying does not make the bot operational. Outstanding, in order:

1. ~~`TREASURY_COLD_ADDRESS`~~ — set 2026-08-11.
2. ~~Fund the Turnkey hot wallet~~ — 0.027668 ETH, about 51 launches.
3. ~~Replace `ConsoleNotifier`~~ — done 2026-08-11. Alerts go to Telegram (`@PonsrLogs_Bot`).
   Delivery was verified against the real chat; the console remains the fallback, so a
   Telegram outage degrades the channel rather than losing the alert.
4. **Finish the mention webhook.** The filter rule exists at twitterapi.io
   (`rule_id ab620f8f51a04b7f99b2237ef12af110`, tag `ponsr-mentions`, value `@ponsrdotfun`,
   10s interval) but is **inactive** (`is_effect: 0`) until the delivery URL is set.

   The URL cannot be set through the API — twitterapi.io takes it in their dashboard only.
   Get it with `npx ts-node scripts/print-webhook-url.ts`; it is not written down anywhere
   because it carries `WEBHOOK_SECRET`. Their dashboard accepts a URL and nothing else, so the
   secret rides as a query parameter — which is why `webhookAuthorised` accepts that form.

   Then activate: POST `/oapi/tweet_filter/update_rule` with the rule's `rule_id`, `tag`,
   `value`, `interval_seconds` and `is_effect: 1`.

   Until it is active the reconciliation sweep is the only path mentions arrive by. It works —
   it is the safety net doing the mechanism's job, which means every reply is up to five
   minutes late.
