# Rollout runbook — current pons V2

For the operator, to be followed in order. Every step is a command or a decision with a
stated abort condition.

**Nothing in this document has been executed.** It describes a rollout that has not
happened.

---

## 0. Before anything

| gate | how | abort if |
|---|---|---|
| Turnkey creation authority **(signer-active)** | `npm run signer:probe-creation` | case 2 must be **denied**, case 1 **ALLOWED**. Closed 2026-08-22 by `b647cc07-…`; re-run to confirm it still holds. Case 3 stays ALLOWED as an accepted residual — see [TURNKEY-CREATION-AUTHORITY.md](TURNKEY-CREATION-AUTHORITY.md). |
| Policy verified for the rollout target **(signer-active)** | `npm run signer:verify-policy -- --target-deployment=pons-v2-current-7ed` | anything other than **PASSED** |
| Artifacts reproduce | `node scripts/verify-artifacts-reproducible.js` | **NOT REPRODUCIBLE** |
| Suites | `cd backend && npm run build && npm test`, then `npm test` and `node website/smoke-test.js` at the root | any failure |
| Live identity | `RPC_URL=… CHAIN_ID=4663 npm run verify:ethcall` | anything but **PASSED** |
| Fresh install | `npm ci` at root **and** `backend/` | any resolution error |

Every command above runs a **pinned local binary** through an npm script. Do not type
`npx` during a rollout: it fetches whatever the registry serves at that moment, and
this sequence moves treasury funds.

The `--target-deployment` flag is not optional. Without it the verifier passes on
whatever `PONS_FACTORY_VERSION` currently names -- and §3 flips that setting minutes
later, so a gate that went green about the old value proves nothing about the new one.

**Two of these gates SIGN.** `probe:creation` and `verify:policy` send real signing
requests to Turnkey. They never broadcast and no value moves -- but they use the bot's
API credential, consume signing quota, and appear in the Turnkey activity log as signer
activity by that key. They are not read-only tests and must not be run as part of
ordinary install verification or CI.

Run them deliberately, once, as an operator ceremony: know why you are running them,
expect the activity entries, and do not repeat them to "check again". The keyless
alternatives -- `npm run read:policies` for what the rules say, `npm run verify:ethcall`
for the chain -- answer most questions without signing anything.

**Never run an admin or mutation script here.** `turnkey-allow-v2-factory.ts`,
`turnkey-scope-bot-user.ts` and `turnkey-policy-probe.ts` change the live Turnkey
organisation -- the last one creates a deny-everything policy that stops the whole
organisation signing while it exists. None of them belongs in install, tests, audit or
rollout verification. Running one is a separate operator ceremony that names the exact
script and the exact mutation, and it is not part of this runbook. The authority matrix
is in [TURNKEY-CREATION-AUTHORITY.md](TURNKEY-CREATION-AUTHORITY.md).

The first row blocked everything else until 2026-08-22, when policy `b647cc07-…` bound
`eth.tx.value == 0` on the creation clause and the broad `897d432e-…` was removed. Re-run it
rather than trusting this paragraph: a bot key that can attach funds to a contract creation
can empty the hot wallet, and the only evidence that it cannot is a probe that says so
today. Case 3 stays ALLOWED by design — initcode is unbound, which costs gas and never
treasury.

## 1. Online SQLite backup and offline rehearsal

This workflow is keyless: it reads no `.env`, signing key, network provider, or LIVE service.
It uses `better-sqlite3`'s SQLite online backup API, so the WAL snapshot remains consistent
while the one application writer continues committing. The CLI validates `integrity_check`,
`foreign_key_check`, and the application `launchCount` before emitting a strict JSON manifest.
The manifest has exactly schema, version, absolute source/backup paths, SHA-256, byte size,
numeric mode/UID/GID, and ISO timestamp. Malformed, stale (default: seven days), path-mismatched,
size-mismatched, or checksum-mismatched manifests fail closed.

