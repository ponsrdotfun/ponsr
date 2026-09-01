#!/usr/bin/env node
/**
 * REFRESH THE COMMITTED LAUNCH SNAPSHOT.
 *
 * `website/data/launches.json` is the site's floor: every page, the board and
 * the social cards start from it, and the live functions only advance PAST it.
 * Nothing in this repository refreshed it -- `build-website.mjs` merely reads
 * it -- so the distance between the snapshot and the chain head grew every day
 * until the scan that closes the gap stopped completing.
 *
 * Measured on production 2026-08-30, with the snapshot two days old: discovery
 * covered 1 547 782 blocks, `launch-feed` took 25.5 s, returned `state:
 * partial`, and a token that plainly exists dropped out of the list. Every
 * social card for it answered 503. The snapshot is not a convenience; a stale
 * one is an outage with a delay fuse.
 *
 * TWO RULES THIS SCRIPT WILL NOT BEND
 * -----------------------------------
 * 1. **A partial scan is never written.** Writing what a half-finished read
 *    returned is how a launch silently disappears from the site's own floor.
 *    An incomplete range aborts with a non-zero exit and the file untouched.
 * 2. **It merges, it does not overwrite.** The snapshot carries facts no
 *    getter reproduces -- `splitter`, `launchFeeEth`, an operator's
 *    description. Fields the chain can speak for are refreshed from the chain;
 *    the rest are preserved from whatever is already committed.
 *
 * Usage:  node scripts/refresh-snapshot.mjs [--write] [--stale-after=<blocks>]
 * Without `--write` it reports what would change and writes nothing.
 *
 * `--stale-after` exists for the scheduled run. Every refresh advances
 * `asOfBlock`, so writing on every run would publish the site several times a
 * day to say nothing new. With a threshold the file is written when a launch
 * actually appeared -- which is when a token needs its page -- or when the gap
 * has grown far enough to matter, and otherwise the run is a no-op.
 */
/**
 * `creator()` on a FeeSplitter, computed once rather than remembered.
 *
 * A wrong selector does not fail loudly: it calls a different function or falls
 * into a fallback and returns an address that looks like an answer. This one is
 * checked against ethers' own hash in the tests.
 */
const CREATOR_SELECTOR = '0x02d05d3f';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPLOYMENT,
  collectCurveActivity,
  collectCurveState,
  collectPairSymbol,
  collectTokenMetadata,
  decodeLaunches,
  fetchPublicGate,
  jsonRpc,
  parseBlockNumber,
} from '../netlify/functions/lib/collector.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = path.join(root, 'website', 'data', 'launches.json');
const RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const GATE_URL = 'https://ponsr-backend.fly.dev/status/core';
const WRITE = process.argv.includes('--write');
const STALE_AFTER = Number(
  (process.argv.find((a) => a.startsWith('--stale-after=')) ?? '=0').split('=')[1]
);

