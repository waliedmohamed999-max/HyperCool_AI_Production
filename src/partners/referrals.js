import {randomBytes} from 'node:crypto';
import {fail} from '../auth.js';
import {audit, clean, getSettings, newId, notifyStaff, notifyUser, now, pageParams, paged, randomCode, sha, tx} from './core.js';
import {effectivePartnerState, getPlanOrNull} from './plans.js';

// Referral tracking: link -> click (visit) -> registration (referral) -> conversion (payment).
// Attribution is decided on the server from a signed-in-independent visitor cookie, never from a
// value the browser can simply claim at signup.

export const LANDING_PATHS = ['/', '/partners', '/app'];
const UTM = /^[\w.\-+ ]{1,80}$/;
const cleanUtm = (v) => { if (v === undefined || v === null || v === '') return null; if (typeof v !== 'string' || !UTM.test(v)) fail(400, 'invalid UTM value'); return v; };
export const ipHash = ip => sha('frost-partners|' + String(ip || '')).slice(0, 32);

function uniqueLinkCode(db) {
 for (let i = 0; i < 20; i++) {
  const code = randomCode(8);
  if (!db.prepare('SELECT 1 FROM referral_links WHERE code=?').get(code) && !db.prepare('SELECT 1 FROM partner_profiles WHERE referral_code=?').get(code)) return code;
 }
 fail(500, 'could not allocate a referral code');
}
export const newReferralCode = uniqueLinkCode;

export function createDefaultLink(db, profile) {
 const id = newId();
 db.prepare("INSERT INTO referral_links (id,partner_id,campaign_id,code,label,landing_path,is_default,status,created_at) VALUES (?,?,NULL,?,?,?,1,'active',?)")
  .run(id, profile.id, profile.referral_code, profile.display_name, '/', now());
 return id;
}

const hydrateLink = (row, origin = '') => row && ({
 id: row.id, campaignId: row.campaign_id, code: row.code, label: row.label, landingPath: row.landing_path, isDefault: !!row.is_default, status: row.status,
 utm: {source: row.utm_source, medium: row.utm_medium, campaign: row.utm_campaign, term: row.utm_term, content: row.utm_content},
 url: `${origin}/r/${row.code}`, createdAt: row.created_at,
 stats: row.clicks === undefined ? undefined : {clicks: row.clicks || 0, uniqueVisitors: row.visitors || 0, registrations: row.registrations || 0, conversions: row.conversions || 0}
});

