import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {createApp} from '../src/application.js';
import {getCredentials} from '../src/runtime/credentials.js';
import {resolveMetaAccessToken} from '../src/runtime/meta-oauth.js';
import {resolveLinkedInAccessToken} from '../src/runtime/linkedin-oauth.js';
import {resolveMicrosoftAccessToken} from '../src/runtime/microsoft-oauth.js';
import {resolveSallaAccessToken} from '../src/runtime/salla-oauth.js';
import {integrationStatus} from '../src/runtime/tools.js';
import {evaluateAgentReadiness} from '../src/runtime/agent-readiness.js';
import {setAccountStatus} from '../src/client/accounts.js';
import {buildToolRegistry} from '../src/runtime/tools.js';

// Merchant OAuth end to end over HTTP. Providers are a scripted fetcher (no network); everything else is real: the signed
// single-use state, the tenant binding, the encrypted stores, the plan/role/support gates and the audit trail.
const PASSWORD = 'oauth-long-test-password-1';
const ENV = {
 PLATFORM_MAIL_TRANSPORT: 'capture', PLATFORM_ADMIN_USERNAMES: 'oa_admin', SUPPORT_ACCESS_USERNAMES: 'oa_admin', INTEGRATION_ENCRYPTION_KEY: 'ab'.repeat(32),
 SALLA_CLIENT_ID: 'salla-id', SALLA_CLIENT_SECRET: 'salla-secret', META_APP_ID: 'meta-id', META_APP_SECRET: 'meta-secret', X_CLIENT_ID: 'x-id', X_CLIENT_SECRET: 'x-secret',
 MICROSOFT_CLIENT_ID: 'ms-id', MICROSOFT_CLIENT_SECRET: 'ms-secret', LINKEDIN_CLIENT_ID: 'li-id', LINKEDIN_CLIENT_SECRET: 'li-secret',
 // the OPERATOR's own static tokens: they must never act for another tenant
 META_ACCESS_TOKEN: 'PLATFORM-META-STATIC-TOKEN', SALLA_ACCESS_TOKEN: 'PLATFORM-SALLA-STATIC-TOKEN', MICROSOFT_ACCESS_TOKEN: 'PLATFORM-MS-STATIC-TOKEN'
};

// ---- scripted providers ------------------------------------------------------------------------------------------------------
const script = {salla: 'ok', meta: 'ok', x: 'ok', microsoft: 'ok', linkedin: 'ok', calls: []};
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json'}});
async function providers(url, init = {}) {
 const u = String(url);
 const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
 script.calls.push({url: u, method: init.method || 'GET', body, auth: init.headers?.Authorization || init.headers?.authorization || null});
 // ---- Salla
 if (u === 'https://accounts.salla.sa/oauth2/token') {
  if (script.salla === 'exchange_fails') return json({error: 'invalid_grant'}, 400);
  return json({access_token: `salla-access-${body.code}`, refresh_token: 'salla-refresh-1', expires_in: 3600, scope: 'offline_access products.read'});
 }
 if (u.startsWith('https://api.salla.dev/admin/v2/products')) {
  if (script.salla === 'verify_fails') return json({error: 'nope'}, 401);
  const auth = init.headers?.Authorization || '';
  if (auth.includes('PLATFORM-SALLA-STATIC-TOKEN')) return json({success: true, data: [], pagination: {totalPages: 1}}); // must never be used for a merchant
  return json({success: true, data: [], pagination: {totalPages: 1}});
 }
 // ---- Meta
 if (u.startsWith('https://graph.facebook.com/v21.0/oauth/access_token')) {
  if (script.meta === 'exchange_fails') return json({error: {message: 'bad code'}}, 400);
  const q = new URL(u).searchParams;
  return json({access_token: q.get('grant_type') === 'fb_exchange_token' ? 'meta-user-long' : 'meta-user-short', expires_in: 5000000});
 }
 if (u.startsWith('https://graph.facebook.com/v21.0/me/accounts')) return json({data: script.meta === 'no_assets' ? [] : [{id: 'PAGE-A', name: 'Alpha Page', access_token: 'meta-page-token-A', instagram_business_account: {id: 'IG-A', username: 'alpha_ig'}}]});
 if (u.startsWith('https://graph.facebook.com/v21.0/me/businesses')) return json({data: [{owned_whatsapp_business_accounts: {data: [{id: 'WABA-A', phone_numbers: {data: [{id: 'PN-A', display_phone_number: '+966500000001'}]}}]}}]});
 // ---- X
 if (u === 'https://api.twitter.com/2/oauth2/token') {
  if (body.grant_type === 'authorization_code') { script.xVerifier = body.code_verifier; return json({access_token: 'x-access-1', refresh_token: 'x-refresh-1', expires_in: 7200, scope: 'tweet.read tweet.write users.read offline_access'}); }
  return json({access_token: 'x-access-2', refresh_token: 'x-refresh-2', expires_in: 7200});
 }
 if (u === 'https://api.twitter.com/2/users/me') return json({data: {id: 'X-1', username: 'alpha_x', name: 'Alpha X'}});
 // ---- Microsoft
 if (u.includes('login.microsoftonline.com') && u.endsWith('/token')) return json({access_token: 'ms-access-1', refresh_token: 'ms-refresh-1', expires_in: 3600, scope: 'Mail.Send Mail.Read offline_access User.Read'});
 if (u.startsWith('https://graph.microsoft.com/v1.0/me')) return json({id: 'MS-1', displayName: 'Alpha Mail', mail: 'owner@alpha.example'});
 // ---- LinkedIn
 if (u === 'https://www.linkedin.com/oauth/v2/accessToken') {
  if (body.grant_type === 'refresh_token') return json({access_token: 'li-access-2', refresh_token: 'li-refresh-2', expires_in: 5000000});
  return json({access_token: 'li-access-1', refresh_token: 'li-refresh-1', expires_in: 5000000, scope: 'openid profile email rw_organization_admin w_organization_social'});
 }
 if (u === 'https://api.linkedin.com/v2/userinfo') return json({sub: 'LI-1', name: 'Alpha Li', email: 'li@alpha.example'});
 if (u.startsWith('https://api.linkedin.com/v2/organizationAcls')) return json({elements: [{'organizationalTarget~': {id: '777', localizedName: 'Alpha Company'}}]});
 return json({error: `unscripted ${u}`}, 404);
}

