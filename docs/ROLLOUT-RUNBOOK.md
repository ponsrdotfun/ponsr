# Rollout runbook — current pons V2

For the operator, to be followed in order. Every step is a command or a decision with a
stated abort condition.

**Nothing in this document has been executed.** It describes a rollout that has not
happened.

---

## 0. Before anything

| gate | how | abort if |
|---|---|---|
| Turnkey creation authority **(signer-active)** | `npm run signer:probe-creation` | case 2 is **ALLOWED** — see [TURNKEY-CREATION-AUTHORITY.md](TURNKEY-CREATION-AUTHORITY.md). This is currently open. |
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

The first row blocks everything else. A bot key that can attach funds to a contract
creation can empty the hot wallet, so shipping the launch path before closing it makes
the treasury reachable by anyone who obtains that key.

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

## 2. Order: code before config

Deploy the new code with `PONS_FACTORY_VERSION` **still `v1`**, and confirm the process
is healthy, before flipping anything.

The reverse order produces the state this migration exists to prevent: config naming a
factory the deployed code does not know how to encode for.

```bash
git checkout main && git merge --no-ff migrate/pons-v2-current
git push origin main          # publishes the WEBSITE too — see §6
fly deploy
```

**Mixed state is refused, not tolerated.** With v1 config and v2 code the bot builds v1
calldata for the v1 factory and verifies the v1 deployment — coherent, because the target
carries its own deployment. Nothing silently spans two.

## 3. Flip the version

```bash
fly secrets set PONS_FACTORY_VERSION=v2
```

Then, within five minutes:

```bash
curl -s https://<backend>/status | jq
```

Required, exactly — `/status` reports these as named checks, not top-level fields:

```bash
curl -s https://<backend>/status   | jq -e '.checks[] | select(.name=="deployment")
           | select(.detail | test("pons-v2-current-7ed"))
           | select(.detail | test("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"; "i"))'

curl -s https://<backend>/status   | jq -e '.checks[] | select(.name=="launchpad") | select(.state=="ok")'
```

Both must exit 0. `jq -e` exits non-zero when nothing matches, so an absent check fails
rather than passing quietly — which matters here more than usual, since a missing
`deployment` check is exactly what an older build would produce.

**Abort and set `PONS_FACTORY_VERSION=v1` if** `/status` reports any other deployment id,
the launchpad check is down, or the deployment check is missing. No launch has happened
yet at this point, so a rollback here costs nothing.

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
- the launch confirms but `/status` still reports the old deployment → config and code
  disagree; roll back the flag.

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

`git push origin main` in §2 **already published it** — Netlify auto-deploys from `main`
with no manual step. Two consequences:

- the board reads both V2 deployments, so historical launches stay visible;
- the pause notice now asks the **current** factory. Before this branch it asked the
  superseded one and told every visitor *"pons has new launches switched off
  platform-wide"* — untrue, and a claim about somebody else's product.

There is no separate website deploy step, and no way to ship the backend without shipping
the site. If they must be staged apart, merge the website change on its own commit first.

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

## 7. Public launching

Still off, and not part of this runbook. Enabling it is a separate decision that requires
the canary to have completed §4 and §5 cleanly.

---

## Rollback

Record these BEFORE §2, while the current state is still the good one:

```bash
fly releases --json | jq -r '.[0] | "RELEASE=\(.Version)  IMAGE=\(.ImageRef)"' \
  | tee ./rollback-target.txt
git rev-parse HEAD | tee -a ./rollback-target.txt        # the website commit to revert to
```

| what | how | owner |
|---|---|---|
| config only | `fly secrets set PONS_FACTORY_VERSION=v1` | operator, no approval needed |
| code | `fly deploy --image <IMAGE from rollback-target.txt>` — never "the previous release", which is not a thing you can type | operator |
| database | restore from `backup-manifest-$STAMP.json` — ordered procedure below | operator |
| website | `git revert -m 1 <merge commit>` then push; Netlify republishes from `main` | operator |

After a code rollback, prove it went back rather than assuming:

```bash
curl -s https://<backend>/status | jq -e '.checks[] | select(.name=="deployment")
  | select(.detail | test("pons-v1"))'
```

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
