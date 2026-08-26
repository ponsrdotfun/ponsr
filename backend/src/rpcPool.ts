import { ethers } from 'ethers';
import { PonsDeployment, executableDeployment } from './deployments';
import { RpcEndpointDescription, describeRpcEndpoint, isIdentified } from './rpcIdentity';

/**
 * More than one RPC endpoint, with the failover BOUNDED and every candidate proven to be
 * the same chain and the same factory before it is allowed to answer anything.
 *
 * WHY A FALLBACK AT ALL
 * ---------------------
 * The backend and the canary both read a single public endpoint. When it slows down there
 * is no second opinion, and the whole launch path stalls behind one host that nobody at
 * Ponsr operates.
 *
 * WHY A FALLBACK IS ALSO DANGEROUS, AND WHAT THAT COSTS HERE
 * ----------------------------------------------------------
 * A naive fallback is strictly worse than no fallback. `ethers.FallbackProvider` and every
 * hand-rolled "try the next URL" loop share one assumption: that the endpoints are
 * interchangeable. If the second URL is testnet, or a fork, or an archive node lagging by
 * an hour, the bot does not stop -- it keeps going against a different world, and every
 * guard in this repository returns a confident answer about somewhere else.
 *
 * That is not hypothetical here. `backend/.env` points at testnet by design while the
 * executable deployment is a mainnet contract, so the single most likely thing to end up
 * in a fallback slot is the testnet URL that is already sitting in the file. On testnet
 * the factory address holds no contract at all, `launchEnabled` reverts, and a launch
 * would be built for a chain the treasury has no funds on.
 *
 * So an endpoint is ADMITTED before it is used, never after:
 *
 *   chain id         must equal the deployment's chain. A different chain is a different
 *                    world, and the same address on it is a different contract.
 *   factory bytecode must hash to the registry's `runtimeBytecodeSha256`. This is the axis
 *                    that catches a fork, a stale archive node, and an endpoint that is
 *                    technically the right chain but serving a superseded state.
 *
 * An endpoint that fails admission is not "tried anyway with a warning". It is refused for
 * this process, and the refusal is reported. A fallback that can silently be wrong offers
 * availability by giving up correctness, which is the wrong trade for a component that
 * spends money.
 *
 * WHY BOUNDED
 * -----------
 * Failover is capped at the number of configured endpoints, tried at most once each, per
 * operation. There is no retry loop and no backoff schedule, deliberately: the caller here
 * is a status check with a deadline, and an unbounded retry inside a bounded deadline just
 * spends the whole budget failing more times. If every endpoint is refused or exhausted,
 * that is an answer -- `down` -- and it is returned rather than waited on.
 */

export interface EndpointAdmission {
  identity: RpcEndpointDescription;
  admitted: boolean;
  /** Present when refused, naming the axis that disagreed. */
  refusedBecause?: string;
  observedChainId?: number;
  /** Round-trip cost of the admission probe, which doubles as a first latency sample. */
  probeMs: number;
}

export interface PoolStatus {
  endpoints: EndpointAdmission[];
  /** Index into `endpoints` of the one currently answering, or null when none is usable. */
  activeIndex: number | null;
}

/**
 * Splits the configured endpoint list.
 *
 * Kept pure and exported so the parsing is testable without a network: a trailing comma or
 * a stray space silently producing an empty endpoint is exactly the kind of thing that
 * shows up as a mysterious failover at three in the morning.
 */
