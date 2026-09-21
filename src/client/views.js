import {fail} from '../auth.js';
import {listConnections, createConnection, getConnection, updateConnection} from '../integrations/connections.js';
import {credentialsConfigured} from '../runtime/credentials.js';
import {getOAuthProvider, PROVIDER_FOR_DEFINITION, providerAvailability} from '../integrations/oauth-providers.js';
import {listIntegrationDefinitions, getIntegrationDefinition} from '../integrations/definitions.js';
import {storeCredential} from '../integrations/vault.js';
import {testConnectionHealth} from '../integrations/health.js';
import {testAnthropicConnection, testOpenAIConnection} from '../connectors.js';
import {listApprovals} from '../runtime/approvals.js';
import {AGENT_IDS} from './catalog.js';
import {audit, clean, newId, now, pageParams, paged, parseJson, tx} from './core.js';
import {agentViews} from './agents.js';
import {assertWithinLimit, listPlans, resolveAccess, usageFor} from './plans.js';

// Read models + thin, tenant-scoped wrappers over the platform's existing services.

// ---- integrations -------------------------------------------------------------------------------------------------------------
// `availability.state` is 'available' only when the action would really work on this server; otherwise 'unavailable' (with the
// concrete reason) or 'coming_soon'. The portal never renders a working-looking button for anything else.
export function integrationsView(db, tenantId, {env = {}, baseUrl = ''} = {}) {
 const connections = listConnections(db, {}, tenantId);
 return listIntegrationDefinitions(db).filter(d => d.isSystem && d.status === 'PUBLISHED').map(def => {
  const via = PROVIDER_FOR_DEFINITION[def.slug] || null;
  const provider = via ? getOAuthProvider(via) : null;
  const mine = connections.filter(c => (c.integrationDefinitionId === def.id || c.integrationDefinitionId === def.slug) && c.status !== 'DISCONNECTED');
  let c = mine.find(x => x.isDefault) || mine[0] || null;
  // WhatsApp is the WhatsApp side of the Meta login: it is connected exactly when that login exposed a WhatsApp account
  if (def.slug === 'whatsapp') { const meta = connections.find(x => x.integrationDefinitionId === 'meta' && x.status !== 'DISCONNECTED'); c = meta?.externalAccountMetadata?.whatsapp ? meta : null; }
  const method = def.authType === 'API_KEY' ? 'api_key' : provider ? 'oauth' : 'unsupported';
  const availability = method === 'api_key'
   ? (def.isAvailable && credentialsConfigured(env) ? {state: 'available', reason: null} : {state: 'unavailable', reason: def.isAvailable ? 'encryption_key_missing' : 'not_implemented'})
   : method === 'oauth' ? providerAvailability(env, provider, {baseUrl}) : {state: 'coming_soon', reason: 'not_implemented'};
  return {
   slug: def.slug, id: def.id, nameAr: def.nameAr, nameEn: def.nameEn, category: def.category, authType: def.authType, available: availability.state === 'available',
   descriptionAr: def.descriptionAr, descriptionEn: def.descriptionEn,
   method, availability, connectVia: via, multiple: !!provider?.multiple,
   connections: (def.slug === 'whatsapp' ? (c ? [c] : []) : mine).map(x => ({id: x.id, name: x.name, status: x.status, accountName: x.externalAccountName || null, lastHealthCheck: x.lastHealthCheck, lastSuccessAt: x.lastSuccessAt, lastError: x.lastErrorMessageSafe || x.lastErrorCode || null, connectedAt: x.connectedAt})),
   connection: c && {id: c.id, name: c.name, status: c.status, accountName: c.externalAccountName || null, lastHealthCheck: c.lastHealthCheck, lastSuccessAt: c.lastSuccessAt, lastErrorAt: c.lastErrorAt, lastError: c.lastErrorMessageSafe || c.lastErrorCode || null, connectedAt: c.connectedAt}
  };
 });
}
export async function connectApiKeyIntegration(db, env, fetcher, ctx, {slug, name, apiKey}) {
 const def = getIntegrationDefinition(db, slug);
 if (!def || !def.isSystem || def.authType !== 'API_KEY' || !def.isAvailable) fail(400, 'this integration cannot be connected with an API key');
 if (typeof apiKey !== 'string' || apiKey.trim().length < 8 || apiKey.length > 400) fail(400, 'a valid API key is required');
 assertWithinLimit(db, ctx.tenantId, 'integrations', 1);
 const key = apiKey.trim();
 const testEnv = slug === 'anthropic' ? {...env, ANTHROPIC_API_KEY: key} : slug === 'openai' ? {...env, OPENAI_API_KEY: key} : null;
 if (!testEnv) fail(400, 'UNSUPPORTED_API_KEY_PROVIDER');
 const result = slug === 'anthropic' ? await testAnthropicConnection({env: testEnv, fetcher}) : await testOpenAIConnection({env: testEnv, fetcher});
 if (result.result !== 'OK') {
  audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: 'CLIENT_INTEGRATION_TEST_FAILED', entityType: 'integration', entityId: slug, detail: {code: result.code || result.result}});
  fail(422, `CREDENTIAL_TEST_FAILED:${result.code || result.result}`);
 }
 return tx(db, () => {
  const connection = createConnection(db, {integrationDefinitionId: def.id, name: clean(name, 80) || def.nameEn, connectedBy: ctx.user.id}, ctx.tenantId);
  storeCredential(db, env, {connectionId: connection.id, credentialType: 'api_key', payload: {apiKey: key}}, ctx.tenantId);
  const t = now();
  updateConnection(db, connection.id, {status: 'CONNECTED', connectedBy: ctx.user.id, connectedAt: t, lastHealthCheck: t, lastSuccessAt: t, lastErrorAt: null, lastErrorCode: null, lastErrorMessageSafe: null}, ctx.tenantId);
  audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: 'CLIENT_INTEGRATION_CONNECTED', entityType: 'integration', entityId: connection.id, detail: {provider: slug}});
  return connection.id;
 });
}
export async function testClientConnection(db, env, fetcher, ctx, id, store) {
 const connection = getConnection(db, id, ctx.tenantId);
 const result = await testConnectionHealth(connection, {store, env, fetcher});
 const t = now();
 updateConnection(db, id, {status: result.status, lastHealthCheck: t, lastSuccessAt: result.status === 'CONNECTED' ? t : connection.lastSuccessAt, lastErrorAt: ['ERROR', 'TOKEN_EXPIRED'].includes(result.status) ? t : connection.lastErrorAt, lastErrorCode: result.errors?.[0] || null, lastErrorMessageSafe: result.safeMessage || null}, ctx.tenantId);
 audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: 'CLIENT_INTEGRATION_TESTED', entityType: 'integration', entityId: id, detail: {status: result.status}});
 return {status: result.status, safeMessage: result.safeMessage || null};
}

