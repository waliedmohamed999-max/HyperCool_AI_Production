# Connection-Aware Runtime (Multi-Tenant Phase 4B)

How a tool call actually flows through the runtime once assignments and connections exist,
and — the part most likely to bite a future change — exactly which legacy provider lookups
had to learn to accept a real `tenantId` for this to be safe with a second tenant.

> **Phase 4C-1 note:** how `session.tenantId` itself gets resolved changed (see
> `docs/WORKSPACE_SELECTION.md`) — a multi-membership user's active workspace selection is now
> considered. Everything below this point is unaffected: the runtime still only ever consumes
> the single, already-resolved, trusted `session.tenantId`/`ctx.tenantId` value, exactly as
> before.

## Execution flow (`runtime.js`, `executeTool`)

```
Agent requests tool
 -> toolRegistry.get(name)                                  [ERROR: UNKNOWN_TOOL]
 -> canUseTool(level, tool, agentId)                          [FORBIDDEN]
 -> resolveToolConnection(db, {tenantId, agentId, toolSlug})   [CONNECTION_REQUIRED / CONNECTION_UNHEALTHY]
 -> requiresApprovalBelowLevel gate (Approval Engine, reused)  [WAITING_APPROVAL]
 -> tool.handler(input, {..., connectionId, assignmentId})     [the real call]
 -> INSERT INTO agent_tool_calls (..., connection_id, status)
```

Every step before the handler call can short-circuit the tool without ever touching a
real provider or spending a network round-trip on a call that was already known to be
invalid (wrong tenant, wrong provider, disabled, unhealthy).

## ToolExecutionContext

Passed to every handler as its second argument:

```js
{store, env, actor, runId, agentId, tenantId, connectionId, assignmentId}
```

No `userId`/`correlationId`/`permissionLevel` field exists separately — `actor` carries the
acting identity (the agent, or a human on the manual-send HTTP paths) and the run row already
carries `actorId`/`triggerType`; adding parallel fields would have been a second copy of data
already on the run, not a real gap.

## Secret boundary (Phase 21/22, verified by test)

The agent/LLM never sees a token, refresh token, API key, or vault payload — only
`connectionId` (an opaque id) flows through `ToolExecutionContext`. Only the tool handler
itself, inside `runtime/tools.js`, ever calls `getCredentialForRuntime`/`resolveMetaAccessToken`
/etc. — never the prompt builder, never a route that returns JSON to a browser. Verified in
`tests/agent-tool-mapping.test.js`: "Secret boundary: the tool execution context never carries
a vault secret — only a connectionId" swaps `runtime.toolRegistry.get` to capture the exact
context object passed to a real handler and asserts no secret-shaped field is present.

## Approval preserves the connection (Phase 40-42)

`requiresApprovalBelowLevel` (today: only `whatsapp_send`, gated at L1) creates a real
`agent_approvals` row carrying `tool_slug`, `assignment_id`, and `connection_id` — the same
table and `/api/approvals/:id/decide` flow every other approval already uses, not a second
engine. `resumeToolApproval` re-validates that stored connection is **still** available
before calling the handler: if it has since gone `DISCONNECTED`/`ERROR`/`TOKEN_EXPIRED`, or
was removed, it returns `CONNECTION_NO_LONGER_AVAILABLE` and never calls the handler — even if
a *different* connection is now the tenant's default. An approval never silently re-targets
whatever is default *now*. Both outcomes are covered by test: connection disconnected before
decision → `CONNECTION_NO_LONGER_AVAILABLE`; connection still healthy → the handler runs and
`agent_tool_calls` logs the resumed call with the real `connection_id`.

## Tool call logging (Phase 44)

Every `agent_tool_calls` row — from a normal run *and* from `resumeToolApproval` — carries
`tenant_id, run_id, tool, connection_id, input, output, status, at`. No secret ever appears in
`output` (handlers return status/id/error-class shapes, never raw tokens).

## Connection dependency check (Phase 46-48)

