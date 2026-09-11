# Integration Connection Architecture (Multi-Tenant Phase 4A)

This document records the model built in Phase 4A — `Tenant → Integration Definition →
Multiple Integration Connections → Secure Credentials Vault → Connection Health → OAuth
State → Provider Account Identity` — and, as important, the compatibility strategy that let
it ship without rewriting or risking any of the 6 existing, working provider integrations.

## Why a compatibility bridge instead of a rewrite

Before this phase, every provider (Salla, WhatsApp/Meta, Microsoft 365, X, LinkedIn) had its
own OAuth module (`src/runtime/*-oauth.js`, `whatsapp.js`) reading/writing exactly one row
per `(tenant_id, provider)` in `integration_credentials` via 5 shared functions in
`src/runtime/credentials.js` (`saveCredentials`, `getCredentials`, `getCredentialsMeta`,
`updateCredentialsMetadata`, `clearCredentials`). That code was live, tested (297 passing
tests), and explicitly off-limits to a from-scratch rewrite ("don't rebuild existing
integrations", "don't break any existing integration").

Rewriting all 6 modules to a brand-new multi-connection model in one pass would have touched
every provider's token-refresh path, every webhook handler, and every existing test — a very
large blast radius for a single phase. Instead:

- `credentials.js`'s 5 functions are **unchanged in behavior and signature** (one function,
  `updateCredentialsMetadata`, gained a 5th, optional `env` parameter — every existing caller
  that omits it behaves exactly as before).
- Each of those functions, after doing its real (unchanged) work, calls into
  `src/integrations/legacy-sync.js` as a **best-effort side effect**, wrapped in `try/catch`
  so a sync failure can never break the legacy write/read that triggered it. This mirrors
  every legacy write into a real `integration_connections` + vault row.
- `src/integrations/migration.js` runs once at boot to copy any credential that was already
  connected BEFORE this phase shipped, so `integration_connections` is a superset of
  `integration_credentials` from the very first boot after upgrade, not just going forward.

