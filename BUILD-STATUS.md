# Build Status

> **Read `docs/pons-v2-findings.md` first (added 2026-07-30).** The official pons docs were
> located and then verified against the chain, and together they invalidate several assumptions
> this file was written against — most seriously, `FeeSplitter.sol` cannot claim its own fees
> under v2's pull-based escrow, and the placeholder launch ABI is wrong in every parameter.
> v2's contracts **are** deployed (the docs' "no launch factory" line is stale), but
> `launchEnabled()` reads `false` and no pair token is approved, so nothing can launch there
> yet. The statuses below are accurate about *what was built and tested*; they are not
> accurate about *what will work against pons*.

Read this before anything else. Every component below is marked exactly as it stands — real
and tested, or a clearly-marked stub. Nothing here is overstated.

## Legend

- ✅ **Built & tested** — real logic, exercised by automated tests, working correctly against
  everything that can be verified without your personal accounts/credentials.
- 🟡 **Stub, clearly marked** — the integration point exists, is correctly shaped to slot into
  the tested pipeline around it, but its body is a deliberate `throw` pointing at a TODO
  comment, because it requires an account/API key only you can create.
- 🔴 **Requires your action before this is trustworthy** — not a code gap, a credential/
  verification gap.

---

## Smart contract

| Component | Status | Notes |
|---|---|---|
| `FeeSplitter.sol` | ✅ (as code) / 🔴 (as a design) | 95/5 split, immutable, no admin function. 13/13 tests passing, including a live reentrancy attack and a rounding-invariant check across 7 different amounts — the contract does exactly what it was specified to do. **But the specification may be wrong:** it can only receive value passively, and pons v2 requires the fee recipient to actively pull from an escrow (`claim()`). v1's mechanism is undocumented. Routed fees could be stranded. Do not deploy as a fee recipient until open question #18 is answered. |
| Deployment to testnet | 🔴 | Never deployed anywhere yet. **Now blocked on the fee-claim question above, not just on having a testnet wallet** — deploying a splitter that cannot claim its own fees would strand user money, which is the exact failure Part 8 §3 was written to prevent. |
| Professional audit | 🔴 | Not performed. Carefully written and thoroughly tested, but per `backend/docs/SECURITY-BOUNDARIES.md` item 7, that is not the same guarantee as a professional audit. The project's own roadmap requires end-to-end testnet validation before mainnet use — this was true before this build session and remains true now. |

## Backend

| Component | Status | Notes |
|---|---|---|
| Idempotency (`db.ts`) | ✅ | Atomic DB-level constraint, tested against simulated concurrent duplicate delivery. |
| LLM parser (`parser.ts`) | ✅ (logic) / 🔴 (needs API key) | Schema, prompt, and injection-resistance are built and tested (`parser.test.ts`). The real Claude Haiku 4.5 calls haven't been exercised — `scripts/run-eval.ts` is ready to run the full 28-case eval set the moment `ANTHROPIC_API_KEY` is set. **Run this before trusting the parser in production.** |
| Validation guard (`validator.ts`) | ✅ | Part 5 mitigations 1–4 and the #7 admission gate implemented and tested: anti-Sybil thresholds, per-user rate cap, global daily spend circuit breaker, live max-fee ceiling, and a live hot-wallet balance floor. The last two rejections are deliberately distinct — `DAILY_SPEND_CAP_REACHED` means funds exist and policy says stop; `TREASURY_EXHAUSTED` means the wallet is actually out. They need different responses from the operator. |
| Monitoring & alerting (`monitor.ts`) | ✅ | **Part 5 mitigation #5, built 2026-07-30.** Detects launch-volume spikes against a rolling baseline (Part 5's 10× rule), Sybil probing by *distinct* rejected accounts, circuit-breaker trips, fee-ceiling hits, low treasury and on-chain failures. Alerts are deduplicated so one incident isn't a hundred pages, and every monitor call is fire-and-forget so a dead notifier can never fail a user's launch. 14 tests. Rejections are now persisted (`rejection_log`) — previously a blocked Sybil attempt left no trace anywhere. **Ships with `ConsoleNotifier`; swap in a real transport before mainnet**, which is a one-line change against the `Notifier` interface. |
| Hot/cold treasury split (`treasuryPolicy.ts`) | ✅ (code) / 🔴 (needs a cold wallet) | **Part 5 mitigation #7, built 2026-08-03 — this completes all seven required mitigations.** Three parts. (1) A hard **admission gate**: `validator.ts` now refuses a launch the hot wallet cannot fund, rather than deploying a splitter and burning gas on a transaction that must revert — this was a real gap, nothing previously checked the balance before spending. (2) A **balance watch** every 15 minutes, which runs whether or not anyone is tweeting; the previous `checkTreasuryBalance` existed but *nothing ever called it*, so the treasury-low alert could never fire. (3) **Boot-time validation** that errors when `TREASURY_COLD_ADDRESS` is unset or equals the hot wallet — a split that looks configured and isn't passes every runtime check silently. Thresholds are in *launches*, converted using the live fee, so a pons fee change needs no config edit. Alerts fire on state *changes*, deduplicated through the DB so a redeploy loop doesn't re-page, and recorded only *after* the notifier accepts them so a timed-out send is retried rather than swallowed. 23 tests. **Still needs the owner to create the cold wallet** (checklist item 0.8) — until then the split is configuration, not protection. |
| Listener reconciliation (`reconciler.ts`) | ✅ | **Part 7 §5, built 2026-07-30.** Polls recent mentions every 5 minutes and pushes anything the webhook never delivered back through the same `handleMention` pipeline. Safe to overlap with the webhook because the idempotency claim is a DB-level constraint — a test asserts the recovered path produces **no extra transaction and no extra fee**. A failed poll deliberately does *not* advance the watermark, so an unread window is retried rather than skipped; the lookback is clamped to 24h so a long outage doesn't replay days of mentions. 8 tests. `RealXClient.getRecentMentions` is still a stub pending the twitterapi.io account. |
| Wallet resolver (`walletResolver.ts`) | 🟡 | `MockWalletResolver` is fully functional for tests/local dev. `PrivyWalletResolver` is a stub — needs a real Privy account (Phase 0 action item). |
| Treasury signer (`treasurySigner.ts`) | 🟡 | `RawKeyTreasurySigner` works for testnet-only use and is explicitly blocked from running when `NODE_ENV=production`. `TurnkeyTreasurySigner` is a stub — needs a real Turnkey account (Phase 0 action item). |
| X client (`xClient.ts`) | 🟡 | `MockXClient` is fully functional for tests. `RealXClient` is a stub — needs a real twitterapi.io account (Phase 0 action item). |
| pons factory ABI (`ponsEncoder.ts`) | 🔴 | **Still the most important gap, and now known to be worse than "unverified".** The placeholder is *wrong in every parameter*: v2's real interface takes a `TokenParams` struct plus `launchConfigId` and `pairToken`, has no `feeWallet`, no `metadataURI`, and no dev-buy field at all (v1 calls it `initialBuyAmount`). The emitted event differs too. The v1 launch signature is published **nowhere**, so Blockscout remains the only route — or ask pons directly (`contact@ponsfamily.com`). Every existing test checks the *encoder's own* correctness against the placeholder; none can validate it against an interface we don't have. See `docs/pons-v2-findings.md` §2 and §6b. |
| Orchestrator (`orchestrator.ts`) | ✅ | Full pipeline tested end-to-end with mocks for every external dependency, including the specific prompt-injection scenario from Part 9 and an on-chain-revert failure path. |
| Reply composer (`replyComposer.ts`) | ✅ | Covered by orchestrator integration tests. |

