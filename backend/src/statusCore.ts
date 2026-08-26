import { DependencyName, DependencyTiming, TimingRecorder } from './dependencyTiming';

/**
 * The authoritative core: everything a decision about the chain depends on, and nothing
 * that a third party can make slow.
 *
 * WHY THE SPLIT EXISTS
 * --------------------
 * v36 answers `/status` truthfully and in 0.4 s most of the time. The tail is the problem:
 * sampled 25 times, three responses took 3 s or more, and on two of those the non-ok check
 * was `read-credits` -- a balance lookup at twitterapi.io that has nothing to do with
 * whether a launch may proceed. On the third, the readiness read itself took 3 012 ms.
 *
 * So there are two contributors, and only one of them is chain-authoritative. Making the
 * whole page wait on an external credits API in order to answer "is this the right chain,
 * the right factory, at the right fee" is the wrong shape regardless of which one is slow
 * on a given afternoon.
 *
 * WHAT IS IN, AND WHY EACH ONE
 * ----------------------------
 *   admitted endpoint + chain   a different chain is a different world
 *   advancing block             a node that answers but does not advance is not usable
 *   deployment + factory        an address is not an identity (findings section 11)
 *   deployment identity         the bytecode is the only thing separating the current
 *                               factory from the superseded one
 *   live launch fee             owner-settable on pons's side; never a constant
 *   launch readiness            complete one-batch permission evidence
 *   treasury address + balance  who is spending, and whether it can
 *   rolling-24h spend + cap     the window `validator.ts` actually admits against
 *   public gate                 Ponsr's own pause, reported, never inferred
 *
 * WHAT IS DELIBERATELY OUT
 * ------------------------
 * Read-provider credits, mention sweep and cross-check, alert and parser routing, and
 * pair-asset inventory. Every one of them matters to an operator and none of them decides
 * whether the chain is what we think it is. They stay on `/status`, with their real state,
 * their last-success age and their error category -- they are not deleted and they are
 * never reported green when they failed.
 *
 * PAIR INVENTORY IS OUT ON PURPOSE, AND THAT IS NARROW.
 * A native-ETH launch does not consult the approval map at all -- the factory
 * short-circuits on the zero address -- so making core wait on a log scan for it would be
 * inventing a dependency. A STOCK-PAIRED launch is different, and its approved-pair
 * evidence is still required, live, in the financial path. Core being green is not a pair
 * approval and this file does not pretend otherwise.
 *
 * THIS IS EVIDENCE, NOT AUTHORITY. A green core says the chain looked right at a moment.
 * It grants nothing: no signature, no spend, no launch. `phase-b-launch.ts` keeps every
 * one of its own direct preflight checks.
 */

export const CORE_SCHEMA = 'ponsr.status-core';
export const CORE_VERSION = 1;

/** Which dependencies the core waits for. Everything else is optional telemetry. */
export const CORE_DEPENDENCIES: readonly DependencyName[] = [
  'chain',
  'launch-fee',
  'launch-readiness',
  'treasury-balance',
  'deployment-identity',
];

/**
 * Closed set. A core problem is one of these, never a sentence built from a provider's
 * error text.
 */
export type CoreProblem =
  | 'no-admitted-endpoint'
  | 'chain-unreadable'
  | 'chain-mismatch'
  | 'block-unreadable'
  | 'deployment-unknown'
  | 'identity-unreadable'
  | 'identity-mismatch'
  | 'identity-stale'
  | 'fee-unreadable'
  | 'readiness-unreadable'
  | 'readiness-incomplete'
  | 'readiness-refused'
  | 'treasury-unreadable'
  | 'spend-unknown'
  | 'spend-exhausted'
  | 'core-deadline-exceeded';

export interface CoreReadiness {
  ready: boolean;
  launchEnabled: boolean;
  whitelisted: boolean;
  /** The factory's own predicate, before any local narrowing. */
  canLaunchOnChain: boolean | null;
  /** False when a verdict was reached with gaps in the evidence. */
  complete: boolean;
  detail?: string;
}

export interface CoreIdentity {
  ok: boolean;
  /** Age of the answer. A remembered pass must be visible as remembered. */
  ageMs: number | null;
  fromCache: boolean;
  /** Present only when the refresh could not be made; never a mismatch. */
  unreadable: boolean;
}

/**
 * The stable machine-readable contract.
 *
 * Field names and semantics are the interface a consumer binds to. Anything absent is
 * `null` and never a permissive default: an unreadable fee is not a free launch and an
 * unknown spend is not headroom.
 */
