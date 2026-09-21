import {fail} from '../auth.js';
import {createApproval, decideApproval} from '../runtime/approvals.js';
import {evaluateAgentReadiness} from '../runtime/agent-readiness.js';
import {RISK_ORDER, describeAgent, isCatalogAgent} from './catalog.js';
import {RISK_LEVELS, TASK_PRIORITIES, audit, clean, cleanMultiline, newId, notify, notifyMembers, now, pageParams, paged, parseJson, tx} from './core.js';
import {agentAccess, effectiveApprovalLevel, getSettingsRow} from './agents.js';
import {assertWithinLimit, resolveAccess} from './plans.js';

// Merchant tasks: a request for one agent to do one job. The engine (1) checks every access layer,
// (2) applies the approval policy BEFORE anything runs, (3) checks integration/AI readiness, (4) runs the
// platform's own agent runtime, and (5) records only what really happened - a task is `completed` only when
// the run completed and none of its tool calls failed.

const hydrate = r => r && ({
 id: r.id, tenantId: r.tenant_id, agentId: r.agent_id, createdBy: r.created_by, assignedTo: r.assigned_to, title: r.title, description: r.description, input: parseJson(r.input_json, {}),
 status: r.status, priority: r.priority, riskLevel: r.risk_level, approvalStatus: r.approval_status, approvalId: r.approval_id, scheduledAt: r.scheduled_at, startedAt: r.started_at, completedAt: r.completed_at,
 result: parseJson(r.result_json, null), error: r.error, runId: r.run_id, usage: parseJson(r.usage_json, null), attempts: r.attempts, createdAt: r.created_at, updatedAt: r.updated_at
});
export const getTask = (db, tenantId, id) => { const t = hydrate(db.prepare('SELECT * FROM client_tasks WHERE id=? AND tenant_id=?').get(id, tenantId)); if (!t) fail(404, 'Task not found'); return t; };

