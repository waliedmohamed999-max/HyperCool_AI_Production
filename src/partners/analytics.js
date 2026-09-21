import {balances} from './commissions.js';
import {listLinks} from './referrals.js';

// Real numbers only: everything below is an aggregate over tracked rows. No estimates, no
// placeholder series - a partner with no activity gets zeros and empty arrays.

const iso = ms => new Date(ms).toISOString();
const dayKey = value => String(value).slice(0, 10);
function fillDays(days, rows, valueKey) {
 const map = new Map(rows.map(r => [r.day, r[valueKey]]));
 const out = [];
 const end = Date.now();
 for (let i = days - 1; i >= 0; i--) { const day = dayKey(iso(end - i * 86400000)); out.push({day, value: map.get(day) || 0}); }
 return out;
}

export function partnerDashboard(db, profile, {days = 30, origin = ''} = {}) {
 const range = [7, 30, 90].includes(days) ? days : 30;
 const since = iso(Date.now() - range * 86400000);
 const one = (sql, ...a) => db.prepare(sql).get(...a);
 const clicksTotal = one('SELECT COALESCE(SUM(click_count),0) v FROM referral_visits WHERE partner_id=? AND flagged=0', profile.id).v;
 const uniqueVisitors = one('SELECT COUNT(*) v FROM referral_visits WHERE partner_id=? AND flagged=0', profile.id).v;
 const registered = one("SELECT COUNT(*) v FROM referrals WHERE partner_id=? AND status NOT IN ('rejected','cancelled')", profile.id).v;
 const converted = one("SELECT COUNT(*) v FROM referrals WHERE partner_id=? AND status='converted'", profile.id).v;
 const bal = balances(db, profile.id);
 const earned = one("SELECT COALESCE(SUM(commission_minor),0) v FROM commissions WHERE partner_id=? AND status NOT IN ('rejected','cancelled')", profile.id).v;
 const approvedMinor = one("SELECT COALESCE(SUM(commission_minor),0) v FROM commissions WHERE partner_id=? AND status IN ('approved','available','paid')", profile.id).v;
 const perDay = (sql, key) => fillDays(range, db.prepare(sql).all(profile.id, since), key);
 return {
  range,
  totals: {
   clicks: clicksTotal, uniqueVisitors, referrals: registered, registered, paidCustomers: converted,
   conversionBps: registered ? Math.round(converted * 10000 / registered) : 0,
   commissionsTotalMinor: earned, commissionsPendingMinor: bal.pendingMinor, commissionsApprovedMinor: approvedMinor,
   withdrawableMinor: bal.withdrawableMinor, reservedMinor: bal.reservedMinor, withdrawnMinor: bal.paidMinor
  },
  series: {
   visitors: perDay("SELECT substr(first_seen_at,1,10) day, COUNT(*) v FROM referral_visits WHERE partner_id=? AND flagged=0 AND first_seen_at>=? GROUP BY day", 'v'),
   registrations: perDay("SELECT substr(registered_at,1,10) day, COUNT(*) v FROM referrals WHERE partner_id=? AND status NOT IN ('rejected','cancelled') AND registered_at>=? GROUP BY day", 'v'),
   commissions: perDay("SELECT substr(created_at,1,10) day, COALESCE(SUM(commission_minor),0) v FROM commissions WHERE partner_id=? AND status NOT IN ('rejected','cancelled') AND created_at>=? GROUP BY day", 'v')
  },
  topLinks: listLinks(db, profile.id, origin).filter(l => l.stats && (l.stats.clicks || l.stats.registrations)).sort((a, b) => b.stats.registrations - a.stats.registrations || b.stats.clicks - a.stats.clicks).slice(0, 5),
  recentReferrals: db.prepare("SELECT status, registered_at registeredAt FROM referrals WHERE partner_id=? ORDER BY registered_at DESC LIMIT 5").all(profile.id)
 };
}

export function adminOverview(db) {
 const one = (sql, ...a) => db.prepare(sql).get(...a);
 const sum = (bucket) => one('SELECT COALESCE(SUM(amount_minor),0) v FROM commission_ledger WHERE bucket=?', bucket).v;
 return {
  partners: {
   total: one('SELECT COUNT(*) v FROM partner_profiles WHERE deleted_at IS NULL').v,
   active: one("SELECT COUNT(*) v FROM partner_profiles WHERE status='active' AND deleted_at IS NULL").v,
   suspended: one("SELECT COUNT(*) v FROM partner_profiles WHERE status='suspended' AND deleted_at IS NULL").v
  },
  applications: {
   pending: one("SELECT COUNT(*) v FROM partner_applications WHERE status='pending'").v,
   underReview: one("SELECT COUNT(*) v FROM partner_applications WHERE status='under_review'").v,
   needsInformation: one("SELECT COUNT(*) v FROM partner_applications WHERE status='needs_information'").v
  },
  referrals: {
   total: one("SELECT COUNT(*) v FROM referrals WHERE status NOT IN ('rejected','cancelled')").v,
   converted: one("SELECT COUNT(*) v FROM referrals WHERE status='converted'").v,
   clicks: one('SELECT COALESCE(SUM(click_count),0) v FROM referral_visits WHERE flagged=0').v
  },
  commissions: {
   needsReview: one("SELECT COUNT(*) v FROM commissions WHERE status='pending'").v,
   pendingMinor: sum('pending'), availableMinor: sum('available'), reservedMinor: sum('reserved'), paidMinor: sum('paid')
  },
  payouts: {
   open: one("SELECT COUNT(*) v FROM payout_requests WHERE status IN ('requested','under_review','approved','processing')").v,
   openMinor: one("SELECT COALESCE(SUM(amount_minor),0) v FROM payout_requests WHERE status IN ('requested','under_review','approved','processing')").v
  },
  topPartners: db.prepare(`SELECT p.id, p.display_name name,
     (SELECT COUNT(*) FROM referrals r WHERE r.partner_id=p.id AND r.status='converted') converted,
     COALESCE((SELECT SUM(commission_minor) FROM commissions c WHERE c.partner_id=p.id AND c.status NOT IN ('rejected','cancelled')),0) earnedMinor
    FROM partner_profiles p WHERE p.deleted_at IS NULL ORDER BY earnedMinor DESC, converted DESC LIMIT 5`).all().filter(r => r.earnedMinor > 0 || r.converted > 0)
 };
}
