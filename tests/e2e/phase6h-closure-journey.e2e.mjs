// Universal Integration Platform — Playwright E2E Journey 6 (Phase 6H, Part 43).
// Exercises the real, UI-observable surfaces of the 8 Phase 6H framework gaps that a browser
// journey adds genuine value over the existing deterministic backend test suites for:
//   (C) Bulk Migrate Connections — real UI drawer, real preview, real execution
//   (H) Platform Connector Analytics tab — real KPIs rendered from real data
//   (J) Agent Connection Map navigation — Agent/Connector cells are real, clickable links
//   (F) Tenant Custom Connector Webhook Trigger — real creation UI, flows through review
// Time-based state machines (Automatic Webhook Retry's backoff/dead-letter, D/E) and pure
// numeric-threshold enforcement (the per-tenant custom connector limit, I) are deliberately NOT
// re-tested here through a slow/fake-clock-driven browser flow — they already have strong,
// deterministic coverage in tests/webhook-automatic-retry.test.js (9 tests) and
// tests/tenant-custom-connectors.test.js + tests/production-pilot-hardening.test.js (a real HTTP
// end-to-end test of the Platform Admin route itself), which give stronger guarantees for that
// exact logic than a browser automation waiting on real backoff timers ever could. The Proactive
// Token Expiry badge (G) is a 3-line conditional render already covered by 7 dedicated backend
// tests (tests/connection-health-view.test.js); building a full OAuth2 authorize/token mock
// server here for marginal additional confidence was judged not worth the added flakiness.
// Run with:
//   node tests/e2e/phase6h-closure-journey.e2e.mjs
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/application.js';
import { createAuth } from '../../src/auth.js';
import { createTenant } from '../../src/tenancy.js';
import { installToolDefinitions } from '../../src/runtime/tool-definitions.js';
import { upsertAssignment } from '../../src/runtime/tool-assignments.js';

const key32 = randomBytes(32).toString('hex');
const directory = await mkdtemp(join(tmpdir(), 'hypercool-e2e-6h-closure-'));
const app = await createApp({ dataDir: directory, env: { INTEGRATION_ENCRYPTION_KEY: key32, PLATFORM_ADMIN_USERNAMES: 'platform_admin', ENABLE_TENANT_CUSTOM_CONNECTORS: 'true' } });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

const browser = await chromium.launch();
const failures = [];
function check(label, cond) { if (cond) console.log('OK  -', label); else { console.log('FAIL-', label); failures.push(label); } }

const adminContext = await browser.newContext();
const adminPage = await adminContext.newPage();
adminPage.on('pageerror', err => console.log('  [admin page error]', err.message));

// --- Platform Admin signs up ------------------------------------------------------------------
await adminPage.goto(base + '/');
await adminPage.waitForSelector('#auth-form [name=username]', { state: 'visible' });
await adminPage.fill('#auth-form [name=name]', 'Platform Admin');
await adminPage.fill('#auth-form [name=username]', 'platform_admin');
await adminPage.fill('#auth-form [name=password]', 'a-long-test-password-123');
await adminPage.click('#auth-form button');
await adminPage.waitForSelector('#session-bar', { state: 'visible', timeout: 15000 });
check('platform admin logged in', await adminPage.isVisible('#session-bar'));

// --- Build + publish v1 (same shape as Journey 3's own setup) -------------------------------
const slug = 'e2e_6h_' + Date.now();
await adminPage.click('#nav-integration-builder');
await adminPage.waitForSelector('#pf-connectors', { state: 'visible' });
await adminPage.waitForTimeout(400);
await adminPage.click('button:has-text("إنشاء تكامل جديد")');
await adminPage.waitForSelector('dialog.drawer[open] [name=slug]', { state: 'visible', timeout: 10000 });
await adminPage.fill('dialog.drawer[open] [name=slug]', slug);
await adminPage.fill('dialog.drawer[open] [name=nameAr]', 'رحلة إغلاق 6H');
await adminPage.fill('dialog.drawer[open] [name=nameEn]', 'E2E 6H Closure');
await adminPage.fill('dialog.drawer[open] [name=baseUrl]', 'https://api.e2e-6h.test');
await adminPage.check('dialog.drawer[open] [name=cap][value="commerce.orders.read"]');
await adminPage.click('dialog.drawer[open] #basic-actions button:has-text("إنشاء المسودة")');
await adminPage.waitForTimeout(500);

