// Universal Integration Platform — Playwright E2E Journey 4 (Phase 6G, Part 52).
// Create connection -> real webhook URL -> a validly-signed event is accepted -> rotate the
// public ID through the real UI -> the OLD URL now 404s, the NEW one works -> rotate the
// secret through the real UI -> the OLD signature now fails, the NEW one works. A REAL browser
// test against a real, ephemeral instance of the actual application. Run with:
//   node tests/e2e/webhook-operations-journey.e2e.mjs
import { randomBytes, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/application.js';

const key32 = randomBytes(32).toString('hex');
const directory = await mkdtemp(join(tmpdir(), 'hypercool-e2e-webhookops-'));
const app = await createApp({ dataDir: directory, env: { INTEGRATION_ENCRYPTION_KEY: key32, PLATFORM_ADMIN_USERNAMES: 'platform_admin' } });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const failures = [];
function check(label, cond) { if (cond) console.log('OK  -', label); else { console.log('FAIL-', label); failures.push(label); } }
page.on('pageerror', err => console.log('  [page error]', err.message));

function sign(body, secret) { return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'); }
function orderPayload(id) { return JSON.stringify({ event: 'order.created', id, data: { order: { id: 'ord_1', total: 42 } } }); }

await page.goto(base + '/');
await page.waitForSelector('#auth-form [name=username]', { state: 'visible' });
await page.fill('#auth-form [name=name]', 'Platform Admin');
await page.fill('#auth-form [name=username]', 'platform_admin');
await page.fill('#auth-form [name=password]', 'a-long-test-password-123');
await page.click('#auth-form button');
await page.waitForSelector('#session-bar', { state: 'visible', timeout: 15000 });
check('logged in', await page.isVisible('#session-bar'));

// --- Publish a connector with a real HMAC webhook trigger, auth NONE (no outbound network
// needed at all for this journey — only INBOUND webhook delivery is exercised). ---
await page.click('#nav-integration-builder');
await page.waitForSelector('#pf-connectors', { state: 'visible' });
await page.waitForTimeout(400);
await page.click('button:has-text("إنشاء تكامل جديد")');
await page.waitForSelector('dialog.drawer[open] [name=slug]', { state: 'visible', timeout: 10000 });
const slug = 'e2e_webhookops_' + Date.now();
await page.fill('dialog.drawer[open] [name=slug]', slug);
await page.fill('dialog.drawer[open] [name=nameAr]', 'رحلة الويبهوك');
await page.fill('dialog.drawer[open] [name=nameEn]', 'E2E Webhook Ops');
await page.fill('dialog.drawer[open] [name=baseUrl]', 'https://api.e2e-webhookops.test');
await page.selectOption('dialog.drawer[open] [name=authType]', 'NONE');
await page.check('dialog.drawer[open] [name=cap][value="commerce.orders.read"]');
await page.click('dialog.drawer[open] #basic-actions button:has-text("إنشاء المسودة")');
await page.waitForTimeout(500);

let tabButtons = await page.$$('dialog.drawer[open] [role=tab]');
await tabButtons[2].click(); // Webhooks
await page.waitForTimeout(200);
await page.click('dialog.drawer[open] button:has-text("إضافة حدث")');
await page.waitForSelector('dialog.confirmation [name=slug]', { state: 'visible' });
await page.fill('dialog.confirmation [name=slug]', 'order_created');
await page.fill('dialog.confirmation [name=name]', 'Order Created');
await page.selectOption('dialog.confirmation [name=authType]', 'HMAC');
await page.fill('dialog.confirmation [name=signatureHeader]', 'X-Signature');
await page.fill('dialog.confirmation [name=signaturePrefix]', 'sha256=');
await page.fill('dialog.confirmation [name=eventIdPath]', 'id');
await page.selectOption('dialog.confirmation [name=eventIdPolicy]', 'REQUIRED');
await page.fill('dialog.confirmation [name=normalizedEventType]', 'ORDER_CREATED');
await page.click('dialog.confirmation button:has-text("إضافة حدث")');
await page.waitForTimeout(500);
check('trigger added', (await page.locator('dialog.drawer[open]').innerText()).includes('order_created'));

await page.getByRole('tab', { name: /المراجعة والنشر/ }).click();
await page.waitForTimeout(200);
await page.click('dialog.drawer[open] button:has-text("نشر الآن")');
await page.waitForTimeout(400);
let confirmButtons = await page.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/^نشر الآن$/.test(t.trim())) { await b.click(); break; } }
await page.waitForTimeout(500);
check('connector published', (await page.locator('dialog.drawer[open]').innerText()).includes('منشور'));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// --- Connect (NONE auth: no secret field, just Save) ------------------------------------------
await page.click('#nav-control-center');
await page.waitForSelector('#control-center', { state: 'visible' });
await page.click('#cc-tabs [role=tab]:has-text("التكاملات")');
await page.waitForTimeout(500);
const card = page.locator(`#cc-panel-integrations .card:has-text("رحلة الويبهوك")`);
for (const b of await card.locator('button').all()) { const t = (await b.textContent()) || ''; if (/إضافة اتصال/.test(t)) { await b.click(); break; } }
await page.waitForSelector('dialog.confirmation[open]', { state: 'visible', timeout: 5000 });
await page.click('dialog.confirmation[open] button:has-text("حفظ")');
await page.waitForTimeout(800);
const connections = await page.evaluate(async s => (await (await fetch('/api/integrations/connections')).json()).filter(c => c.integrationDefinitionId === s), slug);
check('connection created and CONNECTED', connections.length === 1 && connections[0].status === 'CONNECTED');
const connectionId = connections[0].id;

