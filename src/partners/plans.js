import {fail} from '../auth.js';
import {ENTITLEMENTS, LIMITED_ENTITLEMENTS, audit, clean, cleanMultiline, assertCurrency, newId, now, tx, getSettings} from './core.js';

// Partner plans: the single source of truth for what a partner tier costs, pays and unlocks.
// (Workspace/customer pricing tiers are a separate concern - see docs/PARTNERS.md.) Feature access
// is ALWAYS resolved through entitlementsFor(), never from a plan's name.

const hydrate = row => row && ({
 id: row.id, slug: row.slug, planType: row.plan_type,
 nameAr: row.name_ar, nameEn: row.name_en, descriptionAr: row.description_ar, descriptionEn: row.description_en,
 priceMinor: row.price_minor, currency: row.currency, billingPeriod: row.billing_period, status: row.status,
 sortOrder: row.sort_order, highlighted: !!row.highlighted,
 defaultCommissionBps: row.default_commission_bps, commissionDurationDays: row.commission_duration_days,
 commissionHoldDays: row.commission_hold_days, minPayoutMinor: row.min_payout_minor,
 maxTeamMembers: row.max_team_members, maxReferrals: row.max_referrals,
 entitlements: JSON.parse(row.entitlements_json || '[]'), lockedFeatures: ENTITLEMENTS.filter(e => !JSON.parse(row.entitlements_json || '[]').includes(e)),
 trialDays: row.trial_days, createdAt: row.created_at, updatedAt: row.updated_at
});

function intOrNull(value, label, {min = 0, max = 1e9} = {}) {
 if (value === null || value === undefined || value === '') return null;
 if (!Number.isInteger(value) || value < min || value > max) fail(400, `${label} is invalid`);
 return value;
}
function validatePlanInput(input, {partial = false} = {}) {
 const out = {};
 const need = (key, present) => { if (!partial && !present) fail(400, `${key} is required`); };
 if (!partial || input.slug !== undefined) { need('slug', input.slug); if (input.slug !== undefined) { if (typeof input.slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,39}$/.test(input.slug)) fail(400, 'slug must be 2-40 lowercase letters, digits, - or _'); out.slug = input.slug; } }
 for (const key of ['nameAr', 'nameEn']) if (!partial || input[key] !== undefined) { need(key, clean(input[key], 120)); if (input[key] !== undefined) { out[key] = clean(input[key], 120); if (!out[key]) fail(400, `${key} is required`); } }
 for (const key of ['descriptionAr', 'descriptionEn']) if (input[key] !== undefined) out[key] = cleanMultiline(input[key], 2000);
 if (!partial || input.priceMinor !== undefined) { need('priceMinor', input.priceMinor !== undefined); if (input.priceMinor !== undefined) out.priceMinor = intOrNull(input.priceMinor, 'priceMinor', {min: 0}); }
 if (input.currency !== undefined) out.currency = assertCurrency(input.currency);
 if (input.billingPeriod !== undefined) { if (!['free', 'monthly', 'yearly', 'one_time'].includes(input.billingPeriod)) fail(400, 'billingPeriod is invalid'); out.billingPeriod = input.billingPeriod; }
 if (input.status !== undefined) { if (!['active', 'inactive', 'archived'].includes(input.status)) fail(400, 'status is invalid'); out.status = input.status; }
 if (input.sortOrder !== undefined) out.sortOrder = intOrNull(input.sortOrder, 'sortOrder', {min: -1000, max: 1000}) ?? 0;
 if (input.highlighted !== undefined) out.highlighted = input.highlighted ? 1 : 0;
 if (!partial || input.defaultCommissionBps !== undefined) { need('defaultCommissionBps', input.defaultCommissionBps !== undefined); if (input.defaultCommissionBps !== undefined) out.defaultCommissionBps = intOrNull(input.defaultCommissionBps, 'defaultCommissionBps', {min: 0, max: 10000}); }
 if (input.commissionDurationDays !== undefined) out.commissionDurationDays = intOrNull(input.commissionDurationDays, 'commissionDurationDays', {min: 1, max: 3650});
 if (input.commissionHoldDays !== undefined) out.commissionHoldDays = intOrNull(input.commissionHoldDays, 'commissionHoldDays', {min: 0, max: 365});
 if (input.minPayoutMinor !== undefined) out.minPayoutMinor = intOrNull(input.minPayoutMinor, 'minPayoutMinor', {min: 0});
 if (input.maxTeamMembers !== undefined) out.maxTeamMembers = intOrNull(input.maxTeamMembers, 'maxTeamMembers', {min: 0, max: 1000});
 if (input.maxReferrals !== undefined) out.maxReferrals = intOrNull(input.maxReferrals, 'maxReferrals', {min: 0});
 if (input.trialDays !== undefined) out.trialDays = intOrNull(input.trialDays, 'trialDays', {min: 0, max: 365}) ?? 0;
 if (input.entitlements !== undefined) {
  if (!Array.isArray(input.entitlements) || input.entitlements.some(e => !ENTITLEMENTS.includes(e))) fail(400, 'entitlements contains an unknown key');
  out.entitlements = [...new Set(input.entitlements)];
 }
 return out;
}