The Docker image runs Node directly as PID 1. There is no supervisor. Do not use process-pattern
killing and do not scale to zero. Backup is online; restore/rehearsal is fenced later by stopping
the application machine and attaching its volume to a separate maintenance machine. All `fly`
commands below run in the **operator's local shell**, never inside `-C`.

```bash
cd backend
APP=ponsr-backend
APP_MACHINE=$(fly machine list --app "$APP" --json | jq -er 'map(select(.state=="started"))[0].id')
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP=/data/backups/bot.sqlite.$STAMP
REMOTE_MANIFEST=/data/backups/backup-manifest-$STAMP.json
LOCAL_MANIFEST=./backup-manifest-$STAMP.json

# Online: the application writer may remain active.
fly ssh console --app "$APP" --machine "$APP_MACHINE"   -C "npm run maintenance:db -- backup --source /data/bot.sqlite --backup $BACKUP --manifest $REMOTE_MANIFEST"

# Persist the strict JSON manifest off-machine. Abort if transfer or strict parse fails.
fly ssh sftp get "$REMOTE_MANIFEST" "$LOCAL_MANIFEST" --app "$APP"
node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(x.schema!=="ponsr.sqlite-maintenance"||x.version!==1) process.exit(1); console.log(x)' "$LOCAL_MANIFEST"
```

The backup command validates the snapshot before success. Any failed integrity_check,
foreign_key_check, missing `launches` table, or unreadable `launchCount` aborts before manifest
publication.

### Offline rehearsal on a separately fenced maintenance machine

Do this in the restore window. It intentionally stops the only application machine first;
stopping the Fly machine is the real PID-1 fence. Capture its exact image and volume before
stopping it. Abort unless the image is digest-qualified and the app machine is actually stopped.

```bash
IMAGE=$(fly machine status "$APP_MACHINE" --app "$APP" --json | jq -er '.config.image')
case "$IMAGE" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) echo 'image is not digest-qualified' >&2; exit 1;; esac
VOLUME_ID=$(fly volumes list --app "$APP" --json | jq -er '.[] | select(.name=="ponsr_data") | .id')
REGION=$(fly volumes list --app "$APP" --json | jq -er '.[] | select(.id=="'"$VOLUME_ID"'") | .region')
fly machine stop "$APP_MACHINE" --app "$APP"
test "$(fly machine status "$APP_MACHINE" --app "$APP" --json | jq -r .state)" = stopped

# A distinct, disposable maintenance machine mounts the stopped writer's volume.
fly machine run "$IMAGE" --app "$APP" --region "$REGION" --volume "$VOLUME_ID:/data" --rm   --entrypoint /bin/sh -- -lc   "npm run maintenance:db -- rehearse --manifest $REMOTE_MANIFEST --destination /data/restore-rehearsal-$STAMP.sqlite --offline"
```

Require JSON with `integrity: "ok"`, `foreignKeyViolations: 0`, and expected numeric `launchCount`.
Do not start the application between rehearsal and a restore decision.

**Evidence status:** unit/build tests exercise the CLI and concurrent-writer fixture; this Fly
maintenance ceremony is **not LIVE-tested** by this repository work.

## 2. Fence public launching before the deploy

Production already carries `PONS_FACTORY_VERSION=v2`. The stale running image interprets that
as the superseded factory; current `main` interprets it as `pons-v2-current-7ed`, where the
public gate is open. **Deploying is therefore the migration cut-over.** The old instruction to
deploy under v1 and flip afterwards is not the state that exists and must not be followed.

Set Ponsr's independent gate first. The stale image does not read this setting, so its existing
behaviour is unchanged; current code reads it before the paid parser, wallet creation, chain
reads, splitter deployment, signing, or broadcast.

```bash
fly secrets set PUBLIC_LAUNCH_ENABLED=false
fly secrets list | grep -E '^(PUBLIC_LAUNCH_ENABLED|PONS_FACTORY_VERSION|TURNKEY_POLICY_CONFIRMED)'
```

