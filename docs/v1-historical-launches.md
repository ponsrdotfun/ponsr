# The two v1 launches, classified from evidence

**Status:** finding recorded. No remediation is authorised or justified by the evidence
below. No database row has been changed. Read this before writing anything about them.

Two launches in the production database went to `pons-v1`. An earlier finding document
said the fee routing was absent because the database rows carry
`splitter_address = NULL`. **That inference was wrong**, and it was wrong in the expensive
direction: it described creator fees as unrouted when the splitters exist on chain and are
wired. The database is missing a link the chain has.

That is the general lesson worth carrying: a NULL in our own record is a statement about
our record. It is not a statement about the chain, and only the chain can answer what the
chain did.

## What is PROVEN

Read from the public RPC and from the checked-in registry. Nothing here comes from the bot
database except where labelled.

| | Launch A | Launch B |
|---|---|---|
| token | `0xDE4C300cb3ddE2aa1BF78DcCa4b32C27de82FB46` | `0x592f1604CC0641A8143F7d5c6DA958857dDe27D0` |
| tx | `0x6b4ada64…2329c0` | `0x8e844977…f291f201` |
| target | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` (`pons-v1`) | same |
| selector | `0x686399cb` | same |
| locker redirect | `0x86AD6AA9E248382A2AF7dD0f157e3400D94Ad6Df` | `0xA23746b5782629b27D5d2849ce46c85Efe697B1F` |
| splitter `creator()` | `0x896c44Db4671f6405bD22A0D815A164870262619` | `0x71A9DF278cF8885d83513Ae7579e1Cd63d240363` |
| splitter `treasury()` | `0x08e01f1B…74Fa` | same |
| split constants | 9500 / 500 bps | same |
| splitter `token()` | `0x0000…0000` | same |
| `totalReceived` (2026-08-26) | 0 | 0 |

- **v1 launches: PROVEN.**
- **FeeSplitter contracts and locker redirects: PROVEN.**
- **Creator/treasury 95/5 routing: PROVEN.**
- **DB splitter linkage and launch provenance reportedly absent: EXECUTOR-REPORTED**, from
  a read of `/data/bot.sqlite`, pending later DB-artifact reconciliation.
- **Creator fees stranded or lost: NOT PROVEN.** Nothing in the evidence supports it.

## One measurement that is easy to misread

The splitters' `token()` immutable is the zero address, which reads as a native-ETH
splitter. Separately, the deployed runtime of both contracts **contains the `splitERC20`
selector** (`0xf6f697ab`), along with `claimableERC20`, `withdrawERC20` and
`totalReceivedERC20`. Both observations are true. `splitERC20(address)` takes the token as
an argument, so a zero `token()` immutable does not by itself establish that ERC20 fees
cannot be split.

Neither reading is asserted here as the conclusion. What is asserted is the measurement,
and that the question is open.

## Reconstruction specification — for a LATER, separately authorised task

No write is authorised by this document. This is the specification a maintenance task would
follow, recorded now so that task does not have to re-derive it.

For each of the two launches, derive from **selected-factory-scoped receipt logs** and
**live locker state**:

- `deploymentId` = `pons-v1`, and the exact v1 factory address;
- token, transaction hash, block, deployer, pair token, selector and fee paid;
- the locker fee redirect for that token;
- the splitter's runtime identity (code hash and the selectors it exposes);
- `creator`, `treasury`, the 95/5 constants, and the native-token placeholder;
- the DB discrepancy — `splitter_address` and provenance — recorded as a discrepancy,
  **without describing routing as absent**.

The later write must be ordered: backup → `integrity_check` and `foreign_key_check` →
exact row preconditions → transactional annotation → read-back → rollback proof. It must
not rewrite historical creator identity, and it must not claim lost funds without evidence.

## Why this can no longer happen

The launches went to v1 because `PONS_FACTORY_VERSION` let an environment variable answer a
question the registry already answers, and its default was `v1` — so an environment that
never mentioned the setting selected the superseded factory in silence. The setting was
removed on 2026-08-26 along with `V1Target`, `PONS_FACTORY_ADDRESS` and
`PONS_LOCKER_ADDRESS`. See `backend/tests/v1NonExecutable.test.ts` for the behavioural
proof and `backend/tests/v1HistoricalReader.test.ts` for the proof that v1 remains
readable.

**The code change does not remove signer permission.** Turnkey still allows the v1 factory
as a destination. That is a separate owner ceremony — see
`docs/TURNKEY-V1-REVOCATION-CEREMONY.md`.

## Public website scope after the current-V2 canary

The public website now lists only launches attributed to Ponsr through
`pons-v2-current-7ed`. That product decision does not erase V1 history. The four confirmed
V1/test launches are retained here and remain permanent on chain:

| name / symbol | token | launch transaction | block | event time (UTC) |
|---|---|---|---:|---|
| PONSRHOOD / PONSRHOOD | `0xc615D10B97cBC2802162BF7C1b8dFc28163A299D` | `0x26cb2bad3a0a58ebe62fe2269eef4e709b7e270a94faddc79ad235ac8b48d27e` | 27,948,393 | 2026-08-04 21:30:19 |
| PONSRHOOD2 / PONSRHOOD2 | `0x8aE999C51b0b001A8A2bD2D7884323AEB744216f` | `0xabc51fc9c926c28d72a90415d17a5a6cd9de804106d1b091db27f2d9d31914be` | 27,956,490 | 2026-08-04 21:43:52 |
| PONSR / PONSR | `0xDE4C300cb3ddE2aa1BF78DcCa4b32C27de82FB46` | `0x6b4ada64c5853073135a110e695c671162575d616782f8ec25f3a789ed2329c0` | 34,218,573 | 2026-08-12 03:53:41 |
| PONSR / PONSR | `0x592f1604CC0641A8143F7d5c6DA958857dDe27D0` | `0x8e8449778ca8ba4a303f7ee1d574f03b32ca4554e423b85f5b9e700bf291f201` | 34,259,120 | 2026-08-12 05:01:10 |

They are not launch destinations, public cards, feed records, counts, or sitemap entries.
V1 remains historical/read-only.
