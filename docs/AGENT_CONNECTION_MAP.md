# Agent Connection Map + Tool Compatibility View (Phase 6H status)

One real, live view of **Agent → Tool → Capability → Connector → Connection → Version → Health**,
built in `src/runtime/agent-connection-map.js` entirely on top of EXISTING computations
(`evaluateAllToolsReadiness`, `resolveToolConnection`, `listCompatibleConnections`) — never a
second, parallel readiness engine that could silently disagree with what the Agent config
drawer's own tool list already shows.

## Agent Connection Map

`GET /api/agent-connection-map?agentId=&connectorSlug=&status=&capability=&health=`
(`buildAgentConnectionMap`): one row per (agent, tool) pair the agent is allowed to use —

- `agentId`/`agentName`/`toolSlug`/`capability` — from the existing agent/tool definitions.
- `connectorSlug`/`connectionId`/`connectionName`/`connectorVersion`/`healthStatus` — resolved via
  `resolveToolConnection` (the SAME function that decides whether a real agent tool call is
  actually allowed to proceed). Looked up whenever `resolveToolConnection` returns a
  `connectionId` **regardless of whether the result is `blocked`** — several real blocked reasons
  (`CONNECTION_CAPABILITY_MISSING`, `CONNECTION_PROVIDER_MISMATCH`, `CONNECTION_UNHEALTHY`) still
  carry a real connection id, and a map that only looked up the connection on the *unblocked* path
  would silently miss the single most useful case: a pinned connection whose token just expired.
- `readinessStatus`/`readinessReason` — the exact vocabulary `evaluateToolReadiness` already
  returns (`READY`/`CONNECTION_REQUIRED`/`CONNECTION_UNHEALTHY`/`CONNECTION_CAPABILITY_MISSING`/
  `DISABLED`), enriched with `REAUTH_REQUIRED` specifically when the underlying connection's raw
  status is `TOKEN_EXPIRED` — a real, already-true fact this map is the first screen to name
  explicitly rather than folding it into the more generic "unhealthy" bucket.

Filters (`agentId`, `connectorSlug`, `status`, `capability`, and — Phase 6H — `health`, the
connection's own raw transport status, distinct from `status`/Readiness which is the tool's
computed usability) narrow the same underlying rows — never a second query shape.

## Tool Compatibility View

`GET /api/tool-compatibility` (`buildToolCompatibilityView`): per real, distinct tool (not per
agent-tool pair), the connections that could satisfy it (`listCompatibleConnections` — the exact
same generic-capability resolver the Agent config drawer's own connection dropdown already uses)
and which one is actually assigned to each agent allowed to use it. A tool with genuinely no
assignment anywhere (`resolveToolConnection`'s own documented "no assignment row -> pass-through
to legacy resolution" contract) is correctly omitted from a given agent's row rather than shown
with a fabricated "missing" reason — there being nothing yet configured is not the same as
something being broken.

## UI

Control Center → "Agent Map" tab: a filterable table (agent/readiness-status/health-status/
connector-slug/capability) for the map, plus a compatibility summary table (compatible-connection
count and assigned/total-agents ratio per tool).

**Navigation (Phase 6H)** — every cell is now a real, clickable link, reusing EXISTING screens
rather than a second detail view:
- **Agent** cell → opens the same Agent drawer the Agents tab already uses (`openAgentDrawer`).
- **Tool** cell → opens that SAME drawer directly on its Tools tab (the drawer's own `tabs()`
  return value, previously discarded, now exposes `select(index)`).
- **Connector**/**Connection** cells → a Platform Admin goes straight to the real Builder
  definition (`openConnectorWizardBySlug`, exactly like the Integrations tab's own "Manage
  Definition" button); a tenant owner/operator opens the connector's real connection-management
  drawer (`openProviderDrawer`, exactly like the Integrations tab's own "Manage" button).
- **Card view (Phase 6H)** — a Table/Card toggle button; the card view renders the same real
  Agent → Tool (capability) → Connector → Connection chain plus health/readiness badges as a
  simple per-row card (a clear dependency chain, deliberately NOT a node-link graph editor).

## What's NOT built

- **No node-link graph/diagram** — even the new card view is a simple chain-of-chips card per row,
  not a rendered graph with pannable/zoomable nodes; "map" here still means "the full picture",
  not a graph visualization.
- **No capability-level rollup** ("which capabilities does this tenant have zero coverage for at
  all") — the view is per-tool, not aggregated to a capability-coverage summary.

## Proven by

`tests/agent-connection-map.test.js`: a `READY` row carries the real connector/connection/
version/health data; the `REAUTH_REQUIRED` enrichment fires correctly for a `TOKEN_EXPIRED`
connection (a real bug was found and fixed here — see the Phase 6G test-suite commit history: the
enrichment originally only looked up the connection on the unblocked path); all filters (including
Phase 6H's new `health` filter) narrow correctly; the Tool Compatibility View reports real
compatible connections and per-agent assignment/missing state.
`tests/e2e/phase6h-closure-journey.e2e.mjs` (Phase 6H) — seeds a real tool/agent assignment,
verifies the map row renders it, and that clicking the Agent cell opens the real Agent drawer and
clicking the Connector cell (as Platform Admin) navigates to the Builder and opens the real
definition.

## History

Phase 6G built the real, live table itself but shipped read-only, with the DATA needed for
navigation present in every row but no click handler wired to it. Phase 6H closed that gap with
the navigation and card-view above.
