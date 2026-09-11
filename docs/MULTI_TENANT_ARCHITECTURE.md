# Multi-Tenant Architecture — Phase 1–3.5 (Foundation, Data Isolation, Content/Audit Normalization, Tenant-Aware Scheduler + Webhooks)

This document describes exactly what exists today after the first multi-tenant pass, and —
just as importantly — what deliberately does **not** exist yet. Before this pass, HyperCool
was a genuinely single-tenant system: one SQLite file, no company/organization concept
anywhere in the schema, and `integration_credentials` keyed by `provider` alone (one Salla
connection, one WhatsApp connection, etc. system-wide). This phase adds the real tenant
dimension to the two highest-risk, highest-value areas — **integration credentials** and
**CRM leads** — with a full, tested, real cross-tenant isolation guarantee for both. It
does **not** attempt the full 120-phase SaaS/Control-Center vision in one pass; see
"What is deliberately NOT built yet" below for the honest boundary.

## The Tenant model (`src/tenancy.js`)

```
tenants (id, name, slug, status, plan, default_locale, timezone, branding_settings,
         system_mode, created_at, updated_at)
tenant_memberships (id, tenant_id, user_id, role, status, is_owner, created_at)
```

- `status` is one of `ACTIVE` / `SUSPENDED` / `TRIAL` / `ARCHIVED` (enforced by a `CHECK`
  constraint), matching the spec's Tenant model exactly.
- **Identity vs. membership, as specified**: `users` (in `src/store.js`) remains the pure
  identity table (unchanged) — `tenant_memberships` is the new layer that says which
  company a user belongs to and what role they hold *there*. A user is not hardcoded to
  belong to exactly one tenant forever; the schema already supports a future user with two
  membership rows in two different tenants, each with its own role.
- **`ensureDefaultTenant(db)`** is the real, lossless, idempotent backfill (spec Part
  99-101): the first time it runs on a real database, it creates exactly one tenant
  (`"HyperCool"`) and attaches every existing user to it with their current global role
  copied over verbatim. Verified against a real copy of the production database during
  this pass: `integrity_check: ok`, owner account identical before/after, exactly one
  tenant created, one membership row correctly linking the owner with `role: 'owner'`,
  `is_owner: 1`.
- **`resolveTenantForUser(db, userId)`** is what a real per-request `TenantContext` calls.
  Wired into `src/application.js`: right after a session is resolved from its cookie,
  `session.tenantId = resolveTenantForUser(store.db, session.user.id)` — resolved fresh
  every request from the real `tenant_memberships` table, **never** trusted from a query
  string, request body, or header.

## Tenant isolation — what is actually backend-enforced today

Two entities were migrated to a real, tested `tenant_id` scope this pass:

### 1. Integration credentials (`src/runtime/credentials.js`)
The table's primary key changed from `provider` alone to **`(tenant_id, provider)`** — a
real schema change, not a decorative column. Before this, the whole database could only
ever hold one Salla connection, one WhatsApp connection, one Meta connection, etc.,
system-wide; now two tenants can each independently hold their own connection to the same
provider without collision. SQLite can't `ALTER` a primary key, so `installCredentials()`
detects the pre-tenant schema and safely recreates the table, backfilling every existing
row to the one real tenant that owns it (verified lossless against the real production
copy: 0 rows before, 0 rows after, schema correctly updated).

Every function (`saveCredentials`, `getCredentials`, `getCredentialsMeta`,
`updateCredentialsMetadata`, `clearCredentials`) takes an **optional trailing `tenantId`**.
Omitting it resolves to `resolveActiveTenantId(db)` — this is why **none of the ~12
existing files** that call this module (5 OAuth modules, the scheduler, `application.js`,
and every existing test) needed to change: they keep working exactly as before, now
correctly scoped to the one tenant that exists. An explicit `tenantId` is how a real second
tenant's connection gets created and read without ever touching the first tenant's row.