let app, base, dir;
before(async () => {
 dir = await mkdtemp(join(tmpdir(), 'frost-oauth-'));
 app = await createApp({dataDir: dir, env: ENV, fetcher: providers});
 await new Promise(r => app.server.listen(0, '127.0.0.1', r));
 base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await new Promise(r => app.server.close(r)); app.store.close(); await rm(dir, {recursive: true, force: true}); });
const db = () => app.store.db;

async function call(path, {method, body, s, headers = {}, redirect = 'manual'} = {}) {
 const res = await fetch(base + path, {method: method || (body ? 'POST' : 'GET'), redirect, headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(s ? {cookie: s.cookies.join('; '), ...(s.noCsrf ? {} : {'x-csrf-token': s.csrf})} : {}), ...headers}, ...(body ? {body: JSON.stringify(body)} : {})});
 const text = await res.text();
 let data = null; try { data = JSON.parse(text); } catch { /* html/redirect */ }
 return {status: res.status, data, text, location: res.headers.get('location'), setCookie: res.headers.get('set-cookie'), csrf: data?.csrf};
}
const sess = r => ({cookies: [r.setCookie.split(';')[0]], csrf: r.csrf});
const REG = {name: 'Owner', phone: '+966500000100', country: 'SA', businessType: 'retail', businessSize: 'small', ecommercePlatform: 'salla', teamSize: 3, goals: ['content'], planSlug: 'starter', acceptTerms: true, locale: 'en'};
async function registerMerchant(username, businessName, planSlug = 'growth') {
 const r = await call('/api/client/register', {body: {...REG, planSlug, username, email: `${username}@oauth.example`, password: PASSWORD, businessName}});
 assert.equal(r.status, 201, r.text);
 return sess(r);
}
const tenantOf = username => db().prepare('SELECT m.tenant_id t FROM client_members m JOIN users u ON u.id=m.user_id WHERE u.username=?').get(username).t;
// a provider redirecting the browser back: cross-site top-level navigation, NO session cookie (SameSite=Strict withholds it)
// (fetch() sets its own Sec-Fetch-* headers, so a raw http request is used to be exactly what the browser sends)
const nav = (path, extra = {}, fetchSite = 'cross-site') => new Promise((resolve, reject) => {
 const req = http.request(base + path, {method: 'GET', headers: {'sec-fetch-site': fetchSite, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...extra}}, res => {
  let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({status: res.statusCode, text, location: res.headers.location || null}));
 });
 req.on('error', reject); req.end();
});
const xhr = (path) => new Promise((resolve, reject) => {
 const req = http.request(base + path, {method: 'GET', headers: {'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty'}}, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => resolve({status: res.statusCode, text: t})); });
 req.on('error', reject); req.end();
});
async function start(s, slug, body = {}) {
 const r = await call(`/api/client/integrations/${slug}/connect`, {body, s});
 return {res: r, url: r.data?.authorizeUrl ? new URL(r.data.authorizeUrl) : null};
}
const stateOf = url => url.searchParams.get('state');
const callbackPath = (slug, state, code = 'CODE1') => `/api/client/integrations/${slug}/callback?code=${code}&state=${encodeURIComponent(state)}`;
const reasonOf = location => new URL(location, 'http://x').searchParams.get('reason');
const outcomeOf = location => new URL(location, 'http://x').searchParams.get('oauth');
const S = {};

