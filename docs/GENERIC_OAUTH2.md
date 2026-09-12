# Generic Approved OAuth2 Framework (Phase 6G)

Before this phase, adding a NEW OAuth2 provider meant writing a dedicated `src/runtime/<slug>-
oauth.js` module (as Salla and Zid both did) and adding it by hand to `GENERIC_OAUTH_PROVIDERS`
in `application.js`. This phase makes that unnecessary for a new *GENERIC_REST* connector: a
Platform Admin can now define a real, working OAuth2 flow **entirely through the Integration
Builder UI**, with zero code change to `application.js`, `control-center.js`, or the Agent
Runtime.

## What a connector can declare

`src/connectors/dynamic/builder.js`'s `validateOAuth2Config` accepts, on a `GENERIC_REST`
connector's `auth` block when `auth.type === 'OAUTH2'`:

| Field | Meaning | Validated how |
|---|---|---|
| `authorizeUrl` | The provider's real authorization endpoint | Must be `https://`, SSRF-checked (`validateOutboundUrl`) at save time — matches `src/connectors/core/manifest.js`'s own OAUTH2 field name exactly, one shared vocabulary |
| `tokenUrl` | The provider's real token endpoint | Same HTTPS + SSRF check |
| `identityEndpoint` | Optional — a "who am I" endpoint to resolve the connected account's real id/name | Same HTTPS + SSRF check, only if present |
| `scopes` | Array of scope strings | Must be an array |
| `pkce` | Boolean — whether to generate a PKCE `code_challenge`/`code_verifier` (S256 only, no `plain` fallback) | — |
| `clientAuthMethod` | `'body'` (client_id/secret in the token request body) or `'basic'` (HTTP Basic auth header) | Must be one of these two |
| `clientIdEnvKey` / `clientSecretEnvKey` | The NAME of an environment variable holding the real client id/secret — **never the secret value itself** | Must match `^[A-Z][A-Z0-9_]*$` |
| `tokenFieldMappings` | Optional — override the token response's field names (default `access_token`/`refresh_token`/`expires_in`) for a provider that uses different names | — |

`createDraftConnector`/`updateDraftConnector` run this validation at SAVE time (never only at
publish); `core/manifest.js`'s own `validateManifest` independently re-checks `authorizeUrl`/
`tokenUrl` are real `https://` URLs at hydrate time too — the same "never trust the DB merely
because an admin wrote it" defense-in-depth this platform already applies everywhere else.

## No plaintext secret, ever

The connector definition stores only the two env var **names**. The real values are resolved at
call time from `process.env` by `src/runtime/generic-oauth2.js`'s `genericOAuth2Configured`/
`clientAuth` — exactly the same posture Zid/Salla's own hand-written modules already use
(`ZID_CLIENT_ID`/`ZID_CLIENT_SECRET` as real env vars, never stored anywhere in the database).
This platform has no separate "platform secrets vault" distinct from process env for this
purpose — env-var-by-reference is the existing, established mechanism.

## The one shared route pair

`GET /api/integrations/oauth/:slug/start` and `GET /api/integrations/oauth/:slug/callback`
(`application.js`) already existed for Salla/Zid. A new `resolveOAuthProvider(slug)` helper,
shared by these two routes AND the `reconnect` route, now resolves a "provider" object two ways:

1. **`GENERIC_OAUTH_PROVIDERS[slug]`** — the fixed, code-reviewed map of Salla/Zid's own
   hand-built exceptions (Part 23 of this phase's own spec: "built-in exceptions only if the
   protocol genuinely differs" — true for both: Zid's Bearer+X-Manager-Token header pair and
   Salla's own quirks are adapter-level facts, not something the generic framework should try to
   parameterize away).
2. **A real, `PUBLISHED`, `GENERIC_REST` definition whose `auth.type === 'OAUTH2'`** — built on
   the fly from that definition's own stored config, via `createGenericAuthorizeUrl`/
   `exchangeGenericCodeForTokens`/`resolveGenericIdentity` (`runtime/generic-oauth2.js`).

Neither route branches on a specific slug anywhere in this new path — a brand-new OAuth2
connector defined tomorrow through the Builder works immediately, with zero deploy.

## OAuth state, security, and PKCE

Reuses the EXISTING `oauth_states` table/`createOAuthState`/`consumeOAuthState`
(`src/integrations/oauth-state.js`) unchanged — tenant+user+connector-bound, single-use,
10-minute TTL, encrypted PKCE verifier storage already built in Phase 6D. The start route now
generates a real `code_verifier` (32 random bytes, base64url) whenever the connector declares
`pkce: true`, threads it through `createOAuthState`'s existing `pkceVerifier` field, and the
callback route retrieves it via `consumeOAuthState`'s return value — no new state mechanism, no
weakening of the existing one-time/tenant-bound/expiry guarantees. State replay and cross-tenant
redemption are refused by the SAME code path Salla/Zid already exercise (proven in
`tests/integration-connections-api.test.js`); this phase's own `tests/generic-oauth2.test.js`
proves the new code-driven path end-to-end via a real HTTP round trip rather than re-proving the
shared state machinery a second time.

## Token refresh

`resolveGenericOAuth2Credential` (`runtime/generic-oauth2.js`), wired into `genericRestAdapter`'s
`executeAction`/`healthCheck`: before every real call, if the stored token expires within 60
seconds (or has no `expiresAt` at all — treated as still-fresh, matching a provider that never
returns one) it is refreshed on demand and the new access/refresh token pair is persisted back to
that EXACT connection's Vault credential — never a cross-connection fallback, matching Part 24's
requirement precisely.

## What's NOT built

- **No client-credentials or implicit grant support** — only the standard Authorization Code
  grant (with optional PKCE) is implemented; a provider requiring a different OAuth2 grant type
  is not supported by this framework.
- **No automatic scope-upgrade / incremental-auth flow** — if a tenant's granted scopes stop
  covering what a tool needs, the fix today is a full reconnect (see Reauth UX), not an
  incremental consent request.
- **No UI to test the OAuth2 config before actually connecting a real account** — a Platform
  Admin discovers a misconfigured `authorizeUrl`/`tokenUrl`/env var only when a real tenant
  attempts to connect (the failure is honest and safe — `GENERIC_OAUTH2_NOT_CONFIGURED`/
  `INVALID_PROVIDER_RESPONSE` — but there is no dry-run/validate button in the wizard).

## Proven by

`tests/generic-oauth2.test.js` (9 tests): authorize URL construction (including PKCE), body vs.
Basic client auth, a real 401 classifying as `CREDENTIALS_REJECTED`, refresh, identity
resolution, on-demand refresh-then-persist (only when actually near expiry, verified it does NOT
fire on a fresh token), and a full real HTTP round trip — create a brand-new OAuth2 connector via
the Builder, publish it, start→callback through the real routes with a mocked outbound
`fetcher`, confirm the resulting connection is `CONNECTED` with the real identity resolved and
correctly pinned to version 1 — plus the `reconnect` route fix (previously hardcoded to refuse
every provider except Salla).
