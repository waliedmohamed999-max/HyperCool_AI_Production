# Tenant Security Model

This document is the security reference for HyperCool's multi-tenant foundation (Phase 1 +
2 + 3 — see `docs/MULTI_TENANT_ARCHITECTURE.md` for the narrative). It covers tenant
resolution, membership, IDOR protection, and isolation per subsystem, plus the full,
factual classification of every table in the database.

## Tenant resolution

`src/tenancy.js` is the single source of truth. `resolveTenantForUser(db, userId)` is what
a real per-request context calls — wired into `src/application.js` right after a session is
resolved from its cookie: `session.tenantId = resolveTenantForUser(store.db,
session.user.id)`. This is **never** trusted from a query string, request body, or header —
it is looked up fresh, every request, from the real `tenant_memberships` table.

`resolveActiveTenantId(db)` is the internal library default used by every tenant-scoped
function's optional trailing `tenantId` parameter when a caller doesn't supply one — it
resolves to the one real tenant that exists today (there being only one reachable from any
route in this codebase currently). This is a correct value, not a placeholder — see
"Fail-open vs. fail-closed" below for the important nuance this implies.

## Membership

`tenant_memberships (id, tenant_id, user_id, role, status, is_owner, created_at)`.
`users` (identity) and `tenant_memberships` (role-within-a-company) are deliberately
separate, per the spec's own "User = identity, TenantMembership = role" principle — the
schema already supports one user holding memberships (and different roles) in more than one
tenant, even though no UI exists yet to exercise that.

## Fail-open vs. fail-closed — an honest limitation, not a hidden one

The spec's Phase 38-39 asks for a hard fail-closed behavior: a tenant-owned route with no
resolvable tenant context must return `TENANT_CONTEXT_REQUIRED`, never silently fall back to
"the first tenant." **This codebase does not yet implement that fail-closed check** — every
tenant-scoped function's default (`resolveActiveTenantId`) is a fail-*open* default to the
one active tenant, chosen deliberately in Phase 1 so that ~25 existing files and their tests
never needed to change. In today's actual deployment (one tenant reachable from any real
session) this is behaviorally identical to fail-closed — there is no *other* tenant for a
request to accidentally fall into. It stops being safe the moment a second tenant is
reachable through the UI without every route being audited to pass `session.tenantId`
explicitly. **This is the single most important thing to fix before onboarding a real second
paying customer** — see "Remaining risks" in the final report.

## IDOR protection — how it actually works

Every tenant-scoped read/write ends in a `WHERE tenant_id=?` clause (or, for tables reached
transitively — `crm_messages`, `crm_followups`, `agent_tool_calls` — through a parent id
whose owning row was already tenant-checked). A request for another tenant's real,
guessable-if-you-had-it UUID returns exactly the same response as a request for an id that
never existed: a 404 or `null`, never a distinguishable "exists but you can't see it."
Proven, not asserted: `tests/tenancy.test.js` (8 tests) and `tests/tenancy-phase2.test.js`
(4 tests) include real IDOR attempts over actual HTTP with two real logged-in sessions —
credentials, CRM leads, brand memory, agent runs (list and direct-id fetch), approvals (list
and decide), escalations (list and resolve), weekly reports, and the product catalog
delete-bug fix.

## Per-subsystem isolation status

