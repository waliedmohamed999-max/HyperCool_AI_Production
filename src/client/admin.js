import {fail} from '../auth.js';
import {AGENT_IDS, describeAgent} from './catalog.js';
import {PERMISSIONS, ROLE_PERMISSIONS, WORKSPACE_ROLES, audit, clean, hydrateAudit, newId, now, pageParams, paged, parseJson} from './core.js';
import {agentViews, platformAvailability} from './agents.js';
import {ALL_ENTITLEMENTS, effectiveState, getPlan, getProfile, listPlans, planCustomerCounts, resolveAccess, usageFor} from './plans.js';
import {listMembers} from './accounts.js';
import {integrationsView} from './views.js';
import {listSupportSessions} from './support.js';

// Platform-admin read models for the customers section of the main dashboard. Writes live in routes.js
// and call the same domain functions the merchant portal uses, with the admin as the audited actor.

const near = (used, limit) => limit !== null && limit !== undefined && limit > 0 && used / limit >= 0.8;

export function customerRow(db, p) {
 const state = effectiveState(db, p.tenant_id);
 const access = resolveAccess(db, p.tenant_id);
 const usage = usageFor(db, p.tenant_id);
 const owner = db.prepare('SELECT name, COALESCE(email,pending_email) email, last_login_at FROM users WHERE id=?').get(p.owner_user_id);
 const lastTask = db.prepare('SELECT MAX(created_at) at FROM client_tasks WHERE tenant_id=?').get(p.tenant_id).at;
 const lastAudit = db.prepare('SELECT MAX(created_at) at FROM client_audit_logs WHERE tenant_id=?').get(p.tenant_id).at;
 return {
  tenantId: p.tenant_id, businessName: p.business_name, ownerName: owner?.name, ownerEmail: owner?.email, country: p.country, businessType: p.business_type, status: state.status, storedStatus: p.account_status, workspaceStatus: p.workspace_status,
  plan: access?.plan ? {slug: access.plan.slug, nameAr: access.plan.nameAr, nameEn: access.plan.nameEn} : null, members: usage.users, agentsEnabled: AGENT_IDS.filter(id => access?.entitlements.includes(`agent.${id}`)).length,
  usage: {tasks: usage.tasks_per_month, tasksLimit: access?.limits.tasks_per_month ?? null, runs: usage.agent_runs_per_month, runsLimit: access?.limits.agent_runs_per_month ?? null},
  nearLimit: !!access && (near(usage.tasks_per_month, access.limits.tasks_per_month) || near(usage.agent_runs_per_month, access.limits.agent_runs_per_month) || near(usage.users, access.limits.users)),
  lastActivityAt: [lastTask, lastAudit, owner?.last_login_at].filter(Boolean).sort().at(-1) || null, createdAt: p.created_at, trialEndsAt: state.sub?.trial_ends_at || null, endsAt: state.sub?.ends_at || null
 };
}

