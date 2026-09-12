# Platform Operations (Multi-Tenant Phase 4C-7)

A minimal Platform Admin foundation for running a small production pilot — explicitly **not**
a Super Admin SaaS product (Part 19). Everything here reuses real, already-tested data sources
(`buildControlCenterSummary`, `getOnboardingState`, `listActiveMembers`, `listAuditLog`) —
never a second, parallel computation that could drift from what a tenant's own Control Center
already shows.

## Authorization: `PLATFORM_ADMIN_USERNAMES`

Deliberately **not** "a tenant owner is automatically a platform admin" (Part 20) — a
workspace owner has authority over their own company only. A minimal, explicit,
comma-separated allowlist of real usernames in one env var
(`src/platform-admin.js`'s `isPlatformAdmin`) — no new role, no new table. This is a real,
reviewable trade-off for a small pilot's tiny admin population, not a hidden shortcut: anyone
not on this list gets a real 403 from every `/api/platform/*` route, verified directly by test
(including a normal tenant owner — owning a company grants zero platform authority).

## Routes

All tenant-independent (usable by an admin who is not even a member of the tenant in
question), all gated by `requirePlatformAdmin`:

- `GET /api/platform/overview` — real counts: tenants by status, expired trials, total/verified
  users, connections needing attention, blocked agents, recent critical errors (from
  `platform_audit_log`, last 24h). Cheap at pilot scale (iterates the real, tiny tenant list
  once) — documented here as something to revisit before this platform ever has dozens of
  tenants.
- `GET /api/platform/tenants` — the directory: name, status, real trial state, owner, real
  onboarding status, real agent/connection health, and a derived `pilotStatus`
  (`READY`/`NEEDS_ATTENTION`/`BLOCKED`) — never a stored flag.
- `GET /api/platform/tenants/:id` — read-only detail: members, integrations, agents,
  onboarding, last 20 audit entries. Never a secret/credential/vault payload (verified by
  test — reuses the same Control Center summary that already guarantees this).
- `POST /api/platform/tenants/:id/suspend` — immediate (Part 24/26): the existing
  tenant-membership resolution already excludes any non-ACTIVE/TRIAL tenant entirely, so every
  member loses access on their very next request, with zero new invalidation code.
- `POST /api/platform/tenants/:id/reactivate` — restores `ACTIVE` (Part 27 — never silently
  back to `TRIAL` with an already-past expiry, which the real, timestamp-based eligibility
  check would just re-block on the very next request).
- `POST /api/platform/tenants/:id/extend-trial` — body `{days}`; extends from
  `max(now, current expiry)` and always restores `status='TRIAL'` (Part 25/61).

No delete action exists anywhere (Part 24).

## Auditing

Every platform action is recorded in `platform_audit_log` (the same non-tenant-scoped table
Phase 4C-5 built for identity events) — `PLATFORM_TENANT_SUSPENDED`,
`PLATFORM_TENANT_REACTIVATED`, `TRIAL_EXTENDED` — reused rather than duplicated (Part 28).

## Frontend

`#platform` (`public/pages/platform.js`) — visible in the nav only when `GET /api/auth`'s
`isPlatformAdmin` field is true; a direct navigation by anyone else shows a clear "platform
admin only" message rather than a blank page, and every underlying route is independently
gated server-side regardless of what the frontend shows (Part 58).
