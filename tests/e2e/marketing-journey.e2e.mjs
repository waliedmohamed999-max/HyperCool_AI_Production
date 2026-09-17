// Marketing & Social Operating Module — Playwright E2E Journey (Phase MKT-1, spec item 97).
// Drives a real browser through: Marketing Overview -> create campaign -> Frost plan
// (real agentRuntime.run('strategy'/'intelligence', ...), mocked provider since no live
// credentials exist in this environment, exactly like command-center-journey.e2e.mjs) ->
// Content Studio -> approval-style status advance -> schedule -> Unified Inbox -> a lead
// qualified via the public Website Chat widget -> CRM -> Analytics (Overview again).
// No fake success anywhere the provider/connector genuinely isn't configured.
// Run with: node tests/e2e/marketing-journey.e2e.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/application.js';

const directory = await mkdtemp(join(tmpdir(), 'hypercool-e2e-marketing-'));

// --- Mocked LLM: matches on each agent's OWN prompt-file heading, exactly like
// command-center-journey.e2e.mjs's AGENT_TURN_MARKERS (never on frost_commander's prompt or
// any chat history, so there is no cross-agent contamination). ------------------------------
const textTurn = obj => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 5, output_tokens: 5 } });
const STRATEGY_DECISION = { status: 'OK', action: 'PLAN', rationale: 'خطة مبنية على أهداف الحملة الحقيقية.', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: [], payload: { slots: [{ date: '2026-10-01', platform: 'Instagram', audience: 'عملاء أفراد', funnel_stage: 'AWARENESS', pillar: 'عروض موسمية', product_or_category: null, objective: 'زيادة الوعي بالعرض', hook_angle: 'الشتاء له عطره الخاص', key_message: 'خصم 25% لفترة محدودة', CTA: 'تسوق الآن', landing_url: null, evidence_needed: [], asset_needed: [], priority: 'HIGH', approval_risk: 'LOW', reason_for_selection: 'يخدم هدف الحملة مباشرة' }] } };
const INTELLIGENCE_DECISION = { status: 'OK', action: 'ANALYZE', rationale: 'رصدنا فرصة تموضع واضحة.', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: [], payload: { signals: [{ topic_or_competitor: 'منافس رئيسي', observed_change: 'خفض الأسعار 10%', date: '2026-09-15', source: 'مراقبة يدوية', fact: 'تغيير سعري معلن', inference: 'ضغط تنافسي على نفس الشريحة', confidence: 0.7, why_it_matters: 'قد يقلل هامش الربح إن لم نستجب', content_opportunity: 'إبراز الجودة بدل التنافس السعري', sales_opportunity: 'استهداف العملاء الحساسين للسعر بعرض قيمة مختلف', recommended_action: 'مراجعة استراتيجية التسعير هذا الشهر', urgency: 'MEDIUM' }] } };
// Phase MKT-2, Part Q — a real PASS compliance decision, matched on the compliance agent's
// own prompt heading exactly like Strategy/Intelligence above. This is what unlocks the new
// real compliance gate (Part C) added this phase before IN_REVIEW -> APPROVED is even offered.
const COMPLIANCE_DECISION = { status: 'OK', action: 'REVIEW', rationale: 'تحقق حقيقي من المحتوى.', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: [], payload: { classification: 'PASS', issues: [], corrected_text_if_possible: null, evidence_sources: [], verified_fields: ['body'], blocked_fields: [], human_review_required: false, reason: 'لا توجد ادعاءات غير موثقة' } };
async function fetcher(url, options) {
  const bodyText = typeof options?.body === 'string' ? options.body : '';
  if (bodyText.includes('Content Strategy Agent')) return new Response(JSON.stringify(textTurn(STRATEGY_DECISION)), { status: 200, headers: { 'content-type': 'application/json' } });
  if (bodyText.includes('Competitor & Trend Intelligence Agent')) return new Response(JSON.stringify(textTurn(INTELLIGENCE_DECISION)), { status: 200, headers: { 'content-type': 'application/json' } });
  if (bodyText.includes('Brand & Compliance Agent')) return new Response(JSON.stringify(textTurn(COMPLIANCE_DECISION)), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify(textTurn({ status: 'NEEDS_DATA', action: 'NONE', rationale: 'Not part of this scenario', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: ['not_mocked'], payload: null })), { status: 200, headers: { 'content-type': 'application/json' } });
}

const app = await createApp({ dataDir: directory, env: { ANTHROPIC_API_KEY: 'test-secret', ANTHROPIC_MODEL: 'test-model', PLATFORM_MAIL_TRANSPORT: 'capture' }, fetcher: (...args) => fetcher(...args) });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const failures = [];
function check(label, cond) { if (cond) console.log('OK  -', label); else { console.log('FAIL-', label); failures.push(label); } }
page.on('pageerror', err => { console.log('  [page error]', err.message); failures.push('page error: ' + err.message); });

