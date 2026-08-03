# Contracts: Compiling & Testing

## Why this is set up unusually

The environment this project was originally built in has restricted network egress that
blocks `binaries.soliditylang.org`, which Hardhat's built-in compiler downloader needs. To
work around this without weakening the tests at all, contracts are compiled via the pure-JS
`solc` npm package directly, and Hardhat is used only for its in-process local blockchain
(Hardhat Network) via `@nomicfoundation/hardhat-ethers` -- which doesn't need solc at all.

**If you have normal, unrestricted network access, you can ignore this section entirely** and
just use standard Hardhat commands (`npx hardhat compile`, `npx hardhat test`) -- everything
below still works too, so there's no need to change anything, but you don't have to route
around the same restriction.

## Compiling

```bash
node compile-all.js
```

This compiles `contracts/FeeSplitter.sol` and the test-only helper contracts in
`contracts/test-helpers/`, and writes ABI + bytecode to `contracts-test/artifacts.json`.

For a compile-only sanity check with size/warning reporting (no test helpers, just the main
contract):

```bash
node compile-check.js
```

## Testing

```bash
npx hardhat test --no-compile
```

The `--no-compile` flag is required in network-restricted environments -- it stops Hardhat
from attempting its own solc download, since the tests load bytecode from
`contracts-test/artifacts.json` (produced by `compile-all.js` above) via
`ethers.ContractFactory` directly, rather than via `hre.ethers.getContractFactory(name)`
(which would require Hardhat's own compile step to have succeeded).

**Important:** if you edit `FeeSplitter.sol`, re-run `node compile-all.js` before re-running
tests, or the tests will run against stale bytecode.

## What's tested

13 tests in `FeeSplitter.test.js`, covering:
- Deployment validation (zero-address reverts)
- Exact 95/5 split math, including an odd/non-round amount to check for rounding dust
- Event emission correctness
- The forward-failure -> claimable -> withdraw() fallback path (what happens if a recipient
  address can't accept a plain ETH transfer)
- A live reentrancy attack against `withdraw()`, proving the checks-effects-interactions
  ordering prevents double-spending a claimable balance
- An invariant check (`creatorAmount + treasuryAmount == input amount`, always, across many
  amounts) -- the property that matters most for user trust

All 13 currently pass. See `docs/SECURITY-BOUNDARIES.md` in the backend workspace for why
this is meaningful testing but not a substitute for a real audit before mainnet use.
