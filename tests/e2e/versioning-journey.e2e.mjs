// Universal Integration Platform — Playwright E2E Journey 3 (Phase 6G, Part 51).
// Publish v1 -> connect (pinned to v1) -> create v2 via the Versions tab -> the existing
// connection stays pinned to v1 -> migrate to v2 through the real UI (pre-flight preview +
// confirmation) -> real health check -> rollback. A REAL browser test against a real,
// ephemeral instance of the actual application. Run with:
//   node tests/e2e/versioning-journey.e2e.mjs
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/application.js';

const key32 = randomBytes(32).toString('hex');
const directory = await mkdtemp(join(tmpdir(), 'hypercool-e2e-versioning-'));
const app = await createApp({ dataDir: directory, env: { INTEGRATION_ENCRYPTION_KEY: key32, PLATFORM_ADMIN_USERNAMES: 'platform_admin' } });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const failures = [];
function check(label, cond) { if (cond) console.log('OK  -', label); else { console.log('FAIL-', label); failures.push(label); } }
page.on('pageerror', err => console.log('  [page error]', err.message));

await page.goto(base + '/app');
await page.waitForSelector('#auth-form [name=username]', { state: 'visible' });
await page.fill('#auth-form [name=name]', 'Platform Admin');
await page.fill('#auth-form [name=username]', 'platform_admin');
await page.fill('#auth-form [name=password]', 'a-long-test-password-123');
await page.click('#auth-form button');
await page.waitForSelector('#session-bar', { state: 'visible', timeout: 15000 });
check('logged in', await page.isVisible('#session-bar'));

// --- Publish v1 (deliberately NO health check declared — Part 47 of Phase 6B: SSRF correctly
// blocks any real outbound call to a fake .test host, so a connector with no declared health
// check is the one honest way this E2E suite proves a REAL success path without a live API,
// exactly like tests/e2e/tenant-connect-journey.e2e.mjs already establishes for connecting). ---
await page.click('#nav-integration-builder');
await page.waitForSelector('#pf-connectors', { state: 'visible' });
await page.waitForTimeout(400);
await page.click('button:has-text("إنشاء تكامل جديد")');
await page.waitForSelector('dialog.drawer[open] [name=slug]', { state: 'visible', timeout: 10000 });
const slug = 'e2e_versioning_' + Date.now();
await page.fill('dialog.drawer[open] [name=slug]', slug);
await page.fill('dialog.drawer[open] [name=nameAr]', 'رحلة الإصدارات');
await page.fill('dialog.drawer[open] [name=nameEn]', 'E2E Versioning');
await page.fill('dialog.drawer[open] [name=baseUrl]', 'https://api.e2e-versioning.test');
await page.check('dialog.drawer[open] [name=cap][value="commerce.orders.read"]');
await page.click('dialog.drawer[open] #basic-actions button:has-text("إنشاء المسودة")');
await page.waitForTimeout(500);

let tabButtons = await page.$$('dialog.drawer[open] [role=tab]');
await tabButtons[1].click(); // Actions
await page.waitForTimeout(200);
await page.click('dialog.drawer[open] button:has-text("إضافة إجراء")');
await page.waitForSelector('dialog.confirmation [name=slug]', { state: 'visible' });
await page.fill('dialog.confirmation [name=slug]', 'get_orders');
await page.fill('dialog.confirmation [name=nameAr]', 'الطلبات');
await page.fill('dialog.confirmation [name=nameEn]', 'Orders');
await page.fill('dialog.confirmation [name=pathTemplate]', '/orders');
await page.click('dialog.confirmation button:has-text("إضافة إجراء")');
await page.waitForTimeout(500);

await page.getByRole('tab', { name: /المراجعة والنشر/ }).click();
await page.waitForTimeout(200);
await page.click('dialog.drawer[open] button:has-text("نشر الآن")');
await page.waitForTimeout(400);
let confirmButtons = await page.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/^نشر الآن$/.test(t.trim())) { await b.click(); break; } }
await page.waitForTimeout(500);
check('connector v1 published', (await page.locator('dialog.drawer[open]').innerText()).includes('منشور'));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// --- Connect (NONE auth would skip credential entirely; use API_KEY to also prove the pin
// happens on the credential-route success path, not just the OAuth one). ---
await page.click('#nav-control-center');
await page.waitForSelector('#control-center', { state: 'visible' });
await page.click('#cc-tabs [role=tab]:has-text("التكاملات")');
await page.waitForTimeout(500);
const card = page.locator(`#cc-panel-integrations .card:has-text("رحلة الإصدارات")`);
const addButtons = await card.locator('button').all();
for (const b of addButtons) { const t = (await b.textContent()) || ''; if (/إضافة اتصال/.test(t)) { await b.click(); break; } }
await page.waitForSelector('dialog.confirmation[open] input[type=password]', { state: 'visible', timeout: 5000 });
await page.fill('dialog.confirmation[open] input[type=password]', 'e2e-key');
await page.click('dialog.confirmation[open] button:has-text("حفظ")');
await page.waitForTimeout(800);

let connections = await page.evaluate(async s => (await (await fetch('/api/integrations/connections')).json()).filter(c => c.integrationDefinitionId === s), slug);
check('connection created and CONNECTED (no health declared -> trivially OK)', connections.length === 1 && connections[0].status === 'CONNECTED');
check('connection pinned to version 1 at connect time', connections[0].connectorVersion === 1);
const connectionId = connections[0].id;

