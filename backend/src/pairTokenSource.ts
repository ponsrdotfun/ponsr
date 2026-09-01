import { ethers } from 'ethers';
import { ApprovalEvent, PairTokenSource } from './pairTokens';
import { executableDeployment } from './deployments';

/**
 * The chain-backed implementation of `PairTokenSource`.
 *
 * Kept apart from `pairTokens.ts` for the reason the rest of this codebase does it:
 * the decision logic -- which approval wins, what a near miss resolves to, when to
 * refuse -- is the part worth testing exhaustively, and it should not need a node
 * to run. This file is the thin part that talks to one.
 */

/**
 * The ABI of the deployment being scanned, loaded from the registry.
 *
 * This used to be a module-level import of `abi/ponsV2LaunchFactory.json` -- the
 * SUPERSEDED deployment's artifact. The ADDRESS passed in had been the current factory
 * since the registry landed, so every address check passed while the decoding came from
 * somewhere else entirely. An import is invisible to a check that only looks at
 * addresses.
 *
 * It worked, which is the uncomfortable part: `PairTokenApprovalUpdated` and
 * `PairTokenEconomicsUpdated` are byte-identical across both deployments -- verified,
 * not assumed. pons has already changed `TokenParams` between these two factories
 * though, and an approval event is no more permanent than that was. The failure when it
 * stops being true is a silently mis-decoded approval, not an error.
 */
export function pairFactoryAbi(deployment = executableDeployment()): ethers.InterfaceAbi {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(`./${deployment.abiPath}`) as ethers.InterfaceAbi;
}

const ERC20_METADATA_ABI = [
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
];

/**
 * How wide a single `eth_getLogs` window may be.
 *
 * The approvals were granted around block 23.58M against a head past 39M, so a scan
 * covers millions of blocks and providers cap the span of one request -- hence the
 * chunking.
 *
 * Measured against this RPC on 2026-08-19: a 2,000,000-block window returns in 0.5s.
 *  The original 100,000 was a guess made without asking, and it turned a nine-request
 *  scan into a hundred and sixty-five -- 56 seconds, which is long enough that the
 *  status page timed out on it and the first person to ask for a stock pairing would
 *  have waited a minute. Kept below the measured ceiling rather than at it, so a
 *  tightening on their side degrades speed instead of breaking the scan. */
const DEFAULT_CHUNK = 1_000_000;

export interface ChainPairTokenSourceOptions {
  provider: ethers.Provider;
  /**
   * Which deployment is being scanned. This is the identity; everything else follows.
   *
   * It used to take `factoryAddress` as the primary input with `deployment` as an
   * optional extra used only to pick the ABI -- two independent ways to say which
   * contract, and nothing checking they agreed. An address from one deployment decoded
   * with another's ABI would have passed silently, every field individually plausible
   * and the combination describing no real contract.
   */
  deployment?: import('./deployments').PonsDeployment;
  /**
   * Optional, and asserted against the deployment rather than trusted.
   *
   * Kept only so existing callers that pass an address keep working; when both are
   * given they must name the same contract.
   */
  factoryAddress?: string;
  /** Lowest block to scan. Below the factory's deployment there is nothing to find. */
  fromBlock?: number;
  chunkSize?: number;
  /**
   * Where the scan watermark survives a restart.
   *
   * The scan is already incremental WITHIN a process -- `scannedTo` means the
   * second call reads only new blocks. Across a restart it was not, so every
   * deploy swept from the deployment's first block to the head again: 25 million
   * blocks by 2026-09-01, in 1 000 000-block windows, against a shared public
   * endpoint. Measured over ten hours of retained logs, boot discovery failed
   * twice and succeeded twice -- and the sweep only gets longer.
   *
   * The same defect in three places on one day: this, the launchpad watch's
   * `closed` flag, and the snapshot refresh. In-memory state that has to outlive
   * the process is not state, it is a cache with an opinion.
   */
  store?: { get(key: string): string | null; set(key: string, value: string): void };
  storeKey?: string;
}

export class ChainPairTokenSource implements PairTokenSource {
  private factory: ethers.Contract;

  /** The deployment this scanner reads, resolved once. */
  readonly deployment: import('./deployments').PonsDeployment;
  readonly factoryAddress: string;
  readonly fromBlock: number;

  private hydrated = false;
  /** Keyed by deployment: two deployments' approval histories are not the same list. */
  private get storeKey(): string {
    return this.opts.storeKey ?? `pair-approvals:${this.deployment.id}`;
  }

  constructor(private opts: ChainPairTokenSourceOptions) {
    this.deployment = opts.deployment ?? executableDeployment();

    // If a caller supplies both, they must agree. Silently preferring one would make the
    // other a decoration that looks load-bearing.
    if (
      opts.factoryAddress &&
      opts.factoryAddress.toLowerCase() !== this.deployment.factory.toLowerCase()
    ) {
      throw new Error(
        `pair scanner was given factory ${opts.factoryAddress} but deployment ` +
          `${this.deployment.id} is ${this.deployment.factory}. Refusing: an address from one ` +
          "deployment decoded with another's ABI is how a superseded contract gets read as current."
      );
    }

    this.factoryAddress = this.deployment.factory;
    // The deployment's own start block, not a separately configurable number that can
    // drift below it (scanning nothing) or above it (silently missing approvals).
    // An override may scan MORE history, never less.
    //
    // Above the deployment's start block, approvals granted earlier are silently absent
    // -- which looks exactly like pons never having granted them, so the bot refuses an
    // asset pons does support and the refusal is indistinguishable from a correct one.
    // Below it merely costs time: empty blocks scanned for nothing.
    if (opts.fromBlock !== undefined && opts.fromBlock > this.deployment.startBlock) {
      throw new Error(
        `pair scanner was told to start at block ${opts.fromBlock}, after ${this.deployment.id} ` +
          `began at ${this.deployment.startBlock}. Approvals before that would be invisible, ` +
          'and an invisible approval is indistinguishable from one pons never granted.'
      );
    }
    this.fromBlock = opts.fromBlock ?? this.deployment.startBlock;

    this.factory = new ethers.Contract(
      this.factoryAddress,
      pairFactoryAbi(this.deployment),
      opts.provider
    );
  }