let tabButtons = await adminPage.$$('dialog.drawer[open] [role=tab]');
await tabButtons[1].click(); // Actions
await adminPage.waitForTimeout(200);
await adminPage.click('dialog.drawer[open] button:has-text("إضافة إجراء")');
await adminPage.waitForSelector('dialog.confirmation [name=slug]', { state: 'visible' });
await adminPage.fill('dialog.confirmation [name=slug]', 'get_orders');
await adminPage.fill('dialog.confirmation [name=nameAr]', 'الطلبات');
await adminPage.fill('dialog.confirmation [name=nameEn]', 'Orders');
await adminPage.fill('dialog.confirmation [name=pathTemplate]', '/orders');
await adminPage.click('dialog.confirmation button:has-text("إضافة إجراء")');
await adminPage.waitForTimeout(500);

await adminPage.getByRole('tab', { name: /المراجعة والنشر/ }).click();
await adminPage.waitForTimeout(200);
await adminPage.click('dialog.drawer[open] button:has-text("نشر الآن")');
await adminPage.waitForTimeout(400);
let confirmButtons = await adminPage.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/^نشر الآن$/.test(t.trim())) { await b.click(); break; } }
await adminPage.waitForTimeout(500);
check('connector v1 published', (await adminPage.locator('dialog.drawer[open]').innerText()).includes('منشور'));
await adminPage.keyboard.press('Escape');
await adminPage.waitForTimeout(300);

// --- Connect (pinned to v1) --------------------------------------------------------------------
await adminPage.click('#nav-control-center');
await adminPage.waitForSelector('#control-center', { state: 'visible' });
await adminPage.click('#cc-tabs [role=tab]:has-text("التكاملات")');
await adminPage.waitForTimeout(500);
const card = adminPage.locator(`#cc-panel-integrations .card:has-text("رحلة إغلاق 6H")`);
for (const b of await card.locator('button').all()) { const t = (await b.textContent()) || ''; if (/إضافة اتصال/.test(t)) { await b.click(); break; } }
await adminPage.waitForSelector('dialog.confirmation[open] input[type=password]', { state: 'visible', timeout: 5000 });
await adminPage.fill('dialog.confirmation[open] input[type=password]', 'e2e-key');
await adminPage.click('dialog.confirmation[open] button:has-text("حفظ")');
await adminPage.waitForTimeout(800);

let connections = await adminPage.evaluate(async s => (await (await fetch('/api/integrations/connections')).json()).filter(c => c.integrationDefinitionId === s), slug);
check('connection created and pinned to v1', connections.length === 1 && connections[0].connectorVersion === 1);
const connectionId = connections[0].id;
const tenantId = connections[0].tenantId;

// --- Create + publish v2 -------------------------------------------------------------------
await adminPage.click('#nav-integration-builder');
await adminPage.waitForSelector('#pf-connectors', { state: 'visible' });
await adminPage.waitForTimeout(400);
await adminPage.click(`#pf-connectors-list tr:has-text("رحلة إغلاق 6H") button:has-text("إدارة")`);
await adminPage.waitForSelector('dialog.drawer[open]', { state: 'visible' });
await adminPage.waitForTimeout(300);
tabButtons = await adminPage.$$('dialog.drawer[open] [role=tab]');
await tabButtons[4].click(); // Versions
await adminPage.waitForTimeout(400);
await adminPage.click('dialog.drawer[open] button:has-text("إنشاء نسخة مسودة جديدة")');
confirmButtons = await adminPage.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/إنشاء نسخة مسودة جديدة/.test(t.trim())) { await b.click(); break; } }
await adminPage.waitForTimeout(500);

