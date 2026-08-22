# pons — findings from the official docs, then from the chain itself

**Source:** `docs.ponsfamily.com/v2` (single page, hash anchors), read 2026-07-30.
**Why this document exists:** the master spec's pons facts were assembled from indirect
research in July 2026, before these docs were found. Several of them are now known to be
wrong for v2, and one of them breaks a contract we already wrote. Everything below is
from the official docs, not inference — where the docs are silent, that is said explicitly.

> ## ⛳ START HERE: §9 supersedes large parts of this document (2026-08-04)
>
> On 2026-08-04 the **verified source of both live v1 contracts was read directly**. That
> settles, with certainty, the three questions this document lists as blocking — the v1
> launch signature, whether a contract can hold the fee role, and whether the treasury needs
> whitelisting. It also proves `FeeSplitter.sol` was broken in a way nobody had suspected.
>
> **The reason it went unanswered for weeks is worth recording, because it was our own
> mistake, not a gap in pons's documentation.** Every checklist item pointed at
> `api.blockscout.com/4663/...`, the Blockscout **Pro aggregator**, which requires an API
> key — so the ABI pull sat behind an account signup nobody had done. But each chain also
> runs its **own** Blockscout instance with an open API, and Robinhood Chain's is
> `robinhoodchain.blockscout.com`. Both contracts are verified there with full source, and
> no key is needed:
>
> ```bash
> curl "https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB"
> ```
>
> Sections 1–8 are kept intact. They are what was believed before, and the gap between them
> and §9 is the point.

---

## 1. Status: v2 is not launchable yet

> "Only the meme hook and fee escrow are deployed. No launch factory, no curves, no live v2 pools."

| Contract | Address | Status |
|---|---|---|
| Meme hook | `0x8e99D2009D60A917e9B1c00C04C077b8c0c3a044` | deployed (block 23011979) |
| Fee escrow | `0xbc39B6502E1a6Ab36E4A5c5026A35F08342A0A9c` | deployed (block 23011563) |
| Launch factory | — | **not deployed** |
| Bonding curves | — | **not deployed** |
| Launch token impl | — | **not deployed** |
| Buyback vault | — | **not deployed** |
| Launch locker | — | **not deployed** |

> "No audit has closed. Treat v2 as unaudited until the reports are published here."

**Consequence:** there is no v2 factory address to point the bot at, and nothing to test
against. v1 continues to operate and is what any near-term launch would use.

---

## 2. The launch interface is nothing like our placeholder

```solidity
struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }

struct TokenParams {
  string  name;
  string  symbol;
  string  logo;
  string  description;
  Socials socials;
  address creatorFeeRecipient;
  uint16  creatorTaxBps;
  bool    buybackEnabled;
  bytes32 expectedEconomics;
}

function launchToken(TokenParams params, uint256 launchConfigId, address pairToken)
  payable returns (address token, address curve);
```

Against `backend/src/ponsEncoder.ts`'s placeholder:

| Placeholder assumed | Reality (v2) |
|---|---|
| Six flat params | One struct + two scalars |
| `string metadataURI` | `logo` + `description` + `Socials` struct, **as calldata strings** |
| `address feeWallet` | `creatorFeeRecipient` inside the struct |
| `uint256 devBuyAmount` | **does not exist** |
| returns `(token, pool)` | returns `(token, curve)` |
| — | `launchConfigId` (required) |
| — | `pairToken` (required; zero address = native ETH) |
| — | `expectedEconomics` (required anti-race pin) |

### Knock-on effects on our own rules

- **`devBuyAmount` is not a v2 parameter.** `docs/SECURITY-BOUNDARIES.md` item 4 and the
  encoder's hardcoded `0n` guard a field that does not exist in this interface. The rule
  isn't wrong so much as aimed at the wrong place; it needs rewriting against the real ABI.
- **Metadata does not need IPFS.** Open question #10 ("does Pons need an off-chain
  metadata upload?") is answered: logo and description are passed as calldata strings and
  read back via `getTokenInfo()`. **No Pinata account is required**, so that item can come
  off the action checklist.
- **`expectedEconomics` is mandatory, not optional hardening.** Call
  `previewLaunchEconomics(launchConfigId, pairToken)` immediately before launching and pass
  the result. "If the owner changes the config in between, the launch reverts." This is a
  stronger version of our own max-fee guard, enforced by the protocol.
- **Launch may be gated.** `launchEnabled()` and `whitelistedLaunchers(address)` both exist.
  Whether the bot's treasury address needs whitelisting is unknown and worth asking.

---

## 3. ⚠️ The fee model breaks `FeeSplitter.sol`

This is the most serious finding.

**How v2 pays creators:**
- The creator sets `creatorTaxBps` at launch. It is capped by `maxCreatorTaxBps()` and is
  immutable afterwards.
- Trading fees are **credited to the fee escrow, not pushed to recipients**.
- The recipient withdraws on their own schedule: `claim()` for native, `claimToken(address)`
  for ERC-20 quote assets. Balances are readable via `balanceOf(recipient)`.

**Why that breaks our contract:** `contracts/FeeSplitter.sol` has exactly two ways to
receive value — `receive()` and `withdraw()` — and **no ability to call another contract**.
If the splitter is set as `creatorFeeRecipient`, its fees accrue inside the escrow and
*nobody can ever pull them out*, because the escrow pays the recipient and the recipient is
a contract with no code to claim. The money is stranded permanently.

This is precisely the failure Part 8 §3 warned about: *"a bug here doesn't just cost the
bot money, it can strand or misroute funds that belong to users."*

The docs do not state whether a contract may be a recipient at all:

> "Integrators should verify actual contract code before assuming contract wallets can auto-claim."

**What the splitter would need, at minimum:** a function that calls `escrow.claim()` (and
`claimToken`) on itself before splitting, plus a way to call
`transferCreatorFeeRecipient(token, newRecipient)` — which is *callable only by the current
recipient*, so a splitter without it can never hand the role on. None of this can be
finalised until the escrow's real ABI is readable on-chain.

**Correction (2026-07-30, after reading the v1 docs):** an earlier version of this document
said the v1 design was safe because "anyone can call `collectFees(token)`". **That is not
established.** The v1 docs say only:

> "Creator rewards accrue in the token's locked position. When they are available, the
> creator can claim them at any time."

No function name, no ABI, no statement about who may call it. The `collectFees(token)` claim
came from our own earlier research, not from Pons. So it is currently **unknown** whether a
contract can hold the v1 fee role and pull its own rewards. The splitter may be broken on v1
for the same reason it is broken on v2 — this has to be settled by reading the deployed
locker's ABI before the splitter is trusted on either version.

---

## 4. Community takeovers can redirect our fee share

CTOs "redirect the creator's fees" to a new recipient. The protocol can propose a change
with a 3-day delay (`CreatorFeeRecipientChangeProposed` → `CreatorFeeRecipientUpdated`), and:

> "a creator moving their fees elsewhere during the wait does not call off the proposal."

Our fee model assumes the recipient set at launch is permanent. It isn't. A CTO can move
the whole creator-fee stream — including the 5% the bot's treasury depends on — away from
the splitter. This was never considered in Part 8's economics.

---

## 5. Event and read surface (for the tx monitor and the indexer)

Our monitor currently expects `TokenLaunched(token, pool, creator, name, symbol)`. Actual:

```solidity
event TokenLaunched(
  address indexed token, address indexed curve, address indexed deployer,
  address pairToken, uint256 launchConfigId, uint256 graduationThreshold
);
```

