import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

// Same harness/compliance-mocking pattern already established in
// tests/marketing-orchestration.test.js — reused verbatim so this test proves the SAME real
// compliance-approval path (not a shortcut) now also produces a real, cross-visible schedule.
async function harness(fetcher) {
 const directory = await mkdtemp(join(tmpdir(), 'hypercool-content-unify-'));
 const app = await createApp({dataDir: directory, env: {ANTHROPIC_API_KEY: 'test-secret', ANTHROPIC_MODEL: 'test-model', PLATFORM_MAIL_TRANSPORT: 'capture'}, fetcher});
 await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
 const base = `http://127.0.0.1:${app.server.address().port}`;
 async function call(path, input, session, {method} = {}) {
  const res = await fetch(base + path, {method: method || (input ? 'POST' : 'GET'), headers: {...(input ? {'Content-Type': 'application/json'} : {}), ...(session ? {cookie: session.cookie, 'x-csrf-token': session.csrf} : {})}, ...(input ? {body: JSON.stringify(input)} : {})});
  const data = await res.json().catch(() => null);
  return {status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0], csrf: data?.csrf};
 }
 return {app, base, call, cleanup: async () => {await new Promise(resolve => app.server.close(resolve)); app.store.close(); await rm(directory, {recursive: true, force: true});}};
}
function latestMailTo(app, toEmail, kind) {
 const row = app.store.db.prepare('SELECT * FROM platform_mail_outbox WHERE to_email=? AND kind=? ORDER BY created_at DESC LIMIT 1').get(toEmail, kind);
 return row ? JSON.parse(row.captured_body) : null;
}
function extractToken(body, marker) {
 const match = (body.html + body.text).match(new RegExp(marker + '/([a-f0-9]+)'));
 return match ? match[1] : null;
}
async function signupAndCreateWorkspace(call, app, {username, email, companyName}) {
 const signup = await call('/api/signup', {name: 'مستخدم اختبار', username, email, password: 'a-long-test-password'});
 const session = {cookie: signup.cookie, csrf: signup.csrf};
 const mail = latestMailTo(app, email, 'VERIFY_EMAIL');
 const token = extractToken(mail, 'verify-email');
 await call('/api/account/email/verify', {token}, null);
 await call('/api/workspaces', {companyName}, session);
 return session;
}
const textTurn = obj => ({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify(obj)}], usage: {input_tokens: 5, output_tokens: 5}});
function passComplianceFetcher() {
 return async (url, options) => {
  const bodyText = typeof options?.body === 'string' ? options.body : '';
  if (bodyText.includes('Brand & Compliance Agent')) {
   return new Response(JSON.stringify(textTurn({status: 'OK', action: 'REVIEW', rationale: 'فحص حقيقي', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: [], payload: {classification: 'PASS', issues: [], corrected_text_if_possible: null, evidence_sources: [], verified_fields: ['body'], blocked_fields: [], human_review_required: false, reason: 'اختبار'}})), {status: 200, headers: {'content-type': 'application/json'}});
  }
  return new Response(JSON.stringify(textTurn({status: 'NEEDS_DATA', action: 'NONE', rationale: 'not mocked', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: ['x'], payload: null})), {status: 200, headers: {'content-type': 'application/json'}});
 };
}
function futureIso(days) { return new Date(Date.now() + days * 86400000).toISOString(); }

