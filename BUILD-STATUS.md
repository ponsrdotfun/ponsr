# Build Status

> **The on-chain half of this project is finished and proven** (2026-08-04). Read
> `docs/pons-v2-findings.md` **§11 first**, then §10, then §9. Short version:
>
> - **The factory this project read for weeks was superseded.** pons replaced it on
>   2026-08-03. The one they actually use — `0x7eD598…EC7e` — has `launchEnabled` **true** and
>   `canLaunch(treasury)` **true**, and has taken over 1,900 launches. Everything §10 concluded
>   about a closed launchpad and a whitelist blocker was true of a contract nobody uses.
>   `backend/src/deployments.ts` is the registry that makes that mistake un-repeatable: three
>   deployments, **exactly one executable**.
> - Two real mainnet launches were performed, self-dealt. The second collected real trading
>   fees and **split them 95/5 exactly, with nothing left behind** — 95/5 of what reaches our
>   splitter, which is 70% of trading fees after pons's locker, so **66.5% creator / 3.5%
>   treasury**.
> - `FeeSplitter.sol` was broken — not for the escrow reason feared, but because pons pays in
>   **ERC20** and it handled only native ETH. Rewritten and now proven on-chain.
>
> **The bot is live and the full path is proven** (2026-08-12). A tweet from a real account
> produced a real token and a real reply on X: parse, anti-Sybil validation, Privy wallet,
> splitter deploy, `launchToken`, answer. Every provider is wired and verified against its
> live service; the backend runs on Fly as `ponsr-backend` (`iad`,
> `min_machines_running = 1`), health check passing.
>
> **What is deployed is not what is in this repository.** The running image was last updated
> 2026-08-19; the deployment registry landed 2026-08-20 and `main` is 56 commits ahead of it.
> Production is therefore still reading the **superseded** factory and saying so in public —
> its own `/status` reports *"pons has switched launching off and this treasury is not
> whitelisted -- no launch can succeed"*, which is the pre-migration belief this repository
> has since retracted.
>
> That stale deploy is currently acting as a brake: the running bot refuses every launch
> because it thinks the launchpad is shut. It was never a safety measure — the same process
> holds the Turnkey bot key — but the creation-authority finding below is now **closed**, so
> the reason to keep the deploy blocked has gone. What remains is a sequencing question:
> deploying IS the migration cut-over, because production still carries
> `PONS_FACTORY_VERSION=v2`, which on this code means the CURRENT factory where
> `canLaunch(treasury)` is true. The deploy belongs with the canary plan, not on its own.
>
> What remains is not code — see `docs/action-checklist.md`.
>
> ## On the treasury: the bot's key could empty the hot wallet — closed 2026-08-22
>
> **This block used to say the opposite, and the correction is the point.**
>
<!-- historical -->
> It read: everything sits in the hot wallet "and it cannot be moved out", because the Turnkey
> policy "refuses every other destination — which is what makes a leaked signing key cost
> launches rather than the treasury."
<!-- /historical -->
>
> That was false, and it was measured false on 2026-08-21. The policy also allowed
> `eth.tx.to == ''` — a contract creation, which the splitter deploy genuinely needs — **with no
> constraint on value**, and Turnkey signed a creation carrying 1 ETH. A creation's value lands
> in the contract being created, and the sender writes that contract, so one transaction could
> empty the hot wallet while every destination-based check still reported green — a creation has
> no destination for those checks to look at.
>
> The reasoning error is worth keeping even now that the hole is shut: a policy was verified by
> testing the cases somebody thought of. "Arbitrary destination denied" is a true sentence that
> does not mean what it was being used to mean.
>
> **CLOSED 2026-08-22.** Policy `b647cc07-a7fe-4941-914c-2c1032392f80` binds
> `eth.tx.value == 0` on the creation clause; the broad `897d432e-…` was deleted only after
> the replacement was in place. A signed probe, nothing broadcast, measured the funded
> creation **denied** where it had been ALLOWED the day before, with the zero-value splitter
> deploy still ALLOWED and both factories ALLOWED.
>
> **Residual, accepted rather than fixed:** initcode is not bound, so a zero-value deploy of
> arbitrary code is still possible. Gas, never treasury — a zero-value creation has nothing
> to carry away. It is not initcode protection and must not be described as any.
>
> Still true regardless: the daily cap (`DAILY_SPEND_CAP_WEI`) is what bounds a compromised
> key's damage, and the reserve belongs in cold storage with the hot wallet funded in small
> amounts. `TURNKEY_POLICY_CONFIRMED` has not been set.

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
| `FeeSplitter.sol` | ✅ | 95/5 split, immutable, no admin function. **Rewritten 2026-08-04 for ERC20**, which is how pons actually pays creator fees — the locker pushes `token0`/`token1` from the launch's Uniswap v3 position and native ETH never appears. The previous ETH-only version would have accepted those transfers and had no function able to move them out again, stranding every creator's fees permanently. tests covering four token shapes (normal, no-return/USDT-style, false-return, reentrant), a blacklisted recipient, and a rounding invariant across seven awkward amounts. A reentrancy guard was added because a test proved a hostile token could re-enter `splitERC20` and skew the split to 99.75/0.25. |
| Deployed & proven on-chain | ✅ | **Testnet 2026-08-04:** 1000 mock tokens split 950/50 with a zero balance left behind — the stranding failure, checked on a real chain rather than a Hardhat network. `splitERC20` costs 118,955 gas.<br><br>**Mainnet 2026-08-04:** two self-dealt Phase B launches. The second (`0xd80580…eC87`) received real trading fees from a real buy, and `splitERC20` divided **0.00003465 WETH into 95% / 5% exactly, summing to the total**. Read from the contract's own `ERC20FeesSplit` event, not from balance deltas — see the false alarm in §9.11.<br><br>The first mainnet launch deployed the **wrong version** of the splitter and its fees are stranded forever; that incident, its cause, and the two guards added because of it are in §9.10. It cost about $2 because Phase B is self-dealt by design. |
| Professional audit | 🔴 | Not performed. Carefully written, thoroughly tested, and now exercised on mainnet with real fees — but per `backend/docs/SECURITY-BOUNDARIES.md` item 7 none of that is a professional audit. Worth weighing against what the on-chain runs actually found: the ERC20 defect was caught by reading pons's source, the reentrancy hole by writing a test, and the wrong-version deploy by an on-chain check. An audit is for the class of defect none of those would surface. |

