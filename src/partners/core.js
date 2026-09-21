import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {fail} from '../auth.js';

// Frost Partners - shared constants, money math, transaction and audit helpers.
// Design rules that every module in src/partners/ follows:
//  * money is ALWAYS an integer number of minor units (halalas/cents) - never a float;
//  * commission rates are integer basis points (2000 = 20.00%);
//  * every financial state change is a row in the append-only commission_ledger, written in the
//    same transaction as the state change it explains;
//  * authorization identity (partner id, actor) comes from the server session, never the client.

export const ENTITLEMENTS = ['partner.dashboard', 'partner.referrals', 'partner.customers', 'partner.commissions', 'partner.payouts', 'partner.marketing_assets', 'partner.custom_branding', 'partner.team_members', 'partner.analytics', 'partner.export_data'];
// What a partner keeps when their plan has expired ("limited"): read their own basics and earned money.
export const LIMITED_ENTITLEMENTS = ['partner.dashboard', 'partner.commissions', 'partner.payouts', 'partner.customers'];
export const APPLICATION_STATUSES = ['pending', 'under_review', 'approved', 'rejected', 'needs_information'];
export const OPEN_APPLICATION_STATUSES = ['pending', 'under_review', 'needs_information'];
export const PARTNER_STATUSES = ['active', 'limited', 'suspended', 'closed'];
export const REFERRAL_STATUSES = ['clicked', 'registered', 'qualified', 'converted', 'rejected', 'cancelled'];
export const COMMISSION_STATUSES = ['pending', 'on_hold', 'approved', 'available', 'rejected', 'cancelled', 'paid'];
export const PAYOUT_STATUSES = ['requested', 'under_review', 'approved', 'processing', 'paid', 'rejected', 'cancelled'];
export const PAYOUT_METHOD_TYPES = ['bank_transfer', 'paypal', 'other'];
export const STAFF_PERMISSIONS = ['applications', 'partners', 'commissions', 'payouts', 'plans', 'assets'];
export const PARTNER_TYPES = ['affiliate', 'agency', 'reseller', 'influencer', 'consultant', 'other'];
export const BUCKETS = ['pending', 'available', 'reserved', 'paid'];

export const DEFAULT_SETTINGS = {
 attribution_window_days: 30,
 conversion_window_days: 180,
 commission_hold_days: 14,
 min_payout_minor: 10000,
 default_currency: 'SAR',
 registration_mode: 'open',
 approval_mode: 'manual',
 commission_review: 'manual',
 payout_methods: ['bank_transfer', 'paypal'],
 block_self_referral: true,
 max_visits_per_ip_per_hour: 60,
 max_registrations_per_ip_per_day: 5,
 terms_version: '1',
 terms_ar: '',
 terms_en: '',
 notify_partner_email: true
};

export const now = () => new Date().toISOString();
export const newId = () => randomUUID();
export const sha = value => createHash('sha256').update(String(value)).digest('hex');
export const clean = (value, max = 500) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
export const cleanMultiline = (value, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export const isEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// ---- money -------------------------------------------------------------------------------
export function assertMinor(value, label = 'amount') {
 if (!Number.isSafeInteger(value) || value < 0) fail(400, `${label} must be a non-negative integer of minor units`);
 return value;
}
/** Decimal string/number ("120.50") -> integer minor units, exactly (no float rounding drift). */
export function toMinor(input, label = 'amount') {
 const text = typeof input === 'number' ? String(input) : typeof input === 'string' ? input.trim() : '';
 const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text);
 if (!match) fail(400, `${label}: invalid amount`);
 return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0') || 0);
}
export function fromMinor(minor) { return (minor / 100).toFixed(2); }
/** commission = gross * rate, half-up, integer math only. */
export function computeCommission(grossMinor, rateBps) {
 assertMinor(grossMinor, 'gross');
 if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) fail(400, 'commission rate must be 0..10000 basis points');
 return Math.floor((grossMinor * rateBps + 5000) / 10000);
}
export function assertCurrency(code) {
 if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) fail(400, 'currency must be a 3-letter ISO code');
 return code;
}

// ---- transactions ------------------------------------------------------------------------
/** Runs fn inside BEGIN IMMEDIATE ... COMMIT (re-entrant). Never `await` inside fn. */
export function tx(db, fn) {
 if (db.__partnersTx) return fn();
 db.exec('BEGIN IMMEDIATE');
 db.__partnersTx = true;
 try {
  const result = fn();
  db.exec('COMMIT');
  return result;
 } catch (error) {
  db.exec('ROLLBACK');
  throw error;
 } finally {
  db.__partnersTx = false;
 }
}

