# Trial Workspaces (Multi-Tenant Phase 4C-6)

No billing engine. Every helper here is a real, read-derived function over
`tenants.status`/`trial_expires_at` — never a separate "subscription" concept.

## Schema (additive, nullable — Part 16/74/75)

```sql
ALTER TABLE tenants ADD COLUMN trial_started_at TEXT;
ALTER TABLE tenants ADD COLUMN trial_expires_at TEXT;
```

`NULL` for every tenant that predates this phase (the real HyperCool tenant included — never
retroactively converted into a trial, verified by migration dry-run against a real production
copy) and for any tenant created any way other than the self-service flow.

## Length (Part 16)

`TRIAL_DAYS` env var, default `14`. Set once, at creation time
(`bootstrapWorkspaceForOwner`) — `trial_expires_at = trial_started_at + TRIAL_DAYS days`.

## Expiry behavior (Part 17/18) — reuses the existing `SUSPENDED` status, on purpose

SQLite cannot widen a `CHECK` constraint via a simple `ALTER TABLE` (Part 17's own warning) —
adding a distinct `TRIAL_EXPIRED` value would mean rebuilding the `tenants` table, well outside
what should stay a lightweight, additive migration. Reusing the existing `SUSPENDED` status is
the one option that satisfies "no data touched, no new column widening" — `trial_expires_at`
staying non-null on the now-`SUSPENDED` row is what still distinguishes "trial ran out" from an
owner being suspended for any other reason, for any future audit/UI that needs to tell the two
apart.

This is a real, honest trade-off, not a hidden gap: an expired-trial owner currently sees the
**exact same** access-denial behavior as any other suspended tenant (login still works —
their account isn't banned — but that specific workspace becomes unreachable,
`tenant_memberships`/`tenants` join already excludes `SUSPENDED` tenants entirely, Phase
1/3/4C-3 behavior, unchanged). A dedicated "your trial ended, here's how to reach us" screen for
an otherwise-inaccessible tenant was deferred — building it correctly would require loosening
that existing, deliberate exclusion query, a materially bigger change than this phase's scope.
Nothing is deleted either way (Part 17).

## Never a separate scheduler (Part 19)

`expireTrials(db)` (`tenancy.js`) runs at the START of the existing tenant-aware scheduler's
own `tick()` (`runtime/scheduler.js`), before `listTenants()` reads the eligible set for that
same tick — so an overdue trial stops receiving even one more daily brief / follow-up sweep /
scheduled publish from the very moment it's flipped, not one tick late. A
`WORKSPACE_TRIAL_EXPIRED` audit event is recorded for each tenant it expires.

## Read-only helpers (`tenancy.js`)

- `isTrialActive(tenant)` — `true` only while `status==='TRIAL'` and (no expiry set, or expiry
  still in the future).
- `getTrialDaysRemaining(tenant)` — whole days remaining, `null` outside an active trial.

## UI (Part 60)

Control Center's summary (`GET /api/control-center/summary`) now includes a real `workspace.trial`
object (`{active, daysRemaining, expiresAt}`, or `null` for a non-trial tenant) — no fake
"Upgrade" checkout button anywhere (Part 61/103/104); the eventual destination for that action
doesn't exist yet, so none is offered.

## What this phase explicitly does not build (Part 61-63)

No payment processor, no subscription object, no checkout, no card input, no invoices, no VAT,
no coupons, no paid-plan enforcement engine, and no Super Admin panel. `tenants.plan` (an
existing, already-nullable column) is left exactly as it was — available for a future billing
phase to populate, not given any enforcement logic here.
