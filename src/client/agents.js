import {fail} from '../auth.js';
import {getTenantAgentConfig, updateTenantAgentConfig} from '../runtime/agent-config.js';
import {evaluateAgentReadiness} from '../runtime/agent-readiness.js';
import {AGENT_IDS, RISK_ORDER, describeAgent, isCatalogAgent, listCatalog} from './catalog.js';
import {AUTONOMY_LEVELS, audit, clean, cleanMultiline, now, parseJson, tx} from './core.js';
import {agentRunsThisMonth, effectiveState, getProfile, hasEntitlement, isOperational, resolveAccess} from './plans.js';

// Seven authorization layers decide whether an agent may work for a workspace. They are evaluated
// in this order and the FIRST failing layer names the reason (shown to the merchant and returned by
// the API); an agent is usable only when every layer passes:
//   1 platform availability  2 admin (tenant) override  3 plan entitlement  4 account state
//   5 integration/AI readiness  6 usage limit  7 approval policy (applied per task in tasks.js)
// (the workspace-role permission layer is applied by the routes, per user.)

export const getPlatformRow = (db, agentId) => db.prepare('SELECT * FROM client_agent_platform WHERE agent_id=?').get(agentId) || null;
export const getSettingsRow = (db, tenantId, agentId) => db.prepare('SELECT * FROM client_agent_settings WHERE tenant_id=? AND agent_id=?').get(tenantId, agentId) || null;

export function platformAvailability(db) {
 const out = {};
 for (const id of AGENT_IDS) { const r = getPlatformRow(db, id); out[id] = {available: r ? !!r.available : true, allowedPlans: r?.allowed_plans_json ? parseJson(r.allowed_plans_json, null) : null, note: r?.note || null}; }
 return out;
}
export function setPlatformAvailability(db, actor, agentId, {available, allowedPlans = null, note = null}, reason) {
 if (!isCatalogAgent(agentId)) fail(404, 'Unknown agent');
 if (!clean(reason, 300)) fail(400, 'a reason is required');
 if (allowedPlans !== null && (!Array.isArray(allowedPlans) || allowedPlans.some(s => typeof s !== 'string'))) fail(400, 'allowedPlans must be a list of plan slugs');
 tx(db, () => {
  db.prepare('INSERT INTO client_agent_platform (agent_id,available,allowed_plans_json,note,updated_by,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET available=excluded.available,allowed_plans_json=excluded.allowed_plans_json,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at')
   .run(agentId, available ? 1 : 0, allowedPlans && allowedPlans.length ? JSON.stringify(allowedPlans) : null, clean(note, 300) || null, actor?.id || null, now());
  audit(db, {tenantId: null, actor, action: 'CLIENT_AGENT_PLATFORM_CHANGED', entityType: 'agent', entityId: agentId, reason, detail: {available, allowedPlans}});
 });
}

