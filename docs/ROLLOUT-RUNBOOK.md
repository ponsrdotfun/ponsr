# Rollout runbook — current pons V2

For the operator, to be followed in order. Every step is a command or a decision with a
stated abort condition.

**Nothing in this document has been executed.** It describes a rollout that has not
happened.

---

## 0. Before anything

| gate | how | abort if |
|---|---|---|
| Turnkey creation authority | `npm run probe:creation` | case 2 is **ALLOWED** — see [TURNKEY-CREATION-AUTHORITY.md](TURNKEY-CREATION-AUTHORITY.md). This is currently open. |
| Policy verified **for the rollout target** | `npm run verify:policy -- --target-deployment=pons-v2-current-7ed` | anything other than **PASSED** |
| Artifacts reproduce | `node scripts/verify-artifacts-reproducible.js` | **NOT REPRODUCIBLE** |
| Suites | `cd backend && npm run build && npx jest`, `npm test`, `node website/smoke-test.js` | any failure |
| Live identity | `RPC_URL=… CHAIN_ID=4663 npm run verify:ethcall` | anything but **PASSED** |
| Fresh install | `npm ci` at root **and** `backend/` | any resolution error |

Every command above runs a **pinned local binary** through an npm script. Do not type
`npx` during a rollout: it fetches whatever the registry serves at that moment, and
this sequence moves treasury funds.

The `--target-deployment` flag is not optional. Without it the verifier passes on
whatever `PONS_FACTORY_VERSION` currently names -- and §3 flips that setting minutes
later, so a gate that went green about the old value proves nothing about the new one.

The first row blocks everything else. A bot key that can attach funds to a contract
creation can empty the hot wallet, so shipping the launch path before closing it makes
the treasury reachable by anyone who obtains that key.

## 1. Back up

**Do not `cp` a live SQLite file.** The database runs in WAL mode, so at any instant the
`.sqlite` file is missing whatever sits in `-wal` and a plain copy is a torn snapshot:
it opens, it looks fine, and it is missing the most recent writes -- which for this
database are exactly the launches you would be restoring to recover.

Stop the writer, or use SQLite's online backup. Stopping is simpler and this is a
planned change:

```bash
# 1. Stop the only writer.
fly scale count 0 --yes

# 2. Consistent copy, checkpointed and timestamped.
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
fly ssh console -C "sqlite3 /data/bot.sqlite \".backup '/data/bot.sqlite.$STAMP'\""

# 3. Prove the copy is a database, not a file of the right size.
fly ssh console -C "sqlite3 /data/bot.sqlite.$STAMP 'PRAGMA integrity_check;'"
fly ssh console -C "sqlite3 /data/bot.sqlite.$STAMP 'PRAGMA foreign_key_check;'"

# 4. Record what you have, so a restore can be checked against it later.
fly ssh console -C "sha256sum /data/bot.sqlite.$STAMP; ls -l /data/bot.sqlite.$STAMP"
```

Required before continuing:

- `integrity_check` returns exactly `ok`;
- `foreign_key_check` returns nothing;
- the size is non-zero and the checksum is written down somewhere outside the machine.

`.backup` is SQLite's own online backup: it checkpoints the WAL and produces a single
consistent file. `sqlite3 X ".backup Y"` on a stopped writer is belt and braces, and it
is what makes step 3 meaningful.

**Verify the restore in isolation before you need it**, on a scratch path rather than
over the live file:

```bash
fly ssh console -C "cp /data/bot.sqlite.$STAMP /data/restore-test.sqlite"
fly ssh console -C "sqlite3 /data/restore-test.sqlite 'SELECT COUNT(*) FROM launches;'"
fly ssh console -C "rm /data/restore-test.sqlite"
```

A backup nobody has restored is a backup nobody has.

The provenance migration is **additive and in-place**. There is nothing to undo, so this
copy *is* the rollback plan -- `tests/provenanceMigration.test.ts` proves a copy taken
beforehand restores the legacy schema exactly, and that pre-migration queries still work
against a migrated file.

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
npm run collect:v2 -- <splitterAddress> --token=<launchedToken>              # dry run
npm run collect:v2 -- <splitterAddress> --token=<launchedToken> --execute
```

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

| what | how | owner |
|---|---|---|
| config only | `fly secrets set PONS_FACTORY_VERSION=v1` | operator, no approval needed |
| code | `fly deploy` the previous release | operator |
| database | restore `/data/bot.sqlite.pre-v2` | operator |
| website | revert the merge commit and push | operator |

The database restore is the only one with a deadline: rows written after the migration
carry provenance columns the old code does not select, which is harmless — but rows
written after the restore point are simply gone.

**A launched token cannot be rolled back.** Once §4 confirms, that token exists on chain
permanently. Everything above this line is reversible; that is not.

---

## Contradictions this document resolves

Two things in the repository disagreed before this was written, and both are settled here:

- **signer state.** `RawKeyTreasurySigner` refuses to run under `NODE_ENV=production` and
  `TREASURY_SIGNER_PRIVATE_KEY` must not be set there. But `collect-and-split-v2.ts`
  requires that key. It is an **operator-run script for testnet and for local dry runs**;
  on mainnet the claim is permissionless, so anyone — including a wallet the owner
  controls directly — can call `claimAndSplit`. It does not need the bot's key.
- **removed env variables.** `PONS_V2_FACTORY_ADDRESS` and `PONS_V2_FEE_ESCROW_ADDRESS`
  were deleted on 2026-08-20. They may still sit in a `.env` somewhere; they are read by
  nothing. `PONS_V2_APPROVALS_FROM_BLOCK` is likewise no longer read — the scanner takes
  the deployment's own start block.
