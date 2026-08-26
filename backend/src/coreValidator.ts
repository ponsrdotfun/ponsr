import { CORE_SCHEMA, CORE_VERSION, CoreEvidence, CORE_PROBLEMS, CORE_DEPENDENCIES } from './statusCore';
import { DEPENDENCY_NAMES, DEPENDENCY_OUTCOMES } from './dependencyTiming';
import {
  parseAddress,
  parseBoolean,
  parseCount,
  parseFingerprint,
  parseOrigin,
  parsePositive,
  parseTimestamp,
  parseWei,
} from './strictParse';

/**
 * A keyless, HOSTILE-INPUT consumer of the core evidence.
 *
 * WHAT THIS IS
 * ------------
 * One HTTP GET, one absolute deadline, one verdict. It loads no signer, no Turnkey
 * credential, no private key; it reserves no nonce and broadcasts nothing. It is a reader.
 *
 * WHAT A PASS MEANS, STATED SO IT CANNOT BE MISREAD
 * -------------------------------------------------
 * A PASS is keyless readiness EVIDENCE and grants NO signing or financial authority. It
 * says the chain looked right, through one named endpoint, at one moment. It is not
 * permission to spend, not a substitute for the canary's own direct preflight, and not a
 * pair approval. `phase-b-launch.ts` keeps every live chain, deployment, fee, pair,
 * sellability and budget check it already performs.
 *
 * THE BODY IS UNTRUSTED. EVERY FIELD IS PROVEN, NOT READ.
 * ------------------------------------------------------
 * An earlier version called `BigInt(e.launchFeeWei)` on raw JSON, so `"not-a-bigint"` made
 * the validator THROW instead of failing -- and a validator that throws has no closed
 * failure vocabulary at the one moment it needs one. It also compared rolling spend against
 * the cap THE RESPONSE SUPPLIED, so a body claiming a cap of 10^21 passed with the real cap
 * exhausted. A circuit-breaker limit must never be evidence about itself.
 *
 * So: every quantity is caller-pinned, every field is shape-checked before use, and nothing
 * here can throw on any input.
 *
 * WHY THE PUBLIC GATE IS NOT A FAILURE
 * ------------------------------------
 * `PUBLIC_LAUNCH_ENABLED=false` pauses USER traffic: mentions stop before parsing, wallet
 * creation, signing or broadcast. It is deliberately not the operator canary's execution
 * authority -- a readiness check failing on it would demand the bot be opened to the public
 * before one controlled launch could be rehearsed. The expected value is caller-supplied
 * and defaults to the paused state production runs, so the check is real in both directions.
 */