// ---- approvals ------------------------------------------------------------------------------------------------------------------------
export function approvalsView(db, tenantId, url) {
 const p = pageParams(url);
 const status = url.searchParams.get('status');
 const all = listApprovals(db, {status: status || undefined}, tenantId);
 const rows = all.slice(p.offset, p.offset + p.limit).map(a => ({
  id: a.id, agentId: a.agent_id, actionType: a.action_type, riskLevel: a.risk_level, reason: a.reason, status: a.status, createdAt: a.created_at, decidedByName: a.decided_by_name, decidedAt: a.decided_at, runId: a.run_id,
  proposed: summarizeProposed(a.proposed_output)
 }));
 return paged(rows, all.length, p);
}
function summarizeProposed(output) {
 if (!output || typeof output !== 'object') return null;
 const out = {};
 for (const [k, v] of Object.entries(output)) {
  if (v === null || v === undefined) continue;
  out[k] = typeof v === 'string' ? v.slice(0, 500) : typeof v === 'object' ? JSON.stringify(v).slice(0, 500) : v;
 }
 return out;
}

// ---- analytics -------------------------------------------------------------------------------------------------------------------------------
export function analyticsFor(db, tenantId, days = 30) {
 const range = [7, 30, 90].includes(days) ? days : 30;
 const since = new Date(Date.now() - range * 86400000).toISOString();
 const one = (sql, ...a) => db.prepare(sql).get(...a);
 const tasksByStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM client_tasks WHERE tenant_id=? AND created_at>=? GROUP BY status').all(tenantId, since).map(r => [r.status, r.n]));
 const perDay = db.prepare("SELECT substr(created_at,1,10) day, COUNT(*) n FROM client_tasks WHERE tenant_id=? AND status!='draft' AND created_at>=? GROUP BY day").all(tenantId, since);
 const doneDay = db.prepare("SELECT substr(completed_at,1,10) day, COUNT(*) n FROM client_tasks WHERE tenant_id=? AND status='completed' AND completed_at>=? GROUP BY day").all(tenantId, since);
 const series = (rows) => { const map = new Map(rows.map(r => [r.day, r.n])); const out = []; for (let i = range - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); out.push({day: d, value: map.get(d) || 0}); } return out; };
 const byAgent = db.prepare("SELECT agent_id, COUNT(*) runs, SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) failed, COALESCE(SUM(tokens_input+tokens_output),0) tokens, COALESCE(SUM(estimated_cost),0) cost FROM agent_runs WHERE tenant_id=? AND status!='CANCELLED' AND started_at>=? GROUP BY agent_id ORDER BY runs DESC").all(tenantId, since);
 const tokens = one("SELECT COALESCE(SUM(tokens_input+tokens_output),0) t, COALESCE(SUM(estimated_cost),0) c, COUNT(*) n FROM agent_runs WHERE tenant_id=? AND status!='CANCELLED' AND started_at>=?", tenantId, since);
 const approvals = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM agent_approvals WHERE tenant_id=? AND created_at>=? GROUP BY status').all(tenantId, since).map(r => [r.status, r.n]));
 const connections = Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM integration_connections WHERE tenant_id=? AND status!='DISCONNECTED' GROUP BY status").all(tenantId).map(r => [r.status, r.n]));
 const total = Object.values(tasksByStatus).reduce((a, b) => a + b, 0);
 return {
  range, tasks: {total, byStatus: tasksByStatus, created: series(perDay), completed: series(doneDay), completionRateBps: total ? Math.round(((tasksByStatus.completed || 0) * 10000) / total) : 0},
  agents: byAgent.map(r => ({agentId: r.agent_id, runs: r.runs, failed: r.failed || 0, tokens: r.tokens, cost: r.cost})),
  usage: {runs: tokens.n, tokens: tokens.t, cost: tokens.c}, approvals: {pending: approvals.PENDING || 0, approved: (approvals.APPROVED || 0) + (approvals.EDITED || 0), rejected: approvals.REJECTED || 0}, integrations: connections
 };
}

