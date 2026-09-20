import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

// Production-readiness gate item 8: archiving a campaign must NOT delete or hide the canonical
// content items or their publishing history (schedule_jobs). archiveCampaign() only ever sets
// marketing_campaigns.archived_at — it has no cascade into content_items or schedule_jobs (no
// FK constraint exists between them at all), but this proves the observable behavior end-to-end
// through the real API, not just by reading the source.
async function harness(fetcher) {
 const directory = await mkdtemp(join(tmpdir(), 'hypercool-campaign-archival-'));
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
   return new Response(JSON.stringify(textTurn({status: 'OK', action: 'REVIEW', rationale: 'x', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: [], payload: {classification: 'PASS', issues: [], corrected_text_if_possible: null, evidence_sources: [], verified_fields: ['body'], blocked_fields: [], human_review_required: false, reason: 'x'}})), {status: 200, headers: {'content-type': 'application/json'}});
  }
  return new Response(JSON.stringify(textTurn({status: 'NEEDS_DATA', action: 'NONE', rationale: 'not mocked', verification: [], risk_level: 'LOW', escalation_required: false, missing_data: ['x'], payload: null})), {status: 200, headers: {'content-type': 'application/json'}});
 };
}
function futureIso(days) { return new Date(Date.now() + days * 86400000).toISOString(); }

test('Content Unification: archiving a campaign preserves its content and schedule_jobs untouched', async () => {
 const {call, app, cleanup} = await harness(passComplianceFetcher());
 try {
  const owner = await signupAndCreateWorkspace(call, app, {username: 'archival1', email: 'archival1@example.com', companyName: 'Archival Test'});
  const campaign = await call('/api/marketing/campaigns', {name: 'حملة للأرشفة'}, owner);
  const item = await call('/api/marketing/content', {channel: 'X', format: 'post', body: 'محتوى قبل الأرشفة', campaignId: campaign.data.id}, owner);
  await call(`/api/marketing/content/${item.data.id}`, {status: 'IN_REVIEW'}, owner, {method: 'PATCH'});
  await call(`/api/marketing/content/${item.data.id}/run-compliance`, {}, owner);
  await call(`/api/marketing/content/${item.data.id}`, {status: 'APPROVED'}, owner, {method: 'PATCH'});
  const scheduledAt = futureIso(3);
  await call(`/api/marketing/content/${item.data.id}`, {status: 'SCHEDULED', scheduledAt}, owner, {method: 'PATCH'});
  const jobBefore = app.store.db.prepare('SELECT * FROM schedule_jobs WHERE content_id=?').get(item.data.id);
  assert.ok(jobBefore, 'sanity check: a real job exists before archival');

  const archived = await call(`/api/marketing/campaigns/${campaign.data.id}/archive`, {}, owner);
  assert.equal(archived.status, 200, JSON.stringify(archived.data));

  // The canonical content row must still exist, unmodified, with its campaignId intact.
  const contentRow = app.store.db.prepare('SELECT * FROM content_items WHERE id=?').get(item.data.id);
  assert.ok(contentRow, 'content row must survive campaign archival');
  assert.equal(contentRow.campaign_id, campaign.data.id, 'campaignId reference must be preserved, not nulled out');
  assert.equal(JSON.parse(contentRow.json).status, 'SCHEDULED');

  // The schedule_jobs row (publishing history) must also survive untouched.
  const jobAfter = app.store.db.prepare('SELECT * FROM schedule_jobs WHERE content_id=?').get(item.data.id);
  assert.ok(jobAfter, 'schedule_jobs row must survive campaign archival');
  assert.equal(jobAfter.status, jobBefore.status);

  // The content stays reachable/editable through the normal API after its campaign is archived.
  const getAfter = await call(`/api/marketing/content/${item.data.id}`, null, owner, {method: 'GET'});
  assert.equal(getAfter.status, 200, 'content must remain readable via the API after its campaign is archived');
  assert.equal(getAfter.data.campaignId, campaign.data.id);

  // It also still appears in the Global Calendar, filterable by the now-archived campaign's id.
  const planning = await call(`/api/planning?campaignId=${campaign.data.id}`, null, owner, {method: 'GET'});
  assert.equal(planning.data.content.length, 1, 'content must still be visible/filterable by campaignId after archival');
 } finally {await cleanup();}
});
