import {fail} from '../auth.js';
import {isPlatformAdmin} from '../platform-admin.js';
import {STAFF_PERMISSIONS, hasPermission} from './core.js';

// Who is this session in the partner world? Resolved from the trusted server session only.
//   user            - any signed-in account
//   partner         - has a partner profile
//   partner_manager - active partner_staff row (per-permission scope)
//   admin/owner     - platform administrator (PLATFORM_ADMIN_USERNAMES): full program control
// A workspace owner is NOT a program admin: the partner program is platform-wide.
export function partnerContext(db, env, session) {
 if (!session) return null;
 const user = session.user;
 const admin = isPlatformAdmin(env, user);
 const staff = db.prepare('SELECT * FROM partner_staff WHERE user_id=?').get(user.id);
 const staffActive = !!staff && staff.status === 'active';
 const profile = db.prepare('SELECT * FROM partner_profiles WHERE user_id=? AND deleted_at IS NULL').get(user.id) || null;
 const permissions = admin ? [...STAFF_PERMISSIONS, 'settings', 'staff'] : staffActive ? JSON.parse(staff.permissions_json || '[]') : [];
 const roles = ['user'];
 if (profile) roles.push('partner');
 if (staffActive) roles.push('partner_manager');
 if (admin) roles.push('admin', 'owner');
 return {user, isAdmin: admin, isManager: admin || staffActive, permissions, profile, roles};
}
export function requireSession(ctx) {
 if (!ctx) fail(401, 'سجل الدخول أولًا');
 return ctx;
}
export function requireManager(ctx, permission = null) {
 requireSession(ctx);
 if (!ctx.isManager) fail(403, 'هذا الإجراء متاح فقط لإدارة الشراكات');
 if (permission && !hasPermission(ctx.permissions, permission)) fail(403, 'لا تملك صلاحية هذا الإجراء ضمن إدارة الشراكات');
 return ctx;
}
export function requireAdmin(ctx) {
 requireSession(ctx);
 if (!ctx.isAdmin) fail(403, 'هذا الإجراء متاح فقط لمسؤول المنصة');
 return ctx;
}
export function requirePartner(ctx) {
 requireSession(ctx);
 if (!ctx.profile) fail(403, 'NOT_A_PARTNER');
 return ctx.profile;
}
export const actorOf = ctx => ({id: ctx.user.id, name: ctx.user.name, role: ctx.isAdmin ? 'admin' : ctx.isManager ? 'partner_manager' : ctx.profile ? 'partner' : 'user'});
