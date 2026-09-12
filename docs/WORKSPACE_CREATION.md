# New Company / Workspace Creation (Multi-Tenant Phase 4C-6)

`POST /api/workspaces` — the one real, atomic entry point for a verified user to create their
own workspace. Built entirely on the existing, already-tested `createTenant()` +
`seedTenantAgentConfigs()` (Part 1/76: extended, never duplicated) — see
`src/workspace-provisioning.js`.

## Authorization (Part 11/56)

- Must be authenticated (a real session).
- Must have a **verified** email (`session.user.emailVerifiedAt`) — otherwise 403
  `EMAIL_VERIFICATION_REQUIRED`. A suspended platform account can never reach this at all: its
  session lookup already fails structurally (`auth.current`'s query requires
  `users.status='active'`), so no separate suspension check was needed here.
- Deliberately **tenant-independent** — placed in `application.js` alongside the Phase 4C-1
  workspace-selection routes and the Phase 4C-5 account routes, using only `session.user.id`,
  since creating someone's FIRST tenant obviously cannot require one to already be resolved.

## Platform policy (Part 12-14)

Two env-configured, deployment-wide settings — never a per-tenant flag, since neither can
exist before the very tenant they'd gate has been created:

- `ALLOW_SELF_SERVICE_WORKSPACE_CREATION` (default `true`) — a hard platform-wide switch,
  independent of email verification (`selfServicePolicy()`, `workspace-provisioning.js`).
- `SELF_SERVICE_MAX_OWNED_WORKSPACES` (default `1`) — how many workspaces one user can create
  for **themselves**. Counted via a new `tenants.created_by_user_id` column (Part 13) — an
  owner-role membership gained through **accepting someone else's invitation** never touches
  this column and therefore never counts against the cap (verified by test).

`GET /api/workspaces/eligibility` — a cheap, read-only check the frontend uses to decide what
to show (and why not) before ever rendering the creation form; never the real authority itself
(`assertCanSelfCreateWorkspace` is re-checked inside the `POST` regardless).

## Request body — never a client-trusted identity (Part 10/69/70)

Accepts exactly `{companyName, slug?, defaultLocale?, timezone?}`. `ownerUserId`, `tenantId`,
`status`, `plan`, and `role` are never read from the body at all — the creator is always
`session.user.id`, and the tenant always starts `TRIAL` regardless of anything the client sends
(verified directly by test: a request that supplies all five of those fields still produces a
tenant owned by the real session user, status `TRIAL`).

## Atomicity (Part 2/26/35/82)

One real SQL transaction (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`) wraps: tenant + owner
membership (`createTenant`, already atomic with each other) → trial timestamps → the real 12
`TenantAgentConfig` rows (`seedTenantAgentConfigs`). A failure anywhere inside — verified by
test with a genuine forced failure (dropping the agent-configs table mid-flow) — leaves **no**
orphan tenant and **no** orphan membership; `ROLLBACK` undoes everything cleanly.

## Idempotency / double-submit (Part 34/72)

A simple in-process `Set` of user ids currently mid-creation (`workspaceCreationInFlight`,
scoped per `createApp()` instance) rejects a concurrent second request from the same user with
409 while the first is still running. The real invariant that matters — verified by test — is
"never two tenants from one double-click," not the exact rejection reason: if the second
request instead lands just after the first has already committed, it correctly gets 403
`WORKSPACE_LIMIT_REACHED` instead, which is equally correct (the user is now genuinely at
their limit).

## Slug (Part 27-30)

`resolveSlug()` in `workspace-provisioning.js`:
- **Explicit** slug: normalized (lowercase, `[a-z0-9-]`), must be free — a conflict returns
  409 `WORKSPACE_SLUG_TAKEN` with a real, currently-free `suggestion` (never silently
  substituted). A reserved word (`admin`, `api`, `settings`, `control-center`, every real
  hash-route name this app actually has, …) is rejected the same way, 409
  `WORKSPACE_SLUG_RESERVED`.
- **Auto-generated** (no slug given): derived from the company name, a numeric suffix appended
  only if needed for uniqueness. **Arabic is this product's own default locale** — a company
  named entirely in Arabic (or any non-ASCII script) strips to an empty string after
  `[a-z0-9-]` normalization; this is expected, not an error, and falls back to a short random
  identifier (`company-<hex>`) rather than failing the whole signup over an Arabic company
  name. This exact case was a real bug caught by this phase's own tests before it ever reached
  a browser (every Arabic-named test workspace failed to create until this fallback was added).
- `tenants.slug` already had a real `UNIQUE` constraint at the DB level (Part 73) — nothing new
  needed there.

## Trial (Part 15-19)

See `docs/TRIAL_WORKSPACES.md`.

## Seeding (Part 36-41)

- **Tenant defaults**: `default_locale`, `timezone` from the request (validated/defaulted);
  `status='TRIAL'`. No secrets, no integrations, no customer data.
- **12 real `TenantAgentConfig` rows** (`seedTenantAgentConfigs`, pre-existing, reused as-is):
  no AI connection assigned, no external tool enabled.
- **Autonomy**: every agent starts at `L0` simply because no `agent_autonomy` row exists yet —
  `currentAutonomy()` already defaults missing agents to `L0` (pre-existing behavior); nothing
  new to insert.
- **No per-tenant feature-flag table was built.** `runtime/feature-flags.js`'s
  `ENABLE_EXTERNAL_MESSAGING`/`ENABLE_L2_AUTONOMY`/etc. are genuinely deployment-wide env
  settings, not per-tenant rows — there is nothing to "seed safely" per new tenant, since every
  tenant in one deployment already shares the exact same flags. A brand-new workspace's real
  safety comes from the two mechanisms that ARE per-tenant: `L0` autonomy (above) and no AI
  connection assigned (readiness stays `BLOCKED` until an owner explicitly configures one).
- Verified empty by test: zero connections, zero CRM/content/memory rows in a freshly created
  workspace.

## Guided Onboarding handoff (Part 23/24/51/52)

No second onboarding was built. The frontend (`public/pages/new-workspace.js`) navigates
straight to `#onboarding` (`history.replaceState` + reload) on success — the exact same wizard
`docs/WORKSPACE_ONBOARDING.md` already built for an existing workspace. The new tenant's
onboarding state starts `NOT_STARTED` like any other (lazily created on first real interaction,
unchanged) — tenant creation itself never marks onboarding complete.

## Frontend

`#new-workspace` (`public/pages/new-workspace.js`) — reachable in two situations: a verified
user with zero workspaces (routed here instead of the old dead end, see
`docs/PLATFORM_IDENTITY.md`'s workspace-gate update) and an existing user wanting a second
workspace via the switcher. Fields: company name, optional slug, default language, timezone
(defaults to the browser's own `Intl` timezone, never hardcoded to Riyadh for every signup —
Part 31). Never asks for a tenant id, plan, owner id, or agent details (Part 26).
