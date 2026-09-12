# Connection / Connector Usage Analytics (Phase 6G)

Real, live aggregates over data this platform already records — never a second metrics table,
never a fabricated number, and explicitly **operational visibility only**, not a billing meter
(Part 42: this module is never wired into any pricing/quota/invoicing system).

## Connection Usage (tenant-facing)

`GET /api/integrations/connections/:id/usage?window=24h|7d|30d`
(`src/runtime/usage-analytics.js`, `getConnectionUsage`): for ONE tenant's own connection —

- `actionCalls`/`success`/`failure` — counted from the existing audit log's
  `CONNECTOR_ACTION_EXECUTED`/`CONNECTOR_ACTION_FAILED` entries (the exact same entries
  `core/runtime.js`'s `executeConnectorAction` already writes on every single call — no new
  instrumentation needed).
- `averageLatencyMs` — averaged from the same entries' own `latencyMs` field.
- `lastUsedAt` — the most recent of those entries' timestamps.
- `webhookReceived`/`webhookFailed` — counted from the existing `webhook_events` ledger, scoped
  to this connection's own `source` (`connector:<slug>`).

Tenant-scoped throughout (`getConnection` 404s a wrong-tenant id before any aggregation runs) —
proven by a dedicated cross-tenant test.

## Connector Analytics (Platform Admin, cross-tenant)

`GET /api/platform/connectors/:id/analytics?window=24h|7d|30d` (`getConnectorAnalytics`):
aggregated across **every tenant** that has a connection to this connector —
`connectionsCount`, `activeTenants` (distinct tenants with a `CONNECTED`/`DEGRADED` connection),
`calls`/`failures`, and a real `healthDistribution` (a live `GROUP BY status` count).

This is the one place in the Integration Platform that deliberately reads audit log rows
**without** the tenant-scoping every other reader (`listAuditLog`) applies by default — a direct,
bounded SQL query (`LIMIT 20000` rows per window, matching this codebase's own documented
"fine at pilot scale, revisit before thousands of audit rows" performance caveat, already stated
for the pre-existing connection-action-history route) is filtered in application code by the
entry's own `connectorSlug` field.

## Time windows

`24h`/`7d`/`30d` — a simple cutoff timestamp, no pre-aggregated rollup table. At real production
scale with a large audit log this would need indexing/rollup work; explicitly out of scope for
this pass (see the bounded-scan note above).

## UI

- Tenant-facing: the Connection page's "Advanced" drawer, Usage tab — 6 real metrics plus
  "last used", for the default 7-day window (no window switcher in the UI yet — see below).
- Platform-facing: no dedicated Connector Analytics screen was built this pass; the route exists
  and is tested, but nothing in `platform.js` calls it yet.

## What's NOT built

- **No window switcher in the tenant-facing Usage tab UI** — the route supports `24h`/`7d`/`30d`,
  but the UI always requests `7d`; changing the window requires a direct API call today.
- **No Platform Admin UI surface for `getConnectorAnalytics`** — the backend route is real,
  tested, and reachable, but there is no screen in `platform.js` rendering it yet (a real,
  acknowledged gap — this is backend-complete, frontend-incomplete).
- **No per-agent or per-tool usage breakdown** — usage is aggregated per connection/connector
  only, not cross-referenced with which agent/tool triggered each call (that correlation exists
  in principle in the audit log's `actorId`, but this module does not surface it).
- **No export** (CSV/JSON download) of usage data.

## Proven by

`tests/usage-analytics.test.js` (4 tests): real call/success/failure/latency aggregation from the
audit log, tenant isolation (a wrong-tenant connection id 404s), cross-tenant connector-level
aggregation (both tenants' calls counted, including a real cross-tenant failure), and an explicit
assertion that no field in either response looks like a billing/cost/quota field.
