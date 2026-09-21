import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

// Frost Partners - end-to-end over the real HTTP surface: apply -> approve -> click -> signup ->
// payment webhook -> commission -> hold -> payout -> refund, plus isolation/permission checks.
const SECRET = 'whsec_partner_test';
const ENV = {PLATFORM_MAIL_TRANSPORT: 'capture', PLATFORM_ADMIN_USERNAMES: 'pt_admin', INTEGRATION_ENCRYPTION_KEY: 'ab'.repeat(32), PARTNER_BILLING_WEBHOOK_SECRET: SECRET};
let app, base, dir;

before(async () => {
 dir = await mkdtemp(join(tmpdir(), 'frost-partners-'));
 app = await createApp({dataDir: dir, env: ENV});
 await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
 base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
 await new Promise(resolve => app.server.close(resolve));
 app.store.close();
 await rm(dir, {recursive: true, force: true});
});

async function call(path, {method, body, session, headers = {}, raw, redirect} = {}) {
 const res = await fetch(base + path, {
  method: method || (body || raw ? 'POST' : 'GET'), redirect: redirect || 'follow',
  headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(session ? {cookie: session.cookie, 'x-csrf-token': session.csrf} : {}), ...headers},
  ...(body ? {body: JSON.stringify(body)} : raw ? {body: raw} : {})
 });
 const type = res.headers.get('content-type') || '';
 const data = type.includes('json') ? await res.json().catch(() => null) : null;
 return {status: res.status, data, res, cookie: res.headers.get('set-cookie')?.split(';')[0], csrf: data?.csrf};
}
const db = () => app.store.db;
const PASSWORD = 'a-long-test-password';
async function signup(username, email, extraHeaders = {}) {
 const r = await call('/api/signup', {body: {name: `User ${username}`, username, email, password: PASSWORD}, headers: extraHeaders});
 assert.equal(r.status, 201, JSON.stringify(r.data));
 const session = {cookie: r.cookie, csrf: r.csrf, userId: r.data.user.id};
 return session;
}
async function verifyEmail(email) {
 const row = db().prepare("SELECT captured_body FROM platform_mail_outbox WHERE to_email=? AND kind='VERIFY_EMAIL' ORDER BY created_at DESC LIMIT 1").get(email);
 const {html, text} = JSON.parse(row.captured_body);
 const token = (html + text).match(/verify-email\/([a-f0-9]+)/)[1];
 assert.equal((await call('/api/account/email/verify', {body: {token}})).status, 200);
}
const APPLICATION = {fullName: 'Sara Partner', phone: '+966500000001', country: 'SA', partnerType: 'agency', marketingMethod: 'Instagram reels and a newsletter about e-commerce.', expectedCustomers: 25, acceptTerms: true};
async function registerPartner(username, email, extra = {}) {
 const r = await call('/api/partners/register', {body: {...APPLICATION, name: `Partner ${username}`, username, email, password: PASSWORD, ...extra}});
 return r;
}
const sign = payload => { const raw = JSON.stringify(payload); return {raw, headers: {'content-type': 'application/json', 'x-frost-signature': 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex')}}; };
async function webhook(payload) { const s = sign(payload); return call('/api/webhooks/partner-billing', {raw: s.raw, headers: s.headers}); }
const planId = slug => db().prepare('SELECT id FROM partner_plans WHERE slug=?').get(slug).id;
const ledgerSum = (partnerId, bucket) => db().prepare('SELECT COALESCE(SUM(amount_minor),0) v FROM commission_ledger WHERE partner_id=? AND bucket=?').get(partnerId, bucket).v;

const state = {};

test('boot: starter plans exist and the public landing endpoint serves real plans', async () => {
 const r = await call('/api/partners/public/plans');
 assert.equal(r.status, 200);
 assert.deepEqual(r.data.plans.map(p => p.slug), ['starter', 'professional', 'elite']);
 assert.ok(r.data.plans[1].entitlements.includes('partner.marketing_assets'));
 assert.ok(!r.data.plans[0].entitlements.includes('partner.marketing_assets'), 'starter does not include marketing assets');
 assert.equal(r.data.settings.registrationMode, 'open');
 // landing pages are served
 for (const p of ['/partners', '/partners/login', '/partners/dashboard']) assert.equal((await call(p)).status, 200);
 // unknown/anonymous access is rejected
 assert.equal((await call('/api/partners/me')).status, 401);
 assert.equal((await call('/api/partners/dashboard')).status, 401);
 assert.equal((await call('/api/partners/admin/overview')).status, 401);
});

test('application -> approval creates profile, plan, referral code and default link', async () => {
 state.admin = await signup('pt_admin', 'admin@example.com');
 await verifyEmail('admin@example.com');
 const adminMe = await call('/api/partners/me', {session: state.admin});
 assert.equal(adminMe.data.isAdmin, true);
 assert.ok(adminMe.data.roles.includes('owner'));

 const reg = await registerPartner('pt_sara', 'sara@example.com');
 assert.equal(reg.status, 201, JSON.stringify(reg.data));
 assert.equal(reg.data.application.status, 'pending');
 state.sara = {cookie: reg.cookie, csrf: reg.csrf, userId: reg.data.user.id};
 await verifyEmail('sara@example.com');

 // pending applicant is not a partner: portal data is denied, but /me works and shows the application
 const me = await call('/api/partners/me', {session: state.sara});
 assert.equal(me.data.partner, null);
 assert.equal(me.data.application.status, 'pending');
 assert.deepEqual(me.data.roles, ['user']);
 assert.equal((await call('/api/partners/dashboard', {session: state.sara})).data.error, 'NOT_A_PARTNER');
 // a second application while one is open is refused
 assert.equal((await call('/api/partners/applications', {body: {...APPLICATION, email: 'sara@example.com'}, session: state.sara})).status, 409);

 // a normal user (and the applicant) cannot touch the admin surface
 assert.equal((await call('/api/partners/admin/overview', {session: state.sara})).status, 403);
 assert.equal((await call(`/api/partners/admin/applications/${reg.data.application.id}/decision`, {body: {decision: 'approve', planId: planId('professional')}, session: state.sara})).status, 403);

 // incomplete decisions are validated
 const appId = reg.data.application.id;
 assert.equal((await call(`/api/partners/admin/applications/${appId}/decision`, {body: {decision: 'reject'}, session: state.admin})).status, 400, 'a rejection needs a reason');
 const info = await call(`/api/partners/admin/applications/${appId}/decision`, {body: {decision: 'needs_information', message: 'Please share your audience size.'}, session: state.admin});
 assert.equal(info.data.status, 'needs_information');
 const answered = await call(`/api/partners/applications/${appId}/respond`, {body: {response: '12k followers'}, session: state.sara});
 assert.equal(answered.data.status, 'pending');

 const approved = await call(`/api/partners/admin/applications/${appId}/decision`, {body: {decision: 'approve', planId: planId('professional')}, session: state.admin});
 assert.equal(approved.status, 200, JSON.stringify(approved.data));
 assert.equal(approved.data.status, 'approved');
 assert.equal((await call(`/api/partners/admin/applications/${appId}/decision`, {body: {decision: 'approve', planId: planId('professional')}, session: state.admin})).status, 409, 'cannot approve twice');

 const after = await call('/api/partners/me', {session: state.sara});
 assert.ok(after.data.roles.includes('partner'));
 state.saraProfile = after.data.partner;
 assert.match(state.saraProfile.referralCode, /^[A-Z2-9]{8}$/);
 assert.equal(state.saraProfile.plan.slug, 'professional');
 assert.equal(state.saraProfile.effectiveCommissionBps, 2500);
 assert.equal(state.saraProfile.status, 'active');
 assert.ok(state.saraProfile.entitlements.includes('partner.marketing_assets'));
 assert.equal(state.saraProfile.links[0].url, `${base}/r/${state.saraProfile.referralCode}`);
 // notification + real (captured) email
 const notes = await call('/api/partners/notifications', {session: state.sara});
 assert.ok(notes.data.items.some(n => n.kind === 'application_approved'));
 const mail = db().prepare("SELECT * FROM platform_mail_outbox WHERE to_email='sara@example.com' AND kind='PARTNER_NOTICE'").all();
 assert.ok(mail.some(m => JSON.parse(m.captured_body).text.includes(state.saraProfile.referralCode)));
 // the partner dashboard is empty but real (zeros, no invented data)
 const dash = await call('/api/partners/dashboard', {session: state.sara});
 assert.equal(dash.status, 200);
 assert.equal(dash.data.totals.clicks, 0);
 assert.equal(dash.data.totals.commissionsTotalMinor, 0);
 assert.equal(dash.data.series.visitors.length, 30);
 assert.deepEqual(dash.data.topLinks, []);
});

test('referral link click -> customer signup is attributed to the partner (server-side)', async () => {
 const code = state.saraProfile.referralCode;
 const click = await call(`/r/${code}`, {redirect: 'manual'});
 assert.equal(click.status, 302);
 assert.equal(click.res.headers.get('location'), '/');
 const cookie = click.res.headers.get('set-cookie').split(';')[0];
 assert.match(cookie, /^frost_ref=[a-f0-9]{48}$/);
 // refresh within 30 minutes is not a second click
 await call(`/r/${code}`, {redirect: 'manual', headers: {cookie}});
 assert.equal(db().prepare('SELECT COALESCE(SUM(click_count),0) v FROM referral_visits').get().v, 1);
 // unknown code: redirect, no tracking, no cookie
 const bad = await call('/r/ZZZZZZZZ', {redirect: 'manual'});
 assert.equal(bad.status, 302);
 assert.equal(bad.res.headers.get('set-cookie'), null);

 // a client-supplied fake cookie value cannot create attribution
 await signup('pt_fake', 'fake@example.com', {cookie: 'frost_ref=' + 'f'.repeat(48)});
 assert.equal(db().prepare("SELECT COUNT(*) n FROM referrals WHERE referred_user_id=(SELECT id FROM users WHERE username='pt_fake')").get().n, 0);

 state.cust = await signup('pt_cust1', 'cust1@example.com', {cookie});
 const ref = db().prepare('SELECT * FROM referrals WHERE referred_user_id=?').get(state.cust.userId);
 assert.equal(ref.partner_id, state.saraProfile.id);
 assert.equal(ref.status, 'registered');
 await verifyEmail('cust1@example.com');
 assert.equal(db().prepare('SELECT status FROM referrals WHERE referred_user_id=?').get(state.cust.userId).status, 'qualified');

 const list = await call('/api/partners/referrals', {session: state.sara});
 assert.equal(list.data.total, 1);
 assert.equal(list.data.items[0].customerEmail, 'c***@e***', 'the partner only ever sees a masked email');
 assert.ok(!JSON.stringify(list.data).includes('cust1@example.com'));
 const dash = await call('/api/partners/dashboard', {session: state.sara});
 assert.equal(dash.data.totals.clicks, 1);
 assert.equal(dash.data.totals.registered, 1);
 assert.equal(dash.data.totals.paidCustomers, 0);
});

test('self-referral is rejected and an attribution window expiry is honoured', async () => {
 // Sara clicks her own link and registers a second account with her own email
 const click = await call(`/r/${state.saraProfile.referralCode}`, {redirect: 'manual', headers: {'user-agent': 'other-agent'}});
 const cookie = click.res.headers.get('set-cookie').split(';')[0];
 await signup('pt_selfie', 'sara@example.com'.replace('sara', 'sara2'), {cookie});
 // (different email => allowed); now the true self-referral: same partner user id cannot be referred by its own link
 const partnerUser = db().prepare('SELECT id FROM users WHERE username=?').get('pt_sara');
 const {attributeRegistration} = await import('../src/partners/referrals.js');
 db().prepare('DELETE FROM referrals WHERE referred_user_id=?').run(partnerUser.id);
 const visit = db().prepare('SELECT * FROM referral_visits ORDER BY first_seen_at DESC LIMIT 1').get();
 const r = attributeRegistration(db(), ENV, {userId: partnerUser.id, email: 'sara@example.com', visitorId: visit.visitor_id, ip: '1.1.1.1'});
 assert.equal(r.status, 'rejected');
 assert.equal(r.reject_reason, 'self_referral');
 // expired window: visit older than attribution_window_days is ignored
 db().prepare("UPDATE referral_visits SET last_seen_at='2020-01-01T00:00:00.000Z' WHERE visitor_id=?").run(visit.visitor_id);
 const ghost = await signup('pt_late', 'late@example.com', {cookie: `frost_ref=${visit.visitor_id}`});
 assert.equal(db().prepare('SELECT COUNT(*) n FROM referrals WHERE referred_user_id=?').get(ghost.userId).n, 0);
});

test('payment webhook -> pending commission (idempotent) -> review -> available', async () => {
 await call('/api/partners/admin/settings', {method: 'PUT', body: {commission_hold_days: 0, min_payout_minor: 1000}, session: state.admin});
 assert.equal((await webhook({id: 'p1', type: 'payment_succeeded', customer: {email: 'x@none.example'}, amountMinor: 5000, currency: 'SAR', occurredAt: new Date().toISOString()})).data.result, 'customer_unknown');
 // bad signature
 assert.equal((await call('/api/webhooks/partner-billing', {raw: '{}', headers: {'content-type': 'application/json', 'x-frost-signature': 'sha256=' + '0'.repeat(64)}})).status, 401);
 assert.equal((await call('/api/webhooks/partner-billing', {raw: '{}', headers: {'content-type': 'application/json'}})).status, 401);

 const payment = {id: 'pay_1001', type: 'payment_succeeded', customer: {email: 'cust1@example.com'}, planRef: 'pro-monthly', amountMinor: 10000, currency: 'SAR', occurredAt: new Date().toISOString()};
 const first = await webhook(payment);
 assert.equal(first.status, 200);
 assert.equal(first.data.result, 'commission_created');
 const dup = await webhook(payment);
 assert.equal(dup.data.duplicate, true);
 assert.equal(db().prepare('SELECT COUNT(*) n FROM commissions').get().n, 1, 'a replayed webhook never pays twice');
 const commission = db().prepare('SELECT * FROM commissions').get();
 assert.equal(commission.commission_minor, 2500, '25.00% of 100.00');
 assert.equal(commission.commission_rate_bps, 2500);
 assert.equal(commission.status, 'pending', 'manual review by default');
 assert.equal(ledgerSum(state.saraProfile.id, 'pending'), 2500);
 assert.equal(db().prepare('SELECT status FROM referrals WHERE referred_user_id=?').get(state.cust.userId).status, 'converted');

 const view = await call('/api/partners/commissions', {session: state.sara});
 assert.equal(view.data.items[0].status, 'pending');
 assert.equal(view.data.balances.pendingMinor, 2500);
 assert.equal(view.data.balances.withdrawableMinor, 0);

 // rejecting needs a reason; approval with a zero-day hold makes it available immediately
 assert.equal((await call(`/api/partners/admin/commissions/${commission.id}/decision`, {body: {action: 'reject'}, session: state.admin})).status, 400);
 const approve = await call(`/api/partners/admin/commissions/${commission.id}/decision`, {body: {action: 'approve'}, session: state.admin});
 assert.equal(approve.data.status, 'available');
 const bal = (await call('/api/partners/commissions', {session: state.sara})).data.balances;
 assert.equal(bal.pendingMinor, 0);
 assert.equal(bal.withdrawableMinor, 2500);
 // partners cannot approve their own commission
 assert.equal((await call(`/api/partners/admin/commissions/${commission.id}/decision`, {body: {action: 'approve'}, session: state.sara})).status, 403);
 state.commissionId = commission.id;
});

test('payout methods are encrypted+masked; request reserves the balance; lifecycle to paid; receipt upload', async () => {
 const add = await call('/api/partners/payout-methods', {body: {type: 'bank_transfer', label: 'Main', details: {accountName: 'Sara P', iban: 'SA0380000000608010167519', bankName: 'Bank'}}, session: state.sara});
 assert.equal(add.status, 201, JSON.stringify(add.data));
 assert.equal(add.data.masked, 'Bank •••• 7519');
 assert.ok(!JSON.stringify(add.data).includes('SA0380000000608010167519'));
 const stored = db().prepare('SELECT details_encrypted FROM payout_methods').get().details_encrypted;
 assert.ok(!stored.includes('SA03') && !stored.includes('Sara'), 'details are ciphertext at rest');
 assert.ok(!JSON.stringify((await call('/api/partners/payout-methods', {session: state.sara})).data).includes('SA0380000000608010167519'));
 assert.equal((await call('/api/partners/payout-methods', {body: {type: 'bank_transfer', label: 'Bad', details: {accountName: 'x', iban: '123'}}, session: state.sara})).status, 400);
 state.methodId = add.data.id;

 // minimum + verified email + ownership
 assert.equal((await call('/api/partners/payouts', {body: {methodId: state.methodId, amount: '1000.00'}, session: state.sara})).data.error, 'INSUFFICIENT_BALANCE');
 const req = await call('/api/partners/payouts', {body: {methodId: state.methodId}, session: state.sara});
 assert.equal(req.status, 201, JSON.stringify(req.data));
 assert.equal(req.data.amountMinor, 2500);
 assert.equal(req.data.status, 'requested');
 assert.equal(ledgerSum(state.saraProfile.id, 'reserved'), 2500);
 assert.equal(ledgerSum(state.saraProfile.id, 'available'), 0);
 assert.equal((await call('/api/partners/payouts', {body: {methodId: state.methodId}, session: state.sara})).status, 409, 'only one open payout at a time');
 state.payoutId = req.data.id;

 // another partner cannot see/cancel/download it (no IDOR)
 const reg = await registerPartner('pt_ben', 'ben@example.com', {fullName: 'Ben'});
 state.ben = {cookie: reg.cookie, csrf: reg.csrf, userId: reg.data.user.id};
 const benApp = reg.data.application.id;
 await call(`/api/partners/admin/applications/${benApp}/decision`, {body: {decision: 'approve', planId: planId('starter')}, session: state.admin});
 assert.equal((await call(`/api/partners/payouts/${state.payoutId}/cancel`, {body: {}, session: state.ben})).status, 404);
 assert.equal((await call(`/api/partners/payouts/${state.payoutId}/receipt`, {session: state.ben})).status, 404);
 assert.equal((await call('/api/partners/payouts', {session: state.ben})).data.total, 0);

 // staff-only lifecycle
 const D = (action, extra = {}) => call(`/api/partners/admin/payouts/${state.payoutId}/decision`, {body: {action, ...extra}, session: state.admin});
 assert.equal((await call(`/api/partners/admin/payouts/${state.payoutId}/decision`, {body: {action: 'pay', paymentReference: 'X'}, session: state.sara})).status, 403);
 assert.equal((await D('pay', {paymentReference: 'too-early'})).status, 409, 'cannot pay a merely requested payout');
 assert.equal((await D('under_review')).data.status, 'under_review');
 assert.equal((await D('approve')).data.status, 'approved');
 assert.equal((await D('processing')).data.status, 'processing');
 assert.equal((await D('pay')).status, 400, 'a payment reference is required');
 const details = await call(`/api/partners/admin/payouts/${state.payoutId}/details`, {session: state.admin});
 assert.equal(details.data.details.iban, 'SA0380000000608010167519', 'staff can read the destination to send money');
 assert.ok(db().prepare("SELECT 1 FROM partner_audit_logs WHERE action='PAYOUT_DETAILS_VIEWED'").get(), 'every reveal is audited');
 const paid = await D('pay', {paymentReference: 'BANK-REF-77'});
 assert.equal(paid.data.status, 'paid');
 assert.equal(paid.data.paymentReference, 'BANK-REF-77');
 assert.equal((await D('reject', {reason: 'x'})).status, 409, 'a paid payout is final');

 const pdf = Buffer.from('%PDF-1.4 receipt');
 assert.equal((await call(`/api/partners/admin/payouts/${state.payoutId}/receipt`, {method: 'PUT', raw: Buffer.from('not a pdf'), headers: {'content-type': 'application/pdf'}, session: state.admin})).status, 400, 'magic bytes are verified');
 assert.equal((await call(`/api/partners/admin/payouts/${state.payoutId}/receipt`, {method: 'PUT', raw: pdf, headers: {'content-type': 'application/pdf', 'x-file-name': 'receipt.pdf'}, session: state.admin})).status, 200);
 const dl = await call(`/api/partners/payouts/${state.payoutId}/receipt`, {session: state.sara});
 assert.equal(dl.status, 200);
 assert.equal(dl.res.headers.get('content-type'), 'application/pdf');

 assert.equal(ledgerSum(state.saraProfile.id, 'reserved'), 0);
 assert.equal(ledgerSum(state.saraProfile.id, 'paid'), 2500);
 assert.equal(db().prepare('SELECT status FROM commissions WHERE id=?').get(state.commissionId).status, 'paid');
});

test('refund after payout claws back from future earnings; ledger is append-only', async () => {
 const refund = await webhook({id: 'ref_1001', type: 'refund', refersTo: 'pay_1001', customer: {email: 'cust1@example.com'}, amountMinor: 10000, currency: 'SAR', occurredAt: new Date().toISOString()});
 assert.equal(refund.data.result, 'reversal_applied');
 assert.equal(ledgerSum(state.saraProfile.id, 'available'), -2500);
 assert.equal(db().prepare('SELECT status FROM commissions WHERE id=?').get(state.commissionId).status, 'cancelled');
 const bal = (await call('/api/partners/commissions', {session: state.sara})).data.balances;
 assert.equal(bal.withdrawableMinor, 0, 'a negative balance is never withdrawable');
 assert.equal(bal.paidMinor, 2500, 'history of what was paid is preserved');
 assert.throws(() => db().prepare("UPDATE commission_ledger SET amount_minor=1").run(), /append-only/);
 assert.throws(() => db().prepare('DELETE FROM commission_ledger').run(), /append-only/);
 assert.throws(() => db().prepare("UPDATE partner_audit_logs SET action='x'").run(), /append-only/);
 // replay of the refund does nothing
 assert.equal((await webhook({id: 'ref_1001', type: 'refund', refersTo: 'pay_1001', customer: {email: 'cust1@example.com'}, amountMinor: 10000, currency: 'SAR', occurredAt: new Date().toISOString()})).data.duplicate, true);
 assert.equal(ledgerSum(state.saraProfile.id, 'available'), -2500);
});

test('plan entitlements are enforced on the server; expired plan -> limited (data kept); suspension blocks', async () => {
 // Ben is on Starter: marketing assets are locked, core pages work
 assert.equal((await call('/api/partners/assets', {session: state.ben})).data.error, 'ENTITLEMENT_REQUIRED');
 assert.equal((await call('/api/partners/dashboard', {session: state.ben})).status, 200);
 assert.equal((await call('/api/partners/export/commissions.csv', {session: state.ben})).status, 403);
 // Sara (Professional) can read assets
 const asset = await call('/api/partners/admin/assets', {body: {category: 'copy', kind: 'text', titleAr: 'نص', titleEn: 'Pitch', textEn: 'Try Frost'}, session: state.admin});
 assert.equal(asset.status, 201);
 assert.equal((await call('/api/partners/assets', {session: state.sara})).data.items.length, 1);
 assert.equal((await call('/api/partners/export/commissions.csv', {session: state.sara})).status, 200);

 // Expire Sara's paid period
 db().prepare("UPDATE partner_subscriptions SET ends_at='2020-01-01T00:00:00.000Z' WHERE partner_id=? AND status='active'").run(state.saraProfile.id);
 const me = await call('/api/partners/me', {session: state.sara});
 assert.equal(me.data.partner.status, 'limited');
 assert.equal(me.data.partner.planExpired, true);
 assert.equal((await call('/api/partners/assets', {session: state.sara})).data.error, 'PLAN_EXPIRED');
 assert.equal((await call('/api/partners/dashboard', {session: state.sara})).status, 200, 'basics stay readable');
 assert.equal((await call('/api/partners/commissions', {session: state.sara})).data.total, 1, 'earned data is preserved');
 assert.equal((await call('/api/partners/links', {session: state.sara})).data.error, 'PLAN_EXPIRED');
 // renewing restores everything
 const renew = await call(`/api/partners/admin/partners/${state.saraProfile.id}/plan`, {body: {planId: planId('professional'), endsAt: new Date(Date.now() + 30 * 86400000).toISOString()}, session: state.admin});
 assert.equal(renew.status, 200);
 assert.equal((await call('/api/partners/assets', {session: state.sara})).status, 200);

 // Suspension: everything but /me is blocked, links stop tracking, money records are kept
 const susp = await call(`/api/partners/admin/partners/${state.saraProfile.id}`, {method: 'PATCH', body: {status: 'suspended'}, session: state.admin});
 assert.equal(susp.status, 400, 'a reason is required to suspend');
 assert.equal((await call(`/api/partners/admin/partners/${state.saraProfile.id}`, {method: 'PATCH', body: {status: 'suspended', reason: 'policy'}, session: state.admin})).status, 200);
 assert.equal((await call('/api/partners/dashboard', {session: state.sara})).data.error, 'PARTNER_SUSPENDED');
 assert.equal((await call('/api/partners/me', {session: state.sara})).data.partner.status, 'suspended');
 const before = db().prepare('SELECT COUNT(*) n FROM referral_visits').get().n;
 await call(`/r/${state.saraProfile.referralCode}`, {redirect: 'manual', headers: {'user-agent': 'z'}});
 assert.equal(db().prepare('SELECT COUNT(*) n FROM referral_visits').get().n, before, 'a suspended partner earns no new clicks');
 assert.equal(db().prepare('SELECT COUNT(*) n FROM commissions').get().n, 1, 'financial records are never deleted');
 assert.equal((await call(`/api/partners/admin/partners/${state.saraProfile.id}`, {method: 'PATCH', body: {status: 'active'}, session: state.admin})).status, 200);
 assert.equal((await call('/api/partners/dashboard', {session: state.sara})).status, 200);
});

test('CSRF is required on writes; partner id can never be supplied by the client', async () => {
 const noCsrf = await fetch(`${base}/api/partners/links`, {method: 'POST', headers: {'Content-Type': 'application/json', cookie: state.sara.cookie}, body: JSON.stringify({label: 'x'})});
 assert.equal(noCsrf.status, 403);
 // a body-supplied partnerId is ignored: the link is created for the session's partner
 const link = await call('/api/partners/links', {body: {label: 'Campaign', partnerId: state.ben.userId, utmSource: 'ig'}, session: state.sara});
 assert.equal(link.status, 201);
 assert.equal(db().prepare('SELECT partner_id FROM referral_links WHERE id=?').get(link.data.id).partner_id, state.saraProfile.id);
 // Ben cannot edit Sara's link
 assert.equal((await call(`/api/partners/links/${link.data.id}`, {method: 'PATCH', body: {label: 'hijack'}, session: state.ben})).status, 404);
 // invalid UTM / landing path is rejected (no open redirect)
 assert.equal((await call('/api/partners/links', {body: {label: 'bad', landingPath: 'https://evil.example'}, session: state.sara})).status, 400);
 assert.equal((await call('/api/partners/links', {body: {label: 'bad', utmSource: '<script>'}, session: state.sara})).status, 400);
});

test('invite-only mode blocks uninvited registration; an invite works once', async () => {
 await call('/api/partners/admin/settings', {method: 'PUT', body: {registration_mode: 'invite_only'}, session: state.admin});
 assert.equal((await registerPartner('pt_nope', 'nope@example.com')).status, 403);
 assert.equal(db().prepare("SELECT COUNT(*) n FROM users WHERE username='pt_nope'").get().n, 0, 'no orphan account is left behind');
 const invite = await call('/api/partners/admin/invites', {body: {planId: planId('starter')}, session: state.admin});
 assert.equal(invite.status, 201);
 const ok = await registerPartner('pt_invited', 'invited@example.com', {inviteCode: invite.data.code});
 assert.equal(ok.status, 201, JSON.stringify(ok.data));
 assert.equal((await registerPartner('pt_again', 'again@example.com', {inviteCode: invite.data.code})).status, 403, 'an invite is single-use');
 await call('/api/partners/admin/settings', {method: 'PUT', body: {registration_mode: 'open'}, session: state.admin});
});

test('manager permissions are scoped; audit log records staff actions', async () => {
 const mgr = await signup('pt_mgr', 'mgr@example.com');
 const set = await call('/api/partners/admin/staff', {method: 'PUT', body: {identity: 'pt_mgr', permissions: ['applications']}, session: state.admin});
 assert.equal(set.status, 200);
 assert.equal((await call('/api/partners/admin/applications', {session: mgr})).status, 200);
 assert.equal((await call('/api/partners/admin/payouts', {session: mgr})).status, 403, 'no payouts permission');
 assert.equal((await call('/api/partners/admin/settings', {session: mgr})).status, 403);
 assert.equal((await call('/api/partners/admin/staff', {session: mgr})).status, 403);
 assert.equal((await call('/api/partners/admin/overview', {session: mgr})).status, 200);
 assert.equal((await call('/api/partners/admin/staff', {method: 'PUT', body: {identity: 'pt_ben', permissions: ['payouts']}, session: mgr})).status, 403, 'a manager cannot grant permissions');
 const audit = await call('/api/partners/admin/audit', {session: state.admin});
 assert.ok(audit.data.items.some(i => i.action === 'PARTNER_APPLICATION_APPROVE'));
 assert.ok(audit.data.items.some(i => i.action === 'PAYOUT_PAY'));
});
