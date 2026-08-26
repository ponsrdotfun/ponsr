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
 *
 * WHAT THE CACHE IS KEYED ON, AND WHY THAT IS NOT A DETAIL
 * -------------------------------------------------------
 * A cached PASS is a claim about ONE contract as seen through ONE endpoint. The first
 * version of this cache was keyed on nothing at all, which was a real defect rather than a
 * tidiness point: the read pool can fail over between requests, so a pass measured through
 * the primary could be reported while a fallback was the endpoint actually answering. The
 * page would have said "matches the registry" about a node it had never asked.
 *
 * So the key binds every input the answer depends on -- chain id, deployment id, factory
 * address, the expected runtime hash, and the fingerprint of the endpoint that produced it.
 * Any of them changing invalidates the entry rather than reusing it, because a pass earned
 * under different inputs is not evidence about these ones.
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
  /**
   * The cache key the held result was measured under -- chain, deployment, factory,
   * expected runtime hash and endpoint fingerprint.
   *
   * Published so a reader can see WHICH endpoint produced a remembered pass, rather than
   * having to trust that it was this one.
   */
  measuredThrough?: string | null;
}

export const DEFAULT_IDENTITY_TTL_MS = 10 * 60 * 1000;

/**
 * Everything a cached PASS is a claim about. Change any of it and the entry is stale.
 *
 * The endpoint fingerprint is the one that is easiest to leave out and the one that matters
 * most here, because the read path can fail over between two status requests.
 */
export function identityCacheKey(d: PonsDeployment, endpointFingerprint: string): string {
  return [
    d.chainId,
    d.id,
    d.factory.toLowerCase(),
    d.runtimeBytecodeSha256.toLowerCase(),
    endpointFingerprint,
  ].join('|');
}

export class IdentityWatch {
  private cached: IdentityResult | null = null;
  private checkedAt: Date | null = null;
  private cachedKey: string | null = null;
  /**
   * One in-flight probe PER KEY, not one in total.
   *
   * A single mutable slot loses work under interleaving: A starts, B starts and overwrites
   * the slot, A finishes and its `finally` clears B's entry, and a third caller for B then
   * starts a duplicate download of the same 48 KB. A map keyed the same way as the cache
   * cannot do that, and each completion deletes only its own key.
   */
  private readonly inFlight = new Map<string, Promise<IdentityStatus>>();

  constructor(
    private readonly deployment: PonsDeployment = executableDeployment(),
    private readonly ttlMs: number = DEFAULT_IDENTITY_TTL_MS,
    private readonly now: () => Date = () => new Date()
  ) {}

  private status(fromCache: boolean, unreadable?: string): IdentityStatus {
    const ageMs = this.checkedAt ? this.now().getTime() - this.checkedAt.getTime() : null;
    return {
      result: this.cached,
      checkedAt: this.checkedAt,
      ageMs,
      fromCache,
      unreadable,
      measuredThrough: this.cachedKey,
    };
  }

  private fresh(key: string): boolean {
    if (!this.cached || !this.checkedAt) return false;
    // A pass earned through a different endpoint, chain or deployment is not evidence
    // about this one. Re-read rather than reuse.
    if (this.cachedKey !== key) return false;
    // A mismatch is never fresh. Holding one would mean a drift keeps being reported from
    // memory after it is fixed, and -- worse -- that a real one was measured once and then
    // repeated rather than re-confirmed.
    if (!this.cached.ok) return false;
    return this.now().getTime() - this.checkedAt.getTime() < this.ttlMs;
  }

  /**
   * @param endpointFingerprint identity of the endpoint answering this call, from
   *        `rpcIdentity`. Required, not optional: an optional binding is one a caller
   *        forgets, and forgetting it is exactly the defect this parameter exists to close.
   */
  async check(provider: ethers.Provider, endpointFingerprint: string): Promise<IdentityStatus> {
    const key = identityCacheKey(this.deployment, endpointFingerprint);
    if (this.fresh(key)) return this.status(true);
    // Concurrent status requests must not each start their own 48 KB download. Without
    // this, the cache removes the cost for one caller and multiplies it for ten. Shared
    // only among callers asking the SAME question -- a request that failed over to another
    // endpoint must not be handed an answer measured through the first one.
    const running = this.inFlight.get(key);
    if (running) return running;

    const probe = (async () => {
      try {
        const result = await verifyDeploymentIdentity(this.deployment, provider);
        this.cached = result;
        this.checkedAt = this.now();
        this.cachedKey = key;
        return this.status(false);
      } catch (err: any) {
        // Could not ASK. The previous verdict stands with its real age, and the reason is
        // reported separately -- a failure to ask is not a mismatch, and reporting it as
        // one sends an operator hunting a contract upgrade that never happened.
        return this.status(true, String(err?.shortMessage ?? err?.message ?? err).slice(0, 120));
      } finally {
        // Only this key. Clearing a shared slot is how one probe's completion cancelled
        // another's de-duplication.
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, probe);
    return probe;
  }

  /** Forces the next `check` to read the chain. For tests and for an operator command. */
  invalidate(): void {
    this.cached = null;
    this.checkedAt = null;
    this.cachedKey = null;
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
