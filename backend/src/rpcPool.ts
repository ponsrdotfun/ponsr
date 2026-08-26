import { ethers } from 'ethers';
import { PonsDeployment, executableDeployment } from './deployments';
import { RpcEndpointDescription, describeRpcEndpoint, isIdentified } from './rpcIdentity';

/**
 * More than one RPC endpoint, with the failover BOUNDED and every candidate proven -- by
 * asking it -- to be the same chain and the same factory before it may answer anything.
 *
 * WHY A FALLBACK AT ALL
 * ---------------------
 * The backend and the canary both read a single public endpoint. When it slows down there
 * is no second opinion, and the whole read path stalls behind one host nobody at Ponsr
 * operates.
 *
 * WHY A FALLBACK IS ALSO DANGEROUS
 * --------------------------------
 * A naive fallback is strictly worse than none. `ethers.FallbackProvider` and every
 * hand-rolled "try the next URL" loop assume the endpoints are interchangeable. If the
 * second URL is testnet, a fork, or an archive node lagging by an hour, the bot does not
 * stop -- it keeps going against a different world, and every guard in this repository
 * returns a confident answer about somewhere else. Not hypothetical: `backend/.env`
 * already holds a testnet URL, and there this factory address holds no contract at all.
 *
 * THE BUG THIS FILE WAS REWRITTEN TO FIX, WHICH IS WORTH STATING PLAINLY
 * ---------------------------------------------------------------------
 * The first version asked `provider.getNetwork()` for the endpoint's chain id. With
 * `new JsonRpcProvider(url, chainId, { staticNetwork: true })` that returns the CONFIGURED
 * value and sends nothing. Measured: a server answering chain 46630, a pool expecting
 * 4663, zero methods reaching the transport, and the endpoint ADMITTED. The gate compared
 * a constant to itself.
 *
 * The tests did not catch it because they supplied a fake provider whose `getNetwork()`
 * returned whatever the test wanted -- a mock above the layer under test, which reports
 * the author's expectations back to them. The chain id is now read with an explicit
 * `eth_chainId` over the wire, parsed strictly, and the suite asserts that the method
 * actually appears in the server's received-method log.
 *
 * WHAT IS CHECKED BEFORE AN ENDPOINT MAY ANSWER
 * ---------------------------------------------
 *   chain id         from `eth_chainId`, over the wire, strictly parsed
 *   factory bytecode must hash to the registry's `runtimeBytecodeSha256` -- the axis that
 *                    catches a fork, a lagging archive node, and an endpoint on the right
 *                    chain serving superseded state
 *
 * Anything unreadable is a refusal, not a pass: an endpoint that will not say what chain
 * it is on has not proven it is the right one.
 *
 * SECRECY
 * -------
 * Provider errors routinely contain the request URL, and RPC URLs routinely contain an API
 * key. So NO external error text is ever copied into a published field. Failures are
 * mapped to a closed set of categories, and the only variable data allowed alongside them
 * is already public: an observed chain id, a bytecode hash, a byte length.
 */

/** The complete set of reasons an endpoint can be unusable. Closed on purpose. */
export type RefusalCode =
  | 'url-unparseable'
  | 'provider-construction-failed'
  | 'admission-timed-out'
  | 'chain-id-unreadable'
  | 'chain-id-mismatch'
  | 'no-contract-at-factory'
  | 'runtime-unreadable'
  | 'runtime-mismatch'
  | 'operation-timed-out'
  | 'operation-failed'
  | 'budget-exhausted';

/**
 * True for reasons that are a property of the endpoint rather than of the moment.
 *
 * `budget-exhausted` is deliberately NOT permanent: it says the CALLER ran out of time,
 * which is a fact about one request and not about the endpoint. Caching it would let a
 * single slow response mark a healthy endpoint unusable for everything after it.
 */
function isPermanent(code: RefusalCode): boolean {
  return code === 'chain-id-mismatch' || code === 'runtime-mismatch' || code === 'url-unparseable';
}