export function listTasks(db, tenantId, url) {
 const p = pageParams(url);
 const where = ['t.tenant_id=?'], args = [tenantId];
 for (const [param, col] of [['status', 't.status'], ['agent', 't.agent_id'], ['priority', 't.priority']]) { const v = url.searchParams.get(param); if (v) { where.push(`${col}=?`); args.push(v); } }
 const q = clean(url.searchParams.get('q') || '', 80).replace(/[%_]/g, '');
 if (q) { where.push('(t.title LIKE ? OR t.description LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
 const total = db.prepare(`SELECT COUNT(*) n FROM client_tasks t WHERE ${where.join(' AND ')}`).get(...args).n;
 const rows = db.prepare(`SELECT t.*, u.name creator_name FROM client_tasks t LEFT JOIN users u ON u.id=t.created_by WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC, t.rowid DESC LIMIT ? OFFSET ?`).all(...args, p.limit, p.offset);
 return paged(rows.map(r => ({...hydrate(r), creatorName: r.creator_name, result: undefined})), total, p);
}

export function createTask(db, env, ctx, input) {
 const agentId = String(input.agentId || '');
 if (!isCatalogAgent(agentId)) fail(404, 'Unknown agent');
 const title = clean(input.title, 140);
 if (title.length < 3) fail(400, 'title is required (3+ characters)');
 const description = cleanMultiline(input.description || '', 4000);
 const priority = input.priority === undefined ? 'normal' : input.priority;
 if (!TASK_PRIORITIES.includes(priority)) fail(400, 'invalid priority');
 const meta = describeAgent(agentId);
 const risk = input.riskLevel === undefined ? meta.riskLevel : input.riskLevel;
 if (!RISK_LEVELS.includes(risk)) fail(400, 'invalid riskLevel');
 // a merchant can raise the risk of a task but never lower it below what the agent's own catalog level implies
 const riskLevel = RISK_ORDER[risk] < RISK_ORDER[meta.riskLevel] ? meta.riskLevel : risk;
 const params = input.input && typeof input.input === 'object' && !Array.isArray(input.input) ? input.input : {};
 if (JSON.stringify(params).length > 8000) fail(413, 'task input is too large');
 let scheduledAt = null;
 if (input.scheduledAt) {
  const at = Date.parse(input.scheduledAt);
  if (!Number.isFinite(at) || at < Date.now() - 60000) fail(400, 'scheduledAt must be a future date');
  if (at > Date.now() + 366 * 86400000) fail(400, 'scheduledAt is too far ahead');
  scheduledAt = new Date(at).toISOString();
 }
 const access = ctx.access;
 if (!['trial', 'active', 'past_due'].includes(access.state.status)) fail(403, `CLIENT_${access.state.status.toUpperCase()}`);
 const gate = agentAccess(db, env, ctx.tenantId, agentId, access);
 if (!gate.usable) throw Object.assign(new Error(gate.reason), {status: 403, code: gate.reason, layer: gate.layer});
 assertWithinLimit(db, ctx.tenantId, 'tasks_per_month', 1);
 let assignedTo = null;
 if (input.assignedTo) {
  if (!db.prepare("SELECT 1 FROM client_members WHERE tenant_id=? AND user_id=? AND status='active'").get(ctx.tenantId, input.assignedTo)) fail(400, 'assignedTo must be an active member of this workspace');
  assignedTo = input.assignedTo;
 }
 const draft = input.draft === true;
 const id = newId(), t = now();
 db.prepare('INSERT INTO client_tasks (id,tenant_id,agent_id,created_by,assigned_to,title,description,input_json,status,priority,risk_level,scheduled_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(id, ctx.tenantId, agentId, ctx.user.id, assignedTo, title, description, JSON.stringify(params), draft ? 'draft' : 'queued', priority, riskLevel, scheduledAt, t, t);
 audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: 'CLIENT_TASK_CREATED', entityType: 'task', entityId: id, detail: {agentId, draft, scheduledAt}});
 return getTask(db, ctx.tenantId, id);
}

const needsApproval = (level, taskRisk, agentRisk) => {
 const risk = Math.max(RISK_ORDER[taskRisk] || 1, RISK_ORDER[agentRisk] || 1);
 if (level === 'manual') return true;
 if (level === 'approval_required') return risk >= 2;
 return risk >= 3; // limited_autonomy
};
const setTask = (db, id, patch) => {
 const keys = Object.keys(patch);
 db.prepare(`UPDATE client_tasks SET ${keys.map(k => `${k}=?`).join(',')},updated_at=? WHERE id=?`).run(...keys.map(k => patch[k]), now(), id);
};
const TOOL_INTEGRATION_STATUSES = ['CONNECTION_REQUIRED', 'INTEGRATION_REQUIRED', 'CONNECTION_UNHEALTHY', 'CONNECTION_CAPABILITY_MISSING'];

/**
 * Applies the policy and, when allowed, executes the task. Safe to call repeatedly: it only acts on tasks
 * that are queued (or being resumed after approval), so a double dispatch never runs a task twice.
 */
export async function dispatchTask(deps, tenantId, taskId, actor) {
 const {db, env, agentRuntime} = deps;
 const claimed = db.prepare("UPDATE client_tasks SET status='running',started_at=COALESCE(started_at,?),attempts=attempts+1,updated_at=? WHERE id=? AND tenant_id=? AND status IN ('queued','waiting_for_integration')").run(now(), now(), taskId, tenantId);
 if (claimed.changes !== 1) return getTask(db, tenantId, taskId);
 const task = getTask(db, tenantId, taskId);
 const stop = (status, patch = {}) => { setTask(db, taskId, {status, ...patch}); return getTask(db, tenantId, taskId); };
 try {
  const access = resolveAccess(db, tenantId);
  const gate = agentAccess(db, env, tenantId, task.agentId, access);
  if (!gate.usable) {
   const paused = gate.layer === 'account';
   audit(db, {tenantId, actor, action: 'CLIENT_TASK_BLOCKED', entityType: 'task', entityId: taskId, detail: {reason: gate.reason}});
   return stop(paused ? 'paused' : 'failed', {error: gate.reason});
  }
  const row = getSettingsRow(db, tenantId, task.agentId);
  const action = typeof task.input.action === 'string' ? task.input.action : null;
  const blocked = parseJson(row?.blocked_actions_json, null), allowed = parseJson(row?.allowed_actions_json, null);
  if (action && blocked?.includes(action)) return stop('failed', {error: 'ACTION_BLOCKED'});
  if (action && allowed?.length && !allowed.includes(action)) return stop('failed', {error: 'ACTION_NOT_ALLOWED'});
  const level = effectiveApprovalLevel(db, tenantId, task.agentId);
  if (task.approvalStatus !== 'approved' && needsApproval(level, task.riskLevel, describeAgent(task.agentId).riskLevel)) {
   const approval = createApproval(db, {runId: null, agentId: task.agentId, actionType: 'client_task_execution', proposedOutput: {taskId, title: task.title, description: task.description, input: task.input, approvalLevel: level}, riskLevel: task.riskLevel.toUpperCase(), reason: `Task "${task.title}" needs approval before agent ${task.agentId} runs (policy: ${level}).`, tenantId});
   audit(db, {tenantId, actor, action: 'CLIENT_APPROVAL_REQUESTED', entityType: 'task', entityId: taskId, detail: {approvalId: approval.id, level}});
   notifyMembers(db, tenantId, 'approval_required', {taskId, title: task.title, agentId: task.agentId}, 'approvals.review');
   return stop('waiting_for_approval', {approval_id: approval.id, approval_status: 'pending', error: null});
  }
  const readiness = evaluateAgentReadiness(db, env, {tenantId, agentId: task.agentId});
  if (readiness.blockers.some(b => /^AI_|AI_NOT_CONFIGURED/.test(b))) {
   notifyMembers(db, tenantId, 'task_failed', {taskId, title: task.title, reason: 'AI_NOT_CONFIGURED'}, 'tasks.create');
   return stop('failed', {error: 'AI_NOT_CONFIGURED', completed_at: now()});
  }
  const missingTools = readiness.blockers.filter(b => b.startsWith('REQUIRED_TOOL_'));
  if (missingTools.length) {
   notifyMembers(db, tenantId, 'agent_setup_required', {agentId: task.agentId, blockers: missingTools}, 'integrations.manage');
   return stop('waiting_for_integration', {error: missingTools.join(', ')});
  }
  db.prepare('INSERT INTO client_usage_events (id,tenant_id,kind,agent_id,quantity,ref_id,created_at) VALUES (?,?,?,?,1,?,?)').run(newId(), tenantId, 'task_run', task.agentId, taskId, now());
  const run = await agentRuntime.run(task.agentId, {triggerType: 'CLIENT_TASK', triggerId: taskId, input: {task: {id: taskId, title: task.title, description: task.description, priority: task.priority, input: task.input}, agent_settings: parseJson(row?.settings_json, {}), current_datetime: now(), timezone: 'Asia/Riyadh'}, user: {id: actor.id, name: actor.name}, tenantId});
  return finishFromRun(db, tenantId, taskId, run);
 } catch (error) {
  audit(db, {tenantId, actor, action: 'CLIENT_TASK_FAILED', entityType: 'task', entityId: taskId, detail: {error: String(error.message).slice(0, 200)}});
  return stop('failed', {error: String(error.message).slice(0, 300), completed_at: now()});
 }
}

function finishFromRun(db, tenantId, taskId, run) {
 const calls = run.toolCalls || [];
 const integrationIssue = calls.find(c => TOOL_INTEGRATION_STATUSES.includes(c.status));
 const toolFailure = calls.find(c => ['ERROR', 'FORBIDDEN'].includes(c.status));
 const pendingApproval = calls.some(c => c.status === 'WAITING_APPROVAL') || run.status === 'WAITING_APPROVAL';
 const usage = {tokensInput: run.tokens_input ?? run.tokensInput ?? null, tokensOutput: run.tokens_output ?? run.tokensOutput ?? null, cost: run.estimated_cost ?? run.estimatedCost ?? null, latencyMs: run.latency_ms ?? run.latencyMs ?? null, provider: run.provider || null, model: run.model || null};
 const result = {summary: run.output?.rationale || null, action: run.output?.action || null, payload: run.output?.payload ?? null, status: run.output?.status || null, escalation: !!run.output?.escalation_required, toolCalls: calls.map(c => ({tool: c.tool, status: c.status}))};
 let status, error = null;
 if (run.status === 'COMPLETED' || run.status === 'ESCALATED') {
  if (pendingApproval) status = 'waiting_for_approval';
  else if (integrationIssue) { status = 'waiting_for_integration'; error = `${integrationIssue.status}:${integrationIssue.tool}`; }
  else if (toolFailure) { status = 'failed'; error = `TOOL_${toolFailure.status}:${toolFailure.tool}`; }
  else status = 'completed';
 } else if (run.status === 'WAITING_APPROVAL') status = 'waiting_for_approval';
 else if (run.status === 'CANCELLED') {
  const reason = run.output?.reason || run.error || 'RUN_CANCELLED';
  status = /NOT_READY/.test(reason) ? 'waiting_for_integration' : 'failed';
  error = reason;
 } else { status = 'failed'; error = run.error || 'RUN_FAILED'; }
 tx(db, () => {
  setTask(db, taskId, {status, error, run_id: run.id, result_json: JSON.stringify(result), usage_json: JSON.stringify(usage), completed_at: ['completed', 'failed'].includes(status) ? now() : null,
   ...(status === 'waiting_for_approval' ? {approval_status: 'pending'} : {})});
  const tokens = (usage.tokensInput || 0) + (usage.tokensOutput || 0);
  if (tokens) db.prepare('INSERT INTO client_usage_events (id,tenant_id,kind,agent_id,quantity,tokens,ref_id,created_at) VALUES (?,?,?,?,1,?,?,?)').run(newId(), tenantId, 'tokens', run.agent_id || run.agentId || null, tokens, taskId, now());
  const task = getTask(db, tenantId, taskId);
  audit(db, {tenantId, actor: {id: task.createdBy, kind: 'system', name: 'agent runtime'}, action: `CLIENT_TASK_${status.toUpperCase()}`, entityType: 'task', entityId: taskId, detail: {runId: run.id, error}});
  if (status === 'completed') notify(db, tenantId, 'task_completed', {taskId, title: task.title}, task.createdBy);
  else if (status === 'failed') notify(db, tenantId, 'task_failed', {taskId, title: task.title, reason: error}, task.createdBy);
 });
 return getTask(db, tenantId, taskId);
}

export function cancelTask(db, ctx, id) {
 const task = getTask(db, ctx.tenantId, id);
 if (!['draft', 'queued', 'waiting_for_integration', 'waiting_for_approval', 'paused'].includes(task.status)) fail(409, `TASK_${task.status.toUpperCase()}`);
 tx(db, () => {
  setTask(db, id, {status: 'cancelled', completed_at: now()});
  if (task.approvalId) { try { decideApproval(db, task.approvalId, 'REJECTED', ctx.user, ctx.tenantId); } catch { /* already decided */ } setTask(db, id, {approval_status: 'rejected'}); }
  audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: 'CLIENT_TASK_CANCELLED', entityType: 'task', entityId: id});
 });
 return getTask(db, ctx.tenantId, id);
}
export function pauseTask(db, ctx, id, paused) {
 const task = getTask(db, ctx.tenantId, id);
 if (paused && task.status !== 'queued') fail(409, `TASK_${task.status.toUpperCase()}`);
 if (!paused && task.status !== 'paused') fail(409, `TASK_${task.status.toUpperCase()}`);
 setTask(db, id, {status: paused ? 'paused' : 'queued'});
 audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: paused ? 'CLIENT_TASK_PAUSED' : 'CLIENT_TASK_RESUMED', entityType: 'task', entityId: id});
 return getTask(db, ctx.tenantId, id);
}
/** Failed / waiting-for-integration / draft tasks go back to the queue (bounded retries). */
export function requeueTask(db, ctx, id) {
 const task = getTask(db, ctx.tenantId, id);
 if (!['failed', 'waiting_for_integration', 'draft'].includes(task.status)) fail(409, `TASK_${task.status.toUpperCase()}`);
 if (task.attempts >= 5) fail(409, 'TASK_RETRY_LIMIT');
 if (task.status !== 'draft') assertWithinLimit(db, ctx.tenantId, 'tasks_per_month', 0);
 setTask(db, id, {status: 'queued', error: null, completed_at: null});
 audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: task.status === 'draft' ? 'CLIENT_TASK_SUBMITTED' : 'CLIENT_TASK_RETRIED', entityType: 'task', entityId: id});
 return getTask(db, ctx.tenantId, id);
}

