import {fail} from '../auth.js';
import {decrypt, encrypt, encryptionKey} from '../runtime/crypto.js';
import {audit, clean, cleanMultiline, getSettings, newId, notifyUser, now, pageParams, paged, tx} from './core.js';
import {balances, netMinor, postLedger} from './commissions.js';
import {entitlementsFor, effectivePartnerState, getPlanOrNull} from './plans.js';

const OPEN = ['requested', 'under_review', 'approved', 'processing'];
const RECEIPT_TYPES = {'application/pdf': [0x25, 0x50, 0x44, 0x46], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff]};
const MAX_RECEIPT = 2 * 1024 * 1024;

// ---- payout methods (sensitive details are AES-256-GCM encrypted; the API only ever returns `masked`) ----
function keyOrFail(env) {
 const key = encryptionKey(env || {});
 if (!key) fail(503, 'ENCRYPTION_NOT_CONFIGURED');
 return key;
}
const mask = (type, d) => {
 if (type === 'bank_transfer') return `${d.bankName ? d.bankName + ' ' : ''}•••• ${d.iban.slice(-4)}`;
 if (type === 'paypal') { const [n, dom] = d.email.split('@'); return `${n.slice(0, 1)}***@${dom.slice(0, 1)}***`; }
 return d.instructions.slice(0, 3) + '…';
};
function validateDetails(type, raw) {
 const d = raw && typeof raw === 'object' ? raw : {};
 if (type === 'bank_transfer') {
  const iban = String(d.iban || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) fail(400, 'a valid IBAN is required');
  const accountName = clean(d.accountName, 100);
  if (accountName.length < 2) fail(400, 'accountName is required');
  return {accountName, iban, bankName: clean(d.bankName, 80) || null, swift: clean(d.swift, 11).toUpperCase() || null};
 }
 if (type === 'paypal') {
  const email = clean(d.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'a valid PayPal email is required');
  return {email};
 }
 const instructions = cleanMultiline(d.instructions, 500);
 if (instructions.length < 5) fail(400, 'payment instructions are required');
 return {instructions};
}
const hydrateMethod = r => ({id: r.id, type: r.type, label: r.label, masked: r.masked, isDefault: !!r.is_default, createdAt: r.created_at});

export const listMethods = (db, partnerId) => db.prepare("SELECT * FROM payout_methods WHERE partner_id=? AND status='active' ORDER BY is_default DESC, created_at").all(partnerId).map(hydrateMethod);
export function addMethod(db, env, profile, input) {
 const settings = getSettings(db);
 if (!settings.payout_methods.includes(input.type)) fail(400, 'this payout method is not enabled');
 const details = validateDetails(input.type, input.details);
 const label = clean(input.label, 60) || input.type;
 const key = keyOrFail(env);
 return tx(db, () => {
  if (db.prepare("SELECT COUNT(*) n FROM payout_methods WHERE partner_id=? AND status='active'").get(profile.id).n >= 5) fail(409, 'payout method limit reached');
  const id = newId(), t = now();
  const first = !db.prepare("SELECT 1 FROM payout_methods WHERE partner_id=? AND status='active'").get(profile.id);
  const makeDefault = first || input.isDefault === true;
  if (makeDefault) db.prepare('UPDATE payout_methods SET is_default=0 WHERE partner_id=?').run(profile.id);
  db.prepare('INSERT INTO payout_methods (id,partner_id,type,label,masked,details_encrypted,is_default,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,\'active\',?,?)')
   .run(id, profile.id, input.type, label, mask(input.type, details), encrypt(key, JSON.stringify(details)), makeDefault ? 1 : 0, t, t);
  audit(db, {actor: {id: profile.user_id, role: 'partner'}, action: 'PAYOUT_METHOD_ADDED', entityType: 'payout_method', entityId: id, partnerId: profile.id, detail: {type: input.type}});
  return hydrateMethod(db.prepare('SELECT * FROM payout_methods WHERE id=?').get(id));
 });
}
export function deleteMethod(db, profile, id) {
 const row = db.prepare("SELECT * FROM payout_methods WHERE id=? AND partner_id=? AND status='active'").get(id, profile.id);
 if (!row) fail(404, 'Payout method not found');
 db.prepare("UPDATE payout_methods SET status='deleted',is_default=0,updated_at=? WHERE id=?").run(now(), id);
 audit(db, {actor: {id: profile.user_id, role: 'partner'}, action: 'PAYOUT_METHOD_DELETED', entityType: 'payout_method', entityId: id, partnerId: profile.id});
 return {ok: true};
}
export function setDefaultMethod(db, profile, id) {
 if (!db.prepare("SELECT 1 FROM payout_methods WHERE id=? AND partner_id=? AND status='active'").get(id, profile.id)) fail(404, 'Payout method not found');
 tx(db, () => { db.prepare('UPDATE payout_methods SET is_default=0 WHERE partner_id=?').run(profile.id); db.prepare('UPDATE payout_methods SET is_default=1 WHERE id=?').run(id); });
 return {ok: true};
}

