# Project Context for Claude Code

This file is read automatically when this project is opened in Claude Code. It exists so the
next phase of work can start immediately with full context, instead of re-deriving decisions
that have already been made and documented.

**Brand:** the project is **Ponsr**. It was originally called Holdfast; that name only
survives in historical notes.

## Read these first, in this order

1. **`docs/pons-v2-findings.md` — read §11 first, then §10, then §9.**

   **§11 (2026-08-20) is the most important section in this repository right now.** Ponsr had
   been reading a *superseded* pons factory. The current one has been open since 2026-08-03 and
   has taken over 1,900 launches, so everything §10 concluded about a "closed launchpad" was
   true of a contract nobody uses. §11 also carries the lesson that generalises: an address is
   not an identity.

   Sections 1–8 are what was believed from documentation. §9 onward is what the verified
   contracts and real mainnet launches actually showed. Where two sections disagree, the later
   one wins. §9.10 is an incident report worth reading before touching the deploy path.
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
  (Part 9). Run `backend/scripts/run-eval.ts` (**43 cases**) after any change to the system prompt
  in `backend/src/parser.ts` — the eval set must pass cleanly before the change is trusted.
  **Re-run it when the route changes too, not only the prompt.** Its first-ever run (2026-08-06)
  scored 25/28 against a prompt that had been assumed good for weeks. All three failures were
  one gap: distinguishing "this field is genuinely unsettled" from "I can work it out". The
  worst would have launched a token named `MOON` from `launch $MOON` — a permanent on-chain
  name nobody chose. The rules covering all three were already written; they were stated but
  not operational. An eval that has never run is not evidence of anything.

  On 2026-08-19 the suite was rewritten for the audience that actually exists: fourteen of
  its cases were in Indonesian, testing users Ponsr does not have. They are English now, with
  two kept non-English in Spanish and Portuguese — "international" is not "English-only", and
  the property worth guarding is that a label like `simbolo` is read as meaning rather than
  matched as a keyword. Four cases were added the same day for a real defect: a request that
  admits it has not decided the details ("just make me a token, name it whatever you want")
  returned isLaunchIntent false, and false is answered with silence.

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
- **Website is live at https://ponsr.fun** (78 smoke checks). Netlify, auto-deploying from
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

- **Target: the CURRENT pons v2, `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`.** See §11 of
  the findings. `launchEnabled()` is **true** and `canLaunch(treasury)` is **true** — Ponsr can
  launch today through the public gate, and never needed a whitelist to develop or test. The
  whitelist is still worth having, because it survives the gate closing.

  **Deployments are a registry now, not a config address** (`backend/src/deployments.ts`). Each
  entry binds factory, ABI hash, runtime bytecode hash, escrow, selector and schema; exactly one
  is executable and the older two stay indexable forever. A bare address let a superseded
  factory and the current one look identical, and every guard read the wrong one confidently
  for a week.

  Three things differ between the V2 deployments, each failing differently: the calldata gains a
  `salt` (selector `0xf35abbcf`, not `0xa41d5f2b`), the fee escrow is different, and the approved
  asset set is **23 rather than 8**, with RIVN already revoked. The escrow is the dangerous one —
  immutable in each splitter, claims pay `msg.sender`, no `claimFor` — so the wrong one strands a
  creator's fees permanently. Asserted before the splitter is deployed and again before the
  calldata is built.

  **The treasury is the on-chain deployer**, not the X user, who receives the creator share
  through the splitter. `launchTokenFor` would change that but is callable only by pons's
  forwarder. No reply or document may say otherwise.

  Verified with nothing broadcast: exact production calldata PASSES against the live factory by
  `eth_call`, and a forked rehearsal launches paired with AAPL, trades real AAPL, and claims the
  fee back out 95/5 with nothing stranded.

  **The Turnkey policy now allows the current factory** (2026-08-20). The operator created
  `ponsr-bot: launch on pons-v2-current-7ed` (`ece2a399-…`) with root credentials, and
  verification by signing — not by a config flag — shows the current factory ALLOWED, contract
  creation ALLOWED, and an arbitrary destination **denied**. That last line is the one that
  matters: an arbitrary DESTINATION is refused.

  **That is not the same as the treasury being safe, and this file said it was.** The
  policy also allows `eth.tx.to == ''` -- a contract creation, needed for the splitter --
  with no constraint on value. Measured 2026-08-21: Turnkey signs a creation carrying
  1 ETH. A creation's value lands in the contract being created and the sender writes
  that contract, so one transaction empties the hot wallet while every destination-only
  check still reported green. **CLOSED 2026-08-22** by policy
  `b647cc07-a7fe-4941-914c-2c1032392f80`, which binds `eth.tx.value == 0` on the creation
  clause; the broad `897d432e-…` was deleted after it was in place. A signed probe measured
  the funded creation **denied**, the zero-value splitter deploy still ALLOWED, and both
  factories ALLOWED. Nothing broadcast. **Residual, accepted:** initcode is not bound, so a
  zero-value deploy of arbitrary code remains possible — gas, never treasury. See
  `docs/TURNKEY-CREATION-AUTHORITY.md`.
  `scripts/turnkey-allow-v2-factory.ts` is named per deployment so it cannot collide with the
  older, still-present rule for the superseded factory.

  Two things about that verification are worth carrying forward. The verifier had been reading
  `PONS_V2_FACTORY_ADDRESS` and **passed for the superseded factory** — four green ticks about
  the wrong contract; it reads the registry now. And when Turnkey disabled signing org-wide over
  a quota, every check failed and the script reported them all as *denied*, sending the operator
  to fix a policy that was correct. A failure to ask is not a denial, and the run now reports
  INCONCLUSIVE rather than inventing a verdict.

  **Superseded 2026-08-24: production now runs this migration.** The paragraph that stood here
  said production config and the deployed backend were unchanged. That is no longer true — see
  "Production, as actually deployed" below. `PONS_FACTORY_VERSION` is `v2`, which on this code
  means the CURRENT factory.

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

