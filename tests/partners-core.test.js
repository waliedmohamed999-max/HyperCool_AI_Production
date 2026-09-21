import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {computeCommission, toMinor, toBps, saveSettings, getSettings} from '../src/partners/core.js';
import {installPartners, uninstallPartners, PARTNER_TABLES} from '../src/partners/schema.js';
import {installPartnerProgram} from '../src/partners/index.js';
import {ensurePartnerMailKind} from '../src/partners/mail.js';
import {submitApplication, decide} from '../src/partners/applications.js';
import {createPlan, effectivePartnerState, entitlementsFor} from '../src/partners/plans.js';
import {attributeRegistration, trackClick} from '../src/partners/referrals.js';
import {recordBillingEvent, balances, decideCommission, releaseDueCommissions} from '../src/partners/commissions.js';
import {requestPayout, addMethod, decidePayout} from '../src/partners/payouts.js';
import {setPartnerStatus, assignPlan, sweepSubscriptions} from '../src/partners/partners.js';

// Domain-level tests: money math, schema lifecycle and the ledger invariants, without HTTP.
const ENV = {INTEGRATION_ENCRYPTION_KEY: 'ef'.repeat(32)};
const ADMIN = {id: 'admin-1', name: 'Admin', role: 'admin'};

function freshDb() {
 const db = new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON');
 db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, name TEXT, email TEXT, email_verified_at TEXT, preferred_locale TEXT)");
 db.exec(`CREATE TABLE platform_mail_outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('VERIFY_EMAIL','PASSWORD_RESET','INVITATION','SECURITY_NOTICE')), to_email TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('SENT','FAILED')), sent_at TEXT, last_send_error_code TEXT, captured_body TEXT, created_at TEXT NOT NULL)`);
 return db;
}
let seq = 0;
function addUser(db, {email = null, verified = true} = {}) {
 const id = `u${++seq}`;
 db.prepare('INSERT INTO users (id,username,name,email,email_verified_at) VALUES (?,?,?,?,?)').run(id, `user${seq}`, `User ${seq}`, email || `user${seq}@x.test`, verified ? '2026-01-01T00:00:00.000Z' : null);
 return {id, name: `User ${seq}`, email: email || `user${seq}@x.test`};
}
const APP = {fullName: 'Partner One', email: 'p@x.test', phone: '+966500000000', country: 'SA', partnerType: 'affiliate', marketingMethod: 'newsletter and social posts', expectedCustomers: 5, acceptTerms: true};
function setupPartner(db, {holdDays = 0, review = 'auto', plan = 'starter'} = {}) {
 installPartnerProgram(db);
 saveSettings(db, ADMIN, {commission_hold_days: holdDays, commission_review: review, min_payout_minor: 100});
 const user = addUser(db);
 const planId = db.prepare('SELECT id FROM partner_plans WHERE slug=?').get(plan).id;
 const {application} = submitApplication(db, ENV, user, {...APP, email: user.email});
 decide(db, ADMIN, application.id, {decision: 'approve', planId});
 const profile = db.prepare('SELECT * FROM partner_profiles WHERE user_id=?').get(user.id);
 return {user, profile};
}
function referCustomer(db, profile, {email} = {}) {
 const click = trackClick(db, {code: profile.referral_code, ip: '9.9.9.9', userAgent: 'ua', visitorId: null, query: {}});
 const customer = addUser(db, {email});
 const ref = attributeRegistration(db, ENV, {userId: customer.id, email: customer.email, visitorId: click.visitorId, ip: '9.9.9.9'});
 assert.equal(ref.status, 'registered');
 return {customer, ref};
}
let evt = 0;
const pay = (db, customer, amountMinor, extra = {}) => recordBillingEvent(db, ENV, ADMIN, 'manual', {externalId: `e${++evt}`, type: 'payment_succeeded', customerUserId: customer.id, amountMinor, currency: 'SAR', occurredAt: new Date().toISOString(), ...extra});
const sum = (db, partnerId, bucket) => db.prepare('SELECT COALESCE(SUM(amount_minor),0) v FROM commission_ledger WHERE partner_id=? AND bucket=?').get(partnerId, bucket).v;

