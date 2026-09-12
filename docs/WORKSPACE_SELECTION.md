# Workspace Selection (Multi-Tenant Phase 4C-1)

How a multi-membership user gets from "authenticated" to "acting in exactly one, real,
server-validated tenant" — closing the `TENANT_SELECTION_REQUIRED` gap Phase 3.5 deliberately
left open until a real multi-membership path existed to build and test this against.

## 1. Previous architecture

`src/tenancy.js`'s `resolveTenantForUser(db, userId)` was called once per authenticated
request (`application.js`, right after `auth.current(req)`), before any route handler ran. It
resolved a user's tenant from `tenant_memberships`:

- 0 memberships → **lazily auto-attached to whichever tenant `ensureDefaultTenant` returns**
  (the very first tenant ever created, by `created_at`) — regardless of how many tenants
  existed elsewhere in the system.
- 1 membership → that tenant, deterministically.
- >1 memberships → `TENANT_SELECTION_REQUIRED` (409) — correct, but a dead end: there was no
  way to ever resolve past it, because no selection mechanism existed at all.

## 2. Why `TENANT_SELECTION_REQUIRED` existed and never had a fix

Phase 3.5 added the `>1` check to close a real fail-open gap (an unguarded `LIMIT 1`-style
pick), but explicitly scoped out building the selection mechanism itself — "there is
deliberately no active-tenant selection endpoint or UI built yet... until a real
multi-membership path exists to test it against." No route in this codebase has ever created
a second membership for an existing user (`createTenant` only ever adds a membership for its
own new owner), so the `>1` branch was real but practically unreachable — a correct guard with
no way through it. This phase builds that way through.

## 3. Chosen active-workspace design

**Reused the existing server-side session — no new authentication mechanism, no client-side
signed token.** `sessions` (already `token TEXT PRIMARY KEY, user_id, csrf, expires` — see
`src/store.js`) gained one additive, nullable column: `active_tenant_id`. This was the clear
first choice per the stated preference order: this app has no JWT, no client-trusted identity
token at all — every request's identity comes from an opaque, hashed, server-side-looked-up
session cookie (`hc_session`, `HttpOnly; SameSite=Strict`). Persisting the workspace choice as
one more column on that same row means:

- It is never readable or writable by the client directly — only through
  `PUT /api/workspaces/active`, which validates membership first (see §5).
- It requires no new cookie, no new signing/encryption scheme, no new CSRF surface (the
  existing `x-csrf-token` check already covers this route, being a normal mutating `/api/`
  call).
- A stale or forged value is structurally impossible to matter: `resolveTenantForUser` treats
  it as a **hint to re-validate**, never as the authority itself (§7).

No new table was created. `tenant_memberships`/`tenants` (Phase 1) already modeled exactly
what was needed — the gap was entirely in *resolution*, not *storage*.

## 4. Authentication relationship

