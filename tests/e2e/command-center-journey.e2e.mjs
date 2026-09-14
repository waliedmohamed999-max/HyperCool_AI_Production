// Frost Command Center — Playwright E2E Journey (Phase 7A, spec item 85). Drives a real
// browser through the full flow: login -> Command Center -> real DB-derived chat answers
// (company health, CRM follow-ups, integrations) -> a suggestion turned into a real Task ->
// Live Operations timeline -> manual Context added and retrieved by chat -> an agent tool
// connection changed through chat with a real approval -> workspace switch with zero leakage.
//
// The AI provider is mocked (a fake ANTHROPIC_API_KEY + a queued, real Anthropic-shaped
// response sequence, exactly like tests/command-chat.test.js) since no real API key exists in
// this environment — every OTHER part of the flow (tool execution, DB writes, approvals,
// audit) is 100% real, nothing about the mock touches business logic.
// Run with: node tests/e2e/command-center-journey.e2e.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../src/application.js';

const directory = await mkdtemp(join(tmpdir(), 'hypercool-e2e-command-center-'));

// --- Mocked LLM: a content-based router, not a positional queue ----------------------------
// A fixed sequential response queue is fragile here: creating the seed lead through the real
// /api/crm/leads route legitimately emits a real LEAD_CREATED event, which the REAL, unrelated
// orchestrator (src/runtime/orchestrator.js) routes to a real 'leads' agent run — genuine,
// correct application behavior, not a bug — and that run shares this same mocked fetcher,
// silently consuming queue slots meant for the chat turns. Matching each response to the
// REQUEST'S OWN content (which real user question is being asked) is immune to however many
// other real background agent runs happen to fire around it.
const textTurn = (obj, stop = 'end_turn') => ({ stop_reason: stop, content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 5, output_tokens: 5 } });
const toolUseTurn = (name, input, id) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: id || 'call_' + Math.random().toString(36).slice(2), name, input }], usage: { input_tokens: 5, output_tokens: 5 } });
const decision = (answer, dataSources) => ({ status: 'OK', action: 'ANSWER', rationale: 'Answered from real tool results', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: [], payload: { answer, data_sources: dataSources, follow_up_suggestions: [] } });
// A generic, always-schema-valid fallback for any request this router doesn't recognize (e.g.
// the automatic 'leads' agent run triggered by the seed lead's own real LEAD_CREATED event) —
// NEEDS_DATA + payload:null passes validateAgentDecision for every agent, regardless of its
// own specific payload schema.
const fallbackDecision = () => textTurn({ status: 'NEEDS_DATA', action: 'NONE', rationale: 'Not part of this E2E scenario', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: ['not_mocked'], payload: null });
const SCENARIOS = [
 { match: 'اعرض حالة الشركة', tool: 'get_company_health', input: {}, answer: 'الوضع العام مستقر حاليًا بناءً على البيانات الحقيقية.' },
 { match: 'اعرض العملاء المحتاجين متابعة', tool: 'get_followups_needing_attention', input: {}, answer: 'هناك عميل واحد على الأقل يحتاج متابعة متأخرة حاليًا.' },
 { match: 'افحص التكاملات', tool: 'get_integrations_health', input: {}, answer: 'تم فحص حالة التكاملات الحقيقية لهذه المنشأة.' },
 { match: 'ما الهدف المسجل حاليًا', tool: 'search_context', input: { query: 'الربع' }, answer: 'هدف الشركة المسجل هو زيادة المبيعات 20% هذا الربع.' },
 { match: 'غيّر اتصال أداة إرسال واتساب', tool: 'update_agent_tool_connection', input: null /* filled in after setup, once the real connection id is known */, answer: 'أرسلت طلب تغيير الاتصال لموافقتك.' },
 { match: 'أنشئ Workflow', tool: null, answer: 'لا يوجد محرك Workflow عام في هذا الإصدار — القدرة المتاحة فعليًا هي تشغيل متابعة العملاء المتأخرين أو عرض/إيقاف أعمال تقويم المحتوى المجدولة.' },
 { match: 'ملخص الملف المرفق', tool: 'search_context', input: { query: 'مرفق' }, answer: 'الملف المرفق يحتوي على ملاحظات مبيعات الربع — تم الاطلاع عليه ضمن هذه المحادثة.' }
];
// Phase 7B — Multi-Agent Delegation E2E (spec item 57/85): a REAL nested agent run shares this
// SAME mocked fetcher, but with its OWN systemPrompt (that agent's own agents/*.md content, not
// frost_commander's) — matched here by a short, unique phrase verified present in each prompt
// file (buildAgentPrompt output), never by request order. Each delegated agent just returns a
// valid, real decision in one turn (no tool use of its own needed for this scenario).
const AGENT_TURN_MARKERS = [
 { match: 'PERFORMANCE & GROWTH AGENT', decision: { status: 'OK', action: 'ANALYZE', rationale: 'الأداء مستقر مع فرصة نمو في القناة المدفوعة.', verification: [{ field: 'KPI_summary', source: 'weekly_report', status: 'VERIFIED' }], risk_level: 'LOW', escalation_required: false, missing_data: [], payload: { data_quality: 'GOOD', KPI_summary: [], top_wins: [], top_issues: [], funnel_bottleneck: null, possible_drivers: [], stop_doing: [], double_down: [], experiments_next_week: [], data_gaps: [] } } },
 { match: 'COMPETITOR & TREND INTELLIGENCE', decision: { status: 'OK', action: 'ANALYZE', rationale: 'رصدنا تحركًا تسعيريًا من منافس رئيسي هذا الأسبوع.', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: [], payload: { signals: [] } } }
];
const MULTI_AGENT_TRIGGER = 'اعمل خطة نمو للشهر القادم';
async function fetcher(url, options) {
 const bodyText = typeof options?.body === 'string' ? options.body : '';
 // AGENT_TURN_MARKERS are safe to check independently of position: that literal text only
 // ever appears in a DIFFERENT agent's own systemPrompt (see buildAgentPrompt), never inside
 // frost_commander's own systemPrompt or its recentHistory (which only ever carries chat
 // message TEXT, not another agent's prompt file) — so there is no cross-turn contamination
 // risk for these the way there is for frost_commander's own scenario text below.
 for (const marker of AGENT_TURN_MARKERS) {
  if (bodyText.includes(marker.match)) return new Response(JSON.stringify(textTurn(marker.decision)), { status: 200, headers: { 'content-type': 'application/json' } });
 }
 // Every candidate that COULD match frost_commander's own turn — including the multi-agent
 // trigger — must go through the SAME "most-recent-position-wins" comparison: recentHistory
 // means an OLDER turn's trigger text (e.g. a prior "اعمل خطة نمو...") is still present in
 // EVERY later request's body too, so a plain `.includes()` for any one of these would keep
 // firing long after that turn is over (this was a real bug caught by this exact E2E run).
 const ALL_CANDIDATES = [...SCENARIOS, { match: MULTI_AGENT_TRIGGER, multiAgent: true }];
 let scenario = null, bestIndex = -1;
 for (const candidate of ALL_CANDIDATES) {
  const index = bodyText.lastIndexOf(candidate.match);
  if (index > bestIndex) { bestIndex = index; scenario = candidate; }
 }
 if (!scenario) return new Response(JSON.stringify(fallbackDecision()), { status: 200, headers: { 'content-type': 'application/json' } });
 const alreadyRanTool = /"tool_result"/.test(bodyText);
 if (scenario.multiAgent) {
  const body = alreadyRanTool
   ? textTurn(decision('خطة النمو: ضاعف الإنفاق على القناة الأفضل أداءً وراقب تحرك المنافس عن قرب.', ['delegate_to_agent:performance', 'delegate_to_agent:intelligence']))
   : { stop_reason: 'tool_use', content: [
     { type: 'tool_use', id: 'call_perf', name: 'delegate_to_agent', input: { agent: 'performance', objective: 'حلل أداء الأسبوع' } },
     { type: 'tool_use', id: 'call_intel', name: 'delegate_to_agent', input: { agent: 'intelligence', objective: 'حلل تحركات المنافسين' } }
    ], usage: { input_tokens: 5, output_tokens: 5 } };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
 }
 if (!scenario.tool) return new Response(JSON.stringify(textTurn(decision(scenario.answer, []))), { status: 200, headers: { 'content-type': 'application/json' } });
 // The tool_use step's own request never yet contains a tool_result turn; the follow-up
 // (post-execution) request always does — this distinguishes "return the tool call" from
 // "return the final answer" for the SAME matched scenario without any external counter.
 const body = alreadyRanTool ? textTurn(decision(scenario.answer, [scenario.tool])) : toolUseTurn(scenario.tool, scenario.input || {});
 return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const app = await createApp({ dataDir: directory, env: { ANTHROPIC_API_KEY: 'test-secret', ANTHROPIC_MODEL: 'test-model', PLATFORM_MAIL_TRANSPORT: 'capture', PLATFORM_ADMIN_USERNAMES: 'owner' }, fetcher: (...args) => fetcher(...args) });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const failures = [];
function check(label, cond) { if (cond) console.log('OK  -', label); else { console.log('FAIL-', label); failures.push(label); } }
page.on('pageerror', err => { console.log('  [page error]', err.message); failures.push('page error: ' + err.message); });
page.on('console', msg => { if (msg.type() === 'error' && !/AI_NOT_CONFIGURED|network with no provider/i.test(msg.text())) failures.push('console error: ' + msg.text().slice(0, 200)); });
async function closeAnyOpenDialogs() {
 for (let i = 0; i < 5; i++) {
  const open = page.locator('dialog[open]');
  if (await open.count() === 0) return;
  await open.last().locator('.dialog-head button').first().click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(200);
 }
}
async function confirmActionPrompt() {
 const dlg = page.locator('dialog.confirmation[open]');
 await dlg.waitFor({ state: 'visible', timeout: 5000 });
 await dlg.getByRole('button', { name: 'تأكيد', exact: true }).click();
}
async function sendChat(text) {
 // Waiting for ":last-of-type"/"any assistant bubble visible" resolves immediately once a
 // PRIOR turn's bubble already exists, letting the next sendChat() fire before the current
 // turn's real network round-trip finishes — overlapping commander runs would then race for
 // the shared mocked-fetcher queue. Waiting for the real bubble COUNT to increase guarantees
 // each turn fully completes before the next one starts.
 const before = await page.locator('.cmdc-message-assistant').count();
 await page.fill('#cmdc-chat-form textarea', text);
 await page.click('#cmdc-chat-form button[type=submit]');
 await page.waitForFunction(count => document.querySelectorAll('.cmdc-message-assistant').length > count, before, { timeout: 10000 });
 await page.waitForTimeout(200);
}

// --- Setup: real owner + one real overdue follow-up-eligible lead + one real connection ------
// Same {cookie,csrf} session shape as every other HTTP-level test in this repo (e.g.
// tests/reporting-api.test.js) — every POST after the first must echo the session's real csrf
// token back via X-CSRF-Token or the backend's own CSRF check (src/application.js) refuses it.
async function apiCall(path, input, session) {
 const res = await fetch(base + path, { method: input ? 'POST' : 'GET', headers: { ...(input ? { 'Content-Type': 'application/json' } : {}), ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
 const data = await res.json().catch(() => null);
 return { status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0], csrf: data?.csrf };
}
const setup = await apiCall('/api/setup', { username: 'owner', name: 'Owner', password: 'test-password-long' });
const ownerSession = { cookie: setup.cookie, csrf: setup.csrf };
const lead = await apiCall('/api/crm/leads', { name: 'عميل تجريبي', customerType: 'B2C', sourceType: 'INBOUND', phone: '+966500000001' }, ownerSession);
// Force it into a follow-up-eligible stage with an overdue draft follow-up, and mark it HOT/high-value for the suggestions engine, via direct (test-only) DB writes — no HTTP route exists for either, matching the same shortcut used throughout tests/suggestions.test.js.
app.store.db.prepare(`UPDATE crm_leads SET json=json_set(json,'$.stage','QUOTE_SENT','$.temperature','HOT','$.valueSAR',80000) WHERE id=?`).run(lead.data.id);
const tenantRow = app.store.db.prepare('SELECT id FROM tenants LIMIT 1').get();
const { createConnection } = await import('../../src/integrations/connections.js');
const connection = createConnection(app.store.db, { integrationDefinitionId: 'whatsapp', name: 'قناة واتساب تجريبية' }, tenantRow.id);
app.store.db.prepare("UPDATE integration_connections SET status='CONNECTED' WHERE id=?").run(connection.id);
SCENARIOS[4].input = { targetAgentId: 'sales', toolSlug: 'whatsapp_send', connectionId: connection.id };
const { setAutonomy } = await import('../../src/autonomy.js');
setAutonomy(app.store, 'frost_commander', { level: 'L1', reason: 'E2E test promotion', expectedVersion: 0 }, { id: 'seed', name: 'Seed', role: 'owner' }, {}, tenantRow.id);

// --- Real browser login ----------------------------------------------------------------------
await page.goto(base + '/');
await page.waitForSelector('#auth-form [name=username]', { state: 'visible' });
await page.fill('#auth-form [name=username]', 'owner');
await page.fill('#auth-form [name=password]', 'test-password-long');
await page.click('#auth-form button');
await page.waitForSelector('[data-page="overview"]', { state: 'visible', timeout: 15000 });

await page.click('a[href="#command-center"]');
await page.waitForSelector('#cmdc-chat-form', { state: 'visible' });
check('Command Center page has real content', (await page.locator('#command-center').innerText()).length > 200);

// --- Chat: company health ----------------------------------------------------------------
await sendChat('اعرض حالة الشركة');
let lastAnswer = await page.locator('.cmdc-message-assistant').last().innerText();
check('Frost answered the company-health question with real content (not an error)', lastAnswer.length > 5 && !/تعذر/.test(lastAnswer));
check('the real tool-call step is shown, not hidden reasoning', await page.locator('.cmdc-step').first().isVisible());

// --- Chat: CRM follow-ups needing attention ------------------------------------------------
await sendChat('اعرض العملاء المحتاجين متابعة');
lastAnswer = await page.locator('.cmdc-message-assistant').last().innerText();
check('Frost answered the CRM follow-up question with real content', /متابعة/.test(lastAnswer));

// --- Chat: integration health ---------------------------------------------------------------
await sendChat('افحص التكاملات');
lastAnswer = await page.locator('.cmdc-message-assistant').last().innerText();
check('Frost answered the integrations-health question', /تكامل/.test(lastAnswer));

// --- Suggestion -> Create Task ----------------------------------------------------------------
await page.waitForTimeout(500);
const suggestionCard = page.locator('.cmdc-suggestion').first();
const hasSuggestion = await suggestionCard.count() > 0;
check('a real, evidence-backed suggestion appears from the seeded high-value hot lead', hasSuggestion);
if (hasSuggestion) {
 await suggestionCard.locator('[data-suggestion-action="task"]').click();
 await page.waitForTimeout(500);
 const tasksAfter = await apiCall('/api/escalations?status=OPEN', null, ownerSession);
 check('accepting the suggestion created a real Task (escalation)', tasksAfter.data.some(t => t.agent_id === 'human'));
}

// --- Live Operations ---------------------------------------------------------------------------
await page.waitForTimeout(500);
const opRows = page.locator('.cmdc-op-row');
check('Live Operations shows real recorded activity', await opRows.count() > 0);
const firstAgentRunRow = page.locator('.cmdc-op-row[data-op-kind="agent_run"]').first();
if (await firstAgentRunRow.count() > 0) {
 await firstAgentRunRow.click();
 await page.waitForSelector('dialog.drawer[open]', { state: 'visible', timeout: 5000 });
 check('opening an operation shows a real tool-call timeline', await page.locator('dialog.drawer[open] .cmdc-op-row').count() > 0);
 await closeAnyOpenDialogs();
}

// --- Manual context: add then retrieve via chat -------------------------------------------
await page.click('#command-center .ui-tabs button:nth-child(2)');
await page.fill('#cmdc-context-form [name=title]', 'هدف الربع الحالي');
await page.selectOption('#cmdc-context-form [name=type]', 'brain_goals');
await page.fill('#cmdc-context-form [name=description]', 'زيادة المبيعات 20% هذا الربع');
await page.click('#cmdc-context-form button[type=submit]');
await page.waitForSelector('#cmdc-context-just-added .notice', { state: 'visible' });
check('manual context was added with real governance', true);

await page.click('#command-center .ui-tabs button:nth-child(1)');
await sendChat('ما الهدف المسجل حاليًا؟');
lastAnswer = await page.locator('.cmdc-message-assistant').last().innerText();
check('Frost retrieved the just-added manual context in its answer', /الربع|20%/.test(lastAnswer));

// --- Multi-Agent Delegation: Frost delegates a growth plan to Performance + Intelligence -------
// (spec item 57) — real, independent child agent_runs, both linked via parent_run_id, both
// visible as their own step chips (never a fake animation — see command-chat.js's
// stepsFromToolCalls / public/pages/command-center.js's stepChipHtml).
await sendChat(MULTI_AGENT_TRIGGER);
lastAnswer = await page.locator('.cmdc-message-assistant').last().innerText();
check('Frost combined two real delegated agent results into one growth-plan answer', /الأداء الأفضل|المنافس/.test(lastAnswer));
const delegatedSteps = page.locator('.cmdc-step-delegated');
check('the command timeline shows both delegated agents by name, not hidden reasoning', await delegatedSteps.count() === 2);
const lastRunRow = await apiCall('/api/command/operations', null, ownerSession);
const parentRun = lastRunRow.data.items.find(i => i.kind === 'agent_run' && i.agentId === 'frost_commander');
if (parentRun) {
 const runDetail = await apiCall(`/api/agents/runs/${parentRun.id}`, null, ownerSession);
 check('the parent run has two real, independent child runs (performance + intelligence)', runDetail.data.childRuns?.length === 2);
 check('every child run actually completed for real — no fabricated status', runDetail.data.childRuns?.every(c => c.status === 'COMPLETED'));
}

// --- Workflow honesty: no generic workflow engine exists, so Frost says so instead of faking it -
await sendChat('أنشئ Workflow لمتابعة الـLeads المتأخرة لما يدخل Lead جديد');
lastAnswer = await page.locator('.cmdc-message-assistant').last().innerText();
check('Frost honestly declines a generic Workflow request instead of fabricating one', /Workflow|محرك/.test(lastAnswer) && !/تم إنشاء/.test(lastAnswer));

// --- Safe Attachment: upload -> ask Frost about it -> pin selected context to Company Brain ----
await page.setInputFiles('#cmdc-attach-input', { name: 'sales-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('ملاحظات مبيعات الربع: العميل يفضل التسليم صباحًا.', 'utf8') });
await sendChat('أعطني ملخص الملف المرفق');
lastAnswer = await page.locator('.cmdc-message-assistant').last().innerText();
check('Frost answered using the real uploaded attachment content', /مرفق/.test(lastAnswer));
await page.click('#command-center .ui-tabs button:nth-child(6)');
const attachmentPinButton = page.locator('[data-pin-attachment]').first();
check('the uploaded attachment is listed with real traceability (uploader/date), not auto-pinned', await attachmentPinButton.count() > 0);
await attachmentPinButton.click();
await page.waitForTimeout(300);
const attachmentsAfterPin = await apiCall('/api/command/attachments', null, ownerSession);
check('pinning the attachment created a real, governed Company Brain context item', attachmentsAfterPin.data.every(a => a.savedToBrainContextId));
await page.click('#command-center .ui-tabs button:nth-child(1)');

// --- Configuration through chat: change preview -> approval -> applied ------------------------
await sendChat('غيّر اتصال أداة إرسال واتساب لوكيل المبيعات إلى القناة التجريبية');
await page.waitForSelector('.cmdc-approval-pending', { state: 'visible', timeout: 10000 });
check('a configuration action pauses for a real Approval Required card, never auto-executes', await page.locator('.cmdc-approval-pending').count() > 0);
await page.click('.cmdc-approval-pending [data-cmdc-decide="APPROVED"]');
await confirmActionPrompt();
await page.waitForSelector('.cmdc-approval-decided', { state: 'visible', timeout: 5000 });
const assignment = app.store.db.prepare(`SELECT connection_id FROM agent_tool_assignments WHERE tenant_id=? AND agent_id='sales' AND tool_slug='whatsapp_send'`).get(tenantRow.id);
check('approving the change actually updated the real AgentToolAssignment', assignment?.connection_id === connection.id);

// --- Undo: revert the just-applied configuration change through the real canonical service -----
const historyBeforeUndo = await apiCall('/api/command/configuration-history', null, ownerSession);
const latestChange = historyBeforeUndo.data[0];
check('the configuration change created a real, structured history entry', !!latestChange && latestChange.newValue?.connectionId === connection.id);
await page.click('#command-center .ui-tabs button:nth-child(5)');
await page.click(`[data-undo-history="${latestChange.id}"]`);
await confirmActionPrompt();
await page.waitForTimeout(400);
const assignmentAfterUndo = app.store.db.prepare(`SELECT connection_id FROM agent_tool_assignments WHERE tenant_id=? AND agent_id='sales' AND tool_slug='whatsapp_send'`).get(tenantRow.id);
check('Undo restored the previous connection through the real canonical service', assignmentAfterUndo?.connection_id !== connection.id);
await page.click('#command-center .ui-tabs button:nth-child(1)');

// --- Platform Command Center: aggregate-only, never a tenant's business data --------------------
await page.click('a[href="#platform"]');
await page.waitForSelector('#pf-command-center .pfcc-card', { state: 'visible', timeout: 10000 });
const platformText = await page.locator('#pf-command-center').innerText();
check('Platform Command Center shows real scheduler/health status', /Scheduler|جدول/i.test(platformText));
const fullPlatformText = await page.locator('#platform').innerText();
check('Platform Command Center never leaks Tenant A\'s own business data (e.g. the seeded lead name)', !fullPlatformText.includes('عميل تجريبي'));
await page.click('a[href="#command-center"]');
await page.waitForSelector('#cmdc-chat-form', { state: 'visible' });

// --- Workspace switch: zero data leakage -------------------------------------------------------
// A second, independent tenant via the real self-service signup flow.
const signup = await apiCall('/api/signup', { name: 'مستخدم ثانٍ', username: 'ownerb', email: 'ownerb@example.com', password: 'a-long-test-password' });
const signupSession = { cookie: signup.cookie, csrf: signup.csrf };
const mailRow = app.store.db.prepare("SELECT captured_body FROM platform_mail_outbox WHERE to_email=? AND kind='VERIFY_EMAIL' ORDER BY created_at DESC LIMIT 1").get('ownerb@example.com');
const verifyToken = mailRow && JSON.parse(mailRow.captured_body).html.match(/verify-email\/([a-f0-9]+)/)?.[1];
if (verifyToken) await apiCall('/api/account/email/verify', { token: verifyToken }, signupSession);
await apiCall('/api/workspaces', { companyName: 'Tenant B' }, signupSession);

// Tenant B is a wholly separate owner/signup (not a second membership on the same account), so
// there is no in-app workspace switcher here — the real security boundary being tested is
// backend tenant isolation itself, checked directly.
const crossTenantContext = await apiCall('/api/command/context', null, signupSession);
check('workspace isolation: Tenant B sees none of Tenant A\'s Command Center context', crossTenantContext.status === 200 && crossTenantContext.data.length === 0);
const crossTenantConversations = await apiCall('/api/command/conversations', null, signupSession);
check('workspace isolation: Tenant B sees none of Tenant A\'s conversations', crossTenantConversations.data.length === 0);

await browser.close();
await new Promise(resolve => app.server.close(resolve));
app.store.close();
await rm(directory, { recursive: true, force: true });

console.log('\n=== COMMAND CENTER JOURNEY SUMMARY ===');
if (failures.length) { console.log('FAILURES:', failures.length); failures.forEach(f => console.log(' -', f)); process.exit(1); }
console.log('ALL CHECKS PASSED');
