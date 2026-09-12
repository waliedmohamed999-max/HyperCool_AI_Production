# Platform Identity + Verified Email Foundation (Multi-Tenant Phase 4C-5)

A real, global User identity layer for HyperCool, built as a foundation for future
self-service signup, new-company creation, verified invitations, password reset, security
notifications, ownership recovery, and billing identity — **none of which this phase itself
builds**. This phase only adds the identity primitives those features will need.

## Primary principle: User Identity vs TenantMembership

This codebase already had this split structurally (`users` vs `tenant_memberships`); this
phase makes the DISTINCTION explicit and adds the missing piece:

- **User** — the person's identity on the platform. `username` (unchanged), and now `email` /
  `email_verified_at` / `pending_email`. **Global** — never tenant-scoped.
- **TenantMembership** — that person's `role` inside one specific workspace. Unchanged by this
  phase. A single verified User identity can hold different roles across multiple workspaces
  (Part 57/58/59) — this phase makes that scale correctly instead of requiring a
  duplicate account per workspace.

## What this phase deliberately does NOT build

Per the explicit instruction this phase started from:

- **No New Company / New Tenant creation.** `createTenant()` (Phase 3.5) is untouched and
  still not exposed by any route.
- **No Customer Self-Service Signup.** There is still no public "create an account and a
  workspace" flow.
- **No public, unrestricted registration.** The only ways an account is created remain: the
  one-time `/api/setup` (first owner), an owner creating a team member, and invitation
  acceptance/registration (Phase 4C-3).
- **No marketing email system**, no distributed mail queue, no Redis.

## `username` is kept — email is additive

`username` is completely unchanged: same column, same validation, same login path. `email` /
`email_verified_at` / `pending_email` are new, **nullable** columns added to the existing
`users` table (`src/store.js`, guarded `ALTER TABLE ADD COLUMN`, additive-only — see
`docs/MULTI_TENANT_ARCHITECTURE.md`'s migration conventions).

**Schema decision**: a single `email` column stores the address already normalized (trimmed +
lowercased) rather than a separate `email`/`email_normalized` pair — matching `username`'s own
existing precedent (stored lowercase-only, no separate "as-typed" column). `email` holds the
**current verified** address only; `pending_email` holds a not-yet-verified candidate while a
change is in flight (Part 9/10) and is cleared once it is either promoted to `email` or
superseded by a newer request.

```sql
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN pending_email TEXT;
CREATE UNIQUE INDEX idx_users_email ON users(email);
```

SQLite's `UNIQUE` index treats every `NULL` as distinct from every other `NULL` (standard SQL
semantics), so this enforces "no two accounts share the same verified email" without a partial
index — any number of "no email yet" rows coexist freely.

## Existing users are never given a fake email

No existing HyperCool user was backfilled with an invented address (never
`username@example.com` or similar). Every pre-existing row simply has `email = NULL`,
`email_verified_at = NULL` after this migration — verified by the dry-run against a real copy
of the production database (see this phase's Final Report). A real flow exists for a legacy
user to add one whenever they choose — see `docs/EMAIL_VERIFICATION.md`.

## Normalization

One canonical normalizer, `normalizeEmail()` in `src/platform-identity.js`: trim + lowercase
the entire address. No fuzzy matching (no plus-addressing collapsing, no dot-folding) — those
are policy decisions this phase deliberately does not make. `src/invitations.js` imports and
reuses this exact function so "what counts as the same email" never drifts between the two
modules.

## Login accepts username OR verified email

`auth.js`'s `login()` now checks whether the identity field looks like an email (contains `@`
— a real `username` can never contain one, since `createUser`'s own pattern forbids it, so this
is unambiguous) and looks up by `email` (only where `email_verified_at IS NOT NULL` — Part 22:
an unverified `pending_email` is never a login identity) instead of `username` in that case.
The exact same HTML form field is reused for both (the login `<input name="username">`'s
`pattern` attribute in `public/index.html` was relaxed to accept either shape — a real bug this
phase's own Playwright testing caught: the original username-only `pattern` silently blocked
the browser from even submitting an email address, native HTML5 constraint validation stopping
the request before any JS ran).

## Account-level API

- `GET /api/account` — any authenticated role. `{id, username, name, role, email,
  emailVerifiedAt, pendingEmail, platformMail}`.
- `POST /api/account/email` — add or change email. Body `{email}`.
- `POST /api/account/email/resend-verification` — rotates the token, resends.
- `POST /api/account/email/verify` — **public** (no session required — a visitor may click the
  link from a different browser/device). Body `{token}`.

