# Ponsr — Twitter launch bot for pons on Robinhood Chain

> The project was originally called **Holdfast**; the brand is now **Ponsr**.

This is the full build: the fee-splitter smart contract, the backend bot service, and the
launch board website — implementing everything decided across the project's research phase
(see `docs/MASTER-twitter-launch-bot.md` for the full spec and reasoning behind every choice
below).

## What's in here

```
contracts/              FeeSplitter.sol -- the 95/5 fee-splitting contract (Part 8)
contracts-test/          28 passing tests, including two live reentrancy attacks
backend/                 The bot service: listener -> parser -> validator -> launch -> reply
  src/                    Source code (TypeScript)
  tests/                  151 passing tests (unit + full pipeline integration, all mocked)
  scripts/run-eval.ts      Runs the 28-case parser eval set against the real Claude API
  docs/                   SETUP.md and SECURITY-BOUNDARIES.md -- read these before deploying
website/                 Static site, one self-contained file, three routes:
                           /               landing page
                           /explore        the board -- card grid, search, sort, pagination
                           /token/SYMBOL   token detail + "what if I held" panel
docs/                    Every research/spec document from the planning phase, for reference
```

## Read this first: `docs/pons-v2-findings.md` §9, then `BUILD-STATUS.md`

The verified source of both live pons v1 contracts was read on 2026-08-04, which settled every
on-chain question this project had been carrying. The short version:

- **Target v1.** `launchEnabled()` is `true` and no whitelisting is needed — that guard only
  applies when launching is globally off. v2's factory is deployed but closed and unaudited.
- **The real launch interface is checked in** at `backend/src/abi/`. The placeholder it
  replaced was wrong in every parameter, and the code was calling `creationFee()`, which does
  not exist on the deployed contract — the real name is `launchFee()`.
- **`FeeSplitter.sol` was broken, and is fixed.** Fees are pushed, not escrowed, and a contract
  may be the recipient — but they arrive as **ERC20**, and the contract handled only native
  ETH. It would have received them with no way to move them out.
- **No IPFS is needed** — token logo and description travel as calldata strings.

The ABI pull looked blocked on an API key for weeks because every note pointed at
`api.blockscout.com` (the Pro aggregator, which needs one). Each chain also runs its own
Blockscout with an open API:

```bash
curl "https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB"
```

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
on testnet with real (test) funds," are in `backend/docs/SETUP.md` and
`docs/action-checklist.md`.

## Test results

Counts are deliberately not written here. Every hardcoded figure in this repository has
been wrong within a week of being typed -- README said 151 backend tests while the suite
had grown past 500 -- and a stale number looks exactly like evidence.

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
