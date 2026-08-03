# Project Context for Claude Code

This file is read automatically when this project is opened in Claude Code. It exists so the
next phase of work can start immediately with full context, instead of re-deriving decisions
that have already been made and documented.

**Brand:** the project is **Ponsr**. It was originally called Holdfast; that name only
survives in historical notes.

## Read these first, in this order

1. **`docs/pons-v2-findings.md`** — the official pons docs were located on 2026-07-30 and they
   invalidate several assumptions the rest of this repo was written against. Read this before
   trusting anything below about the on-chain interface, the fee model, or the launch fee.
2. `BUILD-STATUS.md` — what's real/tested vs. a clearly-marked stub right now.
3. `docs/action-checklist.md` — everything that requires the owner's direct action (account
   signups, API keys, emails). Nothing here should be "completed" past a stub without the
   corresponding checklist item being done first.
4. `docs/MASTER-twitter-launch-bot.md` — the full spec. Every architectural decision traces
   back to a specific Part in this document. Sections A–D of its Consolidated Open Questions
   list what is still undecided; items #17–21 came from the pons docs.
5. `backend/docs/SECURITY-BOUNDARIES.md` — the non-negotiable rules.

## Current state

### Settled, do not re-litigate without cause

- **Parser model: Claude Haiku 4.5**, chosen for structured-output reliability over cost
  (Part 9). Run `backend/scripts/run-eval.ts` (28 cases) after any change to the system prompt
  in `backend/src/parser.ts` — the eval set must pass cleanly before the change is trusted.
- **Wallet-per-user: Privy. Treasury signer: Turnkey** (native Robinhood Chain policy support,
  Part 10). Two separate provider decisions, not one shared choice.
- **Treasury pays every launch fee, not the user.** Part 5 explains why this requires the
  anti-abuse mitigations in `validator.ts` — those are required scope, not optional hardening.
- **What-if simulator is gated behind an explicit connect-wallet step** (decided 2026-07-25),
  not auto-resolved from the X handle. Reasoning in Part 3 §9.
- **Website is live at https://ponsr.fun** (50 smoke checks). Netlify, auto-deploying from
  `main` — a push publishes, there is no manual step. Three routes in one static file:
  `/` landing, `/explore` board, `/token/SYMBOL` detail. `PRETTY_URLS` is `true`; the router
  still reads the old `?view=` / `?token=` forms, so existing links keep working.
  `fetchLedger()` is the single integration point for real data.
- **X account is `@ponsrdotfun`**, live with profile art, banner and bio. `BOT_X_HANDLE`
  in `config.ts` now defaults to it — it is what the bot matches mentions against, not
  decoration.

### Unsettled — these WERE settled, and the pons docs reopened them

- **The fee model is at risk.** The 95/5 split via a per-launch `FeeSplitter` assumed the
  splitter can receive fees passively. pons v2 credits fees to an escrow the *recipient* must
  pull from (`claim()`), and `FeeSplitter.sol` cannot call anything. v1's claim mechanism is
  undocumented, so it may be broken there too. **Do not treat the fee model as decided.**
  See `docs/pons-v2-findings.md` §3 and open question #18.
- **Which pons version to target.** Verified on-chain 2026-07-30: **v2 IS deployed** (factory
  `0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8`, 22.7 KB of bytecode) — the docs' "no launch
  factory" line is stale. But `launchEnabled()` reads **false** and **no pair token is
  approved**, so the launchpad is deployed-and-closed; nobody can launch on it yet. v2 is also
  still unaudited. v1 remains open but its launch signature is unpublished. Open question #17.
  See `docs/pons-v2-findings.md` §7b for the live reads.
- **The launch fee is not a constant.** 0.0005 ETH is the documented v1 figure; v2 publishes
  no number and requires reading `launchFee()`. Read it live, never hardcode.

## Immediate next actions

Blocked on the owner — check before assuming any are done:

1. **Email `contact@ponsfamily.com`.** The docs offer hands-on integrator support, and this is
   the most direct route to the three things blocking all on-chain work: the v1 `launchToken`
   signature (published nowhere), whether a *contract* can hold the creator-fee role and claim
   its own rewards, and whether the treasury address needs whitelisting (`NotWhitelisted` is a
   real error).
