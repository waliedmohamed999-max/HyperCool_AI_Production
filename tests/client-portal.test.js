import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../src/application.js';
import {installClient, uninstallClient, CLIENT_TABLES, RETAINED_ON_UNINSTALL} from '../src/client/schema.js';
import {makeRunGate} from '../src/client/index.js';

// Merchant portal, end to end over HTTP with a mocked LLM transport (everything else - DB, gates, approvals,
// audit, isolation - is real). The mocked provider answers every agent call with a schema-valid NEEDS_DATA decision.
const ENV = {PLATFORM_MAIL_TRANSPORT: 'capture', PLATFORM_ADMIN_USERNAMES: 'ca_admin,ca_admin2', SUPPORT_ACCESS_USERNAMES: 'ca_admin', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'test-model', INTEGRATION_ENCRYPTION_KEY: 'cd'.repeat(32)};
const llm = async () => new Response(JSON.stringify({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({status: 'NEEDS_DATA', action: 'NONE', rationale: 'Mock provider reply', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: ['none'], payload: null})}], usage: {input_tokens: 11, output_tokens: 7}}), {status: 200, headers: {'content-type': 'application/json'}});
let app, base, dir;
before(async () => {
 dir = await mkdtemp(join(tmpdir(), 'frost-client-'));
 app = await createApp({dataDir: dir, env: ENV, fetcher: llm});
 await new Promise(r => app.server.listen(0, '127.0.0.1', r));
 base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await new Promise(r => app.server.close(r)); app.store.close(); await rm(dir, {recursive: true, force: true}); });

const db = () => app.store.db;
async function call(path, {method, body, s, headers = {}} = {}) {
 const cookies = s ? s.cookies.join('; ') : '';
 const res = await fetch(base + path, {method: method || (body ? 'POST' : 'GET'), headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(s ? {cookie: cookies, 'x-csrf-token': s.csrf} : {}), ...headers}, ...(body ? {body: JSON.stringify(body)} : {})});
 const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
 const setCookie = res.headers.get('set-cookie');
 return {status: res.status, data, setCookie, csrf: data?.csrf};
}
const sess = r => ({cookies: [r.setCookie.split(';')[0]], csrf: r.csrf});
const PASSWORD = 'merchant-long-password-1';
const REG = {name: 'Owner', phone: '+966500000100', country: 'SA', businessType: 'retail', businessSize: 'small', ecommercePlatform: 'salla', teamSize: 3, goals: ['content', 'grow_sales'], planSlug: 'starter', acceptTerms: true, locale: 'en'};
async function registerMerchant(username, businessName) {
 const r = await call('/api/client/register', {body: {...REG, username, email: `${username}@m.example`, password: PASSWORD, businessName}});
 assert.equal(r.status, 201, JSON.stringify(r.data));
 return sess(r);
}
async function login(username) { const r = await call('/api/login', {body: {username, password: PASSWORD}}); assert.equal(r.status, 200); return sess(r); }
async function signupPlain(username) { const r = await call('/api/signup', {body: {name: username, username, email: `${username}@x.example`, password: PASSWORD}}); assert.equal(r.status, 201); return sess(r); }
async function finishOnboarding(s, agents) {
 assert.equal((await call('/api/client/onboarding/1', {method: 'PUT', body: {businessName: 'Store', country: 'SA', offering: 'Shoes and bags', audience: 'Young shoppers'}, s})).status, 200);
 assert.equal((await call('/api/client/onboarding/2', {method: 'PUT', body: {goals: ['content']}, s})).status, 200);
 assert.equal((await call('/api/client/onboarding/3', {method: 'PUT', body: {}, s})).status, 200);
 assert.equal((await call('/api/client/onboarding/4', {method: 'PUT', body: {agents}, s})).status, 200);
 assert.equal((await call('/api/client/onboarding/5', {method: 'PUT', body: {autonomy: 'approval_required'}, s})).status, 200);
 const done = await call('/api/client/onboarding/complete', {body: {}, s});
 assert.equal(done.status, 200, JSON.stringify(done.data));
}
const inviteToken = email => JSON.parse(db().prepare("SELECT captured_body FROM platform_mail_outbox WHERE to_email=? AND kind='INVITATION' ORDER BY created_at DESC LIMIT 1").get(email).captured_body).html.match(/invite\/([a-f0-9]+)/)[1];
const tenantOf = username => db().prepare('SELECT m.tenant_id t FROM client_members m JOIN users u ON u.id=m.user_id WHERE u.username=?').get(username).t;
const S = {};