// ---- payout requests ----------------------------------------------------------------------------------
const hydratePayout = (r, {admin = false} = {}) => r && ({
 id: r.id, partnerId: r.partner_id, methodType: r.method_type, methodLabel: r.method_label, methodMasked: r.method_masked, amountMinor: r.amount_minor, currency: r.currency, status: r.status,
 rejectReason: r.reject_reason, paymentReference: r.payment_reference, requestedAt: r.requested_at, reviewedAt: r.reviewed_at, processingAt: r.processing_at, paidAt: r.paid_at, updatedAt: r.updated_at,
 ...(admin ? {partnerName: r.partner_name, reviewedBy: r.reviewed_by, paidBy: r.paid_by, hasReceipt: !!r.has_receipt} : {hasReceipt: !!r.has_receipt})
});
const PAYOUT_SELECT = 'SELECT r.*, (SELECT 1 FROM payout_receipts x WHERE x.payout_id=r.id) has_receipt';

export function requestPayout(db, env, profile, user, input) {
 return tx(db, () => {
  const fresh = db.prepare('SELECT * FROM partner_profiles WHERE id=?').get(profile.id);
  const state = effectivePartnerState(db, fresh);
  if (state.status === 'suspended' || state.status === 'closed') fail(403, state.status === 'suspended' ? 'PARTNER_SUSPENDED' : 'PARTNER_CLOSED');
  if (!entitlementsFor(db, fresh).includes('partner.payouts')) fail(403, 'ENTITLEMENT_REQUIRED');
  if (!db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(user.id)?.email_verified_at) fail(403, 'EMAIL_NOT_VERIFIED');
  const method = db.prepare("SELECT * FROM payout_methods WHERE id=? AND partner_id=? AND status='active'").get(input.methodId, profile.id);
  if (!method) fail(400, 'a payout method is required');
  if (db.prepare(`SELECT 1 FROM payout_requests WHERE partner_id=? AND status IN (${OPEN.map(() => '?').join(',')})`).get(profile.id, ...OPEN)) fail(409, 'PAYOUT_ALREADY_OPEN');
  const settings = getSettings(db);
  const plan = getPlanOrNull(db, fresh.plan_id);
  const minimum = plan?.minPayoutMinor ?? settings.min_payout_minor;
  const bal = balances(db, profile.id);
  let cap = bal.withdrawableMinor;
  if (input.amountMinor !== undefined && input.amountMinor !== null) {
   if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) fail(400, 'amountMinor must be a positive integer');
   if (input.amountMinor > cap) fail(409, 'INSUFFICIENT_BALANCE');
   cap = input.amountMinor;
  }
  // Whole commissions only, oldest first, never more than the requested/withdrawable amount.
  const candidates = db.prepare(`SELECT c.* FROM commissions c WHERE c.partner_id=? AND c.status='available'
    AND NOT EXISTS (SELECT 1 FROM payout_commissions pc JOIN payout_requests pr ON pr.id=pc.payout_id WHERE pc.commission_id=c.id AND pr.status IN ('requested','under_review','approved','processing'))
    ORDER BY c.available_at, c.created_at`).all(profile.id);
  const picked = []; let total = 0;
  for (const c of candidates) {
   const net = netMinor(db, c);
   if (net <= 0 || total + net > cap) continue;
   picked.push({c, net}); total += net;
  }
  if (total < Math.max(minimum, 1)) fail(409, `BELOW_MINIMUM:${minimum}`);
  const id = newId(), t = now();
  db.prepare('INSERT INTO payout_requests (id,partner_id,method_id,method_type,method_label,method_masked,method_details_encrypted,amount_minor,currency,status,requested_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(id, profile.id, method.id, method.type, method.label, method.masked, method.details_encrypted, total, settings.default_currency, 'requested', t, t);
  for (const {c, net} of picked) db.prepare('INSERT INTO payout_commissions (payout_id,commission_id,amount_minor) VALUES (?,?,?)').run(id, c.id, net);
  postLedger(db, {partnerId: profile.id, payoutId: id, type: 'reserve', bucket: 'available', amount: -total, currency: settings.default_currency, memo: 'payout requested', actor: user});
  postLedger(db, {partnerId: profile.id, payoutId: id, type: 'reserve', bucket: 'reserved', amount: total, currency: settings.default_currency, memo: 'payout requested', actor: user});
  audit(db, {actor: {id: user.id, name: user.name, role: 'partner'}, action: 'PAYOUT_REQUESTED', entityType: 'payout', entityId: id, partnerId: profile.id, detail: {amountMinor: total}});
  return hydratePayout(db.prepare(`${PAYOUT_SELECT} FROM payout_requests r WHERE r.id=?`).get(id));
 });
}

