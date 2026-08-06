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

```bash
fly launch --no-deploy --name ponsr-backend --region sin
```

Answer no to any offer to create a Postgres or Redis instance — the app uses neither. Then
create the volume the database lives on. Without it the deploy fails, which is the intended
behaviour: better a failed deploy than a running bot with a disposable database.

```bash
fly volumes create ponsr_data --region sin --size 1
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

1. **`TREASURY_COLD_ADDRESS`** — see `docs/action-checklist.md` 0.8. Boot reports the setup as
   unhealthy without it, deliberately.
2. **Fund the Turnkey hot wallet on mainnet.** It currently holds nothing. The treasury pays
   every launch fee, so an empty hot wallet means every launch fails at the last step.
3. **Point the X webhook at `https://ponsr-backend.fly.dev`.** Until then the reconciler's
   5-minute sweep is the only path mentions arrive by — it works, but it is the safety net
   rather than the mechanism.
4. **Replace `ConsoleNotifier`.** Alerts currently go to the Fly log, where nobody is watching
   at 3am. It is one line against the `Notifier` interface in `src/monitor.ts`.
