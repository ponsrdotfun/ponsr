# Ponsr — Twitter Launch Bot for Pons on Robinhood Chain

> The project was originally called **Holdfast**; the brand is now **Ponsr**.

This is the full build: the fee-splitter smart contract, the backend bot service, and the
launch board website — implementing everything decided across the project's research phase
(see `docs/MASTER-twitter-launch-bot.md` for the full spec and reasoning behind every choice
below).

## What's in here

```
contracts/              FeeSplitter.sol -- the 95/5 fee-splitting contract (Part 8)
contracts-test/          13 passing tests, including a live reentrancy attack simulation
backend/                 The bot service: listener -> parser -> validator -> launch -> reply
  src/                    Source code (TypeScript)
  tests/                  108 passing tests (unit + full pipeline integration, all mocked)
  scripts/run-eval.ts      Runs the 28-case parser eval set against the real Claude API
  docs/                   SETUP.md and SECURITY-BOUNDARIES.md -- read these before deploying
website/                 Static site, one self-contained file, three routes:
                           /               landing page
                           ?view=explore   the board -- card grid, search, sort, pagination
                           ?token=SYMBOL   token detail + "what if I held" panel
docs/                    Every research/spec document from the planning phase, for reference
```

## Read this first: `docs/pons-v2-findings.md`, then `BUILD-STATUS.md`

The official pons documentation was located on 2026-07-30 and it changed several things this
repo was built on. The short version:

- **pons v2 is deployed but closed.** Verified on-chain: the launch factory exists
  (`0x7E1EAbd…84dB8`), but `launchEnabled()` is `false` and no pair token is approved, so no
  one can launch on v2 yet. Still unaudited. Its published ABI *is* confirmed to match the
  deployed bytecode.
- **v1 is live and every constant we assumed for it is correct** (chain 4663, factory
  `0xA5aAb…1feB`, 0.0005 ETH launch fee, 4.2 ETH graduation, 70% creator share). But its launch
  signature is published nowhere, so the ABI pull is still the blocker.
- **`FeeSplitter.sol` may not work as a fee recipient on either version** — v2 requires the
  recipient to actively claim from an escrow, and the contract can only receive passively. This
  must be settled before it is deployed anywhere.
- **No IPFS is needed** — token logo and description travel as calldata strings.

## Then: `BUILD-STATUS.md`

Before anything else, read `BUILD-STATUS.md`. It states plainly what's real, working, and
tested versus what's a clearly-marked stub waiting on your own account credentials
(Turnkey, Privy, twitterapi.io, the real Pons ABI). This isn't hedging — it's the difference
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
on testnet with real (test) funds," are in `backend/docs/SETUP.md` and
`docs/action-checklist.md`.

## Test results

- **Contract:** 13/13 passing (`contracts-test/`) — **run**
- **Website:** 45/45 passing (`website/smoke-test.js`) — **run**
- **Backend:** 108/108 passing (`backend/tests/`) — **run**
- **Total: 166 automated checks, all run and passing.**

All three suites were executed to produce those numbers — none of it is a claim taken on
faith. Re-run any of them with the commands above (`backend/` needs `npm install` first,
since `node_modules` is not checked in).

## Deploying the website

The site is static — `website/` is published as-is, no build step. `vercel.json` and
`netlify.toml` are both in the repo root; use whichever host you pick, not both.

Both configs rewrite `/explore` and `/token/:symbol` to `index.html`, which is what turns the
routes into `ponsr.fun/explore` and `ponsr.fun/token/GCAT`. The app already *reads* a route
from either the path or the query string, so those URLs resolve immediately. To also have it
*write* the pretty form, set:

```js
const PRETTY_URLS = true;   // website/index.html
```

Do that in the same commit that deploys the rewrites — turning it on without them means
the first refresh on `/explore` is a 404. Left `false`, everything works on any static
host with `?view=explore` / `?token=SYMBOL` URLs.

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
they cannot prove a live third-party integration (Turnkey, Privy, the real Pons contract)
behaves the way its documentation says it will. That gap is exactly what testnet is for, and
skipping it is not a shortcut this build enables or recommends.