Other events worth indexing: `CurveBuy` / `CurveSell` (carry `fee` and `tax` separately —
useful for the what-if simulator), `CurveCompleted`, `PoolGraduated`, `FeesSwept`,
`Credited` / `Claimed` on the escrow, and `CreatorFeeRecipientUpdated`.

Useful reads: `launchFee()`, `maxCreatorTaxBps()`, `getLaunchFeePolicy(token)`
(`protocolFeeShareBps`, `buybackBurnBps`, `hookFeeBps`), `graduationThreshold()`,
`readyToGraduate()`, `graduated()`, `getLaunchedToken(token)`, `getTokenInfo()`.

**Neither the launch fee nor the graduation threshold has a published number** — both are
config-dependent and must be read on-chain. The master spec's "~0.0005 ETH launch fee" and
"~4.2 ETH graduation" are v1-era figures and should not be treated as v2 constants.

---

## 6. Integrator warnings that apply directly to this bot

Straight from the docs:

1. **Route by phase, not by inference.** "Do not infer [launch phase] from balances or
   events" — read the authoritative phase before routing a trade to the curve or the pool.
2. **Final buys get partially refunded.** Read `tokensOut` from the event; never assume the
   requested amount was filled.
3. **Graduation can stall.** An `AutoGraduationFailed` event means the launch needs a manual
   `createGraduatedPool(token)` push — worth monitoring for tokens the bot launched.
4. **Custom pairs inherit the quote asset's risk.**
5. **Some fee sweeps silently skip** (`PoolConversionSkipped`, `PoolBuybackSkipped`), and
   sweeps needing an internal swap are restricted to a trusted operator. Don't assume all
   accrued fees convert.

---

## 6b. v1 — what is actually live (read 2026-07-30, `docs.ponsfamily.com/docs`)

**Every constant the master spec assumed for v1 checks out against the official docs.**