/** Admin per-workspace control: state, allowed/blocked actions, approval level, monthly limit, note. */
export function setAgentAdminControl(db, actor, tenantId, agentId, patch, reason) {
 if (!isCatalogAgent(agentId)) fail(404, 'Unknown agent');
 if (!clean(reason, 300)) fail(400, 'a reason is required');
 const cur = getSettingsRow(db, tenantId, agentId);
 const next = {
  admin_state: patch.adminState ?? cur?.admin_state ?? 'default',
  approval_level: patch.approvalLevel === undefined ? cur?.admin_approval_level ?? null : patch.approvalLevel,
  allowed: patch.allowedActions === undefined ? cur?.allowed_actions_json ?? null : (Array.isArray(patch.allowedActions) && patch.allowedActions.length ? JSON.stringify(patch.allowedActions) : null),
  blocked: patch.blockedActions === undefined ? cur?.blocked_actions_json ?? null : (Array.isArray(patch.blockedActions) && patch.blockedActions.length ? JSON.stringify(patch.blockedActions) : null),
  limit: patch.usageLimitMonthly === undefined ? cur?.usage_limit_monthly ?? null : patch.usageLimitMonthly,
  note: patch.adminNote === undefined ? cur?.admin_note ?? null : clean(patch.adminNote, 300) || null
 };
 if (!['default', 'enabled', 'disabled'].includes(next.admin_state)) fail(400, 'adminState must be default, enabled or disabled');
 if (next.approval_level !== null && !AUTONOMY_LEVELS.includes(next.approval_level)) fail(400, 'invalid approval level');
 if (next.limit !== null && (!Number.isInteger(next.limit) || next.limit < 0)) fail(400, 'usageLimitMonthly must be a non-negative integer or null');
 tx(db, () => {
  db.prepare(`INSERT INTO client_agent_settings (tenant_id,agent_id,admin_state,admin_approval_level,allowed_actions_json,blocked_actions_json,usage_limit_monthly,admin_note,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(tenant_id,agent_id) DO UPDATE SET admin_state=excluded.admin_state,admin_approval_level=excluded.admin_approval_level,allowed_actions_json=excluded.allowed_actions_json,blocked_actions_json=excluded.blocked_actions_json,usage_limit_monthly=excluded.usage_limit_monthly,admin_note=excluded.admin_note,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
   .run(tenantId, agentId, next.admin_state, next.approval_level, next.allowed, next.blocked, next.limit, next.note, actor?.id || null, now());
  syncAgentConfigs(db, tenantId);
  audit(db, {tenantId, actor, action: 'CLIENT_AGENT_ADMIN_CONTROL', entityType: 'agent', entityId: agentId, reason, detail: patch});
 });
}
/** Merchant-side settings: pause/resume and configuration that only narrows behaviour. */
export function setAgentClientSettings(db, actor, tenantId, agentId, patch) {
 if (!isCatalogAgent(agentId)) fail(404, 'Unknown agent');
 const cur = getSettingsRow(db, tenantId, agentId);
 const paused = patch.paused === undefined ? !!cur?.client_paused : !!patch.paused;
 const settings = patch.settings === undefined ? parseJson(cur?.settings_json, {}) : sanitizeAgentSettings(patch.settings);
 let approval = cur?.approval_level ?? null;
 if (patch.approvalLevel !== undefined) {
  if (!AUTONOMY_LEVELS.includes(patch.approvalLevel)) fail(400, 'invalid approval level');
  // Merchants may make an agent stricter or restore the default, never looser than the admin/plan baseline.
  const floor = adminApprovalFloor(db, tenantId, agentId);
  if (AUTONOMY_LEVELS.indexOf(patch.approvalLevel) > AUTONOMY_LEVELS.indexOf(floor)) fail(403, 'APPROVAL_LEVEL_TOO_LOOSE');
  approval = patch.approvalLevel;
 }
 tx(db, () => {
  db.prepare(`INSERT INTO client_agent_settings (tenant_id,agent_id,client_paused,approval_level,settings_json,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)
   ON CONFLICT(tenant_id,agent_id) DO UPDATE SET client_paused=excluded.client_paused,approval_level=excluded.approval_level,settings_json=excluded.settings_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
   .run(tenantId, agentId, paused ? 1 : 0, approval, JSON.stringify(settings), actor?.id || null, now());
  syncAgentConfigs(db, tenantId);
  audit(db, {tenantId, actor, action: paused ? 'CLIENT_AGENT_PAUSED' : 'CLIENT_AGENT_SETTINGS_CHANGED', entityType: 'agent', entityId: agentId, detail: {paused, approvalLevel: approval}});
 });
}
// Only a small, declared set of configuration keys is accepted (configuration_schema).
export const CONFIG_SCHEMA = {
 tone: {type: 'enum', values: ['formal', 'friendly', 'professional', 'playful']},
 language: {type: 'enum', values: ['ar', 'en', 'both']},
 brandNotes: {type: 'text', max: 1000},
 maxItemsPerRun: {type: 'int', min: 1, max: 50}
};
function sanitizeAgentSettings(input) {
 const out = {};
 for (const [k, spec] of Object.entries(CONFIG_SCHEMA)) {
  const v = input?.[k];
  if (v === undefined || v === null || v === '') continue;
  if (spec.type === 'enum') { if (!spec.values.includes(v)) fail(400, `invalid ${k}`); out[k] = v; }
  else if (spec.type === 'text') out[k] = cleanMultiline(String(v), spec.max);
  else if (spec.type === 'int') { if (!Number.isInteger(v) || v < spec.min || v > spec.max) fail(400, `invalid ${k}`); out[k] = v; }
 }
 return out;
}
/** The loosest level the merchant may pick: the admin's forced level, else the catalog default for the agent. */
export function adminApprovalFloor(db, tenantId, agentId) {
 const row = getSettingsRow(db, tenantId, agentId);
 return row?.admin_approval_level || catalogDefaultApproval(agentId);
}
const catalogDefaultApproval = agentId => describeAgent(agentId)?.approvalPolicy || 'approval_required';

/** Effective approval level: the strictest of the merchant choice, the onboarding default (capped by the catalog) and any admin-forced level. */
export function effectiveApprovalLevel(db, tenantId, agentId) {
 const row = getSettingsRow(db, tenantId, agentId);
 const onboarding = db.prepare('SELECT default_autonomy FROM client_onboarding WHERE tenant_id=?').get(tenantId);
 const catalog = catalogDefaultApproval(agentId);
 const candidates = [catalog, onboarding?.default_autonomy, row?.approval_level, row?.admin_approval_level].filter(Boolean);
 return candidates.reduce((strict, level) => (AUTONOMY_LEVELS.indexOf(level) < AUTONOMY_LEVELS.indexOf(strict) ? level : strict));
}

/** Keeps the platform's own per-tenant agent config (used by the runtime) consistent with plan + admin + pause. */
export function syncAgentConfigs(db, tenantId) {
 const access = resolveAccess(db, tenantId);
 if (!access) return;
 const platform = platformAvailability(db);
 for (const id of AGENT_IDS) {
  const cfg = getTenantAgentConfig(db, tenantId, id);
  if (!cfg) continue;
  const row = getSettingsRow(db, tenantId, id);
  const allowed = platform[id].available && (row?.admin_state === 'enabled' || (row?.admin_state !== 'disabled' && hasEntitlement(access, `agent.${id}`) && planAllowed(platform[id], access)));
  const enabled = !!allowed && !row?.client_paused;
  if (!!cfg.enabled !== enabled) updateTenantAgentConfig(db, tenantId, id, {enabled});
 }
}
const planAllowed = (platformRow, access) => !platformRow.allowedPlans || (access.plan && platformRow.allowedPlans.includes(access.plan.slug));

/**
 * Layers 1-6 for one agent in one workspace. Returns {usable, layer, reason}.
 * `access` may be passed to avoid recomputation.
 */
export function agentAccess(db, env, tenantId, agentId, access = resolveAccess(db, tenantId)) {
 if (!access) return {usable: true, layer: null, reason: null};
 const platform = platformAvailability(db)[agentId] || {available: true, allowedPlans: null};
 const row = getSettingsRow(db, tenantId, agentId);
 if (!platform.available) return {usable: false, layer: 'platform', reason: 'AGENT_UNAVAILABLE_PLATFORM', status: 'unavailable'};
 if (row?.admin_state === 'disabled') return {usable: false, layer: 'admin', reason: 'AGENT_DISABLED_BY_ADMIN', status: 'disabled_by_admin'};
 const forced = row?.admin_state === 'enabled';
 if (!forced && (!hasEntitlement(access, `agent.${agentId}`) || !planAllowed(platform, access))) return {usable: false, layer: 'plan', reason: 'AGENT_LOCKED_BY_PLAN', status: 'locked_by_plan'};
 const state = access.state;
 if (!isOperational(state)) return {usable: false, layer: 'account', reason: `CLIENT_${state.status.toUpperCase()}`, status: 'unavailable'};
 if (getProfile(db, tenantId)?.workspace_status === 'onboarding') return {usable: false, layer: 'onboarding', reason: 'ONBOARDING_INCOMPLETE', status: 'setup_required'};
 const cap = row?.usage_limit_monthly;
 if (cap !== null && cap !== undefined && agentRunsThisMonth(db, tenantId, agentId) >= cap) return {usable: false, layer: 'usage', reason: 'AGENT_USAGE_LIMIT', status: 'unavailable'};
 const limit = access.limits.agent_runs_per_month;
 if (limit !== null && limit !== undefined) {
  const used = db.prepare("SELECT COUNT(*) n FROM agent_runs WHERE tenant_id=? AND status!='CANCELLED' AND started_at>=?").get(tenantId, monthStartIso()).n;
  if (used >= limit) return {usable: false, layer: 'usage', reason: 'RUN_LIMIT_REACHED', status: 'unavailable'};
 }
 return {usable: true, layer: null, reason: null, forced};
}
const monthStartIso = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };

/** Full merchant-facing view of one agent: static description + real state. */
export function agentView(db, env, tenantId, agentId, access = resolveAccess(db, tenantId)) {
 const base = describeAgent(agentId);
 if (!base) return null;
 const gate = agentAccess(db, env, tenantId, agentId, access);
 const row = getSettingsRow(db, tenantId, agentId);
 const cfg = getTenantAgentConfig(db, tenantId, agentId);
 const readiness = evaluateAgentReadiness(db, env, {tenantId, agentId});
 const missingTools = readiness.blockers.filter(b => b.startsWith('REQUIRED_TOOL_')).map(b => b.split(':')[1]);
 const aiMissing = readiness.blockers.includes('AI_NOT_CONFIGURED') || readiness.blockers.some(b => /^AI_/.test(b));
 const recent = db.prepare("SELECT status FROM agent_runs WHERE tenant_id=? AND agent_id=? AND status!='CANCELLED' ORDER BY started_at DESC LIMIT 5").all(tenantId, agentId).map(r => r.status);
 const running = db.prepare("SELECT COUNT(*) n FROM client_tasks WHERE tenant_id=? AND agent_id=? AND status='running'").get(tenantId, agentId).n;
 const lastRun = db.prepare('SELECT id,status,started_at,finished_at,error FROM agent_runs WHERE tenant_id=? AND agent_id=? ORDER BY started_at DESC LIMIT 1').get(tenantId, agentId) || null;
 let status = gate.status;
 if (gate.usable) {
  if (aiMissing) status = 'unavailable';
  else if (missingTools.length || (readiness.status === 'BLOCKED' && !aiMissing)) status = 'setup_required';
  else if (row?.client_paused || (cfg && !cfg.enabled)) status = 'paused';
  else if (running > 0) status = 'running';
  else if (recent.length >= 3 && recent.filter(s => s === 'FAILED').length >= 3) status = 'degraded';
  else status = readiness.optional_missing.length < base.optionalTools.length && base.optionalTools.length ? 'connected' : 'available';
 }
 const runs30 = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) failed, COALESCE(SUM(tokens_input+tokens_output),0) tokens FROM agent_runs WHERE tenant_id=? AND agent_id=? AND status!='CANCELLED' AND started_at>=?").get(tenantId, agentId, new Date(Date.now() - 30 * 86400000).toISOString());
 return {
  ...base, status, usable: gate.usable, lockedLayer: gate.layer, lockedReason: gate.reason,
  reasons: [aiMissing ? 'AI_NOT_CONFIGURED' : null, ...missingTools.map(t => `REQUIRED_TOOL:${t}`), gate.reason].filter(Boolean),
  paused: !!row?.client_paused, adminState: row?.admin_state || 'default', adminNote: row?.admin_note || null,
  approvalLevel: effectiveApprovalLevel(db, tenantId, agentId), approvalFloor: adminApprovalFloor(db, tenantId, agentId), allowedActions: parseJson(row?.allowed_actions_json, null), blockedActions: parseJson(row?.blocked_actions_json, null),
  usageLimitMonthly: row?.usage_limit_monthly ?? null, usageThisMonth: agentRunsThisMonth(db, tenantId, agentId), settings: parseJson(row?.settings_json, {}),
  readiness: {status: readiness.status, blockers: readiness.blockers, optionalMissing: readiness.optional_missing},
  health: {recentRuns: recent, running, runs30: runs30.n, failed30: runs30.failed || 0, tokens30: runs30.tokens, lastRun}
 };
}
export function agentViews(db, env, tenantId) {
 const access = resolveAccess(db, tenantId);
 return AGENT_IDS.map(id => agentView(db, env, tenantId, id, access));
}

/** Hook handed to the agent runtime so the plan/admin layers hold even for direct /api/agents/:id/run calls. */
export function makeRunGate(db, env) {
 return (tenantId, agentId) => {
  const access = resolveAccess(db, tenantId);
  if (!access) return null; // a workspace without a client account (legacy tenant) is not restricted here
  if (!isCatalogAgent(agentId)) return isOperational(access.state) ? null : `CLIENT_${access.state.status.toUpperCase()}`;
  const gate = agentAccess(db, env, tenantId, agentId, access);
  return gate.usable ? null : gate.reason;
 };
}
export {effectiveState, listCatalog};
