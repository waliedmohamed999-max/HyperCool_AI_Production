# Integration Operations (Phase 6F)

Real, live operational visibility for the Integration Platform — what exists today, and what a
future phase would still need to add for a full "Operations" screen.

## What exists today

- **Integration Platform dashboard card** (`#platform`, `src/platform-admin.js`'s
  `buildPlatformOverview`): total connectors by status (published/draft/disabled), platform-wide
  active (healthy) connections, platform-wide unhealthy connections, and a real count of
  `webhook_events` rows with `status='FAILED'`. Every number is a live query — never cached,
  never fabricated.
- **Per-connector dependency view** (`GET /api/platform/connectors/:id/dependencies`):
  connections, distinct tenants, enabled agent tool assignments referencing one of those
  connections, and (for a dynamic connector) its own trigger count. Surfaced in the Builder's
  Disable confirmation as a real impact preview before the click is confirmed.
- **Per-connection Action History** (`GET /api/integrations/connections/:id/action-history`):
  the last 30 real `CONNECTOR_ACTION_EXECUTED`/`CONNECTOR_ACTION_FAILED`/
  `CONNECTOR_ACTION_PENDING_APPROVAL` audit rows for that exact connection — action slug,
  status, error code, latency, actor, timestamp. Never the raw output or a credential.
- **Manual Action Runner** (`POST /api/integrations/connections/:id/actions/:actionSlug`,
  pre-existing since Phase 6D, now with a real UI in Control Center): lets an owner/operator run
  any of a connection's declared actions on demand through the exact same ConnectorRuntime
  pipeline (capability check, health-status check, Approval Engine for a write action) the Agent
  tool path uses — never a bypass.

## What a future "Operations" phase would still add

- A dedicated, filterable (by tenant/connector/status/error code/time) operations log screen —
  today the closest equivalent is the existing platform audit log and the per-connection Action
  History above, neither of which is filterable across the whole platform in one view.
- A "pending reauth" / "unhealthy connections" cross-tenant LIST (today the dashboard card gives
  a real COUNT but not a clickable list of which specific connections need attention).
- Automatic periodic health checks on a schedule (today, health is checked on-demand: when a
  tenant clicks "Test Connection", when a connection is first created, or via the Agent
  readiness path — there is no background health-check scheduler for connectors yet).

## Scope note

This document intentionally does not claim a full "Operations Center" exists — see
`docs/INTEGRATION_PLATFORM_COMPLETE.md` for the honest completion matrix.