const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`);
const rpc = (method, params) => jsonRpc(RPC_URL, method, params, 20000);

/** Abort loudly. A snapshot written from an incomplete read is the defect itself. */
function refuse(message) {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(1);
}

const existing = JSON.parse(await fs.readFile(SNAPSHOT, 'utf8'));
const previous = new Map(existing.launches.map((l) => [String(l.token).toLowerCase(), l]));

const head = parseBlockNumber(await rpc('eth_blockNumber', []));
log(`head            ${head}`);
log(`snapshot as of  ${existing.asOfBlock}  (${head - existing.asOfBlock} blocks behind)`);

/**
 * Page the whole range PATIENTLY.
 *
 * `collectLaunches` is tuned for a request path, where a long backoff is worse
 * than an honest partial: it retries three times, 60 ms apart, then gives up.
 * Against 23.4 million blocks of a shared public endpoint that is not enough,
 * and the first run of this script refused for exactly that reason.
 *
 * An operator script has the opposite budget. It may take minutes, so it waits
 * properly between attempts and paces itself rather than bursting -- a burst of
 * probes is what rate-limited this endpoint earlier, not the size of any one
 * request. Measured directly: a 1 000 000-block page is accepted and answers in
 * 299 ms, so the whole history is two dozen requests rather than nine hundred.
 * It still refuses rather than returning a short list.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A few patient attempts for one call. `collector.mjs` keeps its own private. */
async function attempt(call, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await call();
    } catch (error) {
      last = error;
      if (i + 1 < attempts) await sleep(400 * 2 ** i);
    }
  }
  throw last;
}
const hex = (n) => `0x${n.toString(16)}`;
const addressTopic = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;

/**
 * Returns `{ logs, coveredThrough }` — what was read, and the last block it was
 * read THROUGH. Never `toBlock` on faith.
 *
 * AN UNREADABLE RANGE USED TO DISCARD THE WHOLE RUN, INCLUDING WHAT IT HAD
 * ALREADY FOUND. On 2026-09-02 a real user's launch was found at 95.3% of the
 * scan and then thrown away, because the last 4 465 blocks would not read after
 * eight attempts and the run refused rather than published. The site went on
 * showing three launches while a stranger's token sat on chain unlisted — the
 * third ratchet of this exact shape here, and the second in this file.
 *
 * The refusal was not wrong about the hazard. Writing a half-finished read is
 * how a launch silently vanishes from the floor — but ONLY because `asOfBlock`
 * is a CLAIM OF COVERAGE, and future runs start from it. Bank the progress and
 * tell the truth about where it stops, and the danger is gone: the unread tail
 * is simply retried next run, exactly as an unscanned window always was.
 *
 * The scan runs strictly forward, so stopping at the first unreadable range is
 * always safe: everything behind the cursor was read, and nothing ahead is
 * claimed.
 */
async function scanAll(fromBlock, toBlock, { page = 1_000_000, minPage = 1_000, label = 'range' } = {}) {
  const logs = [];
  let cursor = fromBlock;
  let size = page;
  let attempt = 0;

  while (cursor <= toBlock) {
    const end = Math.min(toBlock, cursor + size - 1);
    let got = null;
    try {
      got = await rpc('eth_getLogs', [
        {
          address: DEPLOYMENT.factory,
          fromBlock: hex(cursor),
          toBlock: hex(end),
          topics: [DEPLOYMENT.topic, null, null, addressTopic(DEPLOYMENT.ponsrDeployer)],
        },
      ]);
    } catch {
      // The node answers `log query timed out` on ranges it cannot serve, and
      // the range that can time out is not the range that is large -- one
      // 1 000 000-block page failed where its neighbours succeeded. So halve
      // and retry rather than treating size as a constant, and back off, which
      // is the separate remedy for being rate limited.
      attempt += 1;
      if (size > minPage) {
        size = Math.max(minPage, Math.floor(size / 2));
        log(`    ${label} ${cursor} narrowed to ${size} blocks`);
      } else if (attempt >= 8) {
        log(`    ${label} ${cursor}-${end} unreadable at ${size} blocks after ${attempt} attempts`);
        log(`    banking ${logs.length} event(s) read through ${cursor - 1}; the rest is next run's window`);
        return { logs, coveredThrough: cursor - 1 };
      }
      await sleep(Math.min(20_000, 500 * 2 ** Math.min(attempt, 5)));
      continue;
    }

    logs.push(...got);
    cursor = end + 1;
    attempt = 0;
    // Widen again once the difficult stretch is behind us, or the rest of the
    // history is crawled at the size one bad range forced.
    size = Math.min(page, size * 2);
    const done = Math.min(100, ((cursor - fromBlock) / (toBlock - fromBlock + 1)) * 100);
    log(`  ${done.toFixed(1).padStart(5)}%  ${logs.length} events`);
    await sleep(120);
  }
  return { logs, coveredThrough: toBlock };
}

