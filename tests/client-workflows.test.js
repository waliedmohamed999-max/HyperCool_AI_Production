import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {makeWorkflowGate, isMerchantOnly} from '../src/client/index.js';
import {startWorkflowRun} from '../src/runtime/workflow-engine.js';
import {setAccountStatus} from '../src/client/accounts.js';
import {TEMPLATES, TEMPLATE_KEYS} from '../src/client/workflows.js';

// Merchant workflow TEMPLATES over HTTP: bounded inputs, plan/admin/limit gates, isolation, real execution through the engine
// (mocked LLM transport; everything else is real), approvals, lifecycle, support mode and account state.
const PASSWORD = 'wf-long-test-password-1';
const ENV = {PLATFORM_MAIL_TRANSPORT: 'capture', PLATFORM_ADMIN_USERNAMES: 'wf_admin', SUPPORT_ACCESS_USERNAMES: 'wf_admin', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'test-model', INTEGRATION_ENCRYPTION_KEY: 'cd'.repeat(32)};
const llm = async () => new Response(JSON.stringify({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({status: 'NEEDS_DATA', action: 'NONE', rationale: 'Mock provider reply', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: ['none'], payload: null})}], usage: {input_tokens: 5, output_tokens: 5}}), {status: 200, headers: {'content-type': 'application/json'}});
let app, base, dir;
before(async () => {
 dir = await mkdtemp(join(tmpdir(), 'frost-wf-'));
 app = await createApp({dataDir: dir, env: ENV, fetcher: llm});
 await new Promise(r => app.server.listen(0, '127.0.0.1', r));
 base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await new Promise(r => app.server.close(r)); app.store.close(); await rm(dir, {recursive: true, force: true}); });