export function listLinks(db, partnerId, origin = '') {
 return db.prepare(`SELECT l.*,
   COALESCE((SELECT SUM(click_count) FROM referral_visits v WHERE v.link_id=l.id AND v.flagged=0),0) clicks,
   (SELECT COUNT(*) FROM referral_visits v WHERE v.link_id=l.id AND v.flagged=0) visitors,
   (SELECT COUNT(*) FROM referrals r WHERE r.link_id=l.id AND r.status NOT IN ('rejected','cancelled')) registrations,
   (SELECT COUNT(*) FROM referrals r WHERE r.link_id=l.id AND r.status='converted') conversions
  FROM referral_links l WHERE l.partner_id=? ORDER BY l.is_default DESC, l.created_at`).all(partnerId).map(row => hydrateLink(row, origin));
}
export function createLink(db, profile, input, origin = '') {
 const label = clean(input.label, 80);
 if (!label) fail(400, 'label is required');
 const landing = input.landingPath === undefined ? '/' : input.landingPath;
 if (!LANDING_PATHS.includes(landing)) fail(400, 'landingPath is not allowed');
 return tx(db, () => {
  let campaignId = null;
  if (input.campaignId) {
   const campaign = db.prepare("SELECT * FROM partner_campaigns WHERE id=? AND partner_id=? AND status='active'").get(input.campaignId, profile.id);
   if (!campaign) fail(404, 'Campaign not found');
   campaignId = campaign.id;
  }
  const count = db.prepare('SELECT COUNT(*) n FROM referral_links WHERE partner_id=?').get(profile.id).n;
  if (count >= 100) fail(409, 'link limit reached');
  const id = newId();
  db.prepare('INSERT INTO referral_links (id,partner_id,campaign_id,code,label,landing_path,utm_source,utm_medium,utm_campaign,utm_term,utm_content,is_default,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,\'active\',?)')
   .run(id, profile.id, campaignId, uniqueLinkCode(db), label, landing, cleanUtm(input.utmSource), cleanUtm(input.utmMedium), cleanUtm(input.utmCampaign), cleanUtm(input.utmTerm), cleanUtm(input.utmContent), now());
  audit(db, {actor: {id: profile.user_id, role: 'partner'}, action: 'REFERRAL_LINK_CREATED', entityType: 'referral_link', entityId: id, partnerId: profile.id});
  return hydrateLink(db.prepare('SELECT * FROM referral_links WHERE id=?').get(id), origin);
 });
}
export function updateLink(db, profile, id, input, origin = '') {
 const row = db.prepare('SELECT * FROM referral_links WHERE id=? AND partner_id=?').get(id, profile.id);
 if (!row) fail(404, 'Link not found');
 const label = input.label === undefined ? row.label : clean(input.label, 80);
 if (!label) fail(400, 'label is required');
 let status = row.status;
 if (input.status !== undefined) {
  if (!['active', 'disabled'].includes(input.status)) fail(400, 'invalid status');
  if (row.is_default && input.status === 'disabled') fail(409, 'the default link cannot be disabled');
  status = input.status;
 }
 db.prepare('UPDATE referral_links SET label=?,status=? WHERE id=?').run(label, status, id);
 return hydrateLink(db.prepare('SELECT * FROM referral_links WHERE id=?').get(id), origin);
}
export function listCampaigns(db, partnerId) {
 return db.prepare("SELECT c.*, (SELECT COUNT(*) FROM referral_links l WHERE l.campaign_id=c.id) links FROM partner_campaigns c WHERE c.partner_id=? AND c.status='active' ORDER BY c.created_at").all(partnerId)
  .map(r => ({id: r.id, name: r.name, links: r.links, createdAt: r.created_at}));
}
export function createCampaign(db, profile, input) {
 const name = clean(input.name, 80);
 if (!name) fail(400, 'name is required');
 if (db.prepare("SELECT COUNT(*) n FROM partner_campaigns WHERE partner_id=? AND status='active'").get(profile.id).n >= 50) fail(409, 'campaign limit reached');
 const id = newId();
 db.prepare('INSERT INTO partner_campaigns (id,partner_id,name,created_at) VALUES (?,?,?,?)').run(id, profile.id, name, now());
 return {id, name};
}