The result: `integration_connections` is genuinely the up-to-date source of truth for
anything that only needs identity/status (webhook routing, the scheduler's connection jobs),
while all 6 existing provider modules keep reading and writing the legacy table exactly as
they always have. Zero regression risk to the 297 tests that already proved those modules
work; multi-connection support is proven end-to-end via one concrete provider (Salla — see
below) rather than simulated everywhere at once.

## Data model

```
integration_definitions        -- GLOBAL: what an integration is, never a tenant's connection to it
  id, slug, name_ar/en, category, description_ar/en,
  auth_type IN ('OAUTH2','API_KEY','ACCESS_TOKEN','CUSTOM','NONE'),
  icon_key, capabilities (json array), is_available

integration_connections        -- PER TENANT, MULTIPLE per (tenant, provider)
  id, tenant_id, integration_definition_id, name,
  status IN ('NOT_CONFIGURED','CONNECTING','CONNECTED','DEGRADED','ERROR',
             'TOKEN_EXPIRED','PERMISSION_MISSING','DISCONNECTED'),
  external_account_id/type/name/metadata, scopes,
  connected_by, connected_at, last_health_check, last_success_at,
  last_error_at, last_error_code, last_error_message_safe,
  is_default

integration_credentials_vault  -- one encrypted row per connection
  id, tenant_id, connection_id (UNIQUE), credential_type,
  encrypted_payload, encryption_version, created_at, updated_at, last_rotated_at

oauth_states                   -- DB-backed, single-use, tenant+user+provider bound
  id, tenant_id, user_id, integration_definition_id, connection_id,
  state_token_hash (UNIQUE), pkce_verifier_enc, return_url, expires_at, used_at
```

### `auth_type` — extracted from the real implementation, never assumed

| Provider | auth_type | Real implementation |
|---|---|---|
| `anthropic`, `openai` | `API_KEY` | `src/runtime/llmProvider.js` — pure env-var keys, resolved fresh per call, **no persisted credential/connection model before this phase** |
| `salla` | `OAUTH2` | `src/runtime/salla-oauth.js` — authorization-code flow, no PKCE |
| `microsoft365` | `OAUTH2` | `src/runtime/microsoft-oauth.js` — authorization-code flow |
| `x` | `OAUTH2` | `src/runtime/x-oauth.js` — PKCE is **mandatory** (X rejects a code exchange without a `code_verifier`), unlike every other OAuth2 provider here |
| `linkedin` | `OAUTH2` | `src/runtime/linkedin-oauth.js` — authorization-code flow |
| `meta` | `OAUTH2` | `src/runtime/meta-oauth.js` — Facebook Login for Business; **one grant resolves Page + Instagram + WhatsApp assets together** |
| `whatsapp` | *(no separate row)* | See "Why WhatsApp has no separate definition row" below |
| `canva` | `NONE`, `is_available=0` | Grepped the entire codebase — no real API call, OAuth flow, or connector exists anywhere; only an env var name (`CANVA_API_KEY`) referenced as a placeholder in status displays. Listed honestly as not implemented rather than faking a connect flow. |

### Why WhatsApp has no separate definition row

This codebase's real Meta OAuth grant (`exchangeCodeAndResolveAssets`) resolves Page +
Instagram + WhatsApp assets from ONE Business Login — there has never been a separate
`whatsapp`-provider row in `integration_credentials`. Creating a second, duplicate `whatsapp`
definition/connection would misrepresent the actual architecture and risk two connections
drifting out of sync. `legacy-sync.js` deliberately does not mirror a `whatsapp` connection;
WhatsApp's capability (phone number id, display number) is read from the mirrored `meta`
connection's metadata — exactly as `runtime/whatsapp.js` already reads it via
`getCredentialsMeta(db,'meta')`.

## Multiple connections: uniqueness rules

`integration_connections` deliberately has **no** `UNIQUE(tenant_id, integration_definition_id)`
constraint — that was the old model. What IS enforced, by two partial unique indexes:

1. `(integration_definition_id, external_account_id) WHERE external_account_id IS NOT NULL`
   — the same real external account (a Salla merchant id, a WhatsApp phone number id, ...)
   can never belong to two different tenants. This is a real security boundary, not a
   convenience constraint — it does not apply while `external_account_id` is still NULL
   (expected during a connect flow, before identity is resolved).
2. `(tenant_id, integration_definition_id) WHERE is_default=1` — exactly one default
   connection per tenant per provider, swapped atomically by `setDefaultConnection`
   (`BEGIN IMMEDIATE` → clear old default → set new → `COMMIT`).

## Connection resolution: `resolveProviderAccount`

Every legacy (connection-unaware) call site needs a single answer to "which connection do I
use?". `src/integrations/connections.js`'s `resolveProviderAccount`:

- 0 connections → `null` (not configured — matches today's behavior exactly).
- 1 connection → that one (safe, unambiguous, no need for a default flag at all).
- 2+ with a real default set → the default.
- 2+ with **no** default → throws `{code:'CONNECTION_SELECTION_REQUIRED', status:409,
  connections:[...]}` rather than ever guessing by picking the first row.

## Connection Health: real test-or-nothing

`src/integrations/health.js`'s `testConnectionHealth` reuses the EXACT read-only test
functions this codebase already had and had already proven correct
(`testAnthropicConnection`/`testOpenAIConnection`/`testSallaConnection` from `connectors.js`;
`testWhatsAppConnection`, `testMicrosoftConnection`, `testXConnection`,
`testLinkedInConnection`; a `resolveMetaAccessToken` check for Meta) — never a new provider
call, and never one that sends a message, publishes a post, or creates/deletes anything. A
connection is only ever reported `CONNECTED` after this real check succeeds; a saved
credential alone is not enough (proven in `tests/integration-connections.test.js`).

For Salla specifically, the health check reads **this exact connection's own** vault
credential — genuine per-connection testing, proven with two independent Salla connections
each returning their own distinct token to the mocked test call. For every other provider,
the health check reuses that test function's own default-credential resolution (the same one
the pre-existing `/api/integrations/:id/test` route already used) — correct for today's
sole/default connection of that type. Testing a hypothetical SECOND, non-default connection
of the same non-Salla provider is a known, documented scope boundary for this pass (see
"What this phase deliberately does not do" below), not a bug.

## The multi-connection proof-of-concept: Salla

Rather than attempt all 6 providers' full multi-connection UX in one pass, this phase proves
the model end-to-end through ONE provider — Salla, chosen because it is the simplest OAuth2
flow (no PKCE) and the spec's own explicit multi-store target ("Main Store" + "Riyadh Store"
as two independent connections for one tenant):