1. ~~Create the **cold treasury wallet** and set `TREASURY_COLD_ADDRESS`~~ — the variable
   **is set** in `backend/.env` (verified 2026-08-20: a well-formed address, distinct from
   the hot wallet, so boot-time validation passes). This entry stayed on the list after it
   was done and was repeated back as an open blocker on 2026-08-20 without being checked.
   What remains is an owner fact no code here can confirm: that the address is a wallet
   whose key is genuinely held offline. A cold address that is merely a second hot wallet
   passes every check in this repository and provides none of the protection.
2. **Turnkey root key: a third copy exists and was used on 2026-08-20.** The 2026-08-19
   cleanup removed `~/ponsr-turnkey-root-key.txt` and the dashboard's original `.json` in
   `~/Downloads`, and was recorded here as done. It was not: a copy in
   `~/Downloads/Telegram Desktop/` survived, and it is the one that created the v2 policy
   on 2026-08-20. Two copies were found by searching; the third was found by needing it.

   That is the lesson worth keeping, more than the file itself. A credential that has been
   sent through a chat client exists wherever that client writes attachments, and "I
   deleted it" describes the copies you remembered. Root bypasses the policy engine
   entirely, so every surviving copy is a full bypass of the scoping the bot relies on.

   Owner action: delete that file, and delete the root API key from the Turnkey dashboard.
   Root keys are disposable — mint one with a passkey when an administrative act needs it.
   The bot never needed root: it runs on a scoped key that can reach the pons factories and
   nothing else.
3. ~~Backend hosting, for the listener to run 24/7~~ — **done, and has been for a while.**
   `ponsr-backend` runs on Fly in `iad`, machine `867634bee0e048`, `min_machines_running = 1`
   and `auto_stop_machines = false`, health check passing. This entry sat here as an open
   blocker while the thing it describes was already serving `/status` on the public internet.

   **The stale-deploy problem that stood here is CLOSED (2026-08-24).** See "Production, as
   actually deployed" below. Everything this entry used to say — that the image predated the
   migration, that `/status` advertised the pre-migration belief, that the deploy was still
   to be sequenced with the canary plan — is history now, and is kept only in
   `PONSR-DEPLOY-PAUSED-REPORT.txt`.

### Production, as actually deployed (2026-08-24)

`ponsr-backend` on Fly runs **commit `7856dd2`, release v31**, image
`sha256:48982e5044369aa35724a15a06178012c8d368cac96710b424f3945acc18fa3c`. One machine
(`867634bee0e048`, `iad`), volume `vol_r1j1nwjzdx6p7q3r` attached. Rollback target is the
exact previous digest, `sha256:37f2755c26949ed9d2fb249070838b89ea09f033a5c29750ede4105f37f8bd8a`
(v30) — name the digest, never "the previous release".

Live `/status` serves the typed `spend` envelope: `rolling-24h`, chain 4663,
`pons-v2-current-7ed`, factory `0x7eD598…EC7e`, treasury pinned to the hot wallet,
`publicLaunchEnabled: false`. Overall `degraded` is CORRECT — `public-launches` is the only
non-ok check and it must stay paused.

Three booleans are now set explicitly rather than inherited, because the runtime parses them
strictly (see below): `TURNKEY_POLICY_CONFIRMED=true`, `PUBLIC_LAUNCH_ENABLED=false`,
`REPLY_INCLUDE_LINK=false`. Two of those names did not previously exist as secrets at all.

**Two lessons from this deploy, both about documents rather than code.**

Production had already been migrated to the current factory in release v30, hours before the
paused deploy, and nothing in this repository recorded it. Four consecutive review reports
told an external reviewer that production ran the *superseded* factory. Each was true when
written. Before describing what production believes, read `/status` — this file is a summary
of the past, not an observation of the present.

And **`z.coerce.boolean()` is never the right parser for an environment variable.** It is
JavaScript truthiness, so `"false"` and `"0"` both parse as **true**. It was applied to
`TURNKEY_POLICY_CONFIRMED`, the one setting whose entire job is to let somebody say "I have
NOT verified the signer policy", and to `REPLY_INCLUDE_LINK`, where declining a 13× per-reply
cost opted into it. Both now use `parseAcknowledgement` — tolerant about shape, strict about
meaning — and a test fails if any schema field returns to the coercion. Production refuses to
start unless the acknowledgement is exactly `true`, so a clean boot is itself evidence the
value was accepted.

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
  wallet — the latter being a split that looks real and isn't. **It is set** as of
  2026-08-20. Note what that check can and cannot see: it proves the address is well-formed
  and different, not that its key is offline.
- ~~Listener reconciliation (Part 7 §5)~~ — **built 2026-07-30**, `src/reconciler.ts` with
  8 tests. Runs every 5 minutes from `index.ts`. `RealXClient.getRecentMentions` remains a
  stub until the twitterapi.io account exists.

## Testing conventions already established

- Every module has a corresponding test file. Keep the ratio — don't add orchestrator logic
  without a matching integration test in `backend/tests/orchestrator.test.ts`.
- External dependencies (parser, wallet resolver, X client, treasury signer) are always
  injected via interfaces with a `Mock*` implementation for tests. Follow this pattern for any
  new external integration rather than hardcoding a real client into business logic.
- The website has its own suite: `node website/smoke-test.js` (**78 checks**, no install needed).
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
