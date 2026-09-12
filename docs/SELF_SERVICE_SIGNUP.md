# Self-Service Signup (Multi-Tenant Phase 4C-6)

Public account registration — `POST /api/signup`. Creates a USER identity only; never a
tenant, never a membership. See `docs/WORKSPACE_CREATION.md` for the separate, explicit second
step that creates a company.

## Why account creation and company creation are two separate steps

Per Part 4/7: "لا تطلب company في نفس transaction بالضرورة" / "لا تنشئ Workspace تلقائيًا من
verification endpoint نفسه." A brand-new account is not trustworthy enough to own a workspace
until its email is proven real — collapsing the two into one step would mean either creating a
workspace for an unverified identity, or blocking account creation itself on email delivery
succeeding (fragile, and a bad experience if mail delivery is briefly degraded).

## Flow

1. `POST /api/signup` — body `{name, username, email, password}`. Reuses every existing
   validation (`auth.createUser`'s username/password rules, unchanged) plus
   `platform-identity.js`'s `normalizeEmail`/uniqueness check. On success: a real user row
   (`role:'owner'` — every self-service signup is, by definition, someone about to own their
   own workspace), a real session (Part 6 — the account is logged in immediately), and the
   exact same verification-token flow `docs/EMAIL_VERIFICATION.md` already built
   (`requestEmailChange`, reused directly — no second implementation).
2. The account is now **"Account Created, Email Unverified"**. It can browse Account Settings,
   resend the verification email, and log out/in — but cannot create a workspace yet (Part 3):
   `POST /api/workspaces` checks `session.user.emailVerifiedAt` and returns 403
   `EMAIL_VERIFICATION_REQUIRED` otherwise.
3. Once verified (`docs/EMAIL_VERIFICATION.md`'s existing flow, unchanged), the account becomes
   eligible — see `docs/WORKSPACE_CREATION.md`.

## A critical, pre-existing interaction this phase had to fix

`tenancy.js`'s `resolveTenantForUser` has always auto-attached a user with **zero**
memberships to the sole existing tenant, **when exactly one tenant exists system-wide** — a
Phase 1/3.5 shortcut that was completely safe when the only way to get a new user was
`/api/setup` (once) or an owner adding a team member **inside** that same one tenant.

Self-service signup breaks that assumption: in the real HyperCool deployment today there is
still exactly one tenant. Without a fix, *any stranger signing up publicly would have been
silently attached to, and — since signups default to `role:'owner'` — made an OWNER of, the
real production tenant.* This was caught by this phase's own atomic-bootstrap test (an
unrelated membership-count assertion unexpectedly failed) before it ever reached a browser.

Fix: a new `users.self_registered` column (set only by `registerPublicUser`, never by
`/api/setup`, owner-created team members, or invitation registration) tells
`resolveTenantForUser` to skip the auto-attach and return `NO_WORKSPACE_ACCESS` instead for
such an account — turned into the normal "create your first workspace" prompt on the frontend
(Part 8), never a silent grant of access to someone else's real tenant. See
`docs/TENANT_SECURITY_MODEL.md`'s Phase 4C-6 update for the full security note.

## Public login screen

`public/index.html`'s `#auth-panel` gained a plain show/hide toggle (`#show-signup-link` /
`#show-login-link`) between the existing login form and a new `#signup-form` — no separate
route/hash, matching Part 42/43's "keep it simple, don't build a whole new page for a form
toggle." `render()` unconditionally resets to the login view whenever `!auth.user` (a real bug
this phase's own regression testing found: gating that reset behind `auth.needsSetup||auth.user`
left both forms permanently hidden after a later logout, since neither condition holds true by
then).

## Rate limiting

`checkSignupRateLimit` — 20 signups per IP per 15 minutes (Part 66/67), the same local-Map
shape as every other limiter in this codebase.

## Enumeration

Per Part 68, signup itself CAN report a real username/email conflict (409) — the visitor is
actively trying to register that exact identity, so this is normal, necessary UX, not
enumeration of an unrelated account. Login and forgot-password remain fully generic
(`docs/PLATFORM_IDENTITY.md` / `docs/PASSWORD_RECOVERY.md`, unchanged).
