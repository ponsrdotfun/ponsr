# Letting the treasury send a fee claim

**Status: DONE 2026-09-01. Policy `22f53547-16c6-49af-9b09-1fc86fba18f3`,
`ponsr-bot: claim creator fees`, created by the owner in the dashboard with the root
passkey. Option A was chosen.** Proven by signing, nothing broadcast:

```
splitter                     claim   funded   arbitrary   factory   verdict
MICRODUCK 0x18d1d206…      ALLOWED  denied     denied     ALLOWED   PASS  exit 0
NOBI      0xA45a3615…      ALLOWED  denied     denied     ALLOWED   PASS  exit 0
PSTONKS   0xF78DC016…       denied  denied     denied     ALLOWED   -
```

**And it was used the same day.** Two claims sent from the website by the signed-in owner,
`0x62f152eb…` and `0x3fdff472…`, both status 1: 0.019498 NVDA and 0.008971 SPCX to the
creator's wallet, the remainder to the treasury, every escrow cell now zero. The policy is
not merely correct in a probe; it has carried real value.

**The PSTONKS row is the load-bearing one.** Its splitter is not in the address list, and
it is refused — which is what proves the rule is bound to two destinations rather than
being a blanket allow that would have passed the other two rows identically.

The stored condition reads back exactly as written, parentheses included:

```
eth.tx.value == 0 && (eth.tx.to == '0x18d1d206a042260aa86f2af87a8bf7c959f899d5' || eth.tx.to == '0xa45a3615cf951bb0f0c29d4dee9ca9b2a27fa955')
```

Without those parentheses `&&` would bind only the first address and NOBI would have been
a destination with no constraint on value at all. The signer now holds **three** policies.

Everything below is the reasoning that produced this, kept because the next launch will
need it: a new splitter is NOT covered by this rule.

---

**Originally: not done. An owner action, and deliberately the last step.**

Everything else is built and verified. The website shows a collect button to the
signed-in creator, the route guards it, and the service refuses a claim that is
not the reader's. What is missing is one Turnkey policy, and until it exists the
button answers *"The signing policy does not permit this yet. Nothing was sent
and nothing was spent."* — which is true, and is what it should say.

Measured 2026-09-01 by signing, nothing broadcast:

```
1. claimAndSplit, no value         denied      <- what this document is about
2. claimAndSplit CARRYING VALUE    denied  ok
3. tx to an arbitrary address      denied  ok
4. launch through the factory      ALLOWED ok
```

Reproduce with `npx ts-node scripts/turnkey-verify-claim.ts` from `backend/`.
Exit 3 means *not yet*, 0 means pass, 1 means an authority is open, 2 means at
least one probe could not be asked — which is never the same as a denial.

## What is actually being permitted

`claimAndSplit(address erc20)` on a fee splitter. It is **permissionless** and
pays the **creator**, never the caller, so the treasury sending one cannot move
anybody's fees anywhere except to the person already owed them. The treasury is
spending gas on their behalf and nothing else. This is why the account pages can
keep advertising a custody boundary: the website never touches a private key and
no signature is asked of the reader.

That is the honest case for it. Here is the honest cost.

The signer currently holds exactly two policies — `ece2a399-…` (the current
factory) and `60ef12fa-…` (`eth.tx.to == '' && eth.tx.value == 0`, contract
creation only). Every other destination is refused. Adding a third rule widens
the hot wallet's authority for the first time since the 2026-08-28 ceremony,
and it should be written to be as narrow as the job allows.

## `eth.tx.value == 0` is not optional here

A splitter's native `withdraw()` pays `msg.sender`. So ETH that lands in a
splitter can be taken by whoever asks first — the treasury would be funding a
contract that hands its balance to a stranger.

**Allowing an address is not the same as allowing it to be paid.** A rule that
names a splitter as a destination without binding value to zero is a drain path,
not a claim path. Probe 2 above exists only to measure this, and it must stay
`denied` after the policy is added.

This is the same shape as the finding closed on 2026-08-22: the creation rule
allowed `eth.tx.to == ''` with no constraint on value, and Turnkey signed a
creation carrying 1 ETH while every destination-only check reported green.

## Two ways to write it

### A. Bind the address list — narrowest, needs maintenance

The shape below is copied from the two policies already in force, read with
`scripts/turnkey-read-policies.ts` on 2026-09-01, not written from memory.

```
name       ponsr-bot: claim creator fees
effect     EFFECT_ALLOW
condition  eth.tx.value == 0 && (eth.tx.to == '0x18d1d206a042260aa86f2af87a8bf7c959f899d5' || eth.tx.to == '0xa45a3615cf951bb0f0c29d4dee9ca9b2a27fa955')
consensus  approvers.any(user, user.id == '009b2000-01e2-4984-9326-5bb743bf007a')
```

Two details are not stylistic. **The addresses are lowercase**, because both
existing conditions are — `eth.tx.to == '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'`
is how the factory rule reads, and a checksummed spelling is a different string.
And the destinations are joined with `||` rather than an `in` list, because `||`
is the form already proven to be enforced here; an untested spelling that the
engine cannot parse fails in the direction of refusing everything.

The consensus names the same bot user as both existing rules. That is the user
the signer authenticates as, so a rule naming anyone else grants nothing.

