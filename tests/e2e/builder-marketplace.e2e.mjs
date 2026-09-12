// Universal Integration Platform — Playwright E2E Journey 1 (Phase 6F, Part 74/75).
// Platform Admin: create a real dynamic connector entirely through the Integration Builder UI,
// publish it, and confirm it appears automatically in the tenant-facing catalog — with ZERO
// hand-written frontend code for the new connector. This is a REAL browser test against a real,
// ephemeral instance of the actual application (not a mock) — run with:
//   node tests/e2e/builder-marketplace.e2e.mjs
// Exits 0 on success, 1 on any failed check (suitable for a CI step).
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/application.js';

const key32 = randomBytes(32).toString('hex');
const directory = await mkdtemp(join(tmpdir(), 'hypercool-e2e-builder-'));
const app = await createApp({ dataDir: directory, env: { INTEGRATION_ENCRYPTION_KEY: key32, PLATFORM_ADMIN_USERNAMES: 'platform_admin' } });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const failures = [];
function check(label, cond) { if (cond) console.log('OK  -', label); else { console.log('FAIL-', label); failures.push(label); } }
page.on('pageerror', err => console.log('  [page error]', err.message));

await page.goto(base + '/');
await page.waitForSelector('#auth-form [name=username]', { state: 'visible' });
await page.fill('#auth-form [name=name]', 'Platform Admin');
await page.fill('#auth-form [name=username]', 'platform_admin');
await page.fill('#auth-form [name=password]', 'a-long-test-password-123');
await page.click('#auth-form button');
await page.waitForSelector('#session-bar', { state: 'visible', timeout: 15000 });
check('Platform Admin logged in', await page.isVisible('#session-bar'));

await page.waitForSelector('#nav-integration-builder:not([hidden])', { timeout: 10000 }).catch(() => {});
await page.click('#nav-integration-builder');
await page.waitForSelector('#pf-connectors', { state: 'visible' });
await page.waitForTimeout(400);

await page.click('button:has-text("إنشاء تكامل جديد")');
await page.waitForSelector('dialog.drawer[open] [name=slug]', { state: 'visible', timeout: 10000 });
const slug = 'e2e_journey1_' + Date.now();
await page.fill('dialog.drawer[open] [name=slug]', slug);
await page.fill('dialog.drawer[open] [name=nameAr]', 'رحلة اختبار 1');
await page.fill('dialog.drawer[open] [name=nameEn]', 'E2E Journey 1');
await page.fill('dialog.drawer[open] [name=baseUrl]', 'https://api.e2e-journey1.test');
await page.check('dialog.drawer[open] [name=cap][value="accounting.invoices.read"]');
await page.click('dialog.drawer[open] #basic-actions button:has-text("إنشاء المسودة")');
await page.waitForTimeout(500);
check('draft created', await page.getAttribute('dialog.drawer[open] [name=slug]', 'disabled') !== null);

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
check('action added', (await page.locator('dialog.drawer[open]').innerText()).includes('get_invoices'));

tabButtons = await page.$$('dialog.drawer[open] [role=tab]');
await tabButtons[4].click();
await page.waitForTimeout(200);
await page.evaluate(async () => { window.__preCatalog = await (await fetch('/api/integrations/catalog')).json(); });
const slugPresentBeforePublish = await page.evaluate(s => window.__preCatalog.some(c => c.slug === s), slug);
check('connector NOT in tenant catalog while still a draft', !slugPresentBeforePublish);

await page.click('dialog.drawer[open] button:has-text("نشر الآن")');
await page.waitForTimeout(400);
const confirmButtons = await page.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/^نشر الآن$/.test(t.trim())) { await b.click(); break; } }
await page.waitForTimeout(500);
check('connector PUBLISHED', (await page.locator('dialog.drawer[open]').innerText()).includes('منشور'));

const catalogAfter = await page.evaluate(async () => (await (await fetch('/api/integrations/catalog')).json()));
check('connector appears automatically in the tenant catalog after publish — zero frontend code written for it', catalogAfter.some(c => c.slug === slug));

await browser.close();
app.store.close();
await rm(directory, { recursive: true, force: true });
console.log('\n=== JOURNEY 1 SUMMARY ===');
console.log(failures.length ? `${failures.length} FAILURE(S): ${failures.join(' | ')}` : 'ALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
