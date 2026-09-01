# Ponsr

**Launch a token from a tweet, on Robinhood Chain.**

[![verify](https://github.com/ponsrdotfun/ponsr/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/ponsrdotfun/ponsr/actions/workflows/verify.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[**ponsr.fun**](https://ponsr.fun) · [**@ponsrdotfun**](https://x.com/ponsrdotfun) · built on the [pons](https://ponsfamily.com) launchpad

---

Tag [@ponsrdotfun](https://x.com/ponsrdotfun) on X and describe the token you want. Ponsr
reads the request, pays the fee, deploys the token on Robinhood Chain, and replies with the
contract address and the transaction. Then it writes down what actually happened — the
factory, the curve, the block, the fee — on a page anyone can check.

```
@ponsrdotfun launch a token called Micro Duck, symbol MICRODUCK
```

No wallet to connect, no form, nothing to install. A wallet is created for that X identity
the first time it launches, and it is the same wallet every time after.

## The official Ponsr token

```
PONSR   0xadaafdea5c310be1bd50d48c07f9450914057eb6   Robinhood Chain · id 4663
```

**That address is the only one.** Published 2026-09-02, and the same address is printed on
[ponsr.fun](https://ponsr.fun). Anything else calling itself a Ponsr token is not one, whatever
it is named and wherever it appears.

Two things about it are worth stating plainly, because both are easy to assume wrongly:

- **It was deployed by the owner directly on pons, not through the Ponsr bot.** So its deployer
  is not the treasury, and it does **not** appear on the Explore board — that board means
  "launched through Ponsr", and widening it to include this would cost the board its meaning.
- **Appearing on Explore is not endorsement.** It never was, and it matters more now: the moment
  an official token exists is the moment somebody launches something adjacent and hopes a
  verified row reads as approval.

## The rule this project is built around

**If a number cannot be read from the chain, the site does not show it.**

No invented market caps, no 24-hour change on a token with no trades, no placeholder where
an unread value should be. When a source is stale or unreadable the page says *which*,
because an empty list and a broken reader look identical and only one of them is good news.

That rule is the reason for most of the engineering below, and most of the awkward
paragraphs in this file.

## What the creator keeps

| | |
|---|---|
| **66.5%** | of trading fees, to the creator — pushed to their own wallet by the fee splitter |
| **3.5%** | to Ponsr — for running the bot, the launch fee, and the gas |
| **nothing** | to launch — Ponsr pays the fee and the gas, including the gas to collect |

**95/5 is not 95/5 of the trading fees.** pons's locker takes 30% before the splitter sees
anything, so the split divides the remaining 70. Quoting the splitter's 95% as the creator's
share overstates it by about 1.4×. Only **66.5%** and **3.5%** belong in user-facing copy —
they are what the contracts actually transfer, and anyone can verify them on-chain.

Treat 30 as today's value rather than a constant: `MAX_PROTOCOL_FEE_SHARE` is 50, so pons
can cut the share to 2.5% without notice. Nothing about the fee is hardcoded here — the
launch fee, the graduation threshold and the creator share are all read live.

## What is proven, and what is not

Stated separately on purpose. "Deployed" and "demonstrated" are different claims.

**Proven on mainnet**

- The launch path, end to end, through the current pons v2 factory.
- The fee path. On 2026-09-01 a creator signed in with X, pressed collect, and both claims
  landed — each dividing as exactly `floor(total × 9500 / 10000)` to the creator with the
  remainder to the treasury, and nothing left behind. Before that date 95/5 was asserted by
  the splitter's constants; after it, it is a measured fact.
- Three launches exist: `PSTONKS`, `MICRODUCK`, `NOBI`. Two were made by the project's owner
  and one is its own test token, so **this is not community traction** — it is a record of
  what has been launched.

**Not proven**

- The locker's 30% cut upstream is not exercised by those claims, so 66.5%/3.5% remain
  arithmetic over an observed 95/5 rather than a directly measured pair.
- Automated tests run against mocks. They prove the logic; they cannot prove that a live
  third-party integration behaves the way its documentation says.

## Repository map

```
backend/          the bot: listener -> parser -> validator -> launch -> reply
  src/              TypeScript source
  tests/            unit + full-pipeline integration tests
  scripts/          operational tools -- every one dry-run by default
  docs/             SETUP.md and SECURITY-BOUNDARIES.md
contracts/        FeeSplitter.sol -- the 95/5 splitter
contracts-test/   contract tests, including two live reentrancy attacks
website/          the static site: landing, board, token pages, account
  assets/           ES modules shared by the build and the browser
scripts/          website build and launch-snapshot refresh
docs/             research and specification documents
```

## Quickstart

```bash
# contracts
npm install && node compile-all.js && npx hardhat test --no-compile

# backend
cd backend && npm install && npm test

# website
npm run build:website && node website/smoke-test.js
```

Every suite prints its own count. **No total is written in this file on purpose** — every
hardcoded figure here has been wrong within a week of being typed, and a stale number reads
exactly like evidence. The **verify** badge above is the replacement: it cannot go stale
because nobody types it.

The site uses real routes (`/explore`, `/token/SYMBOL`), so a plain static server will 404
on a direct hit. Use `netlify dev`, which reads `netlify.toml` the way production does.

Full setup, including how to get from "tests pass on mocks" to a backend running against
testnet, is in [`backend/docs/SETUP.md`](backend/docs/SETUP.md).

## Architecture notes worth reading

### An address is not an identity

Ponsr spent weeks reading a **superseded** pons factory. Everything it concluded about a
closed launchpad — that launching was switched off, that a whitelist was the blocker, that
the project was waiting on somebody else — was true of a contract nobody uses.

A factory that answers `launchEnabled()` looks exactly like the right factory.

`backend/src/deployments.ts` is the fix. It is a registry, not a config address: each entry
binds factory, ABI hash, runtime bytecode hash, fee escrow, selector and calldata schema
together, so a mismatch is a refusal rather than a silent wrong answer.

| deployment | factory | role |
|---|---|---|
| `pons-v1` | `0xA5aAb3F0…feB` | indexable only |
| `pons-v2-legacy-7e1` | `0x7E1EAbd5…dB8` | indexable only — superseded 2026-08-03 |
| **`pons-v2-current-7ed`** | **`0x7eD598Bc…C7e`** | **executable** |

Exactly one deployment may receive a launch; `executableDeployment()` throws if that is ever
untrue. The older two stay indexable forever, because they hold real launches that must
remain visible.

Three things differ between the two v2 deployments, each failing differently: the calldata
gains a `bytes32 salt`, moving the selector from `0xa41d5f2b` to `0xf35abbcf`; the approved
pairing set is larger and still grows, so it is read live rather than quoted; and the **fee
escrow is different**. The escrow is the dangerous one — immutable in each splitter, claims
pay `msg.sender`, no `claimFor` — so the wrong one strands a creator's fees permanently. It
is asserted before the splitter is deployed, and again before the calldata is built.

An environment variable used to select the factory, and defaulted to the superseded one. It
was removed on 2026-08-26; the registry decides now. Code cannot remove a permission that
lives in the signer, which is why the signer was cleaned up separately.

### The treasury is the on-chain deployer, not the X user

The user receives the creator share through a per-launch splitter instead. `launchTokenFor`
would change that but is callable only by pons's own forwarder. No reply or document may say
otherwise — "deployed by Ponsr, created by *them*" is the accurate phrasing.

Collecting needs no signature either. `claimAndSplit` is **permissionless and pays the
creator, never the caller**, so Ponsr can send the transaction and pay the gas without being
able to divert a single wei.

### The splitter handles ERC20, because that is what arrives

`FeeSplitter.sol` was rewritten after a real defect: fees arrive as **ERC20** — the launched
token plus WETH, never ETH — and the contract handled only native ETH. It could have
received them with no way to move them out. It now has `splitERC20`, a per-token claimable
ledger and a reentrancy guard.

The first mainnet launch deployed a **stale build** of that contract and its fees are
stranded forever. Every test had passed; they read a hand-maintained copy of the artifact
rather than the one the deploy path used. `compile-all.js` writes that artifact now, and
`phase-b-launch.ts` reads `splitERC20`'s selector back out of the deployed bytecode and
aborts if it is absent — the only check a stale build cannot fool.

### The signer's authority is proven by signing

The bot's key is scoped by Turnkey policy, and the policies are verified by **signing
probes** rather than by trusting a config flag. Three rules stand: the current factory as a
destination, zero-value contract creation for the splitter, and zero-value calls carrying
`claimAndSplit`'s selector.

`eth.tx.value == 0` appears twice there and is load-bearing both times. A creation's value
lands in the contract being created and the sender writes that contract, so an unbounded
creation could empty the hot wallet while every destination-only check still reported green.
A splitter's native `withdraw()` pays `msg.sender`, so ETH sitting in one can be taken by
whoever asks first. **Allowing an address is not the same as allowing it to be paid.**

One residual is accepted rather than fixed: initcode is not bound, so a zero-value deploy of
arbitrary code is still possible. That costs gas and never treasury.

### One description of a component, not two

The site once built every component twice — HTML strings for the static build, DOM nodes for
the browser — and 54 CSS classes were emitted by both. That produced four visible defects in
a single day, and **every one was invisible to tests that read the built HTML**, because in
each case the build script's copy was correct.

`website/assets/markup.mjs` describes a node; `toHtml` renders it for the build and `toDom`
for the browser. `website/assets/cards.mjs` describes each component once. A new component
belongs there, not in either producer.

`innerHTML` is not used, and the reason is not style: every value on these pages is
attacker-influenced token metadata, and a test forbids the sink.

## Deployment

| | |
|---|---|
| Website | Netlify, from this repository. Pushing to `main` publishes — there is no manual step. |
| Backend | Fly, one always-on machine in `iad`, health-checked. |
| Config | `netlify.toml` carries the rewrites, security headers and cache policy. `vercel.json` is a fallback — use one host or the other, never both. |

Status is public: [`/status/core`](https://ponsr-backend.fly.dev/status/core) is a stable
contract for the facts a spend decision rests on, built under its own deadline before any
optional telemetry starts. `/status` adds that telemetry and reports its real state — never
green when it failed.

## Security

Read [`backend/docs/SECURITY-BOUNDARIES.md`](backend/docs/SECURITY-BOUNDARIES.md) before
changing anything that touches a key or a transaction.

Two `.gitignore` entries are not cosmetic. **`backend/.env` is ignored** — it holds the key
that can spend the treasury. **`data/` and `*.sqlite` are ignored** — the bot's database maps
X user IDs to wallet addresses, which is personal data and operational state, not source.

The website holds no private key and never asks anyone to sign anything; a test fails the
build if a signing surface appears in it.

Found something? Open an issue, or reach the project at **ponsrdotfun@gmail.com**. Please do
not open a public issue for anything that could move funds.

## License

[MIT](LICENSE).

Ponsr is independent. It is **not operated by, affiliated with, or endorsed by** pons,
Robinhood, or X. Built on the [pons](https://ponsfamily.com) launchpad.

Nothing here is financial advice. Most permissionless tokens lose all of their value.
