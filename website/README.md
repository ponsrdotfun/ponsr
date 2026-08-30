# Ponsr website V2

A dependency-light static site with modular CSS/ES modules, generated canonical token routes, and one Netlify read function. Netlify publishes `website/`; no backend or financial path is modified.

## Public scope

The public feed contains **only launches attributed to Ponsr through current V2**:

- deployment: `pons-v2-current-7ed`
- factory: `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
- registry start block: `26841846`
- canonical token identity: contract-address route, lower-cased in URLs

V1, legacy V2, and test launches are historical documentation only. They are intentionally excluded from public cards, counts, search, and sitemap. See `docs/v1-historical-launches.md`.

## Data contract

`website/data/launches.json` is the reviewed last-known-good snapshot. `/.netlify/functions/launch-feed` overlaps the snapshot by 128 blocks, reads only bounded ranges, halves failed ranges to a minimum, retries with bounded backoff, and deduplicates on the launch transaction hash while preserving the exact log index. A Ponsr launch transaction emits one selected-factory `TokenLaunched` record, and the transaction key lets an older snapshot with a missing log index reconcile rather than duplicate. Browsers fetch this compact feed; they never scan chain history.

The function reads the backend's public `/status/core` endpoint only to reflect `publicLaunchEnabled`. It performs no mutation. A failure preserves the last-known-good false gate as `stale`, never as enabled.

Each source reports `complete`, `partial`, `stale`, or `error`. `generatedAt` is the snapshot watermark; `observedAt` is request time; each launch's `blockTimestamp` comes only from its authoritative block. Missing block time remains unknown.

## Routes

- `/` — Decide / Learn landing with real PSTONKS evidence
- `/explore` — Monitor current V2 launches
- `/token/0x…` — Command / Inspect token provenance
- `/terms` — mechanism-aware terms

`npm run build:website` generates static address pages with canonical, OG, description, and JSON-LD metadata plus `sitemap.xml`.

## Verification

```bash
npm run test:website
npm run build:website
npm run test:website
```

The current simulator is deliberately unavailable until verified `getReserves` data is part of the canonical feed. It does not use legacy pool mechanics; current V2 trade semantics are `CurveBuy`/`CurveSell`. Reserve, liquidity, valuation, momentum, and price-history claims are not fabricated.