test('Content Unification: campaign content approved+scheduled via the Marketing API produces a real schedule_jobs row and is visible from the Global Calendar', async () => {
 const {call, app, cleanup} = await harness(passComplianceFetcher());
 try {
  const owner = await signupAndCreateWorkspace(call, app, {username: 'unify1', email: 'unify1@example.com', companyName: 'Unify Test 1'});
  const campaign = await call('/api/marketing/campaigns', {name: 'حملة الوحدة'}, owner);
  const item = await call('/api/marketing/content', {channel: 'Instagram', format: 'post', body: 'نص حقيقي للاختبار', campaignId: campaign.data.id}, owner);
  await call(`/api/marketing/content/${item.data.id}`, {status: 'IN_REVIEW'}, owner, {method: 'PATCH'});
  await call(`/api/marketing/content/${item.data.id}/run-compliance`, {}, owner);
  const approved = await call(`/api/marketing/content/${item.data.id}`, {status: 'APPROVED'}, owner, {method: 'PATCH'});
  assert.equal(approved.status, 200);

  const scheduledAt = futureIso(3);
  const scheduled = await call(`/api/marketing/content/${item.data.id}`, {status: 'SCHEDULED', scheduledAt}, owner, {method: 'PATCH'});
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.data));
  assert.equal(scheduled.data.status, 'SCHEDULED');
  assert.equal(scheduled.data.scheduledAt, scheduledAt);

  // The previously-broken gap: a real schedule_jobs row must now exist.
  const job = app.store.db.prepare("SELECT * FROM schedule_jobs WHERE content_id=?").get(item.data.id);
  assert.ok(job, 'expected a real schedule_jobs row for the scheduled campaign content');
  assert.equal(job.status, 'SCHEDULED');

  // Visible identically from BOTH read paths — the actual "no longer two systems" proof.
  const marketingCalendar = await call('/api/marketing/calendar', null, owner, {method: 'GET'});
  assert.equal(marketingCalendar.status, 200);
  const inMarketingCalendar = marketingCalendar.data.find(i => i.id === item.data.id);
  assert.ok(inMarketingCalendar, 'expected the scheduled campaign item in the Marketing calendar');
  assert.equal(inMarketingCalendar.status, 'SCHEDULED');

  const globalPlanning = await call('/api/planning', null, owner, {method: 'GET'});
  assert.equal(globalPlanning.status, 200);
  const inGlobalCalendar = globalPlanning.data.content.find(i => i.id === item.data.id);
  assert.ok(inGlobalCalendar, 'expected the SAME campaign item visible from the Global Calendar (/api/planning)');
  assert.equal(inGlobalCalendar.campaignId, campaign.data.id);
  assert.equal(inGlobalCalendar.platform, 'Instagram');

  // Filtering /api/planning by campaignId returns exactly this item.
  const filtered = await call(`/api/planning?campaignId=${campaign.data.id}`, null, owner, {method: 'GET'});
  assert.equal(filtered.data.content.length, 1);
  assert.equal(filtered.data.content[0].id, item.data.id);
 } finally {await cleanup();}
});

test('Content Unification: a standalone post (no campaign) created via the legacy Planning API is excluded from the Marketing calendar but visible in the Global Calendar', async () => {
 const {call, app, cleanup} = await harness();
 try {
  const owner = await signupAndCreateWorkspace(call, app, {username: 'unify2', email: 'unify2@example.com', companyName: 'Unify Test 2'});
  const content = await call('/api/content', {title: 'منشور مستقل', body: 'نص', platform: 'Instagram', date: futureIso(1).slice(0, 10), url: 'https://hyper-cool.com/product'}, owner);
  assert.equal(content.status, 201);

  const globalPlanning = await call('/api/planning', null, owner, {method: 'GET'});
  const inGlobal = globalPlanning.data.content.find(i => i.id === content.data.id);
  assert.ok(inGlobal, 'standalone post must be visible in the Global Calendar');
  assert.ok(!inGlobal.campaignId, 'a standalone post must never be campaign-tagged');

  const marketingCalendar = await call('/api/marketing/calendar', null, owner, {method: 'GET'});
  assert.equal(marketingCalendar.data.find(i => i.id === content.data.id), undefined, 'a standalone (non-campaign) post must never appear as campaign content');

  const campaignContentList = await call('/api/marketing/content', null, owner, {method: 'GET'});
  assert.equal(campaignContentList.data.find(i => i.id === content.data.id), undefined, 'standalone content must not leak into the campaign content list either');

  // Explicit campaignId=none filter on the Global Calendar returns only standalone content.
  const standaloneOnly = await call('/api/planning?campaignId=none', null, owner, {method: 'GET'});
  assert.ok(standaloneOnly.data.content.some(i => i.id === content.data.id));
 } finally {await cleanup();}
});