- `src/runtime/salla-oauth.js`'s `createAuthorizeUrl(env, userId, externalState=null)` gained
  a 3rd, optional parameter: when supplied (a real token from `oauth-state.js`), it builds the
  exact same authorize URL but never touches its own in-memory `pendingStates` Map. The
  existing single-connection route (`/api/integrations/salla/oauth/start`) never passes this
  argument, so it is completely unchanged.
- New generic routes at `GET/POST /api/integrations/oauth/salla/start` and
  `/api/integrations/oauth/salla/callback` (deliberately a SEPARATE path from
  `/api/integrations/salla/oauth/...` so the two flows never collide) create-or-reuse a
  specific `integration_connections` row, mint a real DB-backed OAuth state bound to it, and
  on callback store the exchanged tokens into THAT connection's own vault credential.
- Proven in `tests/integration-connections-api.test.js`: two independent connect flows create
  two distinct `CONNECTED` connections for the same tenant, each with its own encrypted
  credential; reconnecting with `?connectionId=` refreshes the existing row instead of
  creating a new one; a state token cannot be replayed or redeemed by a different user.

Every other OAuth provider's generic route (`/api/integrations/oauth/:slug/start`) responds
`501` and points back at its existing dedicated route — an explicit, honest scope boundary,
not an oversight.

**Known limitation, inherited from before this phase:** neither the legacy Salla OAuth
callback nor the new generic one resolves a real merchant id at connect time — there is no
live Salla app in this environment to verify the exact "fetch the merchant profile" endpoint
against. `external_account_id` stays NULL until the self-registration bootstrap in
`webhook-tenant-resolver.js` resolves it from the first real webhook (see
`docs/WEBHOOK_TENANT_ROUTING.md`). With two or more simultaneously-unresolved Salla
connections (e.g., two stores connected back-to-back before either receives a webhook), the
bootstrap correctly refuses to guess and both stay unresolved until each receives at least
one real webhook — sequential connects (the realistic case) resolve fine.

## What this phase deliberately does not do

- **Full multi-connection UX for WhatsApp/Meta/Microsoft/X/LinkedIn.** Only Salla is wired
  through the new generic OAuth routes. The other 5 remain on their existing single-connection
  dedicated routes, mirrored into a single "default" `integration_connections` row by the
  compatibility bridge. See the per-provider notes below for the concrete design each would
  need.
- **Multi-store Salla catalog sync.** `/api/salla/sync` still calls `resolveSallaAccessToken`
  (the legacy single/default-connection resolver), so only one store's catalog can be synced
  today regardless of how many Salla connections exist. If/when per-connection catalog sync is
  built, `products`'s primary key (currently `(tenant_id, id)`, `id` being Salla's own product
  id) would need to become `(tenant_id, connection_id, id)` to avoid two stores' products with
  the same numeric id silently overwriting each other for the same tenant. Not built now
  because no route yet lets a caller choose which connection to sync — building the schema
  change without the route that would use it would be speculative.
