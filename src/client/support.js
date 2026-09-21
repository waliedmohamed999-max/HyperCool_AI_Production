import {fail} from '../auth.js';
import {isPlatformAdmin} from '../platform-admin.js';
import {sendSecurityNotice} from '../runtime/platform-mail.js';
import {SUPPORT_LEVELS, audit, clean, getSettings, newId, newToken, notifyMembers, now, sha, tx} from './core.js';
import {getProfile} from './plans.js';

// "Support mode" (الدخول بوضع الدعم). There is NO impersonated login and no customer password is ever
// involved: the admin keeps their own session and additionally carries a short-lived, hashed support
// token bound to (admin, workspace, level). The portal API re-validates it on every request, so
// expiry/revocation/ending takes effect immediately, and every request is logged.

export const SUPPORT_COOKIE = 'hc_support';

/** May this platform admin open support sessions? (`SUPPORT_ACCESS_USERNAMES` narrows it further when set.) */
export function canStartSupport(env, user) {
 if (!isPlatformAdmin(env, user)) return false;
 const allow = String(env.SUPPORT_ACCESS_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
 return !allow.length || allow.includes(String(user.username || '').toLowerCase());
}

const hydrate = r => r && ({
 id: r.id, tenantId: r.tenant_id, adminName: r.admin_name, adminUserId: r.admin_user_id, accessLevel: r.access_level, reason: r.reason, ticket: r.ticket, status: r.status,
 startedAt: r.started_at, expiresAt: r.expires_at, endedAt: r.ended_at, endReason: r.end_reason
});

export function startSupportSession(db, env, admin, tenantId, {reason, ticket = null, minutes = 30, level = 'view_only'}) {
 if (!canStartSupport(env, admin)) fail(403, 'SUPPORT_NOT_AUTHORIZED');
 const settings = getSettings(db);
 const profile = getProfile(db, tenantId);
 if (!profile) fail(404, 'Customer not found');
 const why = clean(reason, 500);
 if (why.length < 10) fail(400, 'a reason of at least 10 characters is required');
 const ticketRef = clean(ticket || '', 60) || null;
 if (settings.support_ticket_required && !ticketRef) fail(400, 'a support ticket number is required');
 if (!SUPPORT_LEVELS.includes(level)) fail(400, `level must be one of ${SUPPORT_LEVELS.join(', ')}`);
 if (!Number.isInteger(minutes) || minutes < 5 || minutes > settings.support_max_minutes) fail(400, `minutes must be between 5 and ${settings.support_max_minutes}`);
 const result = tx(db, () => {
  expireSupportSessions(db);
  if (db.prepare("SELECT 1 FROM client_support_sessions WHERE admin_user_id=? AND status='active'").get(admin.id)) fail(409, 'SUPPORT_SESSION_ACTIVE');
  const token = newToken(), id = newId(), t = now(), expires = new Date(Date.now() + minutes * 60000).toISOString();
  db.prepare('INSERT INTO client_support_sessions (id,tenant_id,admin_user_id,admin_name,access_level,reason,ticket,status,token_hash,started_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, tenantId, admin.id, admin.name, level, why, ticketRef, 'active', sha(token), t, expires);
  db.prepare("INSERT INTO client_support_events (id,session_id,tenant_id,kind,detail,created_at) VALUES (?,?,?,'started',?,?)").run(newId(), id, tenantId, `${level} for ${minutes} min`, t);
  audit(db, {tenantId, actor: {id: admin.id, name: admin.name, kind: 'admin', supportSessionId: id}, action: 'SUPPORT_SESSION_STARTED', entityType: 'support_session', entityId: id, reason: why, detail: {level, minutes, ticket: ticketRef}});
  if (settings.support_notify_customer) notifyMembers(db, tenantId, 'support_started', {level, admin: admin.name, expiresAt: expires}, 'settings.manage');
  return {token, session: hydrate(db.prepare('SELECT * FROM client_support_sessions WHERE id=?').get(id))};
 });
 if (settings.support_notify_customer) mailOwner(db, env, tenantId, `Frost support started a session on your workspace (${level}). Reason: ${why}`, `بدأ فريق دعم Frost جلسة على مساحة عملك (${level}). السبب: ${why}`);
 return result;
}

export function endSupportSession(db, env, id, byUser, {revoked = false, reason = null} = {}) {
 const row = db.prepare('SELECT * FROM client_support_sessions WHERE id=?').get(id);
 if (!row) fail(404, 'Support session not found');
 if (row.status !== 'active') return hydrate(row);
 if (!revoked && row.admin_user_id !== byUser.id) fail(403, 'only the admin who started the session can end it (use revoke)');
 if (revoked && !isPlatformAdmin(env, byUser)) fail(403, 'SUPPORT_NOT_AUTHORIZED');
 const status = revoked ? 'revoked' : 'ended';
 tx(db, () => {
  const t = now();
  db.prepare('UPDATE client_support_sessions SET status=?,ended_at=?,ended_by=?,end_reason=? WHERE id=?').run(status, t, byUser.id, clean(reason || '', 300) || null, id);
  db.prepare("INSERT INTO client_support_events (id,session_id,tenant_id,kind,detail,created_at) VALUES (?,?,?,?,?,?)").run(newId(), id, row.tenant_id, status, clean(reason || '', 300) || null, t);
  audit(db, {tenantId: row.tenant_id, actor: {id: byUser.id, name: byUser.name, kind: 'admin', supportSessionId: id}, action: revoked ? 'SUPPORT_SESSION_REVOKED' : 'SUPPORT_SESSION_ENDED', entityType: 'support_session', entityId: id, reason});
  if (getSettings(db).support_notify_customer) notifyMembers(db, row.tenant_id, 'support_ended', {admin: row.admin_name, revoked}, 'settings.manage');
 });
 return hydrate(db.prepare('SELECT * FROM client_support_sessions WHERE id=?').get(id));
}
/** Marks sessions past their expiry as expired (idempotent). */
export function expireSupportSessions(db, at = Date.now()) {
 let n = 0;
 for (const s of db.prepare("SELECT * FROM client_support_sessions WHERE status='active' AND expires_at<=?").all(new Date(at).toISOString())) {
  tx(db, () => {
   db.prepare("UPDATE client_support_sessions SET status='expired',ended_at=?,end_reason='expired' WHERE id=?").run(now(), s.id);
   db.prepare("INSERT INTO client_support_events (id,session_id,tenant_id,kind,detail,created_at) VALUES (?,?,?,'expired',NULL,?)").run(newId(), s.id, s.tenant_id, now());
   audit(db, {tenantId: s.tenant_id, actor: {id: s.admin_user_id, name: s.admin_name, kind: 'admin', supportSessionId: s.id}, action: 'SUPPORT_SESSION_EXPIRED', entityType: 'support_session', entityId: s.id});
   if (getSettings(db).support_notify_customer) notifyMembers(db, s.tenant_id, 'support_ended', {admin: s.admin_name, expired: true}, 'settings.manage');
  });
  n++;
 }
 return n;
}
/** The active session behind a support token, only if it belongs to THIS signed-in platform admin. */
export function validateSupportToken(db, env, token, sessionUser) {
 if (!token || !sessionUser) return null;
 const row = db.prepare('SELECT * FROM client_support_sessions WHERE token_hash=?').get(sha(token));
 if (!row || row.admin_user_id !== sessionUser.id) return null;
 if (row.status === 'active' && Date.parse(row.expires_at) <= Date.now()) { expireSupportSessions(db); return null; }
 if (row.status !== 'active') return null;
 if (!canStartSupport(env, sessionUser)) return null; // authority is re-checked on every request
 return row;
}
export function logSupportEvent(db, session, {kind, method, path, detail = null}) {
 db.prepare('INSERT INTO client_support_events (id,session_id,tenant_id,kind,method,path,detail,created_at) VALUES (?,?,?,?,?,?,?,?)').run(newId(), session.id, session.tenant_id, kind, method || null, path ? String(path).slice(0, 300) : null, detail ? String(detail).slice(0, 300) : null, now());
}
export function listSupportSessions(db, {tenantId = null, limit = 50} = {}) {
 const rows = tenantId ? db.prepare('SELECT * FROM client_support_sessions WHERE tenant_id=? ORDER BY started_at DESC LIMIT ?').all(tenantId, limit) : db.prepare('SELECT s.*, p.business_name FROM client_support_sessions s LEFT JOIN client_profiles p ON p.tenant_id=s.tenant_id ORDER BY s.started_at DESC LIMIT ?').all(limit);
 return rows.map(r => ({...hydrate(r), businessName: r.business_name, actions: db.prepare("SELECT COUNT(*) n FROM client_audit_logs WHERE support_session_id=? AND action NOT LIKE 'SUPPORT_SESSION%'").get(r.id).n, pageViews: db.prepare("SELECT COUNT(*) n FROM client_support_events WHERE session_id=? AND kind='page_view'").get(r.id).n}));
}
export function supportSessionDetail(db, id, {tenantId = null} = {}) {
 const row = db.prepare('SELECT * FROM client_support_sessions WHERE id=?').get(id);
 if (!row || (tenantId && row.tenant_id !== tenantId)) fail(404, 'Support session not found');
 return {
  ...hydrate(row),
  events: db.prepare("SELECT kind,method,path,detail,created_at FROM client_support_events WHERE session_id=? AND kind!='read' ORDER BY created_at DESC LIMIT 300").all(id).map(e => ({kind: e.kind, method: e.method, path: e.path, detail: e.detail, at: e.created_at})),
  actions: db.prepare("SELECT action,entity_type,entity_id,reason,created_at FROM client_audit_logs WHERE support_session_id=? AND action NOT LIKE 'SUPPORT_SESSION%' ORDER BY created_at DESC LIMIT 300").all(id).map(a => ({action: a.action, entityType: a.entity_type, entityId: a.entity_id, reason: a.reason, at: a.created_at}))
 };
}
function mailOwner(db, env, tenantId, en, ar) {
 try {
  const owner = db.prepare("SELECT u.email, u.preferred_locale FROM client_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.workspace_role='workspace_owner' AND m.status='active' LIMIT 1").get(tenantId);
  if (owner?.email) sendSecurityNotice({db, env}, {to: owner.email, locale: owner.preferred_locale === 'en' ? 'en' : 'ar', message: owner.preferred_locale === 'en' ? en : ar}).catch(() => {});
 } catch { /* best effort */ }
}