// ---- audit + notifications ----------------------------------------------------------------
export function audit(db, {actor, action, entityType, entityId = null, partnerId = null, detail = null}) {
 db.prepare('INSERT INTO partner_audit_logs (id,actor_id,actor_name,actor_role,action,entity_type,entity_id,partner_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
  .run(newId(), actor?.id || null, actor?.name || null, actor?.role || null, action, entityType, entityId, partnerId, detail ? JSON.stringify(detail) : null, now());
}
export function notifyUser(db, userId, kind, params = {}) {
 if (!userId) return;
 db.prepare('INSERT INTO partner_notifications (id,user_id,kind,params_json,created_at) VALUES (?,?,?,?,?)').run(newId(), userId, kind, JSON.stringify(params), now());
}
/** Notify every partner manager / platform admin that can act on `permission`. */
export function notifyStaff(db, env, permission, kind, params = {}) {
 const ids = new Set(db.prepare('SELECT user_id FROM partner_staff WHERE status=\'active\'').all().filter(r => hasPermission(JSON.parse(r.permissions_json || '[]'), permission)).map(r => r.user_id));
 const admins = String(env?.PLATFORM_ADMIN_USERNAMES || '').split(',').map(u => u.trim().toLowerCase()).filter(Boolean);
 for (const username of admins) {
  const row = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (row) ids.add(row.id);
 }
 for (const id of ids) notifyUser(db, id, kind, params);
}
export const hasPermission = (permissions, permission) => Array.isArray(permissions) && permissions.includes(permission);

// ---- codes -------------------------------------------------------------------------------
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L ambiguity
export function randomCode(length = 8) {
 const bytes = randomBytes(length);
 let out = '';
 for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
 return out;
}

// ---- settings ----------------------------------------------------------------------------
export function getSettings(db) {
 const settings = {...DEFAULT_SETTINGS};
 for (const row of db.prepare('SELECT key,value_json FROM partner_settings').all()) {
  try { settings[row.key] = JSON.parse(row.value_json); } catch { /* keep default */ }
 }
 return settings;
}
export function saveSettings(db, actor, patch) {
 const validators = {
  attribution_window_days: v => Number.isInteger(v) && v >= 1 && v <= 365,
  conversion_window_days: v => Number.isInteger(v) && v >= 1 && v <= 1095,
  commission_hold_days: v => Number.isInteger(v) && v >= 0 && v <= 365,
  min_payout_minor: v => Number.isSafeInteger(v) && v >= 0,
  default_currency: v => typeof v === 'string' && /^[A-Z]{3}$/.test(v),
  registration_mode: v => ['open', 'invite_only'].includes(v),
  approval_mode: v => ['manual', 'auto'].includes(v),
  commission_review: v => ['manual', 'auto'].includes(v),
  payout_methods: v => Array.isArray(v) && v.length > 0 && v.every(m => PAYOUT_METHOD_TYPES.includes(m)),
  block_self_referral: v => typeof v === 'boolean',
  max_visits_per_ip_per_hour: v => Number.isInteger(v) && v >= 1 && v <= 100000,
  max_registrations_per_ip_per_day: v => Number.isInteger(v) && v >= 1 && v <= 10000,
  terms_version: v => typeof v === 'string' && v.length >= 1 && v.length <= 20,
  terms_ar: v => typeof v === 'string' && v.length <= 20000,
  terms_en: v => typeof v === 'string' && v.length <= 20000,
  notify_partner_email: v => typeof v === 'boolean'
 };
 tx(db, () => {
  for (const [key, value] of Object.entries(patch || {})) {
   if (!validators[key]) fail(400, `unknown setting: ${key}`);
   if (!validators[key](value)) fail(400, `invalid value for ${key}`);
   db.prepare('INSERT INTO partner_settings (key,value_json,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by')
    .run(key, JSON.stringify(value), now(), actor?.id || null);
  }
  audit(db, {actor, action: 'PARTNER_SETTINGS_UPDATED', entityType: 'settings', detail: patch});
 });
 return getSettings(db);
}

// ---- pagination ---------------------------------------------------------------------------
export function pageParams(url, {defaultLimit = 25, maxLimit = 100} = {}) {
 const limit = Math.min(maxLimit, Math.max(1, Number(url.searchParams.get('limit')) || defaultLimit));
 const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
 return {limit, offset: (page - 1) * limit, page};
}
export function paged(rows, total, {limit, page}) {
 return {items: rows, page, limit, total, pages: Math.max(1, Math.ceil(total / limit))};
}

/** "12.5" -> 1250 basis points, exactly (string arithmetic, never float). */
export function toBps(input, label = 'percent') {
 const text = typeof input === 'number' ? String(input) : typeof input === 'string' ? input.trim() : '';
 const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
 if (!match) fail(400, `${label}: invalid percentage`);
 const bps = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0') || 0);
 if (bps > 10000) fail(400, `${label}: cannot exceed 100%`);
 return bps;
}