Unchanged. `auth.current(req)` still resolves `{user, csrf, tokenHash}` from the session
cookie exactly as before; it now also returns `activeTenantId` (the raw column value, still
unvalidated at this point) as `session.activeTenantId`. An unauthenticated request still gets
`session === null`, and every protected route still fails with the existing `401` ("سجل
الدخول أولًا") via `authorize()` — Case 1 (`AUTH_REQUIRED` equivalent) required no change at
all.

## 5. Membership validation

Every workspace-facing function in `tenancy.js` shares one query
(`VALID_MEMBERSHIP_JOIN`/`validMembershipsForUser`):

```sql
SELECT tm.tenant_id, tm.role, t.name, t.slug, t.status
FROM tenant_memberships tm JOIN tenants t ON t.id = tm.tenant_id
WHERE tm.user_id = ? AND tm.status = 'active' AND t.status IN ('ACTIVE','TRIAL')
```

Both halves matter and were both gaps before this phase: `tenant_memberships.status` has
existed since Phase 1 but nothing ever filtered on it (a revoked membership would have kept
counting as valid — a real, if previously unreachable, class of unwanted access this phase
closes), and `tenants.status` was never checked either (a `SUSPENDED`/`ARCHIVED` tenant would
have stayed selectable). Every function below builds on this one query — never a second,
possibly-inconsistent membership check.

## 6. Workspace activation lifecycle

```
authenticate (auth.current)
 → session.activeTenantId  (the persisted hint — NOT yet trusted)
 → resolveTenantForUser(db, userId, session.activeTenantId)
    0 valid memberships, 1 tenant system-wide  → legacy single-tenant auto-attach (unchanged)
    0 valid memberships, >1 tenants exist      → NO_WORKSPACE_ACCESS
    1 valid membership                          → that tenant (Case 3 — zero friction)
    >1 valid memberships, hint matches one      → that one (Case 5)
    >1 valid memberships, no match              → TENANT_SELECTION_REQUIRED (Case 4)
 → session.tenantId bound for this request's remaining lifetime
 → every tenant-scoped service call uses session.tenantId, same as before this phase
```

`PUT /api/workspaces/active` is the only place a client-supplied id is ever accepted, and only
after `activateWorkspaceForUser` re-runs the exact same membership query — a foreign or
nonexistent id gets the identical `TENANT_ACCESS_DENIED` (403) either way, so a client can
never fingerprint whether some other tenant id happens to exist. Only on success is
`auth.setActiveTenant(session.tokenHash, tenantId)` called, persisting the new hint.

## 7. Stale selection behavior

`resolveTenantForUser` never trusts `session.activeTenantId` — it re-validates it against
`validMembershipsForUser`'s live, fresh query on **every single request**. There is no
separate "invalidate the cache" step because there is no cache: a membership revoked since the
hint was stored simply stops matching, on the very next request, and resolution falls through
exactly as if no hint had ever been stored (down to 1 remaining valid membership → resolved
automatically; still >1 → `TENANT_SELECTION_REQUIRED` again; down to 0 → `NO_WORKSPACE_ACCESS`
if >1 tenant exists system-wide). Proven by test (`workspace-selection.test.js`, "Case 7").

## 8. Switching behavior

`PUT /api/workspaces/active` re-validates membership, persists the new hint, and returns
immediately — the very next request (any route) resolves the new tenant, because resolution
happens fresh every time (§7). There is no separate "apply the switch" step and nothing to
propagate asynchronously.

## 9. Cache behavior

Audited every tenant-scoped subsystem this phase touches for a hidden, non-tenant-keyed cache:
`TenantAgentConfig`, `AgentToolAssignment`, `IntegrationConnection`, `ToolReadiness`/
`AgentReadiness`, `capabilityGranted` (Phase 4B.1). **None of them cache anything** — every one
of these is a live SQL read (or, for readiness/capability, a pure computation over live reads)
scoped by `tenant_id` on every call, with no in-memory memoization keyed any other way. This
was true before this phase and remains true after; Phase 4C-1 adds no new cache anywhere. On
the frontend, the only persisted client-side state at all is the locale preference
(`localStorage`, `hc_locale` — a user preference, correctly never cleared on a workspace
switch); there is no Redux/React Query/Zustand/SWR store to reset, and the app's one in-memory
`viewData` `Map` is already rebuilt from scratch at the top of every `render()` call. Verified
directly by test (`workspace-selection.test.js`'s CRM-lead switching test, the agent-config/
tool-assignment isolation test, the integration-connection isolation test, the approval
isolation test, and the Phase 4B.1 capability-regression test) — each asserts real returned
data, not just HTTP status codes, both immediately after a switch and after switching back.

## 10. Security boundaries

- The only trusted source of `tenantId` for any tenant-scoped operation is
  `session.tenantId`, resolved server-side, once per request, from the real membership table —
  never a request body, query string, or header.
- `PUT /api/workspaces/active`'s `workspaceId` input is the **one deliberate exception** — and
  even there it is fully re-validated before being trusted at all (§5/§6).
- CSRF: the workspace-activation route is a normal mutating `/api/` route and goes through the
  exact same `x-csrf-token` check every other mutation already requires — no exception, no new
  CSRF surface.
- Cookie: unchanged (`hc_session`, `HttpOnly`, `SameSite=Strict`, `Secure` in production via
  the existing `PUBLIC_ORIGIN` HTTPS check). No secret is ever stored in `active_tenant_id` —
  it is an opaque tenant id, not a credential, and is meaningless without also holding the
  valid session cookie for that same user.

## 11. Tenant spoofing defenses (proven by test)

`workspace-selection.test.js`'s "Tenant context cannot be spoofed..." test proves, against
real HTTP responses (not just status codes): a `tenantId` embedded in a request body is
ignored (the resource still lands in the real active workspace); a `tenantId`/`workspaceId`
query-string parameter is ignored; an arbitrary `x-tenant-id`/`x-workspace-id` header is
ignored (grepped the entire backend — no route reads any such header). The only channel that
can ever change the active tenant is the validated `PUT /api/workspaces/active` call itself.

## 12. Frontend behavior

`public/components/workspace-switcher.js` (new) + a small addition to `public/app.js`'s
`render()`:

- Every render cycle calls `GET /api/workspaces/active` before rendering anything
  tenant-scoped. If it resolves (the common case — including every single-membership user,
  which is the entire real deployment today), rendering proceeds exactly as before, with zero
  visible change for that user.
- If it returns `TENANT_SELECTION_REQUIRED`/`NO_WORKSPACE_ACCESS`, the app shows a dedicated
  `#workspace-select-panel` gate (built from the real `workspaces` array the same response
  already carries) and returns **before** rendering `#protected`'s dashboards — no tenant-
  scoped page ever loads before a workspace is actually resolved (Part L).
- The session-bar switcher (`#workspace-switcher`) renders nothing at all when the user has
  fewer than 2 real workspaces (Part K: "for one workspace, keep UX simple") — calls
  `GET /api/workspaces` fresh on every render, never memoized.
- Switching calls the real `PUT /api/workspaces/active` and then simply re-runs the app's
  existing `render()` — which already re-fetches every piece of tenant-scoped state from
  scratch on every call, so no separate "reset" step was needed (§9).
- Never a raw tenant id shown prominently — only `name`/`slug`/`role`.

## 13. Intentionally unsupported / deferred

Per this phase's explicit scope: no Control Center, no billing/subscriptions, no workspace
invitations (a user's second+ membership must currently be created by a database-level
`createTenant(..., ownerUserId)` call — there is no self-serve "invite me to a workspace" flow
yet), no Super Admin, no white-labeling, no new/expanded OAuth flows, no Canva, no fake
analytics. `removeMembership` (added to `tenancy.js` to make Case 7 provable by a real test)
has no HTTP route — it exists for the same reason `createTenant` did before Phase 4B: a real,
tested primitive the next phase's member-management UI can call rather than inventing one
blind.

## 14. APIs

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/api/workspaces` | GET | any authenticated role | Only workspaces with a real, active membership in a real, active/trial tenant. Never a foreign one. |
| `/api/workspaces/active` | GET | any authenticated role | 200 + the active workspace once resolved; 409/403 + the real `workspaces` list when it isn't (never a bare error with no way forward) |
| `/api/workspaces/active` | PUT | any authenticated role, CSRF-protected | `{workspaceId}` → re-validated membership → persisted → returned. `TENANT_ACCESS_DENIED` for anything not a real, current, valid membership |

## 15. Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `AUTH_REQUIRED` *(existing "سجل الدخول أولًا")* | 401 | No/invalid session |
| `NO_WORKSPACE_ACCESS` | 403 | Authenticated, zero valid memberships, and more than one tenant exists system-wide (the single-tenant case keeps the pre-existing lossless auto-attach — zero regression risk) |
| `TENANT_SELECTION_REQUIRED` | 409 | >1 valid membership, no matching active selection — response body includes the real `workspaces` list |
| `TENANT_ACCESS_DENIED` | 403 | `PUT /api/workspaces/active` targeted a tenant the user has no valid membership in — identical response whether that tenant exists at all or not |

## Phase 4C-3 update: memberships now have a real way to be created and revoked

Phase 4C-1 built the selection mechanism; Phase 4C-3 (`docs/WORKSPACE_INVITATIONS.md`,
`docs/WORKSPACE_MEMBERS.md`) built the first real way memberships come and go — invitations and
owner-driven member management. No change was needed here: `resolveTenantForUser`'s per-request
re-validation (§7 above) already handles a membership appearing or disappearing correctly, with
zero new invalidation code — proven directly by Phase 4C-3's own tests (a suspended/removed
member loses access on their very next request; a newly accepted invitation's workspace appears
in `GET /api/workspaces` without requiring re-login).

## Phase 4C-6 update: the zero-membership gate is no longer always a dead end

A real change WAS needed here, though not to the resolution logic itself. Two things changed:

1. **`resolveTenantForUser`'s zero-membership branch now also checks `users.self_registered`**
   before running its legacy single-tenant auto-attach, refusing with `NO_WORKSPACE_ACCESS`
   for a self-service signup even when exactly one tenant exists system-wide (previously this
   auto-attach fired unconditionally at `n===1`, which is exactly the real HyperCool
   deployment's current tenant count — see `docs/SELF_SERVICE_SIGNUP.md` for why that was a
   real security gap this phase found and closed, not a style change).
2. **The frontend gate (`components/workspace-switcher.js`'s `renderWorkspaceGate`) no longer
   treats every `NO_WORKSPACE_ACCESS` the same way.** A verified user with zero real
   memberships now sees a real "create your first workspace" call to action
   (`docs/WORKSPACE_CREATION.md`) instead of the old static "no access, contact your system
   owner" message; an unverified one sees a distinct "verify your email first" prompt with a
   working resend button. The underlying backend error code and resolution semantics are
   completely unchanged — only what the frontend does with that specific, already-existing
   signal is new.

## Phase 4C-7 update: `#account`/`#platform` are workspace-INDEPENDENT pages, and two real bugs
that only surfaced under a genuinely zero-workspace session

Both `<div class="page" data-page="account">` and `<div class="page" data-page="platform">`
live, in the DOM, nested inside `#protected` — the same container the workspace-selection gate
hides wholesale via `$('#protected').hidden=!workspace.ready`. That is correct for every
workspace-SCOPED page, but Account Settings (personal identity) and the Platform Admin
dashboard (cross-tenant authority, `docs/PLATFORM_OPERATIONS.md`) are both legitimately
reachable with zero ready workspaces — a brand-new verified user going to Account Settings from
the gate's own button, or a Platform Admin who owns no workspace of their own. Before this
phase, neither page's render function even ran in that state (`render()` returned early from
the gate), so both were completely unreachable — a real, latent bug from Phase 4C-5/4C-6, only
found now because this phase's Playwright testing specifically exercised a
platform-admin-with-zero-workspaces scenario.

