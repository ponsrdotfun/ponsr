# The bot key could drain the treasury

**Status: CLOSED — 2026-08-22.** Closed by an operator ceremony and proven by an executed
negative probe, not by a policy being written.

<!-- historical -->
It read **Status: OPEN**, measured 2026-08-21, from the day the finding was raised until
the ceremony below. That state is preserved rather than deleted: the reason every guard in
this repository exists is that the finding was once live, and a document that erases its
own history leaves the guards looking arbitrary.
<!-- /historical -->

| | |
|---|---|
| Replacement policy | `b647cc07-a7fe-4941-914c-2c1032392f80` |
| Removed | `897d432e-16f4-4a5e-b16e-42c365508ec6` |
| Condition now | `(eth.tx.to == '' && eth.tx.value == 0) \|\| eth.tx.to == '0xa5aab3f0…feb'` |
| Proven by | `signer:probe-creation` and `signer:verify-policy`, both PASSED |
| Broadcast | none — signing only, no funds moved |

**Measured 2026-08-22, against the new policy:**

```text
1. creation, value 0 (splitter)              ALLOWED   <- the bot still deploys splitters
2. creation carrying 1 ETH                   denied    <- THE FINDING, CLOSED
3. creation, unrelated initcode, value 0     ALLOWED   <- accepted residual, see below
4. transfer to an arbitrary address          denied    <- the original control still holds
1a. tx to the v1 factory                     ALLOWED
1b. tx to the CURRENT factory                ALLOWED
```

Case 2 is the whole finding: measured `ALLOWED` on 2026-08-21 and `denied` on 2026-08-22.

`verify-policy`'s creation case signs the **actual splitter bytecode**, not a ten-byte
prefix, so what is proven is that the real deployment path still works — not merely that
creation in general is permitted.

## The accepted residual — read this before claiming initcode is protected

**Initcode is not bound.** Any **zero-value** contract may still be deployed by the bot key.

That costs **gas, never treasury**: a zero-value creation has nothing to carry away, and the
constructor trick that made this finding dangerous depends entirely on value riding along.

This is the designed limit of Option A, recorded as accepted residual risk. It is **not**
protection, and no document may describe it as one. Closing it would require binding
initcode, or moving creation authority to a separate gas-only key (Option B below).

## What is NOT true because of this closure

The following remain false, and closing the finding does not touch them:

- the backend is **not** deployed with this change — the running image predates it;
- `PONS_FACTORY_VERSION` has **not** been flipped to the current V2;
- **no canary has been run**;
- `TURNKEY_POLICY_CONFIRMED` has **not** been set.

---

## What was measured when the finding was raised

<!-- historical -->
2026-08-21, `scripts/turnkey-probe-creation.ts`, signing only, nothing broadcast. This is
the state that has since been closed; the current readings are at the top of this file.

```text
1. creation, value 0 (splitter)              ALLOWED   <- intended
2. creation carrying 1 ETH                   ALLOWED   <- the finding
3. creation with unrelated initcode          ALLOWED   <- residual
4. transfer to an arbitrary address          denied    <- the check everyone ran
```
<!-- /historical -->

## Why every previous check missed it

The bot's policy **was** (`897d432e`, since deleted):

<!-- historical -->
```text
ponsr-bot: launch + splitter deploy only
  eth.tx.to == '0xa5aab3f0…feb' || eth.tx.to == ''
```
<!-- /historical -->

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

These statements were **wrong** while the finding was open, and were corrected in place.
They are listed so the corrections are traceable, not to be reinstated -- each is still
false in the specific form quoted, because the residual below means no document may claim
initcode is bound:

<!-- historical -->
- `CLAUDE.md` — "a leak of the bot's key now costs launches, not the treasury"
- `BUILD-STATUS.md` — "A leak of that key costs launches, not the treasury."
- `docs/MIGRATION-ACCEPTANCE-2026-08-20.md` §6
- `docs/WRITER-BOT-BRIEF.md`
- `scripts/turnkey-verify-policy.ts` — printed it on PASS
<!-- /historical -->

