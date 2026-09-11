# Workspace Invitations (Multi-Tenant Phase 4C-3)

## Identity model — read this first

This app's `users` table has **no email column at all** — only `username`
(`[a-zA-Z0-9_.-]{3,40}`, unique, not an email). This is a real, load-bearing constraint on
everything below: the classic "verify the invitation's email matches the accepting account's
email" identity check (common in email-based SaaS invite flows) is **structurally impossible**
here — there is no email field on an account to compare against.

Rather than fake this check (matching against `username` fuzzily, or pretending an email field
exists), the security model actually implemented is: **possession of the real, hashed-at-rest,
single-use, expiring invitation token is the sole authority to accept it** — by whichever
authenticated account presents it, or a brand-new account created specifically through it. This
is the same trust model many real invite-link products fall back to once no verified identity
exists to bind against, applied honestly and documented rather than papered over with a check
that couldn't actually mean anything here.

## Schema

```sql
CREATE TABLE workspace_invitations (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 email TEXT NOT NULL,                    -- a label/contact reference, NOT matched against any user field (see above)
 role TEXT NOT NULL CHECK(role IN ('owner','reviewer','operator')),
 token_hash TEXT NOT NULL UNIQUE,        -- sha256(token) — the raw token is NEVER stored
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACCEPTED','EXPIRED','REVOKED')),
 invited_by_user_id TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 accepted_at TEXT,
 revoked_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_workspace_invitations_active_email ON workspace_invitations(tenant_id,email) WHERE status='PENDING';
```

The partial unique index is what makes "no duplicate pending invitation for the same email in
the same tenant" a real DB-level guarantee (Part 5), not a race-prone check-then-insert — a
second create request against an existing `PENDING` row is treated as an implicit resend
(new token, fresh expiry, same row) rather than rejected or duplicated.

`MEMBER_ALREADY_EXISTS` (the spec's other duplicate-handling branch) is **not** checked at
creation time — there is no email field on `users` to cross-reference against. It is instead
handled at acceptance time: accepting an invitation for a tenant you already belong to
reactivates/confirms your existing membership with the invitation's role rather than erroring
or duplicating (idempotent by construction — see "Acceptance" below).

## Token security

- Generated with `randomBytes(32).toString('hex')` (256 bits) — the exact same primitive this
  app's own session tokens already use (`auth.js`).
- Stored only as `sha256(token)`; the plaintext token exists only in memory, for the single
  HTTP response that creates or resends the invitation, and in the resulting copy-link URL.
- Single-use: accepting sets `status='ACCEPTED'`, and every acceptance path re-validates
  `status==='PENDING'` first — a second accept with the same token is rejected (`409`),
  proven by test.
- Tenant-bound and invitation-bound: a token's hash maps to exactly one `workspace_invitations`
  row; there is no way to present a token and choose a different tenant or role.

## Expiry

**7 days** (`INVITATION_EXPIRY_MS` in `src/invitations.js`). Derived live from `expires_at` at
read time — a `PENDING` row past its own expiry reads as `EXPIRED` everywhere (preview, accept,
list) with no background job needed to keep a stored status in sync (Part 75).

## Creation lifecycle

```
POST /api/workspaces/invitations   { email, role }   — owner only
 → validate email format, validate role (the 3 real roles only)
 → existing PENDING row for (tenant, email)? → rotate its token/role/expiry (implicit resend)
 → else → INSERT a new PENDING row
 → return { ...invitation, token }   — the ONLY response that ever carries the raw token
```

No email is actually sent (see "Email delivery" below) — the response's `token` is used by the
frontend to build a copy-link (`https://.../#invite/<token>`) that the owner sends manually.

## Resend / Revoke

`POST .../:id/resend` rotates the token and expiry on the same row (the old token stops
working immediately) and returns the new one-time token. `POST .../:id/revoke` sets
`status='REVOKED'`; a revoked invitation can never be accepted again, even if the old link is
still open in someone's browser (Part 54, proven by test: revoke *after* the invitee has
already loaded the preview still blocks the subsequent accept).

