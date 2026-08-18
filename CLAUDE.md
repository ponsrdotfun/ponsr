# Project Context for Claude Code

This file is read automatically when this project is opened in Claude Code. It exists so the
next phase of work can start immediately with full context, instead of re-deriving decisions
that have already been made and documented.

**Brand:** the project is **Ponsr**. It was originally called Holdfast; that name only
survives in historical notes.

## Read these first, in this order

1. **`docs/pons-v2-findings.md` — start at §10, then §9.** Sections 1–8 are what was believed
   from documentation; §9 onward is what the verified contracts and two real mainnet launches
   actually showed, and **§10 (2026-08-18) supersedes §7 outright** — v2 now approves eight
   pairing assets, six of them tokenised stocks, and both the ETH exemption and the whitelist
   bypass are settled from source rather than inferred. Where they disagree, the later section
   wins. §9.10 is an incident report worth reading
   before touching the deploy path.
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
  (Part 9). Run `backend/scripts/run-eval.ts` (**36 cases**) after any change to the system prompt
  in `backend/src/parser.ts` — the eval set must pass cleanly before the change is trusted.
  **Re-run it when the route changes too, not only the prompt.** Its first-ever run (2026-08-06)
  scored 25/28 against a prompt that had been assumed good for weeks. All three failures were
  one gap: distinguishing "this field is genuinely unsettled" from "I can work it out". The
  worst would have launched a token named `MOON` from `launch $MOON` — a permanent on-chain
  name nobody chose. The rules covering all three were already written; they were stated but
  not operational. An eval that has never run is not evidence of anything.

  Eight cases were added on 2026-08-18 for the pairing asset. Two of them exist only to hold
  one line: a token **about** something is not a token **paired with** it. "Launch an Apple
  meme coin" is a theme; "pair it with AAPL" is a permanent financial decision about what
  every buyer spends. One of the two is in Indonesian against GameStop, because GME is an
  approved pairing asset — so a model inferring from theme has a real asset to wrongly pick.
- **Wallet-per-user: Privy. Treasury signer: Turnkey** (native Robinhood Chain policy support,
  Part 10). Two separate provider decisions, not one shared choice.
- **Treasury pays every launch fee, not the user.** Part 5 explains why this requires the
  anti-abuse mitigations in `validator.ts` — those are required scope, not optional hardening.
- **What-if simulator is gated behind an explicit connect-wallet step** (decided 2026-07-25),
  not auto-resolved from the X handle. Reasoning in Part 3 §9.
- **Website is live at https://ponsr.fun** (53 smoke checks). Netlify, auto-deploying from
  `main` — a push publishes, there is no manual step. Three routes in one static file:
  `/` landing, `/explore` board, `/token/SYMBOL` detail. `PRETTY_URLS` is `true`; the router
  still reads the old `?view=` / `?token=` forms, so existing links keep working.
  **It shows real on-chain data**: `fetchLedger()` reads `TokenLaunched` from the factory,
  filtered on the indexed `deployer` so only Ponsr's launches appear. Two rules follow:
  a production treasury address must be added to `CHAIN.launchers` or its launches will not
  show, and **nothing may be displayed that cannot be read from the chain** — the board
  hides the sparkline, the 24h change and the what-if figures rather than inventing them.
- **X account is `@ponsrdotfun`**, live with profile art, banner and bio. `BOT_X_HANDLE`
  in `config.ts` now defaults to it — it is what the bot matches mentions against, not
  decoration.

### Settled 2026-08-04 by reading the verified contracts

The v1 factory and locker are **verified with full source** on
`robinhoodchain.blockscout.com`, whose API needs no key. (Every checklist item had pointed at
`api.blockscout.com`, the Pro aggregator, which does — that one wrong URL is why this looked
blocked on an account signup for weeks.) ABIs are checked in at `backend/src/abi/`.

