# Ponsr — website

Single self-contained `index.html`. No build step, no framework, no JS dependencies —
the only external request is the Google Fonts stylesheet.

## View it locally

Open `index.html` in any browser, or serve the folder:

```bash
npx serve website/
```

## Routes

Three views live in the one file, each with a real URL so it can be linked from the bot's
reply on X, refreshed, bookmarked and shared:

| URL | View |
|---|---|
| `/` | Landing page — hero, live ticker, stats, how it works, spotlight, FAQ |
| `?view=explore` | The board — card grid, search, sort, status filter, pagination |
| `?token=SYMBOL` | Token detail — chart, stats, contract address, "what if I held" panel |

Query parameters are used because they work on any static host with no configuration.
Behind a host rewrite (Vercel/Netlify) these become `ponsr.fun/explore` and
`ponsr.fun/token/SYMBOL`. The router reads either shape, so the rewrites work the moment
they are deployed; flip `PRETTY_URLS` in the same commit so it also *writes* them.

## What's real vs. mock

**Real:** every route, interaction, animation, the search/sort/filter/pagination logic,
the accessibility work, and the responsive behaviour.

**Mock:** all of the data.

- `MOCK_TOKENS` near the top of the `<script>` block is the dataset. A seeded generator
  pads it to a realistic size so paging and sorting are exercised properly.
- **`fetchLedger()` is the single integration point.** Replace its body with the real API
  call and drive `startLedgerRealtime()`'s update helpers from a websocket instead of the
  simulated feed.
- Contract addresses are deterministic placeholders from `previewAddress()`. Swap in the
  real `token_address` from the `launches` table.
- The what-if panel's **Connect wallet** button is a labelled preview that reveals sample
  figures. The real per-wallet history calculation is the Phase 6 indexer described in
  Part 3 of `docs/MASTER-twitter-launch-bot.md` — it is not implemented here.

## Motion

The motion layer implements the GSAP presets from the `ui-ux-pro-max` skill natively
(CSS/Web APIs), rather than pulling in GSAP: per-character headline reveal, magnetic CTA,
staggered card entrance, layered parallax, shared-element page transitions via the View
Transitions API, and shimmer loading skeletons. Each is commented with the preset it
implements and the constraint that preset imposes.

Everything is disabled under `prefers-reduced-motion`, and route changes still work on
browsers without the View Transitions API — they just cut instead of morphing.

## Re-running the smoke test

```bash
node smoke-test.js
```

39 checks (needs `jsdom`, already in the repo's root `package.json`), covering routing,
the grid, sorting/search/pagination, the what-if gate, the motion layer, and regression
guards for three bugs found in audit: duplicate view-transition names, duplicate token
symbols, and focus stranded inside a hidden view.
