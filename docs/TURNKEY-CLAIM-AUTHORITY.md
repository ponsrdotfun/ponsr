# Letting the treasury send a fee claim

**Status: not done. This is an owner action, and it is deliberately the last step.**

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
eth.tx.value == 0 && eth.tx.data[0..4] == '0x56c937fc'      // claimAndSplit(address)
```

Residual: the treasury can send zero-value calls carrying that selector to any
address. The cost is gas, never treasury funds — value is pinned to zero, and an
arbitrary contract cannot move the treasury's tokens without an approval the
treasury does not grant. It does not widen what a claim can do; it widens where
one can be aimed, and only ever at the expense of gas.

Check the exact expression syntax against Turnkey's policy language before
saving — `data[0..4]` is the intent, not necessarily the literal spelling.

### Which one

**A now, B when the public gate opens.** Two addresses is the shortest-lived
widening available and matches how the ceremony has been run so far, and with
launches rare the maintenance cost is real but small. Do not carry A into an
open gate: a silent unclaimable-fee failure for real creators is worse than the
gas-only residual of B.

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
