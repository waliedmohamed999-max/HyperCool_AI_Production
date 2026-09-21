import {createHmac, timingSafeEqual} from 'node:crypto';
import {fail} from '../auth.js';
import {assertCurrency, audit, clean, computeCommission, getSettings, newId, notifyStaff, notifyUser, now, pageParams, paged, tx} from './core.js';
import {effectivePartnerState, getPlanOrNull} from './plans.js';

// Commission engine. Every movement of money is an append-only commission_ledger row written in the
// same transaction as the state change it explains; balances are ALWAYS derived from the ledger
// (SUM by bucket) - there is no balance column anywhere that code could edit directly.
//
// Buckets:  pending -> available -> reserved -> paid
//   pending   accrued but not yet withdrawable (awaiting review and/or hold period)
//   available approved and past its hold period; withdrawable (never below 0 for a payout)
//   reserved  locked by an open payout request
//   paid      handed to the partner
// Refunds after a commission has become available/paid become a negative `available` entry (clawback)
// so the partner's future earnings absorb it instead of history being rewritten.

const DAY = 86400000;
const OPEN_STATUSES = ['pending', 'on_hold', 'approved'];

export function postLedger(db, {partnerId, commissionId = null, payoutId = null, type, bucket, amount, currency, memo = null, actor = null}) {
 if (!Number.isSafeInteger(amount) || amount === 0) throw new Error('ledger amount must be a non-zero integer');
 db.prepare('INSERT INTO commission_ledger (id,partner_id,commission_id,payout_id,entry_type,bucket,amount_minor,currency,memo,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  .run(newId(), partnerId, commissionId, payoutId, type, bucket, amount, currency, memo, actor?.id || null, now());
}
export function balances(db, partnerId) {
 const out = {pendingMinor: 0, availableMinor: 0, reservedMinor: 0, paidMinor: 0};
 for (const r of db.prepare('SELECT bucket, COALESCE(SUM(amount_minor),0) v FROM commission_ledger WHERE partner_id=? GROUP BY bucket').all(partnerId)) out[`${r.bucket}Minor`] = r.v;
 out.withdrawableMinor = Math.max(0, out.availableMinor);
 return out;
}
const reversedMinor = (db, commissionId) => -db.prepare("SELECT COALESCE(SUM(amount_minor),0) v FROM commission_ledger WHERE commission_id=? AND entry_type IN ('reversal','clawback')").get(commissionId).v;
export const netMinor = (db, commission) => commission.commission_minor - reversedMinor(db, commission.id);

// ---- billing events (the ONLY way a payment becomes a commission) -----------------------------------
export function verifyBillingSignature(rawBody, header, secret) {
 if (!secret || typeof header !== 'string') return false;
 const match = /^sha256=([a-f0-9]{64})$/i.exec(header.trim());
 if (!match) return false;
 const expected = createHmac('sha256', secret).update(rawBody).digest();
 const given = Buffer.from(match[1], 'hex');
 return given.length === expected.length && timingSafeEqual(given, expected);
}

function validateEvent(input) {
 if (typeof input.externalId !== 'string' || !/^[\w.:-]{1,120}$/.test(input.externalId)) fail(400, 'externalId is required (1-120 chars)');
 if (!['payment_succeeded', 'payment_failed', 'refund'].includes(input.type)) fail(400, 'type must be payment_succeeded, payment_failed or refund');
 if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) fail(400, 'amountMinor must be a non-negative integer');
 assertCurrency(input.currency);
 const at = Date.parse(input.occurredAt);
 if (!Number.isFinite(at)) fail(400, 'occurredAt must be an ISO date');
 if (at > Date.now() + DAY) fail(400, 'occurredAt is in the future');
 return {...input, occurredAt: new Date(at).toISOString()};
}