function unreserve(db, payout, type, actor) {
 postLedger(db, {partnerId: payout.partner_id, payoutId: payout.id, type, bucket: 'reserved', amount: -payout.amount_minor, currency: payout.currency, memo: type, actor});
 postLedger(db, {partnerId: payout.partner_id, payoutId: payout.id, type, bucket: 'available', amount: payout.amount_minor, currency: payout.currency, memo: type, actor});
}

export function cancelPayout(db, profile, user, id) {
 return tx(db, () => {
  const p = db.prepare('SELECT * FROM payout_requests WHERE id=? AND partner_id=?').get(id, profile.id);
  if (!p) fail(404, 'Payout not found');
  if (p.status !== 'requested') fail(409, 'only a newly requested payout can be cancelled');
  unreserve(db, p, 'unreserve', user);
  db.prepare("UPDATE payout_requests SET status='cancelled',updated_at=? WHERE id=?").run(now(), id);
  audit(db, {actor: {id: user.id, name: user.name, role: 'partner'}, action: 'PAYOUT_CANCELLED', entityType: 'payout', entityId: id, partnerId: profile.id});
  return hydratePayout(db.prepare(`${PAYOUT_SELECT} FROM payout_requests r WHERE r.id=?`).get(id));
 });
}

export function listPayouts(db, url, {partnerId = null} = {}) {
 const p = pageParams(url);
 const where = ['1=1'], args = [];
 if (partnerId) { where.push('r.partner_id=?'); args.push(partnerId); }
 const status = url.searchParams.get('status');
 if (status) { where.push('r.status=?'); args.push(status); }
 const total = db.prepare(`SELECT COUNT(*) n FROM payout_requests r WHERE ${where.join(' AND ')}`).get(...args).n;
 const rows = db.prepare(`${PAYOUT_SELECT}, pp.display_name partner_name FROM payout_requests r JOIN partner_profiles pp ON pp.id=r.partner_id WHERE ${where.join(' AND ')} ORDER BY r.requested_at DESC LIMIT ? OFFSET ?`).all(...args, p.limit, p.offset);
 return paged(rows.map(r => hydratePayout(r, {admin: !partnerId})), total, p);
}
export function getPayoutAdmin(db, id) {
 const r = db.prepare(`${PAYOUT_SELECT}, pp.display_name partner_name FROM payout_requests r JOIN partner_profiles pp ON pp.id=r.partner_id WHERE r.id=?`).get(id);
 if (!r) fail(404, 'Payout not found');
 return {...hydratePayout(r, {admin: true}), commissions: db.prepare('SELECT commission_id id, amount_minor amountMinor FROM payout_commissions WHERE payout_id=?').all(id)};
}
/** Staff-only: the decrypted destination, needed to actually send the money. Every reveal is audited. */
export function revealPayoutDetails(db, env, actor, id) {
 const r = db.prepare('SELECT * FROM payout_requests WHERE id=?').get(id);
 if (!r) fail(404, 'Payout not found');
 const details = JSON.parse(decrypt(keyOrFail(env), r.method_details_encrypted));
 audit(db, {actor, action: 'PAYOUT_DETAILS_VIEWED', entityType: 'payout', entityId: id, partnerId: r.partner_id});
 return {type: r.method_type, details};
}