export interface CoreEvidence {
  schema: typeof CORE_SCHEMA;
  version: typeof CORE_VERSION;
  /** True only when every core fact was read and every one of them is acceptable. */
  ok: boolean;
  /** ISO. Freshness is the consumer's to bound; staleness is undetectable without it. */
  generatedAt: string;
  /** Wall clock for the core alone. */
  elapsedMs: number;
  /** Fingerprint of the ONE endpoint every observation below came through. */
  observedThrough: string | null;
  /** Scheme and host only. Never a path, query or userinfo. */
  endpointOrigin: string | null;
  chainId: number | null;
  expectedChainId: number;
  block: number | null;
  deploymentId: string | null;
  factory: string | null;
  identity: CoreIdentity | null;
  launchFeeWei: string | null;
  readiness: CoreReadiness | null;
  treasuryAddress: string | null;
  treasuryBalanceWei: string | null;
  /** The window the circuit breaker admits against. Null when it could not be read. */
  rolling24hWei: string | null;
  capWei: string;
  /** Ponsr's own pause. Reported as state; the consumer decides what it means. */
  publicLaunchEnabled: boolean;
  /** Every failed axis, from the closed set above. Empty when ok. */
  problems: CoreProblem[];
  /** Per-dependency cost. Diagnostics only; nothing is decided from these. */
  dependencies: DependencyTiming[];
}

export interface CoreDeps {
  expectedChainId: number;
  capWei: bigint;
  publicLaunchEnabled: boolean;
  deploymentId?: string;
  deploymentFactory?: string;
  treasuryAddress?: string;
  observedThrough?: string;
  endpointOrigin?: string;
  /** Null when no endpoint could be admitted for this response. */
  endpointAvailable: boolean;
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<number>;
  getLiveFeeWei(): Promise<bigint>;
  getTreasuryBalanceWei(): Promise<bigint>;
  getLaunchReadiness(): Promise<{
    launchEnabled: boolean;
    whitelisted: boolean;
    canLaunch?: boolean;
    canLaunchOnChain?: boolean;
    detail?: string;
    incomplete?: string;
  }>;
  getDeploymentIdentity?(): Promise<{
    result: { ok: boolean } | null;
    ageMs: number | null;
    fromCache: boolean;
    unreadable?: string;
  }>;
  rollingSpendLast24hWei?: () => bigint;
}

export interface CoreOptions {
  /** The core's OWN deadline, separate from anything optional telemetry may need. */
  budgetMs?: number;
  /** How old a cached identity pass may be before core calls it stale. */
  identityMaxAgeMs?: number;
  now?: () => number;
  recorder?: TimingRecorder;
}

export const DEFAULT_CORE_BUDGET_MS = 2500;
/** A cached identity pass older than this is not fresh evidence for a spend decision. */
export const DEFAULT_IDENTITY_MAX_AGE_MS = 15 * 60 * 1000;

class Expired extends Error {}

/** Bounds one dependency without propagating anything from it. */
async function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(ms <= 0 ? new Expired(`${label} was not reached`) : new Expired(`${label} did not answer within ${ms}ms`)),
          Math.max(0, ms)
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reads the core, concurrently, under one deadline of its own.
 *
 * Never throws. The caller is a status endpoint, and an exception there loses the evidence
 * that explains the failure.
 */