`findAssignmentsUsingConnection(db, tenantId, connectionId)` in `tool-assignments.js` lists
every enabled assignment pinning a connection — the primitive a disconnect/delete flow needs
to warn or block on real dependents rather than silently breaking an agent's configured tool.
Force-disconnecting a connection does not delete its assignments; they simply stop resolving
(`CONNECTION_UNHEALTHY`/`CONNECTION_REQUIRED`), which readiness surfaces honestly as
`PARTIAL`/`BLOCKED` on the next evaluation — never a stale "still fine" state.

## Legacy provider lookup refactor (Phase 24) — the real fix in this phase

Before this phase, `resolveMetaAccessToken`, `connectedWhatsAppPhoneNumberId`,
`resolveMicrosoftAccessToken`, `resolveXAccessToken`, `resolveLinkedInAccessToken` (and the
publish helpers built on them: `publishToInstagram`/`publishToFacebook`/`publishTweet`/
`publishLinkedInPost`, plus `microsoft-graph.js`'s `sendMail`/`createCalendarEvent`/
`getCalendarAvailability`/`findRecentSentMessage`/`renewMailSubscription`) all called
`getCredentials`/`getCredentialsMeta` from `credentials.js` **without** a `tenantId` — falling
back to `resolveActiveTenantId(db)`, which throws `TENANT_CONTEXT_REQUIRED` the moment a
second tenant exists (by design — it refuses to guess). In practice this meant: the instant a
real second tenant was created, `whatsapp_send`, `meta_publish`, `x_publish`,
`linkedin_publish`, `microsoft_sendEmail`, `create_calendar_event`, and
`get_calendar_availability` would all throw a generic `ERROR` instead of the intended
`INTEGRATION_REQUIRED`/`BLOCKED` — a real regression this phase's own multi-tenant test
(`twoTenants()`) caught directly (two tests failed on this exact bug before the fix:
"whatsapp_send: L0 is FORBIDDEN... L2 executes immediately" and "Approval resume: connection
still healthy...").

Separately, `meta-publishing.js`'s `instagramAccountId`/`pageId` read
`integration_credentials` by `provider` **with no tenant filter at all** — a real cross-tenant
data-leak risk once a second tenant's `meta` row existed (SQLite would return whichever row it
stored first).

Fixed by threading an optional `tenantId` parameter through the entire chain — every resolver,
every publish helper, every `microsoft-graph.js` function — defaulting to `null` (so every
call site that doesn't pass it keeps its exact pre-existing behavior for a single-tenant
deployment) and passed as `ctx.tenantId` at every real agent-tool call site
(`runtime/tools.js`), `session.tenantId` at the three manual-send HTTP routes in
`application.js`, and the already-resolved `tenantId` in `scheduler.js`'s per-tenant
subscription-renewal loop. `meta-publishing.js`'s two lookups now filter by `tenant_id`
explicitly.

**What is still a documented, temporary compatibility fallback, per this phase's explicit
allowance:** the single-workspace admin/status routes (`application.js`'s
`/api/integrations/:id/test`, `integrations/health.js`) and the one-shot "اختبار الاتصال"
buttons still call these resolvers without a `tenantId` — they operate on whichever tenant
`resolveActiveTenantId` picks, which is correct today because no Control Center UI exists yet
to scope them per-request and only one tenant actually uses these admin routes. Wiring real
per-request tenant context into these routes is Phase 4C UI work, not this phase's job — this
is the one place this phase leaves a fallback in place, and it is documented here rather than
silently left for someone to rediscover.

## Provider connection-mode matrix (Phase 13/14/96 — stated honestly, never inflated)

`connectionModeFor(slug)` in `src/integrations/definitions.js`, exposed on every
`IntegrationDefinition` as `connectionMode`:

| Provider | Mode | Why |
|---|---|---|
| `salla` | `MULTI` | Proven end-to-end: two real `integration_connections` rows for one tenant, two tools each pinned to a different one, resolved independently (test: "Salla multi-store") |
| `anthropic` | `MULTI` | Proven end-to-end: two agents, two connections, two vault-stored keys, each run uses its own (test: "AI multi-connection") |
| `openai` | `MULTI` | Same test as above |
| `whatsapp` | `SINGLE` | Shares Meta's OAuth grant; `integration_credentials` PRIMARY KEY is `(tenant_id, provider)` — one row per tenant, "Connect" overwrites it |
| `meta` | `SINGLE` | Same PK constraint; one Page/IG/WhatsApp asset set per tenant today |
| `microsoft365` | `SINGLE` | Same PK constraint; one mailbox/calendar identity per tenant today |
| `x` | `SINGLE` | Same PK constraint; one OAuth user-context identity per tenant today |
| `linkedin` | `SINGLE` | Same PK constraint; one Company Page identity per tenant today |
| `canva` | `UNAVAILABLE` | No real implementation anywhere in this codebase (verified by grep, per Phase 4A's own audit) |

`integration_connections` itself structurally allows multiple rows per `(tenant, provider)`
for every provider — the `SINGLE` classification above is about the **credential layer**
underneath (`integration_credentials`), which is the actual constraint for
whatsapp/meta/microsoft365/x/linkedin today. Making those genuinely `MULTI` would mean giving
each of those five OAuth flows its own per-connection credential row instead of one shared
`(tenant, provider)` slot — real, scoped future work, not something this phase claims to have
already done.

## Phase 4B.1: Connection Capability Enforcement

Phase 4B built `ToolDefinition.capability` and `IntegrationDefinition.capabilities` as real
fields, but nothing ever cross-checked one against the other, or against what a *specific
connection* actually has permission to do — `resolveToolConnection` validated provider match
and health only. A tool could resolve a connection whose real OAuth grant never included the
scope it needs, discoverable only via a live 403 at the provider. Phase 4B.1 closes this.

### The rule (`src/runtime/capability-map.js`)

A small, explicit table maps `(provider, ToolDefinition.capability) → the real OAuth scope(s)
that grant it` — see the file itself for the exact mapping and the reasoning behind each
provider's entry (in particular Salla's single `products.read` scope covering three separate
tool capabilities, and Meta's `publishing` capability being satisfied by whatever this app
actually requests today, not the theoretical ideal — both explained inline).

`connectionGrantsCapability(provider, capability, scopes)` returns true when:
1. the capability has no entry for that provider at all (an internal/AI capability, or a
   provider this table doesn't model — the existing provider/health checks are the only gate,
   unchanged), **or**
2. the connection has **no recorded scopes at all** (`scopes: []` — a legacy or manually-seeded
   connection this app has no real grant data for; never invented as "missing" any more than
   it would be invented as "present" — Part 6: "لا تعتبر supported-by-provider = granted"), **or**
3. at least one of the scopes that grant it is actually present in the connection's real
   `scopes` array (populated from the live OAuth grant at connect/refresh time — see
   `legacy-sync.js` and the generic multi-connection callback in `application.js`).

Never cached: every check reads `connection.scopes` live, so a reconnect, refresh, or a
merchant/user revoking a scope is reflected on the very next check — there is no stored
"capability" value anywhere to go stale or need invalidating.

### Where it's enforced

`resolveToolConnection` (`tool-assignments.js`) checks capability in **both** paths — an
explicit assignment connection, and the tenant-default connection resolved via
`resolveProviderAccount` — after the provider-match and health checks, and always **before**
the tool handler (and therefore before any credential retrieval or provider API call) is ever
reached. A missing capability produces `{blocked:true, reason:'CONNECTION_CAPABILITY_MISSING'}`,
which `runtime.js`'s `executeTool` surfaces as its own `CONNECTION_CAPABILITY_MISSING` tool-call
status (previously folded into the generic `CONNECTION_REQUIRED`), and which
`evaluateToolReadiness` (`agent-readiness.js`) surfaces as its own `ToolReadiness` status —
flowing into `evaluateAgentReadiness`'s existing, reason-agnostic aggregation exactly like any
other non-`READY` tool status (BLOCKED if required, PARTIAL if optional — no special-casing
needed, since that aggregation was already generic).