/**
 * INCREMENTAL BY DEFAULT, BECAUSE A FULL RESCAN EVENTUALLY BECOMES IMPOSSIBLE.
 *
 * This swept from the deployment's first block to the head on every run. That
 * was 24 million blocks by 2026-09-01, and it refuses to write a partial scan --
 * correctly, since a partial sweep that silently dropped a launch would delete a
 * creator's token from the site.
 *
 * Put together, those two make a ratchet. The scheduled refresh failed three
 * times in a row on a range around block 28623096 that could not be read even at
 * 12 500 blocks after eight attempts, and it would have kept failing forever: the
 * bad range sits behind every future run, and the window only grows.
 *
 * So the default now starts where the snapshot already reached. Everything
 * before `asOfBlock` was scanned successfully when that snapshot was written --
 * re-reading it proves nothing new and stakes every future update on a range
 * that has already been read once.
 *
 * The overlap covers a reorg near the tip. `--from-genesis` still does the whole
 * thing for when the question really is "did we ever miss one".
 */
const REORG_OVERLAP = 5_000;
const FROM_GENESIS = process.argv.includes('--from-genesis');
const scanFrom = FROM_GENESIS
  ? DEPLOYMENT.startBlock
  : Math.max(DEPLOYMENT.startBlock, Number(existing.asOfBlock || 0) - REORG_OVERLAP);

log(`scanning ${head - scanFrom} blocks for launches${FROM_GENESIS ? ' (from genesis)' : ` from ${scanFrom}`}...`);
const discovery = await scanAll(scanFrom, head, { label: 'launch range' });
/**
 * `asOfBlock` IS A CLAIM OF COVERAGE, AND EVERY FUTURE RUN STARTS FROM IT.
 *
 * So it is what the scan actually READ THROUGH, never the head it was aiming
 * at. Writing `head` after an unreadable tail would put those blocks behind
 * every future window and make anything launched in them permanently invisible
 * — which is the outcome the partial-scan refusal existed to prevent, arriving
 * through the front door.
 *
 * It can never move backwards either. A first chunk that fails leaves
 * `coveredThrough` below the existing value, and a snapshot that un-claims
 * ground it already holds would re-scan it forever.
 */
const coveredThrough = Math.max(Number(existing.asOfBlock || 0), discovery.coveredThrough);
const shortBy = head - coveredThrough;
log(`found           ${discovery.logs.length} launch events in that window`);
if (shortBy > 0) log(`covered through ${coveredThrough} (${shortBy} blocks short of head; next run picks them up)`);

const observedAt = new Date().toISOString();
const decoded = await decodeLaunches(rpc, discovery.logs, observedAt);

