// Frost merchant portal - Playwright E2E (real browser, real server, real SQLite; only the LLM transport is mocked):
//  1 merchant registers -> 2 onboarding -> 3 sees the 12 agents and their real states -> 4 connects a tool ->
//  5 runs an allowed agent -> 6 a locked agent is refused (UI and direct API) -> 7 invites an operator ->
//  8 operator signs in with its own permissions -> 9 an approval is requested and approved -> 10 platform admin opens the
//  customer file -> 11 read-only support session blocks writes -> 12 limited session may act -> 13 customer sees the sessions ->
//  14 a second merchant sees none of it. Also merchant OAuth in a real browser (cross-site provider redirect, denied consent, replay),
//  workflow templates, RTL/LTR, mobile 390px and console cleanliness.
//  Run with: node tests/e2e/client-portal-journey.e2e.mjs
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createApp} from '../../src/application.js';

const llm = async () => new Response(JSON.stringify({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({status: 'NEEDS_DATA', action: 'NONE', rationale: 'Mock provider reply', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: ['none'], payload: null})}], usage: {input_tokens: 11, output_tokens: 7}}), {status: 200, headers: {'content-type': 'application/json'}});
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json'}});
// the LLM plus a scripted Salla (token + a verification call)
const providers = async (url, init) => {
 const u = String(url);
 if (u === 'https://accounts.salla.sa/oauth2/token') return json({access_token: 'salla-e2e-access', refresh_token: 'salla-e2e-refresh', expires_in: 3600, scope: 'offline_access products.read'});
 if (u.startsWith('https://api.salla.dev/admin/v2/products')) return json({success: true, data: [], pagination: {totalPages: 1}});
 return llm(url, init);
};
const directory = await mkdtemp(join(tmpdir(), 'frost-e2e-client-'));
const shots = new URL('../../output/client-e2e/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
await mkdir(shots, {recursive: true});
const app = await createApp({dataDir: directory, env: {PLATFORM_MAIL_TRANSPORT: 'capture', PLATFORM_ADMIN_USERNAMES: 'e2e_boss', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'test-model', INTEGRATION_ENCRYPTION_KEY: 'ef'.repeat(32), SALLA_CLIENT_ID: 'e2e-salla-id', SALLA_CLIENT_SECRET: 'e2e-salla-secret'}, fetcher: providers});
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const db = app.store.db;
const PASSWORD = 'e2e-merchant-password-1';
const browser = await chromium.launch();
const problems = [];
const allPages = [];

async function newPage(name, {locale = 'en', viewport = {width: 1360, height: 900}} = {}) {
 const context = await browser.newContext({viewport});
 await context.addInitScript(l => { try { localStorage.setItem('hc_locale', l); } catch { /* ignore */ } }, locale);
 const page = await context.newPage();
 allPages.push([name, page]);
 page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push(`[${name}] console: ${m.text()}`); });
 page.on('pageerror', e => problems.push(`[${name}] pageerror: ${e.message}`));
 page.on('response', r => { if (r.status() >= 500) problems.push(`[${name}] HTTP ${r.status()} ${r.url()}`); });
 return {context, page};
}
const shot = (page, name) => page.screenshot({path: join(shots, name + '.png'), fullPage: true});
const step = label => console.log('  ✓', label);
const csrfOf = async page => (await (await page.request.get(`${base}/api/auth`)).json()).csrf;