test('providers are described honestly: available only when the server can really run the flow', async () => {
 S.a = await registerMerchant('oa_a', 'Alpha Store');
 S.b = await registerMerchant('oa_b', 'Beta Store');
 S.c = await registerMerchant('oa_c', 'Gamma Store', 'starter');
 S.tenantA = tenantOf('oa_a'); S.tenantB = tenantOf('oa_b'); S.tenantC = tenantOf('oa_c');
 const list = await call('/api/client/integrations', {s: S.a});
 assert.equal(list.status, 200);
 const by = Object.fromEntries(list.data.items.map(i => [i.slug, i]));
 for (const slug of ['salla', 'meta', 'x', 'microsoft365', 'linkedin']) { assert.equal(by[slug].method, 'oauth', slug); assert.equal(by[slug].availability.state, 'available', slug); assert.equal(by[slug].available, true); }
 assert.equal(by.zid.availability.state, 'unavailable', 'no Zid app configured on this server');
 assert.equal(by.zid.availability.reason, 'provider_not_configured');
 assert.equal(by.canva.availability.state, 'coming_soon');
 assert.equal(by.canva.available, false);
 assert.equal(by.anthropic.method, 'api_key');
 assert.equal(by.whatsapp.connectVia, 'meta');
 // no fake connect for an unavailable / unknown provider
 const zid = await start(S.a, 'zid');
 assert.equal(zid.res.status, 409);
 assert.equal(zid.res.data.error, 'OAUTH_UNAVAILABLE:provider_not_configured');
 assert.equal((await start(S.a, 'nosuch')).res.status, 404);
 // nothing was created by those attempts
 assert.equal(db().prepare('SELECT COUNT(*) n FROM integration_connections WHERE tenant_id=?').get(S.tenantA).n, 0);
});