The verifier runs the funded-creation case as check 4 and **cannot report PASSED** while
it is allowed. On 2026-08-22 it reported PASSED with that case `denied`, which is what
closed this finding.

---

## Two ways to close it — A was chosen and applied on 2026-08-22

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

### Option A — bind value on the creation clause — **CHOSEN 2026-08-22**

The decision is locked, and the condition below is the exact text to apply. It is not
the bare form first sketched here, and the difference matters.

```text
ponsr-bot: v1 factory + zero-value splitter deploy
  (eth.tx.to == '' && eth.tx.value == 0)
  || eth.tx.to == '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb'
```

**The v1 clause is carried over deliberately.** The policy being replaced,
`897d432e-16f4-4a5e-b16e-42c365508ec6`, grants two things at once — the v1 factory *and*
contract creation — and only the creation half is being changed. Replacing it with the
bare `eth.tx.to == '' && eth.tx.value == 0` would silently revoke the v1 grant as well:
`turnkey-verify-policy.ts` case 1a would fail on a configuration that is otherwise
correct, and a rollout that runs the backend on `PONS_FACTORY_VERSION=v1` would find its
launches refused by the policy engine rather than by the launchpad — two different
faults that produce the same silence.

The consensus clause must be byte-identical to the existing one:

```text
approvers.any(user, user.id == '009b2000-01e2-4984-9326-5bb743bf007a')
```

That user id is confirmed, not assumed: `getWhoami` resolves the runtime API key to
`009b2000-01e2-4984-9326-5bb743bf007a` / `ponsr-bot`. Get the consensus wrong and the bot
stops being an approver of its own rule, which denies every launch.

Narrowest change, keeps one key. The splitter constructor is not payable and the bot
never attaches value to a deploy, so this costs nothing operationally.

#### Required outcomes, all six

| case | required | source |
|---|---|---|
| zero-value splitter creation | ALLOWED | probe 1 |
| creation carrying value | **denied** | probe 2 |
| unrelated initcode, zero value | ALLOWED — accepted residual | probe 3 |
| transfer to an arbitrary address | denied | probe 4 |
| v1 factory | ALLOWED | verify 1a |
| current V2 factory | ALLOWED | verify 1b |

Case 3 is reported through the `residual` expectation in `describeOutcome`, not as a
failed `denied`. That is a correctness requirement, not presentation: asserting `denied`
printed a red cross beside an outcome nobody intends to change, and an operator who
learns that a correct run shows a failure is one who will not notice a real one. The
residual is stated on every run, open or closed, so its history can be audited.

`residual` may never be applied to case 2. `tests/turnkeyAuthority.test.ts` fails if it
is, if case 2 leaves the verdict, or if case 3 enters it.

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

## Operator steps — all completed 2026-08-22

1. ~~Choose Option A or B.~~ **A**, with the v1 clause carried over.
2. ~~Apply it with a root credential.~~ Done through the dashboard by the operator, as
   `b647cc07-a7fe-4941-914c-2c1032392f80`, created **before** `897d432e` was deleted so no
   window existed in which contract creation was ungranted.
3. ~~Run `npm run signer:probe-creation`.~~ case 1 `ALLOWED`, case 2 `denied`,
   case 4 `denied`. **PASSED.**
4. ~~Run `npm run signer:verify-policy`.~~ **PASSED**, with 1a and 1b both `ALLOWED`.
5. A document may now say a leaked bot key cannot attach treasury funds to a creation.
   It may **not** say initcode is bound — see the accepted residual at the top.

Read-only policy digests, before and after, taken with one tool:

```text
before   7ae7c68df2919ffe  1b8b585f   e1a02029ef4cbab4  897d432e   80db0bfe838192f9  ece2a399
after    7ae7c68df2919ffe  1b8b585f   a4efe63979c30280  b647cc07   80db0bfe838192f9  ece2a399
```

`897d432e` is absent afterwards; the two untouched policies carry identical digests, which
is what makes "no unexpected policy changed" checkable rather than merely asserted.

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
