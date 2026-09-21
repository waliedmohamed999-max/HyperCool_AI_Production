import {fail} from '../auth.js';
import {activateWorkflow, archiveWorkflow, createWorkflowDraft, getWorkflowWithVersion, listWorkflowRuns, listWorkflows, pauseWorkflow, requestCancelWorkflowRun, resumeWorkflow, startWorkflowRun, updateWorkflowDraft, getRunWithSteps, computeWorkflowReadiness} from '../runtime/workflow-engine.js';
import {audit, clean, cleanMultiline, now, tx} from './core.js';
import {agentAccess, agentView} from './agents.js';
import {assertWithinLimit, resolveAccess} from './plans.js';

// Workflow TEMPLATES ("قوالب سير العمل"), not a free-form editor. A merchant picks a code-reviewed template and fills a few
// bounded inputs (name, objective, trigger); the server builds the step graph, so a merchant can never introduce a tool, an
// arbitrary agent or an unreviewed action. The graph is created through the platform's own workflow engine (same validation,
// versions, readiness, execution and approvals) and every step is checked against the workspace's plan and admin controls.
//
// Every template ends in a human APPROVAL step before anything leaves the workspace, and none uses TOOL steps.

const AGENT_STEP = (id, agentId, instruction, next) => ({id, type: 'AGENT', agentId, objective: instruction, next});
const APPROVAL_STEP = (id, reason, riskLevel, next) => ({id, type: 'APPROVAL', reason, riskLevel, next});
const NOTIFY_STEP = (id, reason) => ({id, type: 'NOTIFY_INTERNAL', reason, next: []});

export const TEMPLATES = {
 content_review: {
  nameAr: 'إنشاء محتوى مع مراجعة الامتثال', nameEn: 'Content creation with compliance review',
  descriptionAr: 'يكتب وكيل النصوص المحتوى، ثم يراجعه وكيل الامتثال، ثم تعتمده أنت قبل أي استخدام.', descriptionEn: 'The copy agent drafts the content, the compliance agent reviews it, then you approve it before any use.',
  agents: ['copy', 'compliance'], triggers: ['MANUAL', 'SCHEDULE'], sensitive: true, objectiveRequired: true,
  steps: p => [
   AGENT_STEP('write', 'copy', `Write marketing content for this brief. Brief: ${p.objective}`, ['review']),
   AGENT_STEP('review', 'compliance', 'Review the content produced in the previous step for compliance with brand and platform rules and list any problems.', ['approve']),
   APPROVAL_STEP('approve', 'Approve the reviewed content before it is used', 'MEDIUM', ['done']),
   NOTIFY_STEP('done', 'Content approved and ready to use')
  ],
  outline: [['AGENT', 'copy'], ['AGENT', 'compliance'], ['APPROVAL'], ['NOTIFY']]
 },
 campaign_planning: {
  nameAr: 'تخطيط حملة تسويقية', nameEn: 'Campaign planning',
  descriptionAr: 'يضع وكيل الاستراتيجية خطة الحملة، ويكتب وكيل النصوص الرسائل، ثم تعتمد الخطة.', descriptionEn: 'The strategy agent plans the campaign, the copy agent writes the messages, then you approve the plan.',
  agents: ['strategy', 'copy'], triggers: ['MANUAL', 'SCHEDULE'], sensitive: false, objectiveRequired: true,
  steps: p => [
   AGENT_STEP('plan', 'strategy', `Create a campaign plan for this objective. Objective: ${p.objective}`, ['messages']),
   AGENT_STEP('messages', 'copy', 'Write the key campaign messages that follow the plan from the previous step.', ['approve']),
   APPROVAL_STEP('approve', 'Approve the campaign plan and messages', 'MEDIUM', ['done']),
   NOTIFY_STEP('done', 'Campaign plan approved')
  ],
  outline: [['AGENT', 'strategy'], ['AGENT', 'copy'], ['APPROVAL'], ['NOTIFY']]
 },
 lead_followup: {
  nameAr: 'متابعة العملاء المحتملين', nameEn: 'Lead follow-up',
  descriptionAr: 'يراجع وكيل العملاء المحتملين الفرص الساخنة ويجهّز وكيل المتابعة رسائل، وتعتمدها قبل أي إرسال.', descriptionEn: 'The leads agent reviews hot leads and the follow-up agent drafts messages; you approve them before anything is sent.',
  agents: ['leads', 'followup'], triggers: ['MANUAL', 'SCHEDULE'], sensitive: true, objectiveRequired: false,
  steps: p => [
   AGENT_STEP('leads', 'leads', `Review the current leads and pick the ones that need attention.${p.objective ? ` Focus: ${p.objective}` : ''}`, ['draft']),
   AGENT_STEP('draft', 'followup', 'Draft follow-up messages for the leads selected in the previous step. Do not send anything.', ['approve']),
   APPROVAL_STEP('approve', 'Approve the follow-up drafts before anything is sent to customers', 'HIGH', ['done']),
   NOTIFY_STEP('done', 'Follow-up drafts approved')
  ],
  outline: [['AGENT', 'leads'], ['AGENT', 'followup'], ['APPROVAL'], ['NOTIFY']]
 },
 weekly_performance: {
  nameAr: 'مراجعة الأداء الأسبوعية', nameEn: 'Weekly performance review',
  descriptionAr: 'يحلّل وكيل الأداء نتائج الأسبوع ويرصد وكيل الذكاء التغيّرات في السوق، وتصلك المراجعة كمهمة.', descriptionEn: 'The performance agent analyses the week and the intelligence agent watches market changes; the review reaches you as a task.',
  agents: ['performance', 'intelligence'], triggers: ['MANUAL', 'SCHEDULE'], sensitive: false, objectiveRequired: false, defaultTrigger: {type: 'SCHEDULE', frequency: 'WEEKLY', hour: 8, weekday: 0},
  steps: p => [
   AGENT_STEP('performance', 'performance', `Review the past week's performance and highlight what changed.${p.objective ? ` Focus: ${p.objective}` : ''}`, ['market']),
   AGENT_STEP('market', 'intelligence', 'Summarise the market and competitor signals that matter for the review in the previous step.', ['done']),
   NOTIFY_STEP('done', 'Weekly performance review is ready')
  ],
  outline: [['AGENT', 'performance'], ['AGENT', 'intelligence'], ['NOTIFY']]
 }
};
export const TEMPLATE_KEYS = Object.keys(TEMPLATES);