### A real, honest gap this audit found (not fixed, by design)

No current `AgentDefinition`'s **required** tool has an external capability dependency — every
required tool across all 12 agents is internal-only (`integrationSlug: null`), by the
deliberate Phase 4B design that no tenant is ever forced to connect a specific provider just to
enable an agent (Part 52). This means "a required tool with a missing capability blocks the
agent" cannot be demonstrated today with a *literal* end-to-end example — it is proven instead
by combining two independently-verified facts: `evaluateToolReadiness` correctly returns
`CONNECTION_CAPABILITY_MISSING` (tested directly), and `evaluateAgentReadiness`'s required-tool
aggregation blocks on *any* non-`READY` status, not specific reason strings (tested directly
against a required tool disabled outright). Documented here rather than silently claimed as
"tested end-to-end" when it isn't.

### Provider capability matrix

| Provider | Connection Mode | Capabilities Supported (`IntegrationDefinition`) | Capabilities Actually Enforced (`capability-map.js`) | Scope Source | Known Limitations |
|---|---|---|---|---|---|
| Salla | MULTI | `products.read`, `stock.read`, `orders.read` | `commerce.products.read`, `commerce.price.read`, `commerce.stock.read` (all via the one `products.read` scope — price/stock are fields on the same product resource, not separate scopes), `orders.read` | `salla-oauth.js` `DEFAULT_SCOPES`: `offline_access, products.read, orders.read, customers.read` | `customers.read` is granted but no tool uses it yet |
| WhatsApp | SINGLE | `messages.receive`, `messages.send`, `templates.read` | `messaging.send` (via `whatsapp_business_messaging`) | Shares Meta's OAuth grant (no separate WhatsApp identity) | `messages.receive`/`templates.read` aren't capability-gated — no tool declares them as a required capability |
| Meta | SINGLE | `publishing`, `messaging`, `analytics` | `publishing` (via `instagram_content_publish` OR `pages_manage_metadata`) | `meta-oauth.js` `DEFAULT_SCOPES` | `pages_manage_posts` — Meta's own documented requirement for a Facebook Page `/feed` post — is **not** currently requested; a pre-existing scope gap this hardening pass surfaces honestly rather than hides. `messaging`/`analytics` aren't capability-gated |
| Microsoft 365 | SINGLE | `mail.read`, `mail.send`, `calendar.read`, `calendar.write` | `mail.send` (`Mail.Send`), `calendar.read`/`calendar.write` (`Calendars.Read`/`Calendars.ReadWrite`) | `microsoft-oauth.js` `DEFAULT_SCOPES` + `CALENDAR_SCOPES` (calendar scopes only requested when `MICROSOFT_ENABLE_CALENDAR=true`) | A tenant connected before `MICROSOFT_ENABLE_CALENDAR` was set will correctly show `CONNECTION_CAPABILITY_MISSING` for calendar tools until reconnected — accurate, not a bug. `mail.read` isn't capability-gated |
| X | SINGLE | `publish`, `analytics` | `publish` (via `tweet.write`) | `x-oauth.js` `DEFAULT_SCOPES` | `analytics` isn't capability-gated |
| LinkedIn | SINGLE | `organization.publish`, `analytics` | `organization.publish` (via `w_organization_social` OR `rw_organization_admin`) | `linkedin-oauth.js` `DEFAULT_SCOPES` | `analytics` isn't capability-gated |
| Anthropic | MULTI | `llm.generate`, `llm.tools`, `llm.structured` | Not scope-gated — `API_KEY` auth has no OAuth scope model; access is all-or-nothing per key | N/A | Correctly has no `capability-map.js` entry |
| OpenAI | MULTI | `llm.generate`, `llm.tools`, `llm.structured` | Same as Anthropic | N/A | Same |
| Canva | UNAVAILABLE | *(none declared)* | N/A — tool `isAvailable:false` | N/A | No real implementation anywhere in this codebase |
