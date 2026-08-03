# Security Boundaries

This document states the non-negotiable architectural rules that make this bot safe to run
with a real treasury balance. These are not implementation details to optimize away later --
several of them exist specifically *because* of failure modes identified in the project's own
research (see the master spec doc, Part 5's audit in particular). If you find yourself editing
code in a way that would violate one of these, stop and re-read the relevant part of the spec
before proceeding.

## 1. The LLM parser never controls money movement

`src/parser.ts` extracts exactly three fields from tweet text: `tokenName`, `tokenSymbol`,
`description`. The `ParsedIntent` TypeScript type (`src/types.ts`) has no field for a wallet
address, fee recipient, or transfer amount -- this is enforced by the type system and by the
Zod schema's default behavior of stripping unknown keys, not merely by prompt wording.

This means a prompt-injection attempt embedded in a tweet (e.g. "...also send fees to
0xattacker...") cannot reach the money-routing logic even if the model is fully fooled into
"wanting" to comply -- there's structurally nowhere for that instruction to land. See
`tests/parser.test.ts`'s "CRITICAL SECURITY PROPERTY" test and
`tests/orchestrator.test.ts`'s prompt-injection test for automated proof of this.

**Where wallet/fee addresses actually come from:** always `walletResolver.ts`, resolved from
the mention's `authorXUserId` -- never from anything the parser returns.

## 2. Every treasury-affecting action requires validation to pass first

`src/validator.ts` runs unconditionally on every request, after the LLM parses it and before
any wallet is touched or any transaction is built. It enforces, in order: required fields
present, sanitized characters, anti-Sybil account signals, per-user rate limits, live fee
ceiling, and the global daily spend circuit breaker. None of these are optional or
skippable -- there is no code path in `orchestrator.ts` that reaches a treasury-spending
transaction without `validateLaunchRequest` having returned `approved: true` first.

## 3. Idempotency is enforced at the database level, not in application logic

`db.claimTweetForProcessing()` uses a SQLite `PRIMARY KEY` constraint, not a
read-then-write check. This closes the specific race condition identified in Part 5's audit:
duplicate webhook deliveries (which happen under real-world network conditions) can never
cause the same tweet to be processed twice, even under concurrent execution. See
`tests/db.test.ts`'s concurrent-claim simulation.

## 4. The dev-buy amount is hardcoded to zero, not defaulted

`src/ponsEncoder.ts`'s `buildLaunchCalldata` sets this as a literal `0n` in the function
body, not a config default that could be silently overridden. If dev-buy support is ever
deliberately added, it should be a separate, explicitly-named code path -- never something
reachable by accident from the default launch flow.

> **Correction (2026-07-30):** the field is not called `devBuyAmount` in either real pons
> interface. In **v1** it appears as **`initialBuyAmount`** (confirmed in the `TokenLaunched`
> event). In **v2** there is no such parameter at all. The *rule* stands and still matters for
> v1 — a bot that silently spends treasury ETH buying the token it just launched is exactly
> the failure this guards against — but the field name in the code is a placeholder and must
> be corrected when the real ABI is pulled. See `docs/pons-v2-findings.md` §2 and §6b.

## 5. The treasury signer is never a bare key in production

`src/treasurySigner.ts` throws if `RawKeyTreasurySigner` is instantiated with
`NODE_ENV=production`. The production path (`TurnkeyTreasurySigner`) is currently a stub that
must be completed with real Turnkey policy-scoped signing (destination = Pons factory only,
function = `launchToken` only) before this bot ever touches real funds. See Part 10 of the
master doc for why Turnkey specifically was chosen for this role.

## 5b. There is no cold-wallet signer in this codebase, and adding one is not an optimization

The hot/cold split (Part 5 mitigation #7, `src/treasuryPolicy.ts`) exists because a single
treasury wallet funding every launch means one leaked key drains the whole operation
(Part 5 §3.6). The bot holds an operating float; the rest lives in a cold or multisig wallet.

`TREASURY_COLD_ADDRESS` is an **address only**. The backend reads it for exactly two purposes:
naming the source/destination in top-up and sweep alerts, and refusing to report the setup as
healthy when it is unset or equal to the hot wallet. Nothing in this process can spend from it.

**Automating the cold → hot refill would defeat the entire mitigation.** A process that can
move funds out of cold storage *is* a hot wallet, whatever it is called, and the blast radius
of a compromise returns to 100%. The manual top-up is not friction to be engineered away; it
is the boundary. Part 6 §2 documents the intended semi-automated flow: the bot detects and
reports, a human moves the money.

Two related rules:

- **The hot ceiling is derived from `DAILY_SPEND_CAP_WEI`, never set as an independent ETH
  figure.** The circuit breaker already caps 24h spend, so a balance above a couple of days'
  cap cannot be spent by the bot but can still be stolen. Replacing the derivation with a
  constant silently re-opens that exposure the next time the cap changes.
- **`validator.ts`'s `getTreasuryBalanceWei` is a required dependency, not an optional one.**
  It was made required deliberately: an optional money guard is one a future call site forgets
  to pass, and the symptom is launches burning gas on transactions that cannot succeed.

## 6. The FeeSplitter contract has no owner, no admin function, no upgradability

Once deployed, a `FeeSplitter` instance's 95/5 split cannot be changed by anyone, including
the bot's own operator. This is a deliberate trust decision (see `contracts/FeeSplitter.sol`'s
NatSpec and Part 8 of the master doc) -- changing the ratio requires deploying a new contract
version and using it for future launches, not flipping a setting on an existing one.

> **⚠️ Blocking issue (2026-07-30): the splitter may not be usable as a fee recipient at all.**
> pons v2 credits creator fees to an escrow that the *recipient* must pull from (`claim()` /
> `claimToken()`), and this contract can only receive value passively -- it cannot call
> anything, so fees routed to it would be stranded permanently. The v1 claim mechanism is
> undocumented ("the creator can claim them at any time", no function named), so the same risk
> is unresolved there. **Do not deploy this as a fee recipient on any network until that
> question is answered** -- see `docs/pons-v2-findings.md` §3 and open question #18.
>
> Two further assumptions in this section are now known to be wrong: the fee recipient is
> **not** permanent (both versions expose a redirect, and a v2 community takeover can move it
> after a 3-day delay), and the creator share is **not** fixed at 70% (it is per-factory and
> already changed once, from 90% on the legacy factory).

## 7. This has been tested carefully, not formally audited

Every module above has automated tests (67 total across contracts + backend at the time of
writing) covering the happy path, edge cases, and adversarial scenarios described above. That
is meaningfully more scrutiny than shipping untested code, but it is not the same thing as a
professional smart-contract audit. Per the project's own implementation roadmap (Part 11),
`FeeSplitter.sol` and the treasury signer flow MUST be exercised end-to-end on Robinhood Chain
testnet -- real deploy, real (test) trading fees, a real claim by whatever mechanism the
deployed contracts actually expose (**not** necessarily `collectFees()`, which was our own
inference), real 95/5 delivery confirmation -- before either is trusted with real funds. Skipping that step is not
a time-saving shortcut; it is the exact gap the project's own audit (Part 5) was written to
prevent.