// ---- validation of the merchant's (bounded) inputs -----------------------------------------------------------------------------
const cleanObjective = value => cleanMultiline(String(value ?? ''), 500).replace(/[{}]/g, ''); // no template braces: nothing of the merchant's text is ever evaluated
function validateTrigger(template, input) {
 const raw = input ?? template.defaultTrigger ?? {type: 'MANUAL'};
 if (!template.triggers.includes(raw.type)) fail(400, `trigger must be one of ${template.triggers.join(', ')}`);
 if (raw.type === 'MANUAL') return {type: 'MANUAL'};
 const frequency = raw.frequency;
 if (!['DAILY', 'WEEKLY'].includes(frequency)) fail(400, 'schedule frequency must be DAILY or WEEKLY');
 const hour = Number(raw.hour);
 if (!Number.isInteger(hour) || hour < 0 || hour > 23) fail(400, 'schedule hour must be 0-23');
 const schedule = {frequency, hour};
 if (frequency === 'WEEKLY') { const weekday = Number(raw.weekday); if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) fail(400, 'schedule weekday must be 0-6'); schedule.weekday = weekday; }
 return {type: 'SCHEDULE', schedule};
}
function normalizeParams(template, input, previous = null) {
 const name = input.name !== undefined ? clean(input.name, 120) : previous?.name;
 const objective = input.objective !== undefined ? cleanObjective(input.objective) : (previous?.objective ?? '');
 if (template.objectiveRequired && objective.length < 5) fail(400, 'objective is required (at least 5 characters)');
 const trigger = validateTrigger(template, input.trigger !== undefined ? input.trigger : previous?.trigger);
 return {name: name && name.length >= 2 ? name : null, objective, trigger};
}
function definitionFrom(template, params) {
 return {nameAr: params.name || template.nameAr, nameEn: params.name || template.nameEn, description: template.descriptionEn, trigger: params.trigger, steps: template.steps(params)};
}