### 2. CRM leads (`src/crm.js`)
Same pattern: `crm_leads` gained a real `tenant_id` column, and `contact_key`'s uniqueness
changed from a global `UNIQUE` constraint to a composite `UNIQUE INDEX (tenant_id,
contact_key)` — meaning the same phone number or email address can now be a completely
separate, independent lead in two different companies (previously impossible: the second
company's inbound message would have been silently merged into the first company's
existing lead). `getLead`, `listLeads`, `searchLeads`, `leadDetail`, `findLeadByPhone`,
`findLeadByEmail`, `createLead`, `findOrCreateLeadFromChannel`, and `updateLead` all take
the same optional trailing `tenantId` pattern. `crm_messages`/`crm_followups` deliberately
did **not** get their own `tenant_id` column — they are only ever reached through a
`lead_id` that a tenant-scoped `getLead()` has already verified belongs to the caller's
tenant, so isolating the lead transitively isolates its messages and follow-ups.

At the HTTP layer, the primary CRM routes (`GET /api/crm`, `GET /api/crm/search`,
`POST /api/crm/leads`, `GET/POST /api/crm/leads/:id`, the manual WhatsApp/email send
routes) now pass `session.tenantId` explicitly rather than relying on the library
default — this is the real `TenantContext` enforcement point at the request boundary.