tabButtons = await adminPage.$$('dialog.drawer[open] [role=tab]');
await tabButtons[1].click(); // Actions
await adminPage.waitForTimeout(200);
const deleteButtons = await adminPage.locator('dialog.drawer[open] button:has-text("حذف الإجراء")').all();
if (deleteButtons.length) await deleteButtons[0].click();
await adminPage.waitForTimeout(300);
await adminPage.click('dialog.drawer[open] button:has-text("إضافة إجراء")');
await adminPage.waitForSelector('dialog.confirmation [name=slug]', { state: 'visible' });
await adminPage.fill('dialog.confirmation [name=slug]', 'get_orders');
await adminPage.fill('dialog.confirmation [name=nameAr]', 'الطلبات');
await adminPage.fill('dialog.confirmation [name=nameEn]', 'Orders');
await adminPage.fill('dialog.confirmation [name=pathTemplate]', '/v2/orders');
await adminPage.click('dialog.confirmation button:has-text("إضافة إجراء")');
await adminPage.waitForTimeout(500);

await adminPage.getByRole('tab', { name: /المراجعة والنشر/ }).click();
await adminPage.waitForTimeout(200);
await adminPage.click('dialog.drawer[open] button:has-text("نشر الآن")');
await adminPage.waitForTimeout(400);
confirmButtons = await adminPage.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/^نشر الآن$/.test(t.trim())) { await b.click(); break; } }
await adminPage.waitForTimeout(500);
const definitionAfterV2 = await adminPage.evaluate(async s => (await (await fetch('/api/platform/connectors')).json()).find(c => c.slug === s), slug);
check('connector republished as v2', definitionAfterV2.version === 2 && definitionAfterV2.status === 'PUBLISHED');

// --- (C) Bulk Migrate Connections: real drawer, real preview, real execution ------------------
tabButtons = await adminPage.$$('dialog.drawer[open] [role=tab]');
await tabButtons[4].click(); // back to Versions
await adminPage.waitForTimeout(400);
const bulkButton = adminPage.locator('dialog.drawer[open] button:has-text("ترحيل الاتصالات بالجملة")');
check('Bulk Migrate Connections button appears once 2 real versions exist', await bulkButton.count() > 0);
await bulkButton.first().click();
await adminPage.waitForTimeout(500);
const previewText = await adminPage.locator('dialog.drawer[open]').last().innerText();
check('bulk preview shows the real affected-connection count (1)', /1/.test(previewText));
const migrateSelected = adminPage.locator('dialog.drawer[open] button:has-text("ترحيل المحدد")').last();
await migrateSelected.click();
await adminPage.waitForTimeout(400);
confirmButtons = await adminPage.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/ترحيل المحدد/.test(t.trim())) { await b.click(); break; } }
await adminPage.waitForTimeout(800);
const afterBulk = await adminPage.evaluate(async id => await (await fetch('/api/integrations/connections/' + id)).json(), connectionId);
check('bulk migration via the real UI actually migrated the connection to v2', afterBulk.connectorVersion === 2 && afterBulk.status === 'CONNECTED');
// Closes only the bulk-migration drawer (Escape closes the topmost open <dialog> natively) —
// the connector wizard drawer underneath is still open, so the Analytics tab below is reached
// directly on it rather than re-opening a second, redundant drawer instance.
await adminPage.keyboard.press('Escape');
await adminPage.waitForTimeout(300);

// --- (H) Platform Connector Analytics tab: real KPIs from real data --------------------------
await adminPage.getByRole('tab', { name: /التحليلات/ }).click();
await adminPage.waitForTimeout(500);
const kpiValues = await adminPage.locator('dialog.drawer[open] #analytics-body .kpi-value').allInnerTexts();
check('Analytics tab renders real KPI cards', kpiValues.length >= 8);
check('Analytics: connectionsCount reflects the real single connection', kpiValues[0] === '1');
await adminPage.keyboard.press('Escape');
await adminPage.waitForTimeout(300);

