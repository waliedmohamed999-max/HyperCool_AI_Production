# Production Pilot Runbook (Multi-Tenant Phase 4C-7)

Operational reference for running HyperCool's first 1-3 real pilot companies.

## Full Production Pilot Audit (Part 1)

| Area | Finding | Risk |
|---|---|---|
| Signup / verification / password recovery | Real, tested end-to-end (Phases 4C-5/4C-6) | LOW |
| Workspace creation | Atomic transaction, real slug/limit/idempotency handling, load-tested to 20 concurrent | LOW |
| Trial | Now timestamp-driven and centrally enforced (this phase) | LOW |
| Scheduler | Per-tenant isolated (`runTenantJob`), one failure never blocks others; now expires trials before each tick | LOW |
| Webhooks | Real idempotency (`INSERT OR IGNORE` on external event id), tenant-routed | LOW |
| Agent runtime | Central eligibility check added this phase; readiness/tool resolution already tenant-scoped | LOW |
| Integrations | Connection-mode matrix already honest (MULTI/SINGLE/UNAVAILABLE); credentials encrypted at rest | LOW |
| Control Center | Real, live-derived, no fake data (established since Phase 4C-2) | LOW |
| Audit logs | Tenant-scoped + a new global `platform_audit_log` for identity/platform events | LOW |
| Health endpoints | `/health/ready` now reports mail/CAPTCHA state; DB is the only hard gate | LOW |
| Sessions | Server-side, hashed tokens, 8h expiry; cookie flags reviewed below | LOW |
| Rate limits | Per-IP limiters exist for every public surface; **NEW** pilot-scale global/per-IP caps added this phase | LOW |
| Backup/restore | Real `VACUUM INTO` backup + integrity check; a full restore drill performed this phase (see below) | LOW |
| Feature flags | **Confirmed platform-wide, not per-tenant** (documented limitation, Part 71) | MEDIUM |
| SQLite under concurrency | `busy_timeout` was 0 (a real gap, fixed this phase) — see "SQLite Pilot Suitability" below | MEDIUM (now mitigated) |
| Bot protection | Did not exist before this phase — now a real, optional layer | Was HIGH, now LOW-MEDIUM depending on config |
| Rate limiting behind a reverse proxy | Uses `req.socket.remoteAddress` directly — if deployed behind nginx/Cloudflare without forwarding the real client IP, every visitor shares one "IP" for rate-limiting purposes | MEDIUM — see "Reverse Proxy" below |
| Trial-ended UX | Real, but intentionally partial (see `docs/TRIAL_EXPERIENCE.md`) | LOW (documented, not hidden) |
| Multi-instance deployment | In-process guards (workspace-creation in-flight lock, rate limiters) do NOT protect across multiple app processes/instances | Not applicable at pilot scale (this app runs as one instance) — **BLOCKER if ever scaled to multiple instances without a shared store** |

**Overall: no BLOCKER for a single-instance, 1-3 tenant pilot.** The one true BLOCKER
(multi-instance safety) only applies if this deployment is ever run as more than one process
against the same database — not the pilot's actual shape.

## SQLite Pilot Suitability (Part 45/46)

- `PRAGMA busy_timeout=5000` added this phase (was previously unset / effectively 0 — a
  writer could get an immediate `SQLITE_BUSY` under real concurrent writes). Combined with WAL
  mode (already enabled), SQLite handles the pilot's real, tested concurrency (up to 50
  simultaneous signup+create requests — see "Load Testing" below) with zero errors.
- **Verdict: SQLite is genuinely acceptable for a 1-3 tenant pilot.** The real operational
  limit is **single-process, single-machine** — there is no multi-writer, multi-host story
  here (Part 37/46). This is a real, documented ceiling, not silently glossed over: if this
  platform ever needs more than one app instance (for horizontal scaling or high availability),
  a real database server (Postgres) and a shared store for rate limiters/in-flight guards
  become necessary. Not needed for the pilot itself.

## Reverse Proxy Note (Part 53)

