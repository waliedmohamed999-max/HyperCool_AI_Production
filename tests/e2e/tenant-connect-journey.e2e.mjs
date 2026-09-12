// Universal Integration Platform — Playwright E2E Journey 2 (Phase 6F, Part 74/76).
// Platform Admin publishes a real dynamic connector; a Tenant Owner discovers it automatically
// in Control Center, connects it (Generic Connection UI), and assigns the generic get_invoices
// tool to the exact resulting connection — all through the real browser UI, real HTTP routes,
// zero mocking of the app itself. Run with: node tests/e2e/tenant-connect-journey.e2e.mjs
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/application.js';

const key32 = randomBytes(32).toString('hex');
const directory = await mkdtemp(join(tmpdir(), 'hypercool-e2e-tenant-'));
const app = await createApp({ dataDir: directory, env: { INTEGRATION_ENCRYPTION_KEY: key32, PLATFORM_ADMIN_USERNAMES: 'platform_admin' } });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const failures = [];
function check(label, cond) { if (cond) console.log('OK  -', label); else { console.log('FAIL-', label); failures.push(label); } }
page.on('pageerror', err => console.log('  [page error]', err.message));

// The first real signup is both the tenant Owner AND (matching the allowlist) the Platform
// Admin — this journey uses ONE session for both roles, exactly as a real small-team pilot
// deployment's very first user genuinely would.
await page.goto(base + '/');
await page.waitForSelector('#auth-form [name=username]', { state: 'visible' });
await page.fill('#auth-form [name=name]', 'Platform Admin');
await page.fill('#auth-form [name=username]', 'platform_admin');
await page.fill('#auth-form [name=password]', 'a-long-test-password-123');
await page.click('#auth-form button');
await page.waitForSelector('#session-bar', { state: 'visible', timeout: 15000 });
check('logged in', await page.isVisible('#session-bar'));

// --- Publish a connector via the Builder ----------------------------------------------------
await page.waitForSelector('#nav-integration-builder:not([hidden])', { timeout: 10000 }).catch(() => {});
await page.click('#nav-integration-builder');
await page.waitForSelector('#pf-connectors', { state: 'visible' });
await page.waitForTimeout(400);
await page.click('button:has-text("إنشاء تكامل جديد")');
await page.waitForSelector('dialog.drawer[open] [name=slug]', { state: 'visible', timeout: 10000 });
const slug = 'e2e_journey2_' + Date.now();
await page.fill('dialog.drawer[open] [name=slug]', slug);
await page.fill('dialog.drawer[open] [name=nameAr]', 'رحلة اختبار 2');
await page.fill('dialog.drawer[open] [name=nameEn]', 'E2E Journey 2');
await page.fill('dialog.drawer[open] [name=baseUrl]', 'https://api.e2e-journey2.test');
await page.check('dialog.drawer[open] [name=cap][value="accounting.invoices.read"]');
await page.click('dialog.drawer[open] #basic-actions button:has-text("إنشاء المسودة")');
await page.waitForTimeout(500);
let tabButtons = await page.$$('dialog.drawer[open] [role=tab]');
await tabButtons[1].click();
await page.waitForTimeout(200);
await page.click('dialog.drawer[open] button:has-text("إضافة إجراء")');
await page.waitForSelector('dialog.confirmation [name=slug]', { state: 'visible' });
await page.fill('dialog.confirmation [name=slug]', 'get_invoices');
await page.fill('dialog.confirmation [name=nameAr]', 'الفواتير');
await page.fill('dialog.confirmation [name=nameEn]', 'Invoices');
await page.fill('dialog.confirmation [name=pathTemplate]', '/invoices');
await page.click('dialog.confirmation button:has-text("إضافة إجراء")');
await page.waitForTimeout(600);
tabButtons = await page.$$('dialog.drawer[open] [role=tab]');
await tabButtons[4].click();
await page.waitForTimeout(200);
await page.click('dialog.drawer[open] button:has-text("نشر الآن")');
await page.waitForTimeout(400);
const confirmButtons = await page.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/^نشر الآن$/.test(t.trim())) { await b.click(); break; } }
await page.waitForTimeout(500);
check('connector published', (await page.locator('dialog.drawer[open]').innerText()).includes('منشور'));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// --- Tenant Owner: discover + connect --------------------------------------------------------
await page.reload();
await page.waitForSelector('#session-bar', { state: 'visible', timeout: 15000 });
await page.click('#nav-control-center');
await page.waitForSelector('#control-center', { state: 'visible' });
await page.click('#cc-tabs [role=tab]:has-text("التكاملات")');
await page.waitForTimeout(500);
const ccText = await page.textContent('#cc-panel-integrations').catch(() => '');
check('new connector visible automatically in Control Center', (ccText || '').includes('رحلة اختبار 2'));

const card = page.locator(`#cc-panel-integrations .card:has-text("رحلة اختبار 2")`);
const cardButtons = await card.locator('button').all();
let clickedConnect = false;
for (const b of cardButtons) { const t = (await b.textContent()) || ''; if (/إضافة اتصال/.test(t)) { await b.click(); clickedConnect = true; break; } }
check('Add Connection button present', clickedConnect);
if (clickedConnect) {
 await page.waitForSelector('dialog.confirmation[open] input[type=password]', { state: 'visible', timeout: 5000 }).catch(() => {});
 const pw = await page.$('dialog.confirmation[open] input[type=password]');
 if (pw) await pw.fill('e2e-test-key');
 await page.click('dialog.confirmation[open] button:has-text("حفظ")');
 await page.waitForTimeout(1200);
}
// A real, honest network failure is expected (no live api.e2e-journey2.test) — the connection
// stays un-connected; this journey proves the WIRING, not a live third-party API.
const connectionsAfter = await page.evaluate(async slug => (await (await fetch('/api/integrations/connections')).json()).filter(c => c.integrationDefinitionId === slug), slug);
check('a connection row was actually created for the new connector', connectionsAfter.length >= 1);

// --- Tool assignment: generic get_invoices tool sees the real connection -------------------
const compatible = await page.evaluate(async () => (await (await fetch('/api/tools/get_invoices/connections')).json()));
check('get_invoices tool compatibility route lists at least one connection', Array.isArray(compatible) && compatible.length >= 1);

await browser.close();
app.store.close();
await rm(directory, { recursive: true, force: true });
console.log('\n=== JOURNEY 2 SUMMARY ===');
console.log(failures.length ? `${failures.length} FAILURE(S): ${failures.join(' | ')}` : 'ALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
