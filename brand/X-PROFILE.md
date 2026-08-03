# Ponsr — X profile assets

Generated from the site's own logo and palette, so the account and the website read
as one brand.

| File | Size | Where it goes |
|---|---|---|
| `x-profile.png` | 1024 × 1024 | Profile picture (X crops it to a circle) |
| `x-banner.png` | 1500 × 500 | Header / banner |

Both are well under X's 2 MB limit. Upload as-is — no cropping needed.

## Bio options (X limit: 160 characters)

Pick one. All four stay inside the neutral-tool framing the project's own legal
research calls for (Part 4): no "investment", "returns", "profit" or "guaranteed",
because the bot *causes* tokens to exist and promotional language is the thing that
changes how that gets characterised.

**A — mechanical, clearest** · 152 chars
> Tag me on X with a name and a ticker. Your token goes live on Robinhood Chain via the Pons factory. You pay nothing to launch. Neutral tool, not advice.

**B — brand-led, echoes the site's tagline** · 158 chars
> Every launch, on the record. Tag @ponsrdotfun with a name and ticker — your token deploys on Robinhood Chain. Creators keep 95% of fees. Neutral tool.

**C — shortest** · 138 chars
> Turn a tweet into a token on Robinhood Chain. Launching is free; creators keep 95% of trading fees. A neutral tool, not investment advice.

**D — leads with the public-record angle** · 145 chars
> Tag me, get a token on Robinhood Chain. Free to launch, 95% of creator fees are yours, and every launch stays on the public record. Neutral tool.

## Other profile fields

- **Name:** `Ponsr`
- **Handle:** `@ponsrdotfun`
- **Location:** `Robinhood Chain` (X allows free text; it reinforces the chain without a claim)
- **Website:** `https://ponsr.fun`
- **Pinned post:** worth writing once the bot is live on testnet — a single example
  tweet showing the tag → reply → token address round trip is the clearest possible
  explanation of the product.

## One thing to decide before going public

The account name sits one character away from **Pons**, the launchpad this bot builds
on top of. Ponsr is a third-party tool, not Pons — the bio wording above says
"via the Pons factory" rather than implying any affiliation, and the visual identity
(robot, emerald) is deliberately nothing like theirs. Worth keeping that separation
in the pinned post and anywhere else the account explains itself.

## Regenerating

`scripts/make-x-assets.py` rebuilds both files from `website/logo-transparent.png`.
Re-run it if the logo or palette changes, so the profile never drifts from the site.
