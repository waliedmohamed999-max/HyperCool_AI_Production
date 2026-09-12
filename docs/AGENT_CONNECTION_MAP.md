# Agent Connection Map + Tool Compatibility View (Phase 6G)

One real, live view of **Agent → Tool → Capability → Connector → Connection → Version → Health**,
built in `src/runtime/agent-connection-map.js` entirely on top of EXISTING computations
(`evaluateAllToolsReadiness`, `resolveToolConnection`, `listCompatibleConnections`) — never a
second, parallel readiness engine that could silently disagree with what the Agent config
drawer's own tool list already shows.

## Agent Connection Map

`GET /api/agent-connection-map?agentId=&connectorSlug=&status=&capability=`
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

Filters (`agentId`, `connectorSlug`, `status`, `capability`) narrow the same underlying rows —
never a second query shape.

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

Control Center → new "Agent Map" tab: a filterable table (agent/status/connector-slug-contains)
for the map, plus a compatibility summary table (compatible-connection count and
assigned/total-agents ratio per tool).

## What's NOT built

- **No visual graph/diagram** — this is a real, filterable table, not a node-link visualization;
  "map" here means "the full picture", not a rendered graph.
- **No click-through from a map row straight to that connection's detail drawer** — the map is
  read-only in this pass; an operator who wants to act on a row still navigates to the
  Integrations tab and finds the connection manually. (Item 45 — "safe navigation" — is therefore
  only partially satisfied: the DATA needed for navigation, e.g. `connectionId`, is present in
  every row, but the UI itself does not yet wire a click handler to it.)
- **No capability-level rollup** ("which capabilities does this tenant have zero coverage for at
  all") — the view is per-tool, not aggregated to a capability-coverage summary.

## Proven by

`tests/agent-connection-map.test.js` (4 tests): a `READY` row carries the real
connector/connection/version/health data; the `REAUTH_REQUIRED` enrichment fires correctly for a
`TOKEN_EXPIRED` connection (a real bug was found and fixed here — see the Phase 6G test-suite
commit history: the enrichment originally only looked up the connection on the unblocked path);
all four filters narrow correctly; the Tool Compatibility View reports real compatible
connections and per-agent assignment/missing state.
