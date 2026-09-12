// Universal Integration Platform — Playwright E2E Journey 5 (Phase 6G, Part 53).
// ENABLE_TENANT_CUSTOM_CONNECTORS=true. Tenant Owner creates a custom connector draft and
// submits it for review; Platform Admin reviews and approves it; the Tenant Owner then connects
// to their own newly-approved connector and it appears (safe read) — and a SEPARATE tenant's
// own catalog never sees it. Two real, independent browser contexts/sessions (never the same
// session merged into both roles, unlike Journeys 1-4) against a real, ephemeral instance of
// the actual application. Run with:
//   node tests/e2e/tenant-custom-governance-journey.e2e.mjs
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/application.js';
import { createAuth } from '../../src/auth.js';
import { createTenant } from '../../src/tenancy.js';

const key32 = randomBytes(32).toString('hex');
const directory = await mkdtemp(join(tmpdir(), 'hypercool-e2e-tenantcustom-'));
const app = await createApp({ dataDir: directory, env: { INTEGRATION_ENCRYPTION_KEY: key32, PLATFORM_ADMIN_USERNAMES: 'platform_admin', ENABLE_TENANT_CUSTOM_CONNECTORS: 'true' } });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

const browser = await chromium.launch();
const failures = [];
function check(label, cond) { if (cond) console.log('OK  -', label); else { console.log('FAIL-', label); failures.push(label); } }

const adminContext = await browser.newContext();
const adminPage = await adminContext.newPage();
adminPage.on('pageerror', err => console.log('  [admin page error]', err.message));
const ownerContext = await browser.newContext();
const ownerPage = await ownerContext.newPage();
ownerPage.on('pageerror', err => console.log('  [owner page error]', err.message));

// --- Platform Admin signs up (first real user, matches the allowlist) ------------------------
await adminPage.goto(base + '/');
await adminPage.waitForSelector('#auth-form [name=username]', { state: 'visible' });
await adminPage.fill('#auth-form [name=name]', 'Platform Admin');
await adminPage.fill('#auth-form [name=username]', 'platform_admin');
await adminPage.fill('#auth-form [name=password]', 'a-long-test-password-123');
await adminPage.click('#auth-form button');
await adminPage.waitForSelector('#session-bar', { state: 'visible', timeout: 15000 });
check('platform admin logged in', await adminPage.isVisible('#session-bar'));

// --- A separate real Tenant Owner (own tenant, NOT platform admin) — the UI's own auth form
// only ever offers setup-the-first-user-or-log-in (no public self-signup screen is exercised by
// this journey; that is a separate, already-covered surface), so this second real user+tenant
// is created directly through the same backend functions the app's own signup route itself
// calls, then its real session token is handed to a genuinely separate browser context via a
// real cookie — never the same session/page as the Platform Admin. ------------------------------
const ownerUsername = 'tc_owner_' + Date.now();
const auth = createAuth(app.store.db);
const ownerUser = auth.createUser({ username: ownerUsername, name: 'Tenant Owner', password: 'a-long-test-password-123' }, 'owner');
createTenant(app.store.db, { name: 'Tenant Custom Co', slug: 'tc-e2e-' + Date.now() }, ownerUser.id);
const ownerLogin = auth.login({ username: ownerUsername, password: 'a-long-test-password-123' }, '127.0.0.1');
await ownerContext.addCookies([{ name: 'hc_session', value: ownerLogin.token, url: base }]);
await ownerPage.goto(base + '/');
await ownerPage.waitForSelector('#session-bar', { state: 'visible', timeout: 15000 });
check('tenant owner logged in (separate session, separate tenant)', await ownerPage.isVisible('#session-bar'));

// --- Tenant Owner: create a custom connector draft --------------------------------------------
await ownerPage.click('#nav-control-center');
await ownerPage.waitForSelector('#control-center', { state: 'visible' });
await ownerPage.click('#cc-tabs [role=tab]:has-text("التكاملات")');
await ownerPage.waitForTimeout(700);
check('"My custom connectors" section visible (flag is on)', (await ownerPage.locator('#cc-panel-integrations').innerText()).includes('موصلاتي المخصصة'));

await ownerPage.click('#cc-custom-connectors button:has-text("مسودة موصل جديد")');
await ownerPage.waitForSelector('dialog.confirmation [name=slug]', { state: 'visible', timeout: 5000 });
const slug = 'tc_e2e_' + Date.now();
await ownerPage.fill('dialog.confirmation [name=slug]', slug);
await ownerPage.fill('dialog.confirmation [name=nameAr]', 'موصل المستأجر');
await ownerPage.fill('dialog.confirmation [name=nameEn]', 'Tenant Connector');
await ownerPage.fill('dialog.confirmation [name=baseUrl]', 'https://api.tc-e2e.test');
await ownerPage.selectOption('dialog.confirmation [name=authType]', 'NONE');
await ownerPage.click('dialog.confirmation button:has-text("حفظ")');
await ownerPage.waitForTimeout(800);

