# Ponsr — Twitter launch bot for pons on Robinhood Chain

[![verify](https://github.com/ponsrdotfun/ponsr/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/ponsrdotfun/ponsr/actions/workflows/verify.yml)

> The project was originally called **Holdfast**; the brand is now **Ponsr**.

This is the full build: the fee-splitter smart contract, the backend bot service, and the
launch board website — implementing everything decided across the project's research phase
(see `docs/MASTER-twitter-launch-bot.md` for the full spec and reasoning behind every choice
below).

## What's in here

```
contracts/              FeeSplitter.sol -- the 95/5 fee-splitting contract (Part 8)
contracts-test/          Contract tests, including two live reentrancy attacks
backend/                 The bot service: listener -> parser -> validator -> launch -> reply
  src/                    Source code (TypeScript)
  tests/                  Unit + full pipeline integration tests (all mocked; run for current count)
  scripts/run-eval.ts      Runs the parser eval set against the real Claude API
  docs/                   SETUP.md and SECURITY-BOUNDARIES.md -- read these before deploying
website/                 Static site, one self-contained file, three routes:
                           /               landing page
                           /explore        the board -- card grid, search, sort, pagination
                           /token/SYMBOL   token detail + "what if I held" panel
docs/                    Every research/spec document from the planning phase, for reference
```

## Read this first: `docs/pons-v2-findings.md` §11, then §10, then §9

Read §11 before anything else in this repository.

Ponsr spent weeks reading a **superseded** pons factory. Everything §10 concluded about a
closed launchpad — that launching was switched off, that a whitelist was the blocker, that
the project was waiting on somebody else — was true of a contract nobody uses. The one pons
actually uses has been open since 2026-08-03 and has taken over 1,900 launches. Ponsr could
have launched the whole time.

The lesson that generalises, and the reason it is worth your time: **an address is not an
identity.** A factory that answers `launchEnabled()` looks exactly like the right factory.

### Three deployments, one of them executable

`backend/src/deployments.ts` is the registry. It exists because a bare config address let a
superseded factory and the current one look identical, and every guard read the wrong one
confidently for a week. Each entry binds factory, ABI hash, runtime bytecode hash, fee
escrow, selector and calldata schema together, so a mismatch is a refusal rather than a
silent wrong answer.

| deployment | factory | role |
|---|---|---|
| `pons-v1` | `0xA5aAb3F0…feB` | indexable only |
| `pons-v2-legacy-7e1` | `0x7E1EAbd5…dB8` | indexable only — superseded 2026-08-03 |
| **`pons-v2-current-7ed`** | **`0x7eD598Bc…C7e`** | **executable** |

Exactly one deployment may receive a launch; `executableDeployment()` throws if that is ever
untrue. The older two stay indexable forever because they hold real launches that must
remain visible.

- **`launchEnabled()` is `true` and `canLaunch(treasury)` is `true`.** Ponsr can launch today
  through the public gate and never needed a whitelist to develop or test. A whitelist is
  still worth having — it survives the gate closing — but it is not a blocker, and any
  document calling it one is sending you to wait on somebody else's reply.
- **Three things differ between the two v2 deployments, each failing differently.** The
  calldata gains a `bytes32 salt`, moving the selector from `0xa41d5f2b` to `0xf35abbcf`; the
  approved pairing set is 23 assets rather than 8, with RIVN already revoked; and the **fee
  escrow is different**. The escrow is the dangerous one — it is immutable in each splitter,
  claims pay `msg.sender`, and there is no `claimFor` — so the wrong one strands a creator's
  fees permanently. It is asserted before the splitter is deployed and again before the
  calldata is built.
- **The treasury is the on-chain deployer, not the X user.** The user receives the creator
  share through the per-launch splitter instead. `launchTokenFor` would change that but is
  callable only by pons's own forwarder. No reply or document may say otherwise.
- **`FeeSplitter.sol` was broken, and is fixed.** Fees arrive as **ERC20** — the launched
  token plus WETH, never ETH — and the contract handled only native ETH. It could have
  received them with no way to move them out. Rewritten with `splitERC20`, a per-token
  claimable ledger and a reentrancy guard.
- **Nothing about the fee is hardcoded.** Read `launchFee()` live; the function is
  `launchFee()`, not `creationFee()`, which does not exist and would revert every read. The
  launch fee, the graduation threshold and the creator share are all owner-settable on pons's
  side, and the split has already changed once between factories.
- **No IPFS is needed** — token logo and description travel as calldata strings.

The whole path is proven end to end: exact production calldata passes against the live
factory by `eth_call`, a forked rehearsal launches paired with AAPL and claims the fee back
out, and two self-dealt mainnet launches split real trading fees 95/5 with nothing stranded.

**95/5 is not 95/5 of the trading fees.** pons's locker takes 30% before our splitter sees
anything, so the split divides the remaining 70: the creator's real take is **66.5%** and the
treasury's is **3.5%**. Those two figures are the only ones that may appear in user-facing
copy, because they are what the contracts actually transfer and anyone can check on-chain. A
revenue model built on 5% is overstated by about 1.4×. Treat 30 as today's value rather than
a constant — `MAX_PROTOCOL_FEE_SHARE` is 50, so pons can cut the share to 2.5% without
notice.

The ABI pull looked blocked on an API key for weeks because every note pointed at
`api.blockscout.com` (the Pro aggregator, which needs one). Each chain also runs its own
Blockscout with an open API:

```bash
curl "https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"
```

### The security finding that was open is now closed

The Turnkey policy allowed the bot key to sign a **contract creation with no constraint on
value** — needed for the splitter, but a creation's value lands in the contract being created
and the sender writes that contract. One transaction could empty the hot wallet while every
destination-only check still reported green.

**Closed 2026-08-22.** Policy `b647cc07-…` now binds `eth.tx.value == 0` on the creation
clause and the broad `897d432e-…` was removed. A signed probe measured the funded creation
`denied` where it had been `ALLOWED` the day before, with the zero-value splitter deploy
still `ALLOWED`. Nothing was broadcast.

**One residual is accepted, not fixed:** initcode is not bound, so any *zero-value* contract
can still be deployed. That costs gas, never treasury — a zero-value creation has nothing to
carry away. Do not read it as initcode being restricted.

Closing this did not deploy anything: the running backend still predates the migration,
`PONS_FACTORY_VERSION` is unflipped, and no canary has been run. Details in
`docs/TURNKEY-CREATION-AUTHORITY.md`.

## Then: `BUILD-STATUS.md`

Before anything else, read `BUILD-STATUS.md`. It states plainly what's real, working, and
tested versus what's a clearly-marked stub waiting on your own account credentials
(Turnkey, Privy, twitterapi.io). This isn't hedging — it's the difference
between "ready to run" and "ready to wire up," and conflating the two with money on the line
is exactly the kind of mistake the project's own Part 5 audit exists to prevent.

## Quickstart

```bash
# Smart contract
cd contracts-test && node ../compile-all.js && npx hardhat test --no-compile

# Backend
cd backend && npm install && npm test

# Website
open website/index.html   # or drag it into any static host -- no build step needed
```

Full setup instructions, including how to get from "tests pass on mocks" to "actually running
on testnet with real (test) funds," are in `backend/docs/SETUP.md`.

## Test results

Counts are deliberately not written here. Every hardcoded figure in this repository has
been wrong within a week of being typed -- README said 151 backend tests while the suite
had grown past 500 -- and a stale number looks exactly like evidence.

The **verify** badge at the top of this file is the replacement: it reports the result of
the last run of `.github/workflows/verify.yml` on `main`, which cannot go stale because
nobody types it. That workflow runs on every push and pull request and is the only claim
about this repository that a reader has not had to take on trust -- a clean root and
backend `npm ci`, the backend typecheck, build and full suite, the contract tests, the
website smoke tests, artifact reproducibility twice, `git diff --check`, and a
production-only backend audit.

Its first two runs each caught a defect that every local run had missed: a Node pin below
22.12 that broke jsdom, and a backup test whose concurrency assertion was a race against
the scheduler rather than a property. That is the argument for the badge in one line --
passing on one machine is not the same as passing.

Run any suite yourself; each prints its own count:

- **Contract:** `npm test` at the root (`contracts-test/`)
- **Website:** `node website/smoke-test.js`
- **Backend:** `cd backend && npm test` (`backend/tests/`)
No total is given here on purpose. Every hardcoded figure in this repository has been
wrong within a week -- this line said 232 while the three suites together had passed 670 --
and a stale number reads exactly like evidence. Run them; they print their own counts.

All three suites were executed to produce those numbers — none of it is a claim taken on
faith. Re-run any of them with the commands above (`backend/` needs `npm install` first,
since `node_modules` is not checked in).

## The website is live: https://ponsr.fun

Deployed 2026-08-04 on **Netlify**, from this repository. Pushing to `main` publishes
automatically — there is no manual deploy step.

| | |
|---|---|
| Production | `https://ponsr.fun` (`www` and plain `http` both 301 to it) |
| Netlify project | `ponsr` · `ponsr.netlify.app` |
| Publish directory | `website/` — no build command, the site is static |
| Certificate | Let's Encrypt, covering the apex and `www` |

`netlify.toml` at the repo root carries everything host-specific: the rewrites for
`/explore` and `/token/:symbol`, the security headers, and the cache policy (immutable
for hashed art, `must-revalidate` for HTML so a deploy is visible immediately).

`vercel.json` is the equivalent for Vercel and is kept only as a fallback. Use one host
or the other, never both.

**`PRETTY_URLS` is now `true`** in `website/index.html`, so the app writes `/explore` and
`/token/SYMBOL` rather than query strings. That is only safe because `netlify.toml`'s
rewrites ship from the same commit — turning it on without them makes the first refresh
on `/explore` a 404. The router still *reads* both forms, so old query-string links keep
working.

One consequence worth knowing locally: `python -m http.server` does not apply rewrites,
so a direct hit on `/explore` 404s there. Use `netlify dev`, which reads `netlify.toml`
the way production does.

## Before the first push to GitHub

`.gitignore` is already set up, and the entries that matter most are not cosmetic:

- **`backend/.env` is ignored.** Per `backend/docs/SETUP.md` it will hold
  `ANTHROPIC_API_KEY`, `TWITTERAPI_IO_KEY` and `TREASURY_SIGNER_PRIVATE_KEY`. Committing
  it publishes a key that can spend the treasury. `.env.example` is the file that belongs
  in the repo.
- **`data/` and `*.sqlite` are ignored.** The bot's database maps X user IDs to wallet
  addresses — personal data and operational state, not source.

If the repository is public, also check that no `.env` was ever committed in an earlier
commit: `git log --all --full-history -- "**/.env"` should return nothing. Git history
keeps deleted files, so removing the file later does not un-publish a leaked key.

## What this is not

This is not a substitute for the testnet validation phase (Phase 1-3) laid out in
Part 11 of `docs/MASTER-twitter-launch-bot.md`. Automated tests against mocks prove the *logic* is correct;
they cannot prove a live third-party integration (Turnkey, Privy, the real pons contract)
behaves the way its documentation says it will. That gap is exactly what testnet is for, and
skipping it is not a shortcut this build enables or recommends.
