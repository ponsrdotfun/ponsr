# Ponsr — Writer's Brief

**Source of truth for anyone or anything writing public copy about Ponsr.**
Written 1 September 2026 against the live contracts, the deployed backend, and
ponsr.fun as it stands today.

Ponsr's entire promise is that it only publishes what can be read from the
chain. Copy written about it has to hold the same line.

---

## 1. What Ponsr is

**Ponsr launches a token from a tweet.** Someone tags `@ponsrdotfun` on X and
describes the token they want. Ponsr reads the request, pays the fee, deploys
the token on Robinhood Chain, and replies with the contract address and the
transaction. Then it writes down what actually happened — the factory, the
curve, the block, the fee — on a public page anyone can check.

The second half is what makes it Ponsr rather than any launcher. **If a number
cannot be read from the chain, the site does not show it.** No invented market
caps, no 24-hour change on a token with no trades, no "coming soon" for things
that are not coming. When a source is stale or unreadable the page says which,
because an empty list and a broken reader look identical and only one of them
is good news.

Ponsr is a neutral tool. Appearing on its board is not an endorsement, a
valuation, or a safety rating.

---

## 2. How someone uses it

1. **Write the tweet.** Name the token and its symbol in plain words. Ponsr asks
   rather than guesses when either is missing — it will not invent a name for a
   permanent on-chain record.
2. **Ponsr replies.** With the contract address and the transaction hash, or
   with the exact reason it could not. Never with silence, never with a vague
   failure.
3. **The trading fees are yours.** Sign in at ponsr.fun with the same X account
   and press collect. Ponsr sends the transaction and pays the gas.

Example request:

```
@ponsrdotfun launch a token called Micro Duck, symbol MICRODUCK
```

There is no wallet to connect, no form, and nothing to install. A wallet is
created for the X identity the first time it launches — the same wallet every
time after that, never a second one.

**Not every request is accepted, and that is deliberate.** An account must be at
least 30 days old and have at least 5 followers, and one account may launch at
most 3 times a day. These are anti-abuse limits: Ponsr pays for every launch, so
it has to be expensive to waste.

---

## 3. What it costs, and what the creator keeps

| | |
|---|---|
| **66.5%** | of trading fees, to the creator — pushed to their own wallet by the fee splitter. Ponsr cannot redirect it. |
| **3.5%** | to Ponsr — what the treasury keeps for running the bot and covering the launch fee and gas. |
| **Nothing** | to launch — Ponsr pays the launch fee and the gas, including the gas to collect. |

**Always name where the rest goes.** The launchpad's own locker takes 30% of
trading fees before Ponsr's splitter sees any of it. 66.5% and 3.5% are what is
left, divided 95/5.

- Quoting 66.5% without mentioning the locker is an honest-looking number with
  thirty percent missing.
- Quoting the splitter's **95%** as the creator's share overstates it by roughly
  1.4×.

Every share is set by contracts on chain, not by Ponsr, and every one of them
can change. Write them as what they are today, never as a guarantee.

---

## 4. Who holds what

- **The website holds no private key** and never asks anyone to sign anything. A
  test fails the build if a signing surface appears in it.
- **Each X identity gets one embedded wallet**, created on first launch and
  resolved on every sign-in after. Never a replacement, never a second one.
- **Ponsr's treasury is the on-chain deployer.** The person requesting the launch
  does not sign the transaction. Say "deployed by Ponsr, created by *them*" —
  both are true and the difference matters.
- **Collecting fees needs no signature.** The split function is permissionless
  and pays the creator whoever calls it, so Ponsr can send it on their behalf and
  cannot divert a single wei by doing so.

---

## 5. The chain facts

Copy these exactly. Do not retype from memory.

| | |
|---|---|
| Chain | Robinhood Chain · id 4663 |
| Launchpad | pons, Protocol V2 (lowercase "pons", always) |
| Factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Launch fee | 0.0005 ETH — paid by Ponsr, not the creator |
| Mechanism | Bonding curve, then graduation at a per-token threshold |
| Pairing assets | Native ETH, or one of 27 approved tokens |
| Explorer | robinhoodchain.blockscout.com |

Approved pairing assets, as of today: AAPL, AMD, AMZN, BB, cbBTC, COIN, COST,
CRCL, DJT, GLD, GME, GOOGL, HIMS, META, MSFT, MSTR, MU, NVDA, PLTR, QQQ, RDDT,
SNDK, SPCX, SPY, TSLA, TTWO, USDG.