// ---- click tracking ------------------------------------------------------------------------
export function newVisitorId() { return randomBytes(24).toString('hex'); }
export function trackClick(db, {code, ip, userAgent, referrer, visitorId, query = {}}) {
 const normalized = String(code || '').toUpperCase();
 const link = db.prepare("SELECT * FROM referral_links WHERE code=? AND status='active'").get(normalized);
 if (!link) return null;
 const profile = db.prepare('SELECT * FROM partner_profiles WHERE id=? AND deleted_at IS NULL').get(link.partner_id);
 if (!profile || effectivePartnerState(db, profile).status !== 'active') return {link, tracked: false, visitorId: null};
 const settings = getSettings(db);
 const vid = /^[a-f0-9]{48}$/.test(visitorId || '') ? visitorId : newVisitorId();
 const iph = ipHash(ip);
 const utm = {source: safeUtm(query.utm_source) || link.utm_source, medium: safeUtm(query.utm_medium) || link.utm_medium, campaign: safeUtm(query.utm_campaign) || link.utm_campaign};
 return tx(db, () => {
  const t = now();
  const recent = db.prepare('SELECT COUNT(*) n FROM referral_visits WHERE ip_hash=? AND last_seen_at>? AND flagged=0').get(iph, new Date(Date.now() - 3600000).toISOString()).n;
  const flagged = recent >= settings.max_visits_per_ip_per_hour ? 1 : 0;
  const existing = db.prepare('SELECT * FROM referral_visits WHERE link_id=? AND visitor_id=?').get(link.id, vid);
  if (existing) {
   // A refresh or double-click within 30 minutes is the same click, not a new one.
   const fresh = Date.now() - Date.parse(existing.last_seen_at) < 30 * 60000;
   db.prepare('UPDATE referral_visits SET click_count=click_count+?,last_seen_at=? WHERE id=?').run(fresh ? 0 : 1, t, existing.id);
   return {link, tracked: !existing.flagged, visitorId: vid, visitId: existing.id};
  }
  const id = newId();
  db.prepare('INSERT INTO referral_visits (id,link_id,partner_id,campaign_id,visitor_id,ip_hash,ua_hash,referrer,landing_page,utm_source,utm_medium,utm_campaign,click_count,flagged,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)')
   .run(id, link.id, link.partner_id, link.campaign_id, vid, iph, userAgent ? sha(userAgent).slice(0, 16) : null, referrer ? String(referrer).slice(0, 300) : null, link.landing_path, utm.source, utm.medium, utm.campaign, flagged, t, t);
  if (flagged) notifyStaff(db, {}, 'partners', 'suspicious_activity', {partnerId: link.partner_id, reason: 'visit_rate'});
  return {link, tracked: !flagged, visitorId: vid, visitId: id};
 });
}
const safeUtm = v => (typeof v === 'string' && UTM.test(v)) ? v : null;

// ---- registration attribution --------------------------------------------------------------
/**
 * Called once when a new account is created. Decides (server-side) whether the registration is
 * credited to a partner. Returns the referral row or null. Every rejection that is worth an
 * audit trail is stored as a 'rejected' referral with a reason.
 */
