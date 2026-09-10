# Multi-Tenant Architecture — Phase 1 (Foundation)

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

## What is deliberately NOT built yet

This was an explicit, informed scoping decision (the owner chose "start with the safe
foundation only" after seeing the true size of the full spec) — these are real, substantial
next-phase items, not oversights:

- **Multiple named connections per integration** (spec Part 9: "2 Salla stores, 3 Meta
  Pages"). Today a tenant can have exactly one connection per provider (a real improvement
  over the old system-wide-one-connection limit, but not yet the full "Main Store / Riyadh
  Store" multi-connection model).
- **The Integration & Agent Control Center UI** (6 tabs: Integrations, Agent Connections,
  AI Providers, Permissions & Policies, Testing & Health, Workspace Settings) — none of
  this UI exists. Every capability above is real at the data/API layer; there is no
  dashboard page yet for an owner to create a second tenant, connect its integrations, or
  configure its agents without directly touching the database.
- **Onboarding wizard, config export/import, company templates/cloning** (spec Parts
  49-53) — not built. `createTenant()` exists and is tested but is not reachable from any
  route yet.
- **Per-tenant agent configuration** (`agent_registry`/`agent_autonomy` are still global —
  one autonomy level and one provider/model override per agent, system-wide, not yet
  per-tenant). A second tenant would currently share the first tenant's agent settings.
- **Brand Memory, content, approvals, audit/events, schedule_jobs, webhook_events** are
  still global (no `tenant_id` column). A second tenant's content/approvals/brand facts
  would currently be visible to/mixed with the first tenant's.
- **Webhook tenant routing** (spec Part 60-61): inbound Salla/Meta/Microsoft webhooks still
  resolve to "the" single active tenant, not a specific tenant identified by the provider
  account id in the payload — because only one tenant can hold a given provider connection
  in practice until a real Control Center lets a second tenant connect its own.
- **Scheduler/queue tenant loop** (spec Part 62-63): `tick()` still runs once globally
  (there is still no queue in this codebase at all, tenant-aware or otherwise) rather than
  once per tenant.
- **Cache/storage isolation** (spec Part 65-66): not applicable yet — no cache layer or
  file storage exists in this codebase.
- **Platform Super Admin role** (spec Part 58-59): not built — there is no cross-tenant
  view of any kind today, by omission rather than by an enforced boundary (since only one
  tenant is reachable from any real route regardless).

None of the above were silently skipped — each is a real, scoped, buildable next phase once
the Control Center UI itself is greenlit.
