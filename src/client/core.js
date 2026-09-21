import {randomBytes, createHash} from 'node:crypto';
import {fail} from '../auth.js';
import {newId, now, tx, clean, cleanMultiline, isEmail, pageParams, paged} from '../partners/core.js';

// Frost Client Portal (merchants / tenants) - shared constants and helpers.
// This layer sits ON TOP of the existing multi-tenant foundation (tenants, tenant_memberships,
// agent_registry, tenant_agent_configs, agent_runs, agent_approvals, integration_connections,
// audit_logs). It adds the merchant-facing product concepts (plans, entitlements, limits, workspace
// roles, tasks, notifications, support sessions) and never duplicates those foundations.

export {newId, now, tx, clean, cleanMultiline, isEmail, pageParams, paged};
export const sha = value => createHash('sha256').update(String(value)).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');

export const ACCOUNT_STATUSES = ['pending', 'trial', 'active', 'limited', 'past_due', 'suspended', 'cancelled', 'archived'];
export const WORKSPACE_STATUSES = ['onboarding', 'ready', 'restricted', 'suspended', 'archived'];
export const OPERATIONAL_STATUSES = ['trial', 'active', 'past_due'];
export const READABLE_STATUSES = ['trial', 'active', 'past_due', 'limited'];
export const PLAN_TYPES = ['standard', 'partner', 'merchant'];
export const AUTONOMY_LEVELS = ['manual', 'approval_required', 'limited_autonomy'];
export const RISK_LEVELS = ['low', 'medium', 'high'];
export const TASK_STATUSES = ['draft', 'queued', 'waiting_for_integration', 'waiting_for_approval', 'running', 'completed', 'failed', 'cancelled', 'paused'];
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const AGENT_STATUSES = ['available', 'setup_required', 'connected', 'running', 'paused', 'degraded', 'unavailable', 'disabled_by_admin', 'locked_by_plan'];

export const CLIENT_ENTITLEMENTS = ['client.dashboard', 'client.analytics', 'client.integrations', 'client.team', 'client.workflows', 'client.approvals', 'client.export'];
export const BILLING_PERIODS = ['free', 'monthly', 'yearly', 'one_time'];
export const LIMIT_KEYS = ['users', 'integrations', 'workflows', 'tasks_per_month', 'agent_runs_per_month'];

// ---- workspace roles ----------------------------------------------------------------------------------------------
export const PERMISSIONS = ['agents.view', 'agents.configure', 'agents.run', 'tasks.create', 'tasks.cancel', 'approvals.review', 'integrations.manage', 'team.manage', 'analytics.view', 'billing.manage', 'settings.manage', 'audit.view'];
export const WORKSPACE_ROLES = ['workspace_owner', 'workspace_admin', 'manager', 'operator', 'analyst', 'viewer'];
export const ROLE_PERMISSIONS = {
 workspace_owner: [...PERMISSIONS],
 workspace_admin: PERMISSIONS.filter(p => p !== 'billing.manage'),
 manager: ['agents.view', 'agents.configure', 'agents.run', 'tasks.create', 'tasks.cancel', 'approvals.review', 'integrations.manage', 'analytics.view', 'audit.view'],
 operator: ['agents.view', 'agents.run', 'tasks.create', 'tasks.cancel', 'analytics.view'],
 analyst: ['agents.view', 'analytics.view', 'audit.view'],
 viewer: ['agents.view', 'analytics.view']
};
// The existing routes authorize on users.role (owner/reviewer/operator). Portal roles map onto the
// least-privileged legacy value that still lets the person exist in tenant_memberships.
export const LEGACY_ROLE = {workspace_owner: 'owner', workspace_admin: 'operator', manager: 'operator', operator: 'operator', analyst: 'reviewer', viewer: 'reviewer'};

export const SUPPORT_LEVELS = ['view_only', 'limited', 'extended'];
export const SUPPORT_LEVEL_ROLE = {view_only: 'viewer', limited: 'manager', extended: 'workspace_admin'};

export const DEFAULT_SETTINGS = {
 registration_mode: 'open',
 default_plan_slug: 'starter',
 support_ticket_required: false,
 support_notify_customer: true,
 support_max_minutes: 120,
 terms_version: '1',
 terms_ar: '',
 terms_en: '',
 privacy_ar: '',
 privacy_en: ''
};