test('Salla: signed single-use state, provider redirect without a session, verified token stored encrypted, nothing echoed back', async () => {
 const {res, url} = await start(S.a, 'salla');
 assert.equal(res.status, 200, res.text);
 assert.equal(url.origin + url.pathname, 'https://accounts.salla.sa/oauth2/auth');
 assert.equal(url.searchParams.get('redirect_uri'), `${base}/api/client/integrations/salla/callback`, 'the portal registers its own callback, not the dashboard one');
 const state = stateOf(url);
 assert.match(state, /^[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{40,}$/, 'token.signature');
 // bound to the workspace and the person, stored hashed (the raw token is not in the database)
 const row = db().prepare('SELECT * FROM oauth_states WHERE tenant_id=?').get(S.tenantA);
 assert.equal(row.integration_definition_id, 'salla');
 assert.notEqual(row.state_token_hash, state.split('.')[0]);
 assert.equal(row.used_at, null);
 assert.equal(db().prepare('SELECT COUNT(*) n FROM integration_connections WHERE tenant_id=?').get(S.tenantA).n, 0, 'nothing is created before the provider answers');

 const back = await nav(callbackPath('salla', state, 'AAA'));
 assert.equal(back.status, 302, back.text);
 assert.equal(outcomeOf(back.location), 'success');
 assert.match(back.location, /^\/client\/integrations\?/);
 const conn = db().prepare("SELECT * FROM integration_connections WHERE tenant_id=? AND integration_definition_id='salla'").get(S.tenantA);
 assert.equal(conn.status, 'CONNECTED');
 // tokens live encrypted in the vault, under this tenant only
 const vault = db().prepare('SELECT * FROM integration_credentials_vault WHERE connection_id=?').get(conn.id);
 assert.equal(vault.tenant_id, S.tenantA);
 assert.ok(!vault.encrypted_payload.includes('salla-access-AAA'), 'ciphertext, not the token');
 assert.equal(db().prepare('SELECT COUNT(*) n FROM integration_credentials_vault WHERE tenant_id=?').get(S.tenantB).n, 0);
 // no API response ever carries a token
 for (const path of ['/api/client/integrations', '/api/client/integrations/salla/status', '/api/client/dashboard', '/api/client/audit']) {
  const r = await call(path, {s: S.a});
  assert.equal(r.status, 200, path);
  assert.ok(!/salla-access|salla-refresh|PLATFORM-SALLA/.test(r.text), `${path} leaks no token`);
 }
 const status = await call('/api/client/integrations/salla/status', {s: S.a});
 assert.equal(status.data.connected, true);
 assert.equal(status.data.connections.length, 1);
 // audit trail
 const actions = db().prepare("SELECT action,actor_kind FROM client_audit_logs WHERE tenant_id=? AND action LIKE 'CLIENT_INTEGRATION_%' ORDER BY rowid").all(S.tenantA).map(r => r.action);
 assert.deepEqual(actions, ['CLIENT_INTEGRATION_OAUTH_STARTED', 'CLIENT_INTEGRATION_CONNECTED']);
 S.sallaConnection = conn.id;
 // the verification call used the merchant's own token, never the operator's static one
 const verify = script.calls.filter(c => c.url.startsWith('https://api.salla.dev/admin/v2/products'));
 assert.ok(verify.length >= 1 && verify.every(c => c.auth === 'Bearer salla-access-AAA'), JSON.stringify(verify.map(c => c.auth)));
 // the provider was called with the merchant's own token, never the platform's static one
});

test('state replay, expiry, tampering and provider mismatch are refused and leave nothing behind', async () => {
 const before = db().prepare('SELECT COUNT(*) n FROM integration_connections WHERE tenant_id=?').get(S.tenantC).n;
 // replay of an already-used state
 const one = await start(S.c, 'salla');
 const state = stateOf(one.url);
 assert.equal(outcomeOf((await nav(callbackPath('salla', state, 'R1'))).location), 'success');
 const replay = await nav(callbackPath('salla', state, 'R2'));
 assert.equal(outcomeOf(replay.location), 'error');
 assert.equal(reasonOf(replay.location), 'state_used');
 // expired
 const two = await start(S.c, 'salla');
 db().prepare("UPDATE oauth_states SET expires_at='2020-01-01T00:00:00.000Z' WHERE state_token_hash=?").run(createHash('sha256').update(stateOf(two.url).split('.')[0]).digest('hex'));
 assert.equal(reasonOf((await nav(callbackPath('salla', stateOf(two.url)))).location), 'state_expired');
 // tampered signature / token / missing state / wrong provider
 const three = await start(S.c, 'salla');
 const [token, sig] = stateOf(three.url).split('.');
 assert.equal(reasonOf((await nav(callbackPath('salla', `${token}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`))).location), 'state_invalid');
 assert.equal(reasonOf((await nav(callbackPath('salla', `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}.${sig}`))).location), 'state_invalid');
 assert.equal(reasonOf((await nav('/api/client/integrations/salla/callback?code=abc')).location), 'state_invalid');
 assert.equal(reasonOf((await nav(callbackPath('meta', stateOf(three.url)))).location), 'state_invalid', 'a Salla state is not valid for Meta');
 // the untouched state still works exactly once
 assert.equal(outcomeOf((await nav(callbackPath('salla', stateOf(three.url), 'R3'))).location), 'success');
 // two extra Salla stores were connected by the valid flows only
 assert.equal(db().prepare('SELECT COUNT(*) n FROM integration_connections WHERE tenant_id=?').get(S.tenantC).n, before + 2);
 const failures = db().prepare("SELECT detail_json FROM client_audit_logs WHERE tenant_id=? AND action='CLIENT_INTEGRATION_OAUTH_FAILED'").all(S.tenantC).map(r => JSON.parse(r.detail_json).reason);
 assert.ok(failures.includes('state_used') && failures.includes('state_expired') && failures.includes('state_invalid'));
});

test('a credential can never land in another workspace: state binding, session mismatch, foreign connection ids', async () => {
 // B has a session cookie while A's redirect arrives: the state names A's owner, B's browser must not complete it
 const started = await start(S.a, 'salla');
 const state = stateOf(started.url);
 const foreign = await nav(callbackPath('salla', state, 'B1'), {cookie: S.b.cookies.join('; ')});
 assert.equal(reasonOf(foreign.location), 'session_mismatch');
 assert.equal(db().prepare('SELECT COUNT(*) n FROM integration_connections WHERE tenant_id=?').get(S.tenantB).n, 0);
 assert.equal(db().prepare('SELECT COUNT(*) n FROM integration_credentials_vault WHERE tenant_id=?').get(S.tenantB).n, 0);
 // a state minted for A cannot be re-pointed at B: the signature covers (token, tenant, user, provider)
 const [token] = state.split('.');
 const forged = `${token}.${'A'.repeat(43)}`;
 assert.equal(reasonOf((await nav(callbackPath('salla', forged))).location), 'state_invalid');
 // B cannot reconnect / inspect / test / disconnect A's connection
 assert.equal((await call('/api/client/integrations/salla/connect', {body: {connectionId: S.sallaConnection}, s: S.b})).status, 404);
 assert.equal((await call(`/api/client/integrations/${S.sallaConnection}/test`, {body: {}, s: S.b})).status, 404);
 assert.equal((await call(`/api/client/integrations/${S.sallaConnection}/disconnect`, {body: {}, s: S.b})).status, 404);
 assert.equal((await call('/api/client/integrations/salla/disconnect', {body: {connectionId: S.sallaConnection}, s: S.b})).status, 404);
 assert.equal((await call('/api/client/integrations/salla/status', {s: S.b})).data.connections.length, 0, 'B sees none of A stores');
 assert.equal(db().prepare('SELECT status FROM integration_connections WHERE id=?').get(S.sallaConnection).status, 'CONNECTED');
 // the pending A state still belongs to A
 assert.equal(outcomeOf((await nav(callbackPath('salla', state, 'A9'))).location), 'success');
});

test('CSRF, roles and account state: only members holding integrations.manage on a writable workspace can start or disconnect', async () => {
 // CSRF: a start request without the session token is rejected
 assert.equal((await call('/api/client/integrations/salla/connect', {body: {}, s: {...S.a, noCsrf: true}})).status, 403);
 assert.equal((await call('/api/client/integrations/salla/connect', {body: {}, s: {...S.a, csrf: 'not-the-token'}})).status, 403);
 assert.equal((await call('/api/client/integrations/salla/connect', {body: {}})).status, 401);
 // a viewer and an analyst hold no integrations.manage; an operator neither
 for (const [role, username] of [['viewer', 'oa_viewer'], ['operator', 'oa_operator']]) {
  const email = `${username}@oauth.example`;
  assert.equal((await call('/api/client/team/invitations', {body: {email, role}, s: S.a})).status, 201);
  const token = JSON.parse(db().prepare("SELECT captured_body FROM platform_mail_outbox WHERE to_email=? AND kind='INVITATION' ORDER BY created_at DESC LIMIT 1").get(email).captured_body).html.match(/invite\/([a-f0-9]+)/)[1];
  S[role] = sess(await call(`/api/client/invitations/${token}/register`, {body: {username, name: role, password: PASSWORD}}));
  const started = await call('/api/client/integrations/salla/connect', {body: {}, s: S[role]});
  assert.equal(started.status, 403, role);
  assert.equal(started.data.error, 'PERMISSION_DENIED:integrations.manage');
  assert.equal((await call('/api/client/integrations/salla/disconnect', {body: {}, s: S[role]})).status, 403);
  assert.equal((await call(`/api/client/integrations/${S.sallaConnection}/disconnect`, {body: {}, s: S[role]})).status, 403);
  assert.equal((await call('/api/client/integrations/salla/status', {s: S[role]})).status, 200, 'reading status is allowed');
 }
 // demoted between start and callback: the callback re-checks the initiating person
 const started = await start(S.a, 'salla');
 const ownerId = db().prepare("SELECT id FROM users WHERE username='oa_a'").get().id;
 db().prepare("UPDATE client_members SET workspace_role='viewer' WHERE user_id=?").run(ownerId);
 let denied;
 try { denied = await nav(callbackPath('salla', stateOf(started.url), 'D1')); }
 finally { db().prepare("UPDATE client_members SET workspace_role='workspace_owner' WHERE user_id=?").run(ownerId); }
 assert.equal(reasonOf(denied.location), 'not_permitted');
 // suspended / limited workspaces cannot start a flow, and cannot finish one that was started before
 const pending = await start(S.b, 'salla');
 const admin = {id: 'system', name: 'test', kind: 'admin'};
 setAccountStatus(db(), app.auth || {revokeSessions() {}}, admin, S.tenantB, 'suspended', 'test suspension');
 assert.equal((await call('/api/client/integrations/salla/connect', {body: {}, s: S.b})).status, 403);
 assert.equal(reasonOf((await nav(callbackPath('salla', stateOf(pending.url), 'S1'))).location), 'account_blocked');
 setAccountStatus(db(), app.auth || {revokeSessions() {}}, admin, S.tenantB, 'active', 'test reactivation');
 db().prepare("UPDATE client_profiles SET account_status='active' WHERE tenant_id=?").run(S.tenantB);
});

test('plan limits apply to connections; the legacy dashboard OAuth routes stay closed to merchants', async () => {
 // starter allows a fixed number of integrations: fill the quota with Salla stores, then the next start is refused
 const limit = (await call('/api/client/me', {s: S.c})).data.access.limits.integrations;
 assert.ok(Number.isInteger(limit));
 let used = db().prepare("SELECT COUNT(*) n FROM integration_connections WHERE tenant_id=? AND status!='DISCONNECTED'").get(S.tenantC).n;
 while (used < limit) { const s = await start(S.c, 'salla'); assert.equal(outcomeOf((await nav(callbackPath('salla', stateOf(s.url), `Q${used}`))).location), 'success'); used++; }
 const over = await start(S.c, 'salla');
 assert.equal(over.res.status, 403);
 assert.equal(over.res.data.error, 'LIMIT_REACHED:integrations');
 // legacy owner-only OAuth routes are not a way around the portal
 for (const path of ['/api/integrations/salla/oauth/start', '/api/integrations/meta/oauth/start', '/api/integrations/oauth/salla/start', '/api/integrations/salla/oauth/callback?code=1&state=2']) {
  assert.equal((await call(path, {s: S.c})).data?.error, 'MERCHANT_USE_CLIENT_PORTAL', path);
 }
});

test('provider failures are reported as clear error states and never leave a half-connected workspace', async () => {
 const count = () => db().prepare('SELECT COUNT(*) n FROM integration_connections WHERE tenant_id=?').get(S.tenantB).n;
 const vaultCount = () => db().prepare('SELECT COUNT(*) n FROM integration_credentials_vault WHERE tenant_id=?').get(S.tenantB).n;
 // user denied consent at the provider
 let s = await start(S.b, 'salla');
 let back = await nav(`/api/client/integrations/salla/callback?error=access_denied&state=${encodeURIComponent(stateOf(s.url))}`);
 assert.equal(outcomeOf(back.location), 'error');
 assert.equal(reasonOf(back.location), 'denied');
 assert.equal(count(), 0);
 // the code exchange fails
 script.salla = 'exchange_fails';
 s = await start(S.b, 'salla');
 back = await nav(callbackPath('salla', stateOf(s.url), 'BAD'));
 assert.equal(reasonOf(back.location), 'provider_error');
 // the token is fine but does not verify against the provider
 script.salla = 'verify_fails';
 s = await start(S.b, 'salla');
 back = await nav(callbackPath('salla', stateOf(s.url), 'UNVERIFIED'));
 assert.equal(reasonOf(back.location), 'verification_failed');
 script.salla = 'ok';
 assert.equal(count(), 0, 'no connection row');
 assert.equal(vaultCount(), 0, 'no credential');
 assert.equal(db().prepare("SELECT COUNT(*) n FROM client_audit_logs WHERE tenant_id=? AND action='CLIENT_INTEGRATION_OAUTH_FAILED'").get(S.tenantB).n >= 3, true);
 // the failure is visible to the person as an error state in the portal, not a silent success
 assert.equal((await call('/api/client/integrations/salla/status', {s: S.b})).data.connected, false);
 // Meta login that exposes no Page and no WhatsApp account connects nothing usable
 script.meta = 'no_assets';
 s = await start(S.b, 'meta');
 back = await nav(callbackPath('meta', stateOf(s.url), 'EMPTY'));
 assert.equal(reasonOf(back.location), 'verification_failed');
 script.meta = 'ok';
 assert.equal(db().prepare("SELECT COUNT(*) n FROM integration_credentials WHERE tenant_id=? AND provider='meta'").get(S.tenantB).n, 0);
});

test('Meta: stored under the workspace, page token encrypted, WhatsApp and the platform static token never cross workspaces', async () => {
 const s = await start(S.a, 'meta');
 assert.equal(s.url.hostname, 'www.facebook.com');
 assert.equal(s.url.searchParams.get('redirect_uri'), `${base}/api/client/integrations/meta/callback`);
 assert.equal(outcomeOf((await nav(callbackPath('meta', stateOf(s.url), 'META1'))).location), 'success');
 const row = db().prepare("SELECT * FROM integration_credentials WHERE provider='meta'").all();
 assert.equal(row.length, 1);
 assert.equal(row[0].tenant_id, S.tenantA);
 assert.ok(!row[0].access_token_enc.includes('meta-user-long') && !row[0].extra_enc.includes('meta-page-token-A'), 'encrypted at rest');
 const store = {db: db()};
 // resolution is per workspace: A gets its own page token, B gets nothing - and NOT the operator's static token either
 assert.equal(resolveMetaAccessToken({store, env: ENV}, 'page', S.tenantA).token, 'meta-page-token-A');
 assert.equal(resolveMetaAccessToken({store, env: ENV}, 'page', S.tenantB), null);
 const defaultTenant = db().prepare('SELECT id FROM tenants ORDER BY created_at LIMIT 1').get().id;
 assert.equal(resolveMetaAccessToken({store, env: ENV}, 'page', defaultTenant)?.token, 'PLATFORM-META-STATIC-TOKEN', "the operator's own workspace keeps its static token");
 assert.equal(integrationStatus(ENV, db(), S.tenantA).meta.configured, true);
 assert.equal(integrationStatus(ENV, db(), S.tenantB).meta.configured, false);
 assert.equal(integrationStatus(ENV, db(), S.tenantB).whatsapp.configured, false);
 // the same holds for Salla and Microsoft static tokens, and for agent readiness
 assert.equal(await resolveSallaAccessToken({store, env: ENV, fetcher: providers}, S.tenantB), null);
 assert.equal(await resolveMicrosoftAccessToken({store, env: ENV, fetcher: providers}, S.tenantB), null);
 assert.equal((await resolveSallaAccessToken({store, env: ENV, fetcher: providers}, defaultTenant))?.token, 'PLATFORM-SALLA-STATIC-TOKEN');
 const readinessB = evaluateAgentReadiness(db(), ENV, {tenantId: S.tenantB, agentId: 'publishing'});
 assert.notEqual(readinessB.status, 'READY', 'the operator static Meta token does not make another workspace ready to publish');
 assert.ok(readinessB.blockers.length > 0);
 const status = await call('/api/client/integrations/meta/status', {s: S.a});
 assert.equal(status.data.connected, true);
 assert.equal(status.data.whatsapp.phoneNumberId, 'PN-A');
 assert.ok(!/meta-user|meta-page-token/.test(status.text));
 // WhatsApp card reflects the Meta login that exposed WhatsApp
 const card = (await call('/api/client/integrations', {s: S.a})).data.items.find(i => i.slug === 'whatsapp');
 assert.equal(card.connection?.status, 'CONNECTED');
 // reconnect keeps a single row and is audited as a reconnect
 const again = await start(S.a, 'meta');
 assert.equal(outcomeOf((await nav(callbackPath('meta', stateOf(again.url), 'META2'))).location), 'success');
 assert.equal(db().prepare("SELECT COUNT(*) n FROM integration_credentials WHERE provider='meta'").get().n, 1);
 assert.ok(db().prepare("SELECT 1 FROM client_audit_logs WHERE tenant_id=? AND action='CLIENT_INTEGRATION_RECONNECTED'").get(S.tenantA));
});

test('X: PKCE verifier is kept encrypted server side and used for the exchange; refresh tokens are honoured (LinkedIn, Microsoft)', async () => {
 const x = await start(S.a, 'x');
 const challenge = x.url.searchParams.get('code_challenge');
 assert.equal(x.url.searchParams.get('code_challenge_method'), 'S256');
 const stored = db().prepare("SELECT pkce_verifier_enc FROM oauth_states WHERE integration_definition_id='x' ORDER BY created_at DESC LIMIT 1").get();
 assert.ok(stored.pkce_verifier_enc && !stored.pkce_verifier_enc.includes(script.xVerifier || 'zzz'));
 assert.equal(outcomeOf((await nav(callbackPath('x', stateOf(x.url), 'X1'))).location), 'success');
 assert.equal(createHash('sha256').update(script.xVerifier).digest('base64url'), challenge, 'the verifier that was sent matches the challenge');
 assert.equal(db().prepare("SELECT tenant_id FROM integration_credentials WHERE provider='x'").get().tenant_id, S.tenantA);
 // LinkedIn: connect, let the access token expire, the stored refresh token renews it
 const li = await start(S.a, 'linkedin');
 assert.equal(outcomeOf((await nav(callbackPath('linkedin', stateOf(li.url), 'L1'))).location), 'success');
 db().prepare("UPDATE integration_credentials SET expires_at='2020-01-01T00:00:00.000Z' WHERE provider='linkedin'").run();
 const renewed = await resolveLinkedInAccessToken({store: {db: db()}, env: ENV, fetcher: providers}, S.tenantA);
 assert.equal(renewed.token, 'li-access-2');
 assert.equal(getCredentials(db(), ENV, 'linkedin', S.tenantA).refreshToken, 'li-refresh-2');
 assert.equal(await resolveLinkedInAccessToken({store: {db: db()}, env: ENV, fetcher: providers}, S.tenantB), null);
 // Microsoft
 const ms = await start(S.a, 'microsoft365');
 assert.equal(outcomeOf((await nav(callbackPath('microsoft365', stateOf(ms.url), 'M1'))).location), 'success');
 assert.equal(db().prepare("SELECT tenant_id FROM integration_credentials WHERE provider='microsoft365'").get().tenant_id, S.tenantA);
 assert.equal((await resolveMicrosoftAccessToken({store: {db: db()}, env: ENV, fetcher: providers}, S.tenantA)).token, 'ms-access-1');
});

test('an agent tool run for one workspace never uses another workspace credential or the operator static token', async () => {
 // Microsoft is connected for A only (previous test); the server also holds the operator's static Microsoft token
 const registry = buildToolRegistry({store: app.store, env: ENV, eventBus: {emit() {}, on() {}}, fetcher: providers, runtimeRef: {current: null}});
 const tool = registry.get('get_calendar_availability');
 const input = {emails: ['x@example.com'], start: '2026-10-01T09:00:00', end: '2026-10-01T10:00:00'};
 const ctx = tenantId => ({tenantId, actor: {id: 'agent:followup', name: 'agent', role: 'agent'}, agentId: 'followup', runId: 'r1'});
 script.calls.length = 0;
 const forB = await tool.handler(input, ctx(S.tenantB));
 assert.equal(forB.status, 'INTEGRATION_REQUIRED', JSON.stringify(forB));
 assert.ok(!script.calls.some(c => c.auth && /PLATFORM-MS-STATIC-TOKEN|ms-access-1/.test(c.auth)), 'no Microsoft call was made with any token for workspace B');
 const forA = await tool.handler(input, ctx(S.tenantA));
 assert.notEqual(forA.status, 'INTEGRATION_REQUIRED', 'workspace A has its own connection');
 assert.ok(script.calls.some(c => c.url.startsWith('https://graph.microsoft.com') && c.auth === 'Bearer ms-access-1'), 'A acts with A own token');
 assert.ok(!script.calls.some(c => c.auth && c.auth.includes('PLATFORM-MS-STATIC-TOKEN')), "the operator's static token was never used");
});

test('disconnect removes every credential and marks the connection; the agent side then finds nothing', async () => {
 const before = db().prepare("SELECT COUNT(*) n FROM integration_credentials_vault WHERE tenant_id=?").get(S.tenantA).n;
 // support-free path: confirmation is not needed for the owner, the audit trail records who did it
 const gone = await call('/api/client/integrations/meta/disconnect', {body: {}, s: S.a});
 assert.equal(gone.status, 200, gone.text);
 assert.equal(db().prepare("SELECT COUNT(*) n FROM integration_credentials WHERE provider='meta'").get().n, 0);
 assert.equal(resolveMetaAccessToken({store: {db: db()}, env: ENV}, 'page', S.tenantA), null, 'no token left to resolve');
 assert.equal(db().prepare("SELECT status FROM integration_connections WHERE tenant_id=? AND integration_definition_id='meta'").get(S.tenantA).status, 'DISCONNECTED');
 assert.equal((await call('/api/client/integrations/meta/status', {s: S.a})).data.connected, false);
 // several Salla stores (workspace C has two): the provider route needs to know which one
 assert.equal((await call('/api/client/integrations/salla/disconnect', {body: {}, s: S.c})).data.error, 'CONNECTION_ID_REQUIRED');
 const one = await call('/api/client/integrations/salla/disconnect', {body: {connectionId: S.sallaConnection}, s: S.a});
 assert.equal(one.status, 200);
 assert.equal(db().prepare('SELECT COUNT(*) n FROM integration_credentials_vault WHERE connection_id=?').get(S.sallaConnection).n, 0);
 // and by connection id
 const other = db().prepare("SELECT id FROM integration_connections WHERE tenant_id=? AND integration_definition_id='salla' AND status='CONNECTED' LIMIT 1").get(S.tenantA).id;
 assert.equal((await call(`/api/client/integrations/${other}/disconnect`, {body: {}, s: S.a})).status, 200);
 assert.equal(db().prepare('SELECT COUNT(*) n FROM integration_credentials_vault WHERE connection_id=?').get(other).n, 0);
 assert.ok(db().prepare("SELECT 1 FROM client_audit_logs WHERE tenant_id=? AND action='CLIENT_INTEGRATION_DISCONNECTED'").get(S.tenantA));
 assert.ok(before > 0);
});

test('support sessions cannot start or complete OAuth; a read-only session cannot disconnect either', async () => {
 S.admin = sess(await call('/api/signup', {body: {name: 'oa admin', username: 'oa_admin', email: 'oa_admin@oauth.example', password: PASSWORD}}));
 const tenant = S.tenantA;
 const viewOnly = await call(`/api/client-admin/customers/${tenant}/support-sessions`, {body: {reason: 'Investigating an integration problem', level: 'view_only', minutes: 20}, s: S.admin});
 assert.equal(viewOnly.status, 201, viewOnly.text);
 const ro = {cookies: [...S.admin.cookies, viewOnly.setCookie.split(';')[0]], csrf: S.admin.csrf};
 assert.equal((await call('/api/client/integrations/salla/connect', {body: {}, s: ro})).data.error, 'SUPPORT_READ_ONLY');
 assert.equal((await call('/api/client/integrations/salla/disconnect', {body: {connectionId: S.sallaConnection}, s: ro})).data.error, 'SUPPORT_READ_ONLY');
 assert.equal((await call('/api/client/integrations/salla/status', {s: ro})).status, 200, 'reads work');
 await call('/api/client/support/end', {body: {}, s: ro});
 const limited = await call(`/api/client-admin/customers/${tenant}/support-sessions`, {body: {reason: 'Reconnecting the store together', level: 'limited', minutes: 20}, s: S.admin});
 const lim = {cookies: [...S.admin.cookies, limited.setCookie.split(';')[0]], csrf: S.admin.csrf};
 // authorizing a third-party account is the customer's act, at any support level
 const denied = await call('/api/client/integrations/salla/connect', {body: {}, s: lim});
 assert.equal(denied.status, 403);
 assert.match(denied.data.error, /SUPPORT_FORBIDDEN|PERMISSION_DENIED/);
 await call('/api/client/support/end', {body: {}, s: lim});
});

test('every merchant OAuth route is reachable directly after a page refresh (SPA deep links)', async () => {
 for (const path of ['/client/integrations', '/client/integrations?oauth=success&provider=salla', '/client/integrations?oauth=error&provider=meta&reason=state_expired']) {
  const res = await fetch(base + path, {headers: {'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document'}});
  assert.equal(res.status, 200, path);
  assert.match(res.headers.get('content-type'), /text\/html/);
 }
 // and the provider's own cross-site navigation to the callback is accepted (not rejected as a cross-site request)
 const s = await start(S.a, 'salla');
 const back = await nav(callbackPath('salla', stateOf(s.url), 'DEEP'));
 assert.equal(back.status, 302);
 // whereas a cross-site *fetch* to the same URL is not a navigation and is refused
 assert.equal((await xhr(callbackPath('salla', 'x.y'))).status, 403);
});