export function listCustomers(db, url, {statusFixed = null} = {}) {
 const p = pageParams(url);
 const where = ['1=1'], args = [];
 const q = clean(url.searchParams.get('q') || '', 80).replace(/[\\%_]/g, m => '\\' + m);
 if (q) { where.push("(p.business_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')"); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
 const rows = db.prepare(`SELECT p.* FROM client_profiles p JOIN users u ON u.id=p.owner_user_id WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC`).all(...args).map(r => customerRow(db, r));
 const status = statusFixed || url.searchParams.get('status');
 const plan = url.searchParams.get('plan');
 const near80 = url.searchParams.get('nearLimit') === '1';
 let out = rows.filter(r => (!status || r.status === status) && (!plan || r.plan?.slug === plan) && (!near80 || r.nearLimit));
 const sort = url.searchParams.get('sort');
 const dir = url.searchParams.get('dir') === 'asc' ? 1 : -1;
 const keyOf = {name: r => r.businessName.toLowerCase(), created: r => r.createdAt, activity: r => r.lastActivityAt || '', usage: r => r.usage.tasks, members: r => r.members}[sort];
 if (keyOf) out = [...out].sort((a, b) => (keyOf(a) > keyOf(b) ? 1 : keyOf(a) < keyOf(b) ? -1 : 0) * dir);
 return paged(out.slice(p.offset, p.offset + p.limit), out.length, p);
}

export function adminOverview(db, env) {
 const rows = db.prepare('SELECT * FROM client_profiles').all().map(r => customerRow(db, r));
 const count = s => rows.filter(r => r.status === s).length;
 const since = new Date(Date.now() - 30 * 86400000).toISOString();
 const one = (sql, ...a) => db.prepare(sql).get(...a).n;
 const clientTenants = "tenant_id IN (SELECT tenant_id FROM client_profiles)";
 return {
  customers: {total: rows.length, active: count('active'), trial: count('trial'), limited: count('limited') + count('past_due'), suspended: count('suspended'), pending: count('pending'), cancelled: count('cancelled') + count('archived')},
  workspaces: {total: rows.length, onboarding: rows.filter(r => r.workspaceStatus === 'onboarding').length, ready: rows.filter(r => r.workspaceStatus === 'ready').length, restricted: rows.filter(r => r.workspaceStatus === 'restricted').length},
  tasks: {running: one(`SELECT COUNT(*) n FROM client_tasks WHERE status IN ('running','queued')`), failed30: one("SELECT COUNT(*) n FROM client_tasks WHERE status='failed' AND created_at>=?", since), completed30: one("SELECT COUNT(*) n FROM client_tasks WHERE status='completed' AND completed_at>=?", since)},
  approvalsPending: one(`SELECT COUNT(*) n FROM agent_approvals WHERE status='PENDING' AND ${clientTenants}`),
  integrationsBroken: one(`SELECT COUNT(*) n FROM integration_connections WHERE status IN ('ERROR','TOKEN_EXPIRED','DEGRADED','PERMISSION_MISSING') AND ${clientTenants}`),
  topAgents: db.prepare(`SELECT agent_id, COUNT(*) runs, SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) failed FROM agent_runs WHERE status!='CANCELLED' AND started_at>=? AND ${clientTenants} GROUP BY agent_id ORDER BY runs DESC LIMIT 6`).all(since).map(r => ({agentId: r.agent_id, runs: r.runs, failed: r.failed || 0})),
  nearLimit: rows.filter(r => r.nearLimit).slice(0, 8).map(r => ({tenantId: r.tenantId, businessName: r.businessName, usage: r.usage})),
  activeSupportSessions: one("SELECT COUNT(*) n FROM client_support_sessions WHERE status='active'"),
  plans: listPlans(db).length
 };
}

export function customerDetail(db, env, tenantId) {
 const profile = getProfile(db, tenantId);
 if (!profile) fail(404, 'Customer not found');
 const access = resolveAccess(db, tenantId);
 const owner = db.prepare('SELECT id,name,username,COALESCE(email,pending_email) email,email_verified_at,last_login_at FROM users WHERE id=?').get(profile.owner_user_id);
 const views = agentViews(db, env, tenantId);
 return {
  row: customerRow(db, profile),
  profile: {businessName: profile.business_name, phone: profile.phone, country: profile.country, businessType: profile.business_type, businessSize: profile.business_size, storeUrl: profile.store_url, ecommercePlatform: profile.ecommerce_platform, teamSize: profile.team_size, goals: parseJson(profile.goals_json, []), termsVersion: profile.terms_version, termsAcceptedAt: profile.terms_accepted_at, statusReason: profile.status_reason, graceUntil: profile.grace_until, createdAt: profile.created_at},
  owner: owner && {id: owner.id, name: owner.name, username: owner.username, email: owner.email, emailVerified: !!owner.email_verified_at, lastLoginAt: owner.last_login_at},
  subscription: {state: access.state.status, expired: access.state.expired, plan: access.plan, trialEndsAt: access.state.sub?.trial_ends_at || null, endsAt: access.state.sub?.ends_at || null, graceUntil: access.state.sub?.grace_until || null,
   history: db.prepare('SELECT s.*, p.slug FROM client_subscriptions s JOIN client_plans p ON p.id=s.plan_id WHERE s.tenant_id=? ORDER BY s.started_at DESC').all(tenantId).map(s => ({plan: s.slug, status: s.status, startedAt: s.started_at, trialEndsAt: s.trial_ends_at, endsAt: s.ends_at, source: s.source}))},
  access: {entitlements: access.entitlements, limits: access.limits, overrides: access.overrides, usage: usageFor(db, tenantId)},
  agents: views.map(a => ({key: a.key, nameAr: a.nameAr, nameEn: a.nameEn, status: a.status, usable: a.usable, lockedReason: a.lockedReason, adminState: a.adminState, adminNote: a.adminNote, approvalLevel: a.approvalLevel, usageLimitMonthly: a.usageLimitMonthly, usageThisMonth: a.usageThisMonth, allowedActions: a.allowedActions, blockedActions: a.blockedActions, riskLevel: a.riskLevel, supportedActions: a.supportedActions, health: a.health, reasons: a.reasons})),
  team: listMembers(db, tenantId),
  integrations: integrationsView(db, tenantId).filter(i => i.connection).map(i => ({slug: i.slug, nameEn: i.nameEn, nameAr: i.nameAr, connection: i.connection})),
  tasks: {byStatus: Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM client_tasks WHERE tenant_id=? GROUP BY status').all(tenantId).map(r => [r.status, r.n])),
   recent: db.prepare('SELECT id,title,agent_id,status,error,created_at FROM client_tasks WHERE tenant_id=? ORDER BY created_at DESC, rowid DESC LIMIT 10').all(tenantId).map(r => ({id: r.id, title: r.title, agentId: r.agent_id, status: r.status, error: r.error, createdAt: r.created_at}))},
  approvals: db.prepare('SELECT id,agent_id,action_type,risk_level,status,created_at FROM agent_approvals WHERE tenant_id=? ORDER BY created_at DESC LIMIT 10').all(tenantId).map(r => ({id: r.id, agentId: r.agent_id, actionType: r.action_type, riskLevel: r.risk_level, status: r.status, createdAt: r.created_at})),
  errors: db.prepare("SELECT id,agent_id,error,started_at FROM agent_runs WHERE tenant_id=? AND status='FAILED' ORDER BY started_at DESC LIMIT 10").all(tenantId).map(r => ({runId: r.id, agentId: r.agent_id, error: r.error, at: r.started_at})),
  notifications: db.prepare('SELECT kind,params_json,created_at FROM client_notifications WHERE tenant_id=? ORDER BY created_at DESC LIMIT 10').all(tenantId).map(r => ({kind: r.kind, params: parseJson(r.params_json, {}), at: r.created_at})),
  audit: db.prepare('SELECT * FROM client_audit_logs WHERE tenant_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(tenantId).map(hydrateAudit),
  supportSessions: listSupportSessions(db, {tenantId, limit: 20}),
  notes: db.prepare('SELECT id,author_name,note,created_at FROM client_admin_notes WHERE tenant_id=? ORDER BY created_at DESC').all(tenantId).map(n => ({id: n.id, authorName: n.author_name, note: n.note, createdAt: n.created_at}))
 };
}
export function addCustomerNote(db, actor, tenantId, note) {
 if (!getProfile(db, tenantId)) fail(404, 'Customer not found');
 const text = String(note || '').trim().slice(0, 2000);
 if (!text) fail(400, 'note is required');
 const id = newId();
 db.prepare('INSERT INTO client_admin_notes (id,tenant_id,author_id,author_name,note,created_at) VALUES (?,?,?,?,?,?)').run(id, tenantId, actor.id, actor.name, text, now());
 audit(db, {tenantId, actor: {...actor, kind: 'admin'}, action: 'CLIENT_ADMIN_NOTE_ADDED', entityType: 'note', entityId: id});
 return {id, note: text};
}

/** Cross-workspace usage table for the Usage tab. */
export function usageTable(db, url) {
 const p = pageParams(url);
 const rows = db.prepare('SELECT * FROM client_profiles ORDER BY business_name').all().map(r => {
  const c = customerRow(db, r);
  const tokens = db.prepare("SELECT COALESCE(SUM(tokens_input+tokens_output),0) t, COALESCE(SUM(estimated_cost),0) cost FROM agent_runs WHERE tenant_id=? AND status!='CANCELLED' AND started_at>=?").get(r.tenant_id, new Date(Date.now() - 30 * 86400000).toISOString());
  return {tenantId: c.tenantId, businessName: c.businessName, plan: c.plan, status: c.status, usage: c.usage, members: c.members, tokens30: tokens.t, cost30: tokens.cost, nearLimit: c.nearLimit};
 });
 return paged(rows.slice(p.offset, p.offset + p.limit), rows.length, p);
}
/** Integration health across all merchant workspaces (broken first). */
export function integrationsTable(db, url) {
 const p = pageParams(url);
 const rows = db.prepare(`SELECT c.id, c.tenant_id, c.name, c.status, c.integration_definition_id, c.last_health_check, c.last_error_message_safe, p.business_name FROM integration_connections c JOIN client_profiles p ON p.tenant_id=c.tenant_id WHERE c.status!='DISCONNECTED' ORDER BY CASE c.status WHEN 'CONNECTED' THEN 1 ELSE 0 END, p.business_name`).all();
 return paged(rows.slice(p.offset, p.offset + p.limit).map(r => ({id: r.id, tenantId: r.tenant_id, businessName: r.business_name, provider: r.integration_definition_id, name: r.name, status: r.status, lastHealthCheck: r.last_health_check, lastError: r.last_error_message_safe})), rows.length, p);
}
export function agentsAdminView(db) {
 const platform = platformAvailability(db);
 const since = new Date(Date.now() - 30 * 86400000).toISOString();
 return AGENT_IDS.map(id => {
  const stats = db.prepare("SELECT COUNT(*) runs, SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) failed, COUNT(DISTINCT tenant_id) workspaces FROM agent_runs WHERE agent_id=? AND status!='CANCELLED' AND started_at>=? AND tenant_id IN (SELECT tenant_id FROM client_profiles)").get(id, since);
  return {...describeAgent(id), platform: platform[id], runs30: stats.runs, failed30: stats.failed || 0, workspaces30: stats.workspaces};
 });
}
export function globalAudit(db, url) {
 const p = pageParams(url);
 const where = ['1=1'], args = [];
 const tenant = url.searchParams.get('tenantId');
 if (tenant) { where.push('tenant_id=?'); args.push(tenant); }
 const action = url.searchParams.get('action');
 if (action) { where.push('action LIKE ?'); args.push(`${String(action).replace(/[%_]/g, '')}%`); }
 if (url.searchParams.get('support') === '1') where.push('support_session_id IS NOT NULL');
 const total = db.prepare(`SELECT COUNT(*) n FROM client_audit_logs WHERE ${where.join(' AND ')}`).get(...args).n;
 const rows = db.prepare(`SELECT a.*, p.business_name FROM client_audit_logs a LEFT JOIN client_profiles p ON p.tenant_id=a.tenant_id WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ? OFFSET ?`).all(...args, p.limit, p.offset);
 return paged(rows.map(r => ({...hydrateAudit(r), businessName: r.business_name})), total, p);
}
export const permissionsCatalog = () => ({roles: WORKSPACE_ROLES.map(r => ({role: r, permissions: ROLE_PERMISSIONS[r]})), permissions: PERMISSIONS, entitlements: ALL_ENTITLEMENTS});
export {getPlan, planCustomerCounts};
