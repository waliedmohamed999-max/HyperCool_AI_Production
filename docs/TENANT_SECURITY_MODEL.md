# Tenant Security Model

This document is the security reference for HyperCool's multi-tenant foundation (Phase 1
through 3.5 — see `docs/MULTI_TENANT_ARCHITECTURE.md` for the narrative). It covers tenant
resolution, membership, IDOR protection, and isolation per subsystem, plus the full,
factual classification of every table in the database.

**Phase 6B addition**: the Connector Runtime (`src/connectors/core/runtime.js`) applies the
exact same IDOR-safe pattern described below to every connector action and health check — a
connection id belonging to Tenant A resolves to `null` under Tenant B's `tenantId` (via the
same tenant-scoped `getConnectionOrNull`), so no outbound HTTP call — and therefore no secret
retrieval from the Vault — is ever reachable across a tenant boundary, even with the exact real
connection id guessed. Proven directly by `tests/generic-rest-connector.test.js`'s cross-tenant
test, which also asserts the mock transport was never called at all. See
`docs/GENERIC_REST_CONNECTOR.md` and `docs/CONNECTOR_SSRF_SECURITY.md` for the rest of the
Generic REST Connector's security model (SSRF protection, header/secret handling).

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

## Fail-open vs. fail-closed — what Phase 3 actually changed, and what it didn't

The spec asks for a hard fail-closed behavior: a tenant-owned operation with no resolvable
tenant context must refuse with `TENANT_CONTEXT_REQUIRED`, never silently fall back to "the
first tenant." Phase 1/2 left every tenant-scoped function's default
(`tenantId||resolveActiveTenantId(db)`) fail-*open* — safe only because there was genuinely
one tenant to fall into.

**Phase 3 closed this at the root.** `resolveActiveTenantId(db)` itself now checks how many
tenants actually exist: if there are two or more, it throws
`Object.assign(new Error('TENANT_CONTEXT_REQUIRED'),{code:'TENANT_CONTEXT_REQUIRED',status:400})`
instead of guessing. Since this is the one function every tenant-scoped default ultimately
calls, this single change converts **every** omitted-`tenantId` call site across the entire
codebase (~40+ of them, spanning every table listed below) from fail-open to fail-closed
simultaneously, with zero per-call-site changes. Proven directly in `tests/tenancy.test.js`:
`saveCredentials`/`getCredentials` called with no `tenantId` throw `TENANT_CONTEXT_REQUIRED`
the moment a second tenant is created.

**What this mechanism does NOT give you on its own** — and what Phase 3.5 closed:

1. **HTTP routes bypass it entirely, safely.** A real request never reaches
   `resolveActiveTenantId`'s guess-or-throw logic at all — `session.tenantId` is set from
   `resolveTenantForUser(db, userId)` (a real membership-table lookup) right after login,
   at `application.js`'s auth block. This is correct by construction regardless of how many
   tenants exist; it simply means the guard is a safety net for code paths *other* than
   HTTP requests, not proof that HTTP routes were individually audited (they were, separately
   — see the per-route `session.tenantId` threading across Phase 2/3).
2. **Background work — fixed in Phase 3.5, not just made to fail loud.** The scheduler's
   `tick()`, the follow-up-gap sweep, and every webhook handler used to have no session and
   call functions with no explicit `tenantId` — meaning they would have hit
   `resolveActiveTenantId`'s throw and stopped working *for every tenant, including the
   first*, the instant a second tenant existed (safe, but not functional). Phase 3.5 added
   `listTenants()` (`src/tenancy.js`) and rewrote the scheduler to loop over every eligible
   tenant, and rewrote every webhook handler to resolve a real tenant from the provider's own
   verified identity instead of relying on the default at all. See
   `docs/TENANT_SCHEDULER.md` and `docs/WEBHOOK_TENANT_ROUTING.md`.
3. **Two tables genuinely have no tenant concept to fail closed on**: `crm_messages`/
   `crm_followups` remain SHARED_SAFE-by-design (isolated transitively via `lead_id`, see
   below) — this is intentional, not a gap. Every other table in this codebase now has a real
   `tenant_id` column (see the classification table below) — there is no longer a table that
   would silently leak.

