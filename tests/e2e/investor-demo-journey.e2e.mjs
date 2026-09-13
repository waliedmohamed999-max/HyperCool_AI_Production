// Investor Demo Data Pack — Playwright E2E Journey (Part 47/48). Seeds the real demo dataset
// via the real `scripts/demo-seed.mjs` CLI (a genuine child process, exactly like an operator
// would run `npm run demo:seed`), then drives a real browser through the full investor
// presentation path: login as investor_demo -> Nova Store dashboard/reports/agents/
// integrations/CRM/content/calendar/audit/team -> switch workspace -> Vertex Solutions
// dashboard/CRM/integrations/agents. Verifies every page renders real content (never empty/
// broken) and that the DEMO DATA banner is visible throughout. Run with:
//   node tests/e2e/investor-demo-journey.e2e.mjs
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApp } from '../../src/application.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const DEMO_PASSWORD = 'investor-e2e-demo-password-2024';
const directory = await mkdtemp(join(tmpdir(), 'hypercool-e2e-investor-demo-'));

execFileSync(process.execPath, [join(repoRoot, 'scripts', 'demo-seed.mjs')], {
 cwd: repoRoot, env: { ...process.env, DATA_DIR: directory, DEMO_USER_PASSWORD: DEMO_PASSWORD }, stdio: 'ignore'
});

const app = await createApp({ dataDir: directory, env: process.env });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const failures = [];
function check(label, cond) { if (cond) console.log('OK  -', label); else { console.log('FAIL-', label); failures.push(label); } }
page.on('pageerror', err => { console.log('  [page error]', err.message); failures.push('page error: ' + err.message); });

async function pageHasRealContent(dataPage, minLength = 80) {
 const text = (await page.locator(`[data-page="${dataPage}"]`).innerText().catch(() => '')).trim();
 return text.length >= minLength && !/lorem ipsum/i.test(text);
}

// --- Login as the real investor demo account --------------------------------------------------
await page.goto(base + '/');
await page.waitForSelector('#auth-form [name=username]', { state: 'visible' });
await page.fill('#auth-form [name=username]', 'investor_demo');
await page.fill('#auth-form [name=password]', DEMO_PASSWORD);
await page.click('#auth-form button');

// investor_demo has 2 real memberships and no active workspace yet -> the workspace gate.
await page.waitForSelector('#workspace-select-panel', { state: 'visible', timeout: 15000 });
const novaCard = page.locator('.workspace-select-item', { hasText: 'نوفا' });
check('workspace selection gate shows Nova Store', await novaCard.count() > 0);
await novaCard.locator('button').click();
await page.waitForSelector('#session-bar', { state: 'visible', timeout: 15000 });
check('logged in as investor_demo, Nova Store activated', await page.isVisible('#session-bar'));

// --- DEMO DATA banner (Part U) ------------------------------------------------------------------
await page.click('a[href="#control-center"]');
await page.waitForSelector('#control-center', { state: 'visible' });
await page.waitForTimeout(500);
check('DEMO DATA banner visible on Nova Store', (await page.locator('#cc-demo-banner').innerText().catch(() => '')).length > 0);

// --- Nova Store: dashboard / reports / agents / integrations / CRM / content / calendar / audit / team
await page.click('a[href="#overview"]');
await page.waitForTimeout(500);
check('Nova overview dashboard has real content', await pageHasRealContent('overview'));

await page.click('a[href="#reports"]');
await page.waitForTimeout(700);
check('Nova reports page has real content', await pageHasRealContent('reports'));

await page.click('a[href="#agents"]');
await page.waitForTimeout(500);
check('Nova agents page has real content', await pageHasRealContent('agents'));

await page.click('a[href="#control-center"]');
await page.waitForTimeout(500);
check('Nova Control Center (Integrations/Health/Readiness) has real content', await pageHasRealContent('control-center'));

await page.click('a[href="#crm"]');
await page.waitForTimeout(700);
check('Nova CRM has real content', await pageHasRealContent('crm'));

await page.click('a[href="#content"]');
await page.waitForTimeout(700);
check('Nova content/approvals page has real content', await pageHasRealContent('content'));

await page.click('a[href="#planning"]');
await page.waitForTimeout(500);
check('Nova calendar/planning page has real content', await pageHasRealContent('planning'));

await page.click('a[href="#audit"]');
await page.waitForTimeout(500);
check('Nova audit trail has real content', await pageHasRealContent('audit'));

const usersLink = page.locator('a[href="#users"]');
if (await usersLink.isVisible().catch(() => false)) {
 await usersLink.click();
 await page.waitForTimeout(500);
 check('Nova team page has real content', await pageHasRealContent('users'));
}

// --- Switch workspace: Nova -> Vertex (Part 32/R) -----------------------------------------------
await page.click('#workspace-switcher summary');
await page.waitForTimeout(200);
const vertexSwitchButton = page.locator('#workspace-switcher .dropdown-items button', { hasText: 'فيرتكس' });
check('workspace switcher lists Vertex Solutions', await vertexSwitchButton.count() > 0);
await vertexSwitchButton.click();
await page.waitForTimeout(1200);
check('workspace switcher shows Vertex as active after switching', (await page.locator('#workspace-switcher summary').innerText()).includes('فيرتكس'));

await page.click('a[href="#overview"]');
await page.waitForTimeout(500);
check('Vertex overview dashboard has real content (different from Nova)', await pageHasRealContent('overview'));
const overviewText = await page.locator('[data-page="overview"]').innerText();
check('Vertex dashboard never shows Nova Store data (tenant isolation, Part S)', !overviewText.includes('متجر نوفا') && !/تيشيرت|شماغ|بشت/.test(overviewText));

await page.click('a[href="#crm"]');
await page.waitForTimeout(700);
check('Vertex CRM (B2B pipeline) has real content', await pageHasRealContent('crm'));

await page.click('a[href="#control-center"]');
await page.waitForTimeout(500);
check('Vertex Control Center (Integrations) has real content', await pageHasRealContent('control-center'));
check('Vertex DEMO DATA banner visible', (await page.locator('#cc-demo-banner').innerText().catch(() => '')).length > 0);

await page.click('a[href="#agents"]');
await page.waitForTimeout(500);
check('Vertex agents page has real content', await pageHasRealContent('agents'));

await browser.close();
app.store.close();
await rm(directory, { recursive: true, force: true });
console.log('\n=== INVESTOR DEMO JOURNEY SUMMARY ===');
console.log(failures.length ? `${failures.length} FAILURE(S): ${failures.join(' | ')}` : 'ALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