test('public config lists real merchant plans; registration creates an isolated workspace', async () => {
 const cfg = await call('/api/client/public/config');
 assert.deepEqual(cfg.data.plans.map(p => p.slug), ['starter', 'growth', 'scale']);
 assert.equal((await call('/api/client/register', {body: {...REG, username: 'bad', email: 'bad@m.example', password: PASSWORD, businessName: 'X', acceptTerms: false}})).status, 400);
 S.a = await registerMerchant('ca_merchant_a', 'Alpha Store');
 const me = await call('/api/client/me', {s: S.a});
 assert.equal(me.status, 200);
 assert.equal(me.data.role, 'workspace_owner');
 assert.equal(me.data.access.accountStatus, 'trial');
 assert.equal(me.data.access.plan.slug, 'starter');
 assert.equal(me.data.workspace.name, 'Alpha Store');
 assert.equal(me.data.onboarding.completed, false);
 assert.ok(me.data.permissions.includes('team.manage'));
 // the platform's own trial clock is cleared so it can never suspend a merchant behind the portal's back
 const t = db().prepare('SELECT status,trial_expires_at FROM tenants WHERE id=?').get(tenantOf('ca_merchant_a'));
 assert.equal(t.status, 'ACTIVE');
 assert.equal(t.trial_expires_at, null);
 S.tenantA = tenantOf('ca_merchant_a');
 assert.equal((await call('/api/client/me')).status, 401);
});

test('the 12 registry agents are listed with real, layered states; nothing runs before onboarding', async () => {
 const list = await call('/api/client/agents', {s: S.a});
 assert.equal(list.data.items.length, 12);
 const byKey = Object.fromEntries(list.data.items.map(a => [a.key, a]));
 assert.deepEqual(Object.keys(byKey).sort(), ['compliance', 'copy', 'creative', 'followup', 'frost', 'intelligence', 'leads', 'memory', 'performance', 'publishing', 'sales', 'strategy']);
 assert.equal(byKey.strategy.status, 'setup_required');
 assert.ok(byKey.strategy.reasons.includes('ONBOARDING_INCOMPLETE'));
 assert.equal(byKey.sales.status, 'locked_by_plan');
 assert.equal(byKey.sales.lockedLayer, 'plan');
 const early = await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'Plan the launch'}, s: S.a});
 assert.equal(early.status, 409);
 assert.equal(early.data.error, 'ONBOARDING_INCOMPLETE');
 // validation
 assert.equal((await call('/api/client/onboarding/complete', {body: {}, s: S.a})).data.error, 'ONBOARDING_INCOMPLETE:1');
 assert.equal((await call('/api/client/onboarding/4', {method: 'PUT', body: {agents: ['sales']}, s: S.a})).status, 403, 'a locked agent cannot be selected');
 await finishOnboarding(S.a, ['strategy', 'copy', 'compliance']);
 const after = Object.fromEntries((await call('/api/client/agents', {s: S.a})).data.items.map(a => [a.key, a]));
 assert.equal(after.strategy.usable, true);
 assert.ok(['available', 'connected'].includes(after.strategy.status), after.strategy.status);
 assert.equal(after.creative.status, 'paused', 'not chosen in onboarding');
 assert.equal(after.sales.status, 'locked_by_plan');
});

test('tasks: low-risk agent runs and completes; plan-locked agents are refused by the API and by the runtime gate', async () => {
 const done = await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'Plan the launch', description: 'Two week plan', wait: true}, s: S.a});
 assert.equal(done.status, 201, JSON.stringify(done.data));
 assert.equal(done.data.status, 'completed');
 assert.ok(done.data.runId);
 assert.equal(done.data.usage.tokensInput, 11);
 const detail = await call(`/api/client/tasks/${done.data.id}`, {s: S.a});
 assert.equal(detail.data.status, 'completed');

 const locked = await call('/api/client/tasks', {body: {agentId: 'sales', title: 'Quote a customer'}, s: S.a});
 assert.equal(locked.status, 403);
 assert.equal(locked.data.error, 'AGENT_LOCKED_BY_PLAN');
 // legacy API is closed to merchant sessions, and the runtime hook holds for every other caller
 assert.equal((await call('/api/agents/sales/run', {body: {scenario: 'x'}, s: S.a})).data.error, 'MERCHANT_USE_CLIENT_PORTAL');
 assert.equal(makeRunGate(db(), ENV)(S.tenantA, 'sales'), 'AGENT_LOCKED_BY_PLAN');
 assert.equal(makeRunGate(db(), ENV)(S.tenantA, 'strategy'), null);
 assert.equal(makeRunGate(db(), ENV)(db().prepare('SELECT id FROM tenants ORDER BY created_at LIMIT 1').get().id, 'sales'), null, 'a tenant without a merchant account is not restricted');
 // paused by the merchant -> not usable
 const paused = await call('/api/client/agents/copy/settings', {method: 'PATCH', body: {paused: true}, s: S.a});
 assert.equal(paused.data.agent.status, 'paused');
 await call('/api/client/agents/copy/settings', {method: 'PATCH', body: {paused: false}, s: S.a});
});

