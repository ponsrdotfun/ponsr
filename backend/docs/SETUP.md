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
- `TWITTERAPI_IO_KEY` (reading mentions and account signals)
- `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` (posting replies --
  X's own API, because posting is account activity and a suspended account cannot be
  re-minted; reads stay on twitterapi.io, which is 33x cheaper on the high-volume side)
- `PRIVY_APP_ID`, `PRIVY_APP_SECRET` (a wallet per X user)
- `TURNKEY_*` (the production treasury signer -- and `TURNKEY_POLICY_CONFIRMED`, which
  production refuses to start without)
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

The backend suite should pass. Its current count is printed by Jest rather than copied here.
It runs entirely against mocks -- no real API keys, no real chain, no real money, per the
design in `tests/orchestrator.test.ts`.

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

## 6b. Going on-chain for the first time, in order

pons is **not deployed on Robinhood Chain testnet** (verified 2026-08-04), so the launch path
cannot be rehearsed there. What can be rehearsed is the contract that matters most.

**Step 1 — create the wallet.** Writes the key to `.env` and prints only the address:

```bash
npx ts-node scripts/new-treasury-wallet.ts          # plan only
npx ts-node scripts/new-treasury-wallet.ts --write  # deliberately create and persist
```

This is a Phase B wallet, not the production treasury -- see item 5 above. Fund it small on
both chains: testnet from the faucet, and ~0.01 ETH on mainnet.

**Step 2 — validate FeeSplitter on testnet. Free, and do not skip it.**

```bash
npx ts-node scripts/validate-splitter.ts            # dry run
npx ts-node scripts/validate-splitter.ts --execute
```

Deploys the splitter and a mock ERC20, splits, and asserts 95/5 landed and **nothing was left
behind**. The 28 unit tests prove the logic; this proves the same bytecode on a real chain with
real gas, which has never been checked. The contract is immutable, so a defect found after
users' fees are routed to it cannot be fixed -- only abandoned.

**Step 3 — Phase B: one self-dealt mainnet launch.**

```bash
RPC_URL=https://rpc.mainnet.chain.robinhood.com CHAIN_ID=4663 npx ts-node scripts/phase-b-launch.ts
```

`creator == treasury == your own address`, so the only fees at stake are yours. Add
`--execute` once the dry run reads correctly. It preflights every guard the factory applies
before spending anything. The token it creates is real and permanent.

**Step 4 — prove the fee path.** Swap against the pool to generate fees, call
`locker.collectFees(token)` (the treasury is authorised as deployer), then `splitERC20` for
both the launched token and the pair token. Only after 95/5 lands is the model proven.

## 7. Build for production

```bash
npm run build
npm start
```

## 8. Before going anywhere near mainnet

Read `docs/SECURITY-BOUNDARIES.md` in full. The three integrations that used to be stubs --
Privy, Turnkey and the X client -- are implemented as of 2026-08-04, so what remains is
credentials and one verification:

```bash
npx ts-node scripts/check-providers.ts        # no Privy resource creation
npx ts-node scripts/check-providers.ts --create-privy-wallet # explicit Privy write check
npx ts-node scripts/turnkey-verify-policy.ts  # the treasury key is genuinely restricted
```

The second matters more than it looks. A Turnkey key with no effective policy behaves
identically to a correctly-scoped one until it is stolen, so this is measured rather than
assumed -- see `turnkey-policy-probe.ts` for how that was established the hard way.

Then follow the implementation roadmap's Phase 1 -> Phase 4 sequence in Part 11 of the master
doc.

One correction to that roadmap, from 2026-08-04: **"testnet first" is not available for the
launch path**, because pons is not deployed on Robinhood Chain testnet. Section 6b above is the
order that replaces it -- the free testnet rehearsal still covers `FeeSplitter`, which is the
part that holds users' money and cannot be changed after deployment.
