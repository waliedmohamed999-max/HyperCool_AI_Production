import {fail} from '../auth.js';
import {getTenant} from '../tenancy.js';
import {PERMISSIONS, ROLE_PERMISSIONS, SUPPORT_LEVEL_ROLE, parseJson} from './core.js';
import {getProfile, resolveAccess} from './plans.js';
import {validateSupportToken} from './support.js';

// Who is calling the portal API, in which workspace, with which permissions.
//  * tenant comes ONLY from the server side: the caller's own client_members rows (+ the session's active
//    workspace when they belong to several). A tenant id in a body/query/header is never trusted.
//  * a platform admin has no workspace of their own here; they act inside one only through a valid,
//    unexpired support session bound to their own signed-in session.

export function resolveClientContext(db, env, session, supportToken = null) {
 if (!session) return {error: {status: 401, code: 'UNAUTHENTICATED'}};
 const support = validateSupportToken(db, env, supportToken, session.user);
 if (support) {
  const role = SUPPORT_LEVEL_ROLE[support.access_level];
  return build(db, session, support.tenant_id, {role, permissions: new Set(ROLE_PERMISSIONS[role]), memberStatus: 'active', readOnly: support.access_level === 'view_only', support});
 }
 const memberships = db.prepare("SELECT * FROM client_members WHERE user_id=? AND status='active' ORDER BY created_at").all(session.user.id);
 if (!memberships.length) return {error: {status: 403, code: 'NO_CLIENT_WORKSPACE'}};
 const chosen = memberships.find(m => m.tenant_id === session.activeTenantId) || memberships[0];
 return build(db, session, chosen.tenant_id, {role: chosen.workspace_role, permissions: new Set(ROLE_PERMISSIONS[chosen.workspace_role] || []), memberStatus: chosen.status, readOnly: false, support: null, workspaces: memberships.length});
}
function build(db, session, tenantId, extra) {
 const profile = getProfile(db, tenantId);
 const tenant = getTenant(db, tenantId);
 if (!profile || !tenant) return {error: {status: 403, code: 'NO_CLIENT_WORKSPACE'}};
 const access = resolveAccess(db, tenantId);
 const support = extra.support;
 const actor = support
  ? {id: session.user.id, name: session.user.name, kind: 'admin_support', supportSessionId: support.id, reason: support.reason, onBehalfOf: profile.owner_user_id}
  : {id: session.user.id, name: session.user.name, kind: 'user'};
 return {user: session.user, csrf: session.csrf, tenantId, tenant, profile, access, role: extra.role, permissions: extra.permissions, readOnly: extra.readOnly, support, actor, workspaces: extra.workspaces || 1};
}
export const can = (ctx, permission) => ctx.permissions.has(permission);
export function requirePermission(ctx, permission) {
 if (!PERMISSIONS.includes(permission)) throw new Error(`unknown permission ${permission}`);
 if (!ctx.permissions.has(permission)) fail(403, `PERMISSION_DENIED:${permission}`);
}
export function requireEntitlement(ctx, key) {
 if (!ctx.access?.entitlements.includes(key)) throw Object.assign(new Error('ENTITLEMENT_REQUIRED'), {status: 403, code: 'ENTITLEMENT_REQUIRED', entitlement: key});
}
/** Reads allowed while limited; writes only while operational. Suspended/cancelled/archived/pending block everything but /me. */
export function requireState(ctx, {write}) {
 const s = ctx.access.state.status;
 if (write) { if (!['trial', 'active', 'past_due'].includes(s)) fail(403, `CLIENT_${s.toUpperCase()}`); }
 else if (!['trial', 'active', 'past_due', 'limited'].includes(s)) fail(403, `CLIENT_${s.toUpperCase()}`);
}
export const publicAccess = ctx => ({
 accountStatus: ctx.access.state.status, workspaceStatus: ctx.profile.workspace_status, expired: ctx.access.state.expired,
 plan: ctx.access.plan && {slug: ctx.access.plan.slug, nameAr: ctx.access.plan.nameAr, nameEn: ctx.access.plan.nameEn, billingPeriod: ctx.access.plan.billingPeriod},
 trialEndsAt: ctx.access.state.sub?.trial_ends_at || null, endsAt: ctx.access.state.sub?.ends_at || null, graceUntil: ctx.access.state.sub?.grace_until || ctx.profile.grace_until || null,
 entitlements: ctx.access.entitlements, limits: ctx.access.limits
});
export {parseJson};
