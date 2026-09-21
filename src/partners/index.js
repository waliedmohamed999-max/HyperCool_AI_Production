import {installPartners} from './schema.js';
import {ensurePartnerMailKind} from './mail.js';
import {createPlan, listPlans} from './plans.js';
import {releaseDueCommissions} from './commissions.js';
import {sweepSubscriptions} from './partners.js';

export {installPartners, uninstallPartners} from './schema.js';

// Starter tiers are assigned by the platform team (price 0), not bought: Frost has no partner
// checkout yet. Names, rates and entitlements are ordinary rows the admin can edit or replace.
const SEED_PLANS = [
 {slug: 'starter', nameAr: 'المبتدئ', nameEn: 'Starter', descriptionAr: 'ابدأ بالإحالات وتتبّع العمولات من لوحة واحدة.', descriptionEn: 'Start referring and track commissions from one dashboard.', priceMinor: 0, billingPeriod: 'free', defaultCommissionBps: 2000, sortOrder: 1,
  entitlements: ['partner.dashboard', 'partner.referrals', 'partner.customers', 'partner.commissions', 'partner.payouts']},
 {slug: 'professional', nameAr: 'المحترف', nameEn: 'Professional', descriptionAr: 'عمولة أعلى ومركز مواد تسويقية وتحليلات وتصدير البيانات.', descriptionEn: 'Higher commission plus the marketing assets center, analytics and data export.', priceMinor: 0, billingPeriod: 'free', defaultCommissionBps: 2500, sortOrder: 2, highlighted: true,
  entitlements: ['partner.dashboard', 'partner.referrals', 'partner.customers', 'partner.commissions', 'partner.payouts', 'partner.marketing_assets', 'partner.analytics', 'partner.export_data']},
 {slug: 'elite', nameAr: 'النخبة', nameEn: 'Elite', descriptionAr: 'أعلى عمولة مع هوية مخصّصة وفريق عمل.', descriptionEn: 'Top commission with custom branding and team members.', priceMinor: 0, billingPeriod: 'free', defaultCommissionBps: 3000, sortOrder: 3, maxTeamMembers: 5,
  entitlements: ['partner.dashboard', 'partner.referrals', 'partner.customers', 'partner.commissions', 'partner.payouts', 'partner.marketing_assets', 'partner.analytics', 'partner.export_data', 'partner.custom_branding', 'partner.team_members']}
];

/** Idempotent boot hook: schema, mail-kind migration, and the editable starter plans (only when none exist). */
export function installPartnerProgram(db) {
 installPartners(db);
 ensurePartnerMailKind(db);
 if (!db.prepare('SELECT 1 FROM partner_plans LIMIT 1').get()) {
  for (const plan of SEED_PLANS) createPlan(db, {id: null, name: 'system', role: 'system'}, plan);
 }
}

const lastRun = new WeakMap();
/** Cheap, idempotent: release commissions whose hold ended and expire lapsed plan periods. */
export function runPartnerMaintenance(db, {force = false} = {}) {
 const t = Date.now();
 if (!force && t - (lastRun.get(db) || 0) < 30000) return null;
 lastRun.set(db, t);
 return {released: releaseDueCommissions(db), subscriptions: sweepSubscriptions(db)};
}
export {listPlans};
