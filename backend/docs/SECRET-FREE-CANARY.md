# The keyless canary dry run, and where credentials start

Closes 5A. Before this, the canary dry run constructed no signer and requested no signature —
both true — and was described as "keyless". It also ran `import { config }`, which calls
`dotenv.config()` at module load and parses every credential-bearing field. On a machine whose
`backend/.env` holds the Turnkey API private key, the raw treasury key and the third-party
tokens, a "keyless" preflight read all of them.

Three claims, kept apart because only two of them used to hold:

| claim | before | now |
|---|---|---|
| no signer constructed | true | true |
| no signature requested | true | true |
| no credential material read | **false** | true |

Reading the mixed `.env` and discarding the dangerous keys would not fix this. The bytes are
read the moment the file is opened. The dry run must never open it.

## The boundary

`src/preflightEnv.ts` is the only settings source the preflight uses. It:

- imports `./config` **never**, so `dotenv` never runs;
- reads `process.env`, and optionally `.env.canary`;
- refuses to serve any name on its credential list, throwing rather than returning it;
- throws if `.env.canary` itself contains a credential name;
- reads **lazily**, at call time, which is what preserves local development (see below).

Credential modules are loaded by `await import(...)` **after** the `--execute` gate in
`scripts/phase-b-launch.ts`, never at module load.

## Commands

Keyless dry run. Nothing is signed, nothing is sent, and `backend/.env` is never opened:

```bash
cd backend && RPC_URL=… CHAIN_ID=4663 TREASURY_ADDRESS=0x… npm run launch:canary
```

Those values may live in `backend/.env.canary` instead, which must contain **no secrets** —
the loader refuses the file if it does. Everything in it is public: an RPC URL, a chain id, a
factory version, the treasury's own address.

Execute mode. Only here are `src/config.ts` and `src/treasurySigner.ts` loaded, and only here
does a credential enter the process:

```bash
cd backend && npm run launch:canary -- --execute
```

Recovery stays keyless and read-only, and cannot broadcast — `CanaryRecoveryDeps` has no
signer and no send function to supply:

```bash
cd backend && npm run recover:canary
```

Normal backend development is unchanged:

```bash
cd backend && npm run dev
```

`src/index.ts` still imports `src/config.ts`, whose `dotenv.config()` populates `process.env`
before anything reads it. Because `preflightEnv()` reads at call time rather than at module
load, the bot sees exactly the values it always did. A module-load snapshot would have read
`process.env` before dotenv ran and silently fallen back to defaults.

## How this is proven

`tests/secretFreeDryRun.test.ts` does not read the source. It spawns the real entrypoint in a
temporary directory holding a `.env` full of sentinel values, with `fs` and `Module._load`
instrumented from inside the process (`tests/fixtures/importProbe.cjs`), and asserts what the
run actually touched:

- the mixed `.env` was never opened;
- `dotenv` was never loaded;
- `src/config` was never loaded;
- `treasurySigner` and `@turnkey/*` were never loaded;
- no sentinel value appears in any output;
- the preflight still ran, against a local mock RPC, and made real chain calls.

One test asserts the probe recorded anything at all. That is not ceremony: three separate
harness bugs during development produced an empty report, and every other assertion in the
file passes vacuously against an empty report. A broken harness looks exactly like perfect
evidence.

A separate static check fails if any module in the preflight import graph acquires a static
import of `src/config.ts`. It supplements the runtime proof and does not replace it.
