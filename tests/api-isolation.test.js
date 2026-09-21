import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {createTenant} from '../src/tenancy.js';
import {createApproval} from '../src/runtime/approvals.js';
import {ROUTE_POLICY} from '../src/security/route-policy.js';

// Legacy /api authorization review, proven over HTTP: two ordinary workspaces (A and C), a merchant (M), a platform operator
// and a platform admin. Tenant A owns data carrying a unique marker; nobody else may ever read, change or enumerate it, and the
// platform-global routes (user directory, registry, kill-switch, server status) are not reachable from a workspace.
const PASSWORD = 'iso-long-test-password-1';
const MARK = 'ZZ-A-SECRET';
const ENV = {PLATFORM_MAIL_TRANSPORT: 'capture', PLATFORM_ADMIN_USERNAMES: 'iso_admin', INTEGRATION_ENCRYPTION_KEY: 'ef'.repeat(32)};
let app, base, dir, auth;
const T = {}, U = {}, SESS = {}, IDS = {};

before(async () => {
 dir = await mkdtemp(join(tmpdir(), 'frost-iso-'));
 app = await createApp({dataDir: dir, env: ENV});
 await new Promise(r => app.server.listen(0, '127.0.0.1', r));
 base = `http://127.0.0.1:${app.server.address().port}`;
 auth = createAuth(app.store.db);
 await seed();
});
after(async () => { await new Promise(r => app.server.close(r)); app.store.close(); await rm(dir, {recursive: true, force: true}); });