test('approval policy: medium-risk agent waits for approval; approval runs it; viewers cannot approve; rejection cancels', async () => {
 const t = await call('/api/client/tasks', {body: {agentId: 'compliance', title: 'Review the spring banner', wait: true}, s: S.a});
 assert.equal(t.status, 201);
 assert.equal(t.data.status, 'waiting_for_approval');
 assert.equal(t.data.approvalStatus, 'pending');
 assert.equal(t.data.runId, null, 'nothing ran before approval');
 const approvals = await call('/api/client/approvals?status=PENDING', {s: S.a});
 assert.equal(approvals.data.total, 1);
 const approvalId = approvals.data.items[0].id;
 assert.equal(approvals.data.items[0].actionType, 'client_task_execution');
 assert.equal((await call(`/api/client/approvals/${approvalId}/decide`, {body: {decision: 'REJECTED'}, s: S.a})).status, 400, 'rejection needs a reason');
 const ok = await call(`/api/client/approvals/${approvalId}/decide`, {body: {decision: 'APPROVED'}, s: S.a});
 assert.equal(ok.status, 200, JSON.stringify(ok.data));
 assert.equal(ok.data.task.status, 'completed');
 assert.equal((await call(`/api/client/approvals/${approvalId}/decide`, {body: {decision: 'APPROVED'}, s: S.a})).status, 409, 'a decision is final');

 const t2 = await call('/api/client/tasks', {body: {agentId: 'compliance', title: 'Review the summer banner', wait: true}, s: S.a});
 const p2 = (await call('/api/client/approvals?status=PENDING', {s: S.a})).data.items[0].id;
 const no = await call(`/api/client/approvals/${p2}/decide`, {body: {decision: 'REJECTED', reason: 'Not now'}, s: S.a});
 assert.equal(no.data.task.status, 'cancelled');
 assert.equal(db().prepare('SELECT status FROM client_tasks WHERE id=?').get(t2.data.id).status, 'cancelled');
 // scheduled + draft + cancel + retry bookkeeping
 const later = await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'Future plan', scheduledAt: new Date(Date.now() + 3600000).toISOString()}, s: S.a});
 assert.equal(later.data.status, 'queued');
 const cancelled = await call(`/api/client/tasks/${later.data.id}/cancel`, {body: {}, s: S.a});
 assert.equal(cancelled.data.status, 'cancelled');
 assert.equal((await call(`/api/client/tasks/${later.data.id}/cancel`, {body: {}, s: S.a})).status, 409);
 const draft = await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'Draft idea', draft: true}, s: S.a});
 assert.equal(draft.data.status, 'draft');
 const submitted = await call(`/api/client/tasks/${draft.data.id}/submit`, {body: {wait: true}, s: S.a});
 assert.equal(submitted.data.status, 'completed');
});

test('team: invitations with workspace roles, permissions enforced on the server, user limit from the plan', async () => {
 const inv = await call('/api/client/team/invitations', {body: {email: 'op@m.example', role: 'operator'}, s: S.a});
 assert.equal(inv.status, 201, JSON.stringify(inv.data));
 assert.equal(inv.data.delivered, true);
 const acc = await call(`/api/client/invitations/${inviteToken('op@m.example')}/register`, {body: {username: 'ca_operator', name: 'Op', password: PASSWORD}});
 assert.equal(acc.status, 200, JSON.stringify(acc.data));
 S.op = sess(acc);
 const me = await call('/api/client/me', {s: S.op});
 assert.equal(me.data.role, 'operator');
 assert.equal(me.data.workspace.name, 'Store');
 assert.ok(!me.data.permissions.includes('approvals.review'));
 // operator may create tasks but not approve or manage the team
 const task = await call('/api/client/tasks', {body: {agentId: 'compliance', title: 'Operator review', wait: true}, s: S.op});
 assert.equal(task.data.status, 'waiting_for_approval');
 const pending = (await call('/api/client/approvals?status=PENDING', {s: S.op})).data.items[0].id;
 assert.equal((await call(`/api/client/approvals/${pending}/decide`, {body: {decision: 'APPROVED'}, s: S.op})).data.error, 'PERMISSION_DENIED:approvals.review');
 assert.equal((await call('/api/client/team/invitations', {body: {email: 'x@m.example', role: 'viewer'}, s: S.op})).data.error, 'PERMISSION_DENIED:team.manage');

 const v = await call('/api/client/team/invitations', {body: {email: 'view@m.example', role: 'viewer'}, s: S.a});
 assert.equal(v.status, 201);
 S.viewer = sess(await call(`/api/client/invitations/${inviteToken('view@m.example')}/register`, {body: {username: 'ca_viewer', name: 'Vi', password: PASSWORD}}));
 assert.equal((await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'Viewer task'}, s: S.viewer})).data.error, 'PERMISSION_DENIED:tasks.create');
 assert.equal((await call('/api/client/agents/strategy/settings', {method: 'PATCH', body: {paused: true}, s: S.viewer})).data.error, 'PERMISSION_DENIED:agents.configure');
 assert.equal((await call('/api/client/agents', {s: S.viewer})).status, 200);
 // starter allows 3 users: owner + operator + viewer are in, a 4th invitation is refused
 const over = await call('/api/client/team/invitations', {body: {email: 'fourth@m.example', role: 'viewer'}, s: S.a});
 assert.equal(over.status, 403);
 assert.equal(over.data.error, 'LIMIT_REACHED:users');
 // last owner protection + role change
 const team = (await call('/api/client/team', {s: S.a})).data;
 assert.equal(team.members.length, 3);
 const owner = team.members.find(m => m.role === 'workspace_owner');
 assert.equal((await call(`/api/client/team/members/${owner.userId}`, {method: 'PATCH', body: {role: 'viewer'}, s: S.a})).status, 400, 'cannot edit yourself');
 const opMember = team.members.find(m => m.username === 'ca_operator');
 assert.equal((await call(`/api/client/team/members/${opMember.userId}`, {method: 'PATCH', body: {role: 'manager'}, s: S.a})).status, 200);
 assert.equal((await call('/api/client/me', {s: S.op})).data.role, 'manager');
 assert.equal((await call(`/api/client/team/members/${opMember.userId}`, {method: 'PATCH', body: {status: 'suspended'}, s: S.a})).status, 200);
 assert.equal((await call('/api/client/me', {s: S.op})).status, 401, 'a suspended member loses the session at once');
});