const TRANSITIONS = {
 under_review: ['requested'],
 approve: ['requested', 'under_review'],
 processing: ['approved'],
 pay: ['approved', 'processing'],
 reject: ['requested', 'under_review', 'approved', 'processing']
};
export function decidePayout(db, actor, id, action, {reason, paymentReference} = {}) {
 if (!TRANSITIONS[action]) fail(400, 'action must be under_review, approve, processing, pay or reject');
 return tx(db, () => {
  const p = db.prepare('SELECT * FROM payout_requests WHERE id=?').get(id);
  if (!p) fail(404, 'Payout not found');
  if (!TRANSITIONS[action].includes(p.status)) fail(409, `cannot ${action} a payout that is ${p.status}`);
  const t = now();
  const owner = db.prepare('SELECT user_id FROM partner_profiles WHERE id=?').get(p.partner_id);
  if (action === 'under_review') db.prepare("UPDATE payout_requests SET status='under_review',reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?").run(actor.id, t, t, id);
  else if (action === 'approve') { db.prepare("UPDATE payout_requests SET status='approved',reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?").run(actor.id, t, t, id); notifyUser(db, owner?.user_id, 'payout_approved', {payoutId: id}); }
  else if (action === 'processing') db.prepare("UPDATE payout_requests SET status='processing',processing_at=?,updated_at=? WHERE id=?").run(t, t, id);
  else if (action === 'reject') {
   const text = cleanMultiline(reason, 500);
   if (!text) fail(400, 'a reason is required');
   unreserve(db, p, 'payout_rejected', actor);
   db.prepare("UPDATE payout_requests SET status='rejected',reject_reason=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?").run(text, actor.id, t, t, id);
   notifyUser(db, owner?.user_id, 'payout_rejected', {payoutId: id, reason: text});
  } else {
   const ref = clean(paymentReference, 120);
   if (!ref) fail(400, 'paymentReference is required');
   postLedger(db, {partnerId: p.partner_id, payoutId: id, type: 'payout', bucket: 'reserved', amount: -p.amount_minor, currency: p.currency, memo: ref, actor});
   postLedger(db, {partnerId: p.partner_id, payoutId: id, type: 'payout', bucket: 'paid', amount: p.amount_minor, currency: p.currency, memo: ref, actor});
   db.prepare("UPDATE payout_requests SET status='paid',payment_reference=?,paid_at=?,paid_by=?,updated_at=? WHERE id=?").run(ref, t, actor.id, t, id);
   db.prepare("UPDATE commissions SET status='paid',paid_at=?,updated_at=? WHERE status='available' AND id IN (SELECT commission_id FROM payout_commissions WHERE payout_id=?)").run(t, t, id);
   notifyUser(db, owner?.user_id, 'payout_paid', {payoutId: id, amountMinor: p.amount_minor, currency: p.currency});
  }
  audit(db, {actor, action: `PAYOUT_${action.toUpperCase()}`, entityType: 'payout', entityId: id, partnerId: p.partner_id, detail: {reason: reason || null, paymentReference: paymentReference || null}});
  return getPayoutAdmin(db, id);
 });
}

// ---- receipts (admin upload, partner download of their own) ----------------------------------------
export function saveReceipt(db, actor, id, {mimeType, fileName, data}) {
 const magic = RECEIPT_TYPES[mimeType];
 if (!magic) fail(415, 'receipt must be a PDF, PNG or JPEG');
 if (!data.length || data.length > MAX_RECEIPT) fail(413, 'receipt must be 1 byte - 2 MB');
 if (!magic.every((b, i) => data[i] === b)) fail(400, 'file content does not match its type');
 const p = db.prepare('SELECT id,partner_id FROM payout_requests WHERE id=?').get(id);
 if (!p) fail(404, 'Payout not found');
 const safeName = clean(fileName, 100).replace(/[^\w.\- ]/g, '_') || 'receipt';
 db.prepare('INSERT INTO payout_receipts (payout_id,file_name,mime_type,size_bytes,data,uploaded_by,uploaded_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(payout_id) DO UPDATE SET file_name=excluded.file_name,mime_type=excluded.mime_type,size_bytes=excluded.size_bytes,data=excluded.data,uploaded_by=excluded.uploaded_by,uploaded_at=excluded.uploaded_at')
  .run(id, safeName, mimeType, data.length, data, actor.id, now());
 audit(db, {actor, action: 'PAYOUT_RECEIPT_UPLOADED', entityType: 'payout', entityId: id, partnerId: p.partner_id});
 return {ok: true};
}
export function getReceipt(db, id, {partnerId = null} = {}) {
 const p = db.prepare('SELECT partner_id FROM payout_requests WHERE id=?').get(id);
 if (!p || (partnerId && p.partner_id !== partnerId)) fail(404, 'Receipt not found');
 const r = db.prepare('SELECT * FROM payout_receipts WHERE payout_id=?').get(id);
 if (!r) fail(404, 'Receipt not found');
 return r;
}