// ---- dashboard --------------------------------------------------------------------------------------------------------------------------------
export function dashboardFor(db, env, ctx) {
 const tenantId = ctx.tenantId;
 const one = (sql, ...a) => db.prepare(sql).get(...a).n;
 const views = agentViews(db, env, tenantId);
 const since = new Date(Date.now() - 30 * 86400000).toISOString();
 const onboarding = db.prepare('SELECT completed_at FROM client_onboarding WHERE tenant_id=?').get(tenantId);
 const connected = one("SELECT COUNT(*) n FROM integration_connections WHERE tenant_id=? AND status='CONNECTED'", tenantId);
 const members = one("SELECT COUNT(*) n FROM client_members WHERE tenant_id=? AND status='active'", tenantId);
 const usage = usageFor(db, tenantId);
 const next = [];
 if (!onboarding?.completed_at) next.push('finish_onboarding');
 if (!connected) next.push('connect_integration');
 if (members <= 1 && ctx.access.entitlements.includes('client.team')) next.push('invite_member');
 if (views.some(a => a.status === 'setup_required' && a.usable)) next.push('setup_agents');
 return {
  counts: {
   activeAgents: views.filter(a => ['available', 'connected', 'running'].includes(a.status)).length, lockedAgents: views.filter(a => a.status === 'locked_by_plan').length, totalAgents: views.length,
   tasksRunning: one("SELECT COUNT(*) n FROM client_tasks WHERE tenant_id=? AND status IN ('running','queued')", tenantId), tasksCompleted: one("SELECT COUNT(*) n FROM client_tasks WHERE tenant_id=? AND status='completed' AND completed_at>=?", tenantId, since),
   tasksFailed: one("SELECT COUNT(*) n FROM client_tasks WHERE tenant_id=? AND status='failed' AND created_at>=?", tenantId, since),
   waitingApproval: one("SELECT COUNT(*) n FROM agent_approvals WHERE tenant_id=? AND status='PENDING'", tenantId), integrationsConnected: connected,
   integrationsBroken: one("SELECT COUNT(*) n FROM integration_connections WHERE tenant_id=? AND status IN ('ERROR','TOKEN_EXPIRED','DEGRADED','PERMISSION_MISSING')", tenantId),
   unreadNotifications: one('SELECT COUNT(*) n FROM client_notifications WHERE tenant_id=? AND (user_id IS NULL OR user_id=?) AND read_at IS NULL', tenantId, ctx.user.id)
  },
  usage: Object.fromEntries(Object.entries(ctx.access.limits).map(([k, limit]) => [k, {used: usage[k], limit}])),
  agents: views.map(a => ({key: a.key, nameAr: a.nameAr, nameEn: a.nameEn, status: a.status, category: a.category, icon: a.icon})),
  recentTasks: db.prepare('SELECT id,title,agent_id,status,priority,created_at FROM client_tasks WHERE tenant_id=? ORDER BY created_at DESC, rowid DESC LIMIT 6').all(tenantId).map(r => ({id: r.id, title: r.title, agentId: r.agent_id, status: r.status, priority: r.priority, createdAt: r.created_at})),
  pendingApprovals: listApprovals(db, {status: 'PENDING'}, tenantId).slice(0, 5).map(a => ({id: a.id, agentId: a.agent_id, actionType: a.action_type, riskLevel: a.risk_level, reason: a.reason, createdAt: a.created_at})),
  activity: db.prepare("SELECT action,actor_name,actor_kind,created_at FROM client_audit_logs WHERE tenant_id=? ORDER BY created_at DESC, rowid DESC LIMIT 8").all(tenantId).map(r => ({action: r.action, actorName: r.actor_name, actorKind: r.actor_kind, at: r.created_at})),
  nextSteps: next
 };
}