- **Target v1 — but #17 is re-opened, see §10 of the findings.** One launch config is live
  (WETH pair, 4.2 ETH graduation). #17 was closed for v1 because v1 was open and v2 was not;
  **both are closed now**, so that reasoning no longer holds, and v2 is the one that can pair
  a launch against a tokenised stock.

  **The code for stock pairing is built and proven** (`pairTokens.ts`, `ponsV2Encoder.ts`,
  `launchTarget.ts`), verified by simulating real calldata against the live mainnet factory.
  It is selected by `PONS_FACTORY_VERSION`. The code default is still `v1`, but
  **production has run `v2` since 2026-08-19** (a Fly secret), because the whitelist that was
  requested is a v2 grant and v2 is a superset: ETH pairing plus the eight approved assets.
  Nothing can launch either way until pons whitelists this treasury or reopens the switch.

  The Turnkey policy was widened to allow the v2 factory on the same day. Verified afterwards:
  v1 and v2 both ALLOWED, and an arbitrary destination, the fee escrow and even the cold
  wallet all still denied — a leak of the bot's key costs launches, not the treasury.

  **Before opening v2 to users, run one self-dealt launch through `phase-b-launch.ts` first.**
  `FeeSplitterV2` has never met a real fee; it passes 12 tests against a mock built from the
  escrow's own source, which is not the same thing. See §10.7 of the findings.

  **`launchEnabled()` is `false` as of 2026-08-18, on v1 AND v2.** It was `true` when this
  was written, and both real launches happened while it was. pons switched it off at
  **2026-08-12 19:42 UTC** — recorded on-chain by `LaunchEnabledUpdated(false)` on the
  factory — and **nobody has launched anything through pons since**, so this is a
  platform-wide pause, not something aimed at Ponsr. No whitelist has been granted to
  anyone in that window either.

  Consequences, none of which are fixable in this codebase: **the bot cannot launch until
  pons flips it back**, or until this treasury is whitelisted, which needs pons to act.
  The bot handles it correctly — `validator.ts` reads readiness live, refuses with
  `LAUNCHPAD_UNAVAILABLE` before any money moves, and tells the person the cause is
  upstream — so nothing is at risk; it simply cannot do its job. `launchpadWatch.ts` now
  alerts when this flips either way, because for three days nothing did, and a closed
  launchpad with no traffic looks exactly like an open one with no traffic.
- **The fee model works, and `FeeSplitter.sol` was broken.** Not for the escrow reason
  feared: fees are **pushed** to `feeRedirects[token]`, and any contract can be the recipient.
  But they arrive as **ERC20** (the launched token + WETH), and the old splitter handled only
  native ETH — it could have received them and never moved them out. Rewritten with
  `splitERC20`, a per-token claimable ledger, and a reentrancy guard.
- **The launch fee is not a constant** — read `launchFee()` live. Note the function is
  `launchFee()`; the code called `creationFee()`, which does not exist and would have
  reverted every read.
- **Guards are read live before every launch** (`getLaunchReadiness()`), because
  `launchEnabled`, the whitelist, and the launch config are all owner-settable on pons's side.

### The on-chain path is finished and proven (2026-08-04)

Two self-dealt mainnet launches were run. The second collected real trading fees and split
them **95/5 exactly, nothing left behind** — verified from the contract's own
`ERC20FeesSplit` event. Every link is now demonstrated: `launchToken` accepted, `feeRedirects`
wired, `collectFees` authorised for the treasury as `deployer`, `splitERC20` correct.

Two hard-won guards came out of it, and both must stay:

- **`compile-all.js` writes `backend/src/feeSplitterArtifact.json`.** It used to be a hand-made
  copy, went stale through the ERC20 rewrite, and the first mainnet launch deployed the
  **old ETH-only splitter**. Its fees are stranded forever. Every test had passed — they read
  the *other* copy. A rehearsal that skips the production deploy path proves less than it looks.
