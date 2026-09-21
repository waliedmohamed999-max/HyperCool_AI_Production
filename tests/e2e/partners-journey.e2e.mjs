// Frost Partners - Playwright E2E journey (real browser, real server, real SQLite):
//  1 landing (real plans) -> 2 partner applies -> 3 admin approves in the dashboard ->
//  4 partner signs in and sees the dashboard/referral link -> 5 a customer arrives via the link and
//  signs up (server-side attribution) -> 6 a payment arrives through the signed billing webhook ->
//  7 admin approves the commission -> 8 partner adds a payout method and requests a payout ->
//  9 admin marks it paid -> 10 partner sees the paid payout. Also checks RTL/LTR, mobile layout and
//  that no browser console errors occur. Run with: node tests/e2e/partners-journey.e2e.mjs
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createApp} from '../../src/application.js';

const SECRET = 'whsec_e2e';
const directory = await mkdtemp(join(tmpdir(), 'frost-e2e-partners-'));
const shots = new URL('../../output/partners-e2e/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
await mkdir(shots, {recursive: true});
const app = await createApp({dataDir: directory, env: {PLATFORM_MAIL_TRANSPORT: 'capture', PLATFORM_ADMIN_USERNAMES: 'e2e_admin', INTEGRATION_ENCRYPTION_KEY: 'cd'.repeat(32), PARTNER_BILLING_WEBHOOK_SECRET: SECRET}});
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const db = app.store.db;
const PASSWORD = 'e2e-long-password-1';
const browser = await chromium.launch();
const problems = [];
const allPages = [];

async function newPage(name, {locale = 'en', viewport = {width: 1360, height: 900}} = {}) {
 const context = await browser.newContext({viewport});
 await context.addInitScript(l => { try { localStorage.setItem('hc_locale', l); } catch { /* ignore */ } }, locale);
 const page = await context.newPage();
 allPages.push([name, page]);
 page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push(`[${name}] console: ${m.text()}`); });
 page.on('response', r => { if (r.status() >= 400 && r.url().includes('/api/partners/')) problems.push(`[${name}] HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });
 page.on('pageerror', e => problems.push(`[${name}] pageerror: ${e.message}`));
 return {context, page};
}
const shot = (page, name) => page.screenshot({path: join(shots, name + '.png'), fullPage: true});
const step = label => console.log('  ✓', label);
async function verifyEmail(page, email) {
 const row = db.prepare("SELECT captured_body FROM platform_mail_outbox WHERE to_email=? AND kind='VERIFY_EMAIL' ORDER BY created_at DESC LIMIT 1").get(email);
 const {html, text} = JSON.parse(row.captured_body);
 const token = (html + text).match(/verify-email\/([a-f0-9]+)/)[1];
 const r = await page.request.post(`${base}/api/account/email/verify`, {data: {token}});
 assert.equal(r.status(), 200);
}
async function adminLogin(page, hash) {
 await page.goto(`${base}/app#${hash}`);
 await page.waitForSelector('#auth-form button:not([disabled])');
 await page.fill('#auth-form input[name=username]', 'e2e_admin');
 await page.fill('#auth-form input[name=password]', PASSWORD);
 await page.click('#auth-form button');
 await page.waitForSelector('#partnerships .ui-tabs');
}

try {
 // ---- 1. public landing with real plans ------------------------------------------------------------
 const guest = await newPage('guest');
 await guest.page.goto(`${base}/partners`);
 await guest.page.waitForSelector('.plan-card');
 assert.equal(await guest.page.locator('.plan-card').count(), 3, 'three real seeded plans are shown');
 assert.match(await guest.page.locator('.plan-card').nth(1).innerText(), /25%/, 'the commission rate comes from the plan row');
 assert.equal(await guest.page.locator('html').getAttribute('dir'), 'ltr');
 await shot(guest.page, '01-landing-en');
 step('landing renders the real plans (EN, LTR)');

 // Arabic / RTL variant of the same page
 const ar = await newPage('guest-ar', {locale: 'ar'});
 await ar.page.goto(`${base}/partners`);
 await ar.page.waitForSelector('.plan-card');
 assert.equal(await ar.page.locator('html').getAttribute('dir'), 'rtl');
 assert.match(await ar.page.locator('h1').first().innerText(), /عمولة/);
 await shot(ar.page, '01-landing-ar');
 await ar.context.close();
 step('landing renders in Arabic (RTL)');

 // ---- 2. partner applies through the UI --------------------------------------------------------------
 await guest.page.click('a.btn-primary >> text=Apply now');
 await guest.page.waitForSelector('form.auth-card.wide');
 await guest.page.fill('input[name=name]', 'Sara Partner');
 await guest.page.fill('input[name=username]', 'e2e_sara');
 await guest.page.fill('input[name=email]', 'sara@e2e.example');
 await guest.page.fill('input[name=password]', PASSWORD);
 await guest.page.fill('input[name=confirmPassword]', PASSWORD);
 await guest.page.fill('input[name=fullName]', 'Sara Partner');
 await guest.page.fill('input[name=phone]', '+966500000010');
 await guest.page.fill('input[name=country]', 'SA');
 await guest.page.fill('textarea[name=marketingMethod]', 'Instagram reels and a weekly newsletter for online stores.');
 await guest.page.fill('input[name=expectedCustomers]', '30');
 await guest.page.check('input[name=acceptTerms]');
 await shot(guest.page, '02-register');
 await guest.page.click('button[type=submit]');
 await guest.page.waitForURL('**/partners/onboarding');
 await guest.page.waitForSelector('.status-card .pill');
 assert.match(await guest.page.locator('.status-card .pill').innerText(), /Pending/i);
 await shot(guest.page, '02-onboarding-pending');
 await verifyEmail(guest.page, 'sara@e2e.example');
 step('partner applied and sees the pending status');

 // ---- 3. admin approves in the dashboard (#partnerships) --------------------------------------------
 const setup = await fetch(`${base}/api/signup`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'E2E Admin', username: 'e2e_admin', email: 'admin@e2e.example', password: PASSWORD})});
 assert.equal(setup.status, 201);
 const admin = await newPage('admin');
 await adminLogin(admin.page, 'partnerships');
 // zero-day hold so an approved commission is withdrawable immediately in this scenario
 await admin.page.request.put(`${base}/api/partners/admin/settings`, {data: {commission_hold_days: 0, min_payout: '10.00'}, headers: {'x-csrf-token': (await (await admin.page.request.get(`${base}/api/auth`)).json()).csrf}});
 await admin.page.click('#partnerships [role=tab] >> text=Applications');
 await admin.page.waitForSelector('button:has-text("Review")');
 await shot(admin.page, '03-admin-applications');
 await admin.page.click('button:has-text("Review")');
 await admin.page.waitForSelector('dialog[open] select[name=decision]');
 await shot(admin.page, '03-admin-review');
 await admin.page.selectOption('dialog[open] select[name=planId]', {value: db.prepare("SELECT id FROM partner_plans WHERE slug='professional'").get().id});
 await admin.page.click('dialog[open] button:has-text("Submit decision")');
 await admin.page.waitForSelector('.pill[data-status=approved]');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM partner_profiles').get().n, 1, 'approval created the partner profile');
 step('admin approved the application from the dashboard');

 // ---- 4. partner signs in -> dashboard --------------------------------------------------------------------
 const partner = await newPage('partner');
 await partner.page.goto(`${base}/partners/login`);
 await partner.page.fill('input[name=username]', 'e2e_sara');
 await partner.page.fill('input[name=password]', PASSWORD);
 await partner.page.click('button[type=submit]');
 await partner.page.waitForURL('**/partners/dashboard');
 await partner.page.waitForSelector('.link-card input');
 const referralUrl = await partner.page.inputValue('.link-card input');
 assert.match(referralUrl, /\/r\/[A-Z2-9]{8}$/);
 assert.equal(await partner.page.locator('.metric').count() >= 8, true);
 await shot(partner.page, '04-dashboard-empty');
 step('partner logs in and lands on /partners/dashboard with a real referral link');

 // ---- 5. a customer arrives through the link and signs up ------------------------------------------------
 const visitor = await newPage('visitor');
 await visitor.page.goto(referralUrl);
 await visitor.page.waitForLoadState('domcontentloaded');
 const signup = await visitor.page.evaluate(async () => (await fetch('/api/signup', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'Customer One', username: 'e2e_cust', email: 'cust@e2e.example', password: 'e2e-long-password-1'})})).status);
 assert.equal(signup, 201);
 await visitor.context.close();
 assert.equal(db.prepare("SELECT status FROM referrals").get().status, 'registered');
 await verifyEmail(partner.page, 'cust@e2e.example');
 await partner.page.goto(`${base}/partners/referrals`);
 await partner.page.click('[role=tab] >> text=Referral list');
 await partner.page.waitForSelector('tbody tr');
 assert.match(await partner.page.locator('tbody').innerText(), /c\*\*\*@e\*\*\*/, 'partner sees only a masked customer email');
 await shot(partner.page, '05-referrals');
 step('customer signup is attributed to the partner and masked in the portal');

 // ---- 6. payment through the signed billing webhook --------------------------------------------------------
 const payload = JSON.stringify({id: 'e2e_pay_1', type: 'payment_succeeded', customer: {email: 'cust@e2e.example'}, planRef: 'pro', amountMinor: 20000, currency: 'SAR', occurredAt: new Date().toISOString()});
 const hook = await fetch(`${base}/api/webhooks/partner-billing`, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-frost-signature': 'sha256=' + createHmac('sha256', SECRET).update(payload).digest('hex')}, body: payload});
 assert.equal((await hook.json()).result, 'commission_created');
 assert.equal(db.prepare('SELECT commission_minor FROM commissions').get().commission_minor, 5000, '25% of 200.00');
 step('signed webhook created a pending commission (25% of 200.00 = 50.00)');

 // ---- 7. admin approves it (hold = 0 so it is immediately available) -------------------------------------------
 await admin.page.click('#partnerships [role=tab] >> text=Commissions');
 await admin.page.waitForSelector('button:has-text("Approve")');
 await shot(admin.page, '07-admin-commissions');
 await admin.page.click('button:has-text("Approve") >> nth=0');
 await admin.page.click('dialog[open] button:has-text("Confirm")');
 await admin.page.waitForSelector('.pill[data-status=available]');
 step('admin approved the commission; it is now available');

 // ---- 8. partner adds a payout method and requests a payout --------------------------------------------------
 await partner.page.goto(`${base}/partners/payouts`);
 await partner.page.waitForSelector('text=Withdrawable balance');
 await partner.page.click('button:has-text("Add method")');
 await partner.page.fill('dialog[open] input[name=accountName]', 'Sara Partner');
 await partner.page.fill('dialog[open] input[name=iban]', 'SA0380000000608010167519');
 await partner.page.fill('dialog[open] input[name=bankName]', 'Test Bank');
 await partner.page.click('dialog[open] button:has-text("Save")');
 await partner.page.waitForSelector('text=Test Bank •••• 7519');
 assert.ok(!(await partner.page.content()).includes('SA0380000000608010167519'), 'the IBAN is never rendered');
 await shot(partner.page, '08-payouts-method');
 await partner.page.click('button:has-text("Request payout")');
 await partner.page.click('dialog[open] button:has-text("Submit request")');
 await partner.page.waitForSelector('.pill[data-status=requested]');
 step('partner added a masked payout method and requested a payout');

 // ---- 9. admin marks it paid --------------------------------------------------------------------------------------
 await admin.page.click('#partnerships [role=tab] >> text=Payouts');
 await admin.page.waitForSelector('button:has-text("Open")');
 await admin.page.click('button:has-text("Open")');
 await admin.page.waitForSelector('dialog[open] button:has-text("Show payment details")');
 await admin.page.click('dialog[open] button:has-text("Show payment details")');
 await admin.page.waitForSelector('text=SA0380000000608010167519');
 await shot(admin.page, '09-admin-payout');
 await admin.page.click('dialog[open] button:has-text("Approve")');
 await admin.page.click('dialog[open] >> nth=1 >> button:has-text("Confirm")');
 await admin.page.waitForSelector('dialog[open] button:has-text("Mark as paid")');
 await admin.page.click('dialog[open] button:has-text("Mark as paid")');
 await admin.page.fill('dialog[open] >> nth=1 >> input[name=value]', 'BANK-E2E-1');
 await admin.page.click('dialog[open] >> nth=1 >> button:has-text("Save")');
 await admin.page.waitForSelector('dialog[open] .pill[data-status=paid]');
 step('admin approved and marked the payout paid with a payment reference');

 // ---- 10. partner sees the paid payout ------------------------------------------------------------------------------
 await partner.page.reload();
 await partner.page.waitForSelector('.pill[data-status=paid]');
 assert.match(await partner.page.locator('tbody').innerText(), /BANK-E2E-1/);
 await shot(partner.page, '10-payouts-paid');
 const ledger = Object.fromEntries(db.prepare('SELECT bucket, SUM(amount_minor) v FROM commission_ledger GROUP BY bucket').all().map(r => [r.bucket, r.v]));
 assert.deepEqual({pending: ledger.pending, available: ledger.available, reserved: ledger.reserved, paid: ledger.paid}, {pending: 0, available: 0, reserved: 0, paid: 5000}, 'ledger balances reconcile');
 step('partner sees the payout as paid; ledger reconciles (pending 0, available 0, reserved 0, paid 50.00)');

 // ---- responsive / RTL spot checks ---------------------------------------------------------------------------------------
 const mobile = await newPage('mobile', {locale: 'ar', viewport: {width: 390, height: 800}});
 await mobile.page.goto(`${base}/partners/login`);
 await mobile.page.fill('input[name=username]', 'e2e_sara');
 await mobile.page.fill('input[name=password]', PASSWORD);
 await mobile.page.click('button[type=submit]');
 await mobile.page.waitForURL('**/partners/dashboard');
 await mobile.page.waitForSelector('.metric');
 const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
 assert.ok(overflow <= 1, `no horizontal page scroll on mobile (overflow ${overflow}px)`);
 await mobile.page.click('.menu-btn');
 await mobile.page.waitForSelector('.sidebar.open');
 await mobile.page.waitForTimeout(400);
 await mobile.page.screenshot({path: join(shots, '11-mobile-menu-ar.png')});
 assert.equal(await mobile.page.locator('html').getAttribute('dir'), 'rtl');
 step('mobile (390px, Arabic/RTL): no horizontal scroll, navigation drawer works');

 // ---- every portal page and every admin tab renders without errors (both languages) -------------------------------
 for (const path of ['referrals', 'customers', 'commissions', 'payouts', 'marketing', 'settings']) {
  await partner.page.goto(`${base}/partners/${path}`);
  await partner.page.waitForSelector('main h1');
  assert.equal(await partner.page.locator('.state-error').count(), 0, `${path}: no error state`);
  await shot(partner.page, `12-portal-${path}`);
 }
 await partner.page.goto(`${base}/partners/marketing`);
 await partner.page.waitForSelector('.asset, .state');
 await admin.page.keyboard.press('Escape');
 for (const tab of ['Overview', 'Applications', 'Partners', 'Plans', 'Commissions', 'Payouts', 'Marketing assets', 'Settings']) {
  await admin.page.click(`#partnerships [role=tab] >> text=${tab}`);
  await admin.page.waitForSelector(`[data-tab] >> visible=true`);
  await admin.page.waitForFunction(() => !document.querySelector('.pt-panel:not([hidden]) .skeleton'));
  assert.equal(await admin.page.locator('.pt-panel:not([hidden]) .empty strong').filter({hasText: /Error|Not found|Forbidden/i}).count(), 0, `admin ${tab}: no error`);
  await shot(admin.page, `13-admin-${tab.replace(/ /g, '-').toLowerCase()}`);
 }
 step('all portal pages and admin tabs render without errors');
 await admin.page.close();
 assert.deepEqual(problems, [], 'no console errors or page errors:\n' + problems.join('\n'));
 console.log('partners journey: OK');
} catch (error) {
 if (problems.length) console.error(['Browser problems before the failure:', ...problems].join('\n'));
 throw error;
} finally {
 await browser.close();
 await new Promise(resolve => app.server.close(resolve));
 app.store.close();
 await rm(directory, {recursive: true, force: true});
}
