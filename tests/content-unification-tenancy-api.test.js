import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

// Production-readiness gate item 6: tenant isolation must hold at the SERVICE/API level (real
// HTTP routes, real authenticated sessions), not only at the raw DB-query level already proven
// by tests/content-unification-tenancy.test.js. Workspace A must never be able to
// retrieve/update/approve/schedule/cancel content belonging to Workspace B, even knowing its
// exact content id.
async function harness(fetcher) {
 const directory = await mkdtemp(join(tmpdir(), 'hypercool-tenancy-api-'));
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
// Fixed noon-UTC instant N days ahead: its Riyadh (+3h) calendar date is the same as its UTC date, so
// content.date and scheduledAt agree whatever time of day the suite runs (scheduleContent validates
// the Riyadh date).
function futureIso(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10) + 'T12:00:00.000Z'; }

test('Tenant isolation (service/API level): Workspace B cannot review/approve/revise/reject/schedule/cancel Workspace A\'s legacy content by ID', async () => {
 const {call, app, cleanup} = await harness();
 try {
  const ownerA = await signupAndCreateWorkspace(call, app, {username: 'tia_owner1', email: 'tia1@example.com', companyName: 'Tenant A'});
  const ownerB = await signupAndCreateWorkspace(call, app, {username: 'tia_owner2', email: 'tia2@example.com', companyName: 'Tenant B'});

  const created = await call('/api/content', {title: 'محتوى A', body: 'نص', platform: 'X', date: futureIso(2).slice(0, 10), url: 'https://hyper-cool.com/tia'}, ownerA);
  assert.equal(created.status, 201);
  const contentId = created.data.id;

  // B attempts every by-ID mutation route against A's content.
  const reviewB = await call(`/api/content/${contentId}/review`, {reviewer: 'X', evidence: 'x', facts: true, claims: true, link: true}, ownerB);
  assert.equal(reviewB.status, 404, 'cross-tenant review must 404, never succeed');
  const approveB = await call(`/api/content/${contentId}/approve`, {owner: 'X'}, ownerB);
  assert.equal(approveB.status, 404, 'cross-tenant approve must 404');
  const reviseB = await call(`/api/content/${contentId}/revise`, {title: 't', body: 'b', url: 'https://hyper-cool.com/tia', platform: 'X', date: futureIso(2).slice(0, 10), reason: 'x'}, ownerB);
  assert.equal(reviseB.status, 404, 'cross-tenant revise must 404');
  const rejectB = await call(`/api/content/${contentId}/reject`, {reason: 'x'}, ownerB);
  assert.equal(rejectB.status, 404, 'cross-tenant reject must 404');

  // A legitimately approves it, then B still must not be able to schedule/cancel it.
  await call(`/api/content/${contentId}/review`, {reviewer: 'R', evidence: 'x', facts: true, claims: true, link: true}, ownerA);
  await call(`/api/content/${contentId}/approve`, {owner: 'O'}, ownerA);
  await call('/api/calendar', {startDate: new Date().toISOString().slice(0, 10)}, ownerB); // B seeds its OWN calendar
  const scheduleB = await call('/api/schedule', {contentId, scheduledAt: futureIso(2)}, ownerB);
  assert.equal(scheduleB.status, 404, 'cross-tenant schedule attempt must 404, never schedule another tenant\'s content');

  await call('/api/calendar', {startDate: new Date().toISOString().slice(0, 10)}, ownerA);
  const scheduleA = await call('/api/schedule', {contentId, scheduledAt: futureIso(2)}, ownerA);
  assert.equal(scheduleA.status, 201, 'sanity check: A can schedule its own content');

  const cancelB = await call('/api/schedule/cancel', {contentId}, ownerB);
  assert.equal(cancelB.status, 200, 'cancelJobs is a no-op for a non-matching tenant, not an error');
  assert.equal(cancelB.data.cancelled, 0, 'cross-tenant cancel must cancel ZERO jobs — never touch another tenant\'s active job');

  // Confirm A's job is still alive after B's no-op cancel attempt.
  const planningA = await call('/api/planning', null, ownerA, {method: 'GET'});
  const activeJobsForA = planningA.data.jobs.filter(j => j.contentId === contentId && ['SCHEDULED', 'READY_FOR_CONNECTOR'].includes(j.status));
  assert.equal(activeJobsForA.length, 1, 'A\'s real job must survive B\'s cross-tenant cancel attempt untouched');

  // B's own planning view must never show A's content at all.
  const planningB = await call('/api/planning', null, ownerB, {method: 'GET'});
  assert.equal(planningB.data.content.find(i => i.id === contentId), undefined, 'A\'s content must never appear in B\'s Global Calendar');
 } finally {await cleanup();}
});