| Fact | Master spec said | v1 docs say | |
|---|---|---|---|
| Chain ID | 4663 | 4663 | ✅ |
| Active factory | `0xA5aAb…1feB` | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` (from block 8991118) | ✅ |
| Active locker | `0x736D…7F35` | `0x736D76699C26D0d966744cAe304C000d471f7F35` | ✅ |
| Legacy factory (do not use) | `0x0c37…77a4` | `0x0c37a24F5D23A486FA692d1500881d698B1F77a4` | ✅ |
| Launch fee | ~0.0005 ETH | "a small 0.0005 ETH launch fee" | ✅ |
| Graduation | ~4.2 ETH | "The default threshold is 4.2 ETH" | ✅ |
| Creator fee share | 70% of trading fees | Creator 70% · protocol 30% (active factory) | ✅ |

Also confirmed: WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, V3 factory
`0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`, position manager
`0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`, swap router
`0xCaf681a66D020601342297493863E78C959E5cb2`, quoter V2
`0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`.

### Still not published: the launch signature

The v1 docs contain **no create/launch function signature and no launch code sample** — the
integration section only covers *reading* launches. So the single most important blocker is
unchanged: the ABI still has to come from the verified contract on Blockscout
(`action-checklist.md` item 1). Neither doc set closes it.

### New v1 facts we did not have

- **The real `TokenLaunched` event** (topic0 `0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a`):
  ```solidity
  event TokenLaunched(
    address indexed token, address indexed deployer, address indexed dexFactory,
    address pairToken, address pool, uint256 dexId, uint256 launchConfigId,
    uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount
  );
  ```
  `ponsEncoder.ts`'s `extractLaunchedTokenAddress` decodes a different shape entirely (it
  expects `name`/`symbol` strings) and would not match this. Note the token address is still
  the first indexed field, so the extractor's *intent* survives — only the ABI is wrong.
- **`initialBuyAmount` exists in v1.** This is the dev-buy that `devBuyAmount` was guarding.
  Correcting §2 above: the parameter is absent in **v2**, but v1 has it under this name — so
  the security rule is still meaningful, it just needs the right field name.
- **`feeRedirects(token)` exists in v1 too**, returning the payout address
  (`redirect === zeroAddress ? deployer : redirect`). So the fee recipient is redirectable on
  **both** versions; Part 8's assumption that the launch-time recipient is permanent is wrong
  everywhere, not just under v2's CTO mechanism. Who may set it is not documented.
- **`restrictionsEndBlock`** — launches carry some restriction window. The docs don't say what
  is restricted. Worth understanding before promising users anything about immediate trading.
- **The fee split has already changed once**: legacy factory paid creators 90%, the active one
  pays 70%. It is a per-factory constant, so it can change again on a future deployment —
  the bot should read it, not hardcode 70%.
- `logo()` and `description()` are plain `view returns (string)` on the token, matching v2's
  calldata-string approach. This is the second independent confirmation that **no IPFS step
  is needed**.

---

## 7. What this changes in the project's plan

| Item | Before | After reading the docs |
|---|---|---|
| Metadata / IPFS (open question #10) | open — assumed a URI, Pinata on the checklist | **resolved: calldata strings, no IPFS needed** |
| `devBuyAmount = 0` rule | a core security boundary | aimed at a parameter v2 doesn't have — restate against the real ABI |
| Max-fee guard | our own invention | v2 has a protocol-level equivalent (`expectedEconomics`) that is **required** |
| FeeSplitter | written and covered by the contract suite | **incompatible with v2's pull-based escrow — needs a claim path before it can be used** |
| Fee permanence | recipient fixed at launch | recipient is transferable, and a CTO can redirect it |
| Launch fee ≈ 0.0005 ETH | treated as a planning constant | v1-era; v2 publishes no number, read `launchFee()` |
| Target version | unstated (implicitly v1) | **decision needed: build for v1 now, or wait for the v2 factory** |

**The one thing that has not changed:** the ABI still has to be pulled from a deployed,
verified contract before any of it is trusted. For v2 that is not yet possible — the factory
does not exist. For v1 it is still the Blockscout call in `docs/action-checklist.md` item 1.

---

## 6c. Terms and attribution — this one has already changed the website

The v1 docs carry brand rules for integrators, and we were breaking two of them.

> - "Write the name in lowercase and link back to the app"
> - "Do not present third-party services as operated by pons"
> - "Do not use the pons name or marks in a way that misleads users"
> - Cannot claim partnership or endorsement without a written agreement
> - "pons is provided as is, without warranties, and the team is not liable for losses
>   arising from integrations, interfaces, RPCs, or indexers"
> - "Onchain data is public and free to read. You are responsible for how you use it."

**Notably, there is no prohibition on bots or derivative products** — only on misleading use
of the name. That is a useful data point next to Part 6's Robinhood Chain "automated tools"
clause: pons itself does not object to something like this existing.

**What was fixed in `website/index.html` on reading this:**
- "Pons factory" → "pons factory" (their stated lowercase rule) in all four places.
- Added the missing link back to `ponsfamily.com` — the rule asks for one and we had none.
- Added an explicit non-affiliation line to the footer:
  *"Ponsr is an independent third-party tool — it is not operated by, affiliated with, or
  endorsed by pons."*

That last one matters more for this project than for a normal integrator: **"Ponsr" is
literally "pons" plus a letter.** Their test is whether the name is used in a way that
*misleads*, so the disclaimer is doing real work, not box-ticking. Worth repeating it in the
X bio and pinned post.

## 6d. Custom errors — the failure modes the bot must handle (v2)

Directly useful for `replyComposer.ts`, which currently only knows "transaction reverted".

| Error | Meaning |
|---|---|
| `LaunchFeeNotPaid` | value sent ≠ `launchFee()` |
| `LaunchEconomicsMismatch` | the pinned terms moved — re-read `previewLaunchEconomics` and retry |
| `NotWhitelisted` | **launching is restricted to approved addresses** |
| `CreatorTaxTooHigh` | tax above `maxCreatorTaxBps()` |
| `PairTokenNotApproved` | quote asset not approved for launches |
| `PairTokenDecimalsMismatch` | quote asset's decimals differ from what was recorded |
| `NativeValueMismatch` | native launch: value sent ≠ `quoteIn` |
| `UnexpectedNativeValue` | value sent on a custom-pair launch |
| `CurveGraduated` | finished on the curve — route to the pool |
| `SlippageExceeded` | could not meet minimum output |
| `TimelockNotElapsed` / `TimelockExpired` | fee-recipient change executed too early / too late |

`NotWhitelisted` confirms the concern in §2: **launching can be permissioned**, so the
treasury address may need approval before it can launch anything.

**Safety:** graduated liquidity is locked permanently — "no unlock button, no privileged
wallet". If a launch stalls in between for seven days, pons can return what was collected.

**Audit status:** three reviews in flight (SB Security, Dingbats, Pashov Audit Group), none
closed.

## 6e. Two things worth using

- **Integrator contact: `contact@ponsfamily.com`** — the docs offer "hands-on support for
  teams integrating pons". This is a far more direct route to the unpublished launch
  signature, the "can a contract hold the fee role" question, and whitelisting than guessing
  from Blockscout. Worth adding to the action checklist alongside the Robinhood email.
- **Reference token: `0x39dBED3a2bd333467115dE45665cC57F813C4571`** — published specifically
  "for validating integrations against known onchain state". Ideal fixture for testing the
  indexer and the what-if maths against real data instead of mocks.

---

## 7b. ⚠️ SUPERSEDED — verified on-chain 2026-07-30, v2 IS deployed

Everything below in §8 was written from the docs' prose, which still carries the stale line
*"Only the meme hook and fee escrow are deployed. No launch factory, no curves, no live v2
pools."* **That sentence is out of date.** The docs' own contract table now lists more
addresses than the prose admits, so the contradiction was settled by asking the chain
directly (`eth_getCode` against `rpc.mainnet.chain.robinhood.com`, chain 4663):

| Contract | Address | Bytecode |
|---|---|---|
| **Launch factory (v2)** | `0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8` | **22,757 bytes ✅** |
| Launch locker (v2) | `0x28b6F0116c7F234951cf0e67319ed53863Df2197` | 1,969 bytes ✅ |
| Migration factory | `0x050e5C224466e2d377a7E555E139D51268239b39` | 13,021 bytes ✅ |
| Meme hook | `0x8e99D2009D60A917e9B1c00C04C077b8c0c3a044` | 15,167 bytes ✅ |
| Fee escrow | `0xbc39B6502E1a6Ab36E4A5c5026A35F08342A0A9c` | 1,932 bytes ✅ |

### But the launchpad is not open

Reading the deployed factory's own state:

| Call | Value | Meaning |
|---|---|---|
| `launchFee()` | `500000000000000` | **0.0005 ETH — identical to v1** |
| `maxCreatorTaxBps()` | `1000` | creator tax capped at **10%** |
| `launchConfigCount()` | `1` | one config exists |
| **`launchEnabled()`** | **`false`** | **launching is switched OFF** |
| `approvedPairTokens(0x0)` | `false` | native ETH not approved |
| `approvedPairTokens(WETH)` | `false` | WETH not approved |

So v2 is **deployed but closed**: the contracts are live, and nobody — including pons's own
front end — can launch through them until `launchEnabled()` flips and at least one pair token
is approved. "Is v2 live?" has two different answers depending on which question is meant,
and both matter to us.

### The published interface is confirmed correct

Those four reads were made using the function signatures **from the docs**, against the
deployed bytecode, and every one returned a sensible value. That means the v2 ABI the docs
publish matches what is actually deployed — a meaningful de-risking of §2. It does not prove
the `launchToken` signature specifically (it is not a view function and cannot be probed
without spending), but the surrounding interface checking out makes it far more trustworthy
than a guess.

### The bot must read these before launching

`launchEnabled()` and `approvedPairTokens(pairToken)` are not optional pre-flight niceties:
with launching disabled, a launch attempt reverts and the treasury still pays gas. The
validator should read both live before building any transaction, exactly as it already reads
`launchFee()`.

### Custom pairs — launching against a tokenised stock

This is a real, documented v2 feature, quoted from the docs:

> "Say a launch is paired against a tokenised stock. Buyers spend that stock token to buy in
> and receive it back when they sell, the target the launch has to hit before it graduates is
> counted in it, the Uniswap pool it graduates into is paired against it, and the creator is
> paid in it."

Key constraints:

- **The pairing asset is chosen at launch and fixed forever.** "You cannot switch a launch to
  a different asset later, and your fees will arrive in whatever you chose." For Ponsr that
  means the treasury's 5% would arrive in the stock token, not ETH — which changes the
  treasury model, since launch fees are paid in ETH.
- **Only pons can approve a pairing asset**, and approval is closed by default: "There is no
  way for anyone else to add one." Right now **nothing is approved**, not even ETH.
- **The pairing asset's risk stacks on top of the launch's own**, and the graduation target is
  denominated in it — "If the asset doubles in value, the real cost of graduating that launch
  doubles too."

**Product angle worth noting:** launching a token paired against a tokenised stock is a
genuinely distinctive thing to offer from a tweet, and it is native to the chain Ponsr already
targets. Part 2's competitor research found hoodr differentiating on stock *rewards*; this
would be stock *pairing*, which is a different and arguably stronger hook. It is not
actionable until pons approves pair assets, but it is worth designing the encoder so
`pairToken` is a first-class parameter rather than something hardcoded to zero.

---

## 8. Superseded answer (kept for the record): is v2 live?

> The section below reflects the docs as read earlier the same day, before the on-chain check
> in §7b. It is wrong about deployment. It is kept because the *reasoning* — prefer what can
> be tested — still applies, and because it shows why the chain was checked rather than the
> prose trusted.

**No — v2 cannot launch a token today.**

| | v1 | v2 |
|---|---|---|
| Factory deployed | ✅ `0xA5aAb…1feB` | ❌ not deployed |
| Curves / pools | ✅ live (Uniswap v3) | ❌ none |
| Audited | not stated | ❌ "No audit has closed" |
| Launch signature published | ❌ | ✅ (but nothing to call it on) |
| Can launch a token now | ✅ | ❌ |

Deployed on v2 so far: the meme hook and the fee escrow only — 2 of the 7 contracts the
architecture needs.

**The awkward part:** the version whose interface we *know* is the one that doesn't exist,
and the version that *works* is the one whose launch signature is still unpublished. Neither
doc set removes the need to pull the real ABI from Blockscout.

**Practical reading:** build for v1, because that is what can actually be tested end to end
on testnet, and treat the v2 interface as a known migration target rather than something to
write code against now. Structure the encoder so the factory interface is swappable — the
project already injects every external dependency behind an interface, so this fits the
existing convention rather than fighting it.

---

# 9. ✅ RESOLVED — the verified v1 source, read 2026-08-04

Both live v1 contracts are verified on `robinhoodchain.blockscout.com`, with full source.
The ABIs are checked in at `backend/src/abi/ponsLaunchFactory.json` and
`ponsLaunchLocker.json`. Everything below is quoted from the deployed source, not inferred.

| Contract | Address | Verified |
|---|---|---|
| `PonsLaunchFactory` | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | ✅ 58 ABI entries |
| `PonsLaunchLocker` | `0x736D76699C26D0d966744cAe304C000d471f7F35` | ✅ 49 ABI entries |

## 9.1 The launch signature — published nowhere, but on-chain all along

```solidity
launchToken(
  TokenParams {
    string name; string symbol; string logo; string description;
    Socials { twitter; telegram; discord; website; farcaster };
    address feeWallet;
  } params,
  uint256 launchConfigId,
  uint256 dexId,
  bytes32 salt
) payable returns (address token)
```

Against the placeholder we had been carrying, every parameter was wrong. Three differences
change behaviour rather than just naming:

- **No dev-buy parameter exists.** The encoder used to hardcode `devBuyAmount = 0`. The real
  factory derives an initial buy from `msg.value` *above* `launchFee`, so **sending exactly
  the fee** is now the whole control. Overpaying by any amount makes the treasury buy into a
  user's token.
- **One `feeWallet`, no separate creator wallet.** The old encoder passed both. There is only
  one address field in the entire call, which is a stronger guarantee for the
  prompt-injection case than the test previously asserted.
- **A CREATE2 `salt`.** We derive it from the source tweet, so a retry predicts the same token
  address and reverts on `PoolAlreadyExists` instead of silently deploying a second token for
  one request.

`chainClient` was also calling **`creationFee()`**, a name invented for the placeholder. The
real function is **`launchFee()`**. No such function as `creationFee` exists, so every fee
read — which gates every launch — would have reverted.

## 9.2 Whitelisting is not required

```solidity
if (!launchEnabled && !whitelistedLaunchers[msg.sender]) revert NotWhitelisted();
```

The whitelist is a bypass for when launching is globally off, not an allowlist to join.
`launchEnabled()` reads **`true`**, so the treasury can launch today. `NotWhitelisted` is
real, but it only fires when pons has closed the door to everyone.

## 9.3 Live factory state (read 2026-08-04)

| Read | Value |
|---|---|
| `launchEnabled()` | **`true`** — v1 is open, unlike v2 |
| `launchFee()` | 0.0005 ETH |
| `launchConfigCount()` | 1 |
| config `0` | enabled, pair `0x0Bd7…AD73` (WETH), graduation **4.2 ETH**, supply 1e27, maxWallet 5%, maxTx 5.5% |

Every documented constant checks out. They remain settings, not constants: `setLaunchFee`,
`setLaunchEnabled` and `updateLaunchConfig` are all owner-callable, which is why
`getLaunchReadiness()` re-reads them before every launch (open question #23).

## 9.4 ⚠️ The fee model — resolved, and `FeeSplitter.sol` was broken

The factory transfers the launch's Uniswap v3 position to the locker and records the fee
wallet:

```solidity
manager.safeTransferFrom(address(this), locker, positionId);
IPonsLaunchLocker(locker).lockPosition(token);
if (params.feeWallet != address(0)) {
    IPonsLaunchLocker(locker).setFeeRedirect(token, params.feeWallet);
}
```

Fees are then collected from the position by `PonsLaunchLocker.collectFees(address token)`:

```solidity
address recipient = feeRedirects[token];
if (recipient == address(0)) recipient = launched.deployer;
if (msg.sender != owner() && msg.sender != launched.deployer
    && msg.sender != recipient && !feeCollectors[msg.sender]) revert NotAuthorized();