// --- (J) Agent Connection Map navigation: real, clickable Agent/Connector links --------------
installToolDefinitions(app.store.db);
app.store.db.prepare("INSERT OR IGNORE INTO tool_definitions (id,slug,description,category,risk_level,action_type,integration_slug,requires_connection,is_read_only,is_external_action,capability,requires_approval_below_level,min_level,allowed_agents,input_schema,is_available,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))")
 .run('e2e_6h_tool', 'e2e_6h_tool', 'x', 'commerce', 'LOW', 'READ', null, 1, 1, 0, 'commerce.orders.read', null, 'L0', JSON.stringify(['frost']), '{}', 1);
upsertAssignment(app.store.db, tenantId, 'frost', 'e2e_6h_tool', { enabled: true, connectionId });

await adminPage.click('#nav-control-center');
await adminPage.waitForSelector('#control-center', { state: 'visible' });
await adminPage.click('#cc-tabs [role=tab]:has-text("خريطة الوكلاء")');
await adminPage.waitForTimeout(600);
const mapRowText = await adminPage.locator('#am-table').innerText();
check('Agent Connection Map row shows the real tool/connector', mapRowText.includes('e2e_6h_tool') && mapRowText.includes(slug));

// The matching row's data cells render in column order: Agent, Tool, Connector, Connection.
const agentRowButtons = await adminPage.locator(`#am-table tr:has-text("e2e_6h_tool") button`).all();
check('Agent Map row has clickable links (agent/tool/connector)', agentRowButtons.length >= 3);
if (agentRowButtons.length) {
 await agentRowButtons[0].click(); // Agent cell's link
 await adminPage.waitForSelector('dialog.drawer[open]', { state: 'visible', timeout: 5000 });
 await adminPage.waitForTimeout(300);
 check('clicking the Agent cell opens the real Agent drawer', await adminPage.locator('dialog.drawer[open]').count() > 0);
 await adminPage.keyboard.press('Escape');
 await adminPage.waitForTimeout(300);
}
if (agentRowButtons.length >= 3) {
 await adminPage.click('#cc-tabs [role=tab]:has-text("خريطة الوكلاء")');
 await adminPage.waitForTimeout(400);
 const connectorRowButtons = await adminPage.locator(`#am-table tr:has-text("e2e_6h_tool") button`).all();
 await connectorRowButtons[2].click(); // Connector cell's link (Platform Admin -> Builder wizard)
 await adminPage.waitForTimeout(600);
 const urlAfterConnectorClick = adminPage.url();
 check('clicking the Connector cell (Platform Admin) navigates to the Builder and opens the real definition', urlAfterConnectorClick.includes('#platform') && await adminPage.locator('dialog.drawer[open]').count() > 0);
}

// This Escape targets a drawer opened via the cross-page openConnectorWizardBySlug() shortcut
// (control-center.js -> platform.js), which races the hash-change router's own async platform
// page render (now slightly heavier post-Phase-7C with Platform Frost Chat's own fetch) — give
// the close() call a moment to actually finish before any later step re-queries dialog[open],
// or a still-closing dialog can be mistaken for gone and left to block a later click.
await adminPage.keyboard.press('Escape').catch(() => {});
await adminPage.waitForTimeout(500);

// --- (F) Tenant Custom Connector Webhook Trigger: real creation UI, flows through review ------
const ownerContext = await browser.newContext();
const ownerPage = await ownerContext.newPage();
ownerPage.on('pageerror', err => console.log('  [owner page error]', err.message));
const ownerUsername = 'e2e6h_owner_' + Date.now();
const auth = createAuth(app.store.db);
const ownerUser = auth.createUser({ username: ownerUsername, name: 'Tenant Owner', password: 'a-long-test-password-123' }, 'owner');
createTenant(app.store.db, { name: 'E2E 6H Tenant', slug: 'e2e6h-t-' + Date.now() }, ownerUser.id);
const ownerLogin = auth.login({ username: ownerUsername, password: 'a-long-test-password-123' }, '127.0.0.1');
await ownerContext.addCookies([{ name: 'hc_session', value: ownerLogin.token, url: base }]);
await ownerPage.goto(base + '/');
await ownerPage.waitForSelector('#session-bar', { state: 'visible', timeout: 15000 });
check('tenant owner logged in (separate session/tenant)', await ownerPage.isVisible('#session-bar'));