export function parseEndpointList(primary: string, fallbacks?: string | null): string[] {
  const extra = String(fallbacks ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const all = [String(primary ?? '').trim(), ...extra].filter(Boolean);
  // De-duplicated: listing the same host twice buys no resilience and doubles the
  // admission cost, while making the pool look twice as redundant as it is.
  return [...new Set(all)];
}

export interface RpcPoolOptions {
  deployment?: PonsDeployment;
  /** Bound on a single admission probe. Separate from the caller's own deadline. */
  admissionTimeoutMs?: number;
  /** Injected so tests do not need a chain. */
  makeProvider?: (url: string, chainId: number) => ethers.JsonRpcProvider;
}

async function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class RpcPool {
  private readonly deployment: PonsDeployment;
  private readonly admissionTimeoutMs: number;
  private readonly makeProvider: (url: string, chainId: number) => ethers.JsonRpcProvider;
  private readonly providers: Array<ethers.JsonRpcProvider | null>;
  private readonly admissions: Array<EndpointAdmission | null>;
  private active: number | null = null;

  constructor(
    private readonly urls: string[],
    options: RpcPoolOptions = {}
  ) {
    this.deployment = options.deployment ?? executableDeployment();
    this.admissionTimeoutMs = options.admissionTimeoutMs ?? 4000;
    this.makeProvider =
      options.makeProvider ??
      ((url, chainId) => new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true }));
    this.providers = urls.map(() => null);
    this.admissions = urls.map(() => null);
  }

  /**
   * Proves one endpoint is the chain and the factory the registry describes.
   *
   * Both reads go in one batch. An admission probe that costs two round trips would make
   * adding a fallback measurably slower on the happy path, which is a good way to ensure
   * nobody ever configures one.
   */
  private async admit(index: number): Promise<EndpointAdmission> {
    const existing = this.admissions[index];
    if (existing) return existing;

    const url = this.urls[index];
    const identity = describeRpcEndpoint(url);
    const started = Date.now();

    const refuse = (why: string, observedChainId?: number): EndpointAdmission => {
      const a: EndpointAdmission = {
        identity,
        admitted: false,
        refusedBecause: why,
        observedChainId,
        probeMs: Date.now() - started,
      };
      this.admissions[index] = a;
      return a;
    };

    if (!isIdentified(identity)) return refuse(identity.problem);

    let provider: ethers.JsonRpcProvider;
    try {
      provider = this.makeProvider(url, this.deployment.chainId);
    } catch (err: any) {
      return refuse(`provider could not be constructed: ${String(err?.message ?? err).slice(0, 80)}`);
    }

    try {
      const [network, code] = await within(
        Promise.all([provider.getNetwork(), provider.getCode(this.deployment.factory)]),
        this.admissionTimeoutMs,
        `admission probe for ${identity.origin}`
      );

      const observed = Number(network.chainId);
      if (observed !== this.deployment.chainId) {
        return refuse(
          `chain id is ${observed}, but ${this.deployment.id} is on ${this.deployment.chainId}`,
          observed
        );
      }
      if (!code || code === '0x') {
        return refuse(
          `no contract at ${this.deployment.factory} -- this endpoint does not serve ${this.deployment.id}`,
          observed
        );
      }
      const hash = ethers.sha256(code).slice(2);
      if (hash.toLowerCase() !== this.deployment.runtimeBytecodeSha256.toLowerCase()) {
        return refuse(
          `the factory's runtime bytecode hashes to ${hash.slice(0, 16)}..., but the registry ` +
            `records ${this.deployment.runtimeBytecodeSha256.slice(0, 16)}... for ${this.deployment.id}`,
          observed
        );
      }

      this.providers[index] = provider;
      const a: EndpointAdmission = {
        identity,
        admitted: true,
        observedChainId: observed,
        probeMs: Date.now() - started,
      };
      this.admissions[index] = a;
      return a;
    } catch (err: any) {
      // Unreachable is refused for now but NOT remembered: an endpoint that was down at
      // boot must be able to come back without a restart, whereas a wrong chain is a
      // permanent property and stays refused.
      const a: EndpointAdmission = {
        identity,
        admitted: false,
        refusedBecause: `could not be probed: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 100)}`,
        probeMs: Date.now() - started,
      };
      return a;
    }
  }

  /**
   * Runs `op` against the first endpoint that answers, trying each at most once.
   *
   * The bound is the point: at most `urls.length` attempts, no retries within an endpoint,
   * no backoff. A caller with a deadline gets an answer or a refusal inside it.
   */
  async run<T>(op: (provider: ethers.JsonRpcProvider) => Promise<T>): Promise<T> {
    const problems: string[] = [];
    // The endpoint that worked last time goes first, so a healthy fallback does not pay
    // for the primary's failure on every subsequent call.
    const order = [
      ...(this.active !== null ? [this.active] : []),
      ...this.urls.map((_, i) => i).filter((i) => i !== this.active),
    ];

    for (const index of order) {
      const admission = await this.admit(index);
      const where = isIdentified(admission.identity) ? admission.identity.origin : 'unparseable endpoint';
      if (!admission.admitted) {
        problems.push(`${where}: ${admission.refusedBecause}`);
        continue;
      }
      const provider = this.providers[index];
      if (!provider) {
        problems.push(`${where}: admitted but has no provider`);
        continue;
      }
      try {
        const value = await op(provider);
        this.active = index;
        return value;
      } catch (err: any) {
        problems.push(`${where}: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 100)}`);
      }
    }

    throw new Error(
      `no RPC endpoint could serve the request (${this.urls.length} configured, each tried once): ` +
        problems.join(' | ')
    );
  }

  /** What each endpoint is and whether it was allowed to answer. Never includes a URL. */
  status(): PoolStatus {
    return {
      endpoints: this.urls.map(
        (url, i) =>
          this.admissions[i] ?? {
            identity: describeRpcEndpoint(url),
            admitted: false,
            refusedBecause: 'not probed yet',
            probeMs: 0,
          }
      ),
      activeIndex: this.active,
    };
  }

  get size(): number {
    return this.urls.length;
  }
}
