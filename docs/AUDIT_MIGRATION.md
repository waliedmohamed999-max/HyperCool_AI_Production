# Audit / Operations Log Migration (Multi-Tenant Phase 3)

This document records exactly what changed when the Operations Log (every approval,
connection, publish outcome, promotion, and system event) moved off the legacy
`state.audit` JSON array and onto a real SQL table — the second of the two hard
architectural problems named for Phase 3 (see `docs/MULTI_TENANT_ARCHITECTURE.md`).

## Why

Exactly the same problem as `state.content` before `docs/CONTENT_MIGRATION.md`:
`state.audit` was one array inside the single-row `state` table's JSON blob
(`src/store.js`), read and rewritten *in full* by every `store.mutate()`/`store.read()`
call. Every tenant would have shared the exact same audit trail — a second tenant would
see the first tenant's connections, promotions, and publish history in its own Operations
Log.

## What changed

- New table `audit_logs` (`src/audit.js`): `id, tenant_id, action, item_id, actor_id,
  created_at, json` + indexes on `(tenant_id)`, `(tenant_id,created_at)`,
  `(tenant_id,action)`. Same "indexed columns + json blob" pattern as `content_items` —
  every call site's entry object (which already varies: `detail`, `errorCode`, `count`,
  `organizationId`, `itemName`, ...) is preserved verbatim in `json`; only a few fields are
  promoted to real columns for filtering. No pure reader function
  (`computeRecentActivity`, `computeContentPipeline`, `computeContentLibrary`,
  `xActivity`/`linkedinActivity`/`sallaActivity`/`metaActivity`/`microsoftActivity`) needed
  to change — only what array their caller passes them did.
- `installAuditLog(db)` creates the table and runs a one-time, idempotent backfill
  (`migrateLegacyStateAudit`) that copies every entry out of `state.audit` into
  `audit_logs`, assigning every row to the one tenant that owned all pre-migration data.
  Guarded by "the table is still empty." Inserted in **reverse** order (oldest legacy entry
  first) so `rowid` order matches real chronological order — `listAuditLog`'s
  `ORDER BY created_at DESC, rowid DESC` then breaks same-millisecond ties (common: several
  audit entries from one request often share an identical timestamp) exactly the way the
  original `.unshift()`-based array order would have.
- `state.audit` itself is left completely untouched — frozen, unused historical backup
  from this point on, same policy as `state.content`.
- `recordAudit(db, entry, tenantId=null)` — the writer, replaces every
  `state.audit.unshift(entry)` call site. Takes the exact same entry object every call site
  already built.
- `listAuditLog(db, {tenantId, limit, sinceIso, action})` — the reader, replaces every
  `state.audit`/`auditState.audit` read (`.filter()`, `.find()`, `[0]`, or passed whole into
  a pure `compute*` helper).

## Call sites updated (every former `state.audit` reference)