export function getSettings(db) {
 const settings = {...DEFAULT_SETTINGS};
 for (const row of db.prepare('SELECT key,value_json FROM client_settings').all()) {
  try { settings[row.key] = JSON.parse(row.value_json); } catch { /* keep default */ }
 }
 return settings;
}
export function saveSettings(db, actor, patch) {
 const ok = {
  registration_mode: v => ['open', 'approval'].includes(v), default_plan_slug: v => typeof v === 'string' && /^[a-z0-9_-]{2,40}$/.test(v),
  support_ticket_required: v => typeof v === 'boolean', support_notify_customer: v => typeof v === 'boolean',
  support_max_minutes: v => Number.isInteger(v) && v >= 5 && v <= 480, terms_version: v => typeof v === 'string' && v.length >= 1 && v.length <= 20,
  terms_ar: v => typeof v === 'string' && v.length <= 20000, terms_en: v => typeof v === 'string' && v.length <= 20000,
  privacy_ar: v => typeof v === 'string' && v.length <= 20000, privacy_en: v => typeof v === 'string' && v.length <= 20000
 };
 tx(db, () => {
  for (const [key, value] of Object.entries(patch || {})) {
   if (!ok[key]) fail(400, `unknown setting: ${key}`);
   if (!ok[key](value)) fail(400, `invalid value for ${key}`);
   db.prepare('INSERT INTO client_settings (key,value_json,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by').run(key, JSON.stringify(value), now(), actor?.id || null);
  }
  audit(db, {tenantId: null, actor, action: 'CLIENT_SETTINGS_UPDATED', entityType: 'settings', detail: patch});
 });
 return getSettings(db);
}

// ---- audit (append-only, tenant scoped; carries support-session attribution) --------------------------------------
/**
 * actor = {id, name, kind: 'user'|'admin'|'admin_support'|'system', onBehalfOf?, supportSessionId?, reason?}
 * `admin_support` rows are the ones performed by a platform admin inside a support session.
 */
export function audit(db, {tenantId, actor, action, entityType = null, entityId = null, reason = null, detail = null}) {
 const support = actor?.kind === 'admin_support';
 db.prepare('INSERT INTO client_audit_logs (id,tenant_id,action,entity_type,entity_id,actor_id,actor_name,actor_kind,performed_by_admin,on_behalf_of_user,support_session_id,reason,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(newId(), tenantId || null, action, entityType, entityId, actor?.id || null, actor?.name || null, actor?.kind || 'system', support || actor?.kind === 'admin' ? actor.id : null, support ? actor.onBehalfOf || null : null, actor?.supportSessionId || null, reason || actor?.reason || null, detail === null || detail === undefined ? null : JSON.stringify(detail), now());
}
export function listAudit(db, tenantId, url) {
 const p = pageParams(url);
 const where = ['tenant_id=?'], args = [tenantId];
 const action = url.searchParams.get('action');
 if (action) { where.push('action LIKE ?'); args.push(`${String(action).replace(/[%_]/g, '')}%`); }
 const total = db.prepare(`SELECT COUNT(*) n FROM client_audit_logs WHERE ${where.join(' AND ')}`).get(...args).n;
 const rows = db.prepare(`SELECT * FROM client_audit_logs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...args, p.limit, p.offset);
 return paged(rows.map(hydrateAudit), total, p);
}
export const hydrateAudit = r => ({
 id: r.id, tenantId: r.tenant_id, action: r.action, entityType: r.entity_type, entityId: r.entity_id, actorName: r.actor_name, actorKind: r.actor_kind,
 performedByAdmin: r.performed_by_admin, onBehalfOfUser: r.on_behalf_of_user, supportSessionId: r.support_session_id, reason: r.reason,
 detail: r.detail_json ? JSON.parse(r.detail_json) : null, createdAt: r.created_at
});

// ---- notifications ----------------------------------------------------------------------------------------------------
export function notify(db, tenantId, kind, params = {}, userId = null) {
 db.prepare('INSERT INTO client_notifications (id,tenant_id,user_id,kind,params_json,created_at) VALUES (?,?,?,?,?,?)').run(newId(), tenantId, userId, kind, JSON.stringify(params), now());
}
/** Notify every active member holding `permission` (or all when null). */
export function notifyMembers(db, tenantId, kind, params = {}, permission = null) {
 for (const m of db.prepare("SELECT user_id, workspace_role FROM client_members WHERE tenant_id=? AND status='active'").all(tenantId)) {
  if (!permission || (ROLE_PERMISSIONS[m.workspace_role] || []).includes(permission)) notify(db, tenantId, kind, params, m.user_id);
 }
}

export const parseJson = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