/** Called after a client_task_execution approval is decided (from the merchant approvals inbox). */
export async function onTaskApprovalDecided(deps, decided, actor) {
 const proposed = parseJson(decided.proposed_output, {});
 const task = db_task(deps.db, decided.tenant_id, proposed.taskId);
 if (!task || task.status !== 'waiting_for_approval') return null;
 if (decided.status === 'REJECTED') {
  setTask(deps.db, task.id, {status: 'cancelled', approval_status: 'rejected', completed_at: now(), error: 'APPROVAL_REJECTED'});
  audit(deps.db, {tenantId: decided.tenant_id, actor, action: 'CLIENT_TASK_REJECTED', entityType: 'task', entityId: task.id});
  notify(deps.db, decided.tenant_id, 'task_rejected', {taskId: task.id, title: task.title}, task.createdBy);
  return getTask(deps.db, decided.tenant_id, task.id);
 }
 setTask(deps.db, task.id, {status: 'queued', approval_status: 'approved'});
 return dispatchTask(deps, decided.tenant_id, task.id, {id: actor.id, name: actor.name, kind: actor.kind});
}
/** After a tool-level approval (raised by the agent itself during a run) is resolved, settle the task that ran it. */
export function settleTaskAfterToolApproval(db, decided) {
 if (!decided.run_id) return null;
 const task = db.prepare("SELECT * FROM client_tasks WHERE run_id=? AND tenant_id=? AND status='waiting_for_approval'").get(decided.run_id, decided.tenant_id);
 if (!task) return null;
 const still = db.prepare("SELECT COUNT(*) n FROM agent_approvals WHERE run_id=? AND status='PENDING'").get(decided.run_id).n;
 if (still) return null;
 const anyRejected = db.prepare("SELECT COUNT(*) n FROM agent_approvals WHERE run_id=? AND status='REJECTED'").get(decided.run_id).n;
 setTask(db, task.id, {status: anyRejected ? 'cancelled' : 'completed', approval_status: anyRejected ? 'rejected' : 'approved', completed_at: now(), error: anyRejected ? 'APPROVAL_REJECTED' : null});
 return getTask(db, decided.tenant_id, task.id);
}
const db_task = (db, tenantId, id) => id ? hydrate(db.prepare('SELECT * FROM client_tasks WHERE id=? AND tenant_id=?').get(id, tenantId)) : null;