Those two are the splitters whose `creator()` is the owner's wallet
`0xcdce6c82…`, read from chain on 2026-09-01. PSTONKS's splitter
(`0xF78DC016…`) pays the **treasury**, not the owner, so it is not needed to
test a creator claim.

Residual: nothing beyond gas, and only to two known contracts.

**The trap is operational, not technical.** Every future launch creates a new
splitter that is not in this list, so its creator's fees sit unclaimable until
someone remembers to edit a Turnkey policy. With the public gate false and
launches rare that is survivable. When the gate opens it stops being survivable,
and the failure is silent — a creator sees a button, presses it, and is told the
policy refuses.

### B. Bind the selector — covers every future launch

```
name       ponsr-bot: claim creator fees by selector
effect     EFFECT_ALLOW
condition  eth.tx.value == 0 && eth.tx.data[0..10] == '0x56c937fc'
consensus  approvers.any(user, user.id == '009b2000-01e2-4984-9326-5bb743bf007a')
```

**`[0..10]`, and the index is not a guess.** Turnkey's own documented example
slices raw calldata as `input[34..74]`, and 34..74 is exactly where the address
argument sits *if the string includes the `0x` prefix and the indices count hex
characters*: two for `0x`, eight for the selector, then a 64-character word whose
last 40 characters are the address. Checked against real calldata:

```
0x56c937fc000000000000000000000000c9158abf265aa26766154269f9b3d417f7771d0a
[0..10]  -> "0x56c937fc"                                  the selector
[34..74] -> "c9158abf...7771d0a"                          the argument, matching the doc
```

An earlier draft of this file said `[0..4]`. That yields `"0x56"`, which can
never equal `'0x56c937fc'` — the policy would have refused every claim, and the
owner would have gone looking for a fault that was a typo in this document.

### What each shape actually permits, measured

Run against the live signer on 2026-09-01, nothing broadcast, with only the
address-list rule in force:

```
1. claimAndSplit to a listed splitter, no value    ALLOWED
2. the same call CARRYING VALUE                     denied
3. a plain transfer to an arbitrary address         denied
4. a launch through the current factory            ALLOWED
5. claimAndSplit to an UNLISTED splitter            denied   <- future launches
6. a DIFFERENT selector to a listed splitter       ALLOWED   <- calldata unbound
```

Rows 5 and 6 are the migration in one picture, and they are **opposite** under
the two shapes. The list refuses future launches and permits any calldata; the
selector rule permits future launches and refuses other calldata. That opposition
is what lets a probe say which rule is enforcing — while both exist, each row is
granted by one of them and no probe can tell them apart.

**Row 6 is a residual, not a hole.** The splitter's functions either pay the
party already owed (`withdrawERC20`) or the caller's own entitlement (native
`withdraw`), so the treasury calling one cannot take anybody's share. It can
waste gas. The same is true of the selector rule's own residual — a zero-value
call carrying that selector to any address — and for the same reason: value is
pinned to zero and the treasury grants no token approvals.

### Which one

**Move to B before the public gate opens.** A covers today with the shortest
possible widening, which is why it was chosen first. Its cost is operational and
silent: every new launch creates a splitter no rule names, so that creator
presses collect and is told the policy refuses, with nothing on the site
explaining why. A gas-only residual is cheaper than a creator who cannot be paid.

### Which one

**A now, B when the public gate opens.** Two addresses is the shortest-lived
widening available and matches how the ceremony has been run so far, and with
launches rare the maintenance cost is real but small. Do not carry A into an
open gate: a silent unclaimable-fee failure for real creators is worse than the
gas-only residual of B.

## Migrating from A to B, in this order

The order is the load-bearing part, and this repository has already paid for the
lesson once: during the v1 revocation the creation-only rule had to be created
before either deletion, because deleting first would have left a bot that could
launch and then not deploy its splitter — after the fee was already spent.

1. **Create the selector rule while the address list still stands.** Nothing is
   removed, so no window exists in which a claim cannot be sent.
2. **Verify the middle**, and expect it to be partly blind:

   ```bash
   npx ts-node scripts/turnkey-verify-claim.ts --expect=both
   ```

   Rows 5 and 6 both read ALLOWED here, and that is correct: one is granted by
   the new rule and one by the old, and no probe can say which. This step proves
   the selector rule EXISTS. It cannot prove it is tight.
3. **Delete the address-list rule** `22f53547-16c6-49af-9b09-1fc86fba18f3`. Bind
   the deletion to that id, never to the name — a name is a label, not authority.
4. **Verify the end state**, which is the only run that proves anything about
   tightness:

   ```bash
   npx ts-node scripts/turnkey-verify-claim.ts --expect=selector
   ```

   Row 5 ALLOWED and row 6 **denied**. Exit 0.

`--expect` refuses an unrecognised value rather than falling back to the lenient
default, so a typo cannot verify against the old expectations and print PASS.

## After creating it

Run the probe again and require:

```
1. claimAndSplit, no value         ALLOWED
2. claimAndSplit CARRYING VALUE    denied
3. tx to an arbitrary address      denied
4. launch through the factory      ALLOWED
```

Exit 0. Nothing broadcast. If option A was chosen, pass the splitter address you
expect to be covered as an argument — the default reads the first launch in the
committed snapshot, which is PSTONKS, and PSTONKS is not in the list above.

Probe 4 is not a formality. Widening one authority is also an opportunity to
break the one that was already working, and a verification that only measures
the new thing cannot see that.