try {
 // ---- 1. landing + registration ------------------------------------------------------------------------------------
 const owner = await newPage('owner');
 const o = owner.page;
 await o.goto(`${base}/client`);
 await o.waitForSelector('.agent-mini');
 assert.equal(await o.locator('.agent-mini').count(), 12, 'the landing lists the 12 registry agents');
 assert.equal(await o.locator('.plan-card').count(), 3);
 await shot(o, '01-landing');
 await o.click('a.btn-primary >> text=Start now');
 await o.waitForSelector('form.auth-card.wide');
 await o.fill('input[name=name]', 'Layla Owner');
 await o.fill('input[name=username]', 'e2e_layla');
 await o.fill('input[name=email]', 'layla@shop.example');
 await o.fill('input[name=phone]', '+966500000200');
 await o.fill('input[name=password]', PASSWORD);
 await o.fill('input[name=confirmPassword]', PASSWORD);
 await o.fill('input[name=businessName]', 'Layla Boutique');
 await o.fill('input[name=country]', 'SA');
 await o.check('input[name="goal:content"]');
 await o.check('input[name="goal:grow_sales"]');
 await o.check('input[name=planSlug][value=starter]');
 await o.check('input[name=acceptTerms]');
 await shot(o, '02-register');
 await o.click('button[type=submit]');
 await o.waitForURL('**/client/onboarding');
 step('merchant registered and landed on onboarding');

 // ---- 2. onboarding -----------------------------------------------------------------------------------------------------
 await o.waitForSelector('text=About your business');
 await o.fill('input[name=industry]', 'Fashion');
 await o.fill('textarea[name=offering]', 'Handmade bags and shoes');
 await o.click('button:has-text("Save and continue")');
 await o.waitForSelector('text=Your goals');
 await o.click('button:has-text("Save and continue")');
 await o.waitForSelector('text=Connect your tools');
 await shot(o, '03-onboarding-tools');
 await o.click('button:has-text("Save and continue")');
 await o.waitForSelector('text=Choose your agents');
 assert.ok(await o.locator('.agent-option.is-locked').count() > 0, 'locked agents are shown as locked');
 await o.locator('.agent-option input[name=strategy]').check();
 await o.locator('.agent-option input[name=compliance]').check();
 await shot(o, '04-onboarding-agents');
 await o.click('button:has-text("Save and continue")');
 await o.waitForSelector('text=Default approval policy, Approvals >> nth=0').catch(() => {});
 await o.waitForSelector('input[name=autonomy]');
 await o.click('button:has-text("Save and continue")');
 await o.waitForSelector('button:has-text("Launch my workspace")');
 await shot(o, '05-onboarding-review');
 await o.click('button:has-text("Launch my workspace")');
 await o.waitForURL('**/client/dashboard');
 await o.waitForSelector('.metric');
 await shot(o, '06-dashboard');
 step('onboarding completed; workspace is live');

 // ---- 3. the 12 agents with real states ---------------------------------------------------------------------------
 await o.goto(`${base}/client/agents`);
 await o.waitForSelector('.agent-card');
 assert.equal(await o.locator('.agent-card').count(), 12);
 const lockedCards = await o.locator('.agent-card.is-locked').count();
 assert.ok(lockedCards >= 8, `starter locks the agents it does not include (${lockedCards})`);
 await shot(o, '07-agents');
 await o.goto(`${base}/client/agents/sales`);
 await o.waitForSelector('.banner-warn');
 assert.match(await o.locator('.banner-warn').innerText(), /not included in your plan/i);
 await shot(o, '08-agent-locked');
 step('12 agents listed; locked agents explain why');

 // ---- 4. integrations ------------------------------------------------------------------------------------------------------
 await o.goto(`${base}/client/integrations`);
 await o.waitForSelector('.integration');
 assert.equal(await o.locator('.integration .pill[data-status=active]').count(), 0, 'nothing is shown as connected before it is verified');
 await o.locator('.integration', {hasText: 'Anthropic'}).locator('button:has-text("Connect")').click();
 await o.fill('dialog[open] input[name=apiKey]', 'sk-ant-test-key-123456');
 await o.click('dialog[open] button:has-text("Connect")');
 await o.waitForSelector('.integration .pill[data-status=active]');
 assert.ok(!(await o.content()).includes('sk-ant-test-key-123456'), 'the key is never rendered back');
 await shot(o, '09-integrations');
 step('integration connected only after a real verification call');

 // ---- 4b. OAuth in a real browser: availability is honest, the provider redirects back cross-site, errors are clear ---------------
 const zid = o.locator('.integration[data-provider=zid]');
 assert.equal(await zid.getAttribute('data-availability'), 'unavailable');
 assert.equal(await zid.locator('button').count(), 0, 'no connect button for a provider this server cannot run');
 assert.match(await zid.innerText(), /not registered its app/i);
 const canva = o.locator('.integration[data-provider=canva]');
 assert.equal(await canva.getAttribute('data-availability'), 'coming_soon');
 assert.equal(await canva.locator('button').count(), 0);
 const salla = o.locator('.integration[data-provider=salla]');
 assert.equal(await salla.getAttribute('data-availability'), 'available');
 let lastCallback = null;
 await o.route('https://accounts.salla.sa/oauth2/auth**', route => {
  const u = new URL(route.request().url());
  assert.equal(u.searchParams.get('redirect_uri'), `${base}/api/client/integrations/salla/callback`);
  const mode = process.env.E2E_SALLA_MODE || 'ok';
  lastCallback = mode === 'denied'
   ? `${base}/api/client/integrations/salla/callback?error=access_denied&state=${encodeURIComponent(u.searchParams.get('state'))}`
   : `${base}/api/client/integrations/salla/callback?code=E2E-CODE&state=${encodeURIComponent(u.searchParams.get('state'))}`;
  route.fulfill({status: 302, headers: {location: lastCallback}});
 });
 // denied consent first: clear error state, nothing connected
 process.env.E2E_SALLA_MODE = 'denied';
 await salla.locator('button:has-text("Connect with sign-in")').click();
 await o.waitForSelector('.form-error[role=alert]');
 assert.match(await o.locator('.form-error[role=alert]').innerText(), /was not given access|not given access/i);
 assert.equal(await o.locator('.integration[data-provider=salla] .conn-row').count(), 0, 'a denied sign-in leaves nothing connected');
 await shot(o, '09b-oauth-denied');
 // then a real completion
 process.env.E2E_SALLA_MODE = 'ok';
 await o.locator('.integration[data-provider=salla] button:has-text("Connect with sign-in")').click();
 await o.waitForSelector('.notice[role=status]');
 assert.match(await o.locator('.notice[role=status]').innerText(), /connected and verified/i);
 await o.waitForSelector('.integration[data-provider=salla] .pill[data-status=active]');
 assert.equal(await o.locator('.integration[data-provider=salla] .conn-row').count(), 1);
 assert.ok(!(await o.content()).includes('salla-e2e-access'), 'no token is ever rendered');
 await shot(o, '09c-oauth-connected');
 // the same callback replayed is refused
 await o.goto(lastCallback);
 await o.waitForSelector('.form-error[role=alert]');
 assert.match(await o.locator('.form-error[role=alert]').innerText(), /already used/i);
 assert.equal(await o.locator('.integration[data-provider=salla] .conn-row').count(), 1, 'the replay added nothing');
 // disconnect
 await o.locator('.integration[data-provider=salla] button:has-text("Disconnect")').click();
 await o.click('dialog[open] button:has-text("Confirm"), dialog[open] button:has-text("Disconnect")');
 await o.waitForSelector('.integration[data-provider=salla] .pill:has-text("Not connected")');
 step('OAuth: sign-in redirect completes in a real browser, denial and replay are clear errors, disconnect removes the store');

 // ---- 5. run an allowed agent ------------------------------------------------------------------------------------------------
 await o.goto(`${base}/client/agents/strategy`);
 await o.click('button:has-text("Create task")');
 await o.fill('dialog[open] input[name=title]', 'Plan the spring launch');
 await o.click('dialog[open] button:has-text("Create task")');
 await o.waitForURL('**/client/tasks');
 await o.waitForSelector('.pill[data-status=completed]', {timeout: 15000});
 await shot(o, '10-tasks');
 step('an allowed agent ran and the task is completed');

 // ---- 6. a locked agent is refused (UI and API) --------------------------------------------------------------------------------
 const csrf = await csrfOf(o);
 const denied = await o.request.post(`${base}/api/client/tasks`, {data: {agentId: 'sales', title: 'Quote a customer'}, headers: {'x-csrf-token': csrf}});
 assert.equal(denied.status(), 403);
 assert.equal((await denied.json()).error, 'AGENT_LOCKED_BY_PLAN');
 const legacy = await o.request.post(`${base}/api/agents/sales/run`, {data: {scenario: 'x'}, headers: {'x-csrf-token': csrf}});
 assert.equal((await legacy.json()).error, 'MERCHANT_USE_CLIENT_PORTAL');
 step('a plan-locked agent is refused by the API, and the legacy API is closed to merchants');

 // ---- 7. invite an operator -----------------------------------------------------------------------------------------------------
 await o.goto(`${base}/client/team`);
 await o.click('button:has-text("Invite a member")');
 await o.fill('dialog[open] input[name=email]', 'omar@shop.example');
 await o.selectOption('dialog[open] select[name=role]', 'operator');
 await o.click('dialog[open] button:has-text("Send invitation")');
 await o.waitForSelector('text=omar@shop.example');
 await shot(o, '11-team');
 const token = JSON.parse(db.prepare("SELECT captured_body FROM platform_mail_outbox WHERE to_email='omar@shop.example' AND kind='INVITATION'").get().captured_body).html.match(/invite\/([a-f0-9]+)/)[1];
 step('invitation sent from the portal');

 // ---- 8. the operator joins with their own permissions --------------------------------------------------------------------------
 const op = await newPage('operator');
 await op.page.goto(`${base}/client/invite/${token}`);
 await op.page.waitForSelector('form');
 await op.page.fill('input[name=name]', 'Omar Operator');
 await op.page.fill('input[name=username]', 'e2e_omar');
 await op.page.fill('input[name=password]', PASSWORD);
 await op.page.click('button[type=submit]');
 await op.page.waitForURL('**/client/dashboard');
 assert.match(await op.page.locator('.top-title').innerText(), /Operator/);
 await op.page.goto(`${base}/client/tasks`);
 await op.page.click('button:has-text("New task")');
 await op.page.selectOption('dialog[open] select[name=agentId]', 'compliance');
 await op.page.fill('dialog[open] input[name=title]', 'Review the spring banner');
 await op.page.click('dialog[open] button:has-text("Create task")');
 await op.page.waitForSelector('.pill[data-status=waiting_for_approval]', {timeout: 15000});
 await op.page.goto(`${base}/client/approvals`);
 await op.page.waitForSelector('.approval');
 assert.equal(await op.page.locator('.approval button:has-text("Approve")').count(), 0, 'an operator cannot approve');
 step('the operator works within their permissions; an approval was requested');

 // ---- 9. the owner approves -----------------------------------------------------------------------------------------------------
 await o.goto(`${base}/client/approvals`);
 await o.waitForSelector('.approval button:has-text("Approve")');
 await shot(o, '12-approvals');
 await o.click('.approval button:has-text("Approve")');
 await o.waitForSelector('text=Nothing waiting, text=No approvals', {timeout: 15000}).catch(() => {});
 await o.goto(`${base}/client/tasks`);
 await o.waitForSelector('tr:has-text("Review the spring banner") .pill[data-status=completed]', {timeout: 15000});
 step('the owner approved and the task ran to completion');

 // ---- 10-12. platform admin: customer file and support sessions ----------------------------------------------------------------------
 await fetch(`${base}/api/signup`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'Boss', username: 'e2e_boss', email: 'boss@frost.example', password: PASSWORD})});
 const admin = await newPage('admin');
 const a = admin.page;
 await a.goto(`${base}/app#customers`);
 await a.waitForSelector('#auth-form button:not([disabled])');
 await a.fill('#auth-form input[name=username]', 'e2e_boss');
 await a.fill('#auth-form input[name=password]', PASSWORD);
 await a.click('#auth-form button');
 await a.waitForSelector('#customers .ui-tabs');
 await a.click('#customers [role=tab] >> text=Customers');
 await a.waitForSelector('#customers [data-tab=customers] tbody tr');
 await shot(a, '13-admin-customers');
 await a.click('#customers [data-tab=customers] button:has-text("Open") >> nth=0');
 await a.waitForSelector('dialog[open] button:has-text("Enter in support mode")');
 await shot(a, '14-admin-customer');
 // read-only session
 await a.click('dialog[open] button:has-text("Enter in support mode")');
 await a.waitForSelector('dialog[open] select[name=level]');
 await a.fill('dialog[open] textarea[name=reason]', 'Investigating a failed task for the customer');
 await a.fill('dialog[open] input[name=ticket]', 'T-2001');
 await a.click('dialog[open] button:has-text("Start session")');
 await a.waitForURL('**/client/dashboard');
 await a.waitForSelector('.support-bar');
 assert.match(await a.locator('.support-bar').innerText(), /support mode/i);
 await shot(a, '15-support-view-only');
 const supportCsrf = await csrfOf(a);
 const blocked = await a.request.post(`${base}/api/client/tasks`, {data: {agentId: 'strategy', title: 'Admin write attempt'}, headers: {'x-csrf-token': supportCsrf}});
 assert.equal((await blocked.json()).error, 'SUPPORT_READ_ONLY', 'view-only support cannot write');
 await a.click('.support-bar button:has-text("End session")');
 await a.waitForURL('**/app#customers');
 step('platform admin entered in read-only support mode; writes are blocked by the server');
 // limited session that acts
 await a.waitForSelector('#customers .ui-tabs');
 await a.click('#customers [role=tab] >> text=Customers');
 await a.click('#customers [data-tab=customers] button:has-text("Open") >> nth=0');
 await a.click('dialog[open] button:has-text("Enter in support mode")');
 await a.selectOption('dialog[open] select[name=level]', 'limited');
 await a.fill('dialog[open] textarea[name=reason]', 'Creating the follow-up task together with the customer');
 await a.click('dialog[open] button:has-text("Start session")');
 await a.waitForURL('**/client/dashboard');
 await a.goto(`${base}/client/tasks`);
 await a.click('button:has-text("New task")');
 await a.fill('dialog[open] input[name=title]', 'Created during support');
 await a.click('dialog[open] button:has-text("Create task")');
 await a.waitForSelector('tr:has-text("Created during support")', {timeout: 15000});
 const row = db.prepare("SELECT * FROM client_audit_logs WHERE action='CLIENT_TASK_CREATED' AND actor_kind='admin_support'").get();
 assert.ok(row && row.performed_by_admin && row.support_session_id && row.on_behalf_of_user, 'the action is attributed to the admin, the session and the customer owner');
 await a.click('.support-bar button:has-text("End session")');
 await a.waitForURL('**/app#customers');
 step('a limited support session performed an action that is audited with full attribution');

 // ---- 13. the customer sees what support did ---------------------------------------------------------------------------------------------
 await o.goto(`${base}/client/support`);
 await o.waitForSelector('tbody tr');
 assert.equal(await o.locator('tbody tr').count(), 2, 'both sessions are visible to the customer');
 await o.click('tbody tr >> nth=0 >> button:has-text("Details")');
 await o.waitForSelector('dialog[open] table');
 await shot(o, '16-customer-support-sessions');
 await o.keyboard.press('Escape');
 await o.goto(`${base}/client/notifications`);
 await o.waitForSelector('.list-row');
 assert.match(await o.locator('.list').innerText(), /support session/i);
 step('the customer sees both support sessions, their actions and notifications');

 // ---- 14. isolation: a second merchant sees none of it ---------------------------------------------------------------------------------------
 const b = await newPage('merchant-b');
 const reg = await b.page.request.post(`${base}/api/client/register`, {data: {name: 'Bob', username: 'e2e_bob', email: 'bob@other.example', password: PASSWORD, phone: '+966500000300', country: 'SA', businessName: 'Bob Store', businessType: 'retail', businessSize: 'small', ecommercePlatform: 'salla', teamSize: 1, goals: ['content'], planSlug: 'starter', acceptTerms: true, locale: 'en'}});
 assert.equal(reg.status(), 201);
 await b.page.goto(`${base}/client/tasks`);
 await b.page.waitForSelector('.state, table');
 assert.equal(await b.page.locator('table').count(), 0, 'the second merchant has no tasks');
 const aTask = db.prepare("SELECT id FROM client_tasks WHERE title='Plan the spring launch'").get().id;
 const peek = await b.page.request.get(`${base}/api/client/tasks/${aTask}`);
 assert.equal(peek.status(), 404, 'another merchant cannot read a task by id');
 step('a second merchant cannot see or fetch any other merchant data');

 // ---- 15. workflow templates ------------------------------------------------------------------------------------------------------------------
 const s3 = await newPage('merchant-c');
 const reg3 = await s3.page.request.post(`${base}/api/client/register`, {data: {name: 'Carla', username: 'e2e_carla', email: 'carla@growth.example', password: PASSWORD, phone: '+966500000400', country: 'SA', businessName: 'Carla Growth', businessType: 'retail', businessSize: 'small', ecommercePlatform: 'salla', teamSize: 2, goals: ['content'], planSlug: 'growth', acceptTerms: true, locale: 'en'}});
 assert.equal(reg3.status(), 201);
 const c = s3.page;
 await c.goto(`${base}/client/workflows`);
 await c.waitForSelector('button:has-text("New from template")');
 assert.match(await c.locator('main').innerText(), /Workflow templates/);
 await c.click('button:has-text("New from template")');
 await c.waitForSelector('dialog[open] select[name=templateKey]');
 const optionTexts = await c.locator('dialog[open] select[name=templateKey] option').allInnerTexts();
 assert.ok(optionTexts.some(t => /not in your plan/i.test(t)), 'a template whose agents are not in the plan says so');
 await c.selectOption('dialog[open] select[name=templateKey]', 'content_review');
 await c.fill('dialog[open] input[name=name]', 'Spring bag copy');
 await c.fill('dialog[open] textarea[name=objective]', 'Launch the spring handmade bag collection');
 await c.selectOption('dialog[open] select[name=triggerType]', 'SCHEDULE');
 await c.selectOption('dialog[open] select[name=frequency]', 'WEEKLY');
 await c.selectOption('dialog[open] select[name=hour]', '9');
 await c.selectOption('dialog[open] select[name=weekday]', '2');
 await shot(c, '19-workflow-template-form');
 await c.click('dialog[open] button:has-text("Save")');
 await c.waitForSelector('tbody tr');
 assert.match(await c.locator('tbody tr').first().innerText(), /Spring bag copy/);
 assert.match(await c.locator('tbody tr').first().innerText(), /Draft/);
 assert.match(await c.locator('tbody tr').first().innerText(), /Weekly at 09:00/);
 assert.ok((await c.locator('tbody tr').first().locator('.form-error').count()) > 0, 'a workspace that has not finished onboarding sees why the workflow cannot run yet');
 await shot(c, '20-workflows-list');
 // activation is refused with the exact reason (onboarding), the workflow stays a draft
 await c.click('tbody tr >> nth=0 >> button:has-text("Activate")');
 await c.waitForSelector('.toast, [role=status], [role=alert]');
 assert.equal(db.prepare("SELECT status FROM workflow_definitions WHERE tenant_id=(SELECT m.tenant_id FROM client_members m JOIN users u ON u.id=m.user_id WHERE u.username='e2e_carla')").get().status, 'DRAFT');
 // edit only the allowed inputs
 await c.click('tbody tr >> nth=0 >> button:has-text("Edit")');
 await c.waitForSelector('dialog[open] input[name=name]');
 assert.equal(await c.locator('dialog[open] select[name=templateKey]').isDisabled(), true, 'the template itself cannot be changed');
 await c.fill('dialog[open] input[name=name]', 'Spring bag copy v2');
 await c.click('dialog[open] button:has-text("Save")');
 await c.waitForFunction(() => document.querySelector('tbody tr')?.innerText.includes('Spring bag copy v2'));
 // Arabic / RTL on a phone: the same workflow list and the template form
 const carlaAr = await newPage('carla-ar', {locale: 'ar', viewport: {width: 390, height: 800}});
 await carlaAr.page.goto(`${base}/client/login`);
 await carlaAr.page.fill('input[name=username]', 'e2e_carla');
 await carlaAr.page.fill('input[name=password]', PASSWORD);
 await carlaAr.page.click('button[type=submit]');
 await carlaAr.page.waitForURL(/\/client\/(dashboard|onboarding)/);
 await carlaAr.page.goto(`${base}/client/workflows`);
 await carlaAr.page.waitForSelector('tbody tr');
 assert.equal(await carlaAr.page.locator('html').getAttribute('dir'), 'rtl');
 assert.match(await carlaAr.page.locator('main').innerText(), /قوالب سير العمل/);
 const wfOverflow = await carlaAr.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
 assert.ok(wfOverflow <= 1, `workflows: no horizontal scroll at 390px (${wfOverflow}px)`);
 await carlaAr.page.click('button:has-text("جديد من قالب")');
 await carlaAr.page.waitForSelector('dialog[open] select[name=templateKey]');
 const dlgOverflow = await carlaAr.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
 assert.ok(dlgOverflow <= 1, `template form: no horizontal scroll at 390px (${dlgOverflow}px)`);
 await carlaAr.page.screenshot({path: join(shots, '21-workflow-form-ar-mobile.png')});
 await carlaAr.page.keyboard.press('Escape');
 await carlaAr.page.goto(`${base}/client/integrations`);
 await carlaAr.page.waitForSelector('.integration');
 assert.equal(await carlaAr.page.locator('main >> text=null').count(), 0, 'no stray "null" text');
 await carlaAr.page.screenshot({path: join(shots, '22-integrations-ar-mobile.png'), fullPage: true});
 // archive with confirmation
 await c.click('tbody tr >> nth=0 >> button:has-text("Archive")');
 await c.click('dialog[open] button:has-text("Confirm"), dialog[open] button:has-text("Archive")');
 await c.waitForSelector('text=No workflows yet');
 step('workflow templates: bounded inputs, plan-aware, honest readiness, edit and archive');

 // ---- Arabic / RTL and mobile ----------------------------------------------------------------------------------------------------------------
 const ar = await newPage('owner-ar', {locale: 'ar', viewport: {width: 390, height: 800}});
 await ar.page.goto(`${base}/client/login`);
 await ar.page.fill('input[name=username]', 'e2e_layla');
 await ar.page.fill('input[name=password]', PASSWORD);
 await ar.page.click('button[type=submit]');
 await ar.page.waitForURL('**/client/dashboard');
 await ar.page.waitForSelector('.metric');
 assert.equal(await ar.page.locator('html').getAttribute('dir'), 'rtl');
 const overflow = await ar.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
 assert.ok(overflow <= 1, `no horizontal scroll on mobile (${overflow}px)`);
 await ar.page.click('.menu-btn');
 await ar.page.waitForSelector('.sidebar.open');
 await ar.page.waitForTimeout(400);
 await ar.page.screenshot({path: join(shots, '17-mobile-menu-ar.png')});
 await ar.page.keyboard.press('Escape');
 for (const path of ['agents', 'tasks', 'approvals', 'integrations', 'analytics', 'team', 'notifications', 'billing', 'settings', 'support']) {
  await ar.page.goto(`${base}/client/${path}`);
  await ar.page.waitForSelector('main h1');
  assert.equal(await ar.page.locator('.state-error').count(), 0, `${path}: no error state`);
  const ov = await ar.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(ov <= 1, `${path}: no horizontal scroll at 390px (${ov}px)`);
 }
 await shot(ar.page, '18-settings-ar');
 step('all portal pages render in Arabic/RTL at 390px without errors or horizontal scroll');

 assert.deepEqual(problems, [], 'no console errors or server errors:\n' + problems.join('\n'));
 console.log('client portal journey: OK');
} catch (error) {
 if (problems.length) console.error(['Browser problems before the failure:', ...problems].join('\n'));
 for (const [name, page] of allPages) await page.screenshot({path: join(shots, `FAIL-${name}.png`), fullPage: true}).catch(() => {});
 throw error;
} finally {
 await browser.close();
 await new Promise(r => app.server.close(r));
 app.store.close();
 await rm(directory, {recursive: true, force: true});
}
