# Agent Tool Mapping (Multi-Tenant Phase 4B)

> **Phase 6E update**: `get_orders`/`get_customers` (`src/runtime/tools.js`) are the second real
> proof (after Phase 6D's `get_invoices`) that a generic, capability-only tool
> (`integrationSlug: null`) auto-discovers ANY compatible connection — now genuinely exercised
> with two different real commerce connectors in the same tenant (Salla + Zid, `docs/
> ZID_CONNECTOR.md`), never a hardcoded per-provider tool. Assignment still selects the exact
> connection; capability only decides eligibility.

This document records what Phase 4B actually built: `Tenant → TenantAgentConfig → Agent Tool
Assignment → exact Integration Connection → Runtime Tool Execution`, on top of the Phase 4A
Integration Connection Core (see `docs/INTEGRATION_CONNECTION_ARCHITECTURE.md`).

## A. Audit of the pre-existing architecture

| Piece | Classification | Where |
|---|---|---|
| `agents.js` / `agents/*.md` / `domain.js` (`agents` array) | GLOBAL_DEFINITION | prompt, payload schema, id/name — never per-tenant |
| `agent_registry` (`src/runtime/registry.js`) | LEGACY_ASSUMPTION → now TENANT_CONFIG-backed | `enabled`/`provider`/`model`/`temperature`/`max_tokens` had no `tenant_id` column at all — a real, pre-existing cross-tenant leak, unreachable until a second tenant existed |
| `agent_autonomy` (`src/autonomy.js`) | Already tenant-scoped (Phase 3) | L0-L3 ledger, append-only, per (tenant, agent) |
| Tool Registry (`buildToolRegistry`, `src/runtime/tools.js`) | TOOL_DEFINITION source of truth | `TOOL_METADATA` — the only place a tool's shape/risk/integration was ever declared |
| Permission Engine (`src/runtime/permissions.js`) | RUNTIME_POLICY | `effectiveLevel`, `canUseTool` |
| Approval Engine (`src/runtime/approvals.js`) | RUNTIME_POLICY, reused unchanged | one `agent_approvals` table for every approval type |
| Integration lookup (`resolveMetaAccessToken`, `resolveMicrosoftAccessToken`, `resolveXAccessToken`, `resolveLinkedInAccessToken`, `resolveProviderAccount`) | LEGACY_ASSUMPTION → NEEDS_REFACTOR | see Section K |
| Agent Playground / Test Mode | RUNTIME_POLICY | `SOCIAL_PUBLISHING_TEST_MODE` (publish tools only, pre-existing) |

No migration started before this audit, per spec.

## C/D. AgentDefinition vs TenantAgentConfig

**AgentDefinition** stays exactly where it always was — `agents.js`/`agents/*.md`/`domain.js` —
untouched by this phase: id, prompt, payload schema, capabilities. GLOBAL, one row per agent,
shared by every tenant.

**TenantAgentConfig** (`src/runtime/agent-config.js`, table `tenant_agent_configs`) is new:

```
id, tenant_id, agent_id, enabled,
ai_connection_id, model, temperature, max_tokens, timeout_ms, approval_policy,
created_at, updated_at
UNIQUE(tenant_id, agent_id)
```

Deliberately does **not** store `permission_level` — the audited L0-L3 ledger
(`agent_autonomy`) is already tenant-scoped and stays the one source of truth; duplicating
"current level" here would create two sources that could drift. The level a run actually uses
is `effectiveLevel(currentAutonomyLevel, env, tenant.max_agent_level)`.

`seedTenantAgentConfigs(db, tenantId)` creates one row per real `AgentDefinition` (12 today)
for a tenant, idempotently (`INSERT OR IGNORE`), inheriting `enabled` from the legacy global
`agent_registry.enabled` flag **once**, at seed time, so an already-configured tenant does not
lose its enabled/disabled agents on upgrade. Every other field starts empty; no external tool
is auto-assigned. Wired into `application.js`'s boot sequence for every existing tenant, and
callable for a brand-new tenant's bootstrap.

## E. ToolDefinition (`src/runtime/tool-definitions.js`, table `tool_definitions`)

GLOBAL, seeded **exclusively** from `TOOL_METADATA` in `src/runtime/tools.js` — the real Tool
Registry this codebase executes. Nothing is hand-typed a second time, and nothing that exists
only in a prompt file gets a row.

```
id, slug, description, category, risk_level, action_type,
integration_slug, requires_connection, is_read_only, is_external_action,
capability, requires_approval_below_level, min_level, allowed_agents,
input_schema, is_available, created_at, updated_at
```

A store that never called `installToolDefinitions()` (any test fixture pre-dating this
phase) falls back to the exact same static catalog in pure memory — identical behavior with
or without the table installed.

## F. AgentToolAssignment (`src/runtime/tool-assignments.js`, table `agent_tool_assignments`)

```
id, tenant_id, agent_id, tool_slug, enabled, connection_id, is_default,
policy_override, created_at, updated_at
UNIQUE(tenant_id, agent_id, tool_slug)
```

**Opt-in, not a mandatory allowlist.** The absence of a row for `(tenant, agent, tool)` is not
an error — it means "this tool behaves exactly as it always has" (gated only by its own
`minLevel`/`allowedAgents`/legacy integration check). Making assignment mandatory would have
required seeding 28 tools × 12 agents × every tenant before anything worked, and would have
silently disabled every tool the moment this table existed — a real regression risk this phase
explicitly avoided. A row only ever **adds** an override: disable a tool for an agent, or pin
it to one exact connection.

## G. Database migrations

Three new tables (`tool_definitions`, `tenant_agent_configs`, `agent_tool_assignments`),
created via `CREATE TABLE IF NOT EXISTS` in `installToolDefinitions`/`installTenantAgentConfigs`/
`installAgentToolAssignments`, called from `application.js`'s boot sequence, after
`seedRegistry` and before the per-tenant `seedTenantAgentConfigs` loop. No column was added to
any pre-existing table. Dry-run verified against a real copy of the production database
(`data/hypercool.sqlite`, backed up first via `npm run backup`): boots clean, seeds 28 tool
definitions and 12 `tenant_agent_configs` rows for the one real tenant, `PRAGMA
integrity_check` returns `ok`.

## H. Existing agent config migration

`agent_registry.enabled` is read once, at first seed, into `tenant_agent_configs.enabled` —
no other legacy field is copied (model/provider/temperature stay on `agent_registry` as the
legacy default for any tenant that has no override yet; see `runtime.js`'s `run()`, which
reads `tenantConfig ?? registryRow` for every field). No prompt, run history, or approval
history is touched by this phase.

## I. Real tool inventory (from `TOOL_METADATA`, `src/runtime/tools.js`)

28 tools total. `isAvailable:false` (honestly NOT_IMPLEMENTED, never faked): `canva_generateAsset`
(no Canva connector exists). `salla_syncOrders` is real — it reads the Salla webhook ledger
(order.created/order.status.updated/order.completed) through ConnectorRuntime; Salla's own
order-list REST endpoint has no verified implementation here, so this is not a live poll.
Categories: Commerce, CRM, Memory, Analytics, Content, Messaging, Social,
Email, Calendar (matches Phase 5's category list minus "Internal", which this codebase folds
into CRM/Analytics rather than a separate bucket — no tool needed a distinct "Internal"
category once the real inventory was listed).

## J. Required / optional tools per agent (`src/runtime/agent-readiness.js`)

```
frost:       required none;                     optional none
strategy:    required search_brand_memory;       optional get_competitor_data
copy:        required search_brand_memory;       optional none
creative:    required search_brand_memory;       optional canva_generateAsset (NOT_IMPLEMENTED)
compliance:  required search_brand_memory;       optional none
publishing:  required none;                      optional meta_publish, x_publish, linkedin_publish
leads:       required create_lead, search_crm;   optional get_current_price, get_stock
sales:       required get_lead, create_lead,
             update_lead, search_crm;            optional get_product, get_current_price, get_stock,
                                                            whatsapp_send, microsoft_sendEmail,
                                                            create_calendar_event, get_calendar_availability
followup:    required get_recent_replies,
             create_followup;                    optional whatsapp_send, microsoft_sendEmail
intelligence:required get_competitor_data;       optional none
performance: required get_metrics;               optional none
memory:      required search_brand_memory,
             propose_memory_update;               optional none
```

Deliberately conservative: **every external-integration tool is optional** for readiness
purposes — no tenant is forced to connect a specific provider just to enable an agent (Phase
52: external sends stay off by default). This policy governs readiness *reporting* only; it
never gates execution (that stays exactly where it was: `minLevel`/`allowedAgents`/assignment
checks in `runtime.js`).

## K. Connection resolution algorithm (`resolveToolConnection`, `tool-assignments.js`)

1. No assignment row at all → `{connectionId:null, assignmentId:null}` — pass through to the
   tool's own pre-existing legacy resolution (static env token or single default connection),
   unchanged from before this phase. This is what keeps every tenant that predates this table
   working with zero behavior change.
2. An assignment row with `enabled:false` → blocked, `TOOL_DISABLED`, regardless of connection
   health.
3. An assignment row with an explicit `connection_id` → that exact connection, always
   validated: must belong to the same tenant, must match the tool's `integration_slug`
   (`CONNECTION_PROVIDER_MISMATCH` otherwise), must not be `DISCONNECTED`, and for anything but
   a read-only tool must not be in any status outside `{CONNECTED, DEGRADED}`
   (`CONNECTION_UNHEALTHY` otherwise).
4. An assignment row with no `connection_id`, for a tool with `requires_connection:true` →
   the tenant's single/default connection for that provider via `resolveProviderAccount`,
   which itself throws `CONNECTION_SELECTION_REQUIRED` rather than silently guessing when more
   than one connection is ambiguous. **Never a "first row" fallback.**

## L. Default connection fallback rules

Exactly the priority order in Phase 12 of the original spec, implemented as above: explicit
assignment connection → tenant default (only when the tool's own `requiresConnection` policy
allows it) → single-connection implicit pass-through for tools that predate this table →
`CONNECTION_SELECTION_REQUIRED` on genuine ambiguity, never resolved silently.

## M. Provider / capability validation

`CONNECTION_PROVIDER_MISMATCH` — a Salla tool can never resolve a Microsoft connection (a
mismatched `integration_slug` fails the check in step 3 above; verified in
`tests/agent-tool-mapping.test.js`). `CONNECTION_CAPABILITY_MISSING` is representable but not
separately exercised in this phase — no tool today declares a capability requirement narrower
than "the right provider, healthy" (`ToolDefinition.capability` is descriptive metadata,
consumed by `resolveToolConnection`'s provider check; a scope-level mismatch would surface as
a real API 403 at execution time, logged to `agent_tool_calls`, not fabricated here).

## N/O. AI connection assignment + model selection

`TenantAgentConfig.ai_connection_id` must belong to the same tenant and must be an
`anthropic`/`openai` connection (`validateAiConnection` in `agent-config.js`) — enforced
server-side, never trusted from a client. `runtime.js`'s `resolveAiConnectionForRun` resolves,
in order: the agent's own `ai_connection_id` → the tenant's `default_ai_connection_id` → the
pre-Phase-4B env-var default. When a connection is resolved, its vault-stored API key
(`getCredentialForRuntime`) is used in place of the env var — verified end to end (two agents,
two connections, two providers, in `tests/agent-tool-mapping.test.js`'s "AI multi-connection"
test): each run's `provider`/`model` and the actual `Authorization`/`x-api-key` header sent
match its own connection, never the other agent's or the env default. Model is never
arbitrarily accepted beyond basic bounds validation (`temperature` 0–2, `max_tokens` 1–32000,
`timeout_ms` 1000–300000) — no live provider-side model-list validation exists in this
codebase for either provider, so none is invented here.

## Salla multi-store / Tenant B tests

See `docs/CONNECTION_AWARE_RUNTIME.md` for the full connection-resolution test list, and
`docs/AGENT_READINESS.md` for the readiness-specific tests.
