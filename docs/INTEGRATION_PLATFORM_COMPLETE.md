# Universal Integration Platform — Completion Status (Phase 6F)

This is the single, honest index of what the Integration Platform (Phases 6A-6F) actually is
today — what's real and shipped, and what's explicitly deferred. See the companion docs listed
at the bottom for the deep-dive on each area.

## What's real and shipped

- **Connector SDK, ConnectorRuntime, SSRF-hardened Generic REST adapter** (6A/6B).
- **Generic Webhook Framework** — inbound only, HMAC/header-token/shared-secret auth,
  idempotency via the real `webhook_events` ledger, dispatch into the real Event Bus (6C).
- **Dynamic Connector Definitions + Integration Builder** — a Platform Admin creates, edits,
  validates, publishes, disables/reactivates a `GENERIC_REST` connector entirely from data (6D).
- **Data-driven Marketplace** — the tenant catalog and Control Center Integrations tab read
  live from `integration_definitions`; a published connector needs zero frontend code (6D).
- **A real, external, first-party connector (Zid)** proving a genuine OAuth2 BUILT_IN connector
  can sit on this same platform (6E) — read-only V1, honestly scoped (see `ZID_CONNECTOR.md`).
- **Dashboard discoverability** — a dedicated "Integration Builder" sidebar entry, an
  "Integration Platform" dashboard card with real counts (connectors by status, active/
  unhealthy connections, failed webhooks), a Platform-Admin-only "+ Add Integration" entry in
  Control Center, and a per-card "Manage Integration" shortcut (Phase 6D.1/6F).
- **Live SPA refresh** — publishing a connector and switching to Control Center/Platform shows
  it immediately, no hard reload (Phase 6D.1/6F, `app.js`'s `refetchPageIfNeeded`).
- **Clone / Export / Import** — a Platform Admin can clone a dynamic connector into a new draft,
  export its declarative shape as safe JSON (never a credential), and import a JSON file back
  through the SAME validated entry points a hand-typed connector uses (Phase 6F).
- **Manual Action Runner + Action History** — a tenant owner/operator can run any of a
  connection's real actions on demand (through the same ConnectorRuntime/Approval Engine
  pipeline the Agent tool path uses) and see a safe, recent run history (Phase 6F).
- **Mapping Preview** — a Platform Admin can preview the canonical mapper's real output against
  a sample payload while building an action, before ever publishing (Phase 6F).
- **Disable Impact Preview** — the real, live connection/tenant/agent-assignment counts are
  shown before a disable confirmation (Phase 6F).
- **A real, previously-broken bug fixed**: `GET /api/tools/:slug/connections` always returned
  an empty list for any generic, capability-only tool (`get_invoices`/`get_orders`/
  `get_customers`) — the Agent config drawer's own connection dropdown for these tools was
  silently broken since Phase 6D/6E. Fixed and tested (Phase 6F).
- **2 real, repository-checked-in Playwright E2E journeys**, runnable via `npm run test:e2e`.

## What's explicitly NOT implemented (by scope decision, not oversight)

| Area | Status | Why |
|---|---|---|
| Full Versioning UI (list/diff/rollback) | Not built | Backend Version Policy B (immutable snapshots, pinning) works and is tested; no dedicated UI to browse versions, diff them, or execute a connection migration/rollback exists |
| Webhook console (URL/secret rotation, failed-webhook inspector, safe reprocess) | Not built | The webhook URL is already visible via the existing `GET .../webhook` route; rotation, an inspector UI, and a reprocess action do not exist |
| Generic, Platform-Admin-configurable OAuth2 framework (beyond Zid) | Not built | Zid's OAuth is a real, hand-built, code-reviewed adapter — a fully generic "define any OAuth2 provider from data" system was judged too large/risky to build safely in this pass |
| Tenant Custom Connector governance (Draft→Review→Approve, limits, policy) | Not built | Only the `ENABLE_TENANT_CUSTOM_CONNECTORS` flag exists (default off, gates nothing yet) — see `TENANT_CUSTOM_CONNECTORS.md` |
| Usage/analytics view (call counts, success rate, avg latency) | Not built | Would need new tracking/aggregation beyond the existing audit log |
| Capability usage viewer / Tool compatibility viewer as dedicated screens | Partially covered | The underlying data is correct and queryable (`GET /api/tools/:slug/connections`); no dedicated "browse by capability" screen was built |
| Agent Connection Map with connector/version/health columns | Partially covered | The Agent config drawer already shows tool→connection assignment; the requested extra columns were not added |
| Reauth UX / token-expiry dedicated screen | Partially covered | `TOKEN_EXPIRED` is a real, honest connection status already surfaced generically; no provider-specific "Reconnect" button UI was added beyond what already exists for Salla/Zid |
| Platform Integration Operations (filterable ops dashboard) | Partially covered | The dashboard card surfaces real aggregate numbers; a dedicated filterable log/ops screen was not built |

See the final Phase 6F report (delivered in-conversation) for the full, itemized completeness
matrix and score.

## Related docs

`INTEGRATION_OPERATIONS.md`, `CONNECTOR_VERSION_MANAGEMENT.md`, `GENERIC_OAUTH2.md`,
`TENANT_CUSTOM_CONNECTORS.md`, `WEBHOOK_OPERATIONS.md`, `CONNECTOR_IMPORT_EXPORT.md`, plus the
existing `DYNAMIC_CONNECTOR_DEFINITIONS.md`, `INTEGRATION_BUILDER.md`,
`INTEGRATION_MARKETPLACE.md`, `CONNECTOR_VERSIONING.md`, `ZID_CONNECTOR.md`.