## Acceptance

Two real entry points, sharing one core (`acceptInvitation` in `src/invitations.js`) once a
`userId` is known:

**Existing user** — `POST /api/invitations/:token/accept`, authenticated, no request body.
Re-validates the token (pending, not expired, not revoked, tenant not suspended/archived), then
creates or reactivates the membership with the invitation's role, marks the invitation
`ACCEPTED`. Placed in `application.js` alongside the Phase 4C-1 workspace-selection routes:
reachable even when the accepting user's OTHER memberships are ambiguous
(`TENANT_SELECTION_REQUIRED`), since accepting a brand-new invitation must never be blocked by
an unrelated pre-existing ambiguity.

**New user** — `POST /api/invitations/:token/register` `{username, name, password}`,
unauthenticated. Re-validates the token first (so an expired/revoked/already-accepted token
never even reaches account creation), creates the account via the exact same `auth.createUser`
every other account on this platform goes through (same password policy, same hashing), with
the invitation's role as the new account's global role — then runs the identical acceptance
core, logs the new user in (a real session, same `Set-Cookie` shape as `/api/login`), and
returns the joined workspace. **No second authentication stack was created** — this is the
existing `auth.js` primitives, called from one more place.

Both paths use whatever role is **currently stored on the invitation** — if an owner changes
the role via resend after the invitee already opened the link, the invitee gets the latest
role, never a stale one baked into the link itself (Part 55, proven by test).

## Multi-workspace / first-workspace behavior

Accepting a **new** invitation while already a member of another tenant does **not**
auto-switch the active workspace (Part 51) — the user stays on whatever they had active, and
the new workspace simply appears in `GET /api/workspaces` for them to switch to explicitly. A
brand-new account (via `register`) has exactly one membership after acceptance, so the existing
Phase 4C-1 resolution (`resolveTenantForUser`) resolves it automatically with zero friction —
no special-casing needed (Part 52).

## Member Management

`GET /api/workspaces/members` (owner only) — real, tenant-scoped, non-removed members
(`listActiveMembers` in `tenancy.js` — a new function; the pre-existing `listTenantMembers` is
untouched, since 3 existing tests depend on its exact "every row, any status" shape).