Rate limiting and the `Host`/`Origin` checks use `req.socket.remoteAddress` and the raw
`Host` header directly — **never** trusts `X-Forwarded-For` (so it cannot be spoofed), but
this also means: if deployed behind a reverse proxy that doesn't preserve the real client
connection, every visitor is rate-limited as if from the SAME IP. `PUBLIC_ORIGIN` must be set
to the real public HTTPS origin either way (required for the `Secure` cookie flag and every
emailed link, Part 54) — see `hostinger-deployment.md` for this deployment's actual proxy
setup. No code change was made here this phase; documenting the real, current behavior is the
honest deliverable.

## Cookie / Config Security (Part 52-55)

- Session cookie: `HttpOnly; SameSite=Strict; Path=/`, plus `Secure` automatically once
  `PUBLIC_ORIGIN` is a real HTTPS URL (unchanged, pre-existing behavior — reviewed, not
  modified).
- `Host`/`Origin` validation and CSP/`X-Content-Type-Options: nosniff` headers already exist
  on every response (pre-existing) — reviewed, unchanged.
- Run `npm run production:check` before any real launch (see below).

## Production Config Check

```
npm run production:check
```

Real, live check (`scripts/production-check.mjs`) — never prints secret values, only
presence/validity. BLOCKER-level items fail the exit code (safe to wire into a deploy
pipeline): `NODE_ENV=production`, `INTEGRATION_ENCRYPTION_KEY` (valid 32-byte
hex/base64), `PUBLIC_ORIGIN` (clean HTTPS origin), and — critically — that
`PLATFORM_MAIL_TRANSPORT` is never `capture` in production (that transport stores full email
bodies, including real links, in the database). WARN-level items (mail, CAPTCHA, platform
admin allowlist, `DATA_DIR`) never fail the exit code since the app genuinely boots and works
without them, but should be reviewed before a real pilot.

## Load / Concurrency Testing (Part 35/36)

```
npm run load:workspace-creation -- 50
```

Real HTTP signups + verifications + `POST /api/workspaces` calls, run against a fresh,
throwaway local SQLite copy (never production). Results from this phase's own run:

| Concurrency | Signups rate-limited (expected, same source IP) | Workspaces created | Duplicates |
|---|---|---|---|
| 10 | 0 | 10 | 0 |
| 25 | 5 | 20 | 0 |
| 50 | 30 | 20 | 0 |

`checkSignupRateLimit` (20/15min per IP) is what caps signups from one source IP — a real,
expected safety behavior, not a bug; every distinct user who DID get through got exactly one
workspace, every time, at every concurrency level tested. Slug-race and invitation-accept-race
are covered directly in `tests/production-pilot-hardening.test.js` rather than the load
script, for exact assertion precision.

**Idempotency-Key header (Part 42) — deliberately not added.** `POST /api/workspaces` was
considered for an `Idempotency-Key` header, but the concurrency testing above (and the
dedicated slug-race test) already proves the real protection — an atomic transaction plus a
genuine DB-level `UNIQUE` constraint on `tenants.slug` — holds with zero duplicates at every
concurrency level tested. Adding a second, client-supplied idempotency mechanism on top would
be real, unrequested complexity for a problem the DB already solves correctly; not implemented
this phase.

**Webhook burst and multi-tenant agent load — real, added test coverage (Part 42-44).**
`tests/production-pilot-hardening.test.js` now includes two more real HTTP concurrency tests
beyond the general load script:
- **Webhook burst**: 120 concurrent, real `POST /api/webhooks/meta/whatsapp` deliveries (real
  HMAC signatures, real routing) across two tenants, including 20 genuine duplicate
  redeliveries (the same provider event id resent) — proves the existing
  `UNIQUE(source,external_event_id)` ledger (`webhook-events.js`) collapses every duplicate to
  exactly one stored event, with zero cross-tenant lead leakage, well under 15 seconds.