**Net effect**: creating a real second tenant today is both *safe* (no cross-tenant data leak
has been found or is expected — every route, the scheduler, and every webhook handler either
resolves a real tenant or fails loud/unresolved) and, for everything built so far,
*functional* (scheduled jobs and webhook ingestion now run correctly per tenant rather than
assuming there is only one). This is the honest basis for this phase's GO/NO-GO decision —
see the final report.

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
| Webhook events | **Isolated (Phase 3.5)** | Each delivery resolves to a real tenant via the provider's own verified identity (WhatsApp phone_number_id, Microsoft subscriptionId, Salla merchant id) — never a default guess. An identity matching no tenant is stored as a diagnostic `TENANT_UNRESOLVED` row (`tenant_id` NULL) and never turned into a business event. See `docs/WEBHOOK_TENANT_ROUTING.md`. |
| Content (drafts/review/approval/publish state) | **Isolated (Phase 3)** | Migrated off the legacy `state.content` JSON array into a real `content_items` SQL table (`src/content.js`) — composite filtering via `tenant_id`, same indexed-columns+json-blob pattern as `crm_leads`/`agent_approvals`. See `docs/CONTENT_MIGRATION.md`. |
| Content Calendar (`calendar_slots`) | **Isolated (Phase 3)** | Composite unique `(tenant_id, date, platform)` — table recreated (the old `UNIQUE(date,platform)` would have let a second tenant collide with the first's calendar). |
| Content Scheduling (`schedule_jobs`) | **Isolated (Phase 3)** | Additive `tenant_id` column + index; the existing partial unique index on `content_id` alone stays correct because a `content_id` is already unique to one tenant. |
| Operations Log (`audit_logs`, replaces `state.audit`) | **Isolated (Phase 3)** | Migrated off the legacy `state.audit` JSON array into a real `audit_logs` SQL table (`src/audit.js`) — same indexed-columns+json-blob pattern. See `docs/AUDIT_MIGRATION.md`. This was the second, and last, of the two Phase-3-named hard problems. |
| CRM follow-ups / messages (list-level reads) | **Isolated (Phase 3)** | `listFollowups`/`listAllMessages` had no tenant filter at all — a real fail-open gap discovered while migrating the audit log (the sales dashboard, weekly report, and Operations Log all list through these). Fixed by joining through `crm_leads.tenant_id`; individual reads by `lead_id` were already safe transitively. |
| Agent definitions/config (`agent_registry`, `agent_autonomy`) | **Global by design this pass** | See "Design decisions" below. |
| Sessions, runtime pause switch | **Global by design** | Correctly so — a session belongs to a user, not a tenant; the pause switch is a platform-wide kill switch (spec's own example of a legitimately shared control). |

## Full table classification (Phase 2 + 3 audit)

| Table | Classification | tenant_id? |
|---|---|---|
| `tenants`, `tenant_memberships` | SYSTEM_INTERNAL (the tenancy layer itself) | n/a |
| `users` | GLOBAL_DEFINITION (identity; tenant assigned via membership) | No — `username` stays globally unique by design |
| `sessions` | SYSTEM_INTERNAL | No |
| `runtime_gate` | SYSTEM_INTERNAL (explicit shared kill switch) | No |
| `integration_credentials` | TENANT_OWNED | **Yes** (Phase 1) |
| `crm_leads` | TENANT_OWNED | **Yes** (Phase 1) |
| `crm_messages`, `crm_followups` | SHARED_SAFE (transitive via `lead_id`) | No (by design) |
| `crm_requests` | TENANT_OWNED | **Yes** (Phase 3 — composite PK `(tenant_id,key)`, table recreated) |
| `memory` | TENANT_OWNED | **Yes** (Phase 2) |
| `products` | TENANT_OWNED | **Yes** (Phase 2 — critical bug fixed) |
| `ai_runs` | TENANT_OWNED | **Yes** (Phase 3 — composite unique `(tenant_id,request_key)`, table recreated) |
| `compliance_runs` | TENANT_OWNED | **Yes** (Phase 3 — composite unique `(tenant_id,request_key)`, table recreated) |
| `weekly_reports`, `daily_briefs` | TENANT_OWNED | **Yes** (Phase 2, row-level only) |
| `calendar_slots` | TENANT_OWNED | **Yes** (Phase 3 — composite unique `(tenant_id,date,platform)`, table recreated) |
| `schedule_jobs` | TENANT_OWNED | **Yes** (Phase 3 — additive column + index) |
| `content_items` (replaces `state.content`) | TENANT_OWNED | **Yes** (Phase 3 — real SQL table, see `docs/CONTENT_MIGRATION.md`) |
| `agent_events` | TENANT_OWNED | **Yes** (Phase 2) |
| `agent_escalations` | TENANT_OWNED | **Yes** (Phase 2) |
| `agent_approvals` | TENANT_OWNED | **Yes** (Phase 2) |
| `webhook_events` | TENANT_OWNED (nullable only for a diagnostic `TENANT_UNRESOLVED` row) | **Yes** (Phase 2 column; Phase 3.5 — real per-provider routing, see `docs/WEBHOOK_TENANT_ROUTING.md`) |
| `agent_runs` | TENANT_OWNED | **Yes** (Phase 2) |
| `agent_tool_calls` | SHARED_SAFE (transitive via `run_id`) | No (by design) |
| `whatsapp_templates` | TENANT_OWNED | **Yes** (Phase 3 — composite unique `(tenant_id,name,language)`, table recreated) |
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

## Phase 4C-3 update: workspace invitations + member management

`resolveTenantForUser(db, userId)` above is now called with a third argument,
`activeTenantIdFromSession` (Phase 4C-1 — see `docs/WORKSPACE_SELECTION.md`); everything in
this document about it being looked up fresh from real `tenant_memberships` on every request,
never trusted from client input, is unchanged and is exactly what makes Phase 4C-3's
invitation acceptance and member suspension/removal safe with zero new invalidation logic (see
`docs/WORKSPACE_INVITATIONS.md` and `docs/WORKSPACE_MEMBERS.md` for the full detail). The new
`workspace_invitations` table follows the same tenant-scoping discipline as every table in this
document's classification: every read/write filters `tenant_id=?`, and a foreign id is
indistinguishable from a nonexistent one (404), never a distinguishable "not yours" response.

## Phase 4C-5 update: `users.email` is intentionally GLOBAL, not tenant-scoped

`docs/PLATFORM_IDENTITY.md` adds `email`/`email_verified_at`/`pending_email` directly to the
existing `users` table — the ONE identity concept in this system that is deliberately **not**
tenant-scoped, by design (Part 57/58/59): one verified person can hold different roles across
multiple workspaces without needing a duplicate account per workspace. This does not weaken
tenant isolation anywhere else — `email_verification_tokens` and `password_reset_tokens` are
likewise correctly global (keyed by `user_id`, never `tenant_id`), and every account-identity
route (`/api/account/*`, `/api/auth/forgot-password`, `/api/auth/reset-password`) resolves its
subject exclusively from `session.user.id` or a token's own `user_id` — never from
`session.tenantId` or any request-supplied tenant value, so this new surface introduces no new
cross-tenant attack path. `workspace_invitations.invitation_mode='EMAIL_BOUND'` (new) still
enforces its identity check per-tenant-scoped invitation, unaffected by this global layer.

## Phase 4C-6 update: a real, pre-existing cross-tenant access gap, found and closed

This phase found and fixed a genuine security issue in `resolveTenantForUser` itself (§7),
not merely added a new surface on top of it. Its zero-membership branch has always
auto-attached a user with no real memberships to the sole existing tenant, **when exactly one
tenant exists system-wide** — safe when the only way to get a new user was `/api/setup` or an
owner-created team member (both already scoped to that one tenant), but this precondition
silently broke the moment self-service public signup could create users unconnected to any
tenant. Since the real HyperCool deployment has exactly one tenant today, *any stranger signing
up publicly would have been auto-attached to — and, since `role` defaults to `'owner'` for a
signup, made an OWNER of — that real production tenant*, before this was caught (by an
unrelated test assertion, before ever reaching a browser) and fixed with a new
`users.self_registered` marker that this one auto-attach path now checks and refuses for. See
`docs/SELF_SERVICE_SIGNUP.md` for the full account, and `docs/WORKSPACE_CREATION.md`/
`docs/TRIAL_WORKSPACES.md` for the rest of this phase's tenant-creation surface — every new
route in it resolves its subject from `session.user.id` alone and never accepts a client-
supplied owner/tenant id (verified directly by test).