...
_transferIfPositive(token0, recipient, recipientAmount0);
_transferIfPositive(token1, recipient, recipientAmount1);
```

**Answering the three questions this document had left open:**

1. **Can a contract hold the fee role?** Yes. `feeRedirects[token]` is a plain address and
   payouts are ERC20 transfers, which any contract can receive.
2. **Push or pull?** **Push.** v2's escrow model does not apply to v1. Nothing needs claiming
   from an escrow.
3. **Who may trigger collection?** The owner, the **deployer** (our treasury), the recipient
   itself, or a whitelisted collector. The treasury is always authorised — it is `msg.sender`
   at launch.

**But the sting is in the last two lines.** Fees arrive as **`token0` and `token1` ERC20
transfers** — the launched token and the pair token. Native ETH is never involved.

`FeeSplitter.sol` split **ETH only**, through `receive()`. It would have accepted those ERC20
transfers happily — any address can hold ERC20 — and had **no function capable of moving them
out again**. Every creator's fees would have accrued in it permanently.

So the instinct to block deployment was right, and the reason was nearly right: the contract
was indeed unusable, just not for the escrow reason assumed. Rewritten 2026-08-04 with
`splitERC20`, a per-token claimable ledger, and a reentrancy guard — the guard added because
a test proved a hostile token could re-enter `splitERC20` and skew the split to 99.75/0.25.

## 9.5 Open questions this closes

| # | Was | Now |
|---|---|---|
| #17 | Which version to target | **v1.** Open, verified, fee model understood. v2 is deployed but `launchEnabled` is false and no pair token is approved |
| #18 | Does the fee model break the splitter? | **Yes, and it is fixed.** Not the escrow problem that was feared — an ERC20-vs-ETH problem |
| #22 | `pairToken` as a first-class parameter | Not a launch parameter in v1. It lives in the launch config, so the bot selects it by `launchConfigId` |
| #23 | Read launch guards live | **Implemented** — `getLaunchReadiness()`, enforced in `validator.ts` |

## 9.6 Still genuinely open

- **The 5% treasury share arrives as tokens, not ETH.** The treasury spends ETH on fees and is
  paid in the launched token plus WETH. Converting, holding, or ignoring that is a product
  decision nobody has made.
- **`protocolFeeShare`** on the locker takes a cut before the recipient's split. It read as
  applying per token (`tokenProtocolFeeShares`); the effective number for our launches has not
  been measured, so "creator keeps 95%" is 95% *of what reaches the splitter*.
- **v2 migration.** `MigrationFactory` is deployed. What migrating costs a token and its fee
  wiring is unexamined.
- The email to `contact@ponsfamily.com` no longer blocks anything, but a reply is still worth
  having on the protocol fee share.

---

## 9.7 ⚠️ pons is NOT deployed on Robinhood Chain testnet (verified 2026-08-04)

The roadmap's Phase 1 says "prove the loop on testnet first". For anything involving pons,
**that is not possible**, and nobody had checked before building the plan around it.

```
POST https://rpc.testnet.chain.robinhood.com  eth_chainId  -> 0xb626 (46630)  ✅ chain is alive
POST …                                        eth_getCode(0xA5aAb…1feB) -> 0x  ❌ no contract
```

The testnet chain runs. The pons factory is simply not on it.

**What this changes:**

- **`FeeSplitter.sol` can still be fully validated on testnet**, because it does not depend on
  pons at all: deploy it, deploy a mock ERC20, transfer some in, call `splitERC20`, confirm
  95/5. That covers the only contract that will ever hold user money, at zero cost.
- **The launch path cannot.** `launchToken` only exists on mainnet.

**The resulting plan (agreed 2026-08-04) — Phase B:** one controlled mainnet launch with
`creator == treasury == the operator's own address`, so the only fees at stake belong to the
operator. `backend/scripts/phase-b-launch.ts` performs it: dry run by default, `--execute` to
send, and it preflights every guard the factory applies (`launchEnabled`, whitelist, launch
config, dex config, live fee against the ceiling, balance against fee + gas reserve) before
spending anything.