let ownConnectors = await ownerPage.evaluate(async () => (await (await fetch('/api/integrations/custom-connectors')).json()).connectors);
check('draft created, owned by this tenant, status DRAFT', ownConnectors.some(c => c.slug === slug && c.status === 'DRAFT'));
check('draft NOT in this tenant\'s own catalog yet (never published)', !(await ownerPage.evaluate(async () => await (await fetch('/api/integrations/catalog')).json())).some(c => c.slug === slug));

// --- Tenant Owner: submit for review -----------------------------------------------------------
await ownerPage.click(`#cc-custom-list tr:has-text("موصل المستأجر") button:has-text("إرسال للمراجعة")`);
await ownerPage.waitForTimeout(800);
ownConnectors = await ownerPage.evaluate(async () => (await (await fetch('/api/integrations/custom-connectors')).json()).connectors);
check('submitted — reviewStatus PENDING', ownConnectors.find(c => c.slug === slug)?.reviewStatus === 'PENDING');

// --- Platform Admin: review queue shows it, approve -----------------------------------------
await adminPage.click('#nav-integration-builder');
await adminPage.waitForSelector('#pf-connectors', { state: 'visible' });
await adminPage.waitForTimeout(600);
const pendingText = await adminPage.locator('#pf-pending-custom').innerText().catch(() => '');
check('Pending Custom Connectors section shows the tenant\'s draft', pendingText.includes('موصل المستأجر'));

await adminPage.click(`#pf-pending-custom [data-pending]:has-text("موصل المستأجر") button:has-text("اعتماد")`);
await adminPage.waitForSelector('dialog.confirmation [open]', { state: 'attached' }).catch(() => {});
const confirmButtons = await adminPage.$$('dialog.confirmation button');
for (const b of confirmButtons) { const t = (await b.textContent()) || ''; if (/^اعتماد$/.test(t.trim())) { await b.click(); break; } }
await adminPage.waitForTimeout(800);

const approvedDefinition = await adminPage.evaluate(async s => (await (await fetch('/api/platform/connectors')).json()).find(c => c.slug === s), slug);
check('approved — status PUBLISHED, reviewStatus APPROVED', approvedDefinition?.status === 'PUBLISHED' && approvedDefinition?.reviewStatus === 'APPROVED');

// --- Tenant Owner: now sees it in their OWN catalog, connects, safe read ----------------------
await ownerPage.reload();
await ownerPage.waitForSelector('#session-bar', { state: 'visible', timeout: 15000 });
const ownCatalogAfter = await ownerPage.evaluate(async () => await (await fetch('/api/integrations/catalog')).json());
check('now visible in the SUBMITTING tenant\'s own catalog', ownCatalogAfter.some(c => c.slug === slug));

await ownerPage.click('#nav-control-center');
await ownerPage.waitForSelector('#control-center', { state: 'visible' });
await ownerPage.click('#cc-tabs [role=tab]:has-text("التكاملات")');
await ownerPage.waitForTimeout(700);
const ownCard = ownerPage.locator(`#cc-panel-integrations .card:has-text("موصل المستأجر")`);
let clickedConnect = false;
for (const b of await ownCard.locator('button').all()) { const t = (await b.textContent()) || ''; if (/إضافة اتصال/.test(t)) { await b.click(); clickedConnect = true; break; } }
check('Add Connection available for the approved tenant custom connector', clickedConnect);
if (clickedConnect) {
 await ownerPage.waitForSelector('dialog.confirmation[open]', { state: 'visible', timeout: 5000 });
 await ownerPage.click('dialog.confirmation[open] button:has-text("حفظ")');
 await ownerPage.waitForTimeout(800);
}
const ownConnections = await ownerPage.evaluate(async s => (await (await fetch('/api/integrations/connections')).json()).filter(c => c.integrationDefinitionId === s), slug);
check('tenant successfully connected to their own approved custom connector (safe read: real connection row, CONNECTED)', ownConnections.length === 1 && ownConnections[0].status === 'CONNECTED');

// --- A SEPARATE tenant (the Platform Admin's own tenant, distinct from the submitter's) never
// sees this tenant-owned connector in ITS OWN catalog — real cross-tenant isolation. -----------
const adminOwnCatalog = await adminPage.evaluate(async () => await (await fetch('/api/integrations/catalog')).json());
check('a DIFFERENT tenant\'s own catalog never shows this tenant-custom connector', !adminOwnCatalog.some(c => c.slug === slug));

await browser.close();
app.store.close();
await rm(directory, { recursive: true, force: true });
console.log('\n=== JOURNEY 5 (TENANT CUSTOM CONNECTOR GOVERNANCE) SUMMARY ===');
console.log(failures.length ? `${failures.length} FAILURE(S): ${failures.join(' | ')}` : 'ALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