**Backend test suite: 108/108 passing.** Run `cd backend && npm test` to verify yourself.

## Website

Branded **Ponsr**. One self-contained `index.html` — no build step, no JS dependencies.
Three client-side routes, each with a real URL so they can be linked, refreshed and shared:
`/` (landing), `?view=explore` (the board), `?token=SYMBOL` (token detail).

| Component | Status | Notes |
|---|---|---|
| Landing page | ✅ | Hero with cursor-tracking mascot, live ticker, live stat bar, how-it-works, spotlight, FAQ/disclaimer. Motion follows the GSAP preset specs implemented natively (split-text headline, magnetic CTA, staggered cards, layered parallax) — no external animation library. |
| Explore board | ✅ | Card grid with generated cover art, market cap, 24h change, bonding-curve progress, contract address and age. Search, five sort orders, status filter, and pagination that caps the DOM at 24 cards regardless of dataset size. |
| Token detail page | ✅ | Per-token page with a drawn chart, stats, contract address and share action. Reached by a shared-element page transition (View Transitions API where supported, plain swap otherwise). |
| "What if I held" panel | ✅ (UI) / 🔴 (needs indexer) | Gated behind an explicit connect-wallet step, per the decision in Part 3 §9. The connect button is a clearly-labelled preview that reveals sample figures — the real per-wallet history calculation (Part 3's Blockscout approach) is the Phase 6 indexer, not built here. |
| Data source | 🔴 | Everything renders from `MOCK_TOKENS` + a simulated live feed in `index.html`. `fetchLedger()` is the single integration point — replace it with the real API call and drive the same update helpers from a websocket. Contract addresses shown are deterministic placeholders, not real deployments. |
| Accessibility | ✅ | All 63 text/surface colour pairs clear WCAG AA 4.5:1 (verified by measurement, not by eye). Every interactive target ≥44×44px. Focus follows route changes into the visible view. `prefers-reduced-motion` disables the motion layer. |
| Smoke test | ✅ | 45/45 automated checks passing (`website/smoke-test.js`) — covers routing, the grid, sorting/search/pagination, the what-if gate, the motion layer, and regression guards for bugs found in audit (duplicate transition names, duplicate token symbols, focus stranded in a hidden view, a headline that stacked one character per line, an orphaned transition snapshot on back). |

## What "no mistake, no bugs, no error" actually means here

Every piece of logic in this build that *can* be tested without a live third-party account
has been tested — 166 automated checks across contract, backend, and website, all passing,
all re-runnable by you right now. Several real bugs were caught and fixed during this build
process specifically because of that testing (a fake-address format bug in a test fixture, a
foreign-key ordering issue in a test) — which is the point of testing: it's not a formality,
it found real mistakes before they could reach you.

What no one can honestly claim is that untested-against-the-real-world integration points
(the real Pons ABI, the real Turnkey/Privy behavior, the real twitterapi.io payload shapes)
are bug-free, because they have not been run against reality yet — only against careful,
best-effort assumptions about how they'll behave. That's not a caveat unique to this build;
it's true of any software that hasn't been through its own integration/staging environment
yet. The project's own implementation roadmap (Phase 1: testnet first) exists precisely to
close that gap safely, with fake money, before real money is ever at risk — and that phase
still needs to happen, starting with the action-checklist.md items.