// ---- readiness against the merchant's plan / admin controls ---------------------------------------------------------------
const BLOCKING_LAYERS = new Set(['platform', 'plan', 'admin']);
/** Blockers that stop a workflow from being CREATED (the agent is not part of the workspace at all). */
function creationBlockers(db, env, ctx, template) {
 const access = resolveAccess(db, ctx.tenantId);
 return template.agents.map(agentId => ({agentId, gate: agentAccess(db, env, ctx.tenantId, agentId, access)})).filter(x => !x.gate.usable && BLOCKING_LAYERS.has(x.gate.layer)).map(x => ({agentId: x.agentId, reason: x.gate.reason}));
}
/** Blockers that stop it from being ACTIVATED or RUN right now (plan, admin, account state, onboarding, AI, integrations, usage). */
export function runBlockers(db, env, ctx, agentIds) {
 const out = [];
 for (const agentId of agentIds) {
  const v = agentView(db, env, ctx.tenantId, agentId);
  if (!['available', 'connected', 'running'].includes(v.status)) out.push({agentId, reason: v.reasons?.[0] || v.lockedReason || v.status.toUpperCase(), status: v.status});
 }
 return out;
}
const agentsOf = version => [...new Set((version?.steps || []).filter(s => s.type === 'AGENT').map(s => s.agentId))];

function metaFor(db, tenantId, workflowId) {
 const row = db.prepare('SELECT * FROM client_workflow_meta WHERE workflow_id=? AND tenant_id=?').get(workflowId, tenantId);
 return row ? {templateKey: row.template_key, params: JSON.parse(row.params_json)} : null;
}

// ---- views --------------------------------------------------------------------------------------------------------------------
export function listTemplates(db, env, ctx) {
 return TEMPLATE_KEYS.map(key => {
  const t = TEMPLATES[key];
  const blockers = creationBlockers(db, env, ctx, t);
  return {key, nameAr: t.nameAr, nameEn: t.nameEn, descriptionAr: t.descriptionAr, descriptionEn: t.descriptionEn, agents: t.agents, triggers: t.triggers, defaultTrigger: t.defaultTrigger || {type: 'MANUAL'}, sensitive: t.sensitive, objectiveRequired: t.objectiveRequired, outline: t.outline, available: blockers.length === 0, blockers};
 });
}
function present(db, env, ctx, workflow, {detail = false} = {}) {
 const meta = metaFor(db, ctx.tenantId, workflow.id);
 const version = getWorkflowWithVersion(db, workflow.id, ctx.tenantId).version || null;
 const blockers = version ? runBlockers(db, env, ctx, agentsOf(version)) : [];
 const engine = version ? computeWorkflowReadiness(db, env, ctx.tenantId, version) : {ready: false, blockers: []};
 return {
  id: workflow.id, nameAr: workflow.nameAr, nameEn: workflow.nameEn, description: workflow.description, status: workflow.status, updatedAt: workflow.updatedAt, createdAt: workflow.createdAt,
  templateKey: meta?.templateKey || null, params: meta?.params || null, editable: !!meta && workflow.status !== 'ARCHIVED',
  trigger: version?.trigger || null, agents: agentsOf(version), stepCount: version?.steps.length || 0,
  ready: blockers.length === 0 && engine.ready, blockers: [...blockers, ...engine.blockers.map(b => ({reason: b.reason, stepId: b.stepId}))],
  ...(detail ? {steps: (version?.steps || []).map(s => ({id: s.id, type: s.type, agentId: s.agentId || null, next: s.next || []})), versionStatus: version?.status || null} : {})
 };
}
export function workflowsView(db, env, ctx) {
 return listWorkflows(db, ctx.tenantId).map(w => present(db, env, ctx, w));
}
export const workflowDetail = (db, env, ctx, id) => present(db, env, ctx, getWorkflowWithVersion(db, id, ctx.tenantId), {detail: true});

