# Universal Integration Platform — Dynamic Connector Definitions (Phase 6D)

## What this phase actually built

`integration_definitions` (the ONE canonical connector-definition table, alive since Phase 4A)
is now data-driven. A Platform Admin can create, edit, validate, and publish a brand-new
connector — actions, webhooks, health check, auth — entirely through the Builder backend
(`src/connectors/dynamic/builder.js`) and its HTTP routes in `application.js`. **No code file is
ever written, no `application.js` route is ever hand-added, no marketplace card is ever
hardcoded for a new connector.** Once published, it behaves identically to a code-defined
connector (Salla, Anthropic, ...) everywhere: the tenant catalog, the Generic Tool resolution
path, the Agent Runtime, the webhook pipeline, the Control Center summary.

This is deliberately **not** a second, parallel model. Every design decision below chose to
extend the one table/one registry that already existed over inventing a new one.

## Why one table, not two

The spec explicitly considered a parallel `connector_definitions` table and rejected it: Salla,
Anthropic, and OpenAI already live in `integration_definitions`, and every existing reader
(`listIntegrationDefinitions`, the Control Center summary, the tenant catalog, connection
creation) already queries that one table by slug. A second table would mean either (a)
duplicating every one of those readers to check both tables, or (b) silently missing dynamic
connectors in half of them. Instead, `installIntegrationDefinitions` (`src/integrations/
definitions.js`) grew new, additive columns via guarded `ALTER TABLE ADD COLUMN` (each checked
against `PRAGMA table_info` first — a no-op on a database that already has them, safe to run on
every boot):

| Column | Purpose |
|---|---|
| `status` | `DRAFT` \| `PUBLISHED` \| `DISABLED`. Built-ins are always `PUBLISHED`. |
| `version` | Bumped on every publish after the first. |
| `adapter_type` | `BUILT_IN` \| `AI_PROVIDER` \| `GENERIC_REST`. Decides adapter resolution (see below). |
| `adapter_key` | Whitelist key into the STATIC registry for `BUILT_IN`/`AI_PROVIDER` — never a module path or `require()` target. |
| `connection_mode_override` | The dynamic definition's own `SINGLE`/`MULTI` (built-ins keep using the existing `connectionModeFor()` map). |
| `is_system` | `1` for the 9 seeded built-in rows — never hard-deletable, never editable via the Builder. |
| `created_by_user_id` | The Platform Admin who authored it. |
| `published_at` | Set on first publish; drives version-bump logic (first publish keeps version 1; every later publish increments it). |
| `rest_config` | JSON: `{baseUrl, allowHttp, allowedHosts, tenantConfigurableHost, health}` — no secrets. |
| `auth_config` | JSON: real auth type + non-secret config (`headerName`, ...) — no secrets. Chosen over widening the existing `auth_type` CHECK constraint (`OAUTH2`/`API_KEY`/`ACCESS_TOKEN`/`CUSTOM`/`NONE`), which would require a risky live-table rebuild for a value like `BEARER_TOKEN`/`BASIC` that only a dynamic connector uses. `auth_type` stays `'CUSTOM'` for these rows, for legacy display/filtering compatibility only — `auth_config.type` is the real source of truth. |

`seedIntegrationDefinitions`'s `INSERT ... ON CONFLICT(slug)` always re-asserts
`status='PUBLISHED', version=1, is_system=1` for the 9 known built-in slugs on every boot — it
can never touch a Builder-authored row, since `ON CONFLICT(slug)` only fires for those 9 exact
slugs.

Two new CHILD tables (`src/connectors/dynamic/store.js`) hold what a `GENERIC_REST` definition
needs beyond a single row: `connector_actions` and `connector_triggers`, one row per action/
trigger, keyed by `(connector_definition_id, slug)`. A third, `connector_definition_versions`,
holds immutable published-manifest snapshots — see `docs/CONNECTOR_VERSIONING.md`.

## Hydration: from rows to a real ConnectorManifest