export interface ValidateOptions {
  /** Chain the caller expects. Stated; never taken from the response. */
  expectedChainId: number;
  expectedDeploymentId: string;
  expectedFactory: string;
  /** Exact wei. An unreadable or different fee fails. */
  expectedLaunchFeeWei: bigint;
  /**
   * The spend cap the caller believes in. REQUIRED.
   *
   * Not optional, and never read from the body. The response used to supply the cap it was
   * measured against, which let a document assert its own headroom.
   */
  expectedCapWei: bigint;
  /**
   * The treasury the caller expects. REQUIRED.
   *
   * The address is public, so pinning it costs nothing and omitting it let a core describing
   * a completely different wallet pass.
   */
  expectedTreasury: string;
  /**
   * Minimum treasury balance the caller requires, in wei.
   *
   * Checked here as well as by the producer: "the producer said ok" is the one thing a
   * hostile-input validator may not rely on.
   */
  requiredTreasuryBalanceWei: bigint;
  /** Endpoint fingerprint the caller expects to have served the response. REQUIRED. */
  expectedEndpointFingerprint: string;
  /** How old `generatedAt` may be. */
  maxAgeMs?: number;
  /** How old a cached identity pass may be. */
  maxIdentityAgeMs?: number;
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
  | 'malformed-field'
  | 'stale'
  | 'clock-ahead'
  | 'core-not-ok'
  | 'unknown-problem-code'
  | 'chain-mismatch'
  | 'block-missing'
  | 'deployment-mismatch'
  | 'factory-mismatch'
  | 'endpoint-mismatch'
  | 'endpoint-missing'
  | 'identity-not-fresh'
  | 'identity-stale'
  | 'fee-mismatch'
  | 'cap-mismatch'
  | 'readiness-incomplete'
  | 'readiness-not-ready'
  | 'readiness-inconsistent'
  | 'treasury-mismatch'
  | 'treasury-unreadable'
  | 'treasury-insufficient'
  | 'spend-unknown'
  | 'spend-exhausted'
  | 'public-gate-unexpected'
  | 'dependency-not-ok'
  | 'dependency-missing'
  | 'request-failed'
  | 'response-too-large';

export interface ValidationResult {
  pass: boolean;
  /** Closed categories, never provider text. */
  failures: ValidationCode[];
  /** One human line per failure, built from public facts only. */
  explanations: string[];
  /** Present only when the body parsed AND every field validated. */
  evidence: CoreEvidence | null;
  elapsedMs: number;
  authority: 'none -- keyless readiness evidence only, grants no signing or financial authority';
}

const AUTHORITY =
  'none -- keyless readiness evidence only, grants no signing or financial authority' as const;

const PROBLEM_SET: ReadonlySet<string> = new Set(CORE_PROBLEMS);
const DEP_NAMES: ReadonlySet<string> = new Set(DEPENDENCY_NAMES);
const DEP_OUTCOMES: ReadonlySet<string> = new Set(DEPENDENCY_OUTCOMES);
/** The dependencies a spend decision rests on. Optional telemetry is not among them. */
const REQUIRED_DEPENDENCIES: ReadonlySet<string> = new Set(CORE_DEPENDENCIES);

/**
 * Checks an already-fetched body. Separated from the fetch so every rule is testable
 * without a network and without a running server. NEVER THROWS, for any input.
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
  const done = (): ValidationResult => ({
    pass: failures.length === 0,
    failures,
    explanations,
    evidence: failures.length === 0 ? (body as CoreEvidence) : null,
    elapsedMs,
    authority: AUTHORITY,
  });

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('body-unparseable', 'the response body was not a JSON object');
    return done();
  }
  const e = body as Record<string, unknown>;

  if (e.schema !== CORE_SCHEMA) {
    fail('schema-unknown', `schema is not ${CORE_SCHEMA}`);
    return done();
  }
  if (e.version !== CORE_VERSION) {
    fail('version-unknown', `version is not ${CORE_VERSION}`);
    return done();
  }

  // --- the producer's own summary, checked for INTERNAL CONSISTENCY ------------------
  //
  // `ok: true` alongside a non-empty problem list is a self-contradicting document, and it
  // used to pass because the summary was only consulted when nothing else had failed.
  const ok = parseBoolean(e.ok);
  if (ok === null) fail('malformed-field', 'ok is not a boolean');
  if (!Array.isArray(e.problems)) {
    fail('missing-field', 'problems is absent or not an array');
  } else {
    for (const p of e.problems) {
      if (typeof p !== 'string' || !PROBLEM_SET.has(p)) {
        fail('unknown-problem-code', 'problems contains a code outside the version 1 vocabulary');
        break;
      }
    }
    if (e.problems.length > 0) {
      fail('core-not-ok', `core reported problems: ${(e.problems as string[]).join(', ')}`);
    }
  }
  if (ok === false) fail('core-not-ok', 'core reported ok: false');

  // --- freshness --------------------------------------------------------------------
  const maxAge = options.maxAgeMs ?? 30_000;
  const generatedAt = parseTimestamp(e.generatedAt);
  if (generatedAt === null) {
    fail('missing-field', 'generatedAt is absent or not a timestamp');
  } else {
    const age = now() - generatedAt;
    if (age > maxAge) fail('stale', `generatedAt is ${Math.round(age / 1000)}s old, limit ${Math.round(maxAge / 1000)}s`);
    // A body from the future is a clock problem, and trusting it would let a stale document
    // pass forever by claiming a future timestamp.
    else if (age < -5_000) fail('clock-ahead', 'generatedAt is more than 5s in the future');
  }
  if (parseCount(e.elapsedMs) === null) fail('malformed-field', 'elapsedMs is not a non-negative safe integer');

  // --- identity of the world being described ----------------------------------------
  const chainId = parseCount(e.chainId);
  if (chainId === null) fail('malformed-field', 'chainId is not a safe integer');
  else if (chainId !== options.expectedChainId) {
    fail('chain-mismatch', `chain is ${chainId}, expected ${options.expectedChainId}`);
  }

  // One response proves a READABLE block, not an advancing one. Advancement needs two
  // observations separated in time, which one verdict cannot have.
  if (parsePositive(e.block) === null) {
    fail('block-missing', 'block is absent, zero, or not a positive safe integer');
  }

  if (e.deploymentId !== options.expectedDeploymentId) {
    fail('deployment-mismatch', `deployment is ${String(e.deploymentId)}, expected ${options.expectedDeploymentId}`);
  }
  const factory = parseAddress(e.factory);
  const expectedFactory = parseAddress(options.expectedFactory);
  if (factory === null || expectedFactory === null || factory !== expectedFactory) {
    fail('factory-mismatch', `factory is ${String(e.factory)}, expected ${options.expectedFactory}`);
  }

  const fingerprint = parseFingerprint(e.observedThrough);
  if (fingerprint === null) fail('endpoint-missing', 'the response does not carry a valid endpoint fingerprint');
  else if (fingerprint !== options.expectedEndpointFingerprint) {
    fail('endpoint-mismatch', `served through ${fingerprint}, expected ${options.expectedEndpointFingerprint}`);
  }
  // An admitted endpoint carries BOTH a fingerprint and a bare origin. A null origin is
  // valid only for a document that had no endpoint at all -- and such a document is not ok,
  // so it fails elsewhere anyway. Accepting null beside a claimed fingerprint would let the
  // schema narrative and the implementation disagree, which is how a contract stops meaning
  // anything.
  if (e.endpointOrigin === null || e.endpointOrigin === undefined) {
    if (fingerprint !== null) {
      fail('endpoint-missing', 'an endpoint fingerprint is present but no origin accompanies it');
    }
  } else if (parseOrigin(e.endpointOrigin) === null) {
    // A published origin carrying a path, query or userinfo would be a leak; accepting it
    // would be helping to hide one.
    fail('malformed-field', 'endpointOrigin is not a bare scheme-and-host origin');
  }

  // --- deployment identity, checked independently of the producer's summary ----------
  const id = e.identity;
  if (!id || typeof id !== 'object') {
    fail('identity-not-fresh', 'no deployment identity evidence is present');
  } else {
    const i = id as Record<string, unknown>;
    const idOk = parseBoolean(i.ok);
    const unreadable = parseBoolean(i.unreadable);
    const fromCache = parseBoolean(i.fromCache);
    const ageMs = i.ageMs === null ? null : parseCount(i.ageMs);
    if (idOk === null || unreadable === null || fromCache === null) {
      fail('identity-not-fresh', 'deployment identity fields are not all booleans');
    } else if (!idOk || unreadable) {
      fail('identity-not-fresh', 'deployment identity is not a clean, readable match');
    }
    if (i.ageMs !== null && ageMs === null) {
      fail('identity-not-fresh', 'identity ageMs is not a non-negative safe integer');
    } else if (ageMs !== null && ageMs > (options.maxIdentityAgeMs ?? 15 * 60 * 1000)) {
      fail('identity-stale', `identity evidence is ${Math.round(ageMs / 1000)}s old`);
    }
  }

  // --- money -------------------------------------------------------------------------
  const fee = parseWei(e.launchFeeWei);
  if (fee === null) fail('fee-mismatch', 'the launch fee is absent or not unsigned decimal wei');
  else if (fee !== options.expectedLaunchFeeWei) {
    fail('fee-mismatch', `fee is ${fee} wei, expected ${options.expectedLaunchFeeWei} wei`);
  }

  // The cap is CALLER-PINNED and additionally required to match what the producer says, so
  // a producer configured with a different cap is caught rather than believed.
  const cap = parseWei(e.capWei);
  if (cap === null) fail('cap-mismatch', 'capWei is absent or not unsigned decimal wei');
  else if (cap !== options.expectedCapWei) {
    fail('cap-mismatch', `cap is ${cap} wei, expected ${options.expectedCapWei} wei`);
  }

  const rolling = e.rolling24hWei === null ? null : parseWei(e.rolling24hWei);
  if (e.rolling24hWei === null || e.rolling24hWei === undefined) {
    // Unknown is not headroom.
    fail('spend-unknown', 'the authoritative rolling 24h spend is unknown');
  } else if (rolling === null) {
    fail('spend-unknown', 'rolling24hWei is not unsigned decimal wei');
  } else if (rolling >= options.expectedCapWei) {
    // Compared against the CALLER's cap, never the body's.
    fail('spend-exhausted', `rolling 24h spend ${rolling} has reached the pinned cap ${options.expectedCapWei}`);
  }

  const treasury = parseAddress(e.treasuryAddress);
  const expectedTreasury = parseAddress(options.expectedTreasury);
  if (treasury === null || expectedTreasury === null || treasury !== expectedTreasury) {
    fail('treasury-mismatch', `treasury is ${String(e.treasuryAddress)}, expected ${options.expectedTreasury}`);
  }
  const balance = e.treasuryBalanceWei === null ? null : parseWei(e.treasuryBalanceWei);
  if (e.treasuryBalanceWei === null || e.treasuryBalanceWei === undefined) {
    fail('treasury-unreadable', 'the treasury balance could not be read');
  } else if (balance === null) {
    fail('treasury-unreadable', 'treasuryBalanceWei is not unsigned decimal wei');
  } else if (balance < options.requiredTreasuryBalanceWei) {
    // A readable zero is not funding. Checked here as well as by the producer.
    fail('treasury-insufficient', `balance ${balance} wei is below the required ${options.requiredTreasuryBalanceWei} wei`);
  }

  // --- launch permission, checked for internal consistency ---------------------------
  const r = e.readiness;
  if (!r || typeof r !== 'object') {
    fail('readiness-incomplete', 'no launch readiness evidence is present');
  } else {
    const rd = r as Record<string, unknown>;
    const ready = parseBoolean(rd.ready);
    const complete = parseBoolean(rd.complete);
    const launchEnabled = parseBoolean(rd.launchEnabled);
    const whitelisted = parseBoolean(rd.whitelisted);
    const onChain = parseBoolean(rd.canLaunchOnChain);
    if (ready === null || complete === null || launchEnabled === null || whitelisted === null) {
      fail('readiness-incomplete', 'launch readiness fields are not all booleans');
    } else {
      if (!complete) fail('readiness-incomplete', 'launch readiness was reached with gaps in its evidence');
      if (!ready) fail('readiness-not-ready', 'this deployment would refuse a launch from this address');
      // The factory's own predicate. A verdict claiming ready while the chain says no is a
      // contradiction, and the narrowed local flag is not a substitute for it.
      if (onChain !== true) {
        fail('readiness-inconsistent', 'canLaunchOnChain is not true');
      }
      // The factory's guard is `launchEnabled || whitelisted`. Ready with neither is a
      // document that contradicts the contract it claims to describe.
      if (ready && !launchEnabled && !whitelisted) {
        fail('readiness-inconsistent', 'ready is true while neither the public gate nor the whitelist permits it');
      }
    }
  }

  // --- Ponsr's own pause --------------------------------------------------------------
  const expectGate = options.expectPublicLaunchEnabled ?? false;
  const gate = parseBoolean(e.publicLaunchEnabled);
  if (gate === null) fail('malformed-field', 'publicLaunchEnabled is not a boolean');
  else if (gate !== expectGate) {
    fail('public-gate-unexpected', `publicLaunchEnabled is ${gate}, expected ${expectGate}`);
  }

  /**
   * --- dependencies: shape AND outcome ------------------------------------------------
   *
   * These were validated for SHAPE only, and a caller that read just the names could
   * therefore accept a document whose `chain` row said `timed-out` sitting beside
   * `ok: true`. The producer should never emit that, but "the producer should never" is
   * the assumption a validator exists to stop making -- and this validator's whole job is
   * to be as good as the WORST input it is handed, not the one anyone had in mind.
   *
   * So: every row well-formed, every CORE dependency present exactly once, and every one
   * of them settled `ok`. A core dependency that failed, timed out or was never reached
   * is a fact about whether the evidence was gathered at all.
   */
  if (e.dependencies !== undefined) {
    if (!Array.isArray(e.dependencies)) {
      fail('malformed-field', 'dependencies is not an array');
    } else {
      const seen = new Map<string, number>();
      let wellFormed = true;
      for (const d of e.dependencies) {
        const row = d as Record<string, unknown> | null;
        if (
          !row ||
          typeof row !== 'object' ||
          typeof row.name !== 'string' ||
          !DEP_NAMES.has(row.name) ||
          typeof row.outcome !== 'string' ||
          !DEP_OUTCOMES.has(row.outcome) ||
          parseCount(row.ms) === null ||
          parseCount(row.startedAtMs) === null ||
          parseBoolean(row.shared) === null
        ) {
          fail('malformed-field', 'a dependency timing row is not a well-formed diagnostic');
          wellFormed = false;
          break;
        }
        seen.set(row.name, (seen.get(row.name) ?? 0) + 1);
        if (REQUIRED_DEPENDENCIES.has(row.name) && row.outcome !== 'ok') {
          fail('dependency-not-ok', `core dependency ${row.name} settled ${row.outcome}, not ok`);
        }
      }
      if (wellFormed) {
        for (const [name, count] of seen) {
          if (count > 1) fail('malformed-field', `dependency ${name} appears ${count} times`);
        }
        for (const name of REQUIRED_DEPENDENCIES) {
          if (!seen.has(name)) fail('dependency-missing', `core dependency ${name} is absent`);
        }
      }
    }
  }