test('money math is integer-only and half-up', () => {
 assert.equal(computeCommission(1, 5000), 1, '0.5 rounds up');
 assert.equal(computeCommission(333, 2500), 83, '83.25 -> 83');
 assert.equal(computeCommission(335, 2500), 84, '83.75 -> 84');
 assert.equal(computeCommission(10001, 3333), 3333);
 assert.equal(computeCommission(0, 2500), 0);
 assert.equal(computeCommission(10000, 10000), 10000);
 assert.throws(() => computeCommission(-1, 100));
 assert.throws(() => computeCommission(1.5, 100));
 assert.throws(() => computeCommission(100, 10001));
 assert.equal(toMinor('120.5'), 12050);
 assert.equal(toMinor('0.07'), 7);
 assert.equal(toMinor(19.99), 1999, 'no float drift');
 assert.throws(() => toMinor('1.234'));
 assert.throws(() => toMinor('-1'));
 assert.throws(() => toMinor('abc'));
 assert.equal(toBps('12.5'), 1250);
 assert.equal(toBps('100'), 10000);
 assert.throws(() => toBps('100.01'));
 assert.throws(() => toBps('-1'));
});

test('schema install is idempotent and the down-migration removes only partner tables', () => {
 const db = freshDb();
 installPartners(db); installPartners(db);
 const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
 for (const t of PARTNER_TABLES) assert.ok(tables().includes(t), `${t} exists`);
 uninstallPartners(db);
 for (const t of PARTNER_TABLES) assert.ok(!tables().includes(t), `${t} dropped`);
 assert.ok(tables().includes('users') && tables().includes('platform_mail_outbox'), 'foreign tables untouched');
 installPartners(db); // and can be re-applied afterwards
 assert.ok(tables().includes('commission_ledger'));
});

test('the mail outbox migration keeps existing rows and accepts the partner kind', () => {
 const db = freshDb();
 db.prepare("INSERT INTO platform_mail_outbox VALUES ('m1','VERIFY_EMAIL','a@x.test','s','SENT',NULL,NULL,'{}','2026-01-01')").run();
 assert.throws(() => db.prepare("INSERT INTO platform_mail_outbox VALUES ('m2','PARTNER_NOTICE','a@x.test','s','SENT',NULL,NULL,'{}','2026-01-01')").run());
 assert.equal(ensurePartnerMailKind(db), true);
 assert.equal(ensurePartnerMailKind(db), false, 'second run is a no-op');
 db.prepare("INSERT INTO platform_mail_outbox VALUES ('m2','PARTNER_NOTICE','a@x.test','s','SENT',NULL,NULL,'{}','2026-01-01')").run();
 assert.equal(db.prepare('SELECT COUNT(*) n FROM platform_mail_outbox').get().n, 2);
});

test('partial refunds reverse proportionally; a full refund cancels; replays and over-refunds are safe', () => {
 const db = freshDb();
 const {profile} = setupPartner(db); // starter = 20%
 const {customer} = referCustomer(db, profile);
 const first = pay(db, customer, 10000, {externalId: 'pay-A'});
 assert.equal(first.commission.commission_minor, 2000);
 assert.equal(first.commission.status, 'available', 'auto review + zero-day hold releases immediately');
 releaseDueCommissions(db); // hold 0 -> available
 assert.equal(balances(db, profile.id).availableMinor, 2000);

 const partial = recordBillingEvent(db, ENV, ADMIN, 'manual', {externalId: 'ref-1', type: 'refund', refersToExternalId: 'pay-A', customerUserId: customer.id, amountMinor: 4000, currency: 'SAR', occurredAt: new Date().toISOString()});
 assert.equal(partial.event.result, 'reversal_applied');
 assert.equal(balances(db, profile.id).availableMinor, 1200, '40% of 20.00 reversed = 8.00');
 assert.equal(db.prepare('SELECT status FROM commissions').get().status, 'available', 'still owed in part');

 const again = recordBillingEvent(db, ENV, ADMIN, 'manual', {externalId: 'ref-1', type: 'refund', refersToExternalId: 'pay-A', customerUserId: customer.id, amountMinor: 4000, currency: 'SAR', occurredAt: new Date().toISOString()});
 assert.equal(again.duplicate, true);
 assert.equal(balances(db, profile.id).availableMinor, 1200);

 const rest = recordBillingEvent(db, ENV, ADMIN, 'manual', {externalId: 'ref-2', type: 'refund', refersToExternalId: 'pay-A', customerUserId: customer.id, amountMinor: 999999, currency: 'SAR', occurredAt: new Date().toISOString()});
 assert.equal(rest.event.result, 'reversal_applied');
 assert.equal(balances(db, profile.id).availableMinor, 0, 'an over-refund is capped at what remains');
 assert.equal(db.prepare('SELECT status FROM commissions').get().status, 'cancelled');
 const late = recordBillingEvent(db, ENV, ADMIN, 'manual', {externalId: 'ref-3', type: 'refund', refersToExternalId: 'pay-A', customerUserId: customer.id, amountMinor: 100, currency: 'SAR', occurredAt: new Date().toISOString()});
 assert.equal(late.event.result, 'already_reversed');
 assert.equal(balances(db, profile.id).availableMinor, 0);
 assert.equal(sum(db, profile.id, 'pending'), 0);
});