export function recordBillingEvent(db, env, actor, source, rawInput) {
 if (!['webhook', 'manual'].includes(source)) fail(400, 'invalid source');
 const input = validateEvent(rawInput);
 return tx(db, () => {
  const dup = db.prepare('SELECT * FROM billing_events WHERE source=? AND external_id=?').get(source, input.externalId);
  if (dup) return {duplicate: true, event: dup, commission: db.prepare('SELECT * FROM commissions WHERE billing_event_id=?').get(dup.id) || null};
  let customer = null;
  if (input.customerUserId) customer = db.prepare('SELECT id,email FROM users WHERE id=?').get(input.customerUserId);
  else if (input.customerEmail) customer = db.prepare('SELECT id,email FROM users WHERE email=?').get(String(input.customerEmail).trim().toLowerCase());
  const eventId = newId();
  db.prepare('INSERT INTO billing_events (id,source,external_id,type,customer_user_id,customer_email,plan_ref,amount_minor,currency,occurred_at,refers_to_event_id,result,raw_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(eventId, source, input.externalId, input.type, customer?.id || null, input.customerEmail ? String(input.customerEmail).slice(0, 254) : null, input.planRef ? String(input.planRef).slice(0, 80) : null, input.amountMinor, input.currency, input.occurredAt, null, 'processing', null, actor?.id || null, now());
  let result, commission = null;
  if (input.type === 'payment_succeeded') ({result, commission} = accrue(db, env, actor, eventId, customer, input));
  else ({result, commission} = reverseForEvent(db, actor, eventId, input));
  db.prepare('UPDATE billing_events SET result=? WHERE id=?').run(result, eventId);
  audit(db, {actor: actor || {id: null, role: 'webhook'}, action: 'BILLING_EVENT_RECORDED', entityType: 'billing_event', entityId: eventId, partnerId: commission?.partner_id || null, detail: {type: input.type, result, source}});
  return {duplicate: false, event: db.prepare('SELECT * FROM billing_events WHERE id=?').get(eventId), commission};
 });
}

function accrue(db, env, actor, eventId, customer, input) {
 if (!customer) return {result: 'customer_unknown'};
 const referral = db.prepare("SELECT * FROM referrals WHERE referred_user_id=? AND status IN ('registered','qualified','converted')").get(customer.id);
 if (!referral) return {result: 'no_referral'};
 const profile = db.prepare('SELECT * FROM partner_profiles WHERE id=?').get(referral.partner_id);
 if (!profile) return {result: 'no_referral'};
 const state = effectivePartnerState(db, profile, Date.parse(input.occurredAt));
 if (state.status === 'suspended' || state.status === 'closed') return {result: 'partner_inactive'};
 const settings = getSettings(db);
 if (input.currency !== settings.default_currency) return {result: 'currency_mismatch'};
 const plan = getPlanOrNull(db, profile.plan_id);
 const windowDays = plan?.commissionDurationDays ?? settings.conversion_window_days;
 if (Date.parse(input.occurredAt) > Date.parse(referral.registered_at) + windowDays * DAY) return {result: 'window_expired'};
 if (input.amountMinor <= 0) return {result: 'zero_amount'};
 const rate = profile.custom_commission_bps ?? plan?.defaultCommissionBps ?? 0;
 const amount = computeCommission(input.amountMinor, rate);
 if (amount <= 0) return {result: 'zero_commission'};
 const holdDays = plan?.commissionHoldDays ?? settings.commission_hold_days;
 const holdUntil = new Date(Date.parse(input.occurredAt) + holdDays * DAY).toISOString();
 const auto = settings.commission_review === 'auto';
 const id = newId(), t = now();
 db.prepare(`INSERT INTO commissions (id,partner_id,referral_id,customer_user_id,billing_event_id,gross_minor,commission_rate_bps,commission_minor,currency,status,hold_until,approved_at,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, profile.id, referral.id, customer.id, eventId, input.amountMinor, rate, amount, input.currency, auto ? 'approved' : 'pending', holdUntil, auto ? t : null, t, t);
 postLedger(db, {partnerId: profile.id, commissionId: id, type: 'accrual', bucket: 'pending', amount, currency: input.currency, memo: `payment ${input.externalId}`});
 if (referral.status !== 'converted') {
  db.prepare("UPDATE referrals SET status='converted',converted_at=?,qualified_at=COALESCE(qualified_at,?),updated_at=? WHERE id=?").run(t, t, t, referral.id);
 }
 notifyUser(db, profile.user_id, 'commission_earned', {commissionId: id, amountMinor: amount, currency: input.currency});
 if (!auto) notifyStaff(db, env, 'commissions', 'commission_needs_review', {commissionId: id});
 releaseIfDue(db, id, actor);
 return {result: 'commission_created', commission: db.prepare('SELECT * FROM commissions WHERE id=?').get(id)};
}

function reverseForEvent(db, actor, eventId, input) {
 if (input.type === 'payment_failed' && !input.refersToExternalId) return {result: 'recorded_no_commission'};
 if (!input.refersToExternalId) return {result: 'original_not_provided'};
 const original = db.prepare("SELECT * FROM billing_events WHERE external_id=? AND type='payment_succeeded' ORDER BY created_at LIMIT 1").get(input.refersToExternalId);
 if (!original) return {result: 'original_not_found'};
 db.prepare('UPDATE billing_events SET refers_to_event_id=? WHERE id=?').run(original.id, eventId);
 const commission = db.prepare('SELECT * FROM commissions WHERE billing_event_id=?').get(original.id);
 if (!commission) return {result: 'refund_no_commission'};
 if (commission.status === 'cancelled' || commission.status === 'rejected') return {result: 'already_reversed', commission};
 const remaining = netMinor(db, commission);
 const refundAmount = input.type === 'payment_failed' ? commission.gross_minor : Math.min(input.amountMinor, commission.gross_minor);
 const proportional = refundAmount >= commission.gross_minor ? remaining : Math.min(remaining, Math.floor((commission.commission_minor * refundAmount * 2 + commission.gross_minor) / (2 * commission.gross_minor)));
 if (proportional <= 0) return {result: 'refund_no_commission', commission};
 applyReversal(db, actor, commission, proportional, input.type === 'refund' ? 'refund' : 'payment_failed');
 return {result: 'reversal_applied', commission: db.prepare('SELECT * FROM commissions WHERE id=?').get(commission.id)};
}

/** Moves `amount` out of whichever bucket currently holds this commission's money. */
function applyReversal(db, actor, commission, amount, reason) {
 const inPending = OPEN_STATUSES.includes(commission.status);
 postLedger(db, {partnerId: commission.partner_id, commissionId: commission.id, type: inPending ? 'reversal' : 'clawback', bucket: inPending ? 'pending' : 'available', amount: -amount, currency: commission.currency, memo: reason, actor});
 const remaining = netMinor(db, commission);
 if (remaining <= 0) {
  db.prepare("UPDATE commissions SET status='cancelled',rejection_reason=?,rejected_at=?,updated_at=? WHERE id=?").run(reason, now(), now(), commission.id);
 }
 notifyUser(db, db.prepare('SELECT user_id FROM partner_profiles WHERE id=?').get(commission.partner_id)?.user_id, 'commission_reversed', {commissionId: commission.id, amountMinor: amount, reason});
}

// ---- lifecycle -------------------------------------------------------------------------------------
function releaseIfDue(db, commissionId, actor = null, at = Date.now()) {
 const c = db.prepare("SELECT * FROM commissions WHERE id=? AND status='approved'").get(commissionId);
 if (!c || Date.parse(c.hold_until) > at) return false;
 const t = new Date(at).toISOString();
 postLedger(db, {partnerId: c.partner_id, commissionId: c.id, type: 'release', bucket: 'pending', amount: -c.commission_minor + reversedMinor(db, c.id), currency: c.currency, memo: 'hold period ended', actor});
 postLedger(db, {partnerId: c.partner_id, commissionId: c.id, type: 'release', bucket: 'available', amount: c.commission_minor - reversedMinor(db, c.id), currency: c.currency, memo: 'hold period ended', actor});
 db.prepare("UPDATE commissions SET status='available',available_at=?,updated_at=? WHERE id=?").run(t, t, c.id);
 const owner = db.prepare('SELECT user_id FROM partner_profiles WHERE id=?').get(c.partner_id);
 notifyUser(db, owner?.user_id, 'commission_available', {commissionId: c.id, amountMinor: c.commission_minor});
 return true;
}
/** Idempotent maintenance: releases every approved commission whose hold has ended. */
export function releaseDueCommissions(db, at = Date.now()) {
 return tx(db, () => {
  let released = 0;
  for (const {id} of db.prepare("SELECT id FROM commissions WHERE status='approved' AND hold_until<=?").all(new Date(at).toISOString())) if (releaseIfDue(db, id, null, at)) released++;
  return released;
 });
}

export function decideCommission(db, actor, id, action, reason = null) {
 return tx(db, () => {
  const c = db.prepare('SELECT * FROM commissions WHERE id=?').get(id);
  if (!c) fail(404, 'Commission not found');
  const t = now();
  const owner = db.prepare('SELECT user_id FROM partner_profiles WHERE id=?').get(c.partner_id);
  if (action === 'approve') {
   if (c.status !== 'pending') fail(409, 'only pending commissions can be approved');
   db.prepare("UPDATE commissions SET status='approved',approved_at=?,updated_at=? WHERE id=?").run(t, t, id);
   releaseIfDue(db, id, actor);
  } else if (action === 'reject') {
   if (!OPEN_STATUSES.includes(c.status)) fail(409, 'only pending, approved or held commissions can be rejected');
   if (!clean(reason, 500)) fail(400, 'a reason is required');
   postLedger(db, {partnerId: c.partner_id, commissionId: id, type: 'reject', bucket: 'pending', amount: -netMinor(db, c), currency: c.currency, memo: clean(reason, 500), actor});
   db.prepare("UPDATE commissions SET status='rejected',rejected_at=?,rejection_reason=?,updated_at=? WHERE id=?").run(t, clean(reason, 500), t, id);
   notifyUser(db, owner?.user_id, 'commission_rejected', {commissionId: id, reason: clean(reason, 500)});
  } else if (action === 'hold') {
   if (!['pending', 'approved'].includes(c.status)) fail(409, 'only pending or approved commissions can be put on hold');
   db.prepare("UPDATE commissions SET status='on_hold',held_previous_status=?,updated_at=? WHERE id=?").run(c.status, t, id);
  } else if (action === 'release_hold') {
   if (c.status !== 'on_hold') fail(409, 'commission is not on hold');
   db.prepare('UPDATE commissions SET status=?,held_previous_status=NULL,updated_at=? WHERE id=?').run(c.held_previous_status || 'pending', t, id);
   releaseIfDue(db, id, actor);
  } else fail(400, 'action must be approve, reject, hold or release_hold');
  audit(db, {actor, action: `COMMISSION_${action.toUpperCase()}`, entityType: 'commission', entityId: id, partnerId: c.partner_id, detail: {reason}});
  return hydrateCommission(db.prepare('SELECT * FROM commissions WHERE id=?').get(id), db);
 });
}

/** Admin: cancel a referral (fraud / invalid). Open commissions are reversed, paid ones clawed back. */
export function cancelReferral(db, actor, referralId, reason) {
 if (!clean(reason, 500)) fail(400, 'a reason is required');
 return tx(db, () => {
  const r = db.prepare('SELECT * FROM referrals WHERE id=?').get(referralId);
  if (!r) fail(404, 'Referral not found');
  if (r.status === 'cancelled' || r.status === 'rejected') return r;
  const t = now();
  for (const c of db.prepare("SELECT * FROM commissions WHERE referral_id=? AND status NOT IN ('cancelled','rejected')").all(referralId)) {
   const remaining = netMinor(db, c);
   if (remaining > 0) applyReversal(db, actor, c, remaining, 'referral_cancelled');
  }
  db.prepare("UPDATE referrals SET status='cancelled',reject_reason=?,updated_at=? WHERE id=?").run(clean(reason, 500), t, referralId);
  audit(db, {actor, action: 'REFERRAL_CANCELLED', entityType: 'referral', entityId: referralId, partnerId: r.partner_id, detail: {reason}});
  return db.prepare('SELECT * FROM referrals WHERE id=?').get(referralId);
 });
}

// ---- reads -------------------------------------------------------------------------------------------
export function hydrateCommission(row, db) {
 if (!row) return null;
 return {
  id: row.id, partnerId: row.partner_id, referralId: row.referral_id, status: row.status, grossMinor: row.gross_minor, rateBps: row.commission_rate_bps, commissionMinor: row.commission_minor,
  netMinor: db ? netMinor(db, row) : undefined, currency: row.currency, holdUntil: row.hold_until, approvedAt: row.approved_at, availableAt: row.available_at, paidAt: row.paid_at, rejectionReason: row.rejection_reason, createdAt: row.created_at
 };
}
export function listCommissions(db, url, {partnerId = null} = {}) {
 const p = pageParams(url);
 const where = ['1=1'], args = [];
 if (partnerId) { where.push('c.partner_id=?'); args.push(partnerId); }
 else if (url.searchParams.get('partnerId')) { where.push('c.partner_id=?'); args.push(url.searchParams.get('partnerId')); }
 const status = url.searchParams.get('status');
 if (status) { where.push('c.status=?'); args.push(status); }
 const from = url.searchParams.get('from'), to = url.searchParams.get('to');
 if (from) { where.push('c.created_at>=?'); args.push(from); }
 if (to) { where.push('c.created_at<=?'); args.push(to); }
 const total = db.prepare(`SELECT COUNT(*) n FROM commissions c WHERE ${where.join(' AND ')}`).get(...args).n;
 const rows = db.prepare(`SELECT c.*, pp.display_name partner_name, u.name customer_name, u.email customer_email FROM commissions c JOIN partner_profiles pp ON pp.id=c.partner_id JOIN users u ON u.id=c.customer_user_id WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).all(...args, p.limit, p.offset);
 return paged(rows.map(r => ({...hydrateCommission(r, db), partnerName: partnerId ? undefined : r.partner_name, customerName: partnerId ? maskName(r.customer_name) : r.customer_name, customerEmail: partnerId ? null : r.customer_email})), total, p);
}
const maskName = name => { const t = String(name || '').trim(); return t ? `${t.slice(0, 1)}${'*'.repeat(Math.min(6, Math.max(2, t.length - 1)))}` : null; };

export function listBillingEvents(db, url) {
 const p = pageParams(url);
 const total = db.prepare('SELECT COUNT(*) n FROM billing_events').get().n;
 const rows = db.prepare('SELECT id,source,external_id,type,customer_user_id,customer_email,plan_ref,amount_minor,currency,occurred_at,result,created_at FROM billing_events ORDER BY created_at DESC LIMIT ? OFFSET ?').all(p.limit, p.offset);
 return paged(rows.map(r => ({id: r.id, source: r.source, externalId: r.external_id, type: r.type, customerEmail: r.customer_email, planRef: r.plan_ref, amountMinor: r.amount_minor, currency: r.currency, occurredAt: r.occurred_at, result: r.result, createdAt: r.created_at})), total, p);
}
export function ledgerFor(db, partnerId, url) {
 const p = pageParams(url);
 const total = db.prepare('SELECT COUNT(*) n FROM commission_ledger WHERE partner_id=?').get(partnerId).n;
 const rows = db.prepare('SELECT id,commission_id,payout_id,entry_type,bucket,amount_minor,currency,memo,created_at FROM commission_ledger WHERE partner_id=? ORDER BY seq DESC LIMIT ? OFFSET ?').all(partnerId, p.limit, p.offset);
 return paged(rows.map(r => ({id: r.id, commissionId: r.commission_id, payoutId: r.payout_id, type: r.entry_type, bucket: r.bucket, amountMinor: r.amount_minor, currency: r.currency, memo: r.memo, createdAt: r.created_at})), total, p);
}
