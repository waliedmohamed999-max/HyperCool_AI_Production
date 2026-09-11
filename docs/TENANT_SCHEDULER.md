# Tenant-Aware Scheduler (Multi-Tenant Phase 3.5, Part A)

This document records exactly how `src/runtime/scheduler.js`'s background job execution
model changed from "run once, implicitly for the one tenant that exists" to "run once per
eligible tenant" — and what deliberately did not change.

## Job audit — every scheduled job that actually exists in this codebase

The spec that requested this phase listed several example job names (Integration Health,
Memory Review, Market Sweep, Metrics Aggregation) that do **not exist** anywhere in this
codebase — no `setInterval`, cron, or scheduled-job registration for any of them was found
by a full-codebase search. Rather than invent jobs to match the example list, this section
documents the five real jobs `src/runtime/scheduler.js`'s `tick()` actually runs:

| Job | Frequency | Classification | Why |
|---|---|---|---|
| Daily Brief (`saveDailyBrief`) | once/day at 08:00 Riyadh | TENANT_JOB | Reads/writes `daily_briefs`, `content_items`, CRM — all tenant-owned business data. |
| Weekly Report (`saveWeeklyReport`) | once/week, Sunday | TENANT_JOB | Reads/writes `weekly_reports` and aggregates CRM/content/autonomy — tenant-owned. |
| Follow-up Sweep (`sweepFollowupGaps`) | every tick | TENANT_JOB | Reads `crm_leads`/`crm_followups`, triggers the `followup` agent — tenant-owned. |
| Scheduled Publishing (`prepareDue`) | every tick | TENANT_JOB | Reads/writes `schedule_jobs`/`content_items`, may emit `CONTENT_PUBLISH_REQUESTED` — tenant-owned. |
| Microsoft Subscription Renewal (`renewMicrosoftSubscriptionIfNeeded`) | every tick | CONNECTION_JOB | A Microsoft mail subscription belongs to one tenant's `integration_credentials` connection, not the platform — renewed once per tenant that actually has one, never assumed singular. |

No GLOBAL_JOB (a job that touches no tenant-owned data at all — e.g. platform maintenance)
exists in this codebase today. If one is added later, it should run exactly once per tick,
outside the per-tenant loop below, and never read/write anything with a `tenant_id` column.

## Architecture: before and after

**Before**: `tick()` called each TENANT_JOB function exactly once, with no explicit
`tenantId` — every one of them defaulted (via `resolveActiveTenantId`) to "the one tenant
that exists." Correct today (there is only one), but the instant a second tenant existed,
`resolveActiveTenantId` would throw `TENANT_CONTEXT_REQUIRED` on the very first call — the
entire tick would abort, and NEITHER tenant's jobs would run.

**After**: `tick()` calls `listTenants(db)` (new function, `src/tenancy.js`) to get every
`ACTIVE`/`TRIAL` tenant, then loops over them SEQUENTIALLY (not parallel — bounded,
predictable load; see "Locking" below), calling each TENANT_JOB once per tenant with an
explicit `tenantId`. The CONNECTION_JOB loops separately over whichever tenants actually
have a non-disconnected `microsoft365` connection (queried directly — never assumed to
be "the" tenant).

**Multi-Tenant Phase 4A update:** the CONNECTION_JOB's tenant enumeration was cut over from
`integration_credentials` to `integration_connections` (`WHERE integration_definition_id=
'microsoft365' AND status!='DISCONNECTED'`) — see `docs/INTEGRATION_CONNECTION_ARCHITECTURE.md`.
The actual renewal call (`renewMicrosoftSubscriptionIfNeeded`) still reads/writes the legacy
`integration_credentials` metadata unchanged; its own `updateCredentialsMetadata` call now
passes `env` so the compatibility bridge mirrors the renewed subscription's expiry back into
`integration_connections` too, keeping the two in sync without a second write path.

`tick()`'s return shape changed from a flat object (`{dailyBrief, weeklyReport, ...}`) to
`{at, tenants: {[tenantId]: {dailyBrief, weeklyReport, followupSweep, schedulePrepare}},
microsoftSubscriptionRenewal: {[tenantId]: {...}}}`. The external automation HTTP endpoints
(`POST /api/automation/daily-brief`, `POST /api/automation/prepare-due`) — which call the
exact same underlying job functions — were changed to the same per-tenant shape for
consistency, since they are the same jobs triggered a different way (an external cron
hitting the HTTP API instead of the in-process timer).