export async function buildCoreEvidence(
  deps: CoreDeps,
  options: CoreOptions = {}
): Promise<CoreEvidence> {
  const now = options.now ?? (() => Date.now());
  const budget = options.budgetMs ?? DEFAULT_CORE_BUDGET_MS;
  const identityMaxAge = options.identityMaxAgeMs ?? DEFAULT_IDENTITY_MAX_AGE_MS;
  const startedAt = now();
  const deadline = startedAt + budget;
  const remaining = () => deadline - now();
  const rec = options.recorder ?? new TimingRecorder(startedAt, now);
  const problems: CoreProblem[] = [];

  const base = {
    schema: CORE_SCHEMA as typeof CORE_SCHEMA,
    version: CORE_VERSION as typeof CORE_VERSION,
    expectedChainId: deps.expectedChainId,
    capWei: deps.capWei.toString(),
    publicLaunchEnabled: deps.publicLaunchEnabled,
    observedThrough: deps.observedThrough ?? null,
    endpointOrigin: deps.endpointOrigin ?? null,
    deploymentId: deps.deploymentId ?? null,
    factory: deps.deploymentFactory ?? null,
    treasuryAddress: deps.treasuryAddress ?? null,
  };

  const finish = (fields: Partial<CoreEvidence>): CoreEvidence => {
    const dependencies = rec.seal(CORE_DEPENDENCIES);
    const elapsedMs = now() - startedAt;
    if (elapsedMs > budget && !problems.includes('core-deadline-exceeded')) {
      problems.push('core-deadline-exceeded');
    }
    return {
      ...base,
      ok: problems.length === 0,
      generatedAt: new Date(now()).toISOString(),
      elapsedMs,
      chainId: null,
      block: null,
      identity: null,
      launchFeeWei: null,
      readiness: null,
      treasuryBalanceWei: null,
      rolling24hWei: null,
      problems,
      dependencies,
      ...fields,
    };
  };

  // No endpoint at all: say so once, in the vocabulary of the contract, and do not fabricate
  // a chain read that never happened.
  if (!deps.endpointAvailable) {
    problems.push('no-admitted-endpoint');
    for (const name of CORE_DEPENDENCIES) rec.absent(name);
    return finish({});
  }

  // Started together. Concurrency is the point: the core's cost is its slowest dependency,
  // not their sum, and the recorder attaches to running promises rather than serialising
  // them.
  const chainP = rec.track('chain', Promise.all([deps.getChainId(), deps.getBlockNumber()]));
  const feeP = rec.track('launch-fee', deps.getLiveFeeWei());
  const readyP = rec.track('launch-readiness', deps.getLaunchReadiness(), true);
  const balanceP = rec.track('treasury-balance', deps.getTreasuryBalanceWei());
  const identityP = deps.getDeploymentIdentity
    ? rec.track('deployment-identity', deps.getDeploymentIdentity())
    : undefined;
  if (!identityP) rec.absent('deployment-identity');

  let chainId: number | null = null;
  let block: number | null = null;
  try {
    const [c, b] = await within(chainP, remaining(), 'chain');
    chainId = c;
    block = b;
    if (c !== deps.expectedChainId) problems.push('chain-mismatch');
  } catch {
    problems.push('chain-unreadable');
  }

  let launchFeeWei: string | null = null;
  try {
    const fee = await within(feeP, remaining(), 'launch fee');
    launchFeeWei = fee.toString();
  } catch {
    // An unreadable fee is never zero. A zero fee is a real value pons could set, so
    // inventing it would publish a price nobody read.
    problems.push('fee-unreadable');
  }

  let readiness: CoreReadiness | null = null;
  try {
    const r = await within(readyP, remaining(), 'launch readiness');
    const complete = !r.incomplete;
    readiness = {
      ready: Boolean(r.canLaunch ?? (r.launchEnabled || r.whitelisted)),
      launchEnabled: Boolean(r.launchEnabled),
      whitelisted: Boolean(r.whitelisted),
      canLaunchOnChain: r.canLaunchOnChain ?? null,
      complete,
      detail: r.detail,
    };
    if (!complete) problems.push('readiness-incomplete');
    if (!readiness.ready) problems.push('readiness-refused');
  } catch {
    problems.push('readiness-unreadable');
  }

  let treasuryBalanceWei: string | null = null;
  try {
    treasuryBalanceWei = (await within(balanceP, remaining(), 'treasury balance')).toString();
  } catch {
    problems.push('treasury-unreadable');
  }

  let identity: CoreIdentity | null = null;
  if (identityP) {
    try {
      const id = await within(identityP, remaining(), 'deployment identity');
      identity = {
        ok: Boolean(id.result?.ok),
        ageMs: id.ageMs,
        fromCache: id.fromCache,
        unreadable: Boolean(id.unreadable),
      };
      if (!id.result) problems.push('identity-unreadable');
      else if (!id.result.ok) problems.push('identity-mismatch');
      // A cached pass is still a pass, but not an unlimited one. Beyond the threshold it
      // is remembered rather than observed, and a spend decision must be able to tell.
      else if (id.ageMs !== null && id.ageMs > identityMaxAge) problems.push('identity-stale');
    } catch {
      problems.push('identity-unreadable');
    }
  } else {
    problems.push('identity-unreadable');
  }

  // Local, no network. Unknown is not headroom: the rolling window is what admits a
  // launch, and a missing figure with a quiet calendar day is not evidence of room.
  let rolling24hWei: string | null = null;
  const rolling = deps.rollingSpendLast24hWei?.();
  if (rolling === undefined) problems.push('spend-unknown');
  else {
    rolling24hWei = rolling.toString();
    if (rolling >= deps.capWei) problems.push('spend-exhausted');
  }

  if (!deps.deploymentId || !deps.deploymentFactory) problems.push('deployment-unknown');
  if (block === null && !problems.includes('chain-unreadable')) problems.push('block-unreadable');

  return finish({ chainId, block, identity, launchFeeWei, readiness, treasuryBalanceWei, rolling24hWei });
}
