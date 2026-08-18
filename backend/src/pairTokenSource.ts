import { ethers } from 'ethers';
import { ApprovalEvent, PairTokenSource } from './pairTokens';
import v2FactoryAbi from './abi/ponsV2LaunchFactory.json';

/**
 * The chain-backed implementation of `PairTokenSource`.
 *
 * Kept apart from `pairTokens.ts` for the reason the rest of this codebase does it:
 * the decision logic -- which approval wins, what a near miss resolves to, when to
 * refuse -- is the part worth testing exhaustively, and it should not need a node
 * to run. This file is the thin part that talks to one.
 */

export const PONS_V2_FACTORY_ABI = v2FactoryAbi as ethers.InterfaceAbi;

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
  factoryAddress: string;
  /** Lowest block to scan. Below the factory's deployment there is nothing to find. */
  fromBlock?: number;
  chunkSize?: number;
}

export class ChainPairTokenSource implements PairTokenSource {
  private factory: ethers.Contract;

  constructor(private opts: ChainPairTokenSourceOptions) {
    this.factory = new ethers.Contract(opts.factoryAddress, PONS_V2_FACTORY_ABI, opts.provider);
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
    const from = this.scannedTo !== null ? this.scannedTo + 1 : this.opts.fromBlock ?? 0;
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
    return this.seen;
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