Abort unless all three names are present, the signer-active probes in §0 passed for the current
deployment, and `TURNKEY_POLICY_CONFIRMED` has been set deliberately. Secret values are not
shown by Fly; the post-deploy status check below proves how the running process interpreted the
public-launch gate.

## 3. Deploy current code while public launching remains paused

Record the rollback image in §Rollback first, then:

```bash
git checkout main
git pull --ff-only origin main
fly deploy
```

`git push` is not a rollout command here: PR #1 and the documentation closures are already on
`main`, and an unrelated push also publishes the website. Deploy the exact reviewed commit.

Within five minutes:

```bash
curl -s https://<backend>/status | jq
```

Required, exactly — `/status` reports these as named checks, not top-level fields:

```bash
curl -s https://<backend>/status   | jq -e '.checks[] | select(.name=="deployment")
           | select(.detail | test("pons-v2-current-7ed"))
           | select(.detail | test("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"; "i"))'

curl -s https://<backend>/status   | jq -e '.checks[] | select(.name=="launchpad") | select(.state=="ok")'

curl -s https://<backend>/status   | jq -e '.checks[] | select(.name=="public-launches")
           | select(.state=="degraded") | select(.detail | test("paused by Ponsr"))'
```

All three must exit 0. The overall status is deliberately `degraded` while Ponsr's gate is
paused; that is containment working, not an outage. `jq -e` exits non-zero when nothing
matches, so an absent check fails rather than passing quietly.

**Abort and roll back the exact image recorded below** if `/status` reports any other deployment,
the upstream launchpad is not ready, the Ponsr pause check is absent/not paused, or the machine
is unstable. Do not compensate by enabling public launches. No launch has happened yet, so
rollback remains reversible.

## 4. Canary: one self-dealt launch

The first launch goes to a wallet the owner controls. Not a user's.

```bash
cd backend
PAIR_WITH=ETH npm run launch:canary                # dry run first
PAIR_WITH=ETH npm run launch:canary -- --execute
```

Spend ceiling for the canary: **0.002 ETH** (`TREASURY_MAX_FEE_WEI`). The live launch fee
is 0.0005 ETH; anything approaching the ceiling means the fee moved and the run should be
abandoned rather than pushed through.

The script now asserts deployment identity before it spends anything — chain id, runtime
hash, ABI hash, selector, escrow. It had none of that until 2026-08-21.

Abort criteria, any one of them:

- identity assertion fails → the contract is not what the registry describes;
- the splitter deploys but the launch reverts → **stop**, do not retry. A retry deploys a
  second splitter and pays a second fee. Record the splitter address; it is not lost,
  and `collect-and-split-v2.ts` can still reach it;
- the launch confirms but `/status` reports anything except the current deployment → stop
  public launching and restore the exact recorded image. Do not change factory selection
  while reconciling a transaction that already landed.

## 5. Reconcile the fees

After the canary has traded at least once:

```bash
cd backend

# Dry run. Reads only -- no key is read, nothing is signed, nothing is sent.
npm run collect:v2 -- <splitterAddress> --token=<launchedToken>

# Execute. This SIGNS and BROADCASTS a claim transaction.
COLLECTOR_OPERATOR_PRIVATE_KEY=0x... \
  npm run collect:v2 -- <splitterAddress> --token=<launchedToken> --execute
```

The dry run needs no credential at all, and demanding one would be backwards -- it would
make the safe path require the dangerous input.

Execute is an operator ceremony. `claimAndSplit` is **permissionless**: anyone may call
it, and it pays only the creator and treasury addresses fixed immutably when the splitter
was deployed. So any funded wallet you control works, and the sender gains nothing by
being the treasury.

**Do not use the bot's key.** `TREASURY_SIGNER_PRIVATE_KEY` is testnet-only, refuses to
run under `NODE_ENV=production`, and belongs to the identity whose Turnkey policy exists
precisely so it cannot move funds freely. Supply the key inline for the one command, as
above, so it is not written to a file. Nothing here prints or persists it.