| Subsystem | Status | Notes |
|---|---|---|
| Integration credentials | **Isolated** | Composite PK `(tenant_id, provider)` — real schema change, not just a filter. |
| CRM leads | **Isolated** | Composite unique `(tenant_id, contact_key)`; messages/followups isolated transitively via `lead_id`. |
| Brand Memory | **Isolated** | Composite unique `(tenant_id, key, version)`. |
| Product catalog (Salla) | **Isolated** | Composite PK `(tenant_id, id)`; the catalog-wipe bug is fixed. |
| Agent runs / tool calls | **Isolated** | Tenant resolved once per `AgentRuntime.run()`, threaded through the run row and every tool call's `ctx`. |
| Agent events | **Isolated** | Real column; `emit()` stamps it. |
| Escalations (human handoff) | **Isolated** | Hot-lead and publish-reconciliation escalations both carry the real tenant. |
| Approvals | **Isolated** | A decision on another tenant's approval id 404s. |
| Weekly reports / daily briefs | **Isolated (Phase 3)** | The report row can't collide across tenants (Phase 2). As of Phase 3, both its content-derived numbers (drafts, published, pipeline — from `content_items`) and its audit-derived numbers (`auditByAction` — from `audit_logs`) are correctly scoped to that tenant, not just the row itself. |
| Webhook events | **Column present, routing not implemented** | Every delivery resolves to the one active tenant; real per-delivery routing (via provider account id) needs the not-yet-built multi-connection model. |
| Content (drafts/review/approval/publish state) | **Isolated (Phase 3)** | Migrated off the legacy `state.content` JSON array into a real `content_items` SQL table (`src/content.js`) — composite filtering via `tenant_id`, same indexed-columns+json-blob pattern as `crm_leads`/`agent_approvals`. See `docs/CONTENT_MIGRATION.md`. |
| Content Calendar (`calendar_slots`) | **Isolated (Phase 3)** | Composite unique `(tenant_id, date, platform)` — table recreated (the old `UNIQUE(date,platform)` would have let a second tenant collide with the first's calendar). |
| Content Scheduling (`schedule_jobs`) | **Isolated (Phase 3)** | Additive `tenant_id` column + index; the existing partial unique index on `content_id` alone stays correct because a `content_id` is already unique to one tenant. |
| Operations Log (`audit_logs`, replaces `state.audit`) | **Isolated (Phase 3)** | Migrated off the legacy `state.audit` JSON array into a real `audit_logs` SQL table (`src/audit.js`) — same indexed-columns+json-blob pattern. See `docs/AUDIT_MIGRATION.md`. This was the second, and last, of the two Phase-3-named hard problems. |
| CRM follow-ups / messages (list-level reads) | **Isolated (Phase 3)** | `listFollowups`/`listAllMessages` had no tenant filter at all — a real fail-open gap discovered while migrating the audit log (the sales dashboard, weekly report, and Operations Log all list through these). Fixed by joining through `crm_leads.tenant_id`; individual reads by `lead_id` were already safe transitively. |
| Agent definitions/config (`agent_registry`, `agent_autonomy`) | **Global by design this pass** | See "Design decisions" below. |
| Sessions, runtime pause switch | **Global by design** | Correctly so — a session belongs to a user, not a tenant; the pause switch is a platform-wide kill switch (spec's own example of a legitimately shared control). |

## Full table classification (Phase 2 audit)

| Table | Classification | tenant_id? |
|---|---|---|
| `tenants`, `tenant_memberships` | SYSTEM_INTERNAL (the tenancy layer itself) | n/a |
| `users` | GLOBAL_DEFINITION (identity; tenant assigned via membership) | No — `username` stays globally unique by design |
| `sessions` | SYSTEM_INTERNAL | No |
| `runtime_gate` | SYSTEM_INTERNAL (explicit shared kill switch) | No |
| `integration_credentials` | TENANT_OWNED | **Yes** (Phase 1) |
| `crm_leads` | TENANT_OWNED | **Yes** (Phase 1) |
| `crm_messages`, `crm_followups` | SHARED_SAFE (transitive via `lead_id`) | No (by design) |
| `crm_requests` | TENANT_OWNED | No — deferred, low severity (idempotency-key cache only) |
| `memory` | TENANT_OWNED | **Yes** (Phase 2) |
| `products` | TENANT_OWNED | **Yes** (Phase 2 — critical bug fixed) |
| `ai_runs`, `compliance_runs` | TENANT_OWNED | No — deferred (no longer blocked by `state.content`, which is now real; simply not yet migrated) |
| `weekly_reports`, `daily_briefs` | TENANT_OWNED | **Yes** (Phase 2, row-level only) |
| `calendar_slots` | TENANT_OWNED | **Yes** (Phase 3 — composite unique `(tenant_id,date,platform)`, table recreated) |
| `schedule_jobs` | TENANT_OWNED | **Yes** (Phase 3 — additive column + index) |
| `content_items` (replaces `state.content`) | TENANT_OWNED | **Yes** (Phase 3 — real SQL table, see `docs/CONTENT_MIGRATION.md`) |
| `agent_events` | TENANT_OWNED | **Yes** (Phase 2) |
| `agent_escalations` | TENANT_OWNED | **Yes** (Phase 2) |
| `agent_approvals` | TENANT_OWNED | **Yes** (Phase 2) |
| `webhook_events` | TENANT_OWNED | **Yes** (Phase 2, column only — routing deferred) |
| `agent_runs` | TENANT_OWNED | **Yes** (Phase 2) |
| `agent_tool_calls` | SHARED_SAFE (transitive via `run_id`) | No (by design) |
| `whatsapp_templates` | TENANT_OWNED | No — deferred, low severity (a tenant's approved WhatsApp templates) |
| `agent_registry` | GLOBAL_DEFINITION (design decision) | No |
| `agent_autonomy` | GLOBAL_DEFINITION (design decision) | No |
| `audit_logs` (replaces `state.audit`) | TENANT_OWNED | **Yes** (Phase 3 — real SQL table, see `docs/AUDIT_MIGRATION.md`) |

### Design decisions (not mechanical fixes)

- **`users.username`** stays globally unique rather than `(tenant_id, username)` — this
  codebase's login model has always been "one identity, one set of credentials," and no
  requirement was given to change that (e.g. to let two different tenants each have their
  own user named `admin`). Revisit if that's actually wanted.
- **`agent_registry`/`agent_autonomy`** stay global — per the spec's own
  `AgentDefinition = GLOBAL` example. Making `enabled`/`model`/`temperature`/autonomy level
  genuinely per-tenant means introducing a real `TenantAgentConfig` table (spec Part 22),
  which is a new schema addition, not a migration of an existing one — deliberately left
  for the Control Center phase, where it belongs alongside the UI that would configure it.

## Event Bus isolation

`agent_events.tenant_id` is a real column. `createEventBus(db).emit(type, payload, runId)`
stamps it from `payload.tenantId` when the caller supplies one, else the resolved default.
As of Phase 3, `CONTENT_APPROVED`, `CONTENT_PUBLISH_REQUESTED` and `CONTENT_PUBLISHED` all
carry a real, resolved `tenantId` too (threaded from `session.tenantId` at the HTTP layer,
through `planning.js`'s `prepareDue`/`scheduleContent` and `runtime/tools.js`'s
`finalizePublishResult`) — they are no longer the "resolves to the default tenant" case this
section used to describe, now that `content_items` itself is tenant-scoped.

## Frost / orchestrator tenant context

`src/runtime/orchestrator.js`'s event routing calls `runtime.run(route.agentId, {...,
input: route.buildInput(payload), tenantId: payload.tenantId})` (fixed in Phase 3) — every
stored event row already carries a real `tenant_id` (`src/runtime/events.js`'s `emit()`
always stamps it), and the orchestrator now reads it back and threads it into the run it
triggers, instead of letting `AgentRuntime.run()` silently fall back to its own default.
Frost-routed (event-triggered) runs are therefore attributed to the triggering event's real
tenant, not just "the one that exists" — the same as manually-triggered runs (`POST
/api/agents/:id/run`), which already passed `session.tenantId` explicitly.