  return done();
}

/** Marker for "this did not settle in time", kept distinct from any legitimate value. */
const TIMED_OUT: unique symbol = Symbol('timed-out');

/** Bounds a promise against an absolute deadline, without propagating anything from it. */
async function untilDeadline<T>(p: Promise<T>, deadline: number): Promise<T | typeof TIMED_OUT> {
  const remaining = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T | typeof TIMED_OUT>([
      p.catch(() => TIMED_OUT as T | typeof TIMED_OUT),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetches once and validates. No retry, ever.
 *
 * ONE ABSOLUTE DEADLINE covers headers, body read AND validation. An AbortSignal on the
 * fetch alone was not enough: `res.json()` is a separate promise, and a non-compliant fetch
 * or a body stream that never ends left the caller pending indefinitely with the abort
 * already fired. Abort is cleanup here; the race is the enforcement.
 */
export async function fetchAndValidateCore(
  baseUrl: string,
  options: ValidateOptions & { timeoutMs?: number; path?: string; fetchImpl?: typeof fetch; maxBodyBytes?: number }
): Promise<ValidationResult> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const maxBodyBytes = options.maxBodyBytes ?? 512 * 1024;
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, '')}${options.path ?? '/status/core'}`;
  const controller = new AbortController();
  const started = Date.now();
  const deadline = started + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const bail = (code: ValidationCode, why: string): ValidationResult => ({
    pass: false,
    failures: [code],
    explanations: [why],
    evidence: null,
    elapsedMs: Date.now() - started,
    authority: AUTHORITY,
  });

  try {
    const res = await untilDeadline(
      Promise.resolve(doFetch(url, { signal: controller.signal })),
      deadline
    );
    if (res === TIMED_OUT) return bail('request-failed', `the request did not complete within ${timeoutMs}ms`);
    if (!res || typeof (res as Response).status !== 'number') {
      return bail('request-failed', 'the fetch implementation did not return a response');
    }
    const response = res as Response;
    if (response.status !== 200) return bail('http-not-200', `the endpoint answered HTTP ${response.status}`);

    // Body length, where the server declares one. A body larger than this is not the core
    // document, and reading it would be spending the deadline on something else.
    const declared = Number(response.headers?.get?.('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      return bail('response-too-large', `the response declared ${declared} bytes`);
    }

    const parsed = await untilDeadline(
      Promise.resolve().then(() => response.json()),
      deadline
    );
    if (parsed === TIMED_OUT) {
      return bail('request-failed', `the response body did not arrive within ${timeoutMs}ms`);
    }
    return validateCoreEvidence(parsed, options, Date.now() - started);
  } catch {
    // Nothing from the thrown value is reported: a fetch failure message carries the URL,
    // and a base URL can carry credentials.
    return bail('request-failed', `the request did not complete within ${timeoutMs}ms`);
  } finally {
    clearTimeout(timer);
  }
}
