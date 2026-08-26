import { CORE_SCHEMA, CORE_VERSION, CoreEvidence } from './statusCore';

/**
 * A keyless consumer of the core evidence.
 *
 * WHAT THIS IS
 * ------------
 * One HTTP GET, one strict client timeout, one verdict. It loads no signer, no Turnkey
 * credential, no private key; it reserves no nonce and broadcasts nothing. It is a reader.
 *
 * WHAT A PASS MEANS, STATED SO IT CANNOT BE MISREAD
 * -------------------------------------------------
 * A PASS is keyless readiness EVIDENCE and grants NO signing or financial authority. It
 * says the chain looked right, through one named endpoint, at one moment. It is not
 * permission to spend, not a substitute for the canary's own direct preflight, and not a
 * pair approval.
 *
 * `phase-b-launch.ts` keeps every live chain, deployment, fee, pair, sellability and budget
 * check it already performs. This may become an ADDITIONAL gate in front of those. It must
 * never become a weaker substitute for them -- an endpoint that says yes is easier to
 * satisfy than a chain that does, and the expensive direction is the one that spends money.
 *
 * WHY THE PUBLIC GATE IS NOT A FAILURE HERE
 * -----------------------------------------
 * `PUBLIC_LAUNCH_ENABLED=false` pauses USER traffic: mentions stop before parsing, wallet
 * creation, signing or broadcast. It is deliberately not the operator canary's execution
 * authority, and a canary readiness check that failed on it would be demanding the bot be
 * opened to the public before a single controlled launch could be rehearsed. So the gate is
 * REPORTED, and its expected value is configurable, defaulting to the paused state that
 * production actually runs.
 */

export interface ValidateOptions {
  /** Chain the caller expects. Must be stated; never taken from the response. */
  expectedChainId: number;
  expectedDeploymentId: string;
  expectedFactory: string;
  /** Exact wei. An unreadable or different fee fails. */
  expectedLaunchFeeWei: bigint;
  expectedTreasury?: string;
  /** Endpoint fingerprint the caller expects to have been used, when it knows one. */
  expectedEndpointFingerprint?: string;
  /** How old `generatedAt` may be. */
  maxAgeMs?: number;
  /** What the public gate is expected to be. Defaults to paused, which production is. */
  expectPublicLaunchEnabled?: boolean;
  now?: () => number;
}

export type ValidationCode =
  | 'http-not-200'
  | 'body-unparseable'
  | 'schema-unknown'
  | 'version-unknown'
  | 'missing-field'
  | 'stale'
  | 'clock-ahead'
  | 'core-not-ok'
  | 'chain-mismatch'
  | 'block-missing'
  | 'deployment-mismatch'
  | 'factory-mismatch'
  | 'endpoint-mismatch'
  | 'endpoint-missing'
  | 'identity-not-fresh'
  | 'fee-mismatch'
  | 'readiness-incomplete'
  | 'readiness-not-ready'
  | 'treasury-mismatch'
  | 'treasury-unreadable'
  | 'spend-unknown'
  | 'spend-exhausted'
  | 'public-gate-unexpected'
  | 'request-failed';

export interface ValidationResult {
  pass: boolean;
  /** Closed categories, never provider text. */
  failures: ValidationCode[];
  /** One human line per failure, built from public facts only. */
  explanations: string[];
  /** Present when a body was read and parsed. */
  evidence: CoreEvidence | null;
  /** Round-trip cost of the single request. */
  elapsedMs: number;
  /** Always stated, on pass and on fail alike. */
  authority: 'none -- keyless readiness evidence only, grants no signing or financial authority';
}

const AUTHORITY = 'none -- keyless readiness evidence only, grants no signing or financial authority' as const;

/**
 * Checks an already-fetched body. Separated from the fetch so every rule is testable
 * without a network and without a running server.
 */
