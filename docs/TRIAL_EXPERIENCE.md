# Trial Experience + Central Tenant Eligibility (Multi-Tenant Phase 4C-7)

Builds on `docs/TRIAL_WORKSPACES.md` (Phase 4C-6) — this phase adds the actual UX and the
central enforcement, closing the two gaps that document listed as deferred.

## `getTrialStatus(tenant)` — the one real classification (Part 11)

`tenancy.js`. Returns `{status, startedAt, expiresAt, daysRemaining}`, `status` one of:

- `NOT_TRIAL` — no trial timestamps at all (the legacy HyperCool tenant, or any non-self-service tenant).
- `ACTIVE_TRIAL` — real trial, >3 days remaining.
- `EXPIRING_SOON` — real trial, ≤3 days remaining (Part 13 — a stronger warning, never a block).
- `EXPIRED` — `trial_expires_at` has already passed, **computed from the live timestamp**, not
  from `tenants.status` having already been flipped to `SUSPENDED` by the scheduler. This is
  the deliberate fix for Part 17's own warning ("لا تعتمد فقط على scheduler changing status"):
  a trial that expired one second ago is `EXPIRED` here immediately, on the very next check,
  even before the next scheduler tick gets around to updating the row.

`isTrialActive`/`getTrialDaysRemaining` (pre-existing, Phase 4C-6) are now thin wrappers around
this one real function — no duplicated threshold logic.

## `tenantOperationalBlockReason(tenant)` — the one central eligibility gate (Part 17/18)

Returns a safe reason code (`TENANT_NOT_FOUND` / `TENANT_ARCHIVED` / `TENANT_TRIAL_EXPIRED` /
`TENANT_SUSPENDED`) or `null`. Wired into the ONE highest-leverage real chokepoint: the agent
runtime's central `run()` entry point (`runtime/runtime.js`) — every agent execution, from
every trigger (manual test, scheduler, webhook-driven, orchestrator-routed), passes through
this exact function before spending a single token. A blocked run is recorded like any other
outcome (`finishTenantNotOperational` — visible in run history, never silently swallowed),
matching the existing `finishDisabled`/`finishNotReady` pattern exactly.

Verified by test using the real, most realistic scenario: a trial expires by timestamp while
`tenants.status` still says `'TRIAL'` in the database (the scheduler hasn't run yet) — a real
`POST /api/agents/:id/run` HTTP call is still correctly refused with `TENANT_TRIAL_EXPIRED`,
proving the check is genuinely timestamp-driven, not status-driven.

The scheduler itself (`runtime/scheduler.js`) calls the companion `expireTrials(db)` at the
very start of every tick, before `listTenants()` reads the eligible set — so a newly-expired
trial is excluded from that same tick's automation, and its status catches up to `SUSPENDED`
for every other part of the system (Control Center, workspace resolution, the frontend gate)
within one tick interval.

## Trial banner (Part 12/13)

Control Center's summary (`GET /api/control-center/summary`) already carried
`workspace.trial` (Phase 4C-6). This phase adds the actual UI: a real banner
(`public/pages/control-center.js`'s `renderTrialBanner`) showing "`{days}` days left" — the
number always comes from the backend (`TRIAL_DAYS`'s real configured value flows through
`trial.daysRemaining`; nothing is hardcoded to 14 client-side). A stronger visual treatment
(not a block) kicks in once the backend itself classifies the trial as `EXPIRING_SOON`.

## Trial-ended UX: the honest, real scope of what this phase built (Part 14/15)

A member of a suspended tenant (trial-expired or otherwise) now sees a real, **named**
"Trial Ended" / "Suspended" screen — never the same opaque `NO_WORKSPACE_ACCESS` a
membership-less brand-new signup sees. A new, deliberately SEPARATE read-only query
(`tenancy.js`'s `listSuspendedWorkspacesForUser`) surfaces this without touching the existing,
security-critical `resolveTenantForUser`/`VALID_MEMBERSHIP_JOIN` gate that every other business
route in this app relies on and that Phase 4C-4's own test explicitly names as "the same
centralized tenant resolution that blocks everything else" — deliberately unchanged here.

**What this does NOT yet do** (an honest, explicit limitation, not a hidden gap): Part 15's
fuller model — a suspended tenant's member still reaching real, live Account Settings/
Workspace Settings/Member Management/Control Center-read-only/data-export views for that
specific (non-operational) tenant — is **not built in this pass**. Doing that correctly would
require loosening the core membership-resolution query that every business route depends on
for its security boundary, which is a materially bigger architectural change than this phase's
scope, and carries real regression risk against multiple existing, deliberately-designed tests
(Phase 4C-3's session-invalidation tests, Phase 4C-4's suspended-tenant-unreachable test). The
real, delivered improvement is: the member now knows **which** company ended and **why**, with
a factual assurance that data is safe and automation is stopped, and a "contact platform
administration" pointer (Part 16 — never a fake Pay-now/Upgrade button, since Billing does not
exist). Restoring live, scoped access to a non-operational tenant is deferred to a future phase
that can afford to redesign that core gate properly.

## No fake Upgrade (Part 16)

Neither the trial banner nor the Trial Ended screen offers a payment/plan-selection flow of any
kind — Billing does not exist yet, so none is faked. The only real action offered is "contact
the platform administration."