`--token` is required unless the launch records are on the same machine. Every splitter
the bot deploys carries `token()` = zero -- it is created before the token exists -- so
the collector cannot infer it, and refuses to guess rather than claiming against nothing.
The canary output in §4 prints the exact command with the token filled in.

The script now **reconciles rather than reports**: it measures both recipients' balances
before and after, requires creator = floor(claimed x 9500/10000) with the remainder to
the treasury, requires zero left in the splitter and the escrow, prints machine-readable
evidence, and exits non-zero on any mismatch. A reverted claim is fatal, not narrated.

Require the final line to read **RECONCILED**. Anything else means the fee path is not
settled, and the escrow binding failure has no recovery.

Remember the locker takes 30% first, so the creator's real share of trading fees is
**66.5%** and the treasury's is **3.5%**. Those two numbers are the only ones that may
appear in user-facing copy.

## 6. The website

The migration and documentation changes are already on `main`, so Netlify has already handled
the website independently of this Fly deployment. There is no website command in this rollout.

- the board reads both V2 deployments, so historical launches stay visible;
- the pause notice asks the **current** factory. Before the migration it asked the superseded
  one and made a platform-wide claim from the wrong contract.

A future push to `main` publishes the website automatically; `fly deploy` does not. Keep those
two release surfaces separate rather than manufacturing an unrelated push during a backend
cut-over.

## 6b. Remove retired secrets

Three settings were deleted from the code. They are read by nothing, so leaving them set
changes no behaviour -- but an operator reading `fly secrets list` cannot tell a live
setting from a dead one, and that ambiguity is what makes somebody "fix" a value that
does nothing.

Do this **after** the backup in §1, so a mistake is recoverable:

```bash
# What is actually set right now.
fly secrets list

# Remove the three that no longer have a reader. Safe to run if they are absent.
fly secrets unset PONS_V2_FACTORY_ADDRESS PONS_V2_FEE_ESCROW_ADDRESS PONS_V2_APPROVALS_FROM_BLOCK

# Locally, if a developer .env still carries them.
grep -nE '^(PONS_V2_FACTORY_ADDRESS|PONS_V2_FEE_ESCROW_ADDRESS|PONS_V2_APPROVALS_FROM_BLOCK)=' backend/.env
```

`fly secrets unset` restarts the app, so do it in the same window as another restart
rather than on its own. Confirm afterwards that `fly secrets list` no longer names them.

## 7. Public launching — separate, post-canary decision

Still off after deployment. Enabling it requires §4 and §5 to have completed cleanly, the
canary launch and fee receipt to reconcile, `/status` to name the current deployment, and no
unresolved incident.

```bash
fly secrets set PUBLIC_LAUNCH_ENABLED=true
curl -s https://<backend>/status | jq -e '.checks[] | select(.name=="public-launches")
         | select(.state=="ok") | select(.detail | test("explicit Ponsr operator"))'
```

That secret change restarts the app. Verify one machine, one volume, a fresh `/health`, the
current deployment check, zero restart loop, and the daily spend ledger before announcing
availability. To pause without changing factory selection:

```bash
fly secrets set PUBLIC_LAUNCH_ENABLED=false
```

---

## Rollback

Record these BEFORE §2, while the current state is still the good one:

```bash
fly releases --json | jq -r '.[0] | "RELEASE=\(.Version)  IMAGE=\(.ImageRef)"' \
  | tee ./rollback-target.txt
git rev-parse HEAD | tee -a ./rollback-target.txt        # the website commit to revert to
printf '%s\n' 'ROLLBACK_EXPECTED_DEPLOYMENT=pons-v2-superseded-a5a' \
  | tee -a ./rollback-target.txt
```