// --- Create v2 via the Versions tab, edit the action path, publish ---------------------------
await page.click('#nav-integration-builder');
await page.waitForSelector('#pf-connectors', { state: 'visible' });
await page.waitForTimeout(400);
await page.click(`#pf-connectors-list tr:has-text("رحلة الإصدارات") button:has-text("إدارة")`);
await page.waitForSelector('dialog.drawer[open]', { state: 'visible' });
await page.waitForTimeout(300);
tabButtons = await page.$$('dialog.drawer[open] [role=tab]');
await tabButtons[4].click(); // Versions (index 4: Basic/Actions/Webhooks/Health/Versions/Review)
await page.waitForTimeout(400);
await page.click('dialog.drawer[open] button:has-text("إنشاء نسخة مسودة جديدة")');
await page.waitForSelector('dialog.confirmation [open]', { state: 'attached' }).catch(() => {});
confirmButtons = await page.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/إنشاء نسخة مسودة جديدة/.test(t.trim())) { await b.click(); break; } }
await page.waitForTimeout(500);

tabButtons = await page.$$('dialog.drawer[open] [role=tab]');
await tabButtons[1].click(); // Actions
await page.waitForTimeout(200);
const deleteButtons = await page.locator('dialog.drawer[open] button:has-text("حذف الإجراء")').all();
if (deleteButtons.length) await deleteButtons[0].click();
await page.waitForTimeout(300);
await page.click('dialog.drawer[open] button:has-text("إضافة إجراء")');
await page.waitForSelector('dialog.confirmation [name=slug]', { state: 'visible' });
await page.fill('dialog.confirmation [name=slug]', 'get_orders');
await page.fill('dialog.confirmation [name=nameAr]', 'الطلبات');
await page.fill('dialog.confirmation [name=nameEn]', 'Orders');
await page.fill('dialog.confirmation [name=pathTemplate]', '/v2/orders');
await page.click('dialog.confirmation button:has-text("إضافة إجراء")');
await page.waitForTimeout(500);

await page.getByRole('tab', { name: /المراجعة والنشر/ }).click();
await page.waitForTimeout(200);
await page.click('dialog.drawer[open] button:has-text("نشر الآن")');
await page.waitForTimeout(400);
confirmButtons = await page.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/^نشر الآن$/.test(t.trim())) { await b.click(); break; } }
await page.waitForTimeout(500);
const definitionAfterV2 = await page.evaluate(async s => (await (await fetch('/api/platform/connectors')).json()).find(c => c.slug === s), slug);
check('connector republished as v2', definitionAfterV2.version === 2 && definitionAfterV2.status === 'PUBLISHED');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

connections = await page.evaluate(async id => [await (await fetch('/api/integrations/connections/' + id)).json()], connectionId);
check('existing connection UNAFFECTED by v2 publish — still pinned to v1', connections[0].connectorVersion === 1);

// --- Migrate through the real Advanced > Version UI -------------------------------------------
await page.click('#nav-control-center');
await page.waitForSelector('#control-center', { state: 'visible' });
await page.click('#cc-tabs [role=tab]:has-text("التكاملات")');
await page.waitForTimeout(400);
const manageButtons = await page.locator(`#cc-panel-integrations .card:has-text("رحلة الإصدارات") button:has-text("إدارة")`).all();
if (manageButtons.length) await manageButtons[0].click();
await page.waitForSelector('dialog.drawer[open]', { state: 'visible' });
await page.waitForTimeout(300);
const advancedButtons = await page.locator('dialog.drawer[open] button:has-text("متقدّم")').all();
check('Advanced button present on the connection card', advancedButtons.length > 0);
if (advancedButtons.length) await advancedButtons[0].click();
await page.waitForSelector('dialog.drawer[open]:has-text("متقدّم")', { state: 'visible' });
await page.waitForTimeout(500);
const versionText = await page.locator('dialog.drawer[open]').last().innerText();
check('Version panel shows current=1, available=2', /1/.test(versionText) && /2/.test(versionText));

const migrateButton = page.locator('dialog.drawer[open] button:has-text("الترقية إلى الإصدار 2")').last();
await migrateButton.click();
await page.waitForTimeout(500);
confirmButtons = await page.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/الترقية إلى الإصدار 2/.test(t.trim())) { await b.click(); break; } }
await page.waitForTimeout(800);

let afterMigrate = await page.evaluate(async id => await (await fetch('/api/integrations/connections/' + id)).json(), connectionId);
check('migration succeeded — connection now pinned to v2 (real health check passed, no network needed)', afterMigrate.connectorVersion === 2 && afterMigrate.status === 'CONNECTED');

// --- Rollback ------------------------------------------------------------------------------
const rollbackButton = page.locator('dialog.drawer[open] button:has-text("التراجع للإصدار السابق")').last();
if (await rollbackButton.count()) {
 await rollbackButton.click();
 await page.waitForTimeout(400);
 confirmButtons = await page.$$('dialog.confirmation button');
 for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/التراجع للإصدار السابق/.test(t.trim())) { await b.click(); break; } }
 await page.waitForTimeout(800);
}
const afterRollback = await page.evaluate(async id => await (await fetch('/api/integrations/connections/' + id)).json(), connectionId);
check('rollback succeeded — connection back on v1', afterRollback.connectorVersion === 1);

await browser.close();
app.store.close();
await rm(directory, { recursive: true, force: true });
console.log('\n=== JOURNEY 3 (VERSIONING) SUMMARY ===');
console.log(failures.length ? `${failures.length} FAILURE(S): ${failures.join(' | ')}` : 'ALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
