import {fail} from '../auth.js';
import {PARTNER_STATUSES, STAFF_PERMISSIONS, audit, clean, cleanMultiline, newId, notifyUser, now, pageParams, paged, tx, randomCode} from './core.js';
import {createDefaultLink, newReferralCode} from './referrals.js';
import {currentSubscription, effectivePartnerState, entitlementsFor, getPlan, getPlanOrNull} from './plans.js';

const addPeriod = (from, period) => {
 const d = new Date(from);
 if (period === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
 else if (period === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
 else return null;
 return d.toISOString();
};

export const hydrateProfile = (db, row) => {
 if (!row) return null;
 const state = effectivePartnerState(db, row);
 const plan = getPlanOrNull(db, row.plan_id);
 const sub = state.subscription;
 return {
  id: row.id, userId: row.user_id, displayName: row.display_name, companyName: row.company_name, country: row.country, phone: row.phone, website: row.website, partnerType: row.partner_type,
  referralCode: row.referral_code, status: state.status, storedStatus: row.status, planExpired: state.planExpired, suspendedReason: row.suspended_reason,
  customCommissionBps: row.custom_commission_bps, planId: row.plan_id,
  plan: plan && {id: plan.id, slug: plan.slug, nameAr: plan.nameAr, nameEn: plan.nameEn, defaultCommissionBps: plan.defaultCommissionBps, priceMinor: plan.priceMinor, currency: plan.currency, billingPeriod: plan.billingPeriod},
  subscription: sub && {id: sub.id, status: sub.status, startedAt: sub.started_at, trialEndsAt: sub.trial_ends_at, endsAt: sub.ends_at, renewsAt: sub.renews_at, priceMinor: sub.price_minor, currency: sub.currency},
  entitlements: entitlementsFor(db, row), effectiveCommissionBps: row.custom_commission_bps ?? plan?.defaultCommissionBps ?? 0,
  createdAt: row.created_at
 };
};

export function getProfileById(db, id) {
 const row = db.prepare('SELECT * FROM partner_profiles WHERE id=? AND deleted_at IS NULL').get(id);
 if (!row) fail(404, 'Partner not found');
 return row;
}

/** Creates the partner profile + default link + plan subscription. Always inside the caller's tx. */
export function createPartnerFromApplication(db, actor, application, {planId, customCommissionBps = null}) {
 const plan = getPlan(db, planId);
 if (plan.status !== 'active') fail(409, 'the selected plan is not active');
 if (db.prepare('SELECT 1 FROM partner_profiles WHERE user_id=?').get(application.user_id)) fail(409, 'this user is already a partner');
 const id = newId(), t = now();
 db.prepare(`INSERT INTO partner_profiles (id,user_id,application_id,display_name,company_name,country,phone,website,partner_type,referral_code,status,plan_id,custom_commission_bps,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`).run(id, application.user_id, application.id, application.full_name, application.company_name, application.country, application.phone, application.website, application.partner_type,
  newReferralCode(db), planId, customCommissionBps, t, t);
 const profile = db.prepare('SELECT * FROM partner_profiles WHERE id=?').get(id);
 createDefaultLink(db, profile);
 assignPlan(db, actor, profile, planId, {source: 'application'});
 return profile;
}

export function assignPlan(db, actor, profile, planId, {startedAt = now(), endsAt, status, source = 'admin', trial = false} = {}) {
 const plan = getPlan(db, planId);
 return tx(db, () => {
  const t = now();
  db.prepare("UPDATE partner_subscriptions SET status='cancelled',ends_at=COALESCE(ends_at,?) WHERE partner_id=? AND status IN ('trialing','active','past_due','expired')").run(t, profile.id);
  const useTrial = trial && plan.trialDays > 0;
  const subStatus = status || (useTrial ? 'trialing' : 'active');
  if (!['trialing', 'active', 'past_due'].includes(subStatus)) fail(400, 'invalid subscription status');
  const trialEnds = useTrial ? new Date(Date.parse(startedAt) + plan.trialDays * 86400000).toISOString() : null;
  const end = endsAt === undefined ? (useTrial ? trialEnds : addPeriod(startedAt, plan.billingPeriod)) : endsAt;
  if (end && Date.parse(end) <= Date.parse(startedAt)) fail(400, 'endsAt must be after startedAt');
  const id = newId();
  db.prepare('INSERT INTO partner_subscriptions (id,partner_id,plan_id,status,price_minor,currency,started_at,trial_ends_at,ends_at,renews_at,source,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(id, profile.id, planId, subStatus, plan.priceMinor, plan.currency, startedAt, trialEnds, end, plan.billingPeriod === 'free' || plan.billingPeriod === 'one_time' ? null : end, source, actor?.id || null, t);
  db.prepare("UPDATE partner_profiles SET plan_id=?,updated_at=?,status=CASE WHEN status='limited' THEN 'active' ELSE status END WHERE id=?").run(planId, t, profile.id);
  audit(db, {actor, action: 'PARTNER_PLAN_ASSIGNED', entityType: 'partner', entityId: profile.id, partnerId: profile.id, detail: {planId, slug: plan.slug, endsAt: end, source}});
  notifyUser(db, profile.user_id, 'plan_changed', {plan: plan.nameEn, planAr: plan.nameAr});
  return id;
 });
}

export function setPartnerStatus(db, actor, partnerId, status, reason = null) {
 if (!PARTNER_STATUSES.includes(status)) fail(400, 'invalid status');
 return tx(db, () => {
  const row = getProfileById(db, partnerId);
  if (row.status === status) return row;
  if ((status === 'suspended' || status === 'closed') && !clean(reason, 500)) fail(400, 'a reason is required');
  db.prepare('UPDATE partner_profiles SET status=?,suspended_reason=?,updated_at=? WHERE id=?').run(status, status === 'suspended' || status === 'closed' ? clean(reason, 500) : null, now(), partnerId);
  if (status === 'suspended' || status === 'closed') db.prepare("UPDATE referral_links SET status='disabled' WHERE partner_id=? AND status='active'").run(partnerId);
  if (status === 'active') db.prepare("UPDATE referral_links SET status='active' WHERE partner_id=? AND status='disabled'").run(partnerId);
  audit(db, {actor, action: 'PARTNER_STATUS_CHANGED', entityType: 'partner', entityId: partnerId, partnerId, detail: {from: row.status, to: status, reason}});
  notifyUser(db, row.user_id, status === 'suspended' ? 'account_suspended' : status === 'active' ? 'account_reactivated' : 'account_status_changed', {status});
  return db.prepare('SELECT * FROM partner_profiles WHERE id=?').get(partnerId);
 });
}
export function setCustomCommission(db, actor, partnerId, bps) {
 if (bps !== null && (!Number.isInteger(bps) || bps < 0 || bps > 10000)) fail(400, 'commission must be 0..10000 basis points or null');
 return tx(db, () => {
  const row = getProfileById(db, partnerId);
  db.prepare('UPDATE partner_profiles SET custom_commission_bps=?,updated_at=? WHERE id=?').run(bps, now(), partnerId);
  audit(db, {actor, action: 'PARTNER_COMMISSION_RATE_CHANGED', entityType: 'partner', entityId: partnerId, partnerId, detail: {from: row.custom_commission_bps, to: bps}});
  return db.prepare('SELECT * FROM partner_profiles WHERE id=?').get(partnerId);
 });
}
export function regenerateReferralCode(db, actor, partnerId) {
 return tx(db, () => {
  const row = getProfileById(db, partnerId);
  const code = newReferralCode(db);
  db.prepare('UPDATE partner_profiles SET referral_code=?,updated_at=? WHERE id=?').run(code, now(), partnerId);
  db.prepare('UPDATE referral_links SET code=? WHERE partner_id=? AND is_default=1').run(code, partnerId);
  audit(db, {actor, action: 'PARTNER_REFERRAL_CODE_REGENERATED', entityType: 'partner', entityId: partnerId, partnerId, detail: {old: row.referral_code}});
  return code;
 });
}
export function updateOwnProfile(db, profile, input) {
 const set = {};
 if (input.displayName !== undefined) { set.display_name = clean(input.displayName, 100); if (!set.display_name) fail(400, 'displayName is required'); }
 if (input.companyName !== undefined) set.company_name = clean(input.companyName, 120) || null;
 if (input.phone !== undefined) { set.phone = clean(input.phone, 30); if (!/^[+\d][\d\s()-]{5,29}$/.test(set.phone)) fail(400, 'invalid phone'); }
 if (input.website !== undefined) set.website = validWebsite(input.website);
 const keys = Object.keys(set);
 if (!keys.length) return profile;
 db.prepare(`UPDATE partner_profiles SET ${keys.map(k => `${k}=?`).join(',')},updated_at=? WHERE id=?`).run(...keys.map(k => set[k]), now(), profile.id);
 return db.prepare('SELECT * FROM partner_profiles WHERE id=?').get(profile.id);
}
export function validWebsite(value) {
 if (value === null || value === undefined || value === '') return null;
 try {
  const u = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('bad');
  return u.toString().slice(0, 300);
 } catch { fail(400, 'invalid website URL'); }
}

export function addNote(db, actor, partnerId, note) {
 getProfileById(db, partnerId);
 const text = cleanMultiline(note, 2000);
 if (!text) fail(400, 'note is required');
 const id = newId();
 db.prepare('INSERT INTO partner_admin_notes (id,partner_id,author_id,author_name,note,created_at) VALUES (?,?,?,?,?,?)').run(id, partnerId, actor.id, actor.name, text, now());
 audit(db, {actor, action: 'PARTNER_NOTE_ADDED', entityType: 'partner', entityId: partnerId, partnerId});
 return {id, note: text};
}
export const listNotes = (db, partnerId) => db.prepare('SELECT id,author_name authorName,note,created_at createdAt FROM partner_admin_notes WHERE partner_id=? ORDER BY created_at DESC').all(partnerId);

export function partnerStats(db, partnerId) {
 const one = (sql, ...a) => db.prepare(sql).get(...a);
 const bucket = b => one('SELECT COALESCE(SUM(amount_minor),0) v FROM commission_ledger WHERE partner_id=? AND bucket=?', partnerId, b).v;
 return {
  clicks: one('SELECT COALESCE(SUM(click_count),0) v FROM referral_visits WHERE partner_id=? AND flagged=0', partnerId).v,
  referrals: one("SELECT COUNT(*) v FROM referrals WHERE partner_id=? AND status NOT IN ('rejected','cancelled')", partnerId).v,
  converted: one("SELECT COUNT(*) v FROM referrals WHERE partner_id=? AND status='converted'", partnerId).v,
  pendingMinor: bucket('pending'), availableMinor: bucket('available'), reservedMinor: bucket('reserved'), paidMinor: bucket('paid')
 };
}

export function listPartners(db, url) {
 const p = pageParams(url);
 const where = ['p.deleted_at IS NULL'], args = [];
 const q = clean(url.searchParams.get('q') || '', 80);
 if (q) { where.push('(p.display_name LIKE ? OR p.referral_code LIKE ? OR u.email LIKE ? OR u.username LIKE ?)'); const like = `%${q.replace(/[%_]/g, '')}%`; args.push(like, like, like, like); }
 const status = url.searchParams.get('status');
 if (status) { where.push('p.status=?'); args.push(status); }
 const plan = url.searchParams.get('plan');
 if (plan) { where.push('p.plan_id=?'); args.push(plan); }
 const total = db.prepare(`SELECT COUNT(*) n FROM partner_profiles p JOIN users u ON u.id=p.user_id WHERE ${where.join(' AND ')}`).get(...args).n;
 const sort = {name: 'p.display_name', created: 'p.created_at', status: 'p.status'}[url.searchParams.get('sort')] || 'p.created_at';
 const dir = url.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
 const rows = db.prepare(`SELECT p.*, u.email, u.username FROM partner_profiles p JOIN users u ON u.id=p.user_id WHERE ${where.join(' AND ')} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`).all(...args, p.limit, p.offset);
 return paged(rows.map(r => ({...hydrateProfile(db, r), email: r.email, username: r.username, stats: partnerStats(db, r.id)})), total, p);
}
export function getPartnerDetail(db, id) {
 const row = getProfileById(db, id);
 const user = db.prepare('SELECT id,username,name,email,email_verified_at FROM users WHERE id=?').get(row.user_id);
 return {
  ...hydrateProfile(db, row), user: {id: user.id, username: user.username, name: user.name, email: user.email, emailVerified: !!user.email_verified_at},
  stats: partnerStats(db, id), notes: listNotes(db, id),
  subscriptions: db.prepare('SELECT s.*, p.name_en plan_name_en, p.name_ar plan_name_ar FROM partner_subscriptions s JOIN partner_plans p ON p.id=s.plan_id WHERE s.partner_id=? ORDER BY s.started_at DESC').all(id)
   .map(s => ({id: s.id, planId: s.plan_id, planNameEn: s.plan_name_en, planNameAr: s.plan_name_ar, status: s.status, startedAt: s.started_at, endsAt: s.ends_at, priceMinor: s.price_minor, currency: s.currency, source: s.source})),
  links: db.prepare('SELECT id,code,label,status,is_default isDefault FROM referral_links WHERE partner_id=?').all(id)
 };
}

/** Marks lapsed subscriptions 'expired' and warns partners 7 days ahead. Idempotent. */
export function sweepSubscriptions(db, at = Date.now()) {
 return tx(db, () => {
  let expired = 0, warned = 0;
  for (const s of db.prepare("SELECT s.*, p.user_id FROM partner_subscriptions s JOIN partner_profiles p ON p.id=s.partner_id WHERE s.status IN ('trialing','active') AND s.ends_at IS NOT NULL").all()) {
   const end = Date.parse(s.ends_at);
   if (end < at) {
    db.prepare("UPDATE partner_subscriptions SET status='expired' WHERE id=?").run(s.id);
    notifyUser(db, s.user_id, 'plan_expired', {subscriptionId: s.id});
    audit(db, {actor: {id: null, role: 'system'}, action: 'PARTNER_SUBSCRIPTION_EXPIRED', entityType: 'subscription', entityId: s.id, partnerId: s.partner_id});
    expired++;
   } else if (end - at < 7 * 86400000 && !db.prepare("SELECT 1 FROM partner_notifications WHERE user_id=? AND kind='plan_expiring' AND params_json LIKE ?").get(s.user_id, `%${s.id}%`)) {
    notifyUser(db, s.user_id, 'plan_expiring', {subscriptionId: s.id, endsAt: s.ends_at});
    warned++;
   }
  }
  return {expired, warned};
 });
}

// ---- staff (partner managers) ---------------------------------------------------------------
export function listStaff(db) {
 return db.prepare('SELECT s.user_id userId, s.permissions_json, s.status, s.created_at createdAt, u.username, u.name, u.email FROM partner_staff s JOIN users u ON u.id=s.user_id ORDER BY s.created_at').all()
  .map(r => ({userId: r.userId, username: r.username, name: r.name, email: r.email, status: r.status, permissions: JSON.parse(r.permissions_json), createdAt: r.createdAt}));
}
export function upsertStaff(db, actor, {identity, permissions, status = 'active'}) {
 if (!Array.isArray(permissions) || permissions.some(p => !STAFF_PERMISSIONS.includes(p))) fail(400, 'invalid permissions');
 if (!['active', 'disabled'].includes(status)) fail(400, 'invalid status');
 const key = String(identity || '').trim().toLowerCase();
 const user = key.includes('@') ? db.prepare('SELECT id FROM users WHERE email=?').get(key) : db.prepare('SELECT id FROM users WHERE username=?').get(key);
 if (!user) fail(404, 'User not found');
 return tx(db, () => {
  const t = now();
  db.prepare("INSERT INTO partner_staff (user_id,role,permissions_json,status,created_by,created_at,updated_at) VALUES (?,'partner_manager',?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET permissions_json=excluded.permissions_json,status=excluded.status,updated_at=excluded.updated_at")
   .run(user.id, JSON.stringify([...new Set(permissions)]), status, actor.id, t, t);
  audit(db, {actor, action: 'PARTNER_STAFF_UPDATED', entityType: 'staff', entityId: user.id, detail: {permissions, status}});
  return user.id;
 });
}

// ---- invites (used when registration_mode = invite_only) -------------------------------------
export function createInvite(db, actor, {email = null, planId = null, note = null, expiresInDays = 30}) {
 if (planId) getPlan(db, planId);
 if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) fail(400, 'expiresInDays must be 1..365');
 const code = randomCode(12), id = newId();
 db.prepare('INSERT INTO partner_invites (id,code,email,plan_id,note,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(id, code, email ? String(email).trim().toLowerCase() : null, planId, clean(note || '', 300) || null, actor.id, now(), new Date(Date.now() + expiresInDays * 86400000).toISOString());
 audit(db, {actor, action: 'PARTNER_INVITE_CREATED', entityType: 'invite', entityId: id});
 return {id, code};
}
export const listInvites = db => db.prepare('SELECT id,code,email,plan_id planId,note,created_at createdAt,expires_at expiresAt,used_by usedBy,used_at usedAt FROM partner_invites ORDER BY created_at DESC LIMIT 200').all();
export function checkInvite(db, code, email) {
 const row = db.prepare('SELECT * FROM partner_invites WHERE code=?').get(String(code || '').toUpperCase());
 if (!row || row.used_at || (row.expires_at && Date.parse(row.expires_at) < Date.now())) fail(403, 'INVITE_INVALID');
 if (row.email && email && row.email !== String(email).toLowerCase()) fail(403, 'INVITE_INVALID');
 return row;
}
export function consumeInvite(db, inviteId, userId) {
 const r = db.prepare('UPDATE partner_invites SET used_by=?,used_at=? WHERE id=? AND used_at IS NULL').run(userId, now(), inviteId);
 if (r.changes !== 1) fail(403, 'INVITE_INVALID');
}
