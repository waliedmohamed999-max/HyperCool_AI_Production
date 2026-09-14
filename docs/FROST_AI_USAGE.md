# AI Usage View (Phase 7C)

`src/runtime/ai-usage.js` — `getAiUsageSummary(db, tenantId, {period})` and
`getRunUsage(db, runId, tenantId)`.

## Zero new tracking

This feature adds no new instrumentation anywhere. It is a pure aggregation of columns that
already exist on `agent_runs`: `tokens_input`, `tokens_output`, `estimated_cost`, `provider`,
`model`, `latency_ms`. Every agent run — including a workflow's AGENT steps — already writes
these columns today; this view only reads them differently.

## Never a fabricated cost

`estimated_cost` is only ever shown when the underlying `agent_runs` row actually has a non-null
value for it. If no real pricing data exists for a given provider/model, the summary reports that
honestly (no cost figure invented, no default multiplier applied) rather than showing a number
that looks precise but isn't backed by anything real.

## Aggregation shape

`getAiUsageSummary(db, tenantId, {period})` — `period` is `'today' | '7d' | '30d'` — returns:

```json
{
  "period": "7d",
  "totalCalls": 42,
  "totalTokensInput": 18342,
  "totalTokensOutput": 9021,
  "totalCost": 0.83,
  "byAgent": [{ "agentId": "frost_commander", "calls": 12, "tokens": 4210, "cost": 0.19 }],
  "byProvider": [{ "provider": "anthropic", "calls": 30, "tokens": 20000, "cost": 0.7 }]
}
```

`getRunUsage(db, runId, tenantId)` returns the same shape's per-call fields for a single run, used
to attach a real `usage` object to the last assistant message in Command Center chat
(`command-chat.js`'s `sendCommandMessage` merges it into `meta` whenever `tokens_input` is
non-null on the underlying run).

## Where it surfaces

- **Command Center AI Usage widget** (`renderAiUsage` in `command-center.js`): Today / 7d / 30d
  toggle, grouped by Agent and by Provider. `GET /api/command/ai-usage?period=`.
- **Per-message usage line**: the chat bubble for the most recent assistant turn shows its own
  real token/cost/duration figures whenever the underlying `agent_runs` row has them.
- **Command Result Export**: the exported Markdown never includes raw usage numbers unless they
  are already part of the visible command summary — export never invents anything not shown on
  screen.

## Tenant isolation

Every query is scoped by `tenant_id`; `tests/ai-usage.test.js` includes a real cross-tenant
aggregation test confirming Tenant B's usage never leaks into Tenant A's summary.

## Tests

`tests/ai-usage.test.js` (2 tests: real aggregation by agent/provider/tenant; no fabricated cost
when `estimated_cost` is null) plus the mandated Usage E2E (spec item 91) in
`tests/e2e/command-center-journey.e2e.mjs`, which drives several real chat commands and confirms
the widget's non-zero token count and the last message's own usage metadata both come from real
`agent_runs` rows, not placeholders.

## Known limitation

Cost figures are only as accurate as the pricing data already recorded per provider/model in
`agent_runs.estimated_cost` at run time — this view does not maintain its own pricing table or
retroactively re-price historical runs if a provider's pricing changes.
