import {fail} from '../auth.js';
import {getTenant} from '../tenancy.js';
import {AGENT_IDS, agentEntitlements, isCatalogAgent} from './catalog.js';
import {BILLING_PERIODS, CLIENT_ENTITLEMENTS, LIMIT_KEYS, OPERATIONAL_STATUSES, PLAN_TYPES, READABLE_STATUSES, audit, clean, cleanMultiline, newId, notifyMembers, now, parseJson, tx} from './core.js';

// Merchant plans = the single source of truth for what a workspace may use. Entitlements
// (`client.*` features + `agent.<id>` per agent) and numeric limits are resolved in ONE place
// (`resolveAccess`) and enforced by routes, by the task engine and by the agent runtime hook.

export const ALL_ENTITLEMENTS = [...CLIENT_ENTITLEMENTS, ...agentEntitlements()];

const hydratePlan = row => row && ({
 id: row.id, slug: row.slug, planType: row.plan_type, nameAr: row.name_ar, nameEn: row.name_en, descriptionAr: row.description_ar, descriptionEn: row.description_en,
 priceMinor: row.price_minor, currency: row.currency, billingPeriod: row.billing_period, status: row.status, sortOrder: row.sort_order, highlighted: !!row.highlighted,
 trialDays: row.trial_days, supportLevel: row.support_level, entitlements: parseJson(row.entitlements_json, []), limits: parseJson(row.limits_json, {}),
 createdAt: row.created_at, updatedAt: row.updated_at
});
export const listPlans = (db, {publicOnly = false} = {}) => db.prepare(publicOnly ? "SELECT * FROM client_plans WHERE status='active' ORDER BY sort_order,created_at" : "SELECT * FROM client_plans WHERE status!='archived' ORDER BY sort_order,created_at").all().map(hydratePlan);
export const getPlan = (db, id) => { const p = hydratePlan(db.prepare('SELECT * FROM client_plans WHERE id=?').get(id)); if (!p) fail(404, 'Plan not found'); return p; };
export const getPlanBySlug = (db, slug) => hydratePlan(db.prepare('SELECT * FROM client_plans WHERE slug=?').get(slug));