test('tenant isolation: merchant B never sees or touches merchant A', async () => {
 S.b = await registerMerchant('ca_merchant_b', 'Beta Store');
 S.tenantB = tenantOf('ca_merchant_b');
 await finishOnboarding(S.b, ['strategy', 'compliance']);
 const aTask = db().prepare('SELECT id FROM client_tasks WHERE tenant_id=? LIMIT 1').get(S.tenantA).id;
 assert.equal((await call('/api/client/tasks', {s: S.b})).data.total, 0);
 assert.equal((await call(`/api/client/tasks/${aTask}`, {s: S.b})).status, 404);
 assert.equal((await call(`/api/client/tasks/${aTask}/cancel`, {body: {}, s: S.b})).status, 404);
 const aApproval = db().prepare('SELECT id FROM agent_approvals WHERE tenant_id=? LIMIT 1').get(S.tenantA).id;
 assert.equal((await call(`/api/client/approvals/${aApproval}/decide`, {body: {decision: 'APPROVED'}, s: S.b})).status, 404);
 assert.equal((await call('/api/client/approvals', {s: S.b})).data.total, 0);
 const team = (await call('/api/client/team', {s: S.b})).data;
 assert.deepEqual(team.members.map(m => m.username), ['ca_merchant_b']);
 // a tenant id supplied by the client is ignored
 const spoof = await call(`/api/client/tasks?tenantId=${S.tenantA}`, {s: S.b, headers: {'x-tenant-id': S.tenantA}});
 assert.equal(spoof.data.total, 0);
 assert.equal((await call('/api/client/audit', {s: S.b})).data.items.every(a => a.tenantId === S.tenantB), true);
 // B's own work stays in B, and legacy global routes are closed to merchants
 const own = await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'Beta plan', wait: true}, s: S.b});
 assert.equal(own.data.status, 'completed');
 assert.equal(db().prepare('SELECT COUNT(*) n FROM client_tasks WHERE tenant_id=?').get(S.tenantA).n > 0, true);
 for (const p of ['/api/users', '/api/agents/cost-summary', '/api/state', '/api/workspaces/members']) assert.equal((await call(p, {s: S.b})).data.error, 'MERCHANT_USE_CLIENT_PORTAL', p);
 assert.equal((await call('/api/users/x/reset-access', {body: {password: 'a-long-new-password'}, s: S.b})).data.error, 'MERCHANT_USE_CLIENT_PORTAL');
 // a merchant is not a platform admin
 assert.equal((await call('/api/client-admin/customers', {s: S.b})).status, 403);
 assert.equal((await call(`/api/client-admin/customers/${S.tenantA}/support-sessions`, {body: {reason: 'curiosity about data'}, s: S.b})).status, 403);
});