- **Agent Tool Mapping / tool-to-connection assignment** — explicitly Phase 4B.
- **A hard delete for connections.** `deleteConnection` is an alias for `disconnectConnection`
  (soft delete → `status='DISCONNECTED'`) because no feature yet writes a real `connection_id`
  onto a business/webhook/audit record (that begins in Phase 4B's tool mapping) — there is
  nothing to dependency-scan yet, so hard-delete would only remove the option to add that scan
  correctly later.
- **A Control Center UI, full Tenant Onboarding, Billing, or White-label** — explicitly out of
  scope per this phase's own instructions; the routes below are backend-only.

## Per-provider multi-connection design notes (not built, documented for Phase 4B+)

- **WhatsApp / Meta** — one Business Login grant already resolves multiple assets (Pages,
  Instagram, phone numbers) at once; a real "second Meta connection" would mean a second,
  separate Business Login grant (e.g., a second Facebook Business Manager). The connection
  model already supports this (multiple `meta`-definition connections per tenant); what is
  missing is a route to start a SECOND Meta OAuth grant without disturbing the first, plus UI
  to pick which connection's WhatsApp number a given send should use.
- **Microsoft 365** — a second connection would be a second mailbox/tenant-app-registration.
  The mail subscription renewal CONNECTION_JOB (Phase 45, see `docs/TENANT_SCHEDULER.md`)
  already iterates every non-disconnected `microsoft365` connection per tenant, so multiple
  Microsoft connections would already renew correctly today — only the OAuth start/callback
  route itself is not yet generalized past the single dedicated route.
- **X** — PKCE's `code_verifier` must stay server-side and connection-specific; `oauth-state.js`
  already supports storing an encrypted PKCE verifier per state row (`pkce_verifier_enc`), so
  X is actually the best-prepared non-Salla provider for the generic flow — wiring it is
  mechanical (add `'x'` to the generic route's allow-list, add PKCE generation) once Phase 4B
  needs it.
- **LinkedIn** — a tenant may administer multiple Company Pages; the real design choice is
  whether "one connection per LinkedIn app-user, with multiple resolvable organizations" or
  "one connection per organization" better fits `resolveProviderAccount`'s single-account
  contract. This phase does not decide it — `linkedin-oauth.js`'s existing
  `resolveAdministeredOrganizations` already returns a list, so the model can go either way;
  deferred to when Phase 4B's tool mapping needs multi-organization publishing.
- **Canva** — no real implementation exists (see `auth_type` table above); nothing to design
  until a real Canva integration exists.

## Verification performed

- `tests/integration-connections.test.js` (24 tests): definitions seeding, multi-connection
  creation/defaults/tenant isolation, the cross-tenant external-account uniqueness boundary,
  `resolveProviderAccount`'s 4 resolution paths, vault encryption-at-rest, vault tenant
  isolation, OAuth state round-trip/replay/IDOR/provider-mismatch/expiry, the legacy-sync
  bridge (mirror + disconnect + idempotency + unmapped-provider skip), the migration function,
  and connection health (not-configured, provider-failure isolation, per-connection Salla
  credential isolation).
- `tests/integration-connections-api.test.js` (9 tests): the full generic HTTP surface —
  definitions/connections CRUD, tenant-isolation IDOR matrix (404 on every op), the API-key
  test-then-store flow (reject-then-accept, secret never echoed), health test route, and the
  full Salla generic OAuth multi-store proof (two connections, replay refusal, reconnect-
  reuses-existing, cross-tenant state IDOR, 501 for unwired providers).
- `webhook-tenant-resolver.js`'s cutover and the scheduler's Microsoft connection-job cutover
  were verified against the existing `webhook-tenant-routing.test.js` and `scheduler.test.js`
  suites (updated where they seeded the legacy table directly) plus the new suites above.
- Migration verified against a real, live copy of `data/hypercool.sqlite` (safely snapshotted
  via `VACUUM INTO` — a live server process was running against the original file, which was
  never opened for writing directly): `PRAGMA integrity_check` = `ok` before and after, the
  app boots cleanly against the copy, all 4 new tables are created, `integration_definitions`
  seeds exactly 9 rows, and existing `users`/`tenants` row counts are unchanged.
- Full suite: 330/330 green (297 pre-existing + 24 + 9 new).

## Phase 4B update: connection_mode + the legacy-lookup tenant bug this phase's tests found

`IntegrationDefinition` now carries a derived `connectionMode` field (`MULTI`/`SINGLE`/
`UNAVAILABLE`) — see `docs/CONNECTION_AWARE_RUNTIME.md`'s matrix for the honest, code-derived
per-provider answer and why `whatsapp`/`meta`/`microsoft365`/`x`/`linkedin` are `SINGLE`
despite `integration_connections` structurally allowing many rows (the constraint is the
`integration_credentials` PRIMARY KEY(tenant_id, provider) one layer down, not this table).

Phase 4B's own multi-tenant tests also surfaced a real bug in this phase's compatibility
bridge: several legacy OAuth resolvers (`resolveMetaAccessToken`, `resolveMicrosoftAccessToken`,
`resolveXAccessToken`, `resolveLinkedInAccessToken`, and the publish helpers built on them)
never threaded a `tenantId` through to `getCredentials`/`getCredentialsMeta`, so they broke
(`TENANT_CONTEXT_REQUIRED`) the moment a real second tenant existed. Fixed in Phase 4B — see
`docs/CONNECTION_AWARE_RUNTIME.md`'s "Legacy provider lookup refactor" section for the full
list of what changed and what remains a documented, temporary fallback (single-workspace admin
routes only).
