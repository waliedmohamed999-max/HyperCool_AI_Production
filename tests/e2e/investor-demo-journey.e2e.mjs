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
// A blocked/failed image load (e.g. a Content-Security-Policy violation on the design preview's
// data: URI) shows up only as a browser console error, never a `pageerror` — surface it as a
// real, named check failure instead of letting it pass silently.
page.on('console', msg => { if (msg.type() === 'error' && /content security policy|blocked/i.test(msg.text())) failures.push('console error: ' + msg.text().slice(0, 200)); });

async function pageHasRealContent(dataPage, minLength = 80) {
 const text = (await page.locator(`[data-page="${dataPage}"]`).innerText().catch(() => '')).trim();
 return text.length >= minLength && !/lorem ipsum/i.test(text);
}
// After a form submit inside a drawer, the app's own render() cycle rebuilds #items from
// scratch — but nothing ever calls .close() on whichever <dialog class="drawer"> was showing
// the now-stale, already-submitted card, so it (and any dialog stacked on top of it, since
// drawer() opens a genuinely new <dialog> each time openContentItem() is called on a fresh
// post-render node) is left open indefinitely, blocking every click on the page underneath.
// Closes every currently-open dialog via its real header close button — exactly what a real
// user would do — looping until none remain.
async function closeAnyOpenDialogs() {
 for (let i = 0; i < 5; i++) {
  const open = page.locator('dialog[open]');
  const count = await open.count();
  if (count === 0) return;
  await open.last().locator('.dialog-head button').first().click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(200);
 }
}
// Submitting a form whose data-action is "approve"/"reject" (or an autonomy change) first opens
// a real, separate "Are you sure?" confirmation prompt (confirmAction, public/components/ui/
// index.js — a `dialog.confirmation`, distinct from the drawer itself) BEFORE the actual API
// call ever fires — clicking "تأكيد" (Confirm) accepts it and lets the real request proceed.
async function confirmActionPrompt() {
 const dlg = page.locator('dialog.confirmation[open]');
 await dlg.waitFor({ state: 'visible', timeout: 5000 });
 await dlg.getByRole('button', { name: 'تأكيد', exact: true }).click();
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

// --- Reports: real Excel/PDF downloads, the week picker, and the trend charts (Part 48+) -----
check('trend section renders real multi-week charts (demo seed saves 4 real weekly reports)', await page.locator('.report-trend-grid .trend-chart').count() >= 4);
const weekOptions = await page.locator('#report-week-select option').count();
check('week picker lists multiple real known weeks', weekOptions >= 2);

const [xlsxDownload] = await Promise.all([
 page.waitForEvent('download'),
 page.click('#report-export-xlsx')
]);
check('Excel export triggers a real download with the right filename', /hypercool-report-.*\.xlsx$/.test(xlsxDownload.suggestedFilename()));

const [pdfDownload] = await Promise.all([
 page.waitForEvent('download'),
 page.click('#report-export-pdf')
]);
check('PDF export triggers a real download with the right filename', /hypercool-report-.*\.pdf$/.test(pdfDownload.suggestedFilename()));

// Switch to an older known week via the picker and confirm the page actually re-rendered that
// different period (not just a no-op click).
const weekLabelBefore = await page.locator('#report-week-label').innerText();
const otherWeekValue = await page.locator('#report-week-select option').nth(1).getAttribute('value');
await page.selectOption('#report-week-select', otherWeekValue);
await page.waitForTimeout(500);
const weekLabelAfter = await page.locator('#report-week-label').innerText();
check('selecting a different week in the picker actually re-renders a different period', weekLabelBefore !== weekLabelAfter);

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

// --- Content: real design previews + a real, interactive Review -> Approve walkthrough -------
// The Content page's own "Content" tab hides its review/approve forms by default (CSS
// `#items>.card>details,#items>.card>form{display:none}`) — the real, intended interaction is
// through the dedicated "Approvals" tab (#content-approval-view), which lists only
// DRAFT/REVIEWED items with an "Open" button that moves the real card into a drawer
// (openContentItem, public/pages/workspace.js) — outside #items, where the form becomes visible.
const assetPreview = page.locator('#items .content-asset-preview').first();
check('at least one content card shows a real design preview image', await assetPreview.count() > 0);
if (await assetPreview.count() > 0) {
 const src = await assetPreview.getAttribute('src');
 check('the design preview is a real, self-contained image (data: URI, zero external network calls)', !!src && src.startsWith('data:image/svg+xml'));
}

await page.locator('[data-page="content"]').getByRole('tab', { name: 'الموافقات', exact: true }).click();
await page.waitForTimeout(400);
// The Approvals tab lists BOTH DRAFT and REVIEWED items (public/pages/workspace.js:
// `content.filter(c => ['DRAFT','REVIEWED'].includes(c.status))`), and which status lands in
// row .first() shifts with the demo data pack's own deterministic PRNG sequence (any new rng()
// consumption anywhere in demo-seed.mjs re-shuffles every later draw — expected, documented
// behavior, not a bug). Picking a row at random would make this walkthrough's review-then-approve
// path flaky — exercise it deliberately, against a real item confirmed DRAFT via the backend.
const draftId = await page.evaluate(async () => {
 const state = await (await fetch('/api/state')).json();
 return state.content.find(c => c.status === 'DRAFT')?.id ?? null;
});
const approvalRow = draftId
 ? page.locator(`#content-approval-view tbody tr:has(button[data-content-open="${draftId}"])`)
 : page.locator('#content-approval-view tbody tr').first();
if (await approvalRow.count() > 0) {
 // Several demo content items can share the same generated title (random theme x platform
 // combination) — every subsequent lookup for "the same item" MUST key off its real, unique id
 // (data-content-open), never its title text, or a duplicate-titled row could be opened by
 // mistake, silently reviewing/approving the WRONG item while this one is never touched.
 const itemId = draftId ?? await approvalRow.locator('button[data-content-open]').getAttribute('data-content-open');
 const itemRow = () => page.locator(`#content-approval-view tbody tr:has(button[data-content-open="${itemId}"])`);
 await approvalRow.locator('button[data-content-open]').click();
 await page.waitForSelector('dialog.drawer[open]', { state: 'visible', timeout: 5000 });
 const drawerBody = page.locator('dialog.drawer[open]');
 check('the opened drawer shows the real design preview', await drawerBody.locator('.content-asset-preview').count() > 0);

 const reviewForm = drawerBody.locator('form[data-action=review]');
 if (await reviewForm.count() > 0) {
  // The review form lives inside a native <details> (collapsed by default, distinct from the
  // separate "compliance-check" details rendered before it) — expand the RIGHT one first.
  await drawerBody.locator('details:not(.compliance-check) summary').first().click();
  check('the review form (real, in-drawer) exposes the asset-review checkbox', await reviewForm.locator('input[name=asset]').count() > 0);
  await reviewForm.locator('textarea[name=evidence]').fill('تم التحقق من التصميم والنص لأغراض العرض على المستثمر (بيانات تجريبية).');
  for (const name of ['facts', 'claims', 'link', 'asset']) await reviewForm.locator(`input[name=${name}]`).check();
  await reviewForm.locator('button').click();
  await page.waitForTimeout(1000);
  await closeAnyOpenDialogs();

  // Re-open the Approvals tab (a full render cycle ran after submit) and approve this EXACT item.
  await page.locator('[data-page="content"]').getByRole('tab', { name: 'الموافقات', exact: true }).click();
  await page.waitForTimeout(400);
  check('the item now needs approval (moved from Draft to Reviewed) after a real review submission', await itemRow().count() > 0);
  if (await itemRow().count() > 0) {
   await itemRow().locator('button[data-content-open]').click();
   await page.waitForSelector('dialog.drawer[open]', { state: 'visible', timeout: 5000 });
   const approveForm = page.locator(`dialog.drawer[open] form[data-action=approve][data-id="${itemId}"]`);
   check('the drawer now shows a real Approve form for this EXACT item', await approveForm.count() > 0);
   if (await approveForm.count() > 0) {
    await approveForm.locator('button').click();
    await confirmActionPrompt(); // approve/reject always ask for confirmation first
    await page.waitForTimeout(1000);
    await closeAnyOpenDialogs();
    // Confirm directly against the real backend state (authoritative — never inferred from a
    // UI list that could itself be stale/mid-transition).
    const finalStatus = await page.evaluate(async id => (await (await fetch('/api/state')).json()).content.find(c => c.id === id)?.status, itemId);
    check('the content item was actually reviewed AND approved live through the real UI (real backend status is APPROVED)', finalStatus === 'APPROVED');
   }
  }
 }
}
// Defensive: whichever branch above ran (or didn't — e.g. no DRAFT item existed to find), never
// leave a stale open drawer behind to block the next navigation click.
await closeAnyOpenDialogs();
await page.locator('[data-page="content"]').getByRole('tab', { name: 'المحتوى', exact: true }).click();
await page.waitForTimeout(300);

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