Two properties of that shape matter:

- `FeeSplitter` is **immutable**. If it is wrong, a self-dealt launch is the run where that
  costs nothing belonging to a user, and the next launch can use a corrected deployment.
- The token is **real and permanent**, on a public launchpad, under this brand. That is the
  actual price of this step, and it is not refundable.

---

## 9.8 ✅ FeeSplitter validated on a real chain (2026-08-04)

The rehearsal from §9.7 was run on Robinhood Chain testnet. This is the first time this
contract's bytecode has executed anywhere except a Hardhat network.

| | |
|---|---|
| Chain | Robinhood Chain testnet (46630) |
| FeeSplitter | `0x3599f4eA6776787E8557b97cA3C66D67690C83E1` |
| Mock ERC20 | `0x7F0565A2E8faB4912D4dfA272964b6E5c77854AF` |
| Split tx | `0x5c26c5b3f52a185782771732223010b7cb261b6af30f361e701e3bb26b74b31b` |

Result on 1000 MOCK:

```
creator got        950.0 MOCK   (95%)
treasury got        50.0 MOCK   (5%)
left in splitter     0.0 MOCK   <- nothing stranded
immutables         match
```

**Gas, which is the number Phase B needs to budget against:**

- `splitERC20`: **118,955 gas**
- Whole run (3 deployments + 1 split): **0.0000149 ETH** at a 0.01 gwei base fee

Gas on this chain is cheap enough that it does not meaningfully change the Phase B budget --
the 0.0005 ETH launch fee dominates by two orders of magnitude. The `TREASURY_GAS_RESERVE_WEI`
default of 0.002 ETH is therefore very conservative, which is the right direction for a
reserve, but worth knowing when reading a `TREASURY_EXHAUSTED` rejection: the wallet is being
held back by a deliberately cautious floor, not by real gas costs.

**What this does and does not prove.** It proves the deployed bytecode splits correctly with
real gas metering, and that nothing is left behind — the failure that would strand user fees in
an immutable contract. It does not exercise the queued-claim path or a hostile token; those are
covered by the 28 unit tests, and reproducing them on-chain would require deploying the
adversarial helpers, which proves nothing the tests do not.

**FeeSplitter is cleared for Phase B.**

---

## 9.9 ✅ PHASE B EXECUTED — first real launch on mainnet (2026-08-04)

`scripts/phase-b-launch.ts --execute`, self-dealt: `creator == treasury == the operator`.

| | |
|---|---|
| Token | `0xc615D10B97cBC2802162BF7C1b8dFc28163A299D` (`PONSRHOOD`) |
| Pool | `0xb5aBBf856Bc24FA6df2D82EF7FCE821ee4E5F790` |
| FeeSplitter | `0x3599f4eA6776787E8557b97cA3C66D67690C83E1` |
| Launch tx | `0x26cb2bad3a0a58ebe62fe2269eef4e709b7e270a94faddc79ad235ac8b48d27e` |
| Position | 586429 |
| `initialBuyAmount` | **0** — the treasury did not buy into its own launch |

**The encoder is proven.** Everything in §9.1 was read from source and believed; this is the
first time the calldata was accepted by the real factory. It worked on the first attempt.

**Fee wiring confirmed on the locker:**

```
feeRedirects[0xc615…299D] = 0x3599f4eA…83E1   ← the splitter, exactly as intended
deployer                  = the treasury      ← so collectFees() is always callable by us
```

### ⚠️ 9.9.1 `protocolFeeShare` measured: **30%** — and it changes what we may claim

The open item from §9.6 now has a number. `PonsLaunchLocker.protocolFeeShare()` and
`tokenProtocolFeeShares(token)` both read **30**, applied *before* the recipient's share:

```
trading fees ──30%──> pons protocol fee recipient
             └─70%──> FeeSplitter ──95%──> creator    = 66.5% of trading fees
                                   └──5%──> treasury  =  3.5% of trading fees
```

This is consistent with the "70% creator share" the v1 docs advertise — pons keeps 30%, and
our 95/5 divides the 70% that arrives. Nothing is wrong; what was wrong was some of our copy.

**"Creators keep 95% of creator fees" is true. "Creators keep 95% of trading fees" is not** —
it overstates a creator's take by about 1.4×, and it is precisely the kind of number a
prospective user can verify on-chain in a minute.

Corrected on discovery:
- `website/index.html` FAQ already said "creator trading fees", which was accurate but easy to
  misread. It now states the 30% explicitly, and that Ponsr neither sets it nor receives it.
- `brand/X-PROFILE.md` bio options B and C claimed "95% of fees" and "95% of trading fees".
  Both rewritten. The live X bio never carried the claim, so nothing published was wrong.

**The treasury's real take is 3.5% of trading fees, not 5%.** Any revenue modelling built on
5% is overstated by the same 1.4×.

### 9.9.2 Still unproven

The fee *path* is wired but has never carried value: no swaps have happened, so
`collectFees` has nothing to collect and `splitERC20` has nothing to split. Until a real
trade generates fees and both are run, the end-to-end model is verified by reading, not by
observation.

---

## 9.10 🔴 INCIDENT — Phase B deployed the wrong FeeSplitter, and the fees are stranded

`collectFees` worked. `splitERC20` reverted with no data, which is what a call to a function
that does not exist looks like. It did not exist: the contract deployed at
`0x3599f4eA6776787E8557b97cA3C66D67690C83E1` is the **pre-rewrite, ETH-only FeeSplitter**.

```
splitERC20(address)              -- absent
withdrawERC20(address,address)   -- absent
claimableERC20(address,address)  -- absent
withdraw()                       -- present   <- the old interface
```

**Stranded permanently, in an immutable contract with no admin:**

| | |
|---|---|
| `PONSRHOOD` | 269,280.16 |
| `WETH` | 0.000445466 |

### Cause

Nothing was wrong with any contract. There were **two copies of one compiled artifact**:

- `contracts-test/artifacts.json` — written by `compile-all.js`
- `backend/src/feeSplitterArtifact.json` — a **hand-made copy**, and the only thing
  `splitterDeployer.ts` reads

FeeSplitter was rewritten for ERC20 and recompiled. The first was refreshed. The second was
not, because nothing refreshed it. Then:

- all 28 contract tests passed — they read the fresh artifact
- the testnet rehearsal (§9.8) passed — it also read the fresh artifact
- the mainnet deploy used the stale one

**The rehearsal validated the contract and not the path that deploys it.** That is the actual
lesson, and it is more general than this bug: a rehearsal that does not use the production
code path can pass while production is broken.

### Why it cost almost nothing

Phase B was designed self-dealt — `creator == treasury == the operator`. So the only money
stranded is the operator's own, and it is roughly **$2**. Had this been the shape originally
proposed (launch straight to real users), the stranded fees would have belonged to a stranger,
in a contract nobody can fix, with no recourse.

**That design decision paid for itself on the first run.** Not by preventing the bug — by
making it cheap to find.

### Fixed

1. **`compile-all.js` now writes both artifacts from the same compile.** Two copies of one
   thing only stay in step if nobody has to remember.
2. **`backend/tests/splitterDeployer.test.ts`** asserts the backend's artifact exposes the
   ERC20 interface *and* that the `splitERC20` selector is present in the compiled bytecode —
   an ABI and a bytecode from different compiles being exactly the shape of this failure.
   Verified by reinstating the stale artifact: two CRITICAL tests fail, as intended.

### Still to do