test('accrual rules: unknown customer, non-referred, currency, window, suspended partner, failed payment', () => {
 const db = freshDb();
 const {profile} = setupPartner(db);
 const {customer} = referCustomer(db, profile);
 const stranger = addUser(db);
 assert.equal(pay(db, stranger, 5000).event.result, 'no_referral');
 assert.equal(recordBillingEvent(db, ENV, ADMIN, 'manual', {externalId: 'x1', type: 'payment_succeeded', customerEmail: 'nobody@x.test', amountMinor: 5000, currency: 'SAR', occurredAt: new Date().toISOString()}).event.result, 'customer_unknown');
 assert.equal(pay(db, customer, 5000, {currency: 'USD'}).event.result, 'currency_mismatch');
 assert.equal(pay(db, customer, 0).event.result, 'zero_amount');
 assert.equal(pay(db, customer, 5000, {occurredAt: new Date(Date.now() + 3600000).toISOString()}).event.result, 'commission_created', 'a small clock skew is tolerated');
 // window: payment long after registration
 db.prepare("UPDATE referrals SET registered_at='2020-01-01T00:00:00.000Z'").run();
 assert.equal(pay(db, customer, 5000).event.result, 'window_expired');
 db.prepare('UPDATE referrals SET registered_at=?').run(new Date().toISOString());
 // failed payment without a reference records nothing
 assert.equal(recordBillingEvent(db, ENV, ADMIN, 'manual', {externalId: 'f1', type: 'payment_failed', customerUserId: customer.id, amountMinor: 5000, currency: 'SAR', occurredAt: new Date().toISOString()}).event.result, 'recorded_no_commission');
 // suspended partner earns nothing new but keeps history
 const before = db.prepare('SELECT COUNT(*) n FROM commissions').get().n;
 setPartnerStatus(db, ADMIN, profile.id, 'suspended', 'test');
 assert.equal(pay(db, customer, 5000).event.result, 'partner_inactive');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM commissions').get().n, before);
 assert.throws(() => setPartnerStatus(db, ADMIN, profile.id, 'closed'), /reason/);
 assert.equal(db.prepare('SELECT status FROM referral_links WHERE partner_id=?').get(profile.id).status, 'disabled');
});

test('manual review, hold period, reject/hold transitions keep the buckets consistent', () => {
 const db = freshDb();
 const {profile} = setupPartner(db, {holdDays: 10, review: 'manual'});
 const {customer} = referCustomer(db, profile);
 const c = pay(db, customer, 10000).commission;
 assert.equal(c.status, 'pending');
 assert.equal(sum(db, profile.id, 'pending'), 2000);
 decideCommission(db, ADMIN, c.id, 'hold');
 assert.equal(db.prepare('SELECT status FROM commissions WHERE id=?').get(c.id).status, 'on_hold');
 assert.throws(() => decideCommission(db, ADMIN, c.id, 'approve'), /pending/);
 decideCommission(db, ADMIN, c.id, 'release_hold');
 assert.equal(decideCommission(db, ADMIN, c.id, 'approve').status, 'approved', 'approved but still inside the 10-day hold');
 assert.equal(releaseDueCommissions(db), 0);
 assert.equal(sum(db, profile.id, 'available'), 0);
 assert.equal(releaseDueCommissions(db, Date.now() + 11 * 86400000), 1);
 assert.equal(sum(db, profile.id, 'pending'), 0);
 assert.equal(sum(db, profile.id, 'available'), 2000);
 assert.equal(releaseDueCommissions(db, Date.now() + 12 * 86400000), 0, 'idempotent');

 const second = pay(db, customer, 5000).commission;
 assert.throws(() => decideCommission(db, ADMIN, second.id, 'reject'), /reason/);
 decideCommission(db, ADMIN, second.id, 'reject', 'invalid');
 assert.equal(sum(db, profile.id, 'pending'), 0, 'a rejected commission leaves the pending bucket');
});