test('Content Unification: a campaign content item reaching a review-equivalent status never crashes or leaks into the legacy flat Content page/dashboard', async () => {
 const {call, app, cleanup} = await harness();
 try {
  const owner = await signupAndCreateWorkspace(call, app, {username: 'unify3', email: 'unify3@example.com', companyName: 'Unify Test 3'});
  const item = await call('/api/marketing/content', {channel: 'X', format: 'post', body: 'محتوى حملة قيد المراجعة'}, owner);
  const toReview = await call(`/api/marketing/content/${item.data.id}`, {status: 'IN_REVIEW'}, owner, {method: 'PATCH'});
  assert.equal(toReview.status, 200);
  assert.equal(toReview.data.status, 'IN_REVIEW'); // external (Marketing) shape keeps its own vocabulary

  // Real regression this closes: the legacy flat Content page's /api/state assumes every
  // content row has item.review.reviewer once status reaches REVIEWED — campaign content never
  // has that shape (its own IN_REVIEW status is a different vocabulary entirely) and must never
  // appear here.
  const state = await call('/api/state', null, owner, {method: 'GET'});
  assert.equal(state.status, 200);
  assert.equal(state.data.content.find(i => i.id === item.data.id), undefined, 'campaign content must never leak into the legacy /api/state content list');

  // Same for the legacy Content dashboard (content-ops.js) — must not crash and must not
  // count this item as a "missing creative asset" (a concept campaign content never had).
  const dashboard = await call('/api/content/dashboard', null, owner, {method: 'GET'});
  assert.equal(dashboard.status, 200);

  // But it IS still visible from the real Marketing content list and the Global Calendar.
  const marketingList = await call('/api/marketing/content', null, owner, {method: 'GET'});
  assert.ok(marketingList.data.some(i => i.id === item.data.id));
  const globalPlanning = await call('/api/planning', null, owner, {method: 'GET'});
  assert.ok(globalPlanning.data.content.some(i => i.id === item.data.id));
 } finally {await cleanup();}
});

test('Content Unification regression: a live-scheduled campaign content job is picked up as READY by prepareDue, never permanently BLOCKED', async () => {
 // Locks in a real bug found during the production-readiness gate: updateCampaignContentItem()
 // writes content.status:'SCHEDULED' (its own real, externally-visible status), but
 // prepareDue()'s campaign-shaped validity check originally required status==='APPROVED' — a
 // mismatch that would BLOCK every live-scheduled campaign job forever, the exact
 // "never actually executes" gap this whole unification was meant to close.
 const {call, app, cleanup} = await harness(passComplianceFetcher());
 try {
  const owner = await signupAndCreateWorkspace(call, app, {username: 'unify4', email: 'unify4@example.com', companyName: 'Unify Test 4'});
  const campaign = await call('/api/marketing/campaigns', {name: 'حملة الجدولة'}, owner);
  const item = await call('/api/marketing/content', {channel: 'Instagram', format: 'post', body: 'محتوى مجدول حقيقي', campaignId: campaign.data.id}, owner);
  await call(`/api/marketing/content/${item.data.id}`, {status: 'IN_REVIEW'}, owner, {method: 'PATCH'});
  await call(`/api/marketing/content/${item.data.id}/run-compliance`, {}, owner);
  await call(`/api/marketing/content/${item.data.id}`, {status: 'APPROVED'}, owner, {method: 'PATCH'});

  const scheduledAt = new Date(Date.now() + 1500).toISOString();
  const scheduled = await call(`/api/marketing/content/${item.data.id}`, {status: 'SCHEDULED', scheduledAt}, owner, {method: 'PATCH'});
  assert.equal(scheduled.status, 200);
  assert.equal(scheduled.data.status, 'SCHEDULED');

  await new Promise(resolve => setTimeout(resolve, 2000));
  const prep = await call('/api/schedule/prepare', {}, owner);
  assert.equal(prep.status, 200);
  assert.equal(prep.data.ready, 1, `expected the due job to become ready, got: ${JSON.stringify(prep.data)}`);
  assert.equal(prep.data.blocked, 0);

  const job = app.store.db.prepare('SELECT status FROM schedule_jobs WHERE content_id=?').get(item.data.id);
  assert.equal(job.status, 'READY_FOR_CONNECTOR');
 } finally {await cleanup();}
});