// --- Rotate the webhook secret ONCE first (this connector never had one — Rotate Secret is
// also how the very first secret gets provisioned, matching this connector's NONE primary
// auth) via the real Advanced > Webhook UI, then send a validly-signed event. -----------------
const manageButtons = await page.locator(`#cc-panel-integrations .card:has-text("رحلة الويبهوك") button:has-text("إدارة")`).all();
await manageButtons[0].click();
await page.waitForSelector('dialog.drawer[open]', { state: 'visible' });
await page.waitForTimeout(300);
const advancedButtons = await page.locator('dialog.drawer[open] button:has-text("متقدّم")').all();
await advancedButtons[0].click();
await page.waitForSelector('dialog.drawer[open]:has-text("متقدّم")', { state: 'visible' });
await page.waitForTimeout(500);
const tabsInAdvanced = await page.locator('dialog.drawer[open]').last().locator('[role=tab]').all();
await tabsInAdvanced[1].click(); // Webhook tab
await page.waitForTimeout(500);

const urlInput = page.locator('dialog.drawer[open]').last().locator('input[readonly]').first();
const url1 = await urlInput.inputValue();
check('real webhook URL shown', /\/api\/webhooks\/connectors\//.test(url1));

let secret1 = null;
page.once('dialog', () => {}); // no native dialogs expected, defensive no-op
const rotateSecretButton = page.locator('dialog.drawer[open]').last().locator('button:has-text("تدوير سر الويبهوك")');
await rotateSecretButton.click();
await page.waitForTimeout(300);
confirmButtons = await page.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/تدوير سر الويبهوك/.test(t.trim())) { await b.click(); break; } }
await page.waitForSelector('dialog.confirmation[open] input[readonly]', { state: 'visible', timeout: 5000 });
secret1 = await page.locator('dialog.confirmation[open] input[readonly]').inputValue();
check('a real, non-empty secret was generated and shown once', typeof secret1 === 'string' && secret1.length >= 32);
await page.click('dialog.confirmation[open] button:has-text("إغلاق")');
await page.waitForTimeout(300);

// --- Deliver a validly-signed event directly (real inbound HTTP, exactly as an external
// platform would) and confirm the real pipeline processed it. ---------------------------------
const body1 = orderPayload('evt-1');
let response = await page.evaluate(async ({ url, body, sig }) => {
 const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body });
 return { status: r.status, data: await r.json() };
}, { url: url1, body: body1, sig: sign(body1, secret1) });
check('validly-signed event PROCESSED', response.status === 200 && response.data.status === 'PROCESSED');

// --- Rotate the public ID (URL) -----------------------------------------------------------
const rotateUrlButton = page.locator('dialog.drawer[open]').last().locator('button:has-text("تدوير رابط الويبهوك")');
await rotateUrlButton.click();
await page.waitForTimeout(300);
confirmButtons = await page.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/تدوير رابط الويبهوك/.test(t.trim())) { await b.click(); break; } }
await page.waitForTimeout(600);
const url2 = await page.locator('dialog.drawer[open]').last().locator('input[readonly]').first().inputValue();
check('a genuinely different URL after rotation', url2 !== url1 && /\/api\/webhooks\/connectors\//.test(url2));

const oldUrlBody = orderPayload('evt-old-url');
const oldUrlResponse = await page.evaluate(async ({ url, body, sig }) => {
 const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body });
 return r.status;
}, { url: url1, body: oldUrlBody, sig: sign(oldUrlBody, secret1) });
check('OLD URL now 404s — stops resolving immediately', oldUrlResponse === 404);

const newUrlBody = orderPayload('evt-new-url');
const newUrlResponse = await page.evaluate(async ({ url, body, sig }) => {
 const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body });
 return { status: r.status, data: await r.json() };
}, { url: url2, body: newUrlBody, sig: sign(newUrlBody, secret1) });
check('NEW URL works with the SAME still-valid secret', newUrlResponse.status === 200 && newUrlResponse.data.status === 'PROCESSED');

// --- Rotate the secret ------------------------------------------------------------------------
await rotateSecretButton.click();
await page.waitForTimeout(300);
confirmButtons = await page.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/تدوير سر الويبهوك/.test(t.trim())) { await b.click(); break; } }
await page.waitForSelector('dialog.confirmation[open] input[readonly]', { state: 'visible', timeout: 5000 });
const secret2 = await page.locator('dialog.confirmation[open] input[readonly]').inputValue();
check('a genuinely different secret after rotation', secret2 !== secret1 && secret2.length >= 32);
await page.click('dialog.confirmation[open] button:has-text("إغلاق")');
await page.waitForTimeout(300);

const oldSigBody = orderPayload('evt-old-sig');
const oldSigResponse = await page.evaluate(async ({ url, body, sig }) => {
 const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body });
 return r.status;
}, { url: url2, body: oldSigBody, sig: sign(oldSigBody, secret1) });
check('OLD signature now fails', oldSigResponse === 401);

const newSigBody = orderPayload('evt-new-sig');
const newSigResponse = await page.evaluate(async ({ url, body, sig }) => {
 const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body });
 return { status: r.status, data: await r.json() };
}, { url: url2, body: newSigBody, sig: sign(newSigBody, secret2) });
check('NEW signature works', newSigResponse.status === 200 && newSigResponse.data.status === 'PROCESSED');

await browser.close();
app.store.close();
await rm(directory, { recursive: true, force: true });
console.log('\n=== JOURNEY 4 (WEBHOOK OPERATIONS) SUMMARY ===');
console.log(failures.length ? `${failures.length} FAILURE(S): ${failures.join(' | ')}` : 'ALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
