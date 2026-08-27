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
  "Production, as actually deployed" below.

  **And superseded again 2026-08-26: there is no factory setting any more.**
  `PONS_FACTORY_VERSION` selected the destination and **defaulted to `v1`**, so an
  environment that never mentioned it launched through the superseded factory. Two
  production launches on 2026-08-12 went to v1 through exactly that path — see
  `docs/v1-historical-launches.md`, which also corrects an earlier claim that their creator
  fees were unrouted (the splitters exist and are wired; the DB row is what is missing).
  The setting, `V1Target`, `PONS_FACTORY_ADDRESS` and `PONS_LOCKER_ADDRESS` are all gone.
  The registry decides, and `executableDeployment()` throws unless exactly one entry is
  executable. The signer allowed v1 for two days longer than the code did, because code
  cannot remove a permission that lives in Turnkey.

  **CLOSED 2026-08-28 by the owner ceremony.** The signer now holds exactly two policies:
  `ece2a399-…` (the current factory) and `60ef12fa-c498-4eaa-a6bb-f20c502152d6`
  (`eth.tx.to == '' && eth.tx.value == 0`, contract creation only). The combined
  `b647cc07-…` and the legacy-v2 `1b8b585f-…` are gone. A signed six-probe matrix measured
  v1 **denied**, legacy-v2 **denied**, the current factory ALLOWED, zero-value creation
  ALLOWED, a funded creation **denied** and an arbitrary destination **denied** — PASS,
  exit 0, nothing broadcast.

  The ORDER was the load-bearing part, and it is why the creation-only rule was created
  before either deletion: `b647cc07` carried the ONLY contract-creation clause, so deleting
  it first would have left a bot that can launch and then cannot deploy its splitter —
  after the launch fee is already spent. It is also why the intermediate probe is
  EXPECTED to fail: while both rules grant creation, no probe can tell which one is
  enforcing. Only the final matrix, with `60ef12fa` alone, proves the replacement works.
  Residual is unchanged: initcode is still unbound, so a zero-value deploy of arbitrary
  code costs gas and never treasury.

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

**THE BACKEND IS FROZEN as of 2026-08-28.** The launch path is proven end to end on mainnet
through the current V2 factory, the signer holds only the two policies it needs, and production
is serving on v38 with the public gate false. Nothing about the backend is the bottleneck any
more, so it stops being where effort goes.

**Next focus is website, data and distribution.** Whatever a reader can see: the board and token
pages, what the site can honestly show from the chain, and how anyone finds Ponsr at all.

The freeze is a default, not a prohibition. What it means concretely:

- No backend feature work, refactor or dependency change without a reason that names a defect
  or a brief. "While I'm in here" is exactly what it exists to stop.
- The public gate stays **false**. Opening it is an owner decision with its own authorisation,
  not a step in some other task.
- **Every remaining chain action that moves value needs its own fresh authorisation.** The
  one-canary authorisation of 2026-08-28 is consumed. The obvious next one — trading against
  the curve and running `collect:v2` to prove the 95/5 split end to end — is a financial action
  and is NOT covered by anything already granted.