async function call(path, {method, body, s, headers = {}} = {}) {
 const res = await fetch(base + path, {method: method || (body !== undefined ? 'POST' : 'GET'), redirect: 'manual', headers: {...(body !== undefined ? {'Content-Type': 'application/json'} : {}), ...(s ? {cookie: s.cookie, 'x-csrf-token': s.csrf} : {}), ...headers}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
 const text = await res.text();
 let data = null; try { data = JSON.parse(text); } catch { /* binary or empty */ }
 return {status: res.status, data, text, cookie: res.headers.get('set-cookie')?.split(';')[0], csrf: data?.csrf};
}
const loginSession = username => { const l = auth.login({username, password: PASSWORD}, '127.0.0.1'); return {cookie: 'hc_session=' + l.token, csrf: l.csrf}; };
function workspaceOwner(username, name, slug) {
 const user = auth.createUser({username, name, password: PASSWORD}, 'owner');
 app.store.db.prepare('UPDATE users SET email=?, email_verified_at=? WHERE id=?').run(`${username}@iso.test`, new Date().toISOString(), user.id);
 const tenantId = createTenant(app.store.db, {name, slug}, user.id);
 return {user, tenantId};
}

async function seed() {
 // operator = the owner of the deployment's own (default) workspace
 const op = await call('/api/setup', {body: {username: 'iso_op', name: 'Operator', password: PASSWORD}});
 SESS.op = {cookie: op.cookie, csrf: op.csrf};
 await call('/api/auth', {s: SESS.op}); // first authenticated request attaches the legacy owner to the default workspace
 U.op = app.store.db.prepare("SELECT id FROM users WHERE username='iso_op'").get().id;
 T.op = app.store.db.prepare('SELECT tenant_id t FROM tenant_memberships WHERE user_id=?').get(U.op).t;
 const a = workspaceOwner('zz_a_owner', `${MARK} Owner`, 'zz-a-store'); U.a = a.user.id; T.a = a.tenantId; SESS.a = loginSession('zz_a_owner');
 const c = workspaceOwner('iso_c_owner', 'Gamma Owner', 'gamma-store'); U.c = c.user.id; T.c = c.tenantId; SESS.c = loginSession('iso_c_owner');
 const adminUser = auth.createUser({username: 'iso_admin', name: 'Platform Admin', password: PASSWORD}, 'owner'); U.admin = adminUser.id;
 SESS.admin = loginSession('iso_admin');
 const reg = await call('/api/client/register', {body: {name: 'Merchant M', username: 'iso_m', email: 'iso_m@iso.test', password: PASSWORD, businessName: 'Merchant M Store', phone: '+966500000123', country: 'SA', businessType: 'retail', businessSize: 'small', ecommercePlatform: 'salla', teamSize: 2, goals: ['content'], planSlug: 'starter', acceptTerms: true, locale: 'en'}});
 assert.equal(reg.status, 201, reg.text);
 SESS.m = {cookie: reg.cookie, csrf: reg.csrf};
 U.m = app.store.db.prepare("SELECT id FROM users WHERE username='iso_m'").get().id;

 // seed tenant A with marked data through its own session
 const lead = await call('/api/crm/leads', {body: {name: `${MARK} lead`, customerType: 'B2C', sourceType: 'INBOUND', email: 'zz-a-lead@iso.test'}, s: SESS.a});
 assert.equal(lead.status, 201, lead.text); IDS.lead = lead.data.id;
 const conn = await call('/api/integrations/connections', {body: {integrationDefinitionId: 'zid', name: `${MARK} store`}, s: SESS.a});
 assert.equal(conn.status, 201, conn.text); IDS.connection = conn.data.id;
 const conv = await call('/api/command/conversations', {body: {title: `${MARK} conversation`}, s: SESS.a});
 assert.ok([200, 201].includes(conv.status), conv.text); IDS.conversation = conv.data?.id;
 const approval = createApproval(app.store.db, {runId: null, agentId: 'human', actionType: 'send_marketing_message', proposedOutput: {note: MARK}, riskLevel: 'LOW', reason: `${MARK} approval`, tenantId: T.a});
 IDS.approval = approval.id;
 const ctx = await call('/api/command/context', {body: {type: 'note', title: `${MARK} context`, content: `${MARK} body`}, s: SESS.a});
 IDS.context = ctx.data?.id;
 IDS.membership = app.store.db.prepare('SELECT id FROM tenant_memberships WHERE tenant_id=? AND user_id=?').get(T.a, U.a).id;
}

const leaks = text => /ZZ-A|zz_a_owner|zz-a-store|zz-a-lead|zz_a/i.test(text || '') || (text || '').includes(T.a);
const workspaceGetRoutes = () => ROUTE_POLICY.filter(e => e.access === 'workspace_member' && e.matcher.literal && /GET/.test(e.methods) && !e.matcher.literal.includes('export.'));

test('a workspace owner cannot read another workspace through any listing route (sweep of every workspace GET route)', async () => {
 const routes = workspaceGetRoutes();
 assert.ok(routes.length > 50, `swept ${routes.length} routes`);
 const problems = [];
 for (const who of ['c', 'op']) {
  for (const e of routes) {
   const res = await call(e.matcher.literal, {s: SESS[who]});
   const notConfigured = res.status === 502 && /_OAUTH_NOT_CONFIGURED/.test(res.text); // a provider start route on a server without that OAuth app
   if (res.status >= 500 && !notConfigured) problems.push(`${who} ${e.matcher.literal} -> ${res.status} ${res.text.slice(0, 120)}`);
   // the operator legitimately sees the platform-wide user directory; every other route must be scoped for everybody
   const operatorDirectory = who === 'op' && ['/api/users', '/api/team/dashboard'].includes(e.matcher.literal);
   if (!operatorDirectory && leaks(res.text)) problems.push(`${who} ${e.matcher.literal} leaked tenant A data`);
  }
 }
 assert.deepEqual(problems, []);
});

test('the same sweep is closed to a merchant account and to anonymous callers', async () => {
 const routes = workspaceGetRoutes();
 for (const e of routes) {
  const merchant = await call(e.matcher.literal, {s: SESS.m});
  assert.equal(merchant.status, 403, `${e.matcher.literal} -> ${merchant.status}`);
  assert.equal(merchant.data?.error, 'MERCHANT_USE_CLIENT_PORTAL', e.matcher.literal);
  const anon = await call(e.matcher.literal);
  assert.equal(anon.status, 401, `${e.matcher.literal} anonymous -> ${anon.status}`);
 }
});

test('resources of another workspace are indistinguishable from missing ones (no IDOR)', async () => {
 const attempts = [
  ['GET', `/api/crm/leads/${IDS.lead}`], ['POST', `/api/crm/leads/${IDS.lead}/update`, {stage: 'WON'}], ['POST', `/api/crm/leads/${IDS.lead}/messages`, {channel: 'WhatsApp', direction: 'INBOUND', text: 'x'}],
  ['GET', `/api/integrations/connections/${IDS.connection}`], ['POST', `/api/integrations/connections/${IDS.connection}/disconnect`, {}], ['POST', `/api/integrations/connections/${IDS.connection}/test`, {}], ['POST', `/api/integrations/connections/${IDS.connection}/set-default`, {}],
  ['GET', `/api/integrations/connections/${IDS.connection}/usage`], ['GET', `/api/integrations/connections/${IDS.connection}/webhook`], ['PUT', `/api/integrations/connections/${IDS.connection}/credential`, {apiKey: 'placeholder-not-a-real-key'}],
  ['POST', `/api/approvals/${IDS.approval}/decide`, {decision: 'APPROVED'}], ['POST', `/api/workspaces/members/${IDS.membership}`, {role: 'operator'}], ['DELETE', `/api/workspaces/members/${IDS.membership}`],
  ['POST', `/api/integrations/oauth/zid/start?connectionId=${IDS.connection}`],
 ];
 for (const who of ['c']) {
  for (const [method, path, body] of attempts) {
   const res = await call(path, {method, body, s: SESS[who]});
   assert.ok(res.status >= 400 && res.status < 500, `${who} ${method} ${path} -> ${res.status} ${res.text.slice(0, 100)}`);
   assert.ok(![200, 201, 302].includes(res.status), `${method} ${path}`);
   assert.ok(!leaks(res.text), `${method} ${path} leaked`);
  }
 }
 // and nothing changed for the owner
 assert.equal(app.store.db.prepare('SELECT stage FROM (SELECT json_extract(json,\'$.stage\') stage FROM crm_leads WHERE id=?)').get(IDS.lead).stage !== 'WON', true);
 assert.equal(app.store.db.prepare('SELECT status FROM agent_approvals WHERE id=?').get(IDS.approval).status, 'PENDING');
 assert.notEqual(app.store.db.prepare('SELECT status FROM integration_connections WHERE id=?').get(IDS.connection).status, 'DISCONNECTED');
});

test('the user directory and account-level actions never reach across workspaces', async () => {
 // listing: a workspace owner sees only the accounts of their own workspace
 const own = await call('/api/users', {s: SESS.c});
 assert.equal(own.status, 200);
 assert.deepEqual(own.data.map(u => u.username), ['iso_c_owner']);
 assert.ok(!leaks(own.text));
 const dash = await call('/api/team/dashboard', {s: SESS.c});
 assert.deepEqual(dash.data.members.map(u => u.username), ['iso_c_owner']);
 // creating platform accounts is an operator action
 assert.equal((await call('/api/users', {body: {username: 'made_by_c', name: 'X', password: PASSWORD, role: 'owner'}, s: SESS.c})).status, 403);
 // account takeover attempts against another workspace's owner, a platform admin and the operator
 for (const victim of [U.a, U.admin, U.op]) for (const action of ['reset-access', 'suspend', 'remove', 'revoke-sessions', 'role']) {
  const res = await call(`/api/users/${victim}/${action}`, {body: {password: 'attacker-chosen-password-1', role: 'viewer'}, s: SESS.c});
  assert.equal(res.status, 404, `${action} on ${victim} -> ${res.status}`);
 }
 assert.equal(auth.login({username: 'zz_a_owner', password: PASSWORD}, '127.0.0.1').user.username, 'zz_a_owner', 'the victim password is unchanged');
 assert.equal(app.store.db.prepare('SELECT status FROM users WHERE id=?').get(U.a).status, 'active');
 // an owner CAN administer an account that belongs to their workspace alone
 const member = auth.createUser({username: 'iso_c_member', name: 'Gamma Member', password: PASSWORD}, 'operator');
 app.store.db.prepare("INSERT INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), T.c, member.id, 'operator', 'active', 0, new Date().toISOString());
 assert.equal((await call(`/api/users/${member.id}/suspend`, {body: {}, s: SESS.c})).status, 200);
 assert.equal((await call(`/api/users/${member.id}/reactivate`, {body: {}, s: SESS.c})).status, 200);
 // ...but not one who also belongs to another workspace
 app.store.db.prepare("INSERT INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), T.a, member.id, 'operator', 'active', 0, new Date().toISOString());
 assert.equal((await call(`/api/users/${member.id}/suspend`, {body: {}, s: SESS.c})).status, 404);
 // the operator keeps the directory
 const all = await call('/api/users', {s: SESS.op});
 assert.ok(all.data.length >= 5);
});

test('platform-global routes are closed to workspace owners and merchants and open to the operator / platform admin', async () => {
 const closed = [['POST', '/api/agents/reseed', {}], ['POST', '/api/agents/sales/model-config', {provider: 'anthropic', model: 'x'}], ['POST', '/api/frost/pause', {reason: 'x'}], ['POST', '/api/frost/resume', {}], ['POST', '/api/frost/run-now', {}], ['GET', '/api/connections'],
  ['GET', '/api/platform/overview'], ['GET', '/api/platform/tenants'], ['GET', '/api/platform/connectors'], ['POST', '/api/platform/connectors', {}], ['GET', '/api/partners/admin/partners'], ['GET', '/api/client-admin/customers'], ['GET', '/api/client-admin/overview']];
 for (const who of ['a', 'c', 'm']) for (const [method, path, body] of closed) {
  const res = await call(path, {method, body, s: SESS[who]});
  assert.ok([401, 403].includes(res.status), `${who} ${method} ${path} -> ${res.status}`);
 }
 // the kill-switch really is untouched
 assert.equal(app.store.db.prepare('SELECT paused FROM runtime_gate WHERE id=1').get().paused, 0);
 // cost is tenant-scoped for a workspace owner, global for the operator
 app.store.db.prepare("INSERT INTO agent_runs (id,agent_id,tenant_id,status,trigger_type,input_context,started_at,estimated_cost,tokens_input,tokens_output) VALUES (?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), 'strategy', T.a, 'COMPLETED', 'TEST', '{}', new Date().toISOString(), 3.5, 10, 10);
 const costC = await call('/api/agents/cost-summary', {s: SESS.c});
 assert.equal(costC.status, 200);
 assert.deepEqual(costC.data.rows, []);
 const costOp = await call('/api/agents/cost-summary', {s: SESS.op});
 assert.ok(costOp.data.rows.length >= 1);
 // operator and platform admin can use their routes
 assert.equal((await call('/api/connections', {s: SESS.op})).status, 200);
 assert.equal((await call('/api/platform/overview', {s: SESS.admin})).status, 200);
 assert.equal((await call('/api/frost/pause', {body: {reason: 'iso test'}, s: SESS.op})).status, 200);
 assert.equal((await call('/api/frost/resume', {body: {}, s: SESS.op})).status, 200);
});

test('unknown API paths are refused for everyone (default deny)', async () => {
 for (const s of [SESS.op, SESS.c, SESS.m, undefined]) assert.equal((await call('/api/definitely-not-a-route', {s})).status, 404);
});

test('a role held in one workspace never carries into another (owner elsewhere, operator here)', async () => {
 // iso_c_owner is a global "owner" account and owns workspace C; in workspace A they are only an operator
 app.store.db.prepare("INSERT INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), T.a, U.c, 'operator', 'active', 0, new Date().toISOString());
 const switched = await call('/api/workspaces/active', {method: 'PUT', body: {workspaceId: T.a}, s: SESS.c});
 assert.equal(switched.status, 200, switched.text);
 // owner-only actions are refused in A although the same account can do them in C
 assert.equal((await call('/api/integrations/connections', {body: {integrationDefinitionId: 'zid', name: 'not allowed'}, s: SESS.c})).status, 403);
 assert.equal((await call('/api/workspaces/invitations', {body: {email: 'x@iso.test', role: 'operator'}, s: SESS.c})).status, 403);
 assert.equal((await call('/api/approvals/' + IDS.approval + '/decide', {body: {decision: 'APPROVED'}, s: SESS.c})).status, 403);
 // operator-level reads work (CRM is owner+operator)
 assert.equal((await call('/api/crm', {s: SESS.c})).status, 200);
 await call('/api/workspaces/active', {method: 'PUT', body: {workspaceId: T.c}, s: SESS.c});
 assert.equal((await call('/api/integrations/connections', {body: {integrationDefinitionId: 'zid', name: 'Gamma zid'}, s: SESS.c})).status, 201);
});

test('the CRM staff picker lists only the caller workspace', async () => {
 const crm = await call('/api/crm', {s: SESS.c});
 assert.ok(!leaks(JSON.stringify(crm.data.staff)), 'no other workspace staff');
 assert.ok(crm.data.staff.every(s => ['iso_c_owner', 'Gamma Owner'].includes(s.name) || s.name.startsWith('Gamma')));
});
