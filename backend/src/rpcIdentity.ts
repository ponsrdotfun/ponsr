import { ethers } from 'ethers';

/**
 * Says WHICH RPC endpoint the backend is talking to, without publishing the URL.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-25 `/status` reported `launchpad: down -- launch readiness did not answer
 * within 5000ms` while the same three contract reads, run from the operator's machine,
 * answered in half a second. The obvious question -- "is the backend even pointed at the
 * same endpoint I am?" -- could not be answered, because `RPC_URL` is a Fly secret and Fly
 * secret VALUES cannot be read back. So the one fact that would have separated "the
 * upstream is slow" from "the backend is pointed somewhere else" was unavailable to
 * everyone, including the operator who set it.
 *
 * The reason it is a secret is real and stays: RPC URLs routinely carry an API key, in the
 * path or the query, and a leaked one is someone else's bill. So this does not reveal the
 * URL. It publishes an IDENTITY -- enough to compare two endpoints and to see when one
 * changes, and not enough to call it.
 *
 * WHAT IS SAFE TO PUBLISH, AND WHY
 * --------------------------------
 *   scheme + host + port   where the traffic goes. Not a credential: anyone watching the
 *                          machine's egress sees it, and it is what an operator needs in
 *                          order to say "that is not the endpoint I tested".
 *   fingerprint            sha256 of the WHOLE url, first 12 hex. Two deployments can be
 *                          compared for equality, and a change is visible, without the
 *                          value being recoverable from the digest.
 *   credentialed           whether the URL carries anything key-shaped at all. This is the
 *                          part an operator cannot otherwise know, and it decides whether
 *                          the secrecy is protecting anything.
 *
 * The path and query are NEVER published, not even redacted piecewise -- a redaction that
 * preserves structure ("/v3/****") still leaks the provider and the shape of the key.
 */

export interface RpcEndpointIdentity {
  /** e.g. `https://rpc.mainnet.chain.robinhood.com`. Never includes path, query or userinfo. */
  origin: string;
  scheme: string;
  host: string;
  /** Present only when the URL states one explicitly. */
  port: number | null;
  /** First 12 hex of sha256 over the complete URL, including path, query and userinfo. */
  fingerprint: string;
  /**
   * Whether anything key-shaped rides in the URL: userinfo, a query string, or a path
   * segment long enough to be a token. Heuristic on purpose -- it may say true for a
   * harmless path, and that direction is the safe one to be wrong in.
   */
  credentialed: boolean;
  /** True when the endpoint is not reachable from the public internet. */
  loopback: boolean;
}

/** A URL that will not parse is a configuration error, and reporting it as an endpoint
 *  identity would invent one. Reported as unparseable instead, still without the value. */
export interface RpcEndpointUnparseable {
  origin: null;
  fingerprint: string;
  problem: string;
}

export type RpcEndpointDescription = RpcEndpointIdentity | RpcEndpointUnparseable;

export function isIdentified(d: RpcEndpointDescription): d is RpcEndpointIdentity {
  return d.origin !== null;
}

/** Digest of the exact bytes given, so two backends can be compared for equality. */
export function fingerprintUrl(url: string): string {
  return ethers.sha256(ethers.toUtf8Bytes(url)).slice(2, 14);
}

/**
 * A path segment long enough and dense enough to be a key rather than a route.
 *
 * `/v1/mainnet` is a route. `/v3/9f2c1d4e8a7b...` is a key. The threshold is deliberately
 * low: over-reporting `credentialed` costs an operator nothing, while under-reporting it
 * tells them a URL is safe to paste into a ticket when it is not.
 */
function looksLikeKey(segment: string): boolean {
  return segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment);
}

/**
 * Whether this host can only be reached from the machine itself.
 *
 * Two things a set of literal strings gets wrong, both found by testing rather than by
 * reading:
 *
 *   - `new URL('http://[::1]:8545').hostname` is `[::1]`, WITH the brackets, so a set
 *     containing `::1` never matches an IPv6 loopback URL.
 *   - loopback is the whole `127.0.0.0/8` block, not just `127.0.0.1`. `127.0.0.2` is
 *     every bit as unreachable from another host.
 *
 * Getting this wrong is not cosmetic: the point of the flag is to tell an operator that
 * the endpoint they are looking at cannot be the one serving anyone else.
 */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '[::]') return true;
  // IPv6, with or without the brackets the URL parser adds.
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  if (bare === '::1') return true;
  // The entire 127.0.0.0/8 block.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

export function describeRpcEndpoint(url: string | undefined | null): RpcEndpointDescription {
  const raw = String(url ?? '');
  const fingerprint = fingerprintUrl(raw);
  if (!raw) return { origin: null, fingerprint, problem: 'RPC_URL is empty or unset' };

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // The message deliberately does not echo the value. A malformed URL is exactly as
    // likely to be a mistyped secret as a mistyped hostname.
    return { origin: null, fingerprint, problem: 'RPC_URL is not a parseable URL' };
  }

  const port = u.port === '' ? null : Number(u.port);
  const segments = u.pathname.split('/').filter(Boolean);

  return {
    origin: `${u.protocol}//${u.host}`,
    scheme: u.protocol.replace(':', ''),
    host: u.hostname,
    port,
    fingerprint,
    credentialed:
      u.username !== '' || u.password !== '' || u.search !== '' || segments.some(looksLikeKey),
    loopback: isLoopbackHost(u.hostname),
  };
}

/** One line for a status page: identity, never the URL. */
export function summariseRpcEndpoint(d: RpcEndpointDescription): string {
  if (!isIdentified(d)) return `${d.problem} (fingerprint ${d.fingerprint})`;
  const bits = [`${d.origin}`, `fingerprint ${d.fingerprint}`];
  if (d.credentialed) bits.push('carries credentials in the URL');
  if (d.loopback) bits.push('loopback -- not reachable off this machine');
  return bits.join(', ');
}
