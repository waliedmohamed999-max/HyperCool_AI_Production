// TeamOpsService — owner-protection, audit shaping and read-aggregation for the Team
// Management & Access Control Center. Uses only the real three roles this app has ever had
// (owner/reviewer/operator) and the minimal primitives just added to auth.js. Never invents
// an invite system, a temporary-password flow, or a "Suspended"/"Pending" role — those exact
// concepts either don't exist in this app (invitations) or map onto the real `status` column
// this migration added (Active/Suspended), documented as such throughout.
import {fail} from './auth.js';

export const ROLE_NAMES={owner:'مالك',operator:'مشغل',reviewer:'مراجع'};
export const ROLE_DESCRIPTIONS={
 owner:'صلاحية كاملة على كل الوحدات، بما فيها إدارة الفريق واعتماد المحتوى والذاكرة.',
 operator:'إعداد المسودات وفرص المبيعات ومقترحات الذاكرة — بانتظار اعتماد المالك أو مراجعة المراجع.',
 reviewer:'مراجعة الامتثال ورفض أو تمرير المحتوى للاعتماد — لا وصول لملفات المبيعات.'
};
// Transcribed directly from every authorize(session,[...]) call in server.js (verified by
// a full-file audit) — there is no dynamic permission-registry data structure in this app to
// introspect at runtime, so this matrix is the accurate, documented shape of what is already
// enforced server-side. Keep in sync by hand if a route's authorize() list changes.
export const ROLE_MATRIX=[
 {area:'المبيعات (CRM)',owner:'MANAGE',operator:'EDIT',reviewer:'NONE'},
 {area:'المحتوى',owner:'MANAGE',operator:'EDIT',reviewer:'EDIT'},
 {area:'الموافقات (اعتماد المحتوى)',owner:'MANAGE',operator:'NONE',reviewer:'NONE'},
 {area:'موافقات الوكلاء والتصعيدات',owner:'MANAGE',operator:'VIEW',reviewer:'VIEW'},
 {area:'فريق الوكلاء',owner:'MANAGE',operator:'VIEW',reviewer:'VIEW'},
 {area:'التكاملات',owner:'MANAGE',operator:'VIEW',reviewer:'VIEW'},
 {area:'ذاكرة العلامة',owner:'MANAGE',operator:'EDIT',reviewer:'VIEW'},
 {area:'إدارة الفريق',owner:'MANAGE',operator:'NONE',reviewer:'NONE'}
];
export const PERMISSION_LABELS={MANAGE:'إدارة كاملة',EDIT:'إنشاء وتعديل',VIEW:'عرض فقط',NONE:'لا وصول'};

function activeOwnerCount(db,excludingId=null) {
 return db.prepare("SELECT COUNT(*) c FROM users WHERE role='owner' AND status='active'"+(excludingId?' AND id!=?':'')).get(...(excludingId?[excludingId]:[])).c;
}
// The two real "would this leave the system with no owner?" guards the spec asks for —
// covers self-demotion and other-initiated changes alike, since both are just "does this
// user's role/status change reduce the active-owner count to zero?"
export function assertRoleChangeAllowed(db,userId,newRole) {
 if(newRole==='owner')return;
 const target=db.prepare('SELECT role,status FROM users WHERE id=?').get(userId);
 if(!target)fail(404,'العضو غير موجود');
 if(target.role!=='owner'||target.status!=='active')return;
 if(activeOwnerCount(db,userId)<1)fail(409,'لا يمكن ترك النظام بلا مالك واحد على الأقل');
}
export function assertDeactivationAllowed(db,userId) {
 const target=db.prepare('SELECT role,status FROM users WHERE id=?').get(userId);
 if(!target)fail(404,'العضو غير موجود');
 if(target.role!=='owner'||target.status!=='active')return;
 if(activeOwnerCount(db,userId)<1)fail(409,'لا يمكن ترك النظام بلا مالك نشط واحد على الأقل');
}
/** Accounts that are (or were invited as) members of ONE workspace — never the platform-wide user directory. */
export function listUsersForTenant(db,tenantId) {
 return db.prepare(`SELECT u.id,u.username,u.name,COALESCE(tm.role,u.role) AS role,u.status,u.created_at,u.last_login_at
  FROM users u JOIN tenant_memberships tm ON tm.user_id=u.id WHERE tm.tenant_id=? AND tm.status IN ('active','suspended') ORDER BY u.name`).all(tenantId);
}
/**
 * A workspace owner may administer an account (reset its access, suspend or remove it) only when that account belongs to
 * this workspace and to no other one: those actions change the ACCOUNT, so they would otherwise reach into every other
 * workspace the person belongs to. Accounts of platform administrators are never manageable from a workspace.
 */
export function canManageUserFromTenant(db,tenantId,targetUserId,{isPlatformAdminUser=false}={}) {
 if(isPlatformAdminUser)return false;
 const memberships=db.prepare("SELECT tenant_id FROM tenant_memberships WHERE user_id=? AND status IN ('active','suspended')").all(targetUserId);
 return memberships.length>0&&memberships.every(m=>m.tenant_id===tenantId);
}
export function buildTeamDashboard(db,{auditEntries,tenantId=null}) {
 const users=tenantId?listUsersForTenant(db,tenantId):db.prepare('SELECT id,username,name,role,status,created_at,last_login_at FROM users ORDER BY name').all();
 const onlineIds=new Set(db.prepare('SELECT DISTINCT user_id FROM sessions WHERE expires>?').all(Date.now()).map(r=>r.user_id));
 const members=users.map(u=>({...u,hasActiveSession:onlineIds.has(u.id)}));
 const summary={
  total:members.length,
  active:members.filter(m=>m.status==='active').length,
  owners:members.filter(m=>m.role==='owner').length,
  pendingInvitations:0
 };
 const USER_ACTIONS=['USER_CREATED','USER_ROLE_CHANGED','USER_SUSPENDED','USER_REACTIVATED','USER_REMOVED','USER_ACCESS_RESET','USER_SESSIONS_REVOKED'];
 const activity=auditEntries.filter(a=>USER_ACTIONS.includes(a.action)).slice(0,30);
 return {summary,members,roleMatrix:ROLE_MATRIX,roleNames:ROLE_NAMES,roleDescriptions:ROLE_DESCRIPTIONS,activity};
}