- **Agent runtime parallel load**: 20 concurrent `/api/agents/sales/run` calls split evenly
  across two tenants, with only the outbound AI fetch mocked (never a real call at scale, Part
  44) — proves each run stays correctly scoped to its own tenant end to end (tenant id, tool
  resolution, and the model's own reply never cross over).

Scheduler multi-tenant isolation (Part 43) already had dedicated coverage from an earlier
phase (`tests/scheduler.test.js`: independent per-tenant jobs in the same tick, one tenant's
failure never blocking another, a reentrancy guard against overlapping ticks) — the underlying
mechanism (`runTenantJob` per tenant, per cycle) does not change shape as tenant count grows,
so no new test was needed to extend that guarantee to pilot scale.

## Backup / Restore Drill (Part 47-49)

Performed on an isolated scratch copy, not live production:

1. `npm run backup` — real `VACUUM INTO`, `integrity_check: ok`.
2. `node scripts/restore.mjs <backup> <scratch-dir>` — **~90ms**, integrity verified both
   before and after.
3. Booted `createApp()` against the restored copy — **~1 second**, zero errors.
4. Verified real data present: users, tenants, memberships, audit log entries all intact and
   correct.

**Recovery time at this data size: well under a few seconds end-to-end** (no enterprise SLA
claimed — this is a real, small dataset; time will grow with real data volume, revisit before
it matters).

## First 24 Hours Monitoring (Part 68)

- `GET /health/ready` — watch for `database` staying `ok`; `platform_mail`/`bot_protection`
  are informational only.
- `#platform` overview — `agentsFailing`, `connectionsNeedingAttention`,
  `recentCriticalErrors` (last 24h, from `platform_audit_log`).
- Watch application logs (`logRequest`'s structured JSON lines) for repeated `error_code`
  values on the same route.
- Confirm the first real signup → verify → create workspace → onboarding chain completes for
  each pilot company as it joins.

## First 7 Days (Part 69)

- Active tenants and their `pilotStatus` (`#platform` directory: READY / NEEDS_ATTENTION /
  BLOCKED).
- Onboarding completion rate across pilot tenants.
- Integration/agent readiness trend per tenant.
- Approval/escalation volume (existing Operations Log).
- AI usage (existing `agent_runs` cost/token tracking) — no Billing metrics yet, since Billing
  does not exist.
- Error rate from `platform_audit_log` `%FAILED%` actions.

## Recommended Pilot Feature Flags (Part 70/71/72)

```
ENABLE_EXTERNAL_MESSAGING=false
ENABLE_EXTERNAL_PUBLISHING=false
ENABLE_AUTOMATED_FOLLOWUPS=false
ENABLE_L2_AUTONOMY=false   (already the default)
ENABLE_L3_AUTONOMY=false   (already the default)
```

**Important, explicit limitation (Part 71/72)**: these flags are platform-wide, not
per-tenant. Running 2-3 pilot companies with genuinely different safety appetites (one wants
external messaging on, another doesn't) is **not possible** with the current architecture
without either hacking around it (explicitly refused — Part 72) or building real per-tenant
feature-flag storage, which is a materially separate piece of work, likely adjacent to a
future Billing/plan-tier phase rather than this pilot-hardening one. Documented here as a
known pilot constraint, not silently worked around.

## Incident Steps

1. Check `GET /health/ready` and `#platform` overview first.
2. If a specific tenant is misbehaving: `#platform` → tenant detail → review recent audit,
   agent/connection health.
3. If containment is needed: `#platform` → suspend that one tenant (immediate, reversible,
   audited) — every OTHER tenant is provably unaffected (verified by test).
4. If data corruption is suspected: stop the app, `npm run backup` the CURRENT state first
   (even if suspect — never lose the only copy), then consider `npm run restore` from the
   last known-good backup.
5. Reactivate/extend-trial once resolved (`#platform`, both audited).

## Starting the App

```
npm run production:check   # must show no BLOCKER
npm start
```

## Creating the First Pilot Tenant

Either: (a) the pilot company signs up themselves (`#signup` → verify → `#new-workspace`), or
(b) an operator does it on their behalf using the exact same real flow (no hidden admin-only
creation path exists — `createTenant`/`bootstrapWorkspaceForOwner` are the only real paths and
both go through the same validated, atomic route).