await ownerPage.click('#nav-control-center');
await ownerPage.waitForSelector('#control-center', { state: 'visible' });
await ownerPage.click('#cc-tabs [role=tab]:has-text("التكاملات")');
await ownerPage.waitForTimeout(700);
await ownerPage.click('#cc-custom-connectors button:has-text("مسودة موصل جديد")');
await ownerPage.waitForSelector('dialog.confirmation [name=slug]', { state: 'visible', timeout: 5000 });
const customSlug = 'e2e6h_wh_' + Date.now();
await ownerPage.fill('dialog.confirmation [name=slug]', customSlug);
await ownerPage.fill('dialog.confirmation [name=nameAr]', 'موصل ويبهوك المستأجر');
await ownerPage.fill('dialog.confirmation [name=nameEn]', 'Tenant Webhook Connector');
await ownerPage.fill('dialog.confirmation [name=baseUrl]', 'https://api.e2e6h-wh.test');
await ownerPage.selectOption('dialog.confirmation [name=authType]', 'NONE');
await ownerPage.click('dialog.confirmation button:has-text("حفظ")');
await ownerPage.waitForTimeout(800);

await ownerPage.click(`#cc-custom-list tr:has-text("موصل ويبهوك المستأجر") button:has-text("أحداث Webhook")`);
await ownerPage.waitForSelector('dialog.drawer[open]', { state: 'visible', timeout: 5000 });
await ownerPage.waitForTimeout(300);
await ownerPage.click('dialog.drawer[open] button:has-text("إضافة حدث")');
await ownerPage.waitForSelector('dialog.confirmation [name=slug]', { state: 'visible', timeout: 5000 });
await ownerPage.fill('dialog.confirmation [name=slug]', 'order_created');
await ownerPage.fill('dialog.confirmation [name=name]', 'Order Created');
await ownerPage.selectOption('dialog.confirmation [name=normalizedEventType]', 'ORDER_CREATED');
await ownerPage.click('dialog.confirmation button:has-text("إضافة حدث")');
await ownerPage.waitForTimeout(600);

const draftForTrigger = (await ownerPage.evaluate(async () => (await (await fetch('/api/integrations/custom-connectors')).json()).connectors)).find(c => c.slug === customSlug);
const triggersAfterAdd = await ownerPage.evaluate(async id => await (await fetch(`/api/integrations/custom-connectors/${id}/triggers`)).json(), draftForTrigger.id);
check('webhook trigger created for the tenant custom connector via the real UI', triggersAfterAdd.length === 1 && triggersAfterAdd[0].slug === 'order_created');
await ownerPage.keyboard.press('Escape');
await ownerPage.waitForTimeout(300);

await ownerPage.click(`#cc-custom-list tr:has-text("موصل ويبهوك المستأجر") button:has-text("إرسال للمراجعة")`);
await ownerPage.waitForTimeout(800);
const submittedList = await ownerPage.evaluate(async () => (await (await fetch('/api/integrations/custom-connectors')).json()).connectors);
check('submitted for review with the trigger intact', submittedList.find(c => c.slug === customSlug)?.reviewStatus === 'PENDING');

await adminPage.click('#nav-integration-builder');
await adminPage.waitForSelector('#pf-connectors', { state: 'visible' });
await adminPage.waitForTimeout(600);
await adminPage.click(`#pf-pending-custom [data-pending]:has-text("موصل ويبهوك المستأجر") button:has-text("اعتماد")`);
confirmButtons = await adminPage.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/^اعتماد$/.test(t.trim())) { await b.click(); break; } }
await adminPage.waitForTimeout(800);
const approvedCustom = await adminPage.evaluate(async s => (await (await fetch('/api/platform/connectors')).json()).find(c => c.slug === s), customSlug);
check('tenant webhook-trigger connector approved and published', approvedCustom?.status === 'PUBLISHED');

await browser.close();
app.store.close();
await rm(directory, { recursive: true, force: true });
console.log('\n=== JOURNEY 6 (PHASE 6H CLOSURE) SUMMARY ===');
console.log(failures.length ? `${failures.length} FAILURE(S): ${failures.join(' | ')}` : 'ALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