The stranded funds are unrecoverable; the token and its splitter stay as they are. A second
Phase B run with a correctly-deployed splitter is needed before the fee path can be called
proven. `collectFees` is already demonstrated to work — it is only the split that has not run
against real fees.

---

## 9.11 ✅ THE FEE PATH IS PROVEN — real money, end to end (2026-08-04)

Second Phase B run, with a correctly-deployed splitter this time. The bytecode guard added
after §9.10 confirmed it before launching: `splitERC20 in code: present ✅`.

| | |
|---|---|
| Token | `0x8aE999C51b0b001A8A2bD2D7884323AEB744216f` (`PONSRHOOD2`) |
| Pool | `0x3fDEA27e33211E7Ace831Db80D28e300f68eDD49` |
| FeeSplitter | `0xd80580634Bd5Eb3484C52eCEcE6a497C68a5eC87` |
| `collectFees` tx | `0xc2477ee28e859f3e091f74a24d56781e7d7b70733fa3990552a4190f3caafdac` |
| `splitERC20` tx | `0xe37b6e302f67bb14457560657a8a86b73a5b6967db130b63c454f504f611e380` |

A real buy generated real fees. From the contract's own `ERC20FeesSplit` event:

```
total     0.00003465    WETH
creator   0.0000329175  WETH   = 95%
treasury  0.0000017325  WETH   =  5%
sum == total, nothing left in the splitter
```

**Every link in the chain is now demonstrated rather than inferred:**

1. `launchToken` accepted by the real factory — §9.9
2. `feeRedirects[token]` set to our splitter by the factory — §9.9
3. Trading fees accrue to the locked Uniswap v3 position
4. `collectFees` authorises the treasury as `deployer` and **pushes ERC20 out** — §9.10, §9.11
5. `splitERC20` divides it **95/5 exactly, with no remainder** — §9.11

Only `PONSRHOOD2`'s WETH side had fees: the trade was a buy, so the fee was taken in the input
token. A sell would produce fees on the token side. Both paths use the same code.

### A false alarm worth recording

The verification script first reported a **50/50 split**. The contract was correct; the script
was not. Phase B sets `creator == treasury`, so measuring by balance delta credits the same
wallet twice and halves the apparent ratio — an arithmetic error that looks exactly like a
contract bug, on the one run where a contract bug was most plausible.

It now reads the ratio from the `ERC20FeesSplit` event, which carries both amounts separately
and reports what the contract actually did. **A verification tool that cannot distinguish
"wrong" from "measured wrong" is not a verification tool**, and this one nearly caused a
correct result to be thrown away.

---

## 9.12 The unit economics, from live mainnet reads (2026-08-06)

§9.9.1 established the *ratio*. This is the part that decides whether the ratio is viable:
what a launch costs, what it returns, and how far it can move without us. Every figure below
was read from the mainnet contracts on 2026-08-06, not taken from documentation.

| Value | Source | Read |
|---|---|---|
| `launchFee()` | factory | **0.0005 ETH** |
| `poolFee` | dex config 0 — uniswap v3 | **10000 = 1%** |
| `graduationThreshold` | launch config 0 | **4.2 ETH** |
| `protocolFeeShare` | locker | **30** |
| `MAX_PROTOCOL_FEE_SHARE` | locker | **50** |

### Break-even

The treasury pays the launch fee for every user (Part 5), so each launch starts underwater
and has to trade its way out:

```
treasury take   = 3.5% of trading fees
trading fees    = 1% of volume
treasury take   = 0.035% of volume

break-even      = 0.0005 / 0.00035  ≈  1.43 ETH of volume
```

Graduation is at 4.2 ETH, so **a token that graduates returns roughly 3× its launch fee**.
A token that never clears ~1.43 ETH of volume is a loss the treasury absorbs.

That ratio is the whole anti-abuse argument in one line. The attacker does not need to steal
anything — they only need to make the bot launch tokens that never trade. This is why the
checks in `validator.ts` are required scope and not hardening, and why weakening one to
"simplify the flow" changes the economics rather than the ergonomics.

### Two reasons 3.5% is still the optimistic figure

1. **Half the revenue is not money.** Fees arrive as `token0` and `token1` — the launched
   token itself plus WETH, never native ETH. The WETH half is real. The token half is a share
   of a new meme token, and most go to zero. Any model that values the token half at its
   nominal price is counting an asset that usually cannot be sold at that price.

2. **`protocolFeeShare` is theirs to raise, up to 50.** At the cap, the treasury's take falls
   from 3.5% to **2.5%** and break-even volume rises to ~2 ETH — with no action on our side
   and no notice. It is owner-settable on pons's side, which is exactly why CLAUDE.md forbids
   hardcoding it. The bot reads it live; **revenue models must treat 30 as today's value, not
   a constant.**

### ✅ DECIDED 2026-08-06: keep 95/5