  /** Events already scanned, and the block they were scanned up to.
   *
   *  Even at a million blocks a window, a full scan is ~17 requests to re-learn facts
   *  that have not changed since 1 August. Events are immutable once mined, so a
   *  refresh only needs the blocks it has not seen -- which after the first pass is
   *  usually none at all. */
  private seen: ApprovalEvent[] = [];
  private scannedTo: number | null = null;

  async approvalHistory(): Promise<ApprovalEvent[]> {
    const head = await this.opts.provider.getBlockNumber();
    // this.fromBlock, resolved once in the constructor from the deployment. Reading
    // opts.fromBlock again here meant a scanner constructed from a deployment alone
    // started at block 0 and swept millions of empty blocks.
    this.hydrate();
    const from = this.scannedTo !== null ? this.scannedTo + 1 : this.fromBlock;
    const chunk = this.opts.chunkSize ?? DEFAULT_CHUNK;
    const filter = this.factory.filters.PairTokenApprovalUpdated();

    if (from > head) return this.seen;

    const out: ApprovalEvent[] = [];
    for (let lo = from; lo <= head; lo += chunk) {
      const hi = Math.min(head, lo + chunk - 1);
      let logs: (ethers.Log | ethers.EventLog)[];
      try {
        logs = await this.factory.queryFilter(filter, lo, hi);
      } catch (err) {
        // One refused window must not silently shorten the history: an approval
        // missed here becomes an asset the bot quietly refuses to offer, which is
        // indistinguishable from pons never having approved it.
        throw new Error(
          `could not read approvals for blocks ${lo}-${hi}: ${(err as Error)?.message ?? err}`
        );
      }
      for (const log of logs) {
        const args = (log as ethers.EventLog).args;
        if (!args) continue;
        out.push({
          pairToken: String(args[0]),
          approved: Boolean(args[1]),
          blockNumber: log.blockNumber,
          logIndex: log.index,
        });
      }
    }

    // Only advanced once the whole range came back: a partial scan recorded as
    // complete would skip the missing window forever, and the asset approved in it
    // would be refused for as long as the process lives.
    this.seen = this.seen.concat(out);
    this.scannedTo = head;
    this.persist();
    return this.seen;
  }

  /**
   * Loads the watermark once, and only if it is coherent.
   *
   * A stored blob that cannot be parsed, or that claims to have scanned below
   * the deployment's own first block, is discarded rather than trusted -- a
   * corrupt watermark would skip the window it claims to have read, and an
   * approval missed there becomes an asset the bot quietly refuses to offer.
   * Starting over is slow; starting from a lie is wrong.
   */
  private hydrate(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    const store = this.opts.store;
    if (!store) return;
    try {
      const raw = store.get(this.storeKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { scannedTo?: unknown; seen?: unknown };
      const scannedTo = Number(parsed.scannedTo);
      if (!Number.isInteger(scannedTo) || scannedTo < this.fromBlock) return;
      if (!Array.isArray(parsed.seen)) return;
      const seen = parsed.seen.filter(
        (e: any) =>
          e && typeof e.pairToken === 'string' && typeof e.approved === 'boolean' &&
          Number.isInteger(e.blockNumber) && Number.isInteger(e.logIndex)
      ) as ApprovalEvent[];
      if (seen.length !== parsed.seen.length) return;
      this.scannedTo = scannedTo;
      this.seen = seen;
    } catch {
      // An unreadable memo costs one full sweep, which is what happened every
      // time before this existed.
    }
  }

  private persist(): void {
    try {
      this.opts.store?.set(this.storeKey, JSON.stringify({ scannedTo: this.scannedTo, seen: this.seen }));
    } catch (err) {
      console.error('[pairTokens] could not persist the scan watermark:', (err as Error)?.message ?? err);
    }
  }

  async tokenMeta(address: string): Promise<{ symbol: string; name: string; decimals: number }> {
    const t = new ethers.Contract(address, ERC20_METADATA_ABI, this.opts.provider);
    const [symbol, name, decimals] = await Promise.all([t.symbol(), t.name(), t.decimals()]);
    return { symbol: String(symbol), name: String(name), decimals: Number(decimals) };
  }

  async economics(address: string): Promise<{ graduationThreshold: bigint; decimals: number }> {
    const e = await this.factory.pairTokenEconomics(address);
    return { graduationThreshold: BigInt(e.graduationThreshold), decimals: Number(e.decimals) };
  }

  async isApproved(address: string): Promise<boolean> {
    return Boolean(await this.factory.approvedPairTokens(address));
  }
}
