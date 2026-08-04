# Setup Guide

## 1. Install dependencies

```bash
cd backend
npm install
```

## 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env` per `action-checklist.md` in the project root. At minimum, to run the test
suite you need nothing filled in (tests use mocks throughout). To run the server for real
against testnet, you need:
- `ANTHROPIC_API_KEY` (Claude Haiku 4.5 access)
- `TWITTERAPI_IO_KEY` (mention listening + reply posting)
- `TREASURY_SIGNER_PRIVATE_KEY` (a **testnet-only** key, funded with testnet ETH from the
  Robinhood Chain faucet -- never a key holding real funds; see `docs/SECURITY-BOUNDARIES.md`
  item 5). This is the **hot** wallet: the bot spends from it and only from it.
- `TREASURY_COLD_ADDRESS` -- optional on testnet (you get a startup warning), **required before
  mainnet**, where a missing or hot-equal cold address is a startup error. It is an address
  only; no cold key belongs in this project. See `docs/SECURITY-BOUNDARIES.md` item 5b.

On startup the server prints a treasury setup report and begins a balance watch every 15
minutes. If you see `[treasury/error]`, the hot/cold split is not actually protecting anything
-- fix it before funding the wallet, not after. A `TOP_UP_REQUIRED` alert means the hot wallet
is running out; it carries the amount and both addresses, and bridging takes ~10 minutes, so it
is not an alert to sit on.

## 3. The pons factory ABI is already pulled and verified

**Resolved 2026-08-04.** The verified ABIs for both live v1 contracts are checked in at
`src/abi/ponsLaunchFactory.json` and `src/abi/ponsLaunchLocker.json`, and `ponsEncoder.ts`
encodes against them. There is nothing to do here before Phase 1.

They came from the chain's own Blockscout instance, whose API needs **no key**:

```bash
curl "https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB"
```

Earlier notes sent everyone to `api.blockscout.com/4663/...` — the Pro aggregator, which does
need a key — so this read as blocked on an account signup for weeks. If you ever need to
re-pull (say pons deploys a new factory), use the URL above, not the aggregator.

To re-check that the deployed contract still matches what is checked in, the probe script
reads the factory's live state — fee, `launchEnabled`, and the launch configs:

```bash
node ../scripts/probe-pons-v1.js    # the live factory the bot targets
node ../scripts/probe-pons-v2.js    # v2, for when it eventually opens
```

Run the v1 probe before any testnet session. If `launchEnabled()` has gone `false`, or the
launch config's `pairToken` or `graduationThreshold` has moved, the bot's assumptions have
changed underneath it — `validator.ts` will refuse launches rather than burn gas, but you
want to know why.


## 4. Run the test suite

```bash
npm test
```

All 122 backend tests should pass. This runs entirely against mocks -- no real API keys,
no real chain, no real money, per the design in `tests/orchestrator.test.ts`.

## 5. Run the parser eval set against the real model (requires ANTHROPIC_API_KEY)

```bash
ANTHROPIC_API_KEY=sk-ant-... npx ts-node scripts/run-eval.ts
```

This hits the real Claude Haiku 4.5 API with all 28 cases from `parser-eval-set.json` and
reports pass/fail per the scoring rules in `parser-eval-guide.md`. Real but tiny cost (well
under $0.01 total, per Part 9's cost simulation). Run this before trusting the parser in
Phase 1, and again any time the system prompt in `src/parser.ts` changes.

## 6. Compile the contract and run its test suite

```bash
cd ..                 # repo root
node compile-all.js
cd contracts-test && npx hardhat test --no-compile
```

All 28 contract tests should pass, covering both fee paths (ERC20 and ETH), two reentrancy
attacks, a blacklisted recipient, and the tokens that break naive splitters -- ones returning
no data, and ones reporting failure by returning `false`. See `contracts-test/README.md` for
why `--no-compile` is used here and how to compile normally with Hardhat's own solc
downloader once you have unrestricted network access.

## 7. Build for production

```bash
npm run build
npm start
```

## 8. Before going anywhere near mainnet

Read `docs/SECURITY-BOUNDARIES.md` in full, and complete every item still marked TODO in:
- `src/walletResolver.ts` (real Privy integration)
- `src/treasurySigner.ts` (real Turnkey integration)
- `src/xClient.ts` (real twitterapi.io integration)

Then follow the implementation roadmap's Phase 1 -> Phase 4 sequence in the master project
doc -- testnet first, always.