| what | how | owner |
|---|---|---|
| contain public launches | `fly secrets set PUBLIC_LAUNCH_ENABLED=false` | operator; do this first |
| deployment selection | do not change during incident response; restore the exact image below | operator |
| code | `fly deploy --image <IMAGE from rollback-target.txt>` — never "the previous release", which is not a thing you can type | operator |
| database | restore from `backup-manifest-$STAMP.json` — ordered procedure below | operator |
| website | `git revert -m 1 <merge commit>` then push; Netlify republishes from `main` | operator |

The captured stale image interprets the production value `PONS_FACTORY_VERSION=v2` as
`pons-v2-superseded-a5a`; it does **not** report a named deployment check. After restoring it,
prove the old image/config tuple is the one running rather than falsely expecting `pons-v1`:

```bash
grep -Fx 'ROLLBACK_EXPECTED_DEPLOYMENT=pons-v2-superseded-a5a' ./rollback-target.txt
curl -s https://<backend>/health | jq -e '.status == "ok"'
curl -s https://<backend>/status \
  | jq -e '[.checks[] | select(.name=="deployment")] | length == 0'
```

The absent deployment check is accepted only for this exact recorded rollback image. It is
not evidence that an unknown runtime is safe, and it is why rollback is containment rather
than completion: keep `PUBLIC_LAUNCH_ENABLED=false` and investigate before any new launch.

"Deploy the previous release" is not an executable instruction. An image digest and a
release number are.

### Restoring the database

Restore requires both physical fencing and explicit `--offline`. Use the §1 variables. The
strict JSON manifest is validated again before replacement. The CLI preserves the current DB,
`-wal`, and `-shm` sidecars under unique `.failed-*` names, stages and validates the backup,
replays numeric UID/GID/mode, swaps it into place, then reruns `integrity_check`,
`foreign_key_check`, and the application launch query (reported as `launchCount`).

```bash
# Fail closed: the application machine must still be stopped.
test "$(fly machine status "$APP_MACHINE" --app "$APP" --json | jq -r .state)" = stopped

# Separately fenced restore process/machine; no application process runs beside it.
fly machine run "$IMAGE" --app "$APP" --region "$REGION" --volume "$VOLUME_ID:/data" --rm   --entrypoint /bin/sh -- -lc   "npm run maintenance:db -- restore --manifest $REMOTE_MANIFEST --destination /data/bot.sqlite --offline"

# Only successful restore JSON permits restart.
fly machine start "$APP_MACHINE" --app "$APP"
curl -s https://<backend>/status | jq -e '.checks[] | select(.state!="down")'
```

Abort and leave the app machine stopped on a non-zero exit, manifest rejection, integrity/FK
failure, launch-count surprise, owner/mode mismatch, or missing preserved artifact. Retain all
`.failed-*` evidence until incident closure. Fly lifecycle commands are local operator commands;
none is hidden in a remote shell. This restore ceremony is **not LIVE-tested** here.

**A launched token cannot be rolled back.** Once §4 confirms, that token exists on chain
permanently. Everything above this line is reversible; that is not.

---

## Contradictions this document resolves

Two things in the repository disagreed before this was written, and both are settled here:

- **signer state.** `RawKeyTreasurySigner` refuses to run under `NODE_ENV=production` and
  `TREASURY_SIGNER_PRIVATE_KEY` must not be set there.

  <!-- historical -->
  This entry used to say `collect-and-split-v2.ts` requires that key and is for local dry
  runs. That stopped being true on 2026-08-21 and the entry did not: the collector reads
  with a provider and no credential at all, and asks for
  `COLLECTOR_OPERATOR_PRIVATE_KEY` only under `--execute`.
  <!-- /historical -->
- **removed env variables.** `PONS_V2_FACTORY_ADDRESS` and `PONS_V2_FEE_ESCROW_ADDRESS`
  were deleted on 2026-08-20. They may still sit in a `.env` somewhere; they are read by
  nothing. `PONS_V2_APPROVALS_FROM_BLOCK` is likewise no longer read — the scanner takes
  the deployment's own start block.