// --- Setup: real signup + workspace, via the real API from inside the browser session ------
// (a real POST /api/signup sets the real session cookie the browser then uses for every
// subsequent navigation/API call below — no UI form-filling needed for pure setup, exactly
// like tests/marketing.test.js's own signupAndCreateWorkspace helper, just driven from a page
// context instead of node-fetch so the same cookie jar backs the rest of this real browser
// session.)
await page.goto(base + '/');
await page.waitForSelector('#auth-form [name=username]', { state: 'visible' });
const signupResult = await page.evaluate(async () => {
  const res = await fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'مالك تجريبي', username: 'mkt_journey_owner', email: 'mkt_journey_owner@example.com', password: 'a-long-test-password-999' }) });
  return { status: res.status, data: await res.json().catch(() => null) };
});
check('real signup succeeded', signupResult.status === 201);
// Real email verification (same requirement tests/marketing.test.js's signupAndCreateWorkspace
// goes through) — reads the real captured mail straight from the app's own DB, exactly like a
// person clicking the real link in their inbox would land on /#verify-email/<token>.
const mailRow = app.store.db.prepare("SELECT captured_body FROM platform_mail_outbox WHERE to_email=? AND kind='VERIFY_EMAIL' ORDER BY created_at DESC LIMIT 1").get('mkt_journey_owner@example.com');
const verifyToken = mailRow ? (JSON.parse(mailRow.captured_body).html + JSON.parse(mailRow.captured_body).text).match(/verify-email\/([a-f0-9]+)/)?.[1] : null;
check('verification email captured with a real token', !!verifyToken);
const verifyResult = await page.evaluate(async token => {
  const res = await fetch('/api/account/email/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  return { status: res.status };
}, verifyToken);
check('real email verified', verifyResult.status === 200);
const wsResult = await page.evaluate(async csrf => {
  const res = await fetch('/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ companyName: 'Nova Journey Test' }) });
  return { status: res.status, data: await res.json().catch(() => null) };
}, signupResult.data?.csrf);
check('real workspace created', wsResult.status === 201);

// The page's own JS booted once already (before the signup/workspace calls above changed
// server-side state) — it needs a real reload to run its render() cycle again and discover
// the now-resolved session + workspace, exactly like a person refreshing after signing up in
// another tab would.
await page.goto(base + '/#marketing');
await page.reload();
await page.waitForSelector('#session-bar', { state: 'visible', timeout: 15000 });
await page.waitForSelector('#marketing #mkt-health', { state: 'visible', timeout: 15000 });
await page.waitForTimeout(400);
check('Marketing Overview loads with real KPI cards', (await page.locator('#mkt-health .kpi-card').count()) === 6);

// --- Campaign Builder + Frost plan (real, mocked-provider agent runs) ----------------------
const tabButtons = page.locator('#mkt-tabs .ui-tabs .tab');
await tabButtons.nth(1).click();
await page.waitForTimeout(200);
await page.click('#mkt-new-campaign');
await page.waitForSelector('dialog.confirmation [name=name]', { state: 'visible' });
await page.fill('dialog.confirmation [name=name]', 'حملة رحلة الاختبار');
await page.fill('dialog.confirmation [name=goal]', 'زيادة المبيعات 20%');
await page.check('dialog.confirmation [name=channel][value=Instagram]');
await page.click('dialog.confirmation button.button.primary');
await page.waitForTimeout(500);
check('Campaign created', (await page.locator('#mkt-campaigns-list', { hasText: 'حملة رحلة الاختبار' }).count()) === 1);

await page.locator('#mkt-campaigns-list a', { hasText: 'حملة رحلة الاختبار' }).click();
await page.waitForSelector('dialog.drawer[open]', { state: 'visible', timeout: 5000 });
const detailTabs = page.locator('dialog.drawer[open] .ui-tabs .tab');
await detailTabs.nth(2).click(); // Intelligence
await page.waitForTimeout(200);
await page.locator('dialog.drawer[open] button', { hasText: 'توليد رصد السوق' }).click();
await page.waitForTimeout(700);
check('Market Intelligence generated via a real (mocked-provider) intelligence agent run', (await page.locator('dialog.drawer[open]').innerText()).includes('منافس رئيسي'));

await detailTabs.nth(1).click(); // Strategy
await page.waitForTimeout(200);
await page.locator('dialog.drawer[open] button', { hasText: 'توليد الاستراتيجية' }).click();
await page.waitForTimeout(700);
check('Strategy generated via a real (mocked-provider) strategy agent run', (await page.locator('dialog.drawer[open]').innerText()).includes('عروض موسمية'));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// --- Content Studio: create -> review -> approve -> schedule (with a real date) ------------
await tabButtons.nth(2).click();
await page.waitForTimeout(200);
await page.click('#mkt-new-content');
await page.waitForSelector('dialog.confirmation [name=body]', { state: 'visible' });
await page.fill('dialog.confirmation [name=body]', 'تشكيلتنا الموسمية وصلت بخصم 25%');
await page.click('dialog.confirmation button.button.primary');
await page.waitForTimeout(400);
check('Content item created', (await page.locator('#mkt-content-list .card', { hasText: 'تشكيلتنا الموسمية' }).count()) === 1);

const contentCard = page.locator('#mkt-content-list .card', { hasText: 'تشكيلتنا الموسمية' });
await contentCard.getByRole('button', { name: 'أرسل للمراجعة' }).click(); // DRAFT -> IN_REVIEW
await page.waitForTimeout(400);
// Part C: a real compliance gate now sits between IN_REVIEW and APPROVED — Approve is not
// even offered until a real, non-stale, non-BLOCK compliance run exists for this exact text.
await contentCard.getByRole('button', { name: 'فحص الامتثال' }).click();
await page.waitForTimeout(600);
check('Real (mocked-provider) compliance check passed and unlocked Approve', (await contentCard.innerText()).includes('الامتثال: مقبول'));
await contentCard.getByRole('button', { name: 'اعتماد', exact: true }).click(); // IN_REVIEW -> APPROVED
await page.waitForTimeout(400);
await contentCard.getByRole('button', { name: 'جدولة', exact: true }).click(); // APPROVED -> SCHEDULED (prompts for a date)
await page.waitForSelector('dialog.confirmation [name=scheduledAt]', { state: 'visible' });
await page.fill('dialog.confirmation [name=scheduledAt]', '2026-10-05T10:00');
await page.click('dialog.confirmation button.button.primary');
await page.waitForTimeout(400);
check('Content item reached SCHEDULED with a real date', (await contentCard.innerText()).includes('مجدول'));

await tabButtons.nth(3).click(); // Calendar
await page.waitForTimeout(300);
check('Scheduled content appears on the Social Calendar (List view)', (await page.locator('#mkt-calendar-list').innerText()).includes('مجدول'));
// Part L: Month/Week/List views — reusing the exact grid the legacy Planning calendar already
// proved; this only checks the real toggle renders a real grid, not an error.
const calendarModeButtons = page.locator('#mkt-calendar-list .calendar-controls button');
await calendarModeButtons.nth(0).click(); // Month
await page.waitForTimeout(300);
check('Calendar Month view renders a real day grid', (await page.locator('#mkt-calendar-list .calendar-grid').count()) === 1);
await calendarModeButtons.nth(1).click(); // Week
await page.waitForTimeout(300);
check('Calendar Week view renders 7 real day cells', (await page.locator('#mkt-calendar-list .calendar-day').count()) === 7);
await calendarModeButtons.nth(2).click(); // back to List

// --- Unified Inbox: qualify a lead captured through the real public Website Chat widget ----
await tabButtons.nth(5).click(); // Widget
await page.waitForTimeout(300);
await page.check('#mkt-widget-form [name=active]');
await page.fill('#mkt-widget-form [name=domains]', 'journey-test.example.com');
await page.click('#mkt-widget-form button[type=submit]');
await page.waitForTimeout(300);
const publicWidgetId = await page.locator('.mkt-embed-snippet').inputValue().then(s => s.match(/data-widget-id="([a-f0-9]+)"/)?.[1]);
check('Widget activated with a real public id', !!publicWidgetId);

// A real browser's fetch() refuses to let script code set the Origin header at all (it is a
// forbidden header name — the browser always sends the page's OWN real origin instead), so a
// genuinely cross-origin call cannot be simulated via page.evaluate(fetch...) here. Playwright's
// own request context is a real HTTP client (not bound by that browser restriction) — the
// same real, honest HTTP request a genuinely different website's server-rendered fetch (or
// any non-browser HTTP client) would send.
const widgetChatResponse = await page.request.post(base + '/api/public/widget/' + publicWidgetId + '/chat', {
  headers: { 'Content-Type': 'application/json', Origin: 'https://journey-test.example.com' },
  data: { text: 'هل يوجد توصيل لجدة؟', name: 'عميل الرحلة التجريبية' }
});
const widgetChat = { status: widgetChatResponse.status(), data: await widgetChatResponse.json().catch(() => null) };
check('Public widget chat created a real lead (cross-origin, no session)', widgetChat.status === 200 && !!widgetChat.data?.leadId);

await tabButtons.nth(4).click(); // Inbox
await page.waitForTimeout(400);
check('The widget-originated conversation appears in the Unified Inbox', (await page.locator('#mkt-inbox-list').innerText()).includes('عميل الرحلة التجريبية'));
await page.locator('#mkt-inbox-list [data-lead]', { hasText: 'عميل الرحلة التجريبية' }).click();
await page.waitForTimeout(300);
check('The real inbound message text is shown in the thread', (await page.locator('#mkt-inbox-thread').innerText()).includes('هل يوجد توصيل لجدة'));

// --- CRM: the SAME lead, reachable via the existing CRM page (no second lead model) --------
await page.click('#mkt-open-crm');
await page.waitForTimeout(300);
check('Deep link opens the real CRM page', page.url().includes('#crm'));

// The CRM deep link navigated away from Marketing — back to it before reusing tabButtons
// (the old marketing page instance is hidden, not destroyed, but its tabs aren't clickable
// while hidden; a real navigation back is what a person would actually do here too).
await page.evaluate(() => { document.querySelector('nav a[href="#marketing"]').click(); });
await page.waitForSelector('[data-page=marketing]', { state: 'visible', timeout: 10000 });
await page.waitForTimeout(300);

// --- Assets (Part K): a real external-URL asset, no fake file storage --------------------
await tabButtons.nth(6).click();
await page.waitForTimeout(300);
await page.click('#mkt-new-asset-external');
await page.waitForSelector('dialog.confirmation [name=ref]', { state: 'visible' });
await page.fill('dialog.confirmation [name=ref]', 'https://cdn.example.com/journey-asset.png');
await page.click('dialog.confirmation button.button.primary');
await page.waitForTimeout(400);
check('Real external asset appears in the Assets tab', (await page.locator('#mkt-assets-list').innerText()).includes('cdn.example.com'));

// --- Performance (Part G/H): honestly refuses a review with no real analytics yet ---------
await tabButtons.nth(7).click();
await page.waitForTimeout(300);
await page.click('#mkt-run-performance-review');
await page.waitForTimeout(500);
check('Performance review is honestly refused with no real analytics data (no fabricated review)', (await page.locator('#mkt-performance').innerText()).includes('لا توجد مراجعات أداء بعد'));

// --- Automated Orchestration (Part B): visible and runnable from the campaign detail drawer -
await tabButtons.nth(1).click();
await page.waitForTimeout(200);
await page.locator('#mkt-campaigns-list a', { hasText: 'حملة رحلة الاختبار' }).click();
await page.waitForSelector('dialog.drawer[open]', { state: 'visible', timeout: 5000 });
const detailTabsAgain = page.locator('dialog.drawer[open] .ui-tabs .tab');
await detailTabsAgain.nth(4).click(); // Automated Orchestration
await page.waitForTimeout(300);
await page.locator('dialog.drawer[open] button', { hasText: 'إنشاء تنسيق تلقائي' }).click();
await page.waitForTimeout(500);
check('Automated orchestration workflow created from the real campaign detail drawer', (await page.locator('dialog.drawer[open]').innerText()).includes('حالة المسار'));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// --- Analytics: back to Overview, real counts now reflect this journey's own real actions --
const finalOverviewResponse = await page.request.get(base + '/api/marketing/overview', { headers: { cookie: (await page.context().cookies()).map(c => `${c.name}=${c.value}`).join('; ') } });
const finalOverview = await finalOverviewResponse.json();
check('Overview reflects the real campaign created in this journey', finalOverview.marketing.campaigns.total === 1);
check('Overview reflects real inbox activity from the widget conversation', finalOverview.marketing.inboxVolume >= 1);
check('Overview honestly reports reach/engagement as unavailable (no connector provides them)', finalOverview.marketing.reach === null && finalOverview.marketing.engagement === null);

const analyticsSummaryResponse = await page.request.get(base + '/api/marketing/analytics/summary', { headers: { cookie: (await page.context().cookies()).map(c => `${c.name}=${c.value}`).join('; ') } });
const analyticsSummary = await analyticsSummaryResponse.json();
check('Analytics summary (Part F) honestly reports no real data connected — no Meta/X/LinkedIn OAuth exists in this journey', analyticsSummary.hasAnyData === false && analyticsSummary.providers.every(p => !p.connected));

await browser.close();
app.store.close();
await rm(directory, { recursive: true, force: true });

console.log('\n=== MARKETING JOURNEY SUMMARY ===');
console.log(failures.length ? `${failures.length} FAILURE(S): ${failures.join(' | ')}` : 'ALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