| File | What changed |
|---|---|
| `src/application.js` | 14 OAuth connect/disconnect/sync audit writes (Salla, Meta, WhatsApp templates, Microsoft, X, LinkedIn), `USER_CREATED`/user-management audit writes, `EMAIL_INGEST_FAILED`, memory save, Salla catalog sync (success + failure), and the shared `log()` helper used by the content revise/reject/review/approve routes — all now call `recordAudit`, threading `session.tenantId` (or `webhookTenantId` for webhook-triggered ones) instead of mutating `state.audit`. `/api/state` (already merging live content, see `docs/CONTENT_MIGRATION.md`) now also merges `listAuditLog(store.db, {tenantId})` into its response. `/api/team/dashboard` reads via `listAuditLog` instead of `store.read().audit`. |
| `src/crm.js` | The file's own internal `audit()` helper (used by `createLead`, `updateLead`, `recordMessage`, `findOrCreateLeadFromChannel`, `recordChannelMessage`, `contactControl`, `createFollowups`, `approveFollowup`, `prepareFollowups`, `cancelFollowups`) now calls `recordAudit` against `store.db` instead of mutating a `state` array. Also fixed a related fail-open gap discovered while touching this file: `listFollowups`/`listAllMessages` had **no tenant filter at all** (a real second tenant would see every tenant's follow-ups and messages) — both now join through `crm_leads` to scope by `tenant_id`, and `leadDetail` threads its `tenantId` through. |
| `src/autonomy.js` | `setAutonomy` gained an optional trailing `tenantId` parameter; its promotion/demotion audit entry uses `recordAudit`. |
| `src/generation.js` | `createGenerator`'s returned `generate(input,user,tenantId=null)` records `AI_DRAFT_CREATED` via `recordAudit`. |
| `src/compliance.js` | `createComplianceChecker`'s returned `check(...)` records `AI_COMPLIANCE_CHECKED` via `recordAudit`. |
| `src/planning.js` | The file's own internal `audit()` helper (used by `createCalendar`, `scheduleContent`, `cancelJobs`, `prepareDue`, `saveDailyBrief`) now calls `recordAudit`. |
| `src/reporting.js` | `buildWeeklyReport`'s `auditInWeek` now reads via `listAuditLog`; `saveWeeklyReport`'s `WEEKLY_REPORT_CREATED` entry uses `recordAudit`. Also fixed two related fail-open gaps found while touching this file: `buildExecutiveReport`'s `allLeads` and `buildWeeklyReport`'s `followupsInWeek` were reading `listLeads`/`listFollowups` with **no tenant filter**; both now thread `tenantId` through. |
| `src/sales-dashboard.js` | `buildSalesDashboard` gained a `tenantId` option; `recentActivity` reads via `listAuditLog` instead of `store.read().audit`. Same fail-open gaps as above applied here too (`listLeads`/`listFollowups`/`listAllMessages` were all unscoped) — all three now take `tenantId`. |
| `src/content-ops.js` | `buildContentWorkspace`'s `pipeline`/`library` sections read via `listAuditLog` instead of `state.audit`. |
| `src/integration-ops.js` | `buildIntegrationsDashboard` reads via `listAuditLog`; `xActivity`/`linkedinActivity` (previously taking the whole `state` object just to reach `.audit`) now take a plain `audit` array parameter, matching `sallaActivity`/`metaActivity`/`microsoftActivity`'s existing signature shape. |
| `src/runtime/tools.js` | `finalizePublishResult`'s three outcome branches (`PUBLISHED`, `STATUS_UNKNOWN`, `FAILED`) and the `create_content` tool handler's `DRAFT_CREATED` entry all call `recordAudit` with `ctx.tenantId`. |

## What this does NOT cover

- Fail-closed conversion: `recordAudit`/`listAuditLog`'s `tenantId=null` default still
  resolves to "the one active tenant" (fail-*open*), consistent with every other table in
  this codebase. Converting this to a hard `TENANT_CONTEXT_REQUIRED` is a separate,
  not-yet-done piece of Phase 3.
- `ai_runs`, `compliance_runs`, `whatsapp_templates`, `crm_requests` were unrelated to the
  audit/content problem and not addressed by this specific migration — all four have since
  been tenant-scoped in a later pass of the same Phase 3 work (see
  `docs/TENANT_SECURITY_MODEL.md`'s table classification, which is current).
- A hypothetical `correlation_id` field (mentioned in the original spec's own description of
  an `AuditService`) was **not** added — nothing in this codebase currently threads a
  correlation id through the ~30 call sites that create audit entries, and inventing one now
  would mean fabricating data no caller actually tracks. `item_id`/`actor_id`/`action` are
  the only fields promoted to real columns because they are the only ones every call site
  reliably already provides.

## Verification performed

- Full test suite (281/281) green after every file's fix.
- Every test fixture that builds its own in-memory DB and exercises a function that writes
  or reads audit entries now calls `installAuditLog(db)`; every direct test seed of
  `state.audit` was converted to `recordAudit`, and every direct read of `store.read().audit`
  (outside of the `/api/state` HTTP tests, which already get live data via the route fix)
  was converted to `listAuditLog`.
- Migration verified against a real copy of the production database
  (`data/hypercool.sqlite`) in an isolated scratchpad directory before touching the real
  file: 4 real legacy audit entries, all migrated with `PRAGMA integrity_check: ok`, the
  owner account and user count unchanged, zero rows with an unresolved `tenant_id`, and the
  newest-first ordering (`DAILY_BRIEF_CREATED` → `WEEKLY_REPORT_CREATED` → ...) preserved
  exactly as the original array had it.
- Applied to the real `data/hypercool.sqlite`: the running server process was stopped,
  restarted (which runs `installAuditLog` on boot), and re-verified —
  `integrity_check: ok`, owner account intact, `audit_logs` table present with all 4 real
  entries correctly migrated.