/** Queued tasks whose time has come (or that were left queued) - run by the maintenance timer and lazily by requests. */
export async function runDueTasks(deps, at = Date.now(), limit = 10) {
 const rows = deps.db.prepare("SELECT id, tenant_id, created_by FROM client_tasks WHERE status='queued' AND (scheduled_at IS NULL OR scheduled_at<=?) ORDER BY created_at LIMIT ?").all(new Date(at).toISOString(), limit);
 const out = [];
 for (const r of rows) out.push(await dispatchTask(deps, r.tenant_id, r.id, {id: r.created_by, name: 'scheduler', kind: 'system'}));
 return out;
}

export function taskDetail(db, tenantId, id) {
 const task = getTask(db, tenantId, id);
 const calls = task.runId ? db.prepare('SELECT tool,status,at FROM agent_tool_calls WHERE run_id=? AND tenant_id=? ORDER BY at').all(task.runId, tenantId) : [];
 const approval = task.approvalId ? db.prepare('SELECT id,status,decided_by_name,decided_at,reason FROM agent_approvals WHERE id=? AND tenant_id=?').get(task.approvalId, tenantId) : null;
 return {...task, toolCalls: calls.map(c => ({tool: c.tool, status: c.status, at: c.at})), approval: approval && {id: approval.id, status: approval.status, decidedBy: approval.decided_by_name, decidedAt: approval.decided_at, reason: approval.reason}};
}
