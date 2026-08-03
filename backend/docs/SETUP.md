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

## 3. Pull the real pons factory ABI before trusting any launch

> **Read `docs/pons-v2-findings.md` first.** The placeholder in `src/ponsEncoder.ts` is not
> merely unverified — it is now known to be wrong in every parameter. The official docs publish
> v2's interface in full, and verification on 2026-07-30 confirmed v2's factory **is** deployed
> and its published ABI matches the deployed bytecode — but `launchEnabled()` reads `false` and
> no pair token is approved, so nothing can launch there yet. v1 is open but its launch
> signature is published nowhere. Decide which version you are targeting (open question #17) before
> spending time on the encoder, and consider emailing `contact@ponsfamily.com` — they offer
> integrator support and that is the shortest path to the signature.

The ABI in `src/ponsEncoder.ts` is a documented placeholder. Before Phase 1 testnet runs are
meaningful, pull the real one:

```bash
curl "https://api.blockscout.com/4663/api/v2/smart-contracts/0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB?apikey=$BLOCKSCOUT_API_KEY" | jq '.abi' > pons-factory-abi.json
```

Compare the real `launchToken` (or whatever it's actually named) signature against
`PONS_FACTORY_ABI_FRAGMENT` in `src/ponsEncoder.ts` and update it to match exactly --
parameter order, types, and the function name itself.

## 4. Run the test suite

```bash
npm test
```

All 54 backend tests should pass. This runs entirely against mocks -- no real API keys,
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
cd ../contracts-workspace  # or wherever contracts/ + contracts-test/ ended up relative to you
node compile-all.js
npx hardhat test --no-compile
```

All 13 contract tests should pass, including the reentrancy-attack and forward-failure
scenarios. See `contracts/README.md` for why `--no-compile` is required in sandboxed network
environments and how to compile normally (with Hardhat's own solc downloader) once you have
unrestricted network access.

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
