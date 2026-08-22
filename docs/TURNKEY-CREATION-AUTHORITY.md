# The bot key can drain the treasury

**Status: OPEN.** Measured 2026-08-21. Closing it requires an explicit operator ceremony;
ordinary install, test, audit, and rollout commands do not mutate Turnkey.

---

## What was measured

`scripts/turnkey-probe-creation.ts`, signing only, nothing broadcast:

```text
1. creation, value 0 (splitter)              ALLOWED   <- intended
2. creation carrying 1 ETH                   ALLOWED   <- the finding
3. creation with unrelated initcode          ALLOWED   <- residual
4. transfer to an arbitrary address          denied    <- the check everyone ran
```

## Why every previous check missed it

The bot's policy is:

```text
ponsr-bot: launch + splitter deploy only
  eth.tx.to == '0xa5aab3f0…feb' || eth.tx.to == ''
```

`eth.tx.to == ''` is a contract creation, and the bot needs it: every launch deploys a
per-launch `FeeSplitterV2` first.

Every verifier written for this policy asked about **destinations**. A contract creation
does not have one — that is the whole reason the empty-string clause exists. So the
question "can this key send funds somewhere it shouldn't?" was asked four times and each
time in a form that a creation slips past.

A creation carries `value` exactly as a transfer does, and the ETH lands in the contract
being created. The sender writes that contract. Six lines of Solidity in a constructor
forwards the balance anywhere:

```solidity
constructor() payable { payable(ATTACKER).transfer(address(this).balance); }
```

One transaction, the entire hot wallet, and `3. tx to an arbitrary address → denied ✅`
still prints green on the way past, because no arbitrary address was ever named.

## What this makes false

Until this is closed, these statements are **wrong** and have been corrected in place:

<!-- historical -->
- `CLAUDE.md` — "a leak of the bot's key now costs launches, not the treasury"
- `BUILD-STATUS.md` — "A leak of that key costs launches, not the treasury."
- `docs/MIGRATION-ACCEPTANCE-2026-08-20.md` §6
- `docs/WRITER-BOT-BRIEF.md`
- `scripts/turnkey-verify-policy.ts` — printed it on PASS
<!-- /historical -->

The verifier now runs the funded-creation case as check 4 and **cannot report PASSED**
while it is allowed.

---

## Two ways to close it

Turnkey's policy language does support the fields needed. Confirmed against
`docs.turnkey.com/concepts/policies/language`:

| field | type | note |
|---|---|---|
| `eth.tx.value` | int | "the amount being sent (in wei)" |
| `eth.tx.data` | string | hex-encoded calldata |
| `eth.tx.chain_id` | int | |
| `eth.tx.function_name` | string | only when an ABI is uploaded |
| `eth.tx.contract_call_args['name']` | mapping | only when an ABI is uploaded |

Operators: `== != < > <= >=` on ints, `== !=` on strings, `&& ||`, `in`, and string
slicing `'abc'[0..2]`. Note **snake_case** — `chain_id`, not `chainId`.

### Option A — bind value on the creation clause

```text
ponsr-bot: splitter deploy, zero value
  eth.tx.to == '' && eth.tx.value == 0
```

Narrowest change, keeps one key. The splitter constructor is not payable and the bot
never attaches value to a deploy, so this costs nothing operationally.

**Do not trust it until an executed negative probe proves enforcement.** Grammar being
documented is not the same as a rule biting: `turnkey-probe-creation.ts` case 2 must flip
to `denied`, and case 1 must stay `ALLOWED`. A rule that denies both breaks launching; a
rule that denies neither is the status quo wearing a new name.

Residual after Option A: initcode is still unbound (case 3), so any **zero-value**
contract may be deployed. That costs gas, not treasury. Recorded as residual risk, not
claimed protection.

### Option B — take creation authority off the treasury key

A second Turnkey user, funded only with gas, holds the sole creation grant. The treasury
signer keeps `eth.tx.to == '<factory>'` and loses `|| eth.tx.to == ''` entirely.