## Backend

| Component | Status | Notes |
|---|---|---|
| Idempotency (`db.ts`) | ✅ | Atomic DB-level constraint, tested against simulated concurrent duplicate delivery. |
| LLM parser (`parser.ts`) | OK | **Live since 2026-08-06.** Claude Haiku 4.5, reached through OpenRouter (`OPENROUTER_API_KEY`); `createParser()` prefers a direct Anthropic key whenever one is added. The eval set (`scripts/parser-eval-set.json`, run with `npm run` on `run-eval.ts`) passes cleanly — its first ever execution scored 25 of the 28 cases it then held, and found three real defects in a prompt that had been treated as settled for weeks. Note OpenRouter answers HTTP 200 with an `error` body on upstream failure or exhausted credit, so a billing problem is detected rather than surfacing as a parse failure. |
| Validation guard (`validator.ts`) | ✅ | Part 5 mitigations 1–4 and the #7 admission gate implemented and tested: anti-Sybil thresholds, per-user rate cap, global daily spend circuit breaker, live max-fee ceiling, and a live hot-wallet balance floor. The last two rejections are deliberately distinct — `DAILY_SPEND_CAP_REACHED` means funds exist and policy says stop; `TREASURY_EXHAUSTED` means the wallet is actually out. They need different responses from the operator. |
| Monitoring & alerting (`monitor.ts`) | OK | **Part 5 mitigation #5.** Detects launch-volume spikes against a rolling baseline, Sybil probing by distinct rejected accounts, circuit-breaker trips, fee-ceiling hits, low treasury and on-chain failures. Alerts are deduplicated, and every monitor call is fire-and-forget so a dead notifier can never fail a launch. **Delivery is Telegram since 2026-08-12** (`@PonsrLogs_Bot`), verified against the real chat; the console remains the fallback, so an outage degrades the channel rather than losing the alert. Also alerts when a reply fails after a successful launch, when a reply had to go out **stripped of the token address** (X refuses crypto addresses for seven days after an account authenticates, and that fallback used to be a console.warn nobody saw), and when the mention sweep keeps failing. |
| Hot/cold treasury split (`treasuryPolicy.ts`) | OK (code) / PARTIAL (in practice) | **Part 5 mitigation #7.** An admission gate that refuses a launch the hot wallet cannot fund, a balance watch every 15 minutes, and boot-time validation that errors when the cold address is unset or equals the hot wallet. Thresholds are in *launches*, converted using the live fee. 23 tests. **The cold address was set on 2026-08-11 — but as of 2026-08-12 it holds 0 ETH and the hot wallet holds all of it.** Until funds actually sit in cold, the split is configuration rather than protection, and the daily cap (0.01 ETH) is what bounds the damage. |
| Listener reconciliation (`reconciler.ts`) | OK | **Part 7 §5.** Sweeps recent mentions on an interval and pushes anything the webhook never delivered through the same idempotent path. The interval is `MENTION_POLL_SECONDS`, **currently 120** — it is the latency a user feels and is bought from twitterapi.io by the poll, so the arithmetic sits beside the setting. Alerts after three consecutive failures, and reports recovery. **In practice this is the primary path, not the safety net:** no webhook provider is wired.<br><br>**Incident 2026-08-24: the bot was deaf and nothing said so.** twitterapi.io credit hit **-89** and every poll had been answering `402 Credits is not enough` for days. Two things hid it. The alert fires once per incident by design -- correct for something that gets noticed, useless here, since that single line had scrolled out of Telegram days earlier. And `/status` reported `mention-crosscheck = ok`, which reads whether an interval is CONFIGURED; an interval cannot go wrong in the way that mattered. A dead read path and a quiet afternoon produce identical evidence: no mentions. Fixed by a `mention-sweep` check that reads the age of the last SUCCESSFUL poll, a `read-credits` check on the provider's balance, and an alert that repeats while the condition persists. Note the balance endpoint is **free** -- it answered 200 with the negative balance while every paid call was refused, so the bot could have watched its own wallet all along at no cost. |
| Dependency status (`statusReport.ts`) | OK | **`/status`, added 2026-08-15.** `/health` stays deliberately shallow because Fly restarts on a failing check and a restart cannot fix an RPC outage — so nothing anywhere reported the real state. This reads the chain id and head, the live launch fee, `launchEnabled`, the hot balance **expressed in launches it can fund**, today's spend against the circuit breaker, and whether the cold address, alert transport and cross-check are configured. Every chain call is bounded: a status page that hangs when the RPC hangs has said nothing at the moment it was needed. The parser is reported as configured rather than proven, and says so — a live parse is billed. Unauthenticated on purpose; all of it is already public on chain. 13 tests. |
| Launchpad watch (`launchpadWatch.ts`) | OK | **Added 2026-08-15, because `/status` found the thing it watches.** `launchEnabled` is pons's switch, not ours. They turned it off at **2026-08-12 19:42 UTC** on both factories and nothing here noticed for three days — the process stayed up, `/health` answered ok, and a closed launchpad with no mentions looks exactly like an open one with no mentions. Runs on a timer and at boot rather than waiting for traffic, since waiting for traffic means waiting for the failure. Alerts once down, once back. A whitelisted treasury is not an outage; an unreadable factory holds its previous belief rather than guessing. 7 tests. |
| Pair-asset discovery (`pairTokens.ts`, `pairTokenSource.ts`) | OK | **Added 2026-08-18.** pons v2 lets a launch be priced, funded and graduated in an approved asset other than ETH. The superseded factory approved eight; the current one approves **23**, with RIVN already revoked — which is itself the argument for the next sentence. The set is **discovered from the factory's own approval history, never hardcoded**: pons calls `setPairTokenApproved` whenever they like, and a checked-in list is a snapshot of one afternoon — this document's own §7 recorded "nothing is approved, not even ETH" and was wrong eleven days later. Three traps handled: `approvedPairTokens(0x0)` is `false` yet ETH pairing works (the gate short-circuits on the zero address), USDG is **6-decimal** against 18 everywhere else, and the log is re-checked live before an asset is offered. Resolution is strict — `AAP` does not become `AAPL`. Scanning is incremental; a full pass is 56s measured. 26 tests. |
| Deployment registry (`deployments.ts`) | OK | **Added 2026-08-20.** Ponsr reported a closed launchpad for a week while reading `0x7E1EAbd5…`, a factory pons replaced on 2026-08-03. The current one — `0x7eD598…EC7e` — has `launchEnabled` **true**, `canLaunch(treasury)` **true**, and has taken over 1,900 launches. One mutable address made the two indistinguishable, so a deployment is now a bound set of facts: ABI hash, runtime bytecode hash and length, escrow, launch selector, TokenParams schema, start block. **Exactly one entry is executable**; v1 and the superseded v2 stay indexable forever, because both carry real launches the board still shows. 5 tests. |
| Deployment identity (`deploymentIdentity.ts`) | OK | **Added 2026-08-20, closing a gap the registry itself left.** `deployments.ts` had recorded an ABI hash, a runtime bytecode hash and a selector since it was written, and nothing read them — accurate, checked-in, inert data, while the launch path still resolved a factory by address alone. That is the same shape as the bug the registry replaced. Four axes, each with a different source of truth: runtime length and sha256 from the chain, `feeEscrow()` from the chain, ABI hash from the file on disk, and the selector **derived from that ABI** rather than compared to itself — which would prove nothing. Every drifted axis is reported, not just the first, so an operator is not surprised twice. Runs inside `readCurrentReadiness()` **ahead of every permission**: a green `canLaunch` from an unexpected contract is not reassurance, it is the most dangerous reading available. Verified live — all three deployments `IDENTITY OK`, the executable one matching the audit's independent values exactly. It first raised two **false alarms** against correct data (v1's ABI file wraps its array in provenance metadata; v1 has no `feeEscrow()` because it pushes from the locker) — both fixed, and the second added an explicit `feeModel` field, since one field had been holding a different *kind* of thing per deployment. 16 tests. |
| Current v2 encoder (`ponsV2CurrentEncoder.ts`) | OK (code) / NOT DEPLOYED | Current `TokenParams` ends with an extra `bytes32 salt`, moving the selector from `0xa41d5f2b` to `0xf35abbcf` — so the previous encoder aimed at the current factory reverts a transaction that has already paid gas. The salt is domain-separated over chain, factory and tweet id: without the factory in the preimage a retried request could predict an address already holding a token from the old factory. It does not replace the database claim; it is a second barrier if that claim is ever lost. **Verified by `eth_call` against the live factory**: exact production calldata PASSES, and every mutation fails as designed — old selector reverts, unapproved pair gives `PairTokenNotApproved`, stale digest gives `LaunchEconomicsMismatch`, a fee one wei short gives `LaunchFeeNotPaid`. 10 tests. |
| Superseded v2 launch path (`ponsV2Encoder.ts`, `launchTarget.ts`) | OK (code) / SUPERSEDED — see the row above | **Everything in this row describes `0x7E1EAbd5…`, the factory pons replaced on 2026-08-03.** It is kept because that deployment holds real launches and the encoder still has to read them; it is not the launch path. `NotWhitelisted` and "no salt" below are facts about that contract, not about Ponsr today — the current factory takes a `salt` and `canLaunch(treasury)` is true. **v2's `launchToken` is a different function**, not v1 plus an argument: `dexId` and `salt` are gone, `feeWallet` became `creatorFeeRecipient`, and `creatorTaxBps`, `buybackEnabled` and `expectedEconomics` appeared. Ponsr sends **creatorTaxBps 0** — a tax is a charge on every trade of somebody else's token, invisible to them, on a launch they cannot renegotiate — and **pins `expectedEconomics`** from `previewLaunchEconomics`, so a change on pons's side between the read and the transaction landing reverts rather than silently repricing. **Note v2 has no salt**, so the only duplicate-launch guard there is the database's idempotency claim. Selected by `PONS_FACTORY_VERSION`; v1 remains the default. **Verified by simulation against the live mainnet factory**: from a whitelisted address, launches paired against AAPL, GME, SPY, USDG and ETH all return WOULD SUCCEED, a bogus asset reverts `PairTokenNotApproved`, and from this treasury the same calldata reverts `NotWhitelisted` — the one gate that is not ours to fix. 25 tests. |
| v2 fee path (`FeeSplitterV2.sol`) | OK (code) / REHEARSED (not yet live) | **Added 2026-08-18, and it is the reason a v2 launch would have lost money.** v1 pushes fees to the recipient; **v2 credits them to `PonsV2FeeEscrow` and pays whoever calls `claimToken` — `msg.sender`, with no `claimFor`.** A plain `FeeSplitter` named as a v2 launch's `creatorFeeRecipient` would be credited correctly and forever with no transaction able to move the money: §9.10 by a different route. `FeeSplitterV2` inherits the split logic rather than restating it, and adds `claimAndSplit` plus an amount-taking form the escrow's own docs say is necessary. Three independent guards refuse to get it wrong quietly: one compile emits both artifacts, the deployer picks by factory version and throws rather than falling back, and `phase-b-launch.ts` reads `claimAndSplit`'s selector out of the deployed bytecode. 12 contract tests against a mock built from the escrow's source, **and a full rehearsal on a forked mainnet** (`scripts/fork-rehearsal.js`, 2026-08-19): a launch paired against AAPL through the real factory, a real 50 AAPL buy on the bonding curve, and the fee claimed back out and split — creator 0.16255 AAPL, treasury 0.00855, nothing stranded. The fork taught three things reading could not: the chain is on **Cancun** (under Shanghai the launch reverts with a bare `invalid opcode`, because pons v2 graduates into Uniswap V4), fees are **credited to the escrow on every trade** rather than accumulating on the curve so there is nothing to sweep, and the split prints as 94.99/5.00 because the creator's share is floored and the dust goes to the treasury. **Still not a live launch:** impersonation is exactly what mainnet will not allow, so the first real one must still be self-dealt. |
| Wallet resolver (`walletResolver.ts`) | ✅ | **Implemented 2026-08-04** against `@privy-io/node` (`server-auth`, which the old TODO named, is deprecated). One embedded wallet per X user, created on first contact. The X user ID is stored as Privy's `external_id` — write-once and unique on their side, so a database restore or a race cannot mint a second wallet for someone who already has one; on that collision the existing wallet is recovered. **Verified live**: `scripts/check-providers.ts` created a real wallet. |
| Treasury signer (`treasurySigner.ts`) | ✅ | **Implemented and scoped 2026-08-04.** `RawKeyTreasurySigner` remains testnet-only and refuses to run under `NODE_ENV=production`. `TurnkeyTreasurySigner` signs through `@turnkey/ethers`.<br><br>The important work was not the code. A probe measured that the **root user bypasses Turnkey's policy engine** — a DENY-all policy was active and a signature still went through — so any policy written for the original key would have appeared in the dashboard and enforced nothing. The bot now runs as a non-root, API-only user whose policy allows exactly two things, **verified rather than assumed**: a transaction to the pons factory (ALLOWED), a contract creation for the splitter (ALLOWED), a transaction anywhere else (DENIED). A leak of that key once reached further than launches: the policy allowed `eth.tx.to == ''` for the splitter deploy with no value constraint, and Turnkey was measured on 2026-08-21 signing a creation carrying 1 ETH — a creation has no destination for the arbitrary-address check to catch. **Closed 2026-08-22** by `b647cc07-…`, which binds `eth.tx.value == 0` on that clause; re-probed the same day, the funded creation came back denied. Initcode is still unbound, so a zero-value deploy of arbitrary code remains possible: gas, never treasury, and recorded as accepted residual rather than protection. See `docs/TURNKEY-CREATION-AUTHORITY.md`.<br><br>`assertTurnkeyPolicyAcknowledged()` blocks production start until `TURNKEY_POLICY_CONFIRMED` is set, because an unpolicied key is indistinguishable from a correct one until it is abused. |
| X client (`xClient.ts`) | ✅ (code) / 🔴 (needs keys) | **Implemented 2026-08-04, and split across two providers.** Reads (mentions, account signals) go to twitterapi.io; writes (replies) go to **X's own API** over OAuth 1.0a. They are different kinds of operation: reading is invisible high-volume data collection, posting is account activity that can get `@ponsrdotfun` suspended — and unlike a domain or a contract, an account cannot be re-minted. X's move to pay-per-use made this affordable: $0.015 a reply, one reply per launch, roughly $1.50/month. That retires Part 10's unanswered question about third-party posting rather than arguing it.<br><br>⚠️ **A reply containing a URL costs $0.200, not $0.015** — 13x. Linking to ponsr.fun from the success reply is therefore a pricing decision, held behind `REPLY_INCLUDE_LINK` and defaulting to off. 8 tests, including that reads never touch the write path.<br><br>Needs `TWITTERAPI_IO_KEY` plus the four `X_API_*` credentials. |
| pons factory ABI (`ponsEncoder.ts`) | ✅ | **Resolved 2026-08-04 — this was the project's longest-standing gap.** The verified ABI is checked in at `src/abi/ponsLaunchFactory.json`, pulled from `robinhoodchain.blockscout.com`, whose API needs no key. (Every checklist item pointed at `api.blockscout.com`, the Pro aggregator, which does — one wrong URL is why this read as blocked on an account signup.) The placeholder was wrong in every parameter. Tests now round-trip through the real ABI, so a wrong struct shape fails the suite instead of passing against a fiction. See `docs/pons-v2-findings.md` §9. |
| Orchestrator (`orchestrator.ts`) | ✅ | Full pipeline tested end-to-end with mocks for every external dependency, including the specific prompt-injection scenario from Part 9 and an on-chain-revert failure path. |
| Reply composer (`replyComposer.ts`) | ✅ | Covered by orchestrator integration tests. |