- Security and correctness fixes are always in scope. A freeze on features is not a freeze on
  defects.

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
2. ~~**Turnkey root key**~~ — **REVOKED 2026-08-26, and the dashboard is the proof.**

   The lesson is worth more than the file, and it took two attempts to learn. The
   2026-08-19 cleanup was recorded here as done and was not: a copy in
   `~/Downloads/Telegram Desktop/` survived. **A credential that has been sent through a
   chat client exists wherever that client writes attachments, and "I deleted it"
   describes the copies you remembered.**

   Then the second half, which is the one that actually mattered: **deleting the file was
   never revocation, and neither was storing it carefully.** Authority lives where the
   credential is REGISTERED. The local copies were verified gone on 2026-08-26 — a full
   profile sweep, Downloads, Desktop, Documents, all three Recycle Bin SIDs and 35
   archived reports — and the key was still live the whole time.

   Owner-revoked in the Turnkey dashboard on 2026-08-26. Verified two ways: the Root user
   now shows *No API keys registered*, and `scripts/turnkey-read-policies.ts` still
   authenticates with the BOT key and returns all three policies, which is what proves the
   right key was removed. **Owner/dashboard-proven — not reproducible by anything in this
   repository**, which has no way to read the API-key list.

   **A recorded fact here was wrong.** This entry said the key was created 2026-08-20 and
   that it created policy `ece2a399-…` that day. The dashboard shows it was created
   **2026-08-05 10:35 and last used 2026-08-05 10:35** — the same minute, so it was never
   used again after the day it was made. 2026-08-20 was the date of the FILE, not of the
   key; the policy work that day went through the dashboard passkey.

   **Residual, accepted and not a blocker:** one root user, one passkey, a 1-of-1 root
   quorum — Turnkey flags this in red itself. Losing that device loses the organisation. A
   second authenticator is recommended and costs nothing; it gates neither the ceremony nor
   a canary unless the owner decides otherwise.

   **The ceremony is COMPLETE as of 2026-08-28** — creation-only replacement, intermediate
   probe, both removals, final probe. No disposable credential was ever created: the owner
   authorised every step with the EXISTING root passkey, so the ceremony added no
   credential to destroy afterwards. The step that used to exist for one is gone.
   See `docs/TURNKEY-V1-REVOCATION-CEREMONY.md`.
3. ~~Backend hosting, for the listener to run 24/7~~ — **done, and has been for a while.**
   `ponsr-backend` runs on Fly in `iad`, machine `867634bee0e048`, `min_machines_running = 1`
   and `auto_stop_machines = false`, health check passing. This entry sat here as an open
   blocker while the thing it describes was already serving `/status` on the public internet.

   **The stale-deploy problem that stood here is CLOSED (2026-08-24).** See "Production, as
   actually deployed" below. Everything this entry used to say — that the image predated the
   migration, that `/status` advertised the pre-migration belief, that the deploy was still
   to be sequenced with the canary plan — is history now, and is kept only in
   `PONSR-DEPLOY-PAUSED-REPORT.txt`.

### Production, as actually deployed (2026-08-25)

`ponsr-backend` on Fly runs **commit `dd9fcbe`, release v35**, image
`sha256:bca351d294d589dddef8847dfc334409a57057d40c7ea3a76dbc79b09c56ae84`. One machine
(`867634bee0e048`, `iad`), volume `vol_r1j1nwjzdx6p7q3r` attached. Rollback target is the
exact previous digest, `sha256:2676be6325aea318abf7e4888320ebed9cf9f2c7a8c55b8c40a76f0bed1452a3`
(v34, source `e92b23b`) — name the digest, never "the previous release".

Live `/status` serves the typed `spend` envelope: `rolling-24h`, chain 4663,
`pons-v2-current-7ed`, factory `0x7eD598…EC7e`, treasury pinned to the hot wallet,
`publicLaunchEnabled: false`, `capWei` 0.01 ETH. Overall `degraded` is CORRECT —
`public-launches` is the only non-ok check and it must stay paused.

Five settings are now established deliberately rather than inherited:
`TURNKEY_POLICY_CONFIRMED=true`, `PUBLIC_LAUNCH_ENABLED=false`, `REPLY_INCLUDE_LINK=false`,
and the two ceilings `TREASURY_MAX_FEE_WEI` and `TREASURY_GAS_RESERVE_WEI`, both 0.002 ETH.
Fly secret VALUES cannot be read, so their old values are not merely unknown but unknowable;
what is recorded is what they ARE.

**`TREASURY_GAS_RESERVE_WEI` is ONE COMBINED budget for the complete two-transaction canary
run — splitter creation plus token launch — not a per-transaction allowance.** It was passed
to both operations independently, which authorised 0.002 ETH twice against a reserve chosen
once. Gas burned by a MINED REVERT counts against it too, and a mined receipt whose gas cannot
be read blocks rather than being accounted as zero. Maximum exposure for one canary execute:
launch fee 0.0005 ETH + combined gas at most 0.002 ETH = **0.0025 ETH**.