Stronger, because it removes the capability rather than constraining it, and the blast
radius of the deployer key becomes its own small balance. Costs an extra key to fund,
monitor and rotate, and the orchestrator must sign with two identities in one launch.

### Also worth binding while the policy is being edited (finding 2)

Destination-only is thin after an API-key compromise. Every field below is supported:

```text
ponsr-bot: launch on pons-v2-current-7ed
  eth.tx.to == '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'
  && eth.tx.chain_id == 4663
  && eth.tx.data[0..10] == '0xf35abbcf'
  && eth.tx.value <= 2000000000000000
```

The value ceiling is `TREASURY_MAX_FEE_WEI` (0.002 ETH), which already bounds the fee in
`validator.ts`. Anything above the live launch fee is treated by pons as an initial buy,
so a ceiling here stops the bot buying into a token it launched for somebody else.

`eth.tx.data[0..10]` uses documented string slicing but has **not been executed** here.
Before relying on it, `verify-current-ethcall.ts`'s exact production calldata must sign
and a wrong-selector mutation must be denied. Until then it is a proposal, not a control.

---

## Operator steps

1. Choose Option A or B. A is smaller; B is stronger.
2. Apply it with a root credential, from the dashboard or a one-shot script.
3. Run `npm run signer:probe-creation` and require:
   - case 1 `ALLOWED` — the bot can still deploy its splitter;
   - case 2 `denied` — the finding is closed;
   - case 4 `denied` — the original control still holds.
4. Run `npm run signer:verify-policy` and require PASSED.
5. Only then may any document say a leaked bot key cannot reach the treasury.

### What this repository CAN do, stated plainly

An earlier version of this line said nothing here performs steps 1-2. That was wrong, and
the correction matters more than the sentence: three scripts can change the live Turnkey
organisation, and one of them used to do it without being asked.

| script | reads | signs | mutates | writes credentials |
|---|:--:|:--:|:--:|:--:|
| `turnkey-read-policies.ts` | ✓ | | | |
| `turnkey-verify-policy.ts` | ✓ | ✓ | | |
| `turnkey-probe-creation.ts` | ✓ | ✓ | | |
| `turnkey-allow-v2-factory.ts` | ✓ | | **createPolicy** | |
| `turnkey-scope-bot-user.ts` | ✓ | | **createUser, createApiKeys, createPolicy** | writes a separate bot-key file plus non-secret recovery JSON; **never `.env`** |
| `turnkey-policy-probe.ts` | ✓ | ✓ | **createPolicy(DENY-ALL), deletePolicy** | |

The last row is the dangerous one. It applies a deny-everything policy to find out whether
policies bite, then removes it in a `finally`. **While that policy exists nothing in the
organisation can sign** -- and if the process dies in between, or the delete fails, it
stays that way. That is the same outage that cost a day on 2026-08-20, reached from the
other direction.

It ran on its name alone until 2026-08-21. It now requires `--execute` **and**
`--acknowledge=I-UNDERSTAND-THIS-DISABLES-SIGNING`, prints the policy id unmistakably
before anything can be lost, and verifies the deletion by re-reading the policy list
rather than trusting that `deletePolicy` returned. If it cannot prove the deletion it
raises an incident and exits non-zero.

`tests/turnkeyAuthority.test.ts` holds this matrix and fails if a mutation entrypoint
stops asking, or if a script classified read-only grows a mutating call.

`scripts/authority-manifest.json` is the complete inventory for every executable under
`backend/scripts`, not only Turnkey entrypoints. Root credentials remain operator inputs and
must live outside the bot's environment and are read from the explicit `--root-key-file`.
The scoped bot key is written only to the exact `--bot-key-output` path, while
`--recovery-output` records non-secret created IDs and a
`planned`, `partial`, or `complete` state so interrupted ceremonies can be recovered. Scoping
requires exact organization/user/policy targets, `--execute`, and a typed acknowledgement.
Afterward use `npm run signer:verify-policy`; do not use the deny-all probe as routine proof.

**None of these scripts belong in ordinary install, test, audit or rollout verification.**
Running one is an operator ceremony that names the exact script and the exact mutation.
