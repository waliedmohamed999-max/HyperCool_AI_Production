# OAuth State Security (Multi-Tenant Phase 4A)

`src/integrations/oauth-state.js` — a real, DB-backed CSRF-state mechanism for the NEW
generic multi-connection OAuth routes, alongside (never replacing) the 5 existing
per-provider in-memory `pendingStates` Maps.

## Why a second mechanism instead of reusing the in-memory Maps

Every existing OAuth module (`meta-oauth.js`, `salla-oauth.js`, `microsoft-oauth.js`,
`x-oauth.js`, `linkedin-oauth.js`) keeps its CSRF state in a plain in-memory `Map`, keyed by
the random state token, storing `{userId, at}`. That is correct and sufficient for what those
routes do — connect/refresh THE ONE default connection for that provider — and this phase
leaves all 5 completely unchanged (per the "don't rebuild existing integrations" instruction).

The new generic routes need more than `{userId, at}`: they need to know WHICH
`integration_connections` row a callback should update (so "reconnect this specific store" vs
"create a new one" both work), and they need it to survive being tenant-bound, not just
user-bound (`session.tenantId` is checked again at consume time). Extending the in-memory Map
shape to carry that would have meant touching all 5 existing modules' state-handling code for
a feature only the new routes need — instead, this is a new, additive table used only by the
new routes.

## Guarantees

- **Real, single-use.** `createOAuthState` returns a raw, high-entropy random token
  (`randomBytes(24).toString('base64url')`, ~144 bits) that goes into the redirect URL's
  `state` parameter — only its SHA-256 hash is ever stored (`state_token_hash`), mirroring the
  session-token hashing pattern already used elsewhere in this codebase (a DB read alone can
  never forge a valid state). `consumeOAuthState` marks `used_at` in the SAME call that
  validates it, so a replay of the exact same token is rejected even though the row is still
  technically within its expiry window — proven in `tests/integration-connections.test.js`'s
  replay test.
- **Tenant + user + provider bound.** `consumeOAuthState` checks, in order: the token exists
  and is unused (400 if not); not expired (400); `user_id` matches the caller (403 — an IDOR
  check, since a stolen `state` value must not be redeemable by a different user); the
  requested `integration_definition_id` matches what the token was issued for (400 — a state
  minted for Salla cannot be redeemed against a different provider's callback). The generic
  OAuth callback route ALSO checks `consumed.tenantId === session.tenantId` (403) as a second,
  independent tenant-boundary check on top of the user check.
- **Expiry-bound.** `TTL_MS = 600000` (10 minutes) — matches every existing `*-oauth.js`
  module's own in-memory expiry exactly, so the security bar is not lowered anywhere by this
  phase. Expired states are refused at consume time regardless of `used_at`; `pruneExpiredOAuthStates`
  is opportunistic housekeeping only (keeps the table from growing forever), never required
  for correctness.
- **PKCE-ready.** `pkce_verifier_enc` stores an AES-256-GCM-encrypted `code_verifier` (reusing
  the same shared `crypto.js` primitives as the Vault) for providers that require PKCE (X is
  the only one in this codebase today — see `docs/INTEGRATION_CONNECTION_ARCHITECTURE.md`'s
  per-provider notes for why X was not wired through the generic flow in this pass despite
  being the best-prepared candidate). No provider in this pass actually uses this field yet
  (Salla requires no PKCE), but the column and the encrypt/decrypt path are already correct
  and tested.

## What the generic OAuth callback route does, step by step

1. Reads `code`/`state` from the query string; 400 if either is missing (matches every
   existing OAuth callback's own validation).
2. `consumeOAuthState(db, state, {userId, integrationDefinitionId}, env)` — throws (and the
   attempt is recorded as `OAUTH_FAILED` in the audit log) on any of: unknown token, already
   used, expired, wrong user, wrong provider.
3. An explicit `consumed.tenantId !== session.tenantId` check (403) — belt-and-suspenders
   alongside the user check above, since a session's tenant is a separate concept from its
   user identity in this codebase's multi-tenant model.
4. Exchanges the real authorization code for tokens via the SAME `exchangeCodeForTokens`
   function the legacy route already uses (no second token-exchange implementation).
5. Stores the result in the Vault under `consumed.connectionId` (the specific connection this
   state was minted for — never guessed, never "the default").
6. Updates that connection to `CONNECTED` with real, resolved identity fields.
7. Records `OAUTH_COMPLETED` to the audit log, tenant-scoped.

## Verification performed

`tests/integration-connections.test.js`: round-trip resolution, single-use/replay,
cross-user IDOR, cross-provider mismatch, expiry, unknown-token rejection, and
`pruneExpiredOAuthStates` only removing genuinely expired rows.
`tests/integration-connections-api.test.js`: the same guarantees proven at the real HTTP
layer through the generic Salla OAuth start/callback routes, including a real cross-tenant
IDOR attempt against a live server (rejected 403) and a real replayed callback against a live
server (rejected 400, and — critically — the underlying token-exchange network call is never
attempted a second time).