// ---- notifications ---------------------------------------------------------------------------------------------------------------------------------
export function listClientNotifications(db, ctx, url) {
 const p = pageParams(url, {defaultLimit: 30});
 const where = 'tenant_id=? AND (user_id IS NULL OR user_id=?)';
 const total = db.prepare(`SELECT COUNT(*) n FROM client_notifications WHERE ${where}`).get(ctx.tenantId, ctx.user.id).n;
 const unread = db.prepare(`SELECT COUNT(*) n FROM client_notifications WHERE ${where} AND read_at IS NULL`).get(ctx.tenantId, ctx.user.id).n;
 const rows = db.prepare(`SELECT * FROM client_notifications WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(ctx.tenantId, ctx.user.id, p.limit, p.offset);
 return {...paged(rows.map(r => ({id: r.id, kind: r.kind, params: parseJson(r.params_json, {}), read: !!r.read_at, createdAt: r.created_at})), total, p), unread};
}
export function markNotificationsRead(db, ctx, ids) {
 const t = now();
 if (Array.isArray(ids) && ids.length) for (const id of ids.slice(0, 100)) db.prepare('UPDATE client_notifications SET read_at=? WHERE id=? AND tenant_id=? AND (user_id IS NULL OR user_id=?) AND read_at IS NULL').run(t, String(id), ctx.tenantId, ctx.user.id);
 else db.prepare('UPDATE client_notifications SET read_at=? WHERE tenant_id=? AND (user_id IS NULL OR user_id=?) AND read_at IS NULL').run(t, ctx.tenantId, ctx.user.id);
}

// ---- billing ----------------------------------------------------------------------------------------------------------------------------------------
export function billingView(db, tenantId) {
 const access = resolveAccess(db, tenantId);
 const history = db.prepare('SELECT s.*, p.name_ar, p.name_en, p.slug FROM client_subscriptions s JOIN client_plans p ON p.id=s.plan_id WHERE s.tenant_id=? ORDER BY s.started_at DESC').all(tenantId)
  .map(s => ({id: s.id, plan: s.slug, nameAr: s.name_ar, nameEn: s.name_en, status: s.status, startedAt: s.started_at, trialEndsAt: s.trial_ends_at, endsAt: s.ends_at, source: s.source}));
 return {
  state: access.state.status, expired: access.state.expired, plan: access.plan, trialEndsAt: access.state.sub?.trial_ends_at || null, endsAt: access.state.sub?.ends_at || null, graceUntil: access.state.sub?.grace_until || access.state.profile.grace_until || null,
  limits: access.limits, usage: usageFor(db, tenantId), history, availablePlans: listPlans(db, {publicOnly: true}).filter(p => p.planType !== 'partner')
 };
}
export {AGENT_IDS, newId};