The owner's call, and it needs no code change — `FeeSplitter` already splits 95/5. The
reasoning is that Ponsr will launch its own token, and the owner takes the **creator** share
on it (66.5% of that token's trading fees), which is expected to cover running costs. The
platform's 3.5% then does not have to carry infrastructure on its own.

Options not taken, kept so the decision can be revisited with its alternatives intact:

- **90/10** — creator 63%, treasury 7%, break-even ~0.71 ETH of volume instead of ~1.43.
- **Keep the ratio, change only the claims** — what was chosen, with the claims already
  corrected in §9.9.1.

Two consequences that follow from *how* this is funded, neither of them blocking:

1. **Running costs now depend on Ponsr's own token trading**, not on launch volume across the
   platform. Those are different risks: the platform can be busy while the token is flat, and
   the 3.5% alone breaks even at ~1.43 ETH of volume per launch. Worth revisiting if the
   token's fees come in under the infrastructure bill.
2. **The creator share arrives in the same shape as the treasury's** — the launched token plus
   WETH, never ETH (§9.9.1). Half of the owner's creator fees will be Ponsr's own token, which
   cannot be spent on hosting without selling it. Only the WETH half is directly usable.

A ratio change remains cheap at any time: a fresh `FeeSplitter` is deployed per launch, so a
future change affects later launches only and strands nothing already deployed.

Whichever is chosen, the numbers that may appear in user-facing copy are **66.5% and 3.5%**,
because those are what the contracts actually transfer. §9.9.1 covers why: the pre-protocol
figures overstate a creator's take by ~1.4×, and it is a number anyone can check on-chain in
a minute.

---

## 10. ⚠️ v2 re-read (2026-08-18): §7's pair-token findings are now WRONG

§7 was written on 2026-08-04 and said v2 was "deployed but closed", with **nothing approved,
not even ETH**, and stock pairing "not actionable". Every one of those reads was correct on the
day. Three of them are no longer true, and the difference is large enough to change what Ponsr
could be.

All of the below is read live from mainnet (chain 4663) and from the **verified source** of
`PonsV2LaunchFactory` at `0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8` — not from documentation.

### 10.1 Eight pair tokens are approved, and six of them are stocks

`approvedPairTokens` now returns `true` for eight assets. The full approval history is eight
`PairTokenApprovalUpdated` events, all grants, **none revoked**:

| Pair asset | Name | Graduation threshold |
|---|---|---|
| `AAPL` | Apple • Robinhood Token | **24.2 AAPL** |
| `NVDA` | NVIDIA • Robinhood Token | **41.6 NVDA** |
| `GOOGL` | Alphabet Class A • Robinhood Token | **24.2 GOOGL** |
| `TSLA` | Tesla • Robinhood Token | **26.0 TSLA** |
| `GME` | GameStop • Robinhood Token | **369.0 GME** |
| `SPCX` | Space Exploration Technologies Class A • Robinhood Token | **72.2 SPCX** |
| `SPY` | SPDR S&P 500 ETF Trust • Robinhood Token | **10.9 SPY** |
| `USDG` | Global Dollar (stablecoin, **6 decimals**) | **8090.0 USDG** |

Thresholds come from `pairTokenEconomics(pairToken)`, which also returns each asset's decimals.
**USDG is 6-decimal**, unlike everything else on this chain; any amount arithmetic that assumes
18 will be wrong by a factor of 10^12, which is not a rounding error but a different number.

Note `SPCX` — SpaceX is not publicly traded, so this is exposure to a private company as a
pairing asset. It is worth understanding what that token actually represents before building a
product around it.

A dollar comparison against v1's 4.2 ETH is deliberately not given here: this chain has no price
oracle for these assets, so any figure would be imported from off-chain and stated with more
confidence than it deserves.

### 10.2 Native ETH still works on v2 — it is exempt, not approved

`approvedPairTokens(0x0)` reads `false`, which looks like ETH pairing is impossible. It is not.
From the verified source, the launch gate reads:

```solidity
if (pairToken != address(0) && !approvedPairTokens[pairToken]) revert PairTokenNotApproved();
```

The zero address short-circuits the check. This is confirmed by behaviour as well as by source:
of the 43 real v2 launches, **13 used `pairToken = 0x0`** while `approvedPairTokens(0x0)` was
already `false`. So v2 is a superset of v1's capability, not a replacement for it — ETH pairing
plus eight approved assets.

### 10.3 The whitelist bypasses the global switch — and unlike v1, it has actually been granted

Same source, one line above:

```solidity
if (!launchEnabled && !whitelistedLaunchers[msg.sender]) revert NotWhitelisted();
```

So a whitelisted launcher can launch **while launching is globally off**. That matters because
of the asymmetry between the two factories:

| | v1 (`0xA5aAb3F0…`) | v2 (`0x7E1EAbd5…`) |
|---|---|---|
| `WhitelistedLauncherUpdated` events, all time | **0** | **2** |
| Currently whitelisted | nobody | two EOAs, both still `true` |

One of the two v2 whitelist holders is the factory's own `owner()`
(`0x0815A488…`). The other, `0xD48e5622…`, is not — so an address outside pons's own has been
granted this. On v1 it has never been granted to anyone, ever.

**This changes the shape of the ask.** "Please turn the launchpad back on for everyone" is a
platform decision; "please whitelist this address on v2, as you have done before" is a request
with precedent, and it is the only one of the two that has ever happened.

### 10.4 v2's public window was real, and short

The 43 v2 launches happened on **2026-08-01 between 02:08 and 02:15 UTC** — seven minutes — by
**18 distinct deployers**, none of them the whitelisted addresses. So this was ordinary public
usage while `launchEnabled` was `true`, not a seeded test. `LaunchEnabledUpdated(false)` follows
immediately at block 24672804.

Two of those launches have since produced `PoolGraduated`, so the full v2 lifecycle — launch,
curve, graduation into a Uniswap pool — has demonstrably completed on mainnet.

### 10.5 Everything else on v2, as read today

| Call | Value | Note |
|---|---|---|
| `launchEnabled()` | **`false`** | closed since 2026-08-01 |
| `launchFee()` | `0.0005 ETH` | identical to v1 |
| `launchConfigCount()` | `1` | one config |
| `launchDeployer()` | `0xdD89f26b…` | **set** — launches revert with `LaunchDeployerNotSet` if it were not |
| `maxCreatorTaxBps()` | `1000` | creator tax capped at 10% |
| `owner()` | `0x0815A488…` | also whitelisted |

### 10.6 What this means for Ponsr, stated plainly

- **The fee still leaves in ETH, but the revenue would arrive in the pairing asset.** Launch
  fees are paid in ETH regardless of pairing; §7's constraint still holds — the pairing asset is
  fixed at launch and the creator and treasury shares arrive in it. A stock-paired launch means
  the treasury's 3.5% arrives as AAPL, not ETH. That is arguably an improvement on today, where
  half the take is a memecoin that usually goes to zero, but it is a different treasury model
  and should be decided rather than absorbed by accident.
- **Nothing here is buildable until an address is whitelisted or the switch flips.** The
  encoder work is not blocked, though: §7 already recommended treating `pairToken` as a
  first-class parameter, and 10.1 turns that from foresight into a requirement.
- **Targeting v2 is not a rewrite of a working system.** v1 is also closed
  (`LaunchEnabledUpdated(false)`, 2026-08-12 19:42 UTC), so both paths need pons to act. Given
  that, the version to ask about is the one with the stock pairing and the whitelist precedent.
- **Open question #17 ("which version to target") is re-opened.** It was closed for v1 on the
  grounds that v1 was open and v2 was not. Neither is open now, so the reasoning that settled it
  no longer applies.

### 10.7 🔴 v2 does not push creator fees — it escrows them, and the escrow pays `msg.sender`

Found on 2026-08-18 while wiring the v2 launch path, and it would have cost real money.

v1 **pushes**: `PonsLaunchLocker.collectFees` transfers the proceeds straight to
`feeRedirects[token]`. A contract that can move ERC20 out again is therefore sufficient, which
is exactly what `FeeSplitter` is and why §9.11 could prove the fee path end to end.

v2 **credits**. Fees accumulate in `PonsV2FeeEscrow`
(`0xbc39B6502E1a6Ab36E4A5c5026A35F08342A0A9c`, verified source) against the recipient's
address, and are collected by calling:

```solidity
function claimToken(address token) external returns (uint256);   // pays msg.sender
```

Read that carefully. There is **no `claimFor`**, and no way for the treasury or anyone else to
claim on another address's behalf. So a v2 launch naming a plain `FeeSplitter` as
`creatorFeeRecipient` would be credited correctly and forever, and **no transaction would exist
that could ever move those fees**. Nothing reverts. The money is visible, attributed, and
permanently unreachable — the §9.10 incident arriving by a different route.

Confirmed empirically as well as from source: the escrow's mainnet log shows `CreditedToken`
raised by curve and hook contracts as trading happens, and `ClaimedToken` raised by recipients
collecting. **There is no public "collect" step for a fee recipient to trigger on v2** — the
money is already there; the only action is the claim.

Consequences, all now implemented:

- `contracts/FeeSplitterV2.sol` inherits `FeeSplitter` and adds `claimAndSplit`. It inherits
  rather than restates: a second copy of the split logic is a second thing to keep in step,
  which is what stranded the fees the first time.
- **Partial claims are required, not a nicety.** The escrow documents that `creditToken` is
  permissionless, that a recipient's balance aggregates credits from every source, and that
  against an asset with a per-transfer cap a full-balance claim can revert — leaving the
  recipient unable to draw any of it.
- `compile-all.js` emits both splitters from one compile; `splitterDeployer.ts` picks by
  factory version and throws rather than falling back; `phase-b-launch.ts` reads
  `claimAndSplit`'s selector back out of the deployed bytecode.
- `scripts/collect-and-split-v2.ts` replaces the v1 collection flow, and refuses outright if
  handed a v1 splitter — verified against a real deployed one.

**Still unproven:** no v2 launch can be made by anyone while `launchEnabled` is false, so
`FeeSplitterV2` has never met a real fee. It passes 12 tests against a mock built from the
escrow's own source, which is not the same thing. Run it end to end before trusting it with a
creator's money.


---

## 11. WE WERE READING A SUPERSEDED FACTORY (2026-08-20)

Section 10 was written on 2026-08-18 against `0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8` and
concluded that launching was closed platform-wide. Every read in it was correct **about that
contract**. It was not the contract pons uses.

**pons deployed a new V2 factory on 2026-08-03** -- block 26,841,846 -- and left launching open.
Over **1,900 launches** have gone through it since. Ponsr spent a week reporting a closed
launchpad, alerting about a closed launchpad, and asking pons to whitelist us for a closed
launchpad, while the door stood open on an address nobody was reading.

### 11.1 The current deployment, verified from the chain

| | |
|---|---|
| Factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Fee escrow | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` |
| Launch deployer | `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42` |
| Launch forwarder | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` |
| Created | block 26,841,846, 2026-08-03 |
| Runtime bytecode | 24,177 bytes, sha256 `226a042e...3848` |
| Canonical ABI | sha256 `1d424e7b...b323` (verified, not a proxy) |
| `launchEnabled()` | **true** |
| `canLaunch(treasury)` | **true** |
| `whitelistedLaunchers(treasury)` | false |

**Ponsr can launch today, through the public gate.** The whitelist is still worth having -- it
survives the gate closing -- but it was never a prerequisite for development, testing, or
launching.

### 11.2 Why changing only the address would have been worse than doing nothing

Three things differ between the two V2 deployments, and each fails differently:

- **The calldata.** Current `TokenParams` ends with an extra `bytes32 salt`, moving the selector
  from `0xa41d5f2b` to `0xf35abbcf`. Old calldata sent to the current factory reverts --
  confirmed by `eth_call` before any code was written.
- **The fee escrow.** Each deployment credits its own. The escrow is baked immutably into every
  splitter, escrow claims pay `msg.sender`, and there is no `claimFor` -- so a splitter built
  against the superseded escrow holds a creator's fees where **nothing can ever reach them**.
  This is the single most dangerous thing in the migration, and it is now a hard assertion both
  before the splitter is deployed and again before the calldata is built.
- **The approved assets.** The superseded factory approved 8. The current one approves **23** --
  adding AMD, AMZN, MSFT, META, COIN, MU, PLTR, TTWO, COST, DJT, MSTR, QQQ, RDDT, SNDK, CRCL --
  and has already **revoked RIVN**. Carrying the old snapshot forward would offer a set both too
  small and, for the revoked one, wrong.

### 11.3 Identity: the treasury is the on-chain deployer

The current factory records `msg.sender` as `originalDeployer`. Ponsr calls it directly, so:

```text
originalDeployer     = Ponsr treasury
creatorFeeRecipient  = the per-launch FeeSplitterV2
95% of the split     = the user's generated wallet
5% of the split      = Ponsr treasury
```

`launchTokenFor(...)` would change this but is callable **only** by the configured forwarder.
**Do not claim the X user is recorded as the on-chain deployer.** Preserving that would be a
separate architecture project, not part of this migration.

### 11.4 There is no pons "V3"

References to V3 in this repository mean **Uniswap V3 infrastructure used by pons v1**. There is
no third pons launch protocol, and none may be implemented or advertised without a separately
verified canonical factory.

### 11.5 What this cost, and the lesson

One mutable `PONS_V2_FACTORY_ADDRESS` made a superseded deployment and the current one
indistinguishable. Every guard read the wrong contract *confidently*: `/status` was internally
consistent and completely wrong, and `launchpadWatch` alerted correctly about a contract nobody
uses.

**An address is not an identity.** A deployment is an ABI, an escrow, a selector, a schema, and
hashes proving the chain matches the description. That is what `backend/src/deployments.ts` now
holds, with exactly one entry executable and the rest indexable forever.

### 11.6 The hashes were recorded and never read (2026-08-20)

§11.5 ends by saying a deployment is "an ABI, an escrow, a selector, a schema, and hashes
proving the chain matches the description." The registry did hold all of that. **Nothing read
the hashes.** They sat in `deployments.ts` as accurate, checked-in, inert data while the launch
path went on resolving a factory by address.

So the fix for "an address is not an identity" had, for a week, exactly the same shape as the
bug: a description that looked authoritative and was never checked against the chain.

`backend/src/deploymentIdentity.ts` closes it. Four axes, and the source of truth for each
matters more than the check:

| axis | truth comes from | catches |
|---|---|---|
| runtime length + sha256 | the chain, `getCode` | an upgrade, a redeployment, a wrong address, the wrong chain |
| fee escrow | the chain, `feeEscrow()` | the mismatch with no recovery |
| ABI sha256 | the file on disk | a regenerated or edited artifact |
| launch selector | derived **from that ABI** | a manifest claiming a selector the ABI does not produce |

The last one is the one worth stating: comparing the manifest's selector string to itself would
prove nothing. It is recomputed from the signature against the loaded ABI, so a drifting ABI and
a stale selector cannot quietly agree with each other.

It runs in `readCurrentReadiness()`, ahead of every permission. **A green `canLaunch` from an
unexpected contract is not reassurance — it is the most dangerous reading available.**

Verified live against mainnet, all three deployments `IDENTITY OK`, with the executable one
matching the audit's independently recorded values exactly: runtime `24177` bytes /
`226a042e…`, ABI `1d424e7b…`, escrow `0xd3AFEB2a…`, selector `0xf35abbcf`.

**Two false alarms it raised first, both the guard's fault.** Pointed at real mainnet it
reported `pons-v1` as drifted on two axes, and the manifest was right both times: v1's ABI file
wraps its array in provenance metadata (`_source`, `_note`, …) and the recorded hash covers the
inner array; and v1 exposes no `feeEscrow()` at all, because it pushes fees from the locker.
Reading that revert as drift condemned a contract for lacking a function it was never meant to
have.

Both are fixed, and the second produced a schema change worth keeping: `feeModel` is now an
explicit field (`push-from-locker` | `escrow-credit`) rather than a comment above `feeEscrow`.
One field had been holding a different *kind* of thing per deployment — the same overloading,
one level down, that this whole registry replaced.

A guard that cries wolf about correct data is worse than no guard: it gets rationalised on first
sight, and the rationalisation is what survives to meet the real mismatch.

### 11.7 The verifier passed for a factory the bot never calls (2026-08-20)

`turnkey-verify-policy.ts` read `PONS_V2_FACTORY_ADDRESS` and reported **PASSED** for
`0x7E1EAbd5…` — four green ticks, none of them about the launch path, ending in "safe to set
`TURNKEY_POLICY_CONFIRMED=true`". §11's own lesson, inside the tool written to apply it.

It now takes the factory from the registry and sends the deployment's real launch selector
rather than a placeholder.

Two related fixes from the same afternoon:

- **A failure is not a denial.** Every error had been classified as "denied", so when Turnkey
  disabled signing org-wide over quota, the script announced NOT SAFE YET and sent the operator
  to fix a policy created correctly minutes earlier. There are three outcomes now — `allowed`,
  `denied`, `unknown` — and any unknown makes the whole run INCONCLUSIVE. *Nothing here says the
  policy is wrong, and nothing says it is right* is a real result; a green tick on an unasked
  question is not.
- **`turnkey-read-policies.ts`** reads the rules without signing anything, because signing is
  exactly what disappears when quota runs out — precisely when you most want to know what the
  policies say. It reports rule *text*, and says so: a policy engine failing open would print
  the same thing.