test('platform admin: customer management, overrides, agent controls, plan changes, suspension and grace', async () => {
 S.admin = await signupPlain('ca_admin');
 const ov = await call('/api/client-admin/overview', {s: S.admin});
 assert.equal(ov.status, 200);
 assert.equal(ov.data.customers.total, 2);
 assert.equal(ov.data.customers.trial, 2);
 const list = await call('/api/client-admin/customers?q=ca_merchant_a', {s: S.admin});
 assert.equal(list.data.total, 1);
 assert.equal(list.data.items[0].plan.slug, 'starter');
 const detail = await call(`/api/client-admin/customers/${S.tenantA}`, {s: S.admin});
 assert.equal(detail.data.agents.length, 12);
 assert.equal(detail.data.team.members.length, 3);
 assert.ok(detail.data.audit.length > 3);
 assert.equal(detail.data.owner.email, 'ca_merchant_a@m.example');

 // agent control needs a reason, then disables an entitled agent for ONE customer
 assert.equal((await call(`/api/client-admin/customers/${S.tenantA}/agents/strategy`, {method: 'PUT', body: {adminState: 'disabled'}, s: S.admin})).status, 400);
 assert.equal((await call(`/api/client-admin/customers/${S.tenantA}/agents/strategy`, {method: 'PUT', body: {adminState: 'disabled', reason: 'abuse review'}, s: S.admin})).status, 200);
 const denied = await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'Should be blocked'}, s: S.a});
 assert.equal(denied.data.error, 'AGENT_DISABLED_BY_ADMIN');
 assert.equal((await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'B is unaffected', wait: true}, s: S.b})).data.status, 'completed');
 await call(`/api/client-admin/customers/${S.tenantA}/agents/strategy`, {method: 'PUT', body: {adminState: 'default', reason: 'review done'}, s: S.admin});
 // force-enable a locked agent + admin-forced approval level (merchant cannot loosen it)
 await call(`/api/client-admin/customers/${S.tenantA}/overrides`, {method: 'PUT', body: {entitlements: {'agent.sales': 'allow'}, reason: 'pilot'}, s: S.admin});
 const sales = (await call('/api/client/agents/sales', {s: S.a})).data.agent;
 assert.equal(sales.usable, true, 'override unlocked the agent');
 await call(`/api/client-admin/customers/${S.tenantA}/agents/sales`, {method: 'PUT', body: {approvalLevel: 'manual', reason: 'strict pilot'}, s: S.admin});
 assert.equal((await call('/api/client/agents/sales/settings', {method: 'PATCH', body: {approvalLevel: 'limited_autonomy'}, s: S.a})).data.error, 'APPROVAL_LEVEL_TOO_LOOSE');
 assert.equal((await call('/api/client/agents/sales', {s: S.a})).data.agent.approvalLevel, 'manual');
 // platform-wide switch-off beats everything, per-plan availability
 await call('/api/client-admin/agents/frost/platform', {method: 'PUT', body: {available: false, reason: 'incident'}, s: S.admin});
 assert.equal((await call('/api/client/agents/frost', {s: S.b})).data.agent.status, 'unavailable');
 await call('/api/client-admin/agents/frost/platform', {method: 'PUT', body: {available: true, reason: 'resolved'}, s: S.admin});
 // limits: a workspace-level task cap from an override
 await call(`/api/client-admin/customers/${S.tenantB}/overrides`, {method: 'PUT', body: {limits: {tasks_per_month: 1}, reason: 'test cap'}, s: S.admin});
 const cap = await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'Second task this month'}, s: S.b});
 assert.equal(cap.data.error, 'LIMIT_REACHED:tasks_per_month');
 await call(`/api/client-admin/customers/${S.tenantB}/overrides`, {method: 'PUT', body: {limits: {tasks_per_month: 'inherit'}, reason: 'cap removed'}, s: S.admin});

 // plan change applies at once; suspension revokes sessions and blocks; reactivation restores
 const growth = db().prepare("SELECT id FROM client_plans WHERE slug='growth'").get().id;
 assert.equal((await call(`/api/client-admin/customers/${S.tenantB}/plan`, {body: {planId: growth, reason: 'upgrade'}, s: S.admin})).status, 200);
 assert.equal((await call('/api/client/agents/sales', {s: S.b})).data.agent.usable, true, 'growth includes the sales agent');
 assert.equal((await call(`/api/client-admin/customers/${S.tenantB}/status`, {body: {status: 'suspended', reason: 'payment dispute'}, s: S.admin})).status, 200);
 assert.equal((await call('/api/client/me', {s: S.b})).status, 401, 'sessions are revoked on suspension');
 S.b = await login('ca_merchant_b');
 assert.equal((await call('/api/client/me', {s: S.b})).data.access.accountStatus, 'suspended');
 assert.equal((await call('/api/client/agents', {s: S.b})).data.error, 'CLIENT_SUSPENDED');
 assert.equal((await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'x'}, s: S.b})).status, 403);
 assert.equal(makeRunGate(db(), ENV)(S.tenantB, 'strategy'), 'CLIENT_SUSPENDED');
 assert.equal((await call(`/api/client-admin/customers/${S.tenantB}/status`, {body: {status: 'active', reason: 'settled'}, s: S.admin})).status, 200);
 S.b = await login('ca_merchant_b');
 assert.equal((await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'Back in business', wait: true}, s: S.b})).data.status, 'completed');

 // trial expiry -> limited (reads work, new work stops, data kept); grace restores operation; renewal restores everything
 db().prepare("UPDATE client_subscriptions SET trial_ends_at='2020-01-01T00:00:00.000Z' WHERE tenant_id=? AND status='trial'").run(S.tenantA);
 const lim = await call('/api/client/me', {s: S.a});
 assert.equal(lim.data.access.accountStatus, 'limited');
 assert.equal((await call('/api/client/tasks', {s: S.a})).status, 200, 'history stays readable');
 assert.equal((await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'After expiry'}, s: S.a})).data.error, 'CLIENT_LIMITED');
 assert.equal((await call('/api/client/analytics', {s: S.a})).status, 200);
 const until = new Date(Date.now() + 5 * 86400000).toISOString();
 assert.equal((await call(`/api/client-admin/customers/${S.tenantA}/grace`, {body: {until, reason: 'renewal in progress'}, s: S.admin})).status, 200);
 assert.equal((await call('/api/client/me', {s: S.a})).data.access.accountStatus, 'past_due');
 assert.equal((await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'During grace', wait: true}, s: S.a})).data.status, 'completed');
 const scale = db().prepare("SELECT id FROM client_plans WHERE slug='scale'").get().id;
 await call(`/api/client-admin/customers/${S.tenantA}/plan`, {body: {planId: scale, reason: 'renewed'}, s: S.admin});
 assert.equal((await call('/api/client/me', {s: S.a})).data.access.accountStatus, 'active');
 assert.equal((await call('/api/client/tasks', {s: S.a})).data.total >= 4, true, 'nothing was deleted');
});