test('Content Unification regression: editing scheduledAt on an already-SCHEDULED campaign item is rejected, never silently desyncing the content record from its active job', async () => {
 // Locks in a real bug found during the production-readiness gate: PATCHing scheduledAt alone
 // (without also toggling status) on an already-SCHEDULED campaign item used to succeed and
 // update content.scheduledAt while leaving the existing schedule_jobs row untouched at the OLD
 // time — the publishing worker would then fire at a time the content record no longer showed,
 // a silent divergence between the canonical record and the job that actually executes.
 const {call, app, cleanup} = await harness(passComplianceFetcher());
 try {
  const owner = await signupAndCreateWorkspace(call, app, {username: 'unify5', email: 'unify5@example.com', companyName: 'Unify Test 5'});
  const item = await call('/api/marketing/content', {channel: 'X', format: 'post', body: 'محتوى لإعادة الجدولة'}, owner);
  await call(`/api/marketing/content/${item.data.id}`, {status: 'IN_REVIEW'}, owner, {method: 'PATCH'});
  await call(`/api/marketing/content/${item.data.id}/run-compliance`, {}, owner);
  await call(`/api/marketing/content/${item.data.id}`, {status: 'APPROVED'}, owner, {method: 'PATCH'});
  const firstTime = futureIso(3);
  const scheduled = await call(`/api/marketing/content/${item.data.id}`, {status: 'SCHEDULED', scheduledAt: firstTime}, owner, {method: 'PATCH'});
  assert.equal(scheduled.status, 200);

  const secondTime = futureIso(5);
  const rescheduleAttempt = await call(`/api/marketing/content/${item.data.id}`, {scheduledAt: secondTime}, owner, {method: 'PATCH'});
  assert.equal(rescheduleAttempt.status, 409, 'changing scheduledAt while a job is already active must be rejected, not silently accepted');

  const jobs = app.store.db.prepare('SELECT status, json FROM schedule_jobs WHERE content_id=?').all(item.data.id);
  assert.equal(jobs.length, 1, 'no duplicate job must be created by the rejected reschedule attempt');
  assert.equal(JSON.parse(jobs[0].json).scheduledAt, firstTime, 'the existing job must keep its original time, untouched by the rejected attempt');

  const unchanged = await call(`/api/marketing/content/${item.data.id}`, null, owner, {method: 'GET'});
  assert.equal(unchanged.data.scheduledAt, firstTime, 'the content record must still agree with its real job (no desync)');
 } finally {await cleanup();}
});

test('Content Unification regression: an arbitrary connectionId supplied by the client is never trusted or persisted (item 10 — no account routing exists yet)', async () => {
 const {call, app, cleanup} = await harness();
 try {
  const owner = await signupAndCreateWorkspace(call, app, {username: 'unify6', email: 'unify6@example.com', companyName: 'Unify Test 6'});
  const item = await call('/api/marketing/content', {channel: 'X', format: 'post', body: 'محتوى', connectionId: 'some-other-tenants-connection-id'}, owner);
  assert.equal(item.status, 201);
  const row = app.store.db.prepare('SELECT json FROM content_items WHERE id=?').get(item.data.id);
  assert.equal(JSON.parse(row.json).connectionId, null, 'a caller-supplied connectionId must never be persisted — account routing is not implemented');
 } finally {await cleanup();}
});