**Backend test suite: run it rather than trust a number here.** `cd backend && npm test`.
A hardcoded count in a document is stale the next time somebody adds a test, and this one
said 151 while the suite had grown past 500 -- a figure that looks like evidence and is not.

## Website

**Live at https://ponsr.fun** since 2026-08-04 (Netlify, auto-deploys from `main`).

Branded **Ponsr**. One self-contained `index.html` — no build step, no JS dependencies.
Three client-side routes, each with a real URL so they can be linked, refreshed and shared:
`/` (landing), `?view=explore` (the board), `?token=SYMBOL` (token detail).

| Component | Status | Notes |
|---|---|---|
| Landing page | ✅ | Hero with cursor-tracking mascot, live ticker, live stat bar, how-it-works, spotlight, FAQ/disclaimer. Motion follows the GSAP preset specs implemented natively (split-text headline, magnetic CTA, staggered cards, layered parallax) — no external animation library. |
| Explore board | OK | Card grid with generated cover art, ETH liquidity, bonding-curve progress, contract address and age. Search, sorting and pagination. **Market cap and 24h change are not shown** — both need a price oracle or an indexer that does not exist here, and the board hides what it cannot read rather than inventing it. Token identity comes from the contract's own `name()`/`symbol()`, and URLs are keyed on the contract address, because two people can and did ask for the same symbol. |
| Token detail page | OK | Per-token page with stats, contract address, the what-if panel and a share action that builds a card image. **No chart is drawn** — there is no price history, and a flat line is a picture of a claim nobody can make. Reached by a shared-element page transition. |
| "If you never sold" panel | OK | **Built for real 2026-08-12; it was a stub before.** Reads ERC20 `Transfer` logs filtered on the connected wallet plus the pool price from `slot0`. The identity received − sent = balance is asserted before anything is shown, and a mismatch displays nothing rather than a figure that might be wrong. Denominated in ETH — this chain has no price oracle, so a dollar figure could only be invented. A sale is a transfer whose transaction also swapped on the pool, which is the only reading that survives a router taking custody first. |
| Data source | ✅ | **Real on-chain data since 2026-08-04.** The board reads `TokenLaunched` from the pons factory, filtered on the event's indexed `deployer` so only Ponsr's own launches appear, and enriches from Blockscout. Both endpoints are CORS-open, so the site stays one static file with no backend.<br><br>What this replaced was worse than a placeholder: 24 generated tokens with market caps, holder counts and contract addresses that existed on no chain, a new fake launch every seven seconds, drifting prices, and a "synced just now" badge over all of it — under a heading reading *Every launch, on the record*.<br><br>**Where data does not exist it is now absent, not invented.** No price history means no sparkline and no 24h change; the what-if panel says it needs an indexer instead of unlocking figures; the spotlight is labelled an illustration. Liquidity is shown in ETH because this chain has no price oracle a static page can read. |
| Accessibility | ✅ | All 63 text/surface colour pairs clear WCAG AA 4.5:1 (verified by measurement, not by eye). Every interactive target ≥44×44px. Focus follows route changes into the visible view. `prefers-reduced-motion` disables the motion layer. |
| Smoke test | OK | **automated checks** (`website/smoke-test.js`, which prints its own count -- this line said 74 while the suite had grown past 80) — routing by contract address, the grid, sorting/search/pagination, the what-if gate, motion, accessibility, the terms link, that no asset path is relative, and **the share cards** — which had no coverage at all until 2026-08-15, because jsdom has no canvas and every builder simply threw. The suite now supplies a recording 2d context with a proportional measureText, which caught a roast long enough to run through the wordmark and off the bottom edge. Several checks exist because a specific bug shipped: read the comment above one before changing it. |

## What "no mistake, no bugs, no error" actually means here

Every piece of logic in this build that *can* be tested without a live third-party account
has automated coverage across contract, backend, and website suites, all re-runnable by you
right now. Run them for current counts and results. Several real bugs were caught and fixed
during this build process specifically because of that testing (a fake-address format bug in a test fixture, a
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