test('payouts: reserve, reject returns the money, paid moves it to the paid bucket, minimums enforced', () => {
 const db = freshDb();
 const {user, profile} = setupPartner(db);
 const {customer} = referCustomer(db, profile);
 pay(db, customer, 10000); releaseDueCommissions(db);
 const method = addMethod(db, ENV, profile, {type: 'paypal', details: {email: 'p@paypal.test'}});
 assert.equal(method.masked, 'p***@p***');
 saveSettings(db, ADMIN, {min_payout_minor: 5000});
 assert.throws(() => requestPayout(db, ENV, profile, user, {methodId: method.id}), /BELOW_MINIMUM/);
 saveSettings(db, ADMIN, {min_payout_minor: 100});
 const req = requestPayout(db, ENV, profile, user, {methodId: method.id});
 assert.equal(req.amountMinor, 2000);
 assert.equal(sum(db, profile.id, 'reserved'), 2000);
 assert.equal(balances(db, profile.id).withdrawableMinor, 0);
 decidePayout(db, ADMIN, req.id, 'reject', {reason: 'bad details'});
 assert.equal(sum(db, profile.id, 'reserved'), 0);
 assert.equal(balances(db, profile.id).withdrawableMinor, 2000, 'rejection returns the funds');
 const again = requestPayout(db, ENV, profile, user, {methodId: method.id});
 decidePayout(db, ADMIN, again.id, 'approve');
 decidePayout(db, ADMIN, again.id, 'pay', {paymentReference: 'R-1'});
 assert.equal(sum(db, profile.id, 'paid'), 2000);
 assert.equal(sum(db, profile.id, 'reserved'), 0);
 assert.throws(() => decidePayout(db, ADMIN, again.id, 'reject', {reason: 'x'}), /paid/);
 assert.throws(() => requestPayout(db, {}, profile, user, {methodId: method.id}), /./, 'nothing left / encryption absent');
});

test('plan expiry limits entitlements without touching data; renewal restores them', () => {
 const db = freshDb();
 const {profile} = setupPartner(db, {plan: 'professional'});
 assert.ok(entitlementsFor(db, profile).includes('partner.marketing_assets'));
 db.prepare("UPDATE partner_subscriptions SET ends_at='2020-01-01T00:00:00.000Z' WHERE partner_id=?").run(profile.id);
 const state = effectivePartnerState(db, profile);
 assert.equal(state.status, 'limited');
 const ents = entitlementsFor(db, profile);
 assert.ok(!ents.includes('partner.marketing_assets') && ents.includes('partner.commissions'));
 assert.deepEqual(sweepSubscriptions(db), {expired: 1, warned: 0});
 assert.equal(db.prepare("SELECT status FROM partner_subscriptions WHERE partner_id=?").get(profile.id).status, 'expired');
 assignPlan(db, ADMIN, profile, profile.plan_id, {endsAt: new Date(Date.now() + 30 * 86400000).toISOString()});
 assert.equal(effectivePartnerState(db, db.prepare('SELECT * FROM partner_profiles WHERE id=?').get(profile.id)).status, 'active');
 assert.ok(entitlementsFor(db, profile).includes('partner.marketing_assets'));
});

test('plans validate their input and unknown entitlements are rejected', () => {
 const db = freshDb();
 installPartnerProgram(db);
 assert.throws(() => createPlan(db, ADMIN, {slug: 'Bad Slug', nameAr: 'x', nameEn: 'x', priceMinor: 0, defaultCommissionBps: 100}), /slug/);
 assert.throws(() => createPlan(db, ADMIN, {slug: 'ok-plan', nameAr: 'x', nameEn: 'x', priceMinor: 0, defaultCommissionBps: 20000}));
 assert.throws(() => createPlan(db, ADMIN, {slug: 'ok-plan', nameAr: 'x', nameEn: 'x', priceMinor: 0, defaultCommissionBps: 100, entitlements: ['partner.fly']}), /entitlements/);
 assert.throws(() => createPlan(db, ADMIN, {slug: 'starter', nameAr: 'x', nameEn: 'x', priceMinor: 0, defaultCommissionBps: 100}), /slug already used/);
 assert.throws(() => saveSettings(db, ADMIN, {attribution_window_days: 0}), /invalid/);
 assert.throws(() => saveSettings(db, ADMIN, {nonsense: 1}), /unknown setting/);
 assert.equal(getSettings(db).attribution_window_days, 30);
});
