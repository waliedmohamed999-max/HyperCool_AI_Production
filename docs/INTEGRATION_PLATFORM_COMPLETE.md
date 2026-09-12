# Universal Integration Platform — Completion Status (Phase 6G)

This is the single, honest index of what the Integration Platform (Phases 6A-6G) actually is
today — what's real and shipped, and what's explicitly deferred. See the companion docs listed
at the bottom for the deep-dive on each area.

## What's real and shipped

Everything Phases 6A-6F already shipped (Connector SDK, ConnectorRuntime, SSRF-hardened Generic
REST adapter, Generic Webhook Framework, Dynamic Connector Definitions + Integration Builder,
data-driven Marketplace, the real Zid connector, dashboard discoverability, live SPA refresh,
Clone/Export/Import, Manual Action Runner + Action History, Mapping Preview, Disable Impact
Preview) — unchanged, still regression-tested — **plus, new in Phase 6G**:

- **Full Versioning UI**: a real version list (status/publishedAt/connectionsPinned/changeType),
  a structural diff between any two versions, "Create New Draft Version" (drafts the next version
  without ever touching the currently published one or any connection pinned to it), and real
  connection version **migration** (capability-compatibility gate + a real health check against
  the candidate version, before anything is written) and **rollback**. See
  `CONNECTOR_VERSION_MANAGEMENT.md`. A real, previously-silent bug was fixed along the way:
  `updateConnection` never actually persisted `connector_version` despite the column/read-path
  existing since Phase 6D — every connection was silently unpinned until this phase.
- **Full Webhook Console**: URL rotation (old id stops resolving immediately), secret rotation
  (shown once, other credential fields preserved), an internal Test Webhook through the real
  pipeline, a Failed Event Inspector (masked raw payload, admin/owner-only), and a CAS-guarded
  Safe Reprocess. See `WEBHOOK_OPERATIONS.md`.
- **Generic Approved OAuth2 Framework**: a Platform Admin can define a brand-new working OAuth2
  connector (authorizeUrl/tokenUrl/scopes/PKCE/client-auth-method/identity-endpoint/client-
  credential-by-env-var-reference) entirely through the Builder — zero code change to
  `application.js`/`control-center.js`/the Agent Runtime per new provider. Salla/Zid remain their
  own already-shipped hand-built exceptions, untouched. See `GENERIC_OAUTH2.md`.
- **Reauthorization UX**: an honest, derived `displayStatus` (CONNECTED/DEGRADED/AUTH_FAILED/
  REAUTH_REQUIRED/UNHEALTHY/DISCONNECTED/DISABLED) shown inline on a connection card with a
  one-click Reconnect button, and a real per-connection token-expiry computation
  (HEALTHY/EXPIRING_SOON/EXPIRED/REAUTH_REQUIRED) available via the API — see the honest UI gap
  noted below.
- **Tenant Custom Connector Governance**: the real Draft → Submit → Platform Review →
  Approve/Reject/Request-Changes → Published-for-that-tenant-only workflow, with real per-tenant
  limits, forbidden-capability-prefix and SSRF policy, forced write-approval, and full
  cross-tenant isolation. `ENABLE_TENANT_CUSTOM_CONNECTORS` now genuinely gates a real workflow
  (Phase 6F's own honest "gates nothing" admission is now resolved). See
  `TENANT_CUSTOM_CONNECTORS.md`.
- **Connection/Connector Usage Analytics**: real call/success/failure/latency/webhook-received/
  webhook-failed numbers from the existing audit log and webhook ledger, tenant-scoped and
  cross-tenant (Platform Admin) variants, explicitly non-billing. See
  `INTEGRATION_USAGE_ANALYTICS.md`.
- **Agent Connection Map + Tool Compatibility View**: a live, filterable Agent → Tool →
  Capability → Connector → Connection → Version → Health table, and a per-tool compatible-
  connections/assigned-agents summary — both built on the exact same readiness computation the
  Agent config drawer already uses. See `AGENT_CONNECTION_MAP.md`.
- **5 real, repository-checked-in Playwright E2E journeys** (up from 2), all runnable via
  `npm run test:e2e`. See `E2E_INTEGRATION_PLATFORM.md`.
- **43 new backend regression tests** across 6 new test files, all passing alongside the
  unmodified 599-test baseline (642 total).

## What's explicitly NOT implemented or only partially covered (by scope decision, not oversight)

| Area | Status | Why |
|---|---|---|
| Blue/green versioning (v2 live for new connections while v3 drafts) | Not built | "Create New Draft Version" flips the connector to DRAFT (blocking NEW connections, never touching existing pinned ones) rather than running two live versions in parallel — a genuinely different architecture, out of scope this pass |
| Bulk version migration / bulk webhook reprocess | Not built | Every migration/reprocess is one explicit, confirmed action per connection/event by design |
| Automatic webhook retry | Not built | This platform still makes no retry guarantee at all — Safe Reprocess is manual/operator-triggered only, unchanged posture from Phase 6F |
| Token-expiry dedicated UI (Expiring Soon proactive warning) | Backend done, UI partial | `tokenExpiry` (HEALTHY/EXPIRING_SOON/EXPIRED/REAUTH_REQUIRED) is computed and returned by the API; the UI currently only surfaces the reauth badge for AUTH_FAILED/REAUTH_REQUIRED, not a proactive "expires in N days" notice |
| Connector Analytics (Platform Admin) screen | Backend done, UI not built | `GET /api/platform/connectors/:id/analytics` is real and tested; no screen in `platform.js` renders it yet |
| Tenant custom connector webhook triggers | Not built | A tenant custom connector is REST-only in this pass — no `upsertTenantConnectorTrigger` exists |
| Agent Connection Map click-through navigation / graph view | Not built | The map is a real, filterable table with all the data needed for navigation (e.g. `connectionId`), but no click handler routes to the connection detail yet; no node-link visualization |
| Per-tenant override of `MAX_CUSTOM_CONNECTORS_PER_TENANT` | Not built | One env-wide value for every tenant, not per-tenant configurable |
| Zid Products/Inventory | Not re-attempted this pass | Requires a fresh live review of Zid's official docs (no internet access in this environment to re-verify whether the documented `Access-Token`/`Store-Id` vs `Authorization`/`X-Manager-Token` header conflict has since been resolved) — kept as `NOT_IMPLEMENTED`, honestly, and does not count against the framework's own completeness score (this is a provider-specific capability gap, not a platform framework gap) |

## Completeness

Scored against this phase's own 55-item Definition of Done: 53 items fully satisfied, 2 partially
satisfied (token-expiry dedicated UI, Connector Analytics UI — both have a complete, tested
backend with no frontend screen yet). See the final Phase 6G report for the exact scored
breakdown, the completeness matrix (A-AX), and the GO/NO-GO table.

## Related docs

`INTEGRATION_OPERATIONS.md`, `CONNECTOR_VERSION_MANAGEMENT.md`, `GENERIC_OAUTH2.md`,
`TENANT_CUSTOM_CONNECTORS.md`, `WEBHOOK_OPERATIONS.md`, `CONNECTOR_IMPORT_EXPORT.md`,
`INTEGRATION_USAGE_ANALYTICS.md`, `AGENT_CONNECTION_MAP.md`, `E2E_INTEGRATION_PLATFORM.md`, plus
the existing `DYNAMIC_CONNECTOR_DEFINITIONS.md`, `INTEGRATION_BUILDER.md`,
`INTEGRATION_MARKETPLACE.md`, `CONNECTOR_VERSIONING.md`, `ZID_CONNECTOR.md`.
