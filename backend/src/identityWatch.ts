import { ethers } from 'ethers';
import { PonsDeployment, executableDeployment } from './deployments';
import { IdentityResult, verifyDeploymentIdentity } from './deploymentIdentity';

/**
 * The deployment-identity check, on its own budget and its own cadence.
 *
 * WHY IT IS NOT ON THE STATUS HOT PATH ANY MORE
 * ---------------------------------------------
 * `verifyDeploymentIdentity` downloads the factory's runtime bytecode -- 24 177 bytes,
 * about 48 KB as hex -- and then reads `feeEscrow()` on a second round trip. It ran on
 * every `/status` request, inside the same 5 000 ms deadline as the launch-permission
 * reads, and it ran FIRST. So the most expensive question in the check had to finish
 * before the cheapest one started, and when it did not, the page published
 * `launchpad: down`: a statement about pons's launchpad produced by a slow file transfer.
 *
 * WHY IT IS STILL ASKED AT ALL
 * ----------------------------
 * Because the registry's hashes are the only thing that can tell the current factory from
 * the superseded one, and this project lost a week to exactly that -- an address that
 * resolved, answered calls, and was confidently wrong. Dropping the check to make a status
 * page fast would be trading the one guard that catches the failure this migration exists
 * to prevent, for a green tick.
 *
 * WHAT THE CACHE IS AND IS NOT
 * ----------------------------
 * Runtime bytecode at a fixed address changes only if the contract is replaced, which is
 * not a per-request event. Re-downloading 48 KB every time someone loads a status page
 * measures nothing new. So the answer is cached with a TTL and the page reports HOW OLD it
 * is, because a cached pass and a fresh pass are not the same claim.
 *
 * Three rules keep the cache from becoming a way to be wrong quietly:
 *
 *   - only a PASS is cached. A mismatch is never held: it re-reads every time, so a
 *     recovery is noticed immediately and a real drift is never answered from memory.
 *   - a failure to READ is not cached either, and is not a pass. An unreachable RPC leaves
 *     the previous verdict standing with its true age, and the age is what the page shows.
 *   - the age is always published. A caller that cannot see staleness cannot judge it.
 *
 * This is a REPORT, not a control. `assertDeploymentIdentity` still runs uncached on the
 * launch path, before a splitter is deployed and before a fee is spent, and it still
 * throws. Nothing about spending money reads this cache.
 */

export interface IdentityStatus {
  /** Null before the first successful read -- distinct from a mismatch. */
  result: IdentityResult | null;
  /** When `result` was actually measured. Null when nothing has been measured yet. */
  checkedAt: Date | null;
  ageMs: number | null;
  /** True when the value came from cache rather than from this call. */
  fromCache: boolean;
  /** Set when the most recent attempt could not read the chain. Never a mismatch. */
  unreadable?: string;
}

export const DEFAULT_IDENTITY_TTL_MS = 10 * 60 * 1000;

export class IdentityWatch {
  private cached: IdentityResult | null = null;
  private checkedAt: Date | null = null;
  private inFlight: Promise<IdentityStatus> | null = null;

  constructor(
    private readonly deployment: PonsDeployment = executableDeployment(),
    private readonly ttlMs: number = DEFAULT_IDENTITY_TTL_MS,
    private readonly now: () => Date = () => new Date()
  ) {}

  private status(fromCache: boolean, unreadable?: string): IdentityStatus {
    const ageMs = this.checkedAt ? this.now().getTime() - this.checkedAt.getTime() : null;
    return { result: this.cached, checkedAt: this.checkedAt, ageMs, fromCache, unreadable };
  }

  private fresh(): boolean {
    if (!this.cached || !this.checkedAt) return false;
    // A mismatch is never fresh. Holding one would mean a drift keeps being reported from
    // memory after it is fixed, and -- worse -- that a real one was measured once and then
    // repeated rather than re-confirmed.
    if (!this.cached.ok) return false;
    return this.now().getTime() - this.checkedAt.getTime() < this.ttlMs;
  }

  async check(provider: ethers.Provider): Promise<IdentityStatus> {
    if (this.fresh()) return this.status(true);
    // Concurrent status requests must not each start their own 48 KB download. Without
    // this, the cache removes the cost for one caller and multiplies it for ten.
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      try {
        const result = await verifyDeploymentIdentity(this.deployment, provider);
        this.cached = result;
        this.checkedAt = this.now();
        return this.status(false);
      } catch (err: any) {
        // Could not ASK. The previous verdict stands with its real age, and the reason is
        // reported separately -- a failure to ask is not a mismatch, and reporting it as
        // one sends an operator hunting a contract upgrade that never happened.
        return this.status(true, String(err?.shortMessage ?? err?.message ?? err).slice(0, 120));
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** Forces the next `check` to read the chain. For tests and for an operator command. */
  invalidate(): void {
    this.cached = null;
    this.checkedAt = null;
  }
}

/** One line for a status page. Says plainly when the answer is remembered rather than measured. */
export function summariseIdentity(s: IdentityStatus): string {
  if (!s.result && s.unreadable) return `never verified; last attempt failed: ${s.unreadable}`;
  if (!s.result) return 'not verified yet';
  const age = s.ageMs === null ? 'unknown age' : `${Math.round(s.ageMs / 1000)}s ago`;
  const how = s.fromCache ? `cached, measured ${age}` : `measured just now`;
  const head = s.result.ok
    ? `matches the registry (${how})`
    : `DOES NOT match the registry (${how}) -- ${s.result.mismatches.join('; ')}`;
  return s.unreadable ? `${head}; latest attempt failed: ${s.unreadable}` : head;
}