`src/connectors/dynamic/hydrate.js`'s `buildRawManifest(db, definition)` assembles a manifest
object shaped exactly like a code-defined one (Phase 6A's `ConnectorManifest`) from the
definition row + its `connector_actions`/`connector_triggers` rows. `hydrateAndValidate(db,
slug)` then runs it through the REAL validator — `validateWebhookManifest` if it has triggers,
else `validateRestManifest` if `adapterType==='GENERIC_REST'`, else the base `validateManifest`.
**This is the same validator `publishConnector` uses to decide whether a publish is even
allowed** — there is no separate, weaker "Builder-only" check; a connector that would fail at
runtime resolution fails at save/publish time too.

## Adapter resolution: the whitelist, not a black box

`src/connectors/dynamic/registry.js`'s `resolveConnectorDynamic(db, slug, {connectorVersion})`
is the ONE function `ConnectorRuntime` (`core/runtime.js`) and the generic webhook pipeline
(`generic-webhook/webhook.js`) call to get a `{manifest, adapter}` pair — replacing the old
default of the static-only `registry.js`:

- `adapterType === 'BUILT_IN' | 'AI_PROVIDER'` → delegates straight to the EXISTING static 6A
  registry (`src/connectors/registry.js`) via `adapter_key`. Salla/Anthropic/OpenAI's real,
  hand-written manifests and adapters are used completely unchanged — critical, because their DB
  rows have **no** `connector_actions` rows at all; hydrating them from the DB would produce an
  empty, wrong manifest. This is a hard architectural rule, not an optimization: dynamic
  hydration only ever applies to `GENERIC_REST`.
- `adapterType === 'GENERIC_REST'` → hydrates from the DB. If `connectorVersion` is given (a
  connection pinned to a specific published version), it reads the frozen snapshot from
  `connector_definition_versions` instead of the live row — see `docs/CONNECTOR_VERSIONING.md`.
  A `DISABLED` definition resolves to `null` (nothing executes against it). A definition that
  isn't `PUBLISHED` and has no matching snapshot also resolves to `null`.
- Anything else → `null`.

No DB column ever holds a `require()` path or file path. The only things a dynamic definition
can point to are (a) a fixed, code-reviewed adapter (`genericRestAdapter`, shared by every
`GENERIC_REST` connector) or (b) a whitelisted static adapter key. This is what keeps "no
arbitrary code execution" true even though connectors are now data-driven.

## The Builder backend (`src/connectors/dynamic/builder.js`)

Every exported function takes `(db, env, actorUser, ...)` and calls `requirePlatformAdmin(env,
actorUser)` first — the exact same `PLATFORM_ADMIN_USERNAMES` allowlist mechanism Phase 4C-7's
Platform Operations dashboard already uses (`src/platform-admin.js`), never a second admin
concept and never a tenant role however senior.

- `createDraftConnector` — validates slug format/uniqueness, `adapterType` (only `GENERIC_REST`
  is creatable dynamically — `BUILT_IN`/`AI_PROVIDER` are reserved for real code-defined
  connectors), `connectionMode`, auth type/config (`NONE` requires `allowNone:true` explicitly,
  `API_KEY` requires a real `headerName`), the base URL (through the SAME SSRF module Phase 6B
  built — an unsafe host can never even be saved), and every capability (against the canonical
  registry — an invented capability is rejected at save time, not just at publish time).
- `updateDraftConnector` — editable while `DRAFT` or already `PUBLISHED` (edits to a published
  definition accumulate on the live row and only take effect on the NEXT publish — see
  Versioning doc); never editable once `DISABLED`, never editable for a system connector. Runs
  the identical auth/URL/capability validation `createDraftConnector` does — an edit is held to
  the same bar as a creation, not a weaker one.
- `upsertActionForConnector` / `upsertTriggerForConnector` — an action's `requiredCapability`
  must already be declared on the definition (`CAPABILITY_NOT_DECLARED` otherwise) — a Builder
  admin cannot silently grant a capability through an action that skipped the Capabilities step.
- `validateConnectorDraft` — runs `hydrateAndValidate` without publishing; the Review/Test step's
  backend.
- `publishConnector` — re-validates (same validator), computes the next version (`1` on first
  publish, `definition.version + 1` on every later one), flips `status` to `PUBLISHED`, and
  saves an immutable manifest snapshot (`saveVersionSnapshot`).
- `disableConnector` / `reactivateConnector` — `DISABLED` blocks new connections and new
  executions but never deletes an existing connection row (Part 41's "no delete, ever").
- `getConnectorDependencies` — real connection/tenant counts, so a Platform Admin can see the
  blast radius before a breaking change.
- `listConnectorsForBuilder` / `getConnectorForBuilder` — Builder list/detail views, including
  both system and dynamic connectors with real connection counts.
- `getTenantCatalog(db)` — `PUBLISHED`-only, safe-metadata-only projection. This is the ONE
  function backing `GET /api/integrations/catalog` — see `docs/INTEGRATION_MARKETPLACE.md`.

## HTTP surface (`src/application.js`)

All under `/api/platform/connectors...`, placed alongside the existing tenant-independent
Platform Admin routes (before the per-tenant resolution gate — a Platform Admin authoring a
connector is never acting inside any one tenant's workspace). Every mutation route passes
`session.user` straight through to the Builder function, which enforces its own admin check —
the HTTP layer adds no separate gate, so there is exactly one place a permission bug could hide,
and it is covered by both a direct-function test suite (`tests/integration-builder.test.js`) and
a real-HTTP-server test suite (`tests/integration-builder-http.test.js`).

```
GET    /api/platform/connectors                  listConnectorsForBuilder
POST   /api/platform/connectors                  createDraftConnector
GET    /api/platform/connectors/:id              getConnectorForBuilder
PATCH  /api/platform/connectors/:id              updateDraftConnector
POST   /api/platform/connectors/:id/validate     validateConnectorDraft
POST   /api/platform/connectors/:id/publish      publishConnector
POST   /api/platform/connectors/:id/disable      disableConnector
POST   /api/platform/connectors/:id/reactivate   reactivateConnector
GET    /api/platform/connectors/:id/dependencies getConnectorDependencies
POST   /api/platform/connectors/:id/actions      upsertActionForConnector
DELETE /api/platform/connectors/:id/actions/:aid deleteActionForConnector
POST   /api/platform/connectors/:id/triggers     upsertTriggerForConnector
DELETE /api/platform/connectors/:id/triggers/:tid deleteTriggerForConnector
GET    /api/platform/capabilities                the canonical capability registry (for the UI's picker)
```

## Generic, capability-based Tool resolution

`src/runtime/tool-assignments.js` gained a NEW, additive branch: when a tool has no fixed
`integrationSlug` and instead declares a `capability`, `resolveGenericCapabilityTool()` calls
`listCompatibleConnections(db, tenantId, capability)`
(`src/connectors/dynamic/compatibility.js`), which resolves EVERY one of the tenant's healthy
connections (built-in or dynamic) through `resolveConnectorDynamic` and checks whether that
connector's manifest declares the capability. Zero connections → pass-through
(`{connectionId:null}`, the tool simply isn't ready). Exactly one → auto-selected. More than one
→ `CONNECTION_SELECTION_REQUIRED`, never a guess. Every pre-6D tool (a fixed `integrationSlug`)
is completely unaffected — this is a new, parallel branch, not a rewrite of the existing one.

`get_invoices` (`src/runtime/tools.js`) is the proof tool: `capability:
'accounting.invoices.read'`, `integrationSlug: null`. Its handler resolves the tenant's
compatible connection and calls the SAME `executeConnectorAction` every other connector action
goes through — **zero `if(connector==='acme_erp')` branch anywhere in Agent Runtime or Control
Center core** (verified by a real source-grep assertion in
`tests/integration-builder.test.js`).

Known, documented scope limitation: the handler calls a fixed `actionId:'get_invoices'` — the
connector's own action slug must match this exact string. This is not a fully generic "any verb"
dispatcher; it is one proof tool wired to one canonical capability, per this phase's scope.

## What's deliberately NOT done this phase

- **No `ENABLE_TENANT_CUSTOM_CONNECTORS` flag is wired up.** Only a Platform Admin can create a
  dynamic connector; a tenant cannot author their own. The flag name is documented here as a
  clearly-labeled future extension point, never a hidden capability.
- **No generic OAuth2.** `GENERIC_REST` supports `NONE`/`API_KEY`/`BEARER_TOKEN`/`BASIC` only.
- **No JS/ZIP/NPM upload, no `eval`, no dynamic `require()`.** Every dynamic connector is
  declarative JSON resolved through the fixed `genericRestAdapter` — see the "Adapter
  resolution" section above.
- **Zid/TikTok/Snapchat are not implemented**, real or otherwise, this phase.

## Files

- `src/integrations/definitions.js` — schema extension + built-in seed (unchanged built-in rows).
- `src/connectors/dynamic/store.js` — `connector_actions`/`connector_triggers`/
  `connector_definition_versions` tables + `connector_version` column on `integration_connections`.
- `src/connectors/dynamic/hydrate.js` — DB rows → real manifest, validated.
- `src/connectors/dynamic/registry.js` — the resolution whitelist.
- `src/connectors/dynamic/compatibility.js` — capability-based connection discovery.
- `src/connectors/dynamic/builder.js` — the Builder backend.
- `tests/integration-builder.test.js` (20 tests) — direct-function proof, including the full
  Acme ERP journey built ENTIRELY through Builder calls (never a code-defined manifest).
- `tests/integration-builder-http.test.js` (8 tests) — the same journey through real HTTP routes.
