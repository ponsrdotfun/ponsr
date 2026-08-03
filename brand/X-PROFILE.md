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

> **Corrected 2026-08-04.** Option A previously read "the Pons factory" with a
> capital P, which breaks pons's own attribution terms — they ask for lowercase
> plus a link back — and it is the rule `CLAUDE.md` lists under "what NOT to do".
> Every option below now writes **pons** lowercase, and A carries the link.

**A — mechanical, clearest, and the only one that satisfies the attribution terms in full** · 157 chars
> Tag me with a name and a ticker — your token goes live on Robinhood Chain via the pons factory (ponsfamily.com). Free to launch. Neutral tool, unaffiliated.

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
- **Website:** `https://ponsr.fun` — this field is currently empty on the live account.
  It is the only clickable link X gives an account by default, and it is the whole
  point of the profile; leaving it blank means every visitor has to guess.
- **Pinned post:** worth writing once the bot is live on testnet — a single example
  tweet showing the tag → reply → token address round trip is the clearest possible
  explanation of the product.

## The separation from pons, and why the spelling matters

The account name sits one character away from **pons**, the launchpad this bot builds
on top of. Ponsr is an independent third-party tool, not pons.

Two rules follow from that, and neither is stylistic:

1. **Always write "pons" in lowercase, and link back to ponsfamily.com.** Those are
   pons's own attribution terms. Capitalising it as a proper noun in the same
   sentence as "Ponsr" is exactly what makes the two read as one brand.
2. **Never state or imply affiliation.** Not in the bio, not in a pinned post, not
   in a reply. The visual identity (robot, emerald) is deliberately nothing like
   theirs for the same reason.

Both rules are recorded in `CLAUDE.md` under "What NOT to do" — this file is just
where they get applied to the X account.

## Regenerating

`scripts/make-x-assets.py` rebuilds both files from `website/logo-transparent.png`.
Re-run it if the logo or palette changes, so the profile never drifts from the site.