The final canary identity is **PONSR STONKS / PSTONKS / native ETH**, chosen by the owner. Its
salt is deterministic per identity, so changing the name or symbol changes the salt and
invalidates any earlier dry run.

**THE CANARY RAN, AND THE CURRENT-V2 LAUNCH PATH IS PROVEN ON MAINNET (2026-08-28).**
Verdict CANARY SUCCESS, fully reconciled, under a fresh one-launch authorisation that is now
**consumed** — anything further needs a new one.

```
token      PONSR STONKS / PSTONKS   0x7803f37e0Db73105c47D5A5F3D054a0ae47E2199
splitter   0xF78DC0166665Bc69d0e40fbf735BdA0D049f088a
pair       0x0000000000000000000000000000000000000000   native ETH
splitter   0x361125a10fbeefdba22bbb64e382b77bafe5c8b2cda417ced69ac461cd3ac3f1  status 1
launch     0xf392c31b4f30eb1b758acc8530e2ba0136b80dd5125f5d5187bbb35dc351b5ce  status 1
cost       0.000702 ETH = fee 0.0005 + gas 0.000202, against a 0.0025 ceiling
```

Balance delta reconciles exactly to fee + actual gas, nonce moved 4 → 6, the journal holds two
`confirmed` rows with the fee recorded once, and the public gate never moved off false. The
splitter's escrow immutable reads back the deployment's escrow and its shares are 9500/500.
See `PONSR-STONKS-CANARY-COMPLETION-REPORT.txt`.

**Three things this does NOT establish, and they matter more than the success line.**

- **The fee-collection path is untested.** No swap, trade or claim was authorised or made.
  95/5 is asserted by the splitter's constants and its escrow binding, not by any value having
  moved. Do not describe the revenue path as proven anywhere.
- **Admission is not atomic**, and the tool prints so itself: the bot ledger and the canary
  journal are separate stores, so a running bot could in principle admit a launch between the
  preflight read and the launch landing. `PUBLIC_LAUNCH_ENABLED=false` narrows that window but
  is a state, not an invariant. Nothing overlapped this time; that was measured, not guaranteed.
- **`/status` rolling-24h reads 0 after the canary, and that is correct.** The canary spends
  from the operator journal, deliberately outside the container. The bot's ledger is not the
  record of this launch and never was.

The two aborted attempts of 2026-08-25 are history now, kept in
`PONSR-CANARY-EXECUTE-ABORTED-REPORT.txt` and
`PONSR-CANARY-EXECUTE-ABORT-AND-LAUNCHPAD-FINDING.txt`. What survives from them is the lesson,
not the status: they stopped on a `/status` 503 that was misdiagnosed as the upstream RPC.

**ROOT CAUSE FOUND 2026-08-26, and it was NOT the upstream RPC.** That diagnosis — recorded in
the abort reports and repeated here — was wrong. The launch-readiness check made **four
sequential HTTP round trips** inside a single 5 000 ms deadline: `eth_getCode` for 24 177 bytes
of runtime bytecode, then `feeEscrow()` alone, then the batched permission reads, then
`getLaunchConfig` waiting on the count from the trip before it. That divides the budget into
~1 250 ms slices, so the check failed whenever ONE round trip cost over a second and passed only
when the network happened to be fast. Measured live in the same minute: **pre-fix 7 354 ms,
post-fix 1 561 ms, identical verdict**. The lesson is the same one §11 of the findings teaches —
`rpc: ok` sitting beside `launchpad: down` was read as a statement about pons, when nothing had
measured pons at all.

Fixed by `readinessProbe.ts` (one round trip, per-call timings marked `shared` because batching
destroys attribution), `identityWatch.ts` (the bytecode check on its own budget and cadence,
never weakened on the launch path), `rpcIdentity.ts` (publish WHICH endpoint answered without
publishing the URL — `RPC_URL` is an unreadable Fly secret, and that missing fact is why this
was misdiagnosed), and `rpcPool.ts` (a bounded fallback that admits an endpoint only if its
chain id and factory bytecode match the registry, wired to the read path only). Not yet
deployed. See `PONSR-READINESS-OBSERVABILITY-REPORT.txt`.

