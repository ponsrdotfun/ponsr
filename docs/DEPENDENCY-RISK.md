# Dependency risk, by reachability

Measured 2026-08-21 with `npm audit`. Numbers move; the reasoning is what should outlast
them, and `npm audit` prints its own totals whenever you want the current ones.

**Nothing here is described as clean.** Root toolchain findings do not reach the running
bot, and saying "clean" would invite someone to stop checking.

---

## What actually runs

| scope | command | result |
|---|---|---|
| **backend, production deps** | `cd backend && npm audit --omit=dev` | **0 vulnerabilities, any severity** |
| root, production deps | `npm audit --omit=dev` | 2 total — 1 high, 1 low |
| root, full toolchain | `npm audit` | 18 total — 5 high, 2 moderate, 11 low |

The first row is the one that matters operationally. `backend/` is the process that runs
24/7, listens on a webhook, holds the signer and spends the treasury. Its production
dependency tree reports nothing.

The root workspace is a **build and test harness**: hardhat, solc, jsdom, ethers for
scripts. It is never deployed. Nothing a user can send the bot reaches it.

---

## The root findings, one at a time

### `tmp` — high, via `solc`

Arbitrary temp-file write through a symlinked `dir`, and path traversal via an
unsanitised prefix.

**Reachability: build-time only.** `solc` runs inside `compile-all.js`, on a developer or
CI machine, against `.sol` files already in this repository. An attacker who could
influence that input already controls the source. The bot never invokes solc.

**Mitigation:** none applied. Accepted as build-time, and pinned — `solc` is exactly
`0.8.36` with a committed lockfile, so this is a known quantity rather than whatever npm
resolves next week.

### `undici`, `adm-zip`, `js-yaml`, `serialize-javascript`, `brace-expansion` — dev only

Hardhat's networking and test tooling. They appear only under `npm audit` without
`--omit=dev`, they run when someone types `npm test` or the fork rehearsal, and they are
absent from any deployed artifact.

**Reachability: dev only.** Accepted.

---

## Why nothing is force-upgraded

`npm audit fix --force` walks major versions. On this tree that means moving hardhat or
ethers underneath a fork rehearsal and a compiler pin that took real work to make
reproducible — trading a build-time advisory nobody can reach for a runtime difference
nobody has tested.

The one that would justify it is a finding in `backend/`'s production tree, and there are
none.

---

## Re-checking

```bash
cd backend && npm audit --omit=dev      # the only row that gates a deploy
npm audit --omit=dev                    # root runtime
npm audit                               # root toolchain, expected non-zero
```

A non-zero root toolchain count is the normal state, not a regression. What would be a
regression is the first row moving off zero, or a root finding turning out to be
reachable from something a user controls.
