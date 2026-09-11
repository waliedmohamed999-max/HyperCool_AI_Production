# Workspace Member Management (Multi-Tenant Phase 4C-3)

Companion to `docs/WORKSPACE_INVITATIONS.md` — this covers managing members who are *already*
in a workspace (as opposed to inviting new ones).

## Roles

Exactly the three roles this app has ever had — `owner`, `reviewer`, `operator`
(`users.role`'s own `CHECK` constraint, `src/store.js`). Phase 4C-3 invents no new role and no
permission tier on top of them.

## API

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/api/workspaces/members` | GET | owner | Real, tenant-scoped, non-removed members (`listActiveMembers`) |
| `/api/workspaces/members/:id` | PATCH | owner | `{role?, status?}` — role: the 3 real roles; status: `active`/`suspended`/`removed` |
| `/api/workspaces/members/:id` | DELETE | owner | Soft removal (`status='removed'`) — never a hard delete |

`:id` is a `tenant_memberships.id`, always scoped by `tenant_id=session.tenantId` inside
`tenancy.js`'s `getMembership` — a membership id from another tenant is indistinguishable from
one that never existed (404), the same convention every other tenant-scoped getter in this
codebase follows.

## Why owner-only

Matches `/api/users`'s existing bar exactly (that route has always been owner-only for both
listing and creating accounts) — member identity/role data is treated with the same
sensitivity as account data, not a lighter "operator can view" tier. If a future phase needs a
finer-grained permission model, that is a real, separate design decision — not one this phase
invents inline.

## Last-owner protection

`tenancy.js`'s `updateMembershipRole`/`updateMembershipStatus` both count the tenant's current
active owners (`countActiveOwners`) before allowing a role change away from `owner`, or a
status change away from `active`, on an `owner` membership — refusing with `409` if that would
leave zero. This holds regardless of who is asking, including an owner acting on their own
membership. Once a second owner exists, the same operation on the first succeeds.

## Session effect (no new invalidation mechanism)

A role/status change takes effect on the affected member's **very next request** — Phase 4C-1's
`resolveTenantForUser` already re-validates real membership status fresh, every single request,
with no cache. Suspending or removing someone is not a "soft" UI-only state; it is immediately
enforced everywhere a `tenantId` gets resolved, including Control Center's own summary
endpoint, agent config, tool assignments, and every other tenant-scoped route.

## UI

Inside Control Center → Workspace Settings → **Team** (owner only — an operator viewing
Control Center never sees these controls, since the backend would 403 them anyway): a
**Members** tab (role dropdown per member, suspend/reactivate, remove, each a real API call)
and an **Invitations** tab (create/resend/revoke, copy-link — see
`docs/WORKSPACE_INVITATIONS.md`).