All three are reachable even for a multi-membership user with **no active workspace
selection** — Account Settings is a USER concern, not scoped to any one workspace (placed in
`application.js` alongside the Phase 4C-1 workspace-selection routes, using only
`session.user.id`, never `session.tenantId`).

See `docs/EMAIL_VERIFICATION.md` for the verification token lifecycle, `docs/PASSWORD_RECOVERY.md`
for forgot/reset password, and `docs/PLATFORM_EMAIL.md` for how the actual email gets sent.

## Auditing: a new, genuinely global log

`recordAudit()` (existing, `audit.js`) requires a tenant context — it throws
`TENANT_CONTEXT_REQUIRED` when more than one tenant exists and no tenant id is given. Several
of this phase's events (`USER_EMAIL_VERIFIED`, `PASSWORD_RESET_REQUESTED`, ...) fire from
routes with **no** tenant context at all (a public password-reset link). Forcing them through
`recordAudit()` would either crash in any real multi-tenant deployment or misfile a global
identity change under whichever workspace the session happens to be in right now. This phase
adds a small, separate, non-tenant-scoped `platform_audit_log` table
(`recordPlatformAudit()` in `src/platform-identity.js`) for exactly these events — never logs a
raw token.

## Frontend

- `#account` — Account Settings (`public/pages/account.js`), visible to every authenticated
  role. Shows username, email status (none/pending/verified), add/change email, resend.
- `#verify-email/<token>`, `#forgot-password`, `#reset-password/<token>` —
  `public/pages/recovery.js`, outside the normal auth-gated flow (same pattern as
  `pages/invite.js`), since a visitor may have no session, an expired one, or be on a different
  device.
- A dismissible, non-blocking banner (`#email-banner`) prompts a legacy account with **no**
  email at all yet to add one — never shown once an email exists (verified or pending), and
  dismissal is per-browser-tab only (`sessionStorage`), not persisted server-side.

## Real bugs this phase's own testing found and fixed

1. **`invitations.js`'s `createInvitation` INSERT dropped a bound parameter** while adding the
   new `invitation_mode` column (a literal `'EMAIL_BOUND'` was spliced into the placeholder
   list without shifting the `.run()` argument list to match) — silently misassigned
   `invited_by_user_id`'s value into the `status` column, which happened to still pass SQLite's
   positional binding but violate the `NOT NULL`/`CHECK` constraints, breaking **every**
   invitation creation. Caught immediately by the full regression suite (13 of 20 invitation
   tests failed with `NOT NULL constraint failed: workspace_invitations.updated_at`) before any
   UI testing even began.
2. **The login `<input>`'s `pattern` attribute blocked entering an email address** — Part 20's
   backend capability ("login accepts username or verified email") existed and passed every
   backend test, but the real browser silently refused to submit the form at all when an email
   was typed, because native HTML5 constraint validation rejected it before the `submit` event
   ever reached JavaScript. Invisible to backend HTTP tests (which bypass the DOM entirely);
   found only by a real-browser Playwright journey that actually typed an email into that exact
   field and clicked the real button. Fixed by relaxing the pattern to accept either shape.
3. **Initial `EMAIL_BOUND` design blocked ordinary existing-user invitation acceptance.** The
   first implementation required an accepting existing user to already have a matching verified
   email, which — since virtually no HyperCool user has verified an email yet on day one of
   this phase — would have made every "Existing-user acceptance" scenario fail, including
   pre-existing regression tests. Revised to only reject a **provable mismatch** (a different
   verified email already on file), never merely "no verified email yet" — consistent with
   Part 47/48's explicit transition rule that legacy users must keep working. See
   `docs/WORKSPACE_INVITATIONS.md`'s Phase 4C-5 update.

## Phase 4C-6 update: this identity foundation is now actually used for self-service signup

`docs/SELF_SERVICE_SIGNUP.md` and `docs/WORKSPACE_CREATION.md` build directly on everything
above: `POST /api/signup` reuses `requestEmailChange` verbatim, and `POST /api/workspaces`
gates on `session.user.emailVerifiedAt` exactly as documented here. One addition:
`resolveTenantForUser` (`tenancy.js`) now also checks a new `users.self_registered` flag before
running its legacy zero-membership auto-attach — see `docs/SELF_SERVICE_SIGNUP.md`'s "a
critical, pre-existing interaction this phase had to fix" section for why this was a real
security gap, not a cosmetic addition.
