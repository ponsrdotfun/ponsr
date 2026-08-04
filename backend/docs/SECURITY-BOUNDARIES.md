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

## 4. The bot never buys into a token it launches, and the control is now `msg.value`

**Rewritten 2026-08-04 against the verified ABI.** There is no dev-buy *parameter* to zero
out — the encoder used to set a literal `devBuyAmount = 0n`, and no such field exists.

The real factory derives an initial buy from `msg.value` **above** `launchFee`:

```solidity
address initialBuyRecipient = params.feeWallet == address(0) ? msg.sender : params.feeWallet;
...
if (initialBuyAmount != 0) { ... }
```

So the rule survives, but what enforces it has moved: `buildLaunchCalldata` returns
`value` equal to **exactly** the live fee. Overpaying by any amount makes the treasury buy
into a user's token with treasury funds.

**Anything that changes how `value` is computed is changing this security property**, even if
it looks like arithmetic. A test asserts the returned value equals the fee exactly, and the
orchestrator test asserts the emitted `initialBuyAmount` is zero.

## 5. The treasury signer is never a bare key in production

`src/treasurySigner.ts` throws if `RawKeyTreasurySigner` is instantiated with
`NODE_ENV=production`. The production path (`TurnkeyTreasurySigner`) is currently a stub that
must be completed with real Turnkey policy-scoped signing (destination = pons factory only,
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

> **✅ Resolved 2026-08-04 — and the contract was broken, though not for the reason feared.**
> The verified v1 locker **pushes** fees to `feeRedirects[token]` as ERC20 transfers; there is
> no escrow to claim from, and any contract may be the recipient. The treasury is always
> authorised to call `collectFees(token)` because it is `launched.deployer`.
>
> The problem was different and worse: fees arrive as **`token0` and `token1` ERC20**, and this
> contract split **native ETH only**. It would have accepted the transfers — any address can
> hold ERC20 — and had no function able to move them out again, stranding every creator's fees
> permanently. Rewritten with `splitERC20`, a per-token claimable ledger, and a reentrancy
> guard. **The rule that follows: any future change must keep an exit path for every asset
> this contract can receive.** A contract that can be paid in something it cannot pay out is
> the failure mode here, and it is invisible until real money is in it.

## 7. This has been tested carefully, not formally audited

Every module above has automated tests (150 across contracts + backend at the time of
writing, 200 including the website) covering the happy path, edge cases, and adversarial
scenarios described above. That
is meaningfully more scrutiny than shipping untested code, but it is not the same thing as a
professional smart-contract audit. Per the project's own implementation roadmap (Part 11),
`FeeSplitter.sol` and the treasury signer flow MUST be exercised end-to-end on Robinhood Chain
testnet -- real deploy, real (test) trading fees, a real claim by whatever mechanism the
deployed contracts actually expose (**not** necessarily `collectFees()`, which was our own
inference), real 95/5 delivery confirmation -- before either is trusted with real funds. Skipping that step is not
a time-saving shortcut; it is the exact gap the project's own audit (Part 5) was written to
prevent.