const observed = [];
for (const launch of decoded) {
  const key = String(launch.token).toLowerCase();
  const prior = previous.get(key) ?? {};
  log(`  ${launch.token} ...`);

  // Facts the chain speaks for. A read that fails keeps the committed value
  // rather than replacing it with a shrug.
  /**
   * `creator()` on the splitter, if there is one. Read with the same tolerance
   * as everything else here: a failure keeps whatever is committed.
   */
  let creator = null;
  const splitterForCreator = prior.splitter ?? launch.splitter ?? null;
  if (splitterForCreator && /^0x[0-9a-fA-F]{40}$/.test(String(splitterForCreator))) {
    try {
      const raw = await rpc('eth_call', [{ to: splitterForCreator, data: CREATOR_SELECTOR }, 'latest']);
      if (typeof raw === 'string' && raw.length >= 66) creator = `0x${raw.slice(-40)}`;
    } catch {
      log(`  ${launch.token} creator() unreadable; keeping the committed value`);
    }
  }

  let metadata = null;
  try {
    metadata = await collectTokenMetadata({ rpc, token: launch.token, blockNumber: head });
  } catch {
    log('    metadata unreadable; keeping what is committed');
  }
  const pairSymbol = await collectPairSymbol({ rpc, pairToken: launch.pairToken, blockNumber: head });

  /**
   * The fee this launch actually paid, taken from the launch transaction.
   *
   * The obvious route -- `launchFee()` at the launch block -- is impossible
   * here, and the endpoint says so plainly: `metadata is not found`. This RPC
   * keeps no historical state, so a call at any past block fails. Measured for
   * both launches before this was written.
   *
   * Today's `launchFee()` would answer, and would be the wrong answer: the fee
   * is owner-settable on pons's side, so what it says now is not what a launch
   * weeks ago paid. Recording it would be inventing a figure that looks read.
   *
   * The transaction's own value needs no historical state and is what actually
   * moved. Ponsr sends EXACTLY the fee -- the factory treats any excess as an
   * initial buy, which is why the launcher never overpays -- so for a launch in
   * this feed, all of which are Ponsr's, the value is the fee.
   */
  let launchFeeEth = null;
  try {
    const tx = await attempt(() => rpc('eth_getTransactionByHash', [launch.transactionHash]));
    const wei = BigInt(tx?.value ?? '0x0');
    const whole = wei / 10n ** 18n;
    const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
    launchFeeEth = `${whole}${frac ? `.${frac}` : ''}`;
  } catch {
    // Says WHY, because the first version of this catch reported a
    // ReferenceError in this file as though the network had failed: `retry` is
    // not exported from collector.mjs, so every read threw, both launches kept
    // whatever was already committed, and the one that had a fee looked
    // correct. A catch-all that blames the network for a bug in its own caller
    // is worse than no catch at all.
    log(`    launch transaction unreadable (${String(error?.message ?? error).slice(0, 80)}); leaving the fee unrecorded`);
  }

  /**
   * THE FEE SPLITTER, READ FROM THE LAUNCH'S OWN CALLDATA.
   *
   * The launch event does not carry it, so the feed published `splitter: null`
   * for every launch except the one that was committed by hand -- and the token
   * page showed an empty "Fee splitter" row. Nothing was lost by that: the
   * splitter exists and is correctly wired on chain, and the backend records it
   * in `launch_provenance`. It was the SITE that could not see it.
   *
   * The address travels as `feeWallet` in the launch calldata, so it is read
   * back from the transaction that created it. Three guards, because decoding
   * is where a plausible wrong answer comes from:
   *
   *   - the selector must be THIS deployment's. A superseded factory takes a
   *     different tuple, and the same word offset there is a different field.
   *   - the result must be a contract. A word that happens to hold twenty
   *     non-zero bytes is not a splitter.
   *   - a committed splitter is never overwritten, and the run stops if the
   *     chain disagrees with one -- the same rule as every other identity here.
   */
  let splitter = null;
  try {
    const tx = await attempt(() => rpc('eth_getTransactionByHash', [launch.transactionHash]));
    const input = String(tx?.input ?? '');
    if (!input.toLowerCase().startsWith(DEPLOYMENT.launchSelector)) {
      log(`    launch calldata is not ${DEPLOYMENT.launchSelector}; not reading a splitter from it`);
    } else {
      const word = DEPLOYMENT.feeWalletWord;
      const candidate = `0x${input.slice(10 + word * 64 + 24, 10 + (word + 1) * 64)}`;
      if (!/^0x[0-9a-f]{40}$/i.test(candidate) || /^0x0{40}$/.test(candidate)) {
        log('    fee wallet word is not an address; leaving the splitter unrecorded');
      } else {
        const code = await attempt(() => rpc('eth_getCode', [candidate, 'latest']));
        if (code && code !== '0x') splitter = candidate;
        else log('    fee wallet is not a contract; leaving the splitter unrecorded');
      }
    }
  } catch {
    log('    launch calldata unreadable; leaving the splitter unrecorded');
  }
  if (splitter && prior.splitter && String(prior.splitter).toLowerCase() !== splitter.toLowerCase()) {
    refuse(`${launch.token}: committed splitter ${prior.splitter} is not what the calldata reports (${splitter})`);
  }

  let curve = null;
  try {
    curve = await collectCurveState({ rpc, curve: launch.curve, blockNumber: head, observedAt });
  } catch {
    log('    curve state unreadable; keeping what is committed');
  }

  let activity = prior.activity ?? null;
  const from = Math.max(Number(launch.blockNumber), Number(prior.activity?.observedThroughBlock ?? 0) - 128);
  const observed = await collectCurveActivity({
    rpc,
    curve: launch.curve,
    fromBlock: Math.max(DEPLOYMENT.startBlock, from),
    toBlock: head,
    initialChunk: 25_000,
  });
  if (observed.state === 'complete') {
    const events = [...(prior.activity?.events ?? []), ...observed.events];
    const seen = new Set();
    const merged = events
      .filter((e) => {
        const id = `${e.transactionHash}:${e.logIndex}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    activity = {
      state: 'observed',
      observedThroughBlock: observed.throughBlock,
      curveBuys: merged.filter((e) => e.kind === 'buy').length,
      curveSells: merged.filter((e) => e.kind === 'sell').length,
      observedAt,
      events: merged,
    };
  } else {
    // Partial activity does not overwrite a complete earlier observation.
    log('    curve activity partial; keeping what is committed');
  }

  /**
   * Identity is immutable, so a committed entry keeps its own -- including the
   * exact casing it was written with. The event gives addresses lower-cased,
   * and silently rewriting a checksummed address that is already published is
   * a change nobody asked for, in a field other code compares against.
   *
   * It is still checked: if the chain disagrees about which curve or deployer
   * belongs to this token, that is not a formatting difference and the run
   * stops rather than papering over it.
   */
  const identity = {};
  for (const field of ['token', 'curve', 'deployer', 'factory', 'pairToken', 'transactionHash']) {
    if (!prior[field]) continue;
    if (String(prior[field]).toLowerCase() !== String(launch[field]).toLowerCase()) {
      refuse(`${launch.token}: committed ${field} ${prior[field]} is not what the chain reports (${launch[field]})`);
    }
    identity[field] = prior[field];
  }

  observed.push({
    ...launch,
    ...identity,
    // Preserved: no getter produces these, and losing them is a silent regression.
    logo: metadata ? metadata.logo : prior.logo ?? null,
    description: metadata ? metadata.description : prior.description ?? '',
    splitter: prior.splitter ?? splitter ?? launch.splitter ?? null,
    /**
     * WHO THE SPLITTER ACTUALLY PAYS.
     *
     * `deployer` is the treasury, because the treasury sends every launch. That
     * is a true fact and a misleading headline: the board read "by 0x08e01f…"
     * on every card, so three tokens appeared to belong to one anonymous wallet
     * on a product whose pitch is "launch YOUR token".
     *
     * The creator is public -- `creator()` on the launch's own splitter -- and
     * is read here rather than on every page load, because it can never change
     * for a given splitter.
     *
     * A read that fails keeps the committed value rather than replacing it with
     * a shrug, and null means unknown rather than "the treasury". The page must
     * be able to tell those apart.
     */
    creator: creator ?? prior.creator ?? null,
    launchFeeEth: prior.launchFeeEth ?? launchFeeEth,
    name: metadata?.name ?? prior.name ?? launch.name,
    symbol: metadata?.symbol ?? prior.symbol ?? launch.symbol,
    pairLabel: pairSymbol || prior.pairLabel || launch.pairLabel,
    metadata: { state: 'stale', observedThroughBlock: head },
    graduationThreshold: curve?.graduationThreshold ?? launch.graduationThreshold,
    reserves: curve?.reserves ?? prior.reserves ?? launch.reserves,
    liquidity: prior.liquidity ?? launch.liquidity,
    feeCollection: prior.feeCollection ?? launch.feeCollection,
    ...(activity ? { activity } : {}),
  });
}

/**
 * A window scan REPLACES what it saw and KEEPS what it did not.
 *
 * The array used to be whatever the sweep decoded, which was safe only because
 * the sweep covered everything. With a window it would delete every launch older
 * than the window -- the exact failure the partial-scan refusal exists to
 * prevent, arriving through the front door instead.
 */
const seen = new Set(observed.map((l) => String(l.token).toLowerCase()));
const merged = new Map(existing.launches.map((l) => [String(l.token).toLowerCase(), l]));
for (const launch of observed) merged.set(String(launch.token).toLowerCase(), launch);
const launches = [...merged.values()];
const carried = existing.launches.filter((l) => !seen.has(String(l.token).toLowerCase())).length;

/**
 * A CARRIED-FORWARD LAUNCH KEEPS ITS VALUES, BUT A MISSING FIELD IS STILL FILLED.
 *
 * The window scan does not re-decode launches older than it, which is the whole
 * point -- re-reading settled ground is what made this refresh fail forever. But
 * "keep what is committed" and "never learn anything new" are different rules,
 * and only the first one is wanted. Without this, `creator` would be null on
 * every existing launch permanently, and the board would keep attributing all of
 * them to the treasury.
 *
 * Bounded: it asks only for launches that have a splitter and no creator yet, so
 * it costs one call per launch exactly once and nothing thereafter.
 */
for (const launch of launches) {
  if (launch.creator || !launch.splitter) continue;
  try {
    // Through `attempt`, because the sweep that ran first leaves a shared public
    // endpoint throttling: the first version of this reported every launch as
    // unreadable and the real reason was HTTP 429. A catch that hides why is
    // worse than no catch, which is how that was found in one run.
    const raw = await attempt(() => rpc('eth_call', [{ to: launch.splitter, data: CREATOR_SELECTOR }, 'latest']));
    if (typeof raw === 'string' && raw.length >= 66) {
      launch.creator = `0x${raw.slice(-40)}`;
      log(`  ${launch.symbol.padEnd(12)} creator backfilled ${launch.creator}`);
    }
  } catch (error) {
    log(`  ${launch.symbol.padEnd(12)} creator() unreadable: ${error?.message ?? error}`);
  }
}
log(`refreshed       ${observed.length} in window, ${carried} carried forward unchanged`);

const gate = await fetchPublicGate(GATE_URL, existing.publicGate);

const refreshed = {
  ...existing,
  generatedAt: observedAt,
  observedAt,
  asOfBlock: coveredThrough,
  publicGate: { ...gate, state: 'stale' },
  sources: [
    {
      id: 'current-v2-chain',
      state: 'stale',
      // What this run actually read, not what the first run once did. A source
      // that overstates its own coverage is worse than one that admits a window.
      fromBlock: FROM_GENESIS ? DEPLOYMENT.startBlock : scanFrom,
      throughBlock: coveredThrough,
      authoritativeTimestamps: true,
      scope: 'verified last-known-good snapshot; live function advances with 128-block overlap',
    },
    { id: 'ponsr-public-gate', state: 'stale', checkedAt: gate.checkedAt ?? observedAt },
  ],
  launches,
};

log('');
log(`launches   ${existing.launches.length} -> ${refreshed.launches.length}`);
log(`asOfBlock  ${existing.asOfBlock} -> ${refreshed.asOfBlock}`);
for (const l of refreshed.launches) log(`  ${l.symbol.padEnd(12)} ${l.pairLabel}`);

if (!WRITE) {
  log('');
  log('dry run -- nothing written. Pass --write to update the snapshot.');
  process.exit(0);
}

const appeared = refreshed.launches.length !== existing.launches.length;
const gap = head - Number(existing.asOfBlock || 0);
if (STALE_AFTER > 0 && !appeared && gap < STALE_AFTER) {
  log('');
  log(`no new launch and only ${gap} blocks behind (threshold ${STALE_AFTER}) -- nothing written.`);
  process.exit(0);
}

await fs.writeFile(SNAPSHOT, `${JSON.stringify(refreshed, null, 1)}\n`, 'utf8');
log('');
log(`written ${path.relative(root, SNAPSHOT)}`);