test('support mode: authorization, read-only enforcement, limited session, attribution, expiry, customer visibility', async () => {
 const tenant = S.tenantA;
 // who may start one
 assert.equal((await call(`/api/client-admin/customers/${tenant}/support-sessions`, {body: {reason: 'Investigating an agent failure'}, s: S.a})).status, 403);
 S.admin2 = await signupPlain('ca_admin2');
 assert.equal((await call(`/api/client-admin/customers/${tenant}/support-sessions`, {body: {reason: 'Investigating an agent failure'}, s: S.admin2})).data.error, 'SUPPORT_NOT_AUTHORIZED', 'admin outside SUPPORT_ACCESS_USERNAMES');
 assert.equal((await call(`/api/client-admin/customers/${tenant}/support-sessions`, {body: {reason: 'short'}, s: S.admin})).status, 400);
 assert.equal((await call(`/api/client-admin/customers/${tenant}/support-sessions`, {body: {reason: 'Investigating an agent failure', level: 'root'}, s: S.admin})).status, 400);
 // the admin has no access without a session
 assert.equal((await call('/api/client/tasks', {s: S.admin})).data.error, 'NO_CLIENT_WORKSPACE');

 const start = await call(`/api/client-admin/customers/${tenant}/support-sessions`, {body: {reason: 'Investigating an agent failure', ticket: 'T-1001', minutes: 30, level: 'view_only'}, s: S.admin});
 assert.equal(start.status, 201, JSON.stringify(start.data));
 assert.match(start.setCookie, /^hc_support=[a-f0-9]{64}; HttpOnly; SameSite=Strict/);
 const cookie = start.setCookie.split(';')[0];
 const inSupport = {cookies: [...S.admin.cookies, cookie], csrf: S.admin.csrf};
 const me = await call('/api/client/me', {s: inSupport});
 assert.equal(me.data.support.level, 'view_only');
 assert.equal(me.data.support.readOnly, true);
 assert.equal(me.data.workspace.name, 'Store');
 assert.equal((await call('/api/client/tasks', {s: inSupport})).status, 200, 'reads work');
 assert.equal((await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'Admin tries to write'}, s: inSupport})).data.error, 'SUPPORT_READ_ONLY');
 assert.equal((await call('/api/client/settings', {method: 'PATCH', body: {name: 'Hijack'}, s: inSupport})).data.error, 'SUPPORT_READ_ONLY');
 assert.equal((await call('/api/client/notifications/read', {body: {}, s: inSupport})).data.error, 'SUPPORT_READ_ONLY');
 assert.equal((await call('/api/client/support/page-view', {body: {path: '/client/agents'}, s: inSupport})).status, 200, 'page views are logged, not customer writes');
 // a second session cannot overlap; another admin cannot use this admin's cookie
 assert.equal((await call(`/api/client-admin/customers/${tenant}/support-sessions`, {body: {reason: 'Second overlapping session', level: 'limited'}, s: S.admin})).data.error, 'SUPPORT_SESSION_ACTIVE');
 assert.equal((await call('/api/client/me', {s: {cookies: [...S.admin2.cookies, cookie], csrf: S.admin2.csrf}})).data.error, 'NO_CLIENT_WORKSPACE', 'the token only works for the admin it was issued to');
 // the customer's owner sees it and was notified; an ordinary member without audit permission does not
 const sessions = (await call('/api/client/support', {s: S.a})).data.items;
 assert.equal(sessions.length, 1);
 assert.equal(sessions[0].ticket, 'T-1001');
 assert.equal(sessions[0].status, 'active');
 assert.equal((await call('/api/client/notifications', {s: S.a})).data.items.some(n => n.kind === 'support_started'), true);
 const sid = start.data.session.id;
 const events = db().prepare("SELECT kind FROM client_support_events WHERE session_id=?").all(sid).map(r => r.kind);
 assert.ok(events.includes('blocked') && events.includes('page_view') && events.includes('started'));

 // end it (from the portal bar), then a limited session that may act - with attribution and confirmation for sensitive actions
 const ended = await call('/api/client/support/end', {body: {}, s: inSupport});
 assert.equal(ended.data.session.status, 'ended');
 assert.equal((await call('/api/client/tasks', {s: inSupport})).data.error, 'NO_CLIENT_WORKSPACE', 'an ended session stops working immediately');
 const start2 = await call(`/api/client-admin/customers/${tenant}/support-sessions`, {body: {reason: 'Fixing the failed task together', minutes: 15, level: 'limited'}, s: S.admin});
 assert.equal(start2.status, 201);
 const s2 = {cookies: [...S.admin.cookies, start2.setCookie.split(';')[0]], csrf: S.admin.csrf};
 const made = await call('/api/client/tasks', {body: {agentId: 'strategy', title: 'Created by support', wait: true}, s: s2});
 assert.equal(made.status, 201, JSON.stringify(made.data));
 assert.equal(made.data.createdBy, db().prepare("SELECT id FROM users WHERE username='ca_admin'").get().id, 'the real actor is the admin');
 const row = db().prepare("SELECT * FROM client_audit_logs WHERE action='CLIENT_TASK_CREATED' AND entity_id=?").get(made.data.id);
 assert.equal(row.actor_kind, 'admin_support');
 assert.equal(row.performed_by_admin, row.actor_id);
 assert.equal(row.support_session_id, start2.data.session.id);
 assert.equal(row.on_behalf_of_user, db().prepare('SELECT owner_user_id o FROM client_profiles WHERE tenant_id=?').get(tenant).o);
 assert.equal(row.reason, 'Fixing the failed task together');
 // limited role: no team management, no ownership transfer, sensitive decisions need explicit confirmation
 assert.equal((await call('/api/client/team/invitations', {body: {email: 'z@m.example', role: 'viewer'}, s: s2})).data.error, 'PERMISSION_DENIED:team.manage');
 assert.match((await call('/api/client/team/transfer-ownership', {body: {userId: 'x', confirmName: 'x'}, s: s2})).data.error, /PERMISSION_DENIED|SUPPORT_FORBIDDEN/);
 const held = await call('/api/client/tasks', {body: {agentId: 'compliance', title: 'Needs approval in support', wait: true}, s: s2});
 const pend = (await call('/api/client/approvals?status=PENDING', {s: s2})).data.items.find(a => a.proposed?.title === 'Needs approval in support');
 assert.equal((await call(`/api/client/approvals/${pend.id}/decide`, {body: {decision: 'APPROVED'}, s: s2})).data.error, 'SUPPORT_CONFIRMATION_REQUIRED');
 assert.equal((await call(`/api/client/approvals/${pend.id}/decide`, {body: {decision: 'APPROVED', confirmSupport: true}, s: s2})).status, 200);
 const detail = await call(`/api/client/support/${start2.data.session.id}`, {s: S.a});
 assert.ok(detail.data.actions.some(a => a.action === 'CLIENT_TASK_CREATED'), 'the customer can see what was done');
 // another admin can revoke; an expired session is dead
 assert.equal((await call(`/api/client-admin/support-sessions/${start2.data.session.id}/revoke`, {body: {reason: 'policy'}, s: S.admin2})).data.status, 'revoked');
 assert.equal((await call('/api/client/tasks', {s: s2})).status, 403);
 const start3 = await call(`/api/client-admin/customers/${tenant}/support-sessions`, {body: {reason: 'A very short session', minutes: 5, level: 'view_only'}, s: S.admin});
 const s3 = {cookies: [...S.admin.cookies, start3.setCookie.split(';')[0]], csrf: S.admin.csrf};
 assert.equal((await call('/api/client/tasks', {s: s3})).status, 200);
 db().prepare("UPDATE client_support_sessions SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(start3.data.session.id);
 assert.equal((await call('/api/client/tasks', {s: s3})).data.error, 'NO_CLIENT_WORKSPACE');
 assert.equal(db().prepare('SELECT status FROM client_support_sessions WHERE id=?').get(start3.data.session.id).status, 'expired');
 // password / e-mail / ownership are simply not reachable through support mode
 assert.equal((await call('/api/users/x/reset-access', {body: {password: 'a-long-new-password'}, s: s3})).status >= 400, true);
 assert.throws(() => db().prepare("DELETE FROM client_audit_logs").run(), /append-only/);
 assert.throws(() => db().prepare("UPDATE client_support_events SET kind='x'").run(), /append-only/);
});