**An independent audit of PR #20 (2026-08-26) found nine defects in that work, and the
first one is the most important lesson in this file after §11 of the findings.**

`rpcPool`'s wrong-chain admission gate **did nothing at all**. It asked
`provider.getNetwork()`, but `new JsonRpcProvider(url, chainId, { staticNetwork: true })`
answers that from the CONFIGURED value and sends no request. Reproduced: a server answering
chain 46630, a pool expecting 4663, **zero methods reaching the transport**, endpoint
**ADMITTED**. The gate compared a constant to itself.

Every wrong-chain test passed, because they supplied a fake provider whose `getNetwork()`
returned whatever the test wanted. **A mock placed above the layer under test can only
report the author's expectations back** — and this repository had already written that
sentence down, in `readinessRoundTrips.test.ts`, before making the mistake in the file next
to it. The eight tests were deleted rather than repaired: adding a `send` stub would have
made them green again and rebuilt the same false comfort. They are replaced by
`rpcPoolTransport.test.ts`, which drives a real `JsonRpcProvider` against a real local
JSON-RPC server and asserts on the methods that server was **actually asked for**.

The other eight are recorded in `PONSR-PR20-AUDIT-CLOSURE-REPORT.txt`. Three are worth
carrying forward as general rules:

- **A revert is proven by revert DATA, not by an error code.** With ethers 6.17 every
  `eth_call` failure is `CALL_EXCEPTION`, and a revert carrying no data is indistinguishable
  from `-32000 server overloaded` down to the same `missing revert data` message. Code alone
  would classify an overloaded node as the contract saying no.
- **A missing input is not a permissive input.** An unreadable `launchFee` became `0n`,
  nothing in the verdict inspects the fee, and `/status` published `launchpad: ok` for a
  launch whose price nobody had managed to read.
- **`/status` reported the UTC calendar day while `validator.ts` admits against a rolling
  24h window.** At 00:01 UTC the page showed a full cap of headroom while every launch was
  being refused — and it told the operator refusals end "at midnight UTC", which is not when
  a rolling window frees up.

**A third review (2026-08-26) found three more, all at the STATUS BOUNDARY rather than in
any single unit, and the first one carries its own lesson.**

`buildStatus` was bounded and tested as bounded. The ROUTE was not: it called
`await rpcPool.acquire()` first, and acquisition admits candidates serially at the full
admission timeout. Measured: **8 020 ms of acquisition before the "one budget for the whole
response" even started**, 8 023 ms total against a claimed 5 000 ms. **The unit test passed
the entire time, because it called `buildStatus` directly.** A bound that holds for a
function says nothing about the composition that calls it, and nothing was testing the
composition. It is `statusSession.ts` now, and the tests drive it: 4 767 ms for the same
scenario, with a body still returned.

The other two: **an unknown rolling spend was falling back to the calendar day**, so a
missing authoritative figure plus a quiet calendar day published `daily-cap: ok` — the same
"missing input treated as permissive" defect as the launch fee, in a different file. And
**`rpc-endpoint` read the pool's mutable preferred endpoint at render time**, so a
concurrent request could leave one response carrying `observedThrough=A` in the envelope
while telling a human that B was serving.

**Production runs v36 (`dd5a72e`) since 2026-08-26**, and the readiness fix works there:
`/status` went from **HTTP 503 at 12.772 s** to **200 at 0.757 s**, with the readiness read
at **74 ms**. The public gate stays false and `public-launches` is the only intended
degraded check.

**What remained was a TAIL, and attributing it needed measurement rather than instinct.**
Sampled 25 times against v36, three responses took 3 s or more; on two of those the non-ok
check was `read-credits` — twitterapi.io, nothing to do with the chain — and on the third
the readiness read itself took 3 012 ms. An outside diagnostic timing each keyless
dependency directly could NOT attribute it, because from a laptop the chain reads take
2–4.7 s while production answers in 0.4 s. A vantage point that differs from production's by
an order of magnitude cannot attribute production's latency, and saying so is part of the
finding.