### Proof, not assertion
`tests/tenancy.test.js` (8 tests, all passing) includes real IDOR-style tests: two tenants
each save a credential and each create a lead with the identical phone number; every
attempt by one tenant to read, list into, or delete the other tenant's row is verified to
fail exactly like the record never existed (a 404/`null`, never a distinguishable "exists
but forbidden" response). One test runs the check through the real HTTP API with two real
logged-in sessions — not just at the library-function level.

## Phase 2 — Data isolation extended to 9 more tables + Agent/Event Bus tenant context

Phase 2 audited all 24 remaining tables (see `docs/TENANT_SECURITY_MODEL.md` for the full
classification) and migrated the ones that were both genuinely tenant-owned AND
independently isolable without first solving the `state.content`/`state.audit` problem
(see below). All nine follow the exact same optional-trailing-`tenantId` pattern as Phase 1
— zero existing call sites broke, verified by running the full suite (281/281) after each
table.

- **`memory` (Brand Memory)** — `UNIQUE(key,version)` → `UNIQUE(tenant_id,key,version)`.
- **`products` (Salla catalog) — critical bug fixed.** `replaceProducts()` used to run
  `DELETE FROM products` with **no tenant filter at all**, then reinsert keyed only by
  Salla's bare external product id. A second tenant syncing their own store would have
  silently **wiped the first tenant's entire catalog**. Now scoped: `PRIMARY KEY
  (tenant_id, id)`, delete scoped to `WHERE tenant_id=?`. Proven by a real HTTP test where
  Tenant B syncs an empty catalog and Tenant A's products are confirmed still present.
- **`agent_approvals`** — real `tenant_id`; a decision on another tenant's approval id now
  404s exactly like it never existed.
- **`agent_runs`** (+ `agent_tool_calls` transitively, via `run_id`) — every execution
  resolves its tenant ONCE at the top of `AgentRuntime.run()` and threads it through the
  run row, every tool call's `ctx.tenantId`, and every escalation the run creates.
- **`agent_events`** — real `tenant_id` column (not just a payload field); `emit()` stamps
  it from `payload.tenantId` when present, else the resolved default.
- **`agent_escalations`** — same pattern; `maybeEscalateHotLead` and the STATUS_UNKNOWN
  publish-reconciliation escalation both now carry the run's real tenant.
- **`weekly_reports`**, **`daily_briefs`** — composite PK `(tenant_id, date/week_start)`
  instead of a global PK. Their generated *contents* still partially aggregate from
  `state.content`/`state.audit` (still global — see below), so the report **rows** no
  longer collide across tenants, but a report's numbers are not yet a hard isolation
  guarantee.
- **`webhook_events`** — real `tenant_id` column, backfilled. Full routing (resolving which
  tenant a delivery is *for* from the provider's own account/store/phone id, never the
  payload's own claim) is not implemented — every delivery still resolves to the one real
  tenant, which is correct today but not yet load-bearing for a genuine second tenant with
  its own Salla/Meta connection.

Cross-tenant HTTP E2E proof: `tests/tenancy-phase2.test.js` (4 tests) — two real tenants,
two real logged-in sessions, verifying Tenant B cannot read Tenant A's brand memory, agent
runs (list or direct-id fetch), approvals (list or decide), escalations (list or resolve),
weekly reports, or product catalog (including the critical delete-bug proof above).

## Phase 3 — Content and Audit both normalized to real SQL tables; Calendar/Scheduling isolated

Phase 3 tackled both hard problems named above. `state.content` was migrated off the legacy
JSON blob array onto a real `content_items` SQL table (`src/content.js`), following the
exact same indexed-columns+json-blob pattern as `crm_leads`/`agent_approvals`. Every one of
the ~24 call sites across `application.js`, `content-ops.js`, `generation.js`,
`integration-ops.js`, `planning.js`, `reporting.js`, and `runtime/tools.js` was updated. See
`docs/CONTENT_MIGRATION.md` for the full call-site table and verification record.

`state.audit` (the Operations Log) was migrated the same way, onto a real `audit_logs` SQL
table (`src/audit.js`). Every one of the ~30 call sites across `application.js`,
`autonomy.js`, `compliance.js`, `content-ops.js`, `crm.js`'s own `audit()` helper,
`generation.js`, `integration-ops.js`, `planning.js`'s own `audit()` helper,
`reporting.js`, `runtime/tools.js`, and `sales-dashboard.js` was updated. See
`docs/AUDIT_MIGRATION.md` for the full call-site table. While migrating it, two related
fail-open gaps were discovered and fixed: `crm.js`'s `listFollowups`/`listAllMessages` and
`reporting.js`/`sales-dashboard.js`'s unscoped `listLeads` calls had **no tenant filter at
all** — a real second tenant would have seen every tenant's leads, follow-ups, and messages
in the sales dashboard and weekly report. Both are now properly scoped.

With content itself real and tenant-scoped, `calendar_slots` and `schedule_jobs` — which key
off `content_id` — were also migrated in the same pass:
`calendar_slots`'s `UNIQUE(date,platform)` table constraint was recreated as
`UNIQUE(tenant_id,date,platform)` (a second tenant's calendar can no longer collide with the
first's); `schedule_jobs` gained an additive `tenant_id` column (its partial unique index on
`content_id` alone stays correct, since a `content_id` is already unique to one tenant).

`src/runtime/orchestrator.js`'s event routing was also fixed to read back the real
`tenantId` every stored event already carries and thread it into the agent run it triggers,
closing the gap described in the old Phase 2 note about Frost-routed runs not being provably
attributed to a specific tenant.

Verified the same way as every prior migration: full suite (281/281) after each file, then
against a real copy of the production database before being applied to the real file and the
running server restarted and re-verified (`integrity_check: ok`, owner account intact) —
done twice, once for the content+calendar/scheduling migration and once for the audit
migration.

With both hard problems solved, the four previously-deferred tables (`ai_runs`,
`compliance_runs`, `whatsapp_templates`, `crm_requests`) were also closed in the same pass —
each following the identical table-recreation pattern (composite unique key including
`tenant_id`) already proven for `crm_leads`/`content_items`. `docs/TENANT_SECURITY_MODEL.md`
now lists every table in this codebase as either tenant-scoped, transitively safe by design,
or a documented, deliberate global default — none are silently unscoped anymore.

**A real cross-tenant test matrix caught six genuine bugs while writing it.** Building
`tests/tenancy-phase3.test.js` (6 new real HTTP IDOR tests covering every surface this phase
touched: content direct-id access, calendar/scheduling, WhatsApp templates, the CRM
idempotency cache, `ai_runs`, and `compliance_runs`) surfaced that `src/crm.js`'s
`contactControl`, `recordMessage`, `recordChannelMessage`, `cancelFollowups`,
`approveFollowup`, and `prepareFollowups` — plus one missed lookup inside `createFollowups`
itself — all called `getLead()`/`audit()` with no `tenantId` at all. None of these leaked
data (the fail-closed guard above would have caught that), but every one of them would have
thrown `TENANT_CONTEXT_REQUIRED` and hard-failed for *every* tenant, including the first, the
moment a second tenant existed. All seven are now fixed and threaded with a real `tenantId`
end to end (HTTP route → function → `getLead`/`audit`), and `prepareFollowups`'s underlying
query — which used to scan `crm_followups` globally with no tenant filter at all — now joins
through `crm_leads` to scope correctly, the same fix already applied to
`listFollowups`/`listAllMessages` earlier in this phase. This is exactly the value of writing
the real cross-tenant test matrix the spec asked for, rather than treating the central
fail-closed guard as sufficient on its own.

A central fail-closed mechanism was also added: `resolveActiveTenantId(db)`
(`src/tenancy.js`) — the default every tenant-scoped function's optional `tenantId`
parameter falls back to — now throws `TENANT_CONTEXT_REQUIRED` the instant a second tenant
exists, instead of silently guessing "the one tenant." This flips **every** call site across
the whole codebase that omits an explicit `tenantId` from fail-open to fail-closed for free,
with no per-call-site change needed, tested directly in `tests/tenancy.test.js`. See
"Fail-closed tenant resolution" below for what this does and does not cover.

## Phase 3.5 — the scheduler and webhooks became genuinely tenant-aware

Phase 3 closed the data-model gaps and added the central `resolveActiveTenantId`
fail-closed guard, but honestly flagged that the guard was a blanket safety net, not proof
that every code path was correct: HTTP routes never exercised it (they resolve via
`resolveTenantForUser` instead), and background work with no session — the scheduler and
every webhook handler — would have hit the guard's default and started throwing
`TENANT_CONTEXT_REQUIRED` on every run the instant a second tenant existed, stopping
automation entirely for every tenant, including the first.

Phase 3.5 closed that gap on both sides:

- **Scheduler** (`src/runtime/scheduler.js`): `listTenants(db)` (new function,
  `src/tenancy.js`) enumerates every `ACTIVE`/`TRIAL` tenant; every TENANT_JOB (daily brief,
  weekly report, follow-up sweep, scheduled publishing) now runs once per eligible tenant,
  sequentially, with one tenant's failure isolated from the rest. The Microsoft subscription
  renewal (a CONNECTION_JOB) loops over whichever tenants actually hold that connection. See
  `docs/TENANT_SCHEDULER.md` for the full job audit and architecture.
- **Webhooks** (Salla, WhatsApp/Meta, Microsoft 365): tenant is now resolved from each
  provider's own verified identity (a WhatsApp `phone_number_id`, a Microsoft
  `subscriptionId`, a Salla `merchant` id) — never from anything a payload claims to be. An
  identity that resolves to no tenant is recorded as a diagnostic
  `WEBHOOK_TENANT_UNRESOLVED` event and never turned into a business event; no new schema was
  needed since the mapping data already existed in `integration_credentials`. See
  `docs/WEBHOOK_TENANT_ROUTING.md` for the full resolution flow per provider and the honest
  Salla self-registration bootstrap it relies on.
- **A real cross-tenant test matrix caught six genuine bugs while writing it**: building
  `tests/tenancy-phase3.test.js` earlier surfaced that `contactControl`, `recordMessage`,
  `recordChannelMessage`, `cancelFollowups`, `approveFollowup`, and `prepareFollowups` in
  `src/crm.js` all omitted `tenantId` entirely — not leaks, but hard failures waiting to
  happen the moment a second tenant existed. All are now fixed.
- A minor, currently-unreachable fail-open gap in `resolveTenantForUser` was also closed: a
  user with more than one tenant membership (not possible via any route today) used to
  silently pick one via `LIMIT 1`; it now throws `TENANT_SELECTION_REQUIRED` instead of
  guessing. No selection UI or endpoint was built (see "What is deliberately NOT built yet").

With this, every automated code path in the codebase — HTTP routes, the scheduler, and every
webhook handler — either resolves a real, verified tenant or fails loud. Full suite: 297/297.

## Phase 4A — Integration Connection Core, multiple connections, Credentials Vault

Before this phase, a tenant could hold at most ONE credential per provider (`integration_
credentials`, one row per `(tenant_id, provider)`) — enough for one Salla store, one WhatsApp
number, one Microsoft mailbox. Phase 4A introduces `integration_connections` (multiple rows
per tenant per provider, a real default-connection concept, and a `CONNECTION_SELECTION_
REQUIRED` resolution rule for the ambiguous case) plus a per-connection encrypted Credentials
Vault and a DB-backed OAuth state mechanism — see `docs/INTEGRATION_CONNECTION_ARCHITECTURE.md`,
`docs/CREDENTIALS_VAULT.md`, and `docs/OAUTH_SECURITY.md` for the full design.

The central architectural decision was a **compatibility bridge**, not a rewrite: all 6
existing provider OAuth modules keep reading/writing the legacy `integration_credentials`
table completely unchanged, while `credentials.js`'s own functions mirror every write into
the new model as a best-effort side effect. `webhook-tenant-resolver.js` and the scheduler's
Microsoft connection job were both cut over to read `integration_connections` instead of the
legacy table (now that it is kept reliably in sync), while multi-connection OAuth itself was
proven end-to-end through one concrete provider (Salla — "Main Store" + "Riyadh Store" as two
real, independently-connected, independently-health-checked connections for one tenant).
Full suite after this phase: 330/330.

## What is deliberately NOT built yet

This was an explicit, informed scoping decision (the owner chose "start with the safe
foundation only," then "data isolation + Control Center foundation" for Phase 2, then
"fail-closed + Content/Audit normalization" for Phase 3, then "tenant-aware scheduler +
webhook routing" for Phase 3.5, each time explicitly deferring the UI and the next-hardest
piece) — these are real, substantial next-phase items, not oversights:

- **Active Tenant Selection UI/endpoint** — the unsafe *guessing* behavior for a
  multi-membership user is fixed (see above), but there is still no `POST
  /api/tenants/active` route, no `TENANT_SELECTION_REQUIRED` HTTP response handling, and no
  UI to pick a tenant. Deliberately not built: no route in this codebase can give an existing
  user a second membership yet (no invite/onboarding flow), so there is no real path to
  exercise such a UI against — building one now would be speculative, not scoped to an actual
  need.
- **Conversations/Messages/Quotes/Follow-ups** — already effectively isolated: these live
  inside `crm_leads`/`crm_messages`/`crm_followups`, reached only via a `lead_id` whose
  owning lead is tenant-checked (Phase 1). "Quotes" specifically are fields on the lead
  object itself (`quoteIntake`), not a separate entity.
- **Notifications** — no dedicated notifications table exists in this codebase at all
  (confirmed by the Phase 2 audit); real-time handoff/alerting is done via
  `agent_escalations` (tenant-scoped) and the Operations Log (also tenant-scoped, Phase 3).
- **Multiple named connections per integration** (spec Part 9: "2 Salla stores, 3 Meta
  Pages") — the data model, vault, health checks, and OAuth flow now support this for real
  (Phase 4A, see `docs/INTEGRATION_CONNECTION_ARCHITECTURE.md`), proven end-to-end for Salla.
  WhatsApp/Meta/Microsoft/X/LinkedIn still resolve to "the one (mirrored) connection this
  tenant has" — their generic multi-connection OAuth flow is not wired up yet, only Salla's.
- **The Integration & Agent Control Center UI** — no dashboard page exists yet for an owner
  to create a second tenant, connect its integrations, or configure its agents without
  directly touching the database. Deliberately deferred again this pass, per the explicit
  instruction to finish data isolation and fail-closed routing before building UI.
- **Onboarding wizard, config export/import, company templates/cloning** — `createTenant()`
  exists and is tested (creates an empty tenant + owner membership, copies zero business
  data) but is not reachable from any route yet.
- **Per-tenant agent configuration** (`agent_registry`/`agent_autonomy` remain global — one
  autonomy level and one provider/model override per agent, system-wide). A second tenant
  would currently share the first tenant's agent enable/model/autonomy settings. This is a
  genuine design decision, not a mechanical fix (see `docs/TENANT_SECURITY_MODEL.md`).
- **Cache/storage isolation**, **Platform Super Admin role**, **populating Salla's
  `external_account_id` at real connect time** (blocked on a live Salla app to verify the
  exact API call against) — unchanged; still not built.
- **Agent Tool Mapping / tool-to-connection assignment, and a Control Center UI for the new
  Integration Connections** — explicitly Phase 4B/4C per the owner's own phase split; Phase
  4A built the connection-ID-ready backend model these depend on, deliberately without an
  agent knowing which connection to use for a given call yet.

None of the above were silently skipped — each is a real, scoped, buildable next phase.