- **`phase-b-launch.ts` reads `splitERC20`'s selector back out of the deployed bytecode** and
  aborts if absent. It is the only check a stale build cannot fool.

Scripts, all dry-run by default: `new-treasury-wallet.ts` (never prints the key),
`validate-splitter.ts` (testnet rehearsal), `phase-b-launch.ts`, `collect-and-split.ts`.

## Immediate next actions

Items 1-3 and 5 closed 2026-08-06. Every external provider is now wired and **verified
against the live service**, not merely configured:

- ~~Privy~~ — `scripts/check-providers.ts` creates a real wallet, not just a credential read.
- ~~Turnkey~~ — signs as a scoped non-root user. `scripts/turnkey-verify-policy.ts` proves the
  policy bites: factory allowed, contract creation allowed, arbitrary destination **denied**.
  The root key is out of `backend/.env` (root bypasses all policies, so storing it beside the
  bot's key made the scoping pointless).
- ~~twitterapi.io~~ — both calls the bot makes return correctly-mapped fields. Free tier is
  1 req/5s, so the reader serialises its own calls.
- ~~Parser eval~~ — **28/28**, stable across three runs. See the note below; it had never
  actually run before, and it found three real defects on its first execution.

**Parser routing:** there is no `ANTHROPIC_API_KEY`; the same `claude-haiku-4.5` is reached
through OpenRouter (`OPENROUTER_API_KEY`). Part 9's model decision is unchanged — only the
route is. `createParser()` prefers Anthropic whenever a direct key is added. Note OpenRouter
returns HTTP 200 with an `error` body on upstream failure or exhausted credit, so a billing
problem would otherwise surface as a parse failure and send you to the system prompt.

Still blocked on the owner:

1. Create the **cold treasury wallet** and set `TREASURY_COLD_ADDRESS` (checklist 0.8).
2. ~~Move the Turnkey root key out of `~/ponsr-turnkey-root-key.txt`~~ — **done 2026-08-19**,
   along with the dashboard's original `.json` download in `~/Downloads` holding the same key,
   which was found by searching rather than by remembering. The bot never needed root: it runs
   on a scoped key that can reach the pons factories and nothing else.
3. Backend hosting, for the listener to run 24/7.

The email to `contact@ponsfamily.com` no longer blocks anything.

**DECIDED 2026-08-06: the split stays 95/5** — no code change, `FeeSplitter` already does
this. Funded by the owner taking the *creator* share (66.5%) on Ponsr's own token launch
rather than by widening the platform's cut. See `docs/pons-v2-findings.md` §9.12 for the
worked numbers and the two consequences that follow. The locker takes **30%** before our splitter sees anything, so 95/5 divides
70: the creator's real take is **66.5%** of trading fees and the treasury's is **3.5%**, not
5%. Any revenue model built on 5% is overstated by ~1.4×.

Read together with the costs (all live mainnet reads, 2026-08-06: launch fee 0.0005 ETH, pool
fee 1%, graduation 4.2 ETH), break-even is **~1.43 ETH of volume per launch**, and a token
that graduates returns roughly 3×. That ratio is the anti-abuse case in one line — an attacker
need not steal anything, only make the bot launch tokens that never trade.

Two things keep 3.5% on the optimistic side: the take arrives as **the launched token plus
WETH, never ETH**, and the token half usually goes to zero; and `MAX_PROTOCOL_FEE_SHARE` is
**50**, so pons can cut us to 2.5% without notice. Treat 30 as today's value, not a constant.

Whatever ratio is chosen, the only figures that may appear in user-facing copy are **66.5%
and 3.5%** — they are what the contracts actually transfer, and anyone can check on-chain.

### Buildable right now, with no accounts needed — nothing left

Every Part 5 / Part 7 requirement that was pure code is now built (see below), and the
on-chain path is proven end to end. What remains is three account signups and a cold wallet.

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