test('without an AI provider tasks fail honestly (nothing is faked)', async () => {
 const dir2 = await mkdtemp(join(tmpdir(), 'frost-client-noai-'));
 const {ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ...env2} = ENV;
 const app2 = await createApp({dataDir: dir2, env: env2, fetcher: llm});
 await new Promise(r => app2.server.listen(0, '127.0.0.1', r));
 const base2 = `http://127.0.0.1:${app2.server.address().port}`;
 try {
  const reg = await fetch(base2 + '/api/client/register', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...REG, username: 'noai_merchant', email: 'noai@m.example', password: PASSWORD, businessName: 'NoAI'})});
  const cookie = reg.headers.get('set-cookie').split(';')[0];
  const csrf = (await reg.json()).csrf;
  const h = {'Content-Type': 'application/json', cookie, 'x-csrf-token': csrf};
  const put = (n, b) => fetch(`${base2}/api/client/onboarding/${n}`, {method: 'PUT', headers: h, body: JSON.stringify(b)});
  await put(1, {businessName: 'NoAI', country: 'SA', offering: 'x'}); await put(2, {goals: ['content']}); await put(3, {}); await put(4, {agents: ['strategy']}); await put(5, {autonomy: 'approval_required'});
  await fetch(base2 + '/api/client/onboarding/complete', {method: 'POST', headers: h, body: '{}'});
  const agents = (await (await fetch(base2 + '/api/client/agents', {headers: h})).json()).items;
  assert.equal(agents.find(a => a.key === 'strategy').status, 'unavailable');
  assert.ok(agents.find(a => a.key === 'strategy').reasons.includes('AI_NOT_CONFIGURED'));
  const t = await (await fetch(base2 + '/api/client/tasks', {method: 'POST', headers: h, body: JSON.stringify({agentId: 'strategy', title: 'Try without AI', wait: true})})).json();
  assert.equal(t.status, 'failed');
  assert.equal(t.error, 'AI_NOT_CONFIGURED');
 } finally { await new Promise(r => app2.server.close(r)); app2.store.close(); await rm(dir2, {recursive: true, force: true}); }
});