export function validateCoreEvidence(
  body: unknown,
  options: ValidateOptions,
  elapsedMs = 0
): ValidationResult {
  const now = options.now ?? (() => Date.now());
  const failures: ValidationCode[] = [];
  const explanations: string[] = [];
  const fail = (code: ValidationCode, why: string) => {
    failures.push(code);
    explanations.push(why);
  };

  if (!body || typeof body !== 'object') {
    fail('body-unparseable', 'the response body was not a JSON object');
    return { pass: false, failures, explanations, evidence: null, elapsedMs, authority: AUTHORITY };
  }
  const e = body as Partial<CoreEvidence>;

  if (e.schema !== CORE_SCHEMA) {
    fail('schema-unknown', `schema is not ${CORE_SCHEMA}`);
    return { pass: false, failures, explanations, evidence: null, elapsedMs, authority: AUTHORITY };
  }
  if (e.version !== CORE_VERSION) {
    fail('version-unknown', `version is not ${CORE_VERSION}`);
    return { pass: false, failures, explanations, evidence: null, elapsedMs, authority: AUTHORITY };
  }

  // Required structural fields. A missing field is never read as a permissive default.
  for (const key of ['ok', 'generatedAt', 'chainId', 'launchFeeWei', 'readiness', 'identity', 'rolling24hWei', 'publicLaunchEnabled'] as const) {
    if (!(key in e)) fail('missing-field', `the field ${key} is absent`);
  }

  const maxAge = options.maxAgeMs ?? 30_000;
  if (typeof e.generatedAt === 'string') {
    const at = Date.parse(e.generatedAt);
    if (Number.isNaN(at)) fail('missing-field', 'generatedAt is not a timestamp');
    else {
      const age = now() - at;
      if (age > maxAge) fail('stale', `generatedAt is ${Math.round(age / 1000)}s old, limit ${Math.round(maxAge / 1000)}s`);
      // A body from the future is a clock problem somewhere, and trusting it would let a
      // stale document pass forever by claiming a future timestamp.
      else if (age < -5_000) fail('clock-ahead', 'generatedAt is more than 5s in the future');
    }
  }

  if (e.chainId !== options.expectedChainId) {
    fail('chain-mismatch', `chain is ${String(e.chainId)}, expected ${options.expectedChainId}`);
  }
  if (typeof e.block !== 'number') fail('block-missing', 'no block number was observed');
  if (e.deploymentId !== options.expectedDeploymentId) {
    fail('deployment-mismatch', `deployment is ${String(e.deploymentId)}, expected ${options.expectedDeploymentId}`);
  }
  if (String(e.factory ?? '').toLowerCase() !== options.expectedFactory.toLowerCase()) {
    fail('factory-mismatch', `factory is ${String(e.factory)}, expected ${options.expectedFactory}`);
  }

  if (!e.observedThrough) fail('endpoint-missing', 'the response does not say which endpoint served it');
  else if (options.expectedEndpointFingerprint && e.observedThrough !== options.expectedEndpointFingerprint) {
    fail('endpoint-mismatch', `served through ${e.observedThrough}, expected ${options.expectedEndpointFingerprint}`);
  }

  const id = e.identity;
  if (!id || !id.ok || id.unreadable) {
    fail('identity-not-fresh', 'deployment identity is not a clean, readable match');
  }

  if (e.launchFeeWei === null || e.launchFeeWei === undefined) {
    fail('fee-mismatch', 'the launch fee could not be read');
  } else if (BigInt(e.launchFeeWei) !== options.expectedLaunchFeeWei) {
    fail('fee-mismatch', `fee is ${e.launchFeeWei} wei, expected ${options.expectedLaunchFeeWei} wei`);
  }

  const r = e.readiness;
  if (!r) fail('readiness-incomplete', 'no launch readiness evidence is present');
  else {
    if (!r.complete) fail('readiness-incomplete', 'launch readiness was reached with gaps in its evidence');
    if (!r.ready) fail('readiness-not-ready', 'this deployment would refuse a launch from this address');
  }

  if (options.expectedTreasury) {
    if (String(e.treasuryAddress ?? '').toLowerCase() !== options.expectedTreasury.toLowerCase()) {
      fail('treasury-mismatch', `treasury is ${String(e.treasuryAddress)}, expected ${options.expectedTreasury}`);
    }
  }
  if (e.treasuryBalanceWei === null || e.treasuryBalanceWei === undefined) {
    fail('treasury-unreadable', 'the treasury balance could not be read');
  }

  if (e.rolling24hWei === null || e.rolling24hWei === undefined) {
    // Unknown is not headroom. This is the same rule the status page learned the hard way.
    fail('spend-unknown', 'the authoritative rolling 24h spend is unknown');
  } else if (e.capWei !== undefined && BigInt(e.rolling24hWei) >= BigInt(e.capWei)) {
    fail('spend-exhausted', `rolling 24h spend ${e.rolling24hWei} has reached the cap ${e.capWei}`);
  }

  const expectGate = options.expectPublicLaunchEnabled ?? false;
  if (e.publicLaunchEnabled !== expectGate) {
    fail('public-gate-unexpected', `publicLaunchEnabled is ${String(e.publicLaunchEnabled)}, expected ${expectGate}`);
  }

  // Last, so the specific reasons above are reported rather than swallowed by the summary.
  if (e.ok !== true && failures.length === 0) {
    fail('core-not-ok', `core reported not ok: ${(e.problems ?? []).join(', ')}`);
  }

  return {
    pass: failures.length === 0,
    failures,
    explanations,
    evidence: e as CoreEvidence,
    elapsedMs,
    authority: AUTHORITY,
  };
}

/**
 * Fetches once and validates. No retry, ever.
 *
 * A retry would turn a bounded check into a poll, and polling until a green appears is how
 * a lucky window gets mistaken for a healthy system.
 */
export async function fetchAndValidateCore(
  baseUrl: string,
  options: ValidateOptions & { timeoutMs?: number; path?: string; fetchImpl?: typeof fetch }
): Promise<ValidationResult> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, '')}${options.path ?? '/status/core'}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await doFetch(url, { signal: controller.signal });
    const elapsed = Date.now() - started;
    if (res.status !== 200) {
      return {
        pass: false,
        failures: ['http-not-200'],
        explanations: [`the endpoint answered HTTP ${res.status}`],
        evidence: null,
        elapsedMs: elapsed,
        authority: AUTHORITY,
      };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        pass: false,
        failures: ['body-unparseable'],
        explanations: ['the response body was not valid JSON'],
        evidence: null,
        elapsedMs: elapsed,
        authority: AUTHORITY,
      };
    }
    return validateCoreEvidence(body, options, elapsed);
  } catch {
    // Nothing from the thrown value is reported: a fetch failure message carries the URL,
    // and a base URL can carry credentials.
    return {
      pass: false,
      failures: ['request-failed'],
      explanations: [`the request did not complete within ${timeoutMs}ms`],
      evidence: null,
      elapsedMs: Date.now() - started,
      authority: AUTHORITY,
    };
  } finally {
    clearTimeout(timer);
  }
}
