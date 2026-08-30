# Ponsr Account Phase B Contract

Status: read-only authentication candidate implemented in PR #25; deployment configuration and production-compatible OAuth/Privy continuity proof remain unavailable. Financial actions, external wallet linking, and production activation are not implemented.

## Identity and wallet invariant

1. OAuth must return and server-verify the stable numeric X user ID. A mutable handle, avatar, display name, browser parameter, or client assertion is not identity.
2. The numeric X user ID must resolve to the exact existing Privy embedded wallet already created by Ponsr for that identity.
3. Login, retry, restore, concurrent requests, database recovery, and provider timeout must never create a second wallet.
4. The browser must use the supported Privy access/recovery model. No private key is exported, imported, logged, returned by an endpoint, or exposed to diagnostics.
5. Treasury and backend launch signing authority remain separate and are never inherited by an account session.

## Proposed authenticated API boundary

All responses use `Cache-Control: private, no-store`, reject cross-origin credentials, and return explicit `loading | authenticated | unauthenticated | unavailable | error` state rather than substituting empty values.

### `GET /api/account/session`

Returns only after server-side session validation:

```json
{
  "state": "authenticated",
  "session": { "expiresAt": "RFC3339", "csrfRequired": true },
  "identity": { "xUserId": "decimal string", "handle": "current display metadata", "verifiedAt": "RFC3339" },
  "wallet": { "address": "checksummed EVM address", "provider": "privy", "continuity": "existing-verified" }
}
```

The endpoint must never create a wallet. `continuity` cannot be inferred from a successful OAuth response; it requires an atomic read of the existing identity-to-wallet binding.

### OAuth start/callback/logout

- `POST /api/auth/x/start`: issues an HttpOnly, Secure, SameSite cookie plus one-time state, PKCE verifier, issued-at, and expiry.
- `GET /api/auth/x/callback`: atomically validates and consumes state, exchanges the code with PKCE, then verifies the stable numeric X user ID through server-side `GET /2/users/me` before rotating into an authenticated session. X OAuth 2.0 PKCE does not provide an OIDC ID token, so fake nonce/issuer/audience checks are not claimed.
- `POST /api/auth/logout`: requires CSRF protection, revokes the server session, expires cookies, and leaves wallet bindings unchanged.
- The pending state is atomically single-use; even an invalid callback consumes it. Authorization codes are exchanged once and the resulting access token is never persisted.

### `GET /api/account/launches`

Returns launches linked by the authoritative immutable creator identity mapping. It must not infer ownership from a current handle, connected browser wallet, token label, or transaction sender.

### `GET /api/account/fees`

Returns separate accounting states:

- `accrued`: observed creator share, not necessarily available;
- `claimable`: proven escrow amount currently available;
- `queued` / `processing`: initiated but not reconciled;
- `paid` / `claimed`: only after successful receipt, destination custody, and accounting reconciliation.

Each row includes chain ID, token, curve, splitter, escrow, source block/time, observation state, transaction hash when present, receipt state, and reconciliation state. User income language is creator trading fees, never dividends or guaranteed earnings.

### `GET /api/account/wallet`

Returns the exact existing embedded wallet address, provider continuity evidence, balance source/freshness, and linked-wallet summaries. Receive is read-only address/QR. It grants no signing authority by itself.

### External wallet challenge

- `POST /api/account/wallet-links/challenge`: returns nonce, exact domain, URI, numeric X account binding, chain ID, issued-at, expiry, and one-time challenge ID.
- `POST /api/account/wallet-links/verify`: verifies the signature, exact message fields, nonce, domain, chain, expiry, intended session, and replay status before linking.
- A challenge is consumed atomically whether verification succeeds or reaches its retry limit.

## Session controls

- HttpOnly, Secure, SameSite cookies; short idle and bounded absolute expiration.
- CSRF token or equivalent origin-bound protection for every mutation.
- Session rotation after callback, privilege change, and recovery.
- Server-side revocation, logout, replay detection, rate limits, and audit records.
- No credentials, OAuth tokens, provider tokens, or wallet secrets in browser storage, URLs, analytics, logs, or public HTML.
- Recovery requires fresh identity verification and cannot alter the immutable existing wallet binding without a separately audited migration.

## Financial mutation boundary

Receive may become available once the verified address is returned. Claim, send, and swap remain separate releases:

- simulation and exact chain/address checks;
- allowance, slippage, fee, destination, and amount clarity;
- explicit signing UX using user-scoped authority only;
- bounded retries with idempotency keys;
- receipt, nonce, destination custody, balances, and journal reconciliation;
- no paid/claimed/sent/swapped state from transaction intent alone.

Automatic claim may be permissionless or keeper-driven only when funds cannot be redirected. Treasury authority is never available to browser diagnostics or account sessions.

## Acceptance evidence required before enabling Sign in with X

1. Numeric X user ID is stable and server-verified.
2. Existing Privy embedded wallet continuity is proven against production-compatible provider behavior.
3. Concurrent login/restore tests prove the system will never create a second wallet.
4. Session expiration, CSRF, state/nonce replay, logout, recovery, and account-switch tests pass.
5. External wallet linking challenge is domain/chain/session bound and replay-safe.
6. Existing launches preserve immutable creator recipients; future recipient choice is explicit and auditable.
7. No private key or treasury signing authority crosses the account boundary.
8. Financial states reconcile receipt and custody before reporting success.

Until all evidence passes, the public website must retain the current `Account connection unavailable` state and all private or financial actions remain disabled.