**A token is _about_ a theme or it is _paired with_ an asset, and these are
completely different things.** "An Apple meme coin" is a theme. "Paired with
AAPL" is a permanent financial decision about what every buyer spends. Never let
the first imply the second.

---

## 6. True as of today

This section dates faster than the rest. Check it before publishing anything
that quotes a number.

| | |
|---|---|
| Public launches | **Open** — requests are being read and answered |
| Launches on record | 3 — PSTONKS, MICRODUCK, NOBI |
| Official Ponsr token | **None.** Not published |
| Fee collection | Proven on mainnet 1 Sept 2026 — 66.5/3.5 paid out exactly |

Two of the three launches were made by Ponsr's owner and one is Ponsr's own test
token, so **do not describe the board as community traction.** It is a record of
what has been launched, and honest writing says how many and by whom if it says
anything at all.

The fee path was proven the day this brief was written: a creator signed in,
pressed collect, and the split paid out to exactly `floor(95%)` of the escrow
with nothing left behind. Before that date it was arithmetic; after it, it is a
measured fact. Both statements were correct on their day — which is why this
section exists.

---

## 7. NEVER CLAIM THESE

Every line here has cost somebody something.

### ✗ "Ponsr, by pons" · "Official pons launcher" · "Partnered with Robinhood"

Ponsr is independent and is **not operated by, affiliated with, or endorsed by**
pons, Robinhood, or X. "Ponsr" is one letter from "pons", so this is the easiest
mistake to make and the most damaging.

### ✗ "Pons" with a capital P

Their attribution terms ask for lowercase plus a link back to ponsfamily.com.
Keep both, every time.

### ✗ "Earn 95% of fees" · "Keep 95%"

95/5 is how the splitter divides what reaches it, *after* the locker's 30%. The
creator's actual share is 66.5%. **Only 66.5% and 3.5% may appear in copy.**

### ✗ "Guaranteed" · "passive income" · "returns" · "will moon"

Launch records are observations, not recommendations, projections, or
valuations. Most permissionless tokens lose all their value. Ponsr does not give
financial advice and neither does its copy.

### ✗ "The official Ponsr token is live"

No official Ponsr token has been published. Anything claiming to be one is not.

### ✗ "Fees delivered" when they are only accrued

Accrued, claimable, and paid are three different states. A balance sitting in
escrow has not moved to anyone.

### ✗ Any market cap, price, or 24-hour change Ponsr has not read

The site deliberately hides figures it cannot read rather than showing a zero.
Copy that fills the gap undoes the one thing the product is for.

---

## 8. Words and spelling

- **Ponsr** — capital P, no full stop. Never "PonsR".
- **pons** — always lowercase, always with a link to ponsfamily.com nearby.
- **@ponsrdotfun** — the only handle. Not @ponsr, not @ponsrfun.
- **Robinhood Chain** — both words capitalised. It is the chain, not the
  company's endorsement.
- **Creator, not owner.** The creator is whose wallet the splitter pays. Ponsr's
  treasury is the deployer.
- Write plainly. The product's voice is specific and unhurried, and it never
  oversells — that restraint *is* the marketing.

---

## 9. Phrasing you can lift

Checked against the contracts. Safe to use as written.

**One-line pitch**
> Tag @ponsrdotfun on X, name your token, and it launches on Robinhood Chain.
> Ponsr pays the fee.

**The economics, complete**
> You keep 66.5% of trading fees. Ponsr keeps 3.5%. The launchpad's locker takes
> 30% before either of us sees it.

**What makes it different**
> Ponsr writes down what actually happened — the factory, the curve, the block,
> the fee. If a number cannot be read from the chain, the site does not show it.

**Custody, in one sentence**
> Collecting needs no signature. The split pays your wallet whoever sends it, so
> Ponsr sends it and pays the gas.

**Attach to anything public-facing**
> Ponsr is independent. It is not operated by, affiliated with, or endorsed by
> pons, Robinhood, or X.

**The disclaimer, minimum viable**
> Inclusion is not endorsement, official status, price, or safety. Most
> permissionless tokens lose all value.

---

Full legal wording lives at ponsr.fun/terms.