The fix is structural rather than a bet on which dependency is slow: `statusCore.ts` is a
stable contract (`ponsr.status-core` v1) for the facts a spend decision rests on, built
under its own deadline BEFORE optional telemetry starts, and `/status/core` serves it alone
without ever starting pair discovery or the credits call. Optional telemetry keeps its real
state on `/status` — never deleted, never reported green when it failed.

**A hostile review of the core contract (2026-08-26) found fourteen defects, and the
shape of them is worth carrying forward: a validator is only as good as the WORST input
it is handed, not the input you had in mind.** Reproduced before fixing: malformed public
JSON made the validator THROW instead of fail; an inflated `capWei` in the body PASSED,
because spend was compared against the cap the response itself supplied; a dead-address
treasury passed, because the pin was optional in the default command; `ok:true` beside
`problems:['chain-mismatch']` passed; a readable ZERO balance passed beside a live fee it
could not pay; `buildCoreEvidence` promised never to throw while a SYNCHRONOUS call inside
it did, and the route then published the raw `DB path /secret/path failed`; an unreadable
identity refresh still published HTTP 200 with `ok:true` when a cached pass existed; and
the "one total deadline" was topped up by two fresh 250 ms floors after it had expired.

A **sixth review (2026-08-26) found the never-throws claim was still false**, and the
shape is worth keeping: only the synchronous rolling-spend callback had been wrapped. The
other six dependencies are *invoked synchronously* when their promises are constructed, so
any implementation throwing before it returns one escaped `buildCoreEvidence` entirely and
the legacy `/status` catch published the raw message — one integration bug away from leaking
an internal path through a public endpoint. It also found the producer publishing
`ok: true` beside `canLaunchOnChain: false`, **relying on its own consumer to repair it**:
an authoritative endpoint has to be internally valid before anybody reads it, because a
second opinion is not a substitute for being right.

A **seventh review (2026-08-26) found two of my own claims false at the exact place I was
most confident**, and both are worth keeping. The report said "both route catches are
sanitised": only `/status` was, and the real `/status/core` catch still published
`detail: String(err.message)` — while the test meant to prove otherwise **built its own
express app and mirrored a sanitised copy**, so it passed against production source that
was still vulnerable. The handlers live in `statusRoutes.ts` now, `index.ts` mounts those,
and the tests import those. And a test asserting `JSON.stringify(error).not.toContain(...)`
proved **nothing at all** — `JSON.stringify(new Error('SECRET'))` is `{}`, because Error's
properties are not enumerable, so the assertion passed while the function was still
rejecting with the secret in `error.message`. A test with a broken oracle is worse than no
test: it reports the boundary as closed.

Three general rules came out of it. **A limit must never be evidence about itself** —
every quantity a verdict depends on is caller-pinned now. **A promise that never throws is
worth nothing if a plain function call beside it can.** And **`getNetwork()` under
`staticNetwork` is configured metadata, not an observation** — the core reads `eth_chainId`
off the wire, because admission's transport check is cached for minutes and a response can
otherwise look freshly chain-bound while nothing asked the endpoint anything.

**A fifth review (2026-08-26) found the fix's own optimisation defeating it.** The pool
coalesces concurrent admissions, and `admit()` handed a later caller the in-flight promise
as-is — so a `/status` request with a **300 ms budget took 983 ms**, waiting under a stalled
1 000 ms probe started by a caller with no deadline at all. Every existing test began from an
idle pool, so nothing touched the concurrency path. The lesson rhymes with the one above: a
bound is only as good as the compositions you actually exercise, and an optimisation that
shares work must not also share the waiting. Probe and wait are separate clocks now.

**The canary journal is NOT in the bot's database.** `/data/bot.sqlite` has no `canary_tx`
table; the journal is operator state outside the container, deliberately, so a deploy cannot
erase a record of transactions that are still on chain. Migrations to it — such as the
gas-evidence columns — happen on the operator's machine, not in production.

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