test('no entitlement or limit is offered without a real feature or measurement behind it', async () => {
 // every limit shown to a merchant is measured, and the customer API entitlement does not exist until the API does
 const billing = await call('/api/client/billing', {s: S.a});
 assert.deepEqual(Object.keys(billing.data.limits).sort(), Object.keys(billing.data.usage).sort());
 for (const [key, used] of Object.entries(billing.data.usage)) assert.equal(typeof used, 'number', key + ' is measured');
 assert.ok(!('storage_mb' in billing.data.limits) && !('retention_days' in billing.data.limits));
 assert.ok(!billing.data.availablePlans.some(p => p.entitlements.includes('client.api_access')));
 const me = await call('/api/client/me', {s: S.a});
 assert.ok(!me.data.access.entitlements.includes('client.api_access'));
 // the platform refuses to configure them again
 const plan = (await call('/api/client-admin/plans', {s: S.admin})).data.items[0];
 assert.equal((await call(`/api/client-admin/plans/${plan.id}`, {method: 'PATCH', body: {entitlements: [...plan.entitlements, 'client.api_access']}, s: S.admin})).status, 400);
 assert.equal((await call(`/api/client-admin/plans/${plan.id}`, {method: 'PATCH', body: {limits: {...plan.limits, storage_mb: 100}}, s: S.admin})).status, 400);
 assert.equal((await call(`/api/client-admin/customers/${S.tenantA}/overrides`, {method: 'PUT', body: {entitlements: {'client.api_access': 'allow'}, reason: 'try'}, s: S.admin})).status, 400);
 assert.equal((await call(`/api/client-admin/customers/${S.tenantA}/overrides`, {method: 'PUT', body: {limits: {storage_mb: 5}, reason: 'try'}, s: S.admin})).status, 400);
});

test('schema: idempotent install; down-migration drops the client tables but keeps the audit trail', () => {
 const d = new DatabaseSync(':memory:');
 d.exec('PRAGMA foreign_keys=ON');
 d.exec('CREATE TABLE tenants (id TEXT PRIMARY KEY); CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE workspace_invitations (id TEXT PRIMARY KEY);');
 installClient(d); installClient(d);
 const names = () => d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
 for (const t of CLIENT_TABLES) assert.ok(names().includes(t), t);
 uninstallClient(d);
 for (const t of CLIENT_TABLES.filter(x => !RETAINED_ON_UNINSTALL.includes(x))) assert.ok(!names().includes(t), t);
 for (const t of RETAINED_ON_UNINSTALL) assert.ok(names().includes(t), t + ' is compliance evidence and stays');
 assert.ok(names().includes('tenants') && names().includes('users'));
 installClient(d);
 assert.ok(names().includes('client_tasks'));
 uninstallClient(d, {dropAudit: true});
 for (const t of CLIENT_TABLES) assert.ok(!names().includes(t), t);
});