export function attributeRegistration(db, env, {userId, email, visitorId, ip}) {
 if (!/^[a-f0-9]{48}$/.test(visitorId || '')) return null;
 const settings = getSettings(db);
 return tx(db, () => {
  if (db.prepare('SELECT 1 FROM referrals WHERE referred_user_id=?').get(userId)) return null;
  const since = new Date(Date.now() - settings.attribution_window_days * 86400000).toISOString();
  const visit = db.prepare('SELECT * FROM referral_visits WHERE visitor_id=? AND flagged=0 AND last_seen_at>=? ORDER BY last_seen_at DESC LIMIT 1').get(visitorId, since);
  if (!visit) return null;
  const profile = db.prepare('SELECT * FROM partner_profiles WHERE id=? AND deleted_at IS NULL').get(visit.partner_id);
  if (!profile || effectivePartnerState(db, profile).status !== 'active') return null;
  const link = db.prepare('SELECT * FROM referral_links WHERE id=?').get(visit.link_id);
  const iph = ipHash(ip), t = now();
  const partnerUser = db.prepare('SELECT id,email FROM users WHERE id=?').get(profile.user_id);
  let status = 'registered', reason = null;
  if (settings.block_self_referral && (partnerUser.id === userId || (partnerUser.email && email && partnerUser.email.toLowerCase() === String(email).toLowerCase()))) { status = 'rejected'; reason = 'self_referral'; }
  else {
   const perDay = db.prepare('SELECT COUNT(*) n FROM referrals WHERE ip_hash=? AND created_at>?').get(iph, new Date(Date.now() - 86400000).toISOString()).n;
   if (perDay >= settings.max_registrations_per_ip_per_day) { status = 'rejected'; reason = 'suspicious_volume'; }
   else {
    const plan = getPlanOrNull(db, profile.plan_id);
    if (plan && plan.maxReferrals !== null) {
     const used = db.prepare("SELECT COUNT(*) n FROM referrals WHERE partner_id=? AND status NOT IN ('rejected','cancelled')").get(profile.id).n;
     if (used >= plan.maxReferrals) { status = 'rejected'; reason = 'plan_limit_reached'; }
    }
   }
  }
  const id = newId();
  db.prepare('INSERT INTO referrals (id,partner_id,link_id,campaign_id,visit_id,visitor_id,referred_user_id,source,medium,campaign,landing_page,first_clicked_at,registered_at,status,reject_reason,ip_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(id, profile.id, link?.id || null, visit.campaign_id, visit.id, visitorId, userId, visit.utm_source, visit.utm_medium, visit.utm_campaign, visit.landing_page, visit.first_seen_at, t, status, reason, iph, t, t);
  audit(db, {actor: {id: userId, role: 'user'}, action: status === 'rejected' ? 'REFERRAL_REJECTED' : 'REFERRAL_REGISTERED', entityType: 'referral', entityId: id, partnerId: profile.id, detail: {reason}});
  if (status === 'registered') notifyUser(db, profile.user_id, 'referral_registered', {});
  else if (reason === 'suspicious_volume') notifyStaff(db, env, 'partners', 'suspicious_activity', {partnerId: profile.id, reason});
  else if (reason === 'plan_limit_reached') notifyUser(db, profile.user_id, 'referral_plan_limit', {});
  return db.prepare('SELECT * FROM referrals WHERE id=?').get(id);
 });
}
/** Email verified -> a registered referral becomes 'qualified'. */
export function markReferralQualified(db, userId) {
 db.prepare("UPDATE referrals SET status='qualified',qualified_at=?,updated_at=? WHERE referred_user_id=? AND status='registered'").run(now(), now(), userId);
}

// ---- partner-facing lists (privacy-preserving) --------------------------------------------
const maskEmail = email => { if (!email) return null; const [name, domain] = String(email).split('@'); return `${name.slice(0, 1)}***@${(domain || '').slice(0, 1)}***`; };
const maskName = name => { const t = String(name || '').trim(); return t ? `${t.slice(0, 1)}${'*'.repeat(Math.min(6, Math.max(2, t.length - 1)))}` : null; };

export function listReferralsForPartner(db, partnerId, url) {
 const p = pageParams(url);
 const status = url.searchParams.get('status');
 const where = ['r.partner_id=?'], args = [partnerId];
 if (status) { where.push('r.status=?'); args.push(status); }
 const from = url.searchParams.get('from'), to = url.searchParams.get('to');
 if (from) { where.push('r.registered_at>=?'); args.push(from); }
 if (to) { where.push('r.registered_at<=?'); args.push(to); }
 const total = db.prepare(`SELECT COUNT(*) n FROM referrals r WHERE ${where.join(' AND ')}`).get(...args).n;
 const rows = db.prepare(`SELECT r.*, u.name customer_name, u.email customer_email, l.label link_label,
   COALESCE((SELECT SUM(c.gross_minor) FROM commissions c WHERE c.referral_id=r.id AND c.status NOT IN ('cancelled','rejected')),0) gross_minor,
   COALESCE((SELECT SUM(c.commission_minor) FROM commissions c WHERE c.referral_id=r.id AND c.status NOT IN ('cancelled','rejected')),0) commission_minor
  FROM referrals r JOIN users u ON u.id=r.referred_user_id LEFT JOIN referral_links l ON l.id=r.link_id
  WHERE ${where.join(' AND ')} ORDER BY r.registered_at DESC LIMIT ? OFFSET ?`).all(...args, p.limit, p.offset);
 return paged(rows.map(r => ({
  id: r.id, status: r.status, rejectReason: r.reject_reason, customerName: maskName(r.customer_name), customerEmail: maskEmail(r.customer_email),
  link: r.link_label, source: r.source, medium: r.medium, campaign: r.campaign,
  clickedAt: r.first_clicked_at, registeredAt: r.registered_at, qualifiedAt: r.qualified_at, convertedAt: r.converted_at,
  grossMinor: r.gross_minor, commissionMinor: r.commission_minor
 })), total, p);
}