const textTurn = obj => ({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify(obj)}], usage: {input_tokens: 5, output_tokens: 5}});
function passComplianceFetcher() {
 return async (url, options) => {
  const bodyText = typeof options?.body === 'string' ? options.body : '';
  if (bodyText.includes('Brand & Compliance Agent')) {
   return new Response(JSON.stringify(textTurn({status: 'OK', action: 'REVIEW', rationale: 'x', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: [], payload: {classification: 'PASS', issues: [], corrected_text_if_possible: null, evidence_sources: [], verified_fields: ['body'], blocked_fields: [], human_review_required: false, reason: 'x'}})), {status: 200, headers: {'content-type': 'application/json'}});
  }
  return new Response(JSON.stringify(textTurn({status: 'NEEDS_DATA', action: 'NONE', rationale: 'not mocked', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: ['x'], payload: null})), {status: 200, headers: {'content-type': 'application/json'}});
 };
}

test('Tenant isolation (service/API level): Workspace B cannot read/update/run-compliance/generate-creative on Workspace A\'s campaign content by ID', async () => {
 const {call, app, cleanup} = await harness(passComplianceFetcher());
 try {
  const ownerA = await signupAndCreateWorkspace(call, app, {username: 'tia_owner3', email: 'tia3@example.com', companyName: 'Tenant A2'});
  const ownerB = await signupAndCreateWorkspace(call, app, {username: 'tia_owner4', email: 'tia4@example.com', companyName: 'Tenant B2'});

  const campaign = await call('/api/marketing/campaigns', {name: 'حملة A'}, ownerA);
  const item = await call('/api/marketing/content', {channel: 'X', format: 'post', body: 'محتوى A', campaignId: campaign.data.id}, ownerA);
  const itemId = item.data.id;

  const getB = await call(`/api/marketing/content/${itemId}`, null, ownerB, {method: 'GET'});
  assert.equal(getB.status, 404, 'cross-tenant GET on campaign content must 404');
  const patchB = await call(`/api/marketing/content/${itemId}`, {status: 'IN_REVIEW'}, ownerB, {method: 'PATCH'});
  assert.equal(patchB.status, 404, 'cross-tenant PATCH on campaign content must 404, never mutate another tenant\'s record');
  const complianceB = await call(`/api/marketing/content/${itemId}/run-compliance`, {}, ownerB);
  assert.equal(complianceB.status, 404, 'cross-tenant run-compliance must 404');
  const creativeB = await call(`/api/marketing/content/${itemId}/generate-creative`, {}, ownerB);
  assert.equal(creativeB.status, 404, 'cross-tenant generate-creative must 404');

  // B's own reads must never include A's campaign content.
  const listB = await call('/api/marketing/content', null, ownerB, {method: 'GET'});
  assert.equal(listB.data.find(i => i.id === itemId), undefined);
  const planningB = await call(`/api/planning?campaignId=${campaign.data.id}`, null, ownerB, {method: 'GET'});
  assert.equal(planningB.data.content.length, 0, 'B must never see A\'s campaign content even when filtering by A\'s exact campaignId');

  // Confirm A's own record is completely untouched by all of B's rejected attempts.
  const getA = await call(`/api/marketing/content/${itemId}`, null, ownerA, {method: 'GET'});
  assert.equal(getA.status, 200);
  assert.equal(getA.data.status, 'DRAFT');
 } finally {await cleanup();}
});