## Eligible tenants (Part A4)

`listTenants(db, {statuses=['ACTIVE','TRIAL']})` — a TRIAL tenant is actively evaluating the
product, and its automation (daily brief, follow-up sweep, scheduled publishing) is exactly
what it's here to try, so it is included by default. `SUSPENDED` and `ARCHIVED` tenants are
never eligible — no automated job may touch a suspended tenant's data while its access is
revoked, or an archived tenant's data at all.

## Tenant context threading (Part A5/A6)

Every job call is now `jobFunction(store, ..., tenantId)` — no optional/omittable tenantId
inside the per-tenant loop. `sweepFollowupGaps` gained a `tenantId` parameter it did not have
before (threaded into both its `listLeads` read and the `agentRuntime.run(...)` call it
makes, so the triggered `followup` agent run is correctly attributed). `saveDailyBrief`,
`saveWeeklyReport`, and `prepareDue` already had one from earlier Phase 3 work.

`correlationId`: each per-tenant job attempt gets a `randomUUID()` correlation id, recorded
alongside a failure (see below). It does **not** thread further into `agent_runs` or
`agent_events`, which have no such column — extending those tables was judged out of
proportion to what this phase actually needed (the `tenantId` propagation tests already
prove the chain stays attributable end-to-end without it). Revisit if a real cross-system
tracing need arises.

## Job execution record (Part A13)

There is no dedicated job-run/log table in this codebase. Rather than add one purely for
routine bookkeeping, a scheduled job's outcome is recorded to the existing `audit_logs` table
(`src/audit.js`) **only on failure** (`action: 'SCHEDULER_JOB_FAILED'`, with `itemId` = job
name, `errorCode`, `correlationId`, tenant-scoped). A successful, routine tick (nothing due,
nothing to sweep) is not itself logged — matching how every other audit entry in this
codebase represents something a human would actually want to see in the Operations Log, not
a heartbeat repeating every few minutes forever. The full per-tenant, per-job outcome is
still available in `tick()`'s own return value for any caller that wants it (tests, or a
future ops endpoint).

## Failure isolation (Part A14)

Each per-tenant job call is wrapped individually (`runTenantJob`) — a thrown error is caught,
logged (see above), and the loop continues to the next job/tenant. Proven directly in
`tests/scheduler.test.js`: a test forces Tenant A's daily brief into a pre-existing
(idempotency-replayed) state and confirms Tenant B's own daily brief still succeeds
independently in the same tick.

## Locking (Part A12)

This app is a single always-on process with one `setInterval` loop — not a horizontally
scaled cluster. A DB-based lock (a `scheduler_locks` row claimed via a conditional `UPDATE`)
would solve a problem this deployment does not have and was deliberately not built. What was
built: an in-process reentrancy guard (`tickRunning` boolean) that makes a `tick()` call
return `{skipped: 'ALREADY_RUNNING'}` if a previous tick from the SAME process is still in
flight — the actual risk today (a slow tick overlapping the next timer firing), proven in
`tests/scheduler.test.js`'s concurrent-tick test. If this process is ever run as more than
one instance, the DB-based lock described above is the natural next step.

## What this does NOT cover

- No GLOBAL_JOB exists to classify, since none exists in the codebase (see the audit table
  above) — this is a factual statement about today's code, not a gap.
- `agent_runs`/`agent_events` were not extended with a `correlation_id` column (see above).
- The external automation endpoints' response shape changed (flat → per-tenant map) — a
  breaking change to that HTTP contract, accepted because there is exactly one real
  deployment of this system today and the alternative (leaving it flat) would have meant it
  silently only ever serviced one tenant even after everything else in this phase became
  tenant-aware.

## Verification

`tests/scheduler.test.js` — 8 tests: the original 4 (daily brief timing/idempotency, weekly
report timing, pause gate, follow-up sweep) updated to the new per-tenant return shape, plus
4 new ones proving genuine two-tenant isolation, suspended/archived exclusion, failure
isolation, and the reentrancy guard. Full suite: 297/297 green.
