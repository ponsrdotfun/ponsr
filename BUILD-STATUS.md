# Build Status

> **The on-chain half of this project is finished and proven** (2026-08-04). Read
> `docs/pons-v2-findings.md` §9 for the full record. Short version:
>
> - The verified v1 source was read directly, settling the launch signature, the fee model,
>   and whitelisting — none of which needed the reply from pons everyone was waiting on.
> - Two real mainnet launches were performed, self-dealt. The second collected real trading
>   fees and **split them 95/5 exactly, with nothing left behind**.
> - `FeeSplitter.sol` was broken — not for the escrow reason feared, but because pons pays in
>   **ERC20** and it handled only native ETH. Rewritten and now proven on-chain.
>
> What remains is not on-chain work. It is three account signups (Privy, Turnkey,
> twitterapi.io) and a cold wallet.

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
| `FeeSplitter.sol` | ✅ | 95/5 split, immutable, no admin function. **Rewritten 2026-08-04 for ERC20**, which is how pons actually pays creator fees — the locker pushes `token0`/`token1` from the launch's Uniswap v3 position and native ETH never appears. The previous ETH-only version would have accepted those transfers and had no function able to move them out again, stranding every creator's fees permanently. 28/28 tests, covering four token shapes (normal, no-return/USDT-style, false-return, reentrant), a blacklisted recipient, and a rounding invariant across seven awkward amounts. A reentrancy guard was added because a test proved a hostile token could re-enter `splitERC20` and skew the split to 99.75/0.25. |
| Deployed & proven on-chain | ✅ | **Testnet 2026-08-04:** 1000 mock tokens split 950/50 with a zero balance left behind — the stranding failure, checked on a real chain rather than a Hardhat network. `splitERC20` costs 118,955 gas.<br><br>**Mainnet 2026-08-04:** two self-dealt Phase B launches. The second (`0xd80580…eC87`) received real trading fees from a real buy, and `splitERC20` divided **0.00003465 WETH into 95% / 5% exactly, summing to the total**. Read from the contract's own `ERC20FeesSplit` event, not from balance deltas — see the false alarm in §9.11.<br><br>The first mainnet launch deployed the **wrong version** of the splitter and its fees are stranded forever; that incident, its cause, and the two guards added because of it are in §9.10. It cost about $2 because Phase B is self-dealt by design. |
| Professional audit | 🔴 | Not performed. Carefully written, thoroughly tested, and now exercised on mainnet with real fees — but per `backend/docs/SECURITY-BOUNDARIES.md` item 7 none of that is a professional audit. Worth weighing against what the on-chain runs actually found: the ERC20 defect was caught by reading pons's source, the reentrancy hole by writing a test, and the wrong-version deploy by an on-chain check. An audit is for the class of defect none of those would surface. |

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
| pons factory ABI (`ponsEncoder.ts`) | ✅ | **Resolved 2026-08-04 — this was the project's longest-standing gap.** The verified ABI is checked in at `src/abi/ponsLaunchFactory.json`, pulled from `robinhoodchain.blockscout.com`, whose API needs no key. (Every checklist item pointed at `api.blockscout.com`, the Pro aggregator, which does — one wrong URL is why this read as blocked on an account signup.) The placeholder was wrong in every parameter. Tests now round-trip through the real ABI, so a wrong struct shape fails the suite instead of passing against a fiction. See `docs/pons-v2-findings.md` §9. |
| Orchestrator (`orchestrator.ts`) | ✅ | Full pipeline tested end-to-end with mocks for every external dependency, including the specific prompt-injection scenario from Part 9 and an on-chain-revert failure path. |
| Reply composer (`replyComposer.ts`) | ✅ | Covered by orchestrator integration tests. |

**Backend test suite: 131/131 passing.** Run `cd backend && npm test` to verify yourself.

## Website

**Live at https://ponsr.fun** since 2026-08-04 (Netlify, auto-deploys from `main`).

Branded **Ponsr**. One self-contained `index.html` — no build step, no JS dependencies.
Three client-side routes, each with a real URL so they can be linked, refreshed and shared:
`/` (landing), `?view=explore` (the board), `?token=SYMBOL` (token detail).

| Component | Status | Notes |
|---|---|---|
| Landing page | ✅ | Hero with cursor-tracking mascot, live ticker, live stat bar, how-it-works, spotlight, FAQ/disclaimer. Motion follows the GSAP preset specs implemented natively (split-text headline, magnetic CTA, staggered cards, layered parallax) — no external animation library. |
| Explore board | ✅ | Card grid with generated cover art, market cap, 24h change, bonding-curve progress, contract address and age. Search, five sort orders, status filter, and pagination that caps the DOM at 24 cards regardless of dataset size. |
| Token detail page | ✅ | Per-token page with a drawn chart, stats, contract address and share action. Reached by a shared-element page transition (View Transitions API where supported, plain swap otherwise). |
| "What if I held" panel | ✅ (UI) / 🔴 (needs indexer) | Gated behind an explicit connect-wallet step, per the decision in Part 3 §9. The connect button is a clearly-labelled preview that reveals sample figures — the real per-wallet history calculation (Part 3's Blockscout approach) is the Phase 6 indexer, not built here. |
| Data source | ✅ | **Real on-chain data since 2026-08-04.** The board reads `TokenLaunched` from the pons factory, filtered on the event's indexed `deployer` so only Ponsr's own launches appear, and enriches from Blockscout. Both endpoints are CORS-open, so the site stays one static file with no backend.<br><br>What this replaced was worse than a placeholder: 24 generated tokens with market caps, holder counts and contract addresses that existed on no chain, a new fake launch every seven seconds, drifting prices, and a "synced just now" badge over all of it — under a heading reading *Every launch, on the record*.<br><br>**Where data does not exist it is now absent, not invented.** No price history means no sparkline and no 24h change; the what-if panel says it needs an indexer instead of unlocking figures; the spotlight is labelled an illustration. Liquidity is shown in ETH because this chain has no price oracle a static page can read. |
| Accessibility | ✅ | All 63 text/surface colour pairs clear WCAG AA 4.5:1 (verified by measurement, not by eye). Every interactive target ≥44×44px. Focus follows route changes into the visible view. `prefers-reduced-motion` disables the motion layer. |
| Smoke test | ✅ | 45/45 automated checks passing (`website/smoke-test.js`) — covers routing, the grid, sorting/search/pagination, the what-if gate, the motion layer, and regression guards for bugs found in audit (duplicate transition names, duplicate token symbols, focus stranded in a hidden view, a headline that stacked one character per line, an orphaned transition snapshot on back). |

## What "no mistake, no bugs, no error" actually means here

Every piece of logic in this build that *can* be tested without a live third-party account
has been tested — 212 automated checks across contract, backend, and website, all passing,
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