// ---- create / edit ------------------------------------------------------------------------------------------------------------
export function createFromTemplate(db, env, ctx, input) {
 const template = TEMPLATES[String(input.templateKey || '')];
 if (!template) fail(400, 'UNKNOWN_TEMPLATE');
 const blockers = creationBlockers(db, env, ctx, template);
 if (blockers.length) throw Object.assign(new Error(blockers[0].reason), {status: 403, code: blockers[0].reason, details: {blockers}});
 assertWithinLimit(db, ctx.tenantId, 'workflows', 1);
 const params = normalizeParams(template, input);
 return tx(db, () => {
  const created = createWorkflowDraft(db, env, ctx.tenantId, definitionFrom(template, params), ctx.user);
  const t = now();
  db.prepare('INSERT INTO client_workflow_meta (workflow_id,tenant_id,template_key,params_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(created.id, ctx.tenantId, input.templateKey, JSON.stringify(params), ctx.user.id, t, t);
  audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: 'CLIENT_WORKFLOW_CREATED', entityType: 'workflow', entityId: created.id, detail: {template: input.templateKey, trigger: params.trigger.type}});
  return workflowDetail(db, env, ctx, created.id);
 });
}
export function updateFromTemplate(db, env, ctx, id, input) {
 const meta = metaFor(db, ctx.tenantId, id);
 getWorkflowWithVersion(db, id, ctx.tenantId); // 404 for another tenant's id
 if (!meta) fail(409, 'WORKFLOW_NOT_EDITABLE');
 const template = TEMPLATES[meta.templateKey];
 if (!template) fail(409, 'WORKFLOW_NOT_EDITABLE');
 const blockers = creationBlockers(db, env, ctx, template);
 if (blockers.length) throw Object.assign(new Error(blockers[0].reason), {status: 403, code: blockers[0].reason, details: {blockers}});
 const params = normalizeParams(template, input, meta.params);
 return tx(db, () => {
  const def = definitionFrom(template, params);
  updateWorkflowDraft(db, env, id, def, ctx.user, ctx.tenantId);
  db.prepare('UPDATE client_workflow_meta SET params_json=?, updated_at=? WHERE workflow_id=? AND tenant_id=?').run(JSON.stringify(params), now(), id, ctx.tenantId);
  audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: 'CLIENT_WORKFLOW_UPDATED', entityType: 'workflow', entityId: id, detail: {template: meta.templateKey}});
  return workflowDetail(db, env, ctx, id);
 });
}

// ---- lifecycle ---------------------------------------------------------------------------------------------------------------
function assertRunnable(db, env, ctx, id) {
 const w = getWorkflowWithVersion(db, id, ctx.tenantId);
 const blockers = runBlockers(db, env, ctx, agentsOf(w.version));
 if (blockers.length) throw Object.assign(new Error('WORKFLOW_BLOCKED'), {status: 409, code: 'WORKFLOW_BLOCKED', details: {blockers}});
 return w;
}
const actorUser = ctx => ({id: ctx.user.id, name: ctx.user.name, role: ctx.actor.kind === 'admin_support' ? 'support' : 'owner'});
export function lifecycle(db, env, ctx, id, action) {
 getWorkflowWithVersion(db, id, ctx.tenantId);
 let result;
 if (action === 'activate') { assertRunnable(db, env, ctx, id); result = activateWorkflow(db, env, id, actorUser(ctx), ctx.tenantId); }
 else if (action === 'pause') result = pauseWorkflow(db, id, actorUser(ctx), ctx.tenantId);
 else if (action === 'resume') { assertRunnable(db, env, ctx, id); result = resumeWorkflow(db, id, actorUser(ctx), ctx.tenantId); }
 else if (action === 'archive') result = archiveWorkflow(db, id, actorUser(ctx), ctx.tenantId);
 else fail(400, 'unknown action');
 audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: `CLIENT_WORKFLOW_${action.toUpperCase()}`, entityType: 'workflow', entityId: id});
 return workflowDetail(db, env, ctx, id);
}
export async function runNow(deps, db, env, ctx, id) {
 assertRunnable(db, env, ctx, id);
 audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: 'CLIENT_WORKFLOW_RUN_STARTED', entityType: 'workflow', entityId: id});
 return startWorkflowRun(deps, id, {triggerType: 'MANUAL', tenantId: ctx.tenantId});
}
export const runsOf = (db, ctx, id) => { getWorkflowWithVersion(db, id, ctx.tenantId); return listWorkflowRuns(db, ctx.tenantId, {workflowId: id, limit: 20}); };
export const runDetail = (db, ctx, runId) => getRunWithSteps(db, runId, ctx.tenantId);
export function cancelRun(db, ctx, runId) {
 const run = requestCancelWorkflowRun(db, runId, actorUser(ctx), ctx.tenantId);
 audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: 'CLIENT_WORKFLOW_RUN_CANCELLED', entityType: 'workflow_run', entityId: runId});
 return run;
}

/** Hook for the workflow engine: no new run (scheduled or event driven) starts in a workspace whose account is not operational. */
export function makeWorkflowGate(db) {
 return tenantId => {
  const access = resolveAccess(db, tenantId);
  if (!access) return null; // not a merchant workspace
  return ['trial', 'active', 'past_due'].includes(access.state.status) ? null : `CLIENT_${access.state.status.toUpperCase()}`;
 };
}