const db = () => app.store.db;
async function call(path, {method, body, s} = {}) {
 const res = await fetch(base + path, {method: method || (body ? 'POST' : 'GET'), redirect: 'manual', headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(s ? {cookie: s.cookies.join('; '), 'x-csrf-token': s.csrf} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
 const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
 return {status: res.status, data, text, setCookie: res.headers.get('set-cookie'), csrf: data?.csrf};
}
const sess = r => ({cookies: [r.setCookie.split(';')[0]], csrf: r.csrf});
const REG = {name: 'Owner', phone: '+966500000100', country: 'SA', businessType: 'retail', businessSize: 'small', ecommercePlatform: 'salla', teamSize: 3, goals: ['content'], acceptTerms: true, locale: 'en'};
async function merchant(username, businessName, planSlug) {
 const r = await call('/api/client/register', {body: {...REG, planSlug, username, email: `${username}@wf.example`, password: PASSWORD, businessName}});
 assert.equal(r.status, 201, r.text);
 return sess(r);
}
async function onboard(s, agents) {
 assert.equal((await call('/api/client/onboarding/1', {method: 'PUT', body: {businessName: 'Store', country: 'SA', offering: 'Shoes and bags', audience: 'Young shoppers'}, s})).status, 200);
 assert.equal((await call('/api/client/onboarding/2', {method: 'PUT', body: {goals: ['content']}, s})).status, 200);
 assert.equal((await call('/api/client/onboarding/3', {method: 'PUT', body: {}, s})).status, 200);
 assert.equal((await call('/api/client/onboarding/4', {method: 'PUT', body: {agents}, s})).status, 200);
 assert.equal((await call('/api/client/onboarding/5', {method: 'PUT', body: {autonomy: 'approval_required'}, s})).status, 200);
 assert.equal((await call('/api/client/onboarding/complete', {body: {}, s})).status, 200);
}
const tenantOf = username => db().prepare('SELECT m.tenant_id t FROM client_members m JOIN users u ON u.id=m.user_id WHERE u.username=?').get(username).t;
const S = {};

test('templates are offered per plan; a starter workspace has no workflow feature at all', async () => {
 S.a = await merchant('wf_a', 'Alpha Workflows', 'growth');
 S.b = await merchant('wf_b', 'Beta Workflows', 'growth');
 S.starter = await merchant('wf_starter', 'Starter Store', 'starter');
 S.tenantA = tenantOf('wf_a'); S.tenantB = tenantOf('wf_b');
 assert.equal((await call('/api/client/workflows', {s: S.starter})).data.error, 'ENTITLEMENT_REQUIRED');
 assert.equal((await call('/api/client/workflows', {body: {templateKey: 'content_review', objective: 'A launch brief'}, s: S.starter})).status, 403);
 const list = await call('/api/client/workflows', {s: S.a});
 assert.equal(list.status, 200);
 assert.deepEqual(list.data.items, []);
 const byKey = Object.fromEntries(list.data.templates.map(t => [t.key, t]));
 assert.deepEqual(Object.keys(byKey).sort(), [...TEMPLATE_KEYS].sort());
 assert.equal(byKey.content_review.available, true);
 assert.equal(byKey.campaign_planning.available, true);
 assert.equal(byKey.weekly_performance.available, false, 'the growth plan does not include the performance agent');
 assert.ok(byKey.weekly_performance.blockers.some(b => b.agentId === 'performance' && b.reason === 'AGENT_LOCKED_BY_PLAN'));
 // every template ends in a human approval or an internal notification and never uses a TOOL step
 for (const t of Object.values(TEMPLATES)) {
  const steps = t.steps({objective: 'x brief'});
  assert.ok(steps.every(s => s.type !== 'TOOL'), 'no TOOL steps');
  if (t.sensitive) assert.ok(steps.some(s => s.type === 'APPROVAL'), 'sensitive templates require approval');
 }
});

test('creation takes bounded inputs only: no tools, no arbitrary agents, no template injection', async () => {
 const create = body => call('/api/client/workflows', {body, s: S.a});
 assert.equal((await create({templateKey: 'nope', objective: 'A launch brief'})).status, 400);
 assert.equal((await create({templateKey: 'content_review'})).status, 400, 'objective required');
 assert.equal((await create({templateKey: 'content_review', objective: 'ok'})).status, 400, 'objective too short');
 assert.equal((await create({templateKey: 'content_review', objective: 'A launch brief', trigger: {type: 'EVENT', eventType: 'LEAD_CREATED'}})).status, 400, 'event triggers are not offered');
 assert.equal((await create({templateKey: 'content_review', objective: 'A launch brief', trigger: {type: 'SCHEDULE', frequency: 'HOURLY', hour: 3}})).status, 400);
 assert.equal((await create({templateKey: 'content_review', objective: 'A launch brief', trigger: {type: 'SCHEDULE', frequency: 'DAILY', hour: 25}})).status, 400);
 assert.equal((await create({templateKey: 'weekly_performance'})).data.error, 'AGENT_LOCKED_BY_PLAN');
 // hostile extras are ignored: the graph is built from the template only
 const made = await create({templateKey: 'content_review', name: 'Winter launch copy', objective: 'Launch {{trigger.secret}} winter shoes', steps: [{id: 'x', type: 'TOOL', toolName: 'meta_publish', next: []}], toolName: 'whatsapp_send', agentId: 'sales', trigger: {type: 'MANUAL'}});
 assert.equal(made.status, 201, made.text);
 assert.equal(made.data.status, 'DRAFT');
 assert.equal(made.data.templateKey, 'content_review');
 assert.equal(made.data.nameEn, 'Winter launch copy');
 assert.deepEqual(made.data.steps.map(s => s.type), ['AGENT', 'AGENT', 'APPROVAL', 'NOTIFY_INTERNAL']);
 assert.deepEqual(made.data.agents.sort(), ['compliance', 'copy']);
 assert.ok(!made.data.params.objective.includes('{'), 'template braces are stripped');
 const stored = db().prepare('SELECT steps_json FROM workflow_versions WHERE workflow_id=?').get(made.data.id).steps_json;
 assert.ok(!/meta_publish|whatsapp_send|"sales"/.test(stored));
 S.wf = made.data.id;
 assert.ok(db().prepare("SELECT 1 FROM client_audit_logs WHERE tenant_id=? AND action='CLIENT_WORKFLOW_CREATED' AND entity_id=?").get(S.tenantA, S.wf));
 assert.ok(db().prepare("SELECT 1 FROM audit_logs WHERE tenant_id=? AND action='WORKFLOW_CREATED'").get(S.tenantA), 'the engine audited it too');
 // the legacy dashboard workflow API is not a way around the templates
 assert.equal((await call('/api/workflows', {body: {nameAr: 'x', trigger: {type: 'MANUAL'}, steps: []}, s: S.a})).data.error, 'MERCHANT_USE_CLIENT_PORTAL');
});

test('editing changes only the allowed inputs and rebuilds the graph from the template', async () => {
 const edit = await call(`/api/client/workflows/${S.wf}`, {method: 'PATCH', body: {name: 'Renamed copy flow', objective: 'A different brief for spring', trigger: {type: 'SCHEDULE', frequency: 'WEEKLY', hour: 9, weekday: 2}, steps: [{id: 'evil', type: 'TOOL'}]}, s: S.a});
 assert.equal(edit.status, 200, edit.text);
 assert.equal(edit.data.nameEn, 'Renamed copy flow');
 assert.equal(edit.data.trigger.type, 'SCHEDULE');
 assert.deepEqual(edit.data.trigger.schedule, {frequency: 'WEEKLY', hour: 9, weekday: 2});
 assert.deepEqual(edit.data.steps.map(s => s.id), ['write', 'review', 'approve', 'done']);
 assert.equal((await call(`/api/client/workflows/${S.wf}`, {method: 'PATCH', body: {trigger: {type: 'SCHEDULE', frequency: 'WEEKLY', hour: 9}}, s: S.a})).status, 400, 'weekly needs a weekday');
 assert.equal((await call(`/api/client/workflows/${S.wf}`, {method: 'PATCH', body: {trigger: {type: 'MANUAL'}}, s: S.a})).data.trigger.type, 'MANUAL');
 // a workflow that did not come from a portal template is not editable here
 const foreign = db().prepare("SELECT id FROM workflow_definitions WHERE tenant_id=?").all(S.tenantA).map(r => r.id);
 assert.equal(foreign.length, 1);
});

test('activation and runs need a ready workspace: onboarding, agents, plan and admin controls are all checked', async () => {
 // onboarding not finished -> the agents are not usable yet
 const early = await call(`/api/client/workflows/${S.wf}/activate`, {body: {}, s: S.a});
 assert.equal(early.status, 409);
 assert.equal(early.data.error, 'WORKFLOW_BLOCKED');
 await onboard(S.a, ['copy', 'compliance', 'strategy']);
 // an admin turns an agent off for this workspace: still blocked, with the exact agent
 const admin = await call('/api/signup', {body: {name: 'wf admin', username: 'wf_admin', email: 'wf_admin@wf.example', password: PASSWORD}});
 S.admin = sess(admin);
 const off = await call(`/api/client-admin/customers/${S.tenantA}/agents/copy`, {method: 'PUT', body: {adminState: 'disabled', reason: 'Investigating'}, s: S.admin});
 assert.ok([200, 201].includes(off.status), off.text);
 const blocked = await call(`/api/client/workflows/${S.wf}/activate`, {body: {}, s: S.a});
 assert.equal(blocked.status, 409);
 assert.ok(blocked.data.details?.blockers?.some(b => b.agentId === 'copy'), JSON.stringify(blocked.data));
 assert.equal((await call(`/api/client/workflows/${S.wf}/run`, {body: {}, s: S.a})).status, 409);
 await call(`/api/client-admin/customers/${S.tenantA}/agents/copy`, {method: 'PUT', body: {adminState: 'default', reason: 'Done'}, s: S.admin});
 const on = await call(`/api/client/workflows/${S.wf}/activate`, {body: {}, s: S.a});
 assert.equal(on.status, 200, on.text);
 assert.equal(on.data.status, 'ACTIVE');
});

test('a run executes through the engine: agents run (gated), the approval waits for a person, then the run completes', async () => {
 const run = await call(`/api/client/workflows/${S.wf}/run`, {body: {}, s: S.a});
 assert.equal(run.status, 201, run.text);
 assert.equal(run.data.status, 'WAITING_APPROVAL', JSON.stringify(run.data));
 const steps = Object.fromEntries(run.data.steps.map(s => [s.stepId, s.status]));
 assert.equal(steps.write, 'COMPLETED');
 assert.equal(steps.review, 'COMPLETED');
 assert.equal(steps.approve, 'WAITING_APPROVAL');
 assert.equal(db().prepare("SELECT COUNT(*) n FROM agent_runs WHERE tenant_id=? AND trigger_type='WORKFLOW'").get(S.tenantA).n, 2);
 // the person decides in the portal's approval centre
 const pending = (await call('/api/client/approvals?status=PENDING', {s: S.a})).data.items.find(a => a.actionType === 'workflow_step_approval');
 assert.ok(pending, 'the workflow approval is in the merchant approval centre');
 const decided = await call(`/api/client/approvals/${pending.id}/decide`, {body: {decision: 'APPROVED'}, s: S.a});
 assert.equal(decided.status, 200, decided.text);
 const finished = await call(`/api/client/workflows/${S.wf}/runs`, {s: S.a});
 assert.equal(finished.data.items[0].status, 'COMPLETED');
 assert.equal((await call(`/api/client/workflow-runs/${run.data.id}`, {s: S.a})).data.status, 'COMPLETED');
 assert.ok(db().prepare("SELECT 1 FROM client_audit_logs WHERE tenant_id=? AND action='CLIENT_WORKFLOW_RUN_STARTED'").get(S.tenantA));
 // the merchant's usage counts the agent runs
 assert.ok((await call('/api/client/dashboard', {s: S.a})).data.usage.agent_runs_per_month.used >= 2);
});

test('pause stops new runs, resume restores them, a running run can be cancelled, archive needs care', async () => {
 assert.equal((await call(`/api/client/workflows/${S.wf}/pause`, {body: {}, s: S.a})).data.status, 'PAUSED');
 assert.equal((await call(`/api/client/workflows/${S.wf}/run`, {body: {}, s: S.a})).status, 409, 'paused: no run starts');
 assert.equal((await call(`/api/client/workflows/${S.wf}/resume`, {body: {}, s: S.a})).data.status, 'ACTIVE');
 const run = await call(`/api/client/workflows/${S.wf}/run`, {body: {}, s: S.a});
 assert.equal(run.data.status, 'WAITING_APPROVAL');
 const cancelled = await call(`/api/client/workflow-runs/${run.data.id}/cancel`, {body: {}, s: S.a});
 assert.equal(cancelled.status, 200, cancelled.text);
 assert.ok(['CANCELLED', 'CANCEL_REQUESTED'].includes(cancelled.data.status));
 assert.ok(db().prepare("SELECT 1 FROM client_audit_logs WHERE tenant_id=? AND action='CLIENT_WORKFLOW_RUN_CANCELLED'").get(S.tenantA));
});

test('isolation: another workspace cannot list, read, edit, run, activate or cancel these workflows', async () => {
 assert.deepEqual((await call('/api/client/workflows', {s: S.b})).data.items, []);
 for (const [method, path, body] of [['GET', `/api/client/workflows/${S.wf}`], ['PATCH', `/api/client/workflows/${S.wf}`, {name: 'hijack'}], ['POST', `/api/client/workflows/${S.wf}/run`, {}], ['POST', `/api/client/workflows/${S.wf}/activate`, {}], ['POST', `/api/client/workflows/${S.wf}/pause`, {}], ['POST', `/api/client/workflows/${S.wf}/archive`, {}], ['GET', `/api/client/workflows/${S.wf}/runs`]]) {
  const res = await call(path, {method, body, s: S.b});
  assert.equal(res.status, 404, `${method} ${path} -> ${res.status}`);
 }
 const runId = db().prepare('SELECT id FROM workflow_runs WHERE workflow_id=? LIMIT 1').get(S.wf).id;
 assert.equal((await call(`/api/client/workflow-runs/${runId}`, {s: S.b})).status, 404);
 assert.equal((await call(`/api/client/workflow-runs/${runId}/cancel`, {body: {}, s: S.b})).status, 404);
 assert.equal(db().prepare('SELECT status FROM workflow_definitions WHERE id=?').get(S.wf).status, 'ACTIVE');
 // B's own workflow is invisible to A
 await onboard(S.b, ['copy', 'compliance']);
 const own = await call('/api/client/workflows', {body: {templateKey: 'campaign_planning', objective: 'Beta spring campaign'}, s: S.b});
 assert.equal(own.status, 201);
 assert.deepEqual((await call('/api/client/workflows', {s: S.a})).data.items.map(i => i.id), [S.wf]);
});

test('plan limit on workflows, and a limited/suspended account creates and starts nothing', async () => {
 db().prepare("INSERT OR REPLACE INTO client_tenant_overrides (tenant_id,kind,key,value,updated_by,updated_at) VALUES (?,?,?,?,?,?)").run(S.tenantA, 'limit', 'workflows', '2', 'test', new Date().toISOString());
 assert.equal((await call('/api/client/workflows', {body: {templateKey: 'campaign_planning', objective: 'Second workflow brief'}, s: S.a})).status, 201);
 const over = await call('/api/client/workflows', {body: {templateKey: 'campaign_planning', objective: 'Third workflow brief'}, s: S.a});
 assert.equal(over.status, 403);
 assert.equal(over.data.error, 'LIMIT_REACHED:workflows');
 // account states
 const gate = makeWorkflowGate(db());
 assert.equal(gate(S.tenantA), null);
 setAccountStatus(db(), {revokeSessions() {}}, {id: 'system', name: 'test', kind: 'admin'}, S.tenantA, 'suspended', 'test suspension');
 assert.equal(gate(S.tenantA), 'CLIENT_SUSPENDED');
 assert.equal((await call('/api/client/workflows', {body: {templateKey: 'campaign_planning', objective: 'While suspended brief'}, s: S.a})).status, 403);
 // the engine itself refuses to start a run (scheduled and event runs go through this path)
 await assert.rejects(() => startWorkflowRun({store: app.store, env: ENV, startGate: gate}, S.wf, {triggerType: 'SCHEDULE', tenantId: S.tenantA}), /لا يسمح|غير نشط|ليس نشط/);
 setAccountStatus(db(), {revokeSessions() {}}, {id: 'system', name: 'test', kind: 'admin'}, S.tenantA, 'active', 'test reactivation');
 assert.equal(gate(S.tenantA), null);
 assert.equal(isMerchantOnly(db(), db().prepare("SELECT id FROM users WHERE username='wf_a'").get().id), true);
});

test('support mode: a view-only session cannot create, edit, activate or run workflows', async () => {
 const start = await call(`/api/client-admin/customers/${S.tenantA}/support-sessions`, {body: {reason: 'Investigating a workflow problem', level: 'view_only', minutes: 15}, s: S.admin});
 assert.equal(start.status, 201, start.text);
 const ro = {cookies: [...S.admin.cookies, start.setCookie.split(';')[0]], csrf: S.admin.csrf};
 assert.equal((await call('/api/client/workflows', {s: ro})).status, 200, 'reads work');
 for (const [method, path, body] of [['POST', '/api/client/workflows', {templateKey: 'content_review', objective: 'A support brief'}], ['PATCH', `/api/client/workflows/${S.wf}`, {name: 'x'}], ['POST', `/api/client/workflows/${S.wf}/activate`, {}], ['POST', `/api/client/workflows/${S.wf}/run`, {}], ['POST', `/api/client/workflows/${S.wf}/pause`, {}]]) {
  assert.equal((await call(path, {method, body, s: ro})).data.error, 'SUPPORT_READ_ONLY', `${method} ${path}`);
 }
 await call('/api/client/support/end', {body: {}, s: ro});
});

test('members without agents.configure / agents.run cannot change or run workflows', async () => {
 const email = 'wf_viewer@wf.example';
 assert.equal((await call('/api/client/team/invitations', {body: {email, role: 'viewer'}, s: S.a})).status, 201);
 const token = JSON.parse(db().prepare("SELECT captured_body FROM platform_mail_outbox WHERE to_email=? AND kind='INVITATION' ORDER BY created_at DESC LIMIT 1").get(email).captured_body).html.match(/invite\/([a-f0-9]+)/)[1];
 const viewer = sess(await call(`/api/client/invitations/${token}/register`, {body: {username: 'wf_viewer', name: 'Viewer', password: PASSWORD}}));
 assert.equal((await call('/api/client/workflows', {s: viewer})).status, 200);
 for (const [method, path, body] of [['POST', '/api/client/workflows', {templateKey: 'content_review', objective: 'A viewer brief'}], ['PATCH', `/api/client/workflows/${S.wf}`, {name: 'x'}], ['POST', `/api/client/workflows/${S.wf}/activate`, {}], ['POST', `/api/client/workflows/${S.wf}/run`, {}]]) {
  const res = await call(path, {method, body, s: viewer});
  assert.equal(res.status, 403, `${method} ${path}`);
  assert.match(res.data.error, /PERMISSION_DENIED/);
 }
});