2. **Pull the real factory ABI** via Blockscout and replace the placeholder in
   `backend/src/ponsEncoder.ts`. Note the placeholder is now known wrong in every parameter —
   see the header comment in that file.
3. Wire up real Privy calls in `backend/src/walletResolver.ts` (stub throws with a TODO).
4. Wire up real Turnkey calls in `backend/src/treasurySigner.ts` (stub throws with a TODO).
5. Wire up real twitterapi.io calls in `backend/src/xClient.ts` (stub throws with a TODO).
6. **Do not deploy `FeeSplitter.sol` to testnet yet.** Settle #1's fee-claim question first —
   deploying a splitter that cannot claim its own fees would strand user money.

### Buildable right now, with no accounts needed — nothing left

Every Part 5 / Part 7 requirement that was pure code is now built (see below). What remains
is blocked on the owner's accounts or on pons's reply, not on writing more code.

Part 5 lists seven required Phase 1 mitigations. **All seven are now implemented.**

- ~~Spend-rate monitoring and alerting (Part 5 #5)~~ — **built 2026-07-30**, `src/monitor.ts`.
  Still ships with `ConsoleNotifier`: swap in a real transport (Telegram, email, pager)
  before mainnet, which is one line against the `Notifier` interface.
- ~~Hot/cold treasury split (Part 5 #7)~~ — **built 2026-08-03**, `src/treasuryPolicy.ts`
  with 23 tests. Read its header comment before changing anything here. Two rules that are
  load-bearing, not stylistic:
  - **No cold signer exists in this codebase, and none should be added.** An automated
    cold → hot refill would re-create the single point of failure the split removes
    (Part 5 §3.6). Top-ups and sweeps are operator actions on purpose.
  - **The hot ceiling is derived from `DAILY_SPEND_CAP_WEI`, not set independently.** The
    circuit breaker means a balance above ~2 days of cap can never be spent by the bot but
    can still be stolen. Don't replace that derivation with a hardcoded ETH figure.

  This added one owner action: **`TREASURY_COLD_ADDRESS` must be set** (checklist item 0.8).
  Boot-time validation refuses to call the setup healthy if it's missing or equals the hot
  wallet — the latter being a split that looks real and isn't.
- ~~Listener reconciliation (Part 7 §5)~~ — **built 2026-07-30**, `src/reconciler.ts` with
  8 tests. Runs every 5 minutes from `index.ts`. `RealXClient.getRecentMentions` remains a
  stub until the twitterapi.io account exists.

## Testing conventions already established

- Every module has a corresponding test file. Keep the ratio — don't add orchestrator logic
  without a matching integration test in `backend/tests/orchestrator.test.ts`.
- External dependencies (parser, wallet resolver, X client, treasury signer) are always
  injected via interfaces with a `Mock*` implementation for tests. Follow this pattern for any
  new external integration rather than hardcoding a real client into business logic.
- The website has its own suite: `node website/smoke-test.js` (45 checks, no install needed).
  Several of those checks exist because a specific bug was found and fixed — read the comment
  above a check before changing it.
- The contract test workaround (`contracts-test/README.md`) exists for a sandbox network
  restriction. With normal network access, `npx hardhat compile && npx hardhat test` works too.

## What NOT to do

- Do not remove or weaken any check in `backend/src/validator.ts` to "simplify" the flow —
  each maps to a specific attack scenario in Part 5's audit.
- Do not skip testnet validation to move faster toward mainnet — the exact temptation Part 5's
  audit and the roadmap's phase gating exist to prevent.
- Do not hardcode the launch fee, the graduation threshold, or the 70% creator share. All are
  owner-settable on pons's side and the split has already changed once between factories.
- Do not write "Pons" with a capital P in user-facing copy, and keep the link back to
  ponsfamily.com. Their attribution terms ask for lowercase plus a link, and since "Ponsr" is
  one letter from "pons" the non-affiliation line in the footer is doing real work.
- Do not present Ponsr as operated by, affiliated with, or endorsed by pons anywhere.