`PATCH /api/workspaces/members/:id` `{role?, status?}` — role limited to the 3 real roles;
status to `active`/`suspended`/`removed`. `DELETE /api/workspaces/members/:id` is a soft
removal (`status='removed'`) — matching this codebase's established "archive, don't erase"
convention (Phase 4C-1's `removeMembership`); history/audit rows referencing this membership are
never touched.

**Last-owner protection** (Part 9/25): `tenancy.js`'s `updateMembershipRole`/
`updateMembershipStatus` both refuse to demote, suspend, or remove a tenant's last active
`owner` — regardless of who is asking, including that owner acting on themselves. Proven by
test: with exactly one owner, all three operations `409`; once a second owner exists, the same
operation on the first succeeds.

## Session invalidation (no new mechanism needed)

This is the direct payoff of Phase 4C-1's own design: `resolveTenantForUser` already
re-validates `tenant_memberships.status='active'` **fresh, on every single request** — it was
never cached. Suspending or removing a member's row is instantly effective on their very next
request, with zero new invalidation code (proven by test: a suspended member's next `GET
/api/crm` gets `403 NO_WORKSPACE_ACCESS` or, if they have other memberships,
`TENANT_SELECTION_REQUIRED`/a safe fallback — never continued access to the revoked tenant).

## Rate limiting

A simple, conservative in-memory limiter (`checkInvitationRateLimit`, identical shape to
`auth.js`'s own login limiter) — 20 attempts per 15 minutes per IP — guards the three
**unauthenticated**, token-guessing-reachable routes: `preview`, `accept`, `register`. The
authenticated create/resend/revoke routes are already behind session + CSRF + owner-role, a
materially higher bar than a bare IP address.

## Email delivery status — stated plainly

**No email delivery exists.** This codebase has no platform-level email transport (the only
email-capable code is `microsoft-graph.js`, which sends through a specific TENANT's own
connected mailbox for marketing email — using it here would make invitations depend on that
tenant having Microsoft 365 configured, which is not this platform's actual behavior and was
deliberately not built). The UI shows the real, honest state: an invitation is created, its
one-time link is copied to the clipboard, and the owner is told explicitly to send it manually
— never a claim that an email was sent.

## Security summary (matches the Phase 4C-3 acceptance criteria)

| Question | Answer |
|---|---|
| Is the token ever stored in plaintext? | No — only `sha256(token)` |
| Can a token be reused after acceptance? | No — `status='ACCEPTED'` blocks every subsequent accept attempt |
| Can a foreign tenant's invitations be listed/resent/revoked? | No — every lookup filters `tenant_id=?`; a foreign id is indistinguishable from nonexistent (404) |
| Can a non-owner invite or manage members? | No — every route is `authorize(session,['owner'])`, matching `/api/users`'s existing bar exactly |
| Can the last owner be removed? | No — enforced in `tenancy.js`, independent of who's asking |
| Does a guessed token leak anything? | No — 404, identical to a real-but-garbage token; no user-existence enumeration anywhere |
| Does revoking mid-flow work? | Yes — a token loaded before revocation still fails to accept afterward |

## Known limitations

- `MEMBER_ALREADY_EXISTS` is not detected at *creation* time (no reliable email-to-account
  lookup existed at the time this table's identity model was designed) — handled at
  *acceptance* time instead (idempotent reactivation).
- No owner-transfer workflow beyond simple role changes (a tenant can have multiple owners;
  there is no single "primary owner" concept to transfer) — not required by this phase.
- No invitation search/filter UI beyond the plain list — acceptable at expected volumes.

## Phase 4C-5 update: real email delivery + identity-bound invitations

The "no email delivery exists" limitation above is now **partially closed**: a real Platform
Mail Service exists (`docs/PLATFORM_EMAIL.md`) and `POST /api/workspaces/invitations` /
`.../resend` now attempt a real send of the accept link. The response's `delivered` flag
reports the true outcome — the owner's copy-link fallback (unchanged from Phase 4C-3) remains
available regardless, since a real transport may still be unconfigured or a send may still
fail.

Every invitation created from Phase 4C-5 onward is classified `EMAIL_BOUND` (a new
`invitation_mode` column, additive) rather than the original `TOKEN_ONLY_LEGACY` trust model:

- **A brand-new account** registering through an `EMAIL_BOUND` link (`/register`) has its email
  promoted straight to verified — receiving the link at that address is treated as the same
  proof email verification itself relies on (Part 35).
- **An existing, authenticated user** accepting one (`/accept`) is refused (403) only on a
  **provable mismatch** — they already have a *different* verified email on file. A user with
  no verified email yet is **not** blocked (this was a deliberate revision after this phase's
  own regression testing showed the stricter original design broke ordinary acceptance for
  virtually every existing account, since almost none had a verified email yet — see
  `docs/PLATFORM_IDENTITY.md`'s "Real bugs this phase's own testing found" section). A full
  "verified email required to accept" policy is deferred to whenever email becomes mandatory
  platform-wide, ahead of Phase 4C-6.
- Every invitation created **before** this phase (and therefore never actually delivered by a
  real mail service, since none existed) keeps its `TOKEN_ONLY_LEGACY` classification and
  accepts on token possession alone, completely unchanged — this phase never reinterprets a
  pre-existing invitation's trust model retroactively.

The original "Security summary" table above is unaffected: every row in it remains true for
both invitation modes.
