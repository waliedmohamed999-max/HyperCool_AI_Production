# Connection-Aware Runtime (Multi-Tenant Phase 4B)

How a tool call actually flows through the runtime once assignments and connections exist,
and — the part most likely to bite a future change — exactly which legacy provider lookups
had to learn to accept a real `tenantId` for this to be safe with a second tenant.

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
