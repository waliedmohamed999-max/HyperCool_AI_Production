# Content Migration (Multi-Tenant Phase 3)

This document records exactly what changed when content (drafts, reviewed/approved posts,
published records) moved off the legacy `state.content` JSON array and onto a real SQL
table. It exists so a future reader never has to reverse-engineer the migration from git
history.

## Why

Before this migration, every content item lived inside ONE array (`state.content`)
serialized into a single JSON blob (the `state` table's one row, `src/store.js`), read and
rewritten IN FULL by every `store.mutate()`/`store.read()` call. That made real per-tenant
isolation of content structurally impossible: every tenant would have shared the exact same
array, and a second tenant's content routes would have read and mutated the first tenant's
drafts. This was one of the three architectural problems explicitly named as blocking a real
second tenant.

## What changed

- New table `content_items` (`src/content.js`): `id, tenant_id, status, platform, date,
  created_at, json` + indexes on `(tenant_id)`, `(tenant_id,status)`, `(tenant_id,date)`.
  Same "indexed columns + json blob" pattern already used for `crm_leads`,
  `agent_approvals`, `memory`, `agent_escalations` — a handful of queryable columns
  alongside the full, variably-shaped domain object. This means `src/domain.js`'s pure
  `createContent`/`reviewContent`/`approveContent` functions needed **zero changes** — only
  where the result of calling them gets stored changed.
- `installContent(db)` creates the table and runs a one-time, idempotent backfill
  (`migrateLegacyStateContent`) that copies every item out of the legacy `state.content`
  array into `content_items`, preserving the item's real `id` and assigning every row to the
  one tenant that owned all pre-migration data. Guarded by "the table is still empty," so a
  server restart never re-copies or duplicates. Ordering: `content_items` is read back via
  `ORDER BY created_at DESC`, not `rowid`, because the legacy array's `.unshift()` semantics
  meant rowid-order would have inverted the original newest-first ordering.
- `state.content` itself is **left completely untouched** by the migration — it becomes a
  frozen, unused historical backup the moment `content_items` is populated. Nothing in the
  codebase reads or writes it after this migration (see the call-site list below); it is not
  deleted, in keeping with this project's "never delete data, even legacy, without a
  separate explicit instruction" rule.
- Repository functions (`src/content.js`): `listContent(db,tenantId=null)`,
  `getContent(db,id,tenantId=null)` (throws 404, matches `getLead`'s convention),
  `getContentOrNull(db,id,tenantId=null)` (non-throwing, for call sites that already return
  their own "not found" shape), `insertContent(db,item,tenantId=null)`,
  `writeContent(db,item)` (in-place update; keeps the `status`/`platform`/`date` indexed
  columns in sync with the json blob on every write).

## Call sites updated (every former `state.content` reference)

| File | What changed |
|---|---|
| `src/application.js` | `POST /api/content`, `.../revise`, `.../reject`, `.../review`, `.../approve` now call `insertContent`/`getContent`/`writeContent` instead of mutating `state.content`. `/api/content/dashboard` passes `session.tenantId` into `buildContentWorkspace`. `/api/state` (a general introspection endpoint several tests and the UI rely on) now merges live `listContent(store.db, session?.tenantId)` into its response instead of the permanently-frozen legacy array. |
| `src/content-ops.js` | `buildContentWorkspace` reads `listContent(store.db, tenantId)` instead of `state.content`; the five pure `compute*` helpers were unchanged (they already took a content array as a parameter). |
| `src/runtime/tools.js` | `create_content` tool calls `insertContent`; `meta_publish`/`x_publish`/`linkedin_publish` look up the item via `getContentOrNull(db, contentId, ctx.tenantId)` instead of `state.content.find`; `finalizePublishResult`'s `PUBLISHED` branch calls `getContent`/`writeContent`. |
| `src/planning.js` | `scheduleContent`, `prepareDue`, `buildBrief` all read content via `getContentOrNull`/`listContent` with a `tenantId` parameter (optional trailing, defaults to the active tenant — same pattern as every other Phase 1/2 migration). |
| `src/compliance.js` | `createComplianceChecker`'s returned `check(contentId,input,user,tenantId=null)` function reads the item via `getContentOrNull` twice (before and after the provider call, to detect a mid-check edit) instead of `store.read().content.find`. |
| `src/generation.js` | `createGenerator`'s returned `generate(input,user,tenantId=null)` calls `insertContent(db,content,tenantId)` instead of `state.content.unshift`. |
| `src/integration-ops.js` | `xActivity`/`linkedinActivity` take a `content` array parameter (from `listContent(store.db,tenantId)`) instead of reading `state.content` themselves; `buildIntegrationsDashboard` gained a `tenantId` option. |
| `src/reporting.js` | `buildWeeklyReport`/`buildExecutiveReport` gained a `tenantId` parameter and read content via `listContent` instead of `state.content`. |

## What this does NOT cover (see the Phase 3 final report for the full list)

- `state.audit` (the Operations Log) is a separate, still-global JSON array — a similarly
  shaped but separately scoped problem, not touched by this migration.
- `ai_runs` and `compliance_runs` are not yet tenant-scoped. They were blocked on this
  migration before (their content-hash comparisons needed a real per-tenant content lookup);
  that blocker is gone, but the tables themselves have not been migrated yet.
- Fail-closed conversion: `getContentOrNull`/`getContent`/`listContent`/`insertContent`'s
  `tenantId=null` default still resolves to "the one active tenant" (fail-*open*), consistent
  with every other Phase 1/2 table. Converting this to a hard `TENANT_CONTEXT_REQUIRED` is a
  separate, not-yet-done piece of Phase 3.

## Verification performed

- Full test suite (281/281) green after every file's fix, run file-by-file rather than
  batched.
- New/updated test fixtures across `tests/planning.test.js`, `tests/compliance.test.js`,
  `tests/content-ops.test.js`, `tests/feature-flags.test.js`, `tests/scheduler.test.js`,
  `tests/x-linkedin.test.js`, `tests/integration-ops.test.js`, `tests/reporting.test.js`,
  `tests/executive-report.test.js`, `tests/ai.test.js`, `tests/integration.test.js` — every
  fixture that built its own in-memory DB now calls `installContent(db)`, and every place a
  test seeded content directly into `state.content` now uses `insertContent`/`writeContent`.
- Migration verified against a real copy of the production database (`data/hypercool.sqlite`)
  in an isolated scratchpad directory before ever touching the real file: confirmed
  `PRAGMA integrity_check` = `ok`, the owner account and user count unchanged, and (in this
  deployment's case) zero legacy content rows to migrate — the production `state.content`
  array was already empty, so `content_items` started empty too, correctly.
- Applied to the real `data/hypercool.sqlite`: the running server process was stopped,
  restarted (which runs `installContent` on boot), and re-verified — `integrity_check: ok`,
  owner account intact, `content_items` table present.