export function listPlans(db, {publicOnly = false, includeArchived = false} = {}) {
 const rows = publicOnly
  ? db.prepare("SELECT * FROM partner_plans WHERE status='active' ORDER BY sort_order,created_at").all()
  : db.prepare(includeArchived ? 'SELECT * FROM partner_plans ORDER BY sort_order,created_at' : "SELECT * FROM partner_plans WHERE status!='archived' ORDER BY sort_order,created_at").all();
 return rows.map(hydrate);
}
export function getPlan(db, id) {
 const plan = hydrate(db.prepare('SELECT * FROM partner_plans WHERE id=?').get(id));
 if (!plan) fail(404, 'Plan not found');
 return plan;
}
export function getPlanOrNull(db, id) { return id ? hydrate(db.prepare('SELECT * FROM partner_plans WHERE id=?').get(id)) : null; }

export function createPlan(db, actor, input) {
 const v = validatePlanInput(input);
 if (v.priceMinor > 0 && (v.billingPeriod || 'monthly') === 'free') fail(400, 'a free plan cannot have a price');
 return tx(db, () => {
  if (db.prepare('SELECT id FROM partner_plans WHERE slug=?').get(v.slug)) fail(409, 'slug already used');
  const id = newId(), t = now();
  db.prepare(`INSERT INTO partner_plans (id,slug,name_ar,name_en,description_ar,description_en,price_minor,currency,billing_period,status,sort_order,highlighted,default_commission_bps,commission_duration_days,commission_hold_days,min_payout_minor,max_team_members,max_referrals,entitlements_json,trial_days,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, v.slug, v.nameAr, v.nameEn, v.descriptionAr || '', v.descriptionEn || '', v.priceMinor, v.currency || getSettings(db).default_currency,
   v.billingPeriod || (v.priceMinor === 0 ? 'free' : 'monthly'), v.status || 'active', v.sortOrder ?? 0, v.highlighted ?? 0, v.defaultCommissionBps, v.commissionDurationDays ?? null, v.commissionHoldDays ?? null,
   v.minPayoutMinor ?? null, v.maxTeamMembers ?? null, v.maxReferrals ?? null, JSON.stringify(v.entitlements || []), v.trialDays ?? 0, t, t);
  audit(db, {actor, action: 'PARTNER_PLAN_CREATED', entityType: 'plan', entityId: id, detail: {slug: v.slug}});
  return getPlan(db, id);
 });
}
const COLUMN = {slug: 'slug', nameAr: 'name_ar', nameEn: 'name_en', descriptionAr: 'description_ar', descriptionEn: 'description_en', priceMinor: 'price_minor', currency: 'currency', billingPeriod: 'billing_period', status: 'status', sortOrder: 'sort_order', highlighted: 'highlighted', defaultCommissionBps: 'default_commission_bps', commissionDurationDays: 'commission_duration_days', commissionHoldDays: 'commission_hold_days', minPayoutMinor: 'min_payout_minor', maxTeamMembers: 'max_team_members', maxReferrals: 'max_referrals', trialDays: 'trial_days'};
export function updatePlan(db, actor, id, input) {
 const v = validatePlanInput(input, {partial: true});
 return tx(db, () => {
  const before = getPlan(db, id);
  if (v.slug && v.slug !== before.slug && db.prepare('SELECT id FROM partner_plans WHERE slug=?').get(v.slug)) fail(409, 'slug already used');
  const sets = [], values = [];
  for (const [key, value] of Object.entries(v)) {
   if (key === 'entitlements') { sets.push('entitlements_json=?'); values.push(JSON.stringify(value)); continue; }
   sets.push(`${COLUMN[key]}=?`); values.push(value);
  }
  if (!sets.length) return before;
  sets.push('updated_at=?'); values.push(now(), id);
  db.prepare(`UPDATE partner_plans SET ${sets.join(',')} WHERE id=?`).run(...values);
  const after = getPlan(db, id);
  if (after.priceMinor > 0 && after.billingPeriod === 'free') fail(400, 'a free plan cannot have a price');
  audit(db, {actor, action: 'PARTNER_PLAN_UPDATED', entityType: 'plan', entityId: id, detail: {changed: Object.keys(v)}});
  return after;
 });
}
export function planSubscriberCounts(db) {
 const out = {};
 for (const row of db.prepare("SELECT plan_id, COUNT(*) n FROM partner_profiles WHERE deleted_at IS NULL AND plan_id IS NOT NULL AND status!='closed' GROUP BY plan_id").all()) out[row.plan_id] = row.n;
 return out;
}

// ---- subscription state + entitlements -------------------------------------------------------
/** The partner's current subscription row (latest that has not been cancelled), or null. */
export function currentSubscription(db, partnerId) {
 return db.prepare("SELECT * FROM partner_subscriptions WHERE partner_id=? AND status!='cancelled' ORDER BY started_at DESC, created_at DESC LIMIT 1").get(partnerId) || null;
}
/** Effective standing = stored status downgraded to 'limited' when the paid period has run out. */
export function effectivePartnerState(db, profile, at = Date.now()) {
 const sub = currentSubscription(db, profile.id);
 let planExpired = false;
 if (sub && sub.ends_at && Date.parse(sub.ends_at) < at) planExpired = true;
 if (sub && sub.status === 'expired') planExpired = true;
 if (sub && sub.status === 'past_due') planExpired = true;
 if (!sub && profile.plan_id) planExpired = false;
 const status = profile.status === 'active' && planExpired ? 'limited' : profile.status;
 return {status, planExpired, subscription: sub};
}
export function entitlementsFor(db, profile, at = Date.now()) {
 const state = effectivePartnerState(db, profile, at);
 if (state.status === 'suspended' || state.status === 'closed') return [];
 const plan = getPlanOrNull(db, profile.plan_id);
 const full = plan ? plan.entitlements : [];
 if (state.status === 'limited') return full.filter(e => LIMITED_ENTITLEMENTS.includes(e));
 return full;
}
export function requireEntitlement(db, profile, key) {
 if (!ENTITLEMENTS.includes(key)) throw new Error(`unknown entitlement ${key}`);
 const state = effectivePartnerState(db, profile);
 if (!entitlementsFor(db, profile).includes(key)) {
  const reason = state.status === 'suspended' ? 'PARTNER_SUSPENDED' : state.status === 'closed' ? 'PARTNER_CLOSED' : state.planExpired || state.status === 'limited' ? 'PLAN_EXPIRED' : 'ENTITLEMENT_REQUIRED';
  throw Object.assign(new Error(reason), {status: 403, code: reason, entitlement: key});
 }
}