function validatePlan(input, partial) {
 const out = {};
 const need = (k, ok) => { if (!partial && !ok) fail(400, `${k} is required`); };
 if (!partial || input.slug !== undefined) { need('slug', input.slug); if (input.slug !== undefined) { if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(String(input.slug))) fail(400, 'slug must be 2-40 lowercase letters, digits, - or _'); out.slug = input.slug; } }
 for (const k of ['nameAr', 'nameEn']) if (!partial || input[k] !== undefined) { const v = clean(input[k], 120); need(k, v); if (input[k] !== undefined) { if (!v) fail(400, `${k} is required`); out[k] = v; } }
 for (const k of ['descriptionAr', 'descriptionEn']) if (input[k] !== undefined) out[k] = cleanMultiline(input[k], 2000);
 if (input.planType !== undefined) { if (!PLAN_TYPES.includes(input.planType)) fail(400, 'planType is invalid'); out.planType = input.planType; }
 if (!partial || input.priceMinor !== undefined) { need('priceMinor', input.priceMinor !== undefined); if (input.priceMinor !== undefined) { if (!Number.isSafeInteger(input.priceMinor) || input.priceMinor < 0) fail(400, 'priceMinor is invalid'); out.priceMinor = input.priceMinor; } }
 if (input.currency !== undefined) { if (!/^[A-Z]{3}$/.test(input.currency)) fail(400, 'currency is invalid'); out.currency = input.currency; }
 if (input.billingPeriod !== undefined) { if (!BILLING_PERIODS.includes(input.billingPeriod)) fail(400, 'billingPeriod is invalid'); out.billingPeriod = input.billingPeriod; }
 if (input.status !== undefined) { if (!['active', 'inactive', 'archived'].includes(input.status)) fail(400, 'status is invalid'); out.status = input.status; }
 if (input.sortOrder !== undefined) out.sortOrder = Number.isInteger(input.sortOrder) ? input.sortOrder : 0;
 if (input.highlighted !== undefined) out.highlighted = input.highlighted ? 1 : 0;
 if (input.trialDays !== undefined) { if (!Number.isInteger(input.trialDays) || input.trialDays < 0 || input.trialDays > 365) fail(400, 'trialDays is invalid'); out.trialDays = input.trialDays; }
 if (input.supportLevel !== undefined) out.supportLevel = clean(input.supportLevel, 30) || 'standard';
 if (input.entitlements !== undefined) {
  if (!Array.isArray(input.entitlements) || input.entitlements.some(e => !ALL_ENTITLEMENTS.includes(e))) fail(400, 'entitlements contains an unknown key');
  out.entitlements = [...new Set(input.entitlements)];
 }
 if (input.limits !== undefined) {
  if (!input.limits || typeof input.limits !== 'object') fail(400, 'limits must be an object');
  const lim = {};
  for (const [k, v] of Object.entries(input.limits)) {
   if (!LIMIT_KEYS.includes(k)) fail(400, `unknown limit: ${k}`);
   if (v === null || v === '') continue;
   if (!Number.isInteger(v) || v < 0) fail(400, `limit ${k} must be a non-negative integer`);
   lim[k] = v;
  }
  out.limits = lim;
 }
 return out;
}
export function createPlan(db, actor, input) {
 const v = validatePlan(input, false);
 return tx(db, () => {
  if (db.prepare('SELECT 1 FROM client_plans WHERE slug=?').get(v.slug)) fail(409, 'slug already used');
  const id = newId(), t = now();
  db.prepare('INSERT INTO client_plans (id,slug,plan_type,name_ar,name_en,description_ar,description_en,price_minor,currency,billing_period,status,sort_order,highlighted,trial_days,support_level,entitlements_json,limits_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(id, v.slug, v.planType || 'merchant', v.nameAr, v.nameEn, v.descriptionAr || '', v.descriptionEn || '', v.priceMinor, v.currency || 'SAR', v.billingPeriod || (v.priceMinor ? 'monthly' : 'free'), v.status || 'active', v.sortOrder ?? 0, v.highlighted ?? 0, v.trialDays ?? 14, v.supportLevel || 'standard', JSON.stringify(v.entitlements || []), JSON.stringify(v.limits || {}), t, t);
  audit(db, {tenantId: null, actor, action: 'CLIENT_PLAN_CREATED', entityType: 'plan', entityId: id, detail: {slug: v.slug}});
  return getPlan(db, id);
 });
}
const COL = {slug: 'slug', planType: 'plan_type', nameAr: 'name_ar', nameEn: 'name_en', descriptionAr: 'description_ar', descriptionEn: 'description_en', priceMinor: 'price_minor', currency: 'currency', billingPeriod: 'billing_period', status: 'status', sortOrder: 'sort_order', highlighted: 'highlighted', trialDays: 'trial_days', supportLevel: 'support_level'};
export function updatePlan(db, actor, id, input) {
 const v = validatePlan(input, true);
 return tx(db, () => {
  const before = getPlan(db, id);
  if (v.slug && v.slug !== before.slug && db.prepare('SELECT 1 FROM client_plans WHERE slug=?').get(v.slug)) fail(409, 'slug already used');
  const sets = [], vals = [];
  for (const [k, val] of Object.entries(v)) {
   if (k === 'entitlements') { sets.push('entitlements_json=?'); vals.push(JSON.stringify(val)); } else if (k === 'limits') { sets.push('limits_json=?'); vals.push(JSON.stringify(val)); } else { sets.push(`${COL[k]}=?`); vals.push(val); }
  }
  if (!sets.length) return before;
  sets.push('updated_at=?'); vals.push(now(), id);
  db.prepare(`UPDATE client_plans SET ${sets.join(',')} WHERE id=?`).run(...vals);
  audit(db, {tenantId: null, actor, action: 'CLIENT_PLAN_UPDATED', entityType: 'plan', entityId: id, detail: {changed: Object.keys(v)}});
  return getPlan(db, id);
 });
}
export const planCustomerCounts = db => Object.fromEntries(db.prepare(`SELECT s.plan_id, COUNT(*) n FROM client_subscriptions s WHERE s.id=(SELECT s2.id FROM client_subscriptions s2 WHERE s2.tenant_id=s.tenant_id AND s2.status!='cancelled' ORDER BY s2.started_at DESC, s2.created_at DESC LIMIT 1) GROUP BY s.plan_id`).all().map(r => [r.plan_id, r.n]));

// Starter tiers. Prices are 0 on purpose: Frost has no merchant checkout yet, so plans are assigned by
// staff; names/limits/entitlements are ordinary rows that the admin edits in the dashboard.
const all12 = AGENT_IDS.map(id => `agent.${id}`);
const CORE = ['client.dashboard', 'client.analytics', 'client.integrations', 'client.approvals'];
const SEED = [
 {slug: 'starter', nameAr: 'المبتدئ', nameEn: 'Starter', descriptionAr: 'ابدأ بوكلاء المحتوى وأدوات الحوكمة الأساسية.', descriptionEn: 'Start with the content agents and the core governance tools.', priceMinor: 0, billingPeriod: 'free', sortOrder: 1, trialDays: 14,
  entitlements: [...CORE, 'client.team', 'agent.strategy', 'agent.copy', 'agent.creative', 'agent.compliance'], limits: {users: 3, integrations: 3, workflows: 2, tasks_per_month: 100, agent_runs_per_month: 200}},
 {slug: 'growth', nameAr: 'النمو', nameEn: 'Growth', descriptionAr: 'كل وكلاء المبيعات والنشر مع الفريق والأتمتة.', descriptionEn: 'Sales and publishing agents with team access and automation.', priceMinor: 0, billingPeriod: 'monthly', sortOrder: 2, highlighted: true, trialDays: 14,
  entitlements: [...CORE, 'client.team', 'client.workflows', 'client.export', 'agent.strategy', 'agent.copy', 'agent.creative', 'agent.compliance', 'agent.publishing', 'agent.leads', 'agent.sales', 'agent.followup'], limits: {users: 10, integrations: 8, workflows: 10, tasks_per_month: 1000, agent_runs_per_month: 2000}},
 {slug: 'scale', nameAr: 'التوسع', nameEn: 'Scale', descriptionAr: 'كل الوكلاء الاثني عشر بحدود أعلى ودعم أولوية.', descriptionEn: 'All twelve agents with higher limits and priority support.', priceMinor: 0, billingPeriod: 'monthly', sortOrder: 3, trialDays: 14, supportLevel: 'priority',
  entitlements: [...CLIENT_ENTITLEMENTS, ...all12], limits: {users: 50, integrations: 20, workflows: 50, tasks_per_month: 10000, agent_runs_per_month: 20000}}
];
// Entitlements / limits that once existed in the catalogue but have no feature or measurement behind them (the customer API and
// storage/retention metering). They are removed from plans and overrides so nothing shows a promise the platform cannot keep.
const RETIRED_ENTITLEMENTS = ['client.api_access'];
const RETIRED_LIMITS = ['storage_mb', 'retention_days'];
export function retireUnbackedKeys(db) {
 return tx(db, () => {
  let changed = 0;
  for (const p of db.prepare('SELECT id, entitlements_json, limits_json FROM client_plans').all()) {
   const ents = JSON.parse(p.entitlements_json || '[]'), lims = JSON.parse(p.limits_json || '{}');
   const nextEnts = ents.filter(e => !RETIRED_ENTITLEMENTS.includes(e));
   const nextLims = Object.fromEntries(Object.entries(lims).filter(([k]) => !RETIRED_LIMITS.includes(k)));
   if (nextEnts.length !== ents.length || Object.keys(nextLims).length !== Object.keys(lims).length) { db.prepare('UPDATE client_plans SET entitlements_json=?, limits_json=?, updated_at=? WHERE id=?').run(JSON.stringify(nextEnts), JSON.stringify(nextLims), now(), p.id); changed++; }
  }
  for (const [kind, keys] of [['entitlement', RETIRED_ENTITLEMENTS], ['limit', RETIRED_LIMITS]]) for (const key of keys) changed += db.prepare('DELETE FROM client_tenant_overrides WHERE kind=? AND key=?').run(kind, key).changes;
  return changed;
 });
}
export function seedPlans(db) {
 if (db.prepare('SELECT 1 FROM client_plans LIMIT 1').get()) return;
 for (const plan of SEED) createPlan(db, {id: null, name: 'system', kind: 'system'}, plan);
}

// ---- subscription + lifecycle ------------------------------------------------------------------------------------------
export const currentSubscription = (db, tenantId) => db.prepare("SELECT * FROM client_subscriptions WHERE tenant_id=? AND status!='cancelled' ORDER BY started_at DESC, created_at DESC LIMIT 1").get(tenantId) || null;
export const getProfile = (db, tenantId) => db.prepare('SELECT * FROM client_profiles WHERE tenant_id=?').get(tenantId) || null;

/**
 * The account state the platform actually enforces. Admin-set states (pending/suspended/cancelled/
 * archived) win; otherwise it is derived from the current subscription period and any grace period.
 */
export function effectiveState(db, tenantId, at = Date.now()) {
 const profile = getProfile(db, tenantId);
 if (!profile) return null;
 if (['pending', 'suspended', 'cancelled', 'archived'].includes(profile.account_status)) return {status: profile.account_status, profile, sub: currentSubscription(db, tenantId), expired: false};
 const sub = currentSubscription(db, tenantId);
 if (!sub) return {status: 'limited', profile, sub: null, expired: true};
 const end = sub.status === 'trial' ? sub.trial_ends_at : sub.ends_at;
 let status = sub.status === 'trial' ? 'trial' : 'active';
 let expired = false;
 if (sub.status === 'expired') { status = 'limited'; expired = true; }
 else if (sub.status === 'past_due') status = 'past_due';
 if (end && Date.parse(end) < at) {
  expired = true;
  const grace = sub.grace_until || profile.grace_until;
  status = grace && Date.parse(grace) > at ? 'past_due' : 'limited';
 }
 return {status, profile, sub, expired};
}
export const isOperational = state => !!state && OPERATIONAL_STATUSES.includes(state.status);
export const isReadable = state => !!state && READABLE_STATUSES.includes(state.status);

function workspaceStatusFor(profile, status) {
 if (status === 'suspended') return 'suspended';
 if (status === 'archived' || status === 'cancelled') return 'archived';
 if (status === 'limited' || status === 'past_due') return 'restricted';
 return profile.workspace_status === 'onboarding' ? 'onboarding' : 'ready';
}
/** Persists derived states (idempotent) and notifies once per transition. Runs lazily and on a timer. */
export function syncLifecycle(db, at = Date.now()) {
 let changed = 0;
 for (const p of db.prepare('SELECT * FROM client_profiles').all()) {
  const state = effectiveState(db, p.tenant_id, at);
  const ws = workspaceStatusFor(p, state.status);
  if (state.status === p.account_status && ws === p.workspace_status) continue;
  tx(db, () => {
   const t = now();
   db.prepare('UPDATE client_profiles SET account_status=?,workspace_status=?,updated_at=? WHERE tenant_id=?').run(state.status, ws, t, p.tenant_id);
   if (state.sub && state.expired && state.sub.status !== 'expired' && state.status === 'limited') db.prepare("UPDATE client_subscriptions SET status='expired' WHERE id=?").run(state.sub.id);
   audit(db, {tenantId: p.tenant_id, actor: {kind: 'system', name: 'lifecycle'}, action: 'CLIENT_STATUS_CHANGED', entityType: 'account', detail: {from: p.account_status, to: state.status}});
   notifyMembers(db, p.tenant_id, state.status === 'limited' ? 'plan_expired' : 'status_changed', {status: state.status}, 'billing.manage');
  });
  changed++;
 }
 return changed;
}

/** Assign a plan (new subscription row; the previous one is closed, never deleted). */
export function assignPlan(db, actor, tenantId, planId, {trial = false, endsAt, graceUntil = null, source = 'admin', reason = null} = {}) {
 const plan = getPlan(db, planId);
 if (plan.status === 'archived') fail(409, 'plan is archived');
 return tx(db, () => {
  const t = now();
  db.prepare("UPDATE client_subscriptions SET status='cancelled',ends_at=COALESCE(ends_at,?) WHERE tenant_id=? AND status IN ('trial','active','past_due','expired')").run(t, tenantId);
  const useTrial = trial && plan.trialDays > 0;
  const trialEnds = useTrial ? new Date(Date.now() + plan.trialDays * 86400000).toISOString() : null;
  let end = endsAt === undefined ? (useTrial ? trialEnds : periodEnd(plan.billingPeriod)) : endsAt;
  if (end && Date.parse(end) <= Date.now()) fail(400, 'endsAt must be in the future');
  const id = newId();
  db.prepare('INSERT INTO client_subscriptions (id,tenant_id,plan_id,status,started_at,trial_ends_at,ends_at,grace_until,source,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, tenantId, planId, useTrial ? 'trial' : 'active', t, trialEnds, useTrial ? null : end, graceUntil, source, actor?.id || null, t);
  const profile = getProfile(db, tenantId);
  if (profile && !['suspended', 'cancelled', 'archived', 'pending'].includes(profile.account_status)) db.prepare("UPDATE client_profiles SET account_status=?,grace_until=?,updated_at=? WHERE tenant_id=?").run(useTrial ? 'trial' : 'active', graceUntil, t, tenantId);
  db.prepare("UPDATE tenants SET plan=?,updated_at=? WHERE id=?").run(plan.slug, t, tenantId);
  audit(db, {tenantId, actor, action: 'CLIENT_PLAN_ASSIGNED', entityType: 'subscription', entityId: id, reason, detail: {plan: plan.slug, trial: useTrial, endsAt: end}});
  notifyMembers(db, tenantId, 'plan_changed', {plan: plan.slug, planAr: plan.nameAr, planEn: plan.nameEn});
  syncLifecycle(db);
  return id;
 });
}
function periodEnd(period) {
 const d = new Date();
 if (period === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
 else if (period === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
 else return null;
 return d.toISOString();
}
export function grantGrace(db, actor, tenantId, untilIso, reason) {
 const until = Date.parse(untilIso);
 if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + 90 * 86400000) fail(400, 'grace period must end within the next 90 days');
 if (!clean(reason, 300)) fail(400, 'a reason is required');
 tx(db, () => {
  const t = now();
  db.prepare('UPDATE client_profiles SET grace_until=?,updated_at=? WHERE tenant_id=?').run(new Date(until).toISOString(), t, tenantId);
  const sub = currentSubscription(db, tenantId);
  if (sub) db.prepare("UPDATE client_subscriptions SET grace_until=?,status=CASE WHEN status='expired' THEN 'active' ELSE status END WHERE id=?").run(new Date(until).toISOString(), sub.id);
  audit(db, {tenantId, actor, action: 'CLIENT_GRACE_GRANTED', entityType: 'account', reason, detail: {until: new Date(until).toISOString()}});
  notifyMembers(db, tenantId, 'grace_granted', {until: new Date(until).toISOString()}, 'billing.manage');
  syncLifecycle(db);
 });
}

// ---- entitlements + limits -------------------------------------------------------------------------------------------------
export function tenantOverrides(db, tenantId) {
 const out = {entitlements: {}, limits: {}};
 for (const r of db.prepare('SELECT kind,key,value FROM client_tenant_overrides WHERE tenant_id=?').all(tenantId)) out[r.kind === 'entitlement' ? 'entitlements' : 'limits'][r.key] = r.value;
 return out;
}
export function setOverrides(db, actor, tenantId, {entitlements = {}, limits = {}}, reason) {
 if (!clean(reason, 300)) fail(400, 'a reason is required');
 for (const [k, v] of Object.entries(entitlements)) { if (!ALL_ENTITLEMENTS.includes(k)) fail(400, `unknown entitlement: ${k}`); if (!['allow', 'deny', 'inherit'].includes(v)) fail(400, 'entitlement value must be allow, deny or inherit'); }
 for (const [k, v] of Object.entries(limits)) { if (!LIMIT_KEYS.includes(k)) fail(400, `unknown limit: ${k}`); if (v !== 'inherit' && v !== null && (!Number.isInteger(v) || v < 0)) fail(400, `limit ${k} must be a non-negative integer, null (unlimited) or "inherit"`); }
 tx(db, () => {
  const put = (kind, key, value) => value === 'inherit'
   ? db.prepare('DELETE FROM client_tenant_overrides WHERE tenant_id=? AND kind=? AND key=?').run(tenantId, kind, key)
   : db.prepare('INSERT INTO client_tenant_overrides (tenant_id,kind,key,value,updated_by,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id,kind,key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(tenantId, kind, key, String(value === null ? 'unlimited' : value), actor?.id || null, now());
  for (const [k, v] of Object.entries(entitlements)) put('entitlement', k, v);
  for (const [k, v] of Object.entries(limits)) put('limit', k, v);
  audit(db, {tenantId, actor, action: 'CLIENT_OVERRIDES_CHANGED', entityType: 'overrides', reason, detail: {entitlements, limits}});
 });
}

/** Everything an authorization check needs about a workspace, resolved once. */
export function resolveAccess(db, tenantId, at = Date.now()) {
 const state = effectiveState(db, tenantId, at);
 if (!state) return null;
 const plan = state.sub ? getPlan(db, state.sub.plan_id) : null;
 const ov = tenantOverrides(db, tenantId);
 const set = new Set(plan ? plan.entitlements : []);
 for (const [k, v] of Object.entries(ov.entitlements)) { if (v === 'allow') set.add(k); else if (v === 'deny') set.delete(k); }
 const limits = {};
 for (const key of LIMIT_KEYS) {
  if (key in ov.limits) limits[key] = ov.limits[key] === 'unlimited' ? null : Number(ov.limits[key]);
  else limits[key] = plan && key in plan.limits ? plan.limits[key] : null;
 }
 return {state, plan, entitlements: [...set], limits, overrides: ov, operational: isOperational(state), readable: isReadable(state)};
}
export const hasEntitlement = (access, key) => !!access && access.entitlements.includes(key);

// ---- usage -----------------------------------------------------------------------------------------------------------------------------
const monthStart = (at = Date.now()) => { const d = new Date(at); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };
export function usageFor(db, tenantId, at = Date.now()) {
 const since = monthStart(at);
 const one = (sql, ...a) => db.prepare(sql).get(...a).n;
 return {
  users: one("SELECT COUNT(*) n FROM client_members WHERE tenant_id=? AND status='active'", tenantId),
  integrations: one("SELECT COUNT(*) n FROM integration_connections WHERE tenant_id=? AND status!='DISCONNECTED'", tenantId),
  workflows: one("SELECT COUNT(*) n FROM workflow_definitions WHERE tenant_id=? AND status!='ARCHIVED'", tenantId),
  tasks_per_month: one("SELECT COUNT(*) n FROM client_tasks WHERE tenant_id=? AND status!='draft' AND created_at>=?", tenantId, since),
  agent_runs_per_month: one("SELECT COUNT(*) n FROM agent_runs WHERE tenant_id=? AND status!='CANCELLED' AND started_at>=?", tenantId, since),
 };
}
export function agentRunsThisMonth(db, tenantId, agentId, at = Date.now()) {
 return db.prepare("SELECT COUNT(*) n FROM agent_runs WHERE tenant_id=? AND agent_id=? AND status!='CANCELLED' AND started_at>=?").get(tenantId, agentId, monthStart(at)).n;
}
/** Throws 403 LIMIT_REACHED:<key> when `used + adding` would exceed the workspace limit. */
export function assertWithinLimit(db, tenantId, key, adding = 1) {
 const access = resolveAccess(db, tenantId);
 const limit = access?.limits[key];
 if (limit === null || limit === undefined) return;
 if (usageFor(db, tenantId)[key] + adding > limit) throw Object.assign(new Error(`LIMIT_REACHED:${key}`), {status: 403, code: 'LIMIT_REACHED', limitKey: key, limit});
}
export {isCatalogAgent};
export const tenantName = (db, tenantId) => getTenant(db, tenantId)?.name || null;