export interface EndpointAdmission {
  identity: RpcEndpointDescription;
  admitted: boolean;
  /** Machine-readable and non-secret. Absent when admitted. */
  refusedCode?: RefusalCode;
  /** Human-readable, built here from public facts only -- never from provider text. */
  refusedBecause?: string;
  observedChainId?: number;
  /** Round-trip cost of the admission probe, which doubles as a first latency sample. */
  probeMs: number;
  /** When this verdict was measured. Null when the endpoint has not been probed. */
  checkedAt: string | null;
  /** Age of the verdict. An admission that is remembered must be visible as remembered. */
  ageMs: number | null;
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

/**
 * Strict `eth_chainId`, with every loose reading refused.
 *
 * `Number(raw)` would accept `''` as 0, `parseInt` would accept `'4663junk'`, and neither
 * notices a value past 2^53 where equality silently stops meaning anything. An endpoint
 * that cannot state its chain id in the one format the JSON-RPC spec defines has not
 * identified itself, and guessing on its behalf is how the wrong chain gets admitted.
 */
export function parseChainId(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) return null;
  const value = BigInt(raw);
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

export interface RpcPoolOptions {
  deployment?: PonsDeployment;
  /** Bound on a single admission probe. Separate from the caller's own deadline. */
  admissionTimeoutMs?: number;
  /**
   * Bound on ONE endpoint's attempt at the caller's operation.
   *
   * Without this a hung request never fails over: the most common real RPC failure is a
   * stall, not a rejection, so a fallback that only engages on rejection does not engage on
   * the failure it was bought for.
   */
  operationTimeoutMs?: number;
  /**
   * How long a successful admission may be reused before the endpoint is re-checked.
   *
   * A pass used to be kept for the lifetime of the process, so an endpoint that later
   * forked or fell behind kept being used without ever being asked again.
   */
  admissionTtlMs?: number;
  /** Injected so tests can supply a broken provider without a network. */
  makeProvider?: (url: string, chainId: number) => ethers.JsonRpcProvider;
  now?: () => number;
}

export const DEFAULT_ADMISSION_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_OPERATION_TIMEOUT_MS = 2500;

/**
 * How long the CALLER has left, for work that is part of a larger bounded response.
 *
 * Without this the pool's own timeouts are additive with the caller's: /status opened with
 * `await rpcPool.acquire()` and only afterwards started its 5 000 ms deadline, so two
 * stalled candidates at the 4 000 ms default cost 8 000 ms before the "one budget for the
 * whole response" even began. Measured on the route: 8 026 ms of acquisition, 8 038 ms
 * total, against a claimed 5 000 ms bound.
 *
 * Every internal timeout is clamped to what remains, so a caller cannot configure an
 * admission or operation timeout that outlives the deadline it is nested inside.
 */
export interface BudgetedCall {
  /** Absolute epoch-ms deadline for the whole enclosing response. */
  deadlineMs?: number;
}

class TimedOut extends Error {}

/**
 * Bounds a promise WITHOUT propagating anything from it.
 *
 * The rejection is swallowed rather than re-thrown: whatever the underlying provider says
 * on the way down may contain the request URL, and this function's callers publish what
 * they are given. A separate marker type is thrown instead.
 */
async function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimedOut()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class RpcPool {
  private readonly deployment: PonsDeployment;
  private readonly admissionTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly admissionTtlMs: number;
  private readonly makeProvider: (url: string, chainId: number) => ethers.JsonRpcProvider;
  private readonly now: () => number;
  private readonly providers: Array<ethers.JsonRpcProvider | null>;
  private readonly admissions: Array<EndpointAdmission | null>;
  private readonly admittedAt: Array<number | null>;
  private readonly inFlight: Array<Promise<EndpointAdmission> | null>;
  private active: number | null = null;
  /**
   * Incremented for every `run`. A timed-out attempt that finishes later carries a stale
   * token and is refused the right to record itself as the active endpoint.
   */
  private generation = 0;

  constructor(
    private readonly urls: string[],
    options: RpcPoolOptions = {}
  ) {
    this.deployment = options.deployment ?? executableDeployment();
    this.admissionTimeoutMs = options.admissionTimeoutMs ?? 4000;
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.admissionTtlMs = options.admissionTtlMs ?? DEFAULT_ADMISSION_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.makeProvider =
      options.makeProvider ??
      ((url, chainId) => new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true }));
    this.providers = urls.map(() => null);
    this.admissions = urls.map(() => null);
    this.admittedAt = urls.map(() => null);
    this.inFlight = urls.map(() => null);
  }

  private fresh(index: number): boolean {
    const a = this.admissions[index];
    const at = this.admittedAt[index];
    if (!a || at === null) return false;
    // A permanent refusal is kept: a wrong chain is a property of the endpoint, not of the
    // moment, and re-probing it every request buys nothing. Everything else -- including a
    // transient outage -- must be able to recover without a restart.
    if (!a.admitted) return a.refusedCode ? isPermanent(a.refusedCode) : false;
    return this.now() - at < this.admissionTtlMs;
  }

  private record(index: number, a: Omit<EndpointAdmission, 'checkedAt' | 'ageMs'>): EndpointAdmission {
    const at = this.now();
    this.admittedAt[index] = at;
    const full: EndpointAdmission = { ...a, checkedAt: new Date(at).toISOString(), ageMs: 0 };
    this.admissions[index] = full;
    return full;
  }

  /**
   * Proves one endpoint is the chain and the factory the registry describes.
   *
   * Both reads are issued together so ethers batches them: an admission probe costing two
   * round trips would make adding a fallback measurably slower on the happy path, which is
   * a good way to ensure nobody ever configures one.
   */
  /**
   * A refusal that belongs to THIS CALLER, not to the endpoint.
   *
   * Deliberately not recorded. `budget-exhausted` says the caller ran out of time; storing
   * it would publish a fact about one slow request as if it were a property of the endpoint,
   * overwrite a real admission's `checkedAt`, and let two concurrent responses describe the
   * pool differently depending on which finished last.
   */
  private notReached(index: number, why: string): EndpointAdmission {
    return {
      identity: describeRpcEndpoint(this.urls[index]),
      admitted: false,
      refusedCode: 'budget-exhausted',
      refusedBecause: why,
      probeMs: 0,
      checkedAt: null,
      ageMs: null,
    };
  }

  /**
   * Admission for ONE caller: shares the network probe, never the waiting budget.
   *
   * Coalescing used to hand a later caller the first caller's raw promise, so the newcomer
   * waited under an allowance it never agreed to. Measured: a `/status` request with a
   * 300 ms budget took 983 ms because it inherited a stalled 1 000 ms probe started by a
   * caller with no deadline at all. The whole point of the overall status deadline was
   * defeated by the optimisation sitting next to it.
   *
   * So there are two different clocks and they are kept apart:
   *
   *   the PROBE is bounded by `admissionTimeoutMs`, the pool's own unit of work. It is
   *     shared, it is never cancelled by a waiter giving up, and it records the truth when
   *     it finishes.
   *   the WAIT is bounded by this caller's remaining deadline. Giving up on the wait
   *     abandons nothing and poisons nothing; it only stops this response from blocking.
   */
  private async admit(index: number, deadlineMs?: number): Promise<EndpointAdmission> {
    if (this.fresh(index)) return this.admissions[index]!;

    // Concurrent callers must not each start their own probe. Per-endpoint, so a second
    // endpoint's probe is never merged with the first's.
    let running = this.inFlight[index];
    if (!running) {
      // The probe takes no caller deadline. A shared unit of work bounded by whoever
      // happened to start it would make its lifetime depend on an unrelated request.
      running = this.probe(index).finally(() => {
        this.inFlight[index] = null;
      });
      // A waiter that gives up leaves this promise unawaited; without a handler here that
      // is an unhandled rejection, which in production is a warning and can be fatal.
      running.catch(() => {});
      this.inFlight[index] = running;
    }

    const wait = this.allowance(this.admissionTimeoutMs, deadlineMs);
    if (wait <= 0) {
      return this.notReached(index, 'the status request ran out of budget before this endpoint was reached');
    }
    try {
      return await bounded(running, wait);
    } catch (err) {
      if (err instanceof TimedOut) {
        // The shared probe continues and will record its real verdict. This caller simply
        // stops waiting for it.
        return this.notReached(
          index,
          `the status request ran out of budget after waiting ${wait}ms for this endpoint`
        );
      }
      // probe() resolves rather than rejects for every network outcome, so reaching here
      // means something unexpected. Reported as a refusal rather than propagated, because a
      // status page must produce a body.
      return this.notReached(index, 'the admission probe failed unexpectedly');
    }
  }

  /** What this call may still spend: the caller's remaining time, never more. */
  private allowance(configured: number, deadlineMs?: number): number {
    if (deadlineMs === undefined) return configured;
    return Math.min(configured, Math.max(0, deadlineMs - this.now()));
  }

  /**
   * An equal slice of the remaining budget for one of `candidatesLeft` candidates.
   *
   * Returns an absolute deadline, so it composes with `allowance` unchanged. Without it the
   * first candidate consumes everything and a configured fallback can never be reached --
   * which is the failure mode a fallback exists to cover.
   */
  private share(deadlineMs: number | undefined, candidatesLeft: number): number | undefined {
    if (deadlineMs === undefined) return undefined;
    const remaining = Math.max(0, deadlineMs - this.now());
    return this.now() + Math.floor(remaining / Math.max(1, candidatesLeft));
  }

  private async probe(index: number): Promise<EndpointAdmission> {
    const url = this.urls[index];
    const identity = describeRpcEndpoint(url);
    const started = this.now();

    const refuse = (
      refusedCode: RefusalCode,
      refusedBecause: string,
      observedChainId?: number
    ): EndpointAdmission =>
      this.record(index, {
        identity,
        admitted: false,
        refusedCode,
        refusedBecause,
        observedChainId,
        probeMs: this.now() - started,
      });

    if (!isIdentified(identity)) return refuse('url-unparseable', identity.problem);

    // The pool's own unit of work, not any caller's. See admit() for why these are
    // separate clocks.
    const budget = this.admissionTimeoutMs;

    let provider: ethers.JsonRpcProvider;
    try {
      provider = this.makeProvider(url, this.deployment.chainId);
    } catch {
      // Nothing from the thrown error is reported. A construction failure message is one of
      // the likeliest places for the URL -- and therefore the key -- to appear.
      return refuse('provider-construction-failed', 'the provider could not be constructed');
    }

    let rawChainId: unknown;
    let code: string;
    try {
      // eth_chainId over the wire, NOT provider.getNetwork(): with a configured static
      // network that answers from configuration and sends nothing. This is the line the
      // whole rewrite exists for.
      [rawChainId, code] = await bounded(
        Promise.all([
          provider.send('eth_chainId', []) as Promise<unknown>,
          provider.getCode(this.deployment.factory),
        ]),
        budget
      );
    } catch (err) {
      if (err instanceof TimedOut) {
        return refuse('admission-timed-out', `the endpoint did not answer within ${budget}ms`);
      }
      return refuse('chain-id-unreadable', 'the endpoint did not return a usable chain id and runtime');
    }

    const observed = parseChainId(rawChainId);
    if (observed === null) {
      // Deliberately does not echo the value: a malformed chain id is attacker-influenced
      // text arriving from a remote host.
      return refuse('chain-id-unreadable', 'the endpoint returned a chain id that is not a valid hex quantity');
    }
    if (observed !== this.deployment.chainId) {
      return refuse(
        'chain-id-mismatch',
        `chain id is ${observed}, but ${this.deployment.id} is on ${this.deployment.chainId}`,
        observed
      );
    }
    if (!code || code === '0x') {
      return refuse(
        'no-contract-at-factory',
        `no contract at ${this.deployment.factory} -- this endpoint does not serve ${this.deployment.id}`,
        observed
      );
    }
    const hash = ethers.sha256(code).slice(2);
    if (hash.toLowerCase() !== this.deployment.runtimeBytecodeSha256.toLowerCase()) {
      return refuse(
        'runtime-mismatch',
        `the factory's runtime bytecode hashes to ${hash.slice(0, 16)}..., but the registry ` +
          `records ${this.deployment.runtimeBytecodeSha256.slice(0, 16)}... for ${this.deployment.id}`,
        observed
      );
    }

    this.providers[index] = provider;
    return this.record(index, {
      identity,
      admitted: true,
      observedChainId: observed,
      probeMs: this.now() - started,
    });
  }

  /**
   * Runs `op` against the first endpoint that answers, trying each at most once.
   *
   * The bound is the point: at most `urls.length` attempts, no retries within an endpoint,
   * no backoff, and each attempt itself bounded so a stall cannot consume the caller's
   * whole deadline.
   */
  async run<T>(
    op: (provider: ethers.JsonRpcProvider, endpoint: RpcEndpointDescription) => Promise<T>,
    options: BudgetedCall = {}
  ): Promise<T> {
    const token = ++this.generation;
    const problems: string[] = [];
    // The endpoint that worked last time goes first, so a healthy fallback does not pay for
    // the primary's failure on every subsequent call. Admission is unaffected by ordering.
    const order = [
      ...(this.active !== null ? [this.active] : []),
      ...this.urls.map((_, i) => i).filter((i) => i !== this.active),
    ];

    for (let position = 0; position < order.length; position++) {
      const index = order[position];
      const candidatesLeft = order.length - position;
      const admission = await this.admit(index, this.share(options.deadlineMs, candidatesLeft));
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
      const opBudget = this.allowance(
        this.operationTimeoutMs,
        this.share(options.deadlineMs, candidatesLeft)
      );
      if (opBudget <= 0) {
        problems.push(`${where}: the status request ran out of budget before this endpoint was tried`);
        continue;
      }
      try {
        const value = await bounded(op(provider, admission.identity), opBudget);
        // A stale generation means this caller already gave up and something else has since
        // run. Recording `active` here would let an abandoned attempt reassign the pool
        // behind a later caller's back.
        if (token === this.generation) this.active = index;
        return value;
      } catch (err) {
        const timedOut = err instanceof TimedOut;
        problems.push(
          `${where}: ${timedOut ? `the operation did not answer within ${opBudget}ms` : 'the operation failed'}`
        );
        // Nothing from `err` is retained. The operation callback is application code that
        // wraps provider errors, and those carry the request URL.
      }
    }

    throw new Error(
      `no RPC endpoint could serve the request (${this.urls.length} configured, each tried once): ` +
        problems.join(' | ')
    );
  }

  /**
   * Pins ONE admitted endpoint, so everything in a single response comes from one view.
   *
   * `run` picks per call and may fail over between calls. That is right for independent
   * reads and wrong for a status page: /status was reading chain id, block, fee and balance
   * through the pinned provider while readiness and identity came through the pool, and
   * then labelling the whole response with the POOL's endpoint. A reader would see endpoint
   * B named as active above evidence that came from A -- one document, two worlds, and no
   * way to tell from the page.
   *
   * Returns null rather than throwing when nothing can be admitted: the caller is a status
   * page whose job is to report that, not to fail.
   */
  async acquire(
    options: BudgetedCall = {}
  ): Promise<{ provider: ethers.JsonRpcProvider; endpoint: RpcEndpointDescription; index: number } | null> {
    const order = [
      ...(this.active !== null ? [this.active] : []),
      ...this.urls.map((_, i) => i).filter((i) => i !== this.active),
    ];
    for (let position = 0; position < order.length; position++) {
      const index = order[position];
      // Every candidate shares the caller's ONE remaining budget -- and shares it FAIRLY.
      //
      // Giving the first candidate the whole remainder makes a fallback unreachable
      // whenever the primary stalls: the budget is spent waiting on the endpoint that is
      // already known to be slow, and the healthy one is never tried. So each remaining
      // candidate gets an equal slice of what is left, and an early answer returns the rest
      // of the budget to the candidates behind it.
      const admission = await this.admit(index, this.share(options.deadlineMs, order.length - position));
      const provider = this.providers[index];
      if (admission.admitted && provider) {
        this.active = index;
        // The INDEX travels with the session. A caller that renders "which endpoint served
        // this response" must not look up `activeIndex` later: a concurrent request can
        // move it between acquisition and rendering.
        return { provider, endpoint: admission.identity, index };
      }
    }
    return null;
  }

  /** What each endpoint is and whether it was allowed to answer. Never includes a URL. */
  status(): PoolStatus {
    return {
      endpoints: this.urls.map((url, i) => {
        const a = this.admissions[i];
        if (!a) {
          return {
            identity: describeRpcEndpoint(url),
            admitted: false,
            refusedBecause: 'not probed yet',
            probeMs: 0,
            checkedAt: null,
            ageMs: null,
          };
        }
        const at = this.admittedAt[i];
        return { ...a, ageMs: at === null ? null : this.now() - at };
      }),
      activeIndex: this.active,
    };
  }

  get size(): number {
    return this.urls.length;
  }
}
