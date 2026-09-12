# Generic OAuth2 Framework — Status (Phase 6F)

**Not built.** This document exists to record the honest scope decision, so a future phase
doesn't have to re-discover it.

## What exists today

Two real, hand-built, code-reviewed OAuth2 flows: Salla (Phase pre-6, `src/runtime/
salla-oauth.js`) and Zid (Phase 6E, `src/runtime/zid-oauth.js`). Both share the SAME generic,
multi-connection OAuth *infrastructure* — OAuth State (`src/integrations/oauth-state.js`, one-
time, tenant/user/connector/connection-bound, expiring), the Vault, and one shared pair of
routes in `application.js` (`/api/integrations/oauth/:slug/start|callback`) dispatching through
a small, fixed allowlist (`GENERIC_OAUTH_PROVIDERS`). Adding a THIRD real OAuth2 provider today
means writing one more small `*-oauth.js` module (following `zid-oauth.js`'s shape) and adding
one allowlist entry — a real, working, but still per-provider, code-defined pattern.

## What Phase 6F's spec asked for, and why it wasn't built

The request was a fully **data-driven** OAuth2 framework: a Platform Admin defines an approved
OAuth2 connector entirely through the Builder UI — authorization URL, token URL, scopes, PKCE,
identity endpoint, refresh behavior — with no code file, the same way a `GENERIC_REST` connector
is defined today.

This was not attempted this phase because it is qualitatively riskier than the REST case:

- A generic REST connector's "auth" is a static header value (API key/bearer/basic) — trivial to
  validate and impossible to misuse for anything beyond what the header already grants.
- A generic OAuth2 connector's "auth" is an entire **live authorization flow**: an admin-supplied
  authorize/token/identity URL set, a refresh contract that varies per real provider (some
  require `redirect_uri` on refresh, some don't; token lifetimes and rotation behavior differ;
  identity-resolution response shapes differ), and a state/callback surface that, if the generic
  validation missed one edge case, could plausibly be tricked into treating an admin-supplied
  URL as more trustworthy than it is (open-redirect-adjacent risk class, not just SSRF).

Building this safely needs its own dedicated, careful pass — SSRF-validating the admin-supplied
URLs is necessary but not sufficient; the harder work is the refresh/identity contract
abstraction itself. Rather than ship a rushed, partially-tested generic OAuth2 system, this
phase left the existing, real, per-provider pattern in place and documented the gap honestly.

## If a future phase builds this

Recommended shape, so it doesn't collide with what exists:

- A NEW `auth.type: 'OAUTH2_GENERIC'` (or similar) alongside the existing `NONE/API_KEY/
  BEARER_TOKEN/BASIC` set for `GENERIC_REST` — never widening `AUTH_TYPE.OAUTH2`'s existing
  meaning (used by the real, hand-built Salla/Zid manifests).
- The SAME `GENERIC_OAUTH_PROVIDERS`-style allowlist dispatch in `application.js`, but resolving
  its `createAuthorizeUrl`/`exchangeCodeForTokens`/`resolveIdentity` functions generically from
  the connector definition's own stored config, instead of one hand-written module per provider.
- Every admin-supplied URL validated through the EXISTING `validateOutboundUrl` (SSRF module) at
  save time, exactly like a `GENERIC_REST` connector's `baseUrl` already is.
- `PUBLISHED`-only: a `DRAFT` OAuth2 connector definition must never be reachable via the real
  OAuth start/callback routes (Part 29 of the original spec — "only PUBLISHED platform-managed
  definitions may use generic OAuth").