The fix, in `app.js`'s `render()`: when the current hash is `#account`, or `#platform` AND
`auth.isPlatformAdmin` is true, `#protected` stays visible and the gate is skipped — that page's
render function is called directly instead. Two follow-on bugs were found while proving this
end-to-end and are both fixed:

1. **A hash-based (not admin-based) carve-out is wrong.** The first version of this fix checked
   only `['account','platform'].includes(currentPage())`, with no admin check — so a completely
   ordinary user who happened to still have `#platform` in the URL (left over from an earlier,
   correctly-refused direct-navigation attempt) would skip the workspace gate entirely and get
   stuck on a page they have no authority to view, instead of the real
   selection/creation/trial-ended prompt. Fixed by gating the `#platform` branch on
   `auth.isPlatformAdmin` specifically; `#account` has no such gate since every authenticated
   user may always view their own account.
2. **`POST /api/logout` itself required a resolvable tenant.** It was registered, in
   `application.js`, after the generic `if(url.pathname.startsWith('/api/') && tenantResolutionError) throw tenantResolutionError;`
   gate — so any session with no resolvable workspace (a Platform Admin with zero workspaces of
   their own, or a brand-new signup) got a 403 `NO_WORKSPACE_ACCESS` from logout itself. Fixed
   by moving the logout route before that gate, alongside `GET /api/auth` (logout is a pure
   session action, never a workspace one), with its own explicit CSRF check preserved and a
   null-session guard (an unauthenticated logout call is now a harmless no-op, not a crash).
