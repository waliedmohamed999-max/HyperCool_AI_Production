import {fail} from '../auth.js';
import {recordPlatformAudit, registerPublicUser, checkSignupRateLimit} from '../platform-identity.js';
import {sendVerificationEmail, platformMailStatus} from '../runtime/platform-mail.js';
import {checkGlobalSignupLimit} from '../runtime/pilot-limits.js';
import {captchaRequiredFor, verifyBotProtection} from '../runtime/bot-protection.js';
import {encryptionConfigured} from '../runtime/crypto.js';
import {randomUUID} from 'node:crypto';
import {PAYOUT_METHOD_TYPES, STAFF_PERMISSIONS, getSettings, isEmail, newId, now, saveSettings, toBps, toMinor, tx} from './core.js';
import {actorOf, partnerContext, requireAdmin, requireManager, requirePartner, requireSession} from './access.js';
import {ENTITLEMENTS} from './core.js';
import {createPlan, getPlan, listPlans, planSubscriberCounts, requireEntitlement, updatePlan} from './plans.js';
import {addNote, assignPlan, checkInvite, createInvite, getPartnerDetail, getProfileById, hydrateProfile, listInvites, listPartners, listStaff, regenerateReferralCode, setCustomCommission, setPartnerStatus, updateOwnProfile, upsertStaff} from './partners.js';
import {decide, getApplication, latestApplicationForUser, listApplications, respondToInformationRequest, submitApplication, validateApplication} from './applications.js';
import {attributeRegistration, createCampaign, createLink, listCampaigns, listLinks, listReferralsForPartner, trackClick, updateLink} from './referrals.js';
import {balances, cancelReferral, decideCommission, ledgerFor, listBillingEvents, listCommissions, recordBillingEvent, verifyBillingSignature} from './commissions.js';
import {addMethod, cancelPayout, decidePayout, deleteMethod, getPayoutAdmin, getReceipt, listMethods, listPayouts, requestPayout, revealPayoutDetails, saveReceipt, setDefaultMethod} from './payouts.js';
import {createAsset, getAssetFile, listAssetsAdmin, listAssetsForPartner, saveAssetFile, updateAsset} from './assets.js';
import {adminOverview, partnerDashboard} from './analytics.js';
import {sendPartnerMail} from './mail.js';
import {runPartnerMaintenance} from './index.js';

// HTTP surface of the partner program. Mounted by application.js BEFORE the workspace pipeline
// (a partner may have no workspace at all), so this file owns its own authentication, CSRF and
// authorization: the partner id ALWAYS comes from the server session, never from the client.

export const PORTAL_PAGES = ['/partners', '/partners/login', '/partners/register', '/partners/onboarding', '/partners/dashboard', '/partners/referrals', '/partners/customers', '/partners/commissions', '/partners/payouts', '/partners/marketing', '/partners/settings'];
const COOKIE = 'frost_ref';
const cookieOf = (req, name) => req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) || null;
const clientIp = (req, env) => (env.PUBLIC_ORIGIN ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '';
const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
async function readBinary(req, max) {
 const chunks = []; let size = 0;
 for await (const c of req) { size += c.length; if (size > max) fail(413, 'File too large'); chunks.push(c); }
 return Buffer.concat(chunks);
}
const decodeName = v => { try { return decodeURIComponent(String(v || '')); } catch { return ''; } };
const forceParam = (url, key, value) => { const u = new URL(url); u.searchParams.set(key, value); return u; };
// The browser sends human units ("25", "120.50"); the server converts to bps / minor units.
function normalizePlanInput(i) {
 const o = {...i};
 if (o.price !== undefined) { o.priceMinor = toMinor(o.price, 'price'); delete o.price; }
 if (o.commissionPercent !== undefined) { o.defaultCommissionBps = toBps(o.commissionPercent, 'commission'); delete o.commissionPercent; }
 if (o.minPayout !== undefined) { o.minPayoutMinor = o.minPayout === '' || o.minPayout === null ? null : toMinor(o.minPayout, 'minPayout'); delete o.minPayout; }
 for (const k of ['commissionDurationDays', 'commissionHoldDays', 'maxTeamMembers', 'maxReferrals']) if (o[k] === '') o[k] = null;
 return o;
}
function normalizeSettingsInput(i) {
 const o = {...i};
 if (o.min_payout !== undefined) { o.min_payout_minor = toMinor(o.min_payout, 'min_payout'); delete o.min_payout; }
 return o;
}
const customBps = i => (i.customCommissionPercent === undefined ? undefined : i.customCommissionPercent === '' || i.customCommissionPercent === null ? null : toBps(i.customCommissionPercent, 'commission'));
const withParam = (url, key, value) => { const u = new URL(url); if (!u.searchParams.get(key)) u.searchParams.set(key, value); return u; };

export function createPartnerRoutes({store, env, auth, fetcher, readJson, secureCookie}) {
 const db = store.db;
 const mailCtx = () => ({db, env, fetcher});
 const publicSettings = () => {
  const s = getSettings(db);
  return {registrationMode: s.registration_mode, attributionWindowDays: s.attribution_window_days, commissionHoldDays: s.commission_hold_days, minPayoutMinor: s.min_payout_minor, currency: s.default_currency, payoutMethods: s.payout_methods, termsVersion: s.terms_version, termsAr: s.terms_ar, termsEn: s.terms_en};
 };
 const sessionCookie = result => `hc_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie}`;

 return async function handle(req, res, url, session, {send, baseUrl}) {
  const path = url.pathname;
  const method = req.method;
  const isPartnerApi = path.startsWith('/api/partners/') || path === '/api/partners';
  const isRedirect = method === 'GET' && /^\/r\/[A-Za-z0-9]{4,16}$/.test(path);
  const isWebhook = method === 'POST' && path === '/api/webhooks/partner-billing';
  if (!isPartnerApi && !isRedirect && !isWebhook) return false;
  runPartnerMaintenance(db);

  // ---- public: referral link click -----------------------------------------------------------------
  if (isRedirect) {
   const code = path.slice(3);
   const tracked = trackClick(db, {code, ip: clientIp(req, env), userAgent: req.headers['user-agent'], referrer: req.headers.referer, visitorId: cookieOf(req, COOKIE), query: Object.fromEntries(url.searchParams)});
   const headers = {Location: tracked?.link?.landing_path || '/', 'Cache-Control': 'no-store'};
   if (tracked?.tracked && tracked.visitorId) {
    headers['Set-Cookie'] = `${COOKIE}=${tracked.visitorId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${getSettings(db).attribution_window_days * 86400}${secureCookie}`;
   }
   res.writeHead(302, headers);
   res.end();
   return true;
  }

  // ---- public: billing webhook (authenticity = HMAC of the raw body) -----------------------------------
  if (isWebhook) {
   if (!env.PARTNER_BILLING_WEBHOOK_SECRET) fail(503, 'PARTNER_BILLING_WEBHOOK_NOT_CONFIGURED');
   const raw = (await readBinary(req, 100000)).toString('utf8');
   if (!verifyBillingSignature(raw, req.headers['x-frost-signature'], env.PARTNER_BILLING_WEBHOOK_SECRET)) fail(401, 'INVALID_SIGNATURE');
   let p; try { p = JSON.parse(raw); } catch { fail(400, 'invalid JSON'); }
   const r = recordBillingEvent(db, env, null, 'webhook', {externalId: p.id, type: p.type, customerEmail: p.customer?.email, customerUserId: p.customer?.userId, planRef: p.planRef, amountMinor: p.amountMinor, currency: p.currency, occurredAt: p.occurredAt, refersToExternalId: p.refersTo});
   send(200, {received: true, duplicate: r.duplicate, result: r.event.result});
   return true;
  }

  // ---- public: plans + settings for the landing page -------------------------------------------------
  if (method === 'GET' && path === '/api/partners/public/plans') {
   const plans = listPlans(db, {publicOnly: true}).map(p => ({id: p.id, slug: p.slug, nameAr: p.nameAr, nameEn: p.nameEn, descriptionAr: p.descriptionAr, descriptionEn: p.descriptionEn, priceMinor: p.priceMinor, currency: p.currency, billingPeriod: p.billingPeriod, highlighted: p.highlighted, defaultCommissionBps: p.defaultCommissionBps, commissionHoldDays: p.commissionHoldDays, minPayoutMinor: p.minPayoutMinor, entitlements: p.entitlements, trialDays: p.trialDays}));
   send(200, {plans, settings: publicSettings()});
   return true;
  }
  if (method === 'GET' && path === '/api/partners/public/invite') {
   try { checkInvite(db, url.searchParams.get('code'), null); send(200, {valid: true}); } catch { send(200, {valid: false}); }
   return true;
  }

  // ---- public: one-step partner sign-up (account + application) ----------------------------------------
  if (method === 'POST' && path === '/api/partners/register') {
   if (env.ALLOW_PUBLIC_SIGNUP === 'false') fail(403, 'REGISTRATION_CLOSED');
   checkSignupRateLimit(req.socket.remoteAddress);
   checkGlobalSignupLimit(env);
   const input = await readJson(req);
   if (captchaRequiredFor(env, 'signup')) {
    const captcha = await verifyBotProtection({env, fetcher}, input.captchaToken, req.socket.remoteAddress);
    if (!captcha.ok) fail(400, captcha.errorCode);
   }
   const settings = getSettings(db);
   validateApplication({...input, email: input.email});
   if (settings.registration_mode === 'invite_only') checkInvite(db, input.inviteCode, String(input.email || '').trim().toLowerCase());
   const created = tx(db, () => {
    const {user, token, normalizedEmail} = registerPublicUser(db, auth, {name: input.name || input.fullName, username: input.username, email: input.email, password: input.password});
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    const {application, outcome} = submitApplication(db, env, {id: user.id, name: user.name}, {...input, email: normalizedEmail}, {inviteCode: input.inviteCode});
    attributeRegistration(db, env, {userId: user.id, email: normalizedEmail, visitorId: cookieOf(req, COOKIE), ip: clientIp(req, env)});
    return {user, row, token, normalizedEmail, application, outcome};
   });
   const locale = ['ar', 'en'].includes(input.locale) ? input.locale : 'ar';
   const delivery = await sendVerificationEmail(mailCtx(), {to: created.normalizedEmail, locale, verifyUrl: `${baseUrl}/app#verify-email/${created.token}`});
   recordPlatformAudit(db, {id: randomUUID(), action: 'USER_REGISTERED', itemId: created.user.id, actorId: created.user.id, actorName: created.user.name, at: now()});
   const result = auth.session(db.prepare('SELECT * FROM users WHERE id=?').get(created.user.id));
   res.setHeader('Set-Cookie', sessionCookie(result));
   send(201, {user: result.user, csrf: result.csrf, application: created.application, outcome: created.outcome, delivered: delivery.delivered});
   return true;
  }

  // ---- everything below needs a session ---------------------------------------------------------------
  const ctx = partnerContext(db, env, session);
  requireSession(ctx);
  if (method !== 'GET' && req.headers['x-csrf-token'] !== session.csrf) fail(403, 'رمز حماية الجلسة غير صالح');
  const actor = actorOf(ctx);
  const q = re => path.match(re);
  const partnerGate = key => { const profile = requirePartner(ctx); requireEntitlement(db, profile, key); return profile; };
  const origin = baseUrl;
  const notifyMail = (userId, kind, params) => { sendPartnerMail(mailCtx(), userId, kind, params, origin); };

  // -- identity / status
  if (method === 'GET' && path === '/api/partners/me') {
   const unread = db.prepare('SELECT COUNT(*) n FROM partner_notifications WHERE user_id=? AND read_at IS NULL').get(ctx.user.id).n;
   send(200, {
    user: {id: ctx.user.id, name: ctx.user.name, username: ctx.user.username, email: ctx.user.email, emailVerified: !!ctx.user.emailVerifiedAt},
    roles: ctx.roles, isManager: ctx.isManager, isAdmin: ctx.isAdmin, permissions: ctx.permissions,
    partner: ctx.profile ? {...hydrateProfile(db, ctx.profile), links: listLinks(db, ctx.profile.id, origin).filter(l => l.isDefault).map(l => ({code: l.code, url: l.url}))} : null,
    application: latestApplicationForUser(db, ctx.user.id), unreadNotifications: unread,
    capabilities: {mailConfigured: platformMailStatus(env).status === 'CONFIGURED', encryptionConfigured: encryptionConfigured(env)},
    settings: publicSettings(), entitlementCatalog: ENTITLEMENTS
   });
   return true;
  }
  if (method === 'PATCH' && path === '/api/partners/profile') {
   const profile = requirePartner(ctx);
   const updated = updateOwnProfile(db, profile, await readJson(req));
   send(200, hydrateProfile(db, updated));
   return true;
  }
  if (method === 'GET' && path === '/api/partners/notifications') {
   const rows = db.prepare('SELECT id,kind,params_json,read_at,created_at FROM partner_notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(ctx.user.id);
   send(200, {items: rows.map(r => ({id: r.id, kind: r.kind, params: JSON.parse(r.params_json || '{}'), read: !!r.read_at, createdAt: r.created_at})), unread: rows.filter(r => !r.read_at).length});
   return true;
  }
  if (method === 'POST' && path === '/api/partners/notifications/read') {
   const input = await readJson(req);
   if (Array.isArray(input.ids) && input.ids.length) for (const id of input.ids.slice(0, 100)) db.prepare('UPDATE partner_notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL').run(now(), String(id), ctx.user.id);
   else db.prepare('UPDATE partner_notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(now(), ctx.user.id);
   send(200, {ok: true});
   return true;
  }

  // -- applications (existing signed-in account)
  if (method === 'POST' && path === '/api/partners/applications') {
   const input = await readJson(req);
   const email = input.email || ctx.user.email;
   const result = submitApplication(db, env, ctx.user, {...input, email}, {inviteCode: input.inviteCode});
   send(201, result);
   return true;
  }
  const appRespond = q(/^\/api\/partners\/applications\/([\w-]+)\/respond$/);
  if (method === 'POST' && appRespond) {
   send(200, respondToInformationRequest(db, env, ctx.user, appRespond[1], (await readJson(req)).response));
   return true;
  }

  // -- partner: dashboard, links, referrals, customers
  if (method === 'GET' && path === '/api/partners/dashboard') {
   const profile = partnerGate('partner.dashboard');
   send(200, {...partnerDashboard(db, profile, {days: Number(url.searchParams.get('days')) || 30, origin}), partner: hydrateProfile(db, profile)});
   return true;
  }
  if (method === 'GET' && path === '/api/partners/links') {
   const profile = partnerGate('partner.referrals');
   send(200, {links: listLinks(db, profile.id, origin), campaigns: listCampaigns(db, profile.id)});
   return true;
  }
  if (method === 'POST' && path === '/api/partners/links') {
   const profile = partnerGate('partner.referrals');
   send(201, createLink(db, profile, await readJson(req), origin));
   return true;
  }
  const linkId = q(/^\/api\/partners\/links\/([\w-]+)$/);
  if (method === 'PATCH' && linkId) {
   const profile = partnerGate('partner.referrals');
   send(200, updateLink(db, profile, linkId[1], await readJson(req), origin));
   return true;
  }
  if (method === 'POST' && path === '/api/partners/campaigns') {
   const profile = partnerGate('partner.referrals');
   send(201, createCampaign(db, profile, await readJson(req)));
   return true;
  }
  if (method === 'GET' && path === '/api/partners/referrals') {
   const profile = partnerGate('partner.referrals');
   send(200, listReferralsForPartner(db, profile.id, url));
   return true;
  }
  if (method === 'GET' && path === '/api/partners/customers') {
   const profile = partnerGate('partner.customers');
   send(200, listReferralsForPartner(db, profile.id, withParam(url, 'status', 'converted')));
   return true;
  }

  // -- partner: commissions + ledger + exports
  if (method === 'GET' && path === '/api/partners/commissions') {
   const profile = partnerGate('partner.commissions');
   send(200, {...listCommissions(db, url, {partnerId: profile.id}), balances: balances(db, profile.id)});
   return true;
  }
  if (method === 'GET' && path === '/api/partners/ledger') {
   const profile = partnerGate('partner.commissions');
   send(200, ledgerFor(db, profile.id, url));
   return true;
  }
  const exportMatch = q(/^\/api\/partners\/export\/(commissions|referrals)\.csv$/);
  if (method === 'GET' && exportMatch) {
   const profile = partnerGate('partner.export_data');
   const big = new URL(url); big.searchParams.set('limit', '100');
   const rows = exportMatch[1] === 'commissions'
    ? [['id', 'status', 'gross', 'rate_bps', 'commission', 'currency', 'created_at'], ...listCommissions(db, big, {partnerId: profile.id}).items.map(c => [c.id, c.status, (c.grossMinor / 100).toFixed(2), c.rateBps, (c.commissionMinor / 100).toFixed(2), c.currency, c.createdAt])]
    : [['id', 'status', 'source', 'medium', 'campaign', 'registered_at', 'converted_at'], ...listReferralsForPartner(db, profile.id, big).items.map(r => [r.id, r.status, r.source, r.medium, r.campaign, r.registeredAt, r.convertedAt])];
   res.writeHead(200, {'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${exportMatch[1]}.csv"`});
   res.end('﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'));
   return true;
  }

  // -- partner: payouts
  if (method === 'GET' && path === '/api/partners/payout-methods') {
   const profile = partnerGate('partner.payouts');
   send(200, {methods: listMethods(db, profile.id), enabledTypes: getSettings(db).payout_methods.filter(t => PAYOUT_METHOD_TYPES.includes(t)), encryptionConfigured: encryptionConfigured(env)});
   return true;
  }
  if (method === 'POST' && path === '/api/partners/payout-methods') {
   const profile = partnerGate('partner.payouts');
   send(201, addMethod(db, env, profile, await readJson(req)));
   return true;
  }
  const methodId = q(/^\/api\/partners\/payout-methods\/([\w-]+)(\/default)?$/);
  if (methodId && ((method === 'DELETE' && !methodId[2]) || (method === 'POST' && methodId[2]))) {
   const profile = partnerGate('partner.payouts');
   send(200, method === 'DELETE' ? deleteMethod(db, profile, methodId[1]) : setDefaultMethod(db, profile, methodId[1]));
   return true;
  }
  if (method === 'GET' && path === '/api/partners/payouts') {
   const profile = partnerGate('partner.payouts');
   send(200, {...listPayouts(db, url, {partnerId: profile.id}), balances: balances(db, profile.id), minPayoutMinor: getSettings(db).min_payout_minor});
   return true;
  }
  if (method === 'POST' && path === '/api/partners/payouts') {
   const profile = partnerGate('partner.payouts');
   const input = await readJson(req);
   send(201, requestPayout(db, env, profile, ctx.user, {methodId: input.methodId, amountMinor: input.amount === undefined ? undefined : toMinor(input.amount, 'amount')}));
   return true;
  }
  const payoutPartner = q(/^\/api\/partners\/payouts\/([\w-]+)\/(cancel|receipt)$/);
  if (payoutPartner) {
   const profile = partnerGate('partner.payouts');
   if (method === 'POST' && payoutPartner[2] === 'cancel') { send(200, cancelPayout(db, profile, ctx.user, payoutPartner[1])); return true; }
   if (method === 'GET' && payoutPartner[2] === 'receipt') { sendFile(res, getReceipt(db, payoutPartner[1], {partnerId: profile.id}), true); return true; }
  }

  // -- partner: marketing assets
  if (method === 'GET' && path === '/api/partners/assets') {
   const profile = partnerGate('partner.marketing_assets');
   send(200, {items: listAssetsForPartner(db, profile)});
   return true;
  }
  const assetFile = q(/^\/api\/partners\/assets\/([\w-]+)\/file$/);
  if (method === 'GET' && assetFile) {
   const profile = partnerGate('partner.marketing_assets');
   const f = getAssetFile(db, assetFile[1], profile);
   sendFile(res, {file_name: f.name, mime_type: f.mime, data: f.data}, url.searchParams.get('download') === '1');
   return true;
  }

  // =====================================  ADMIN / PARTNER MANAGERS  =====================================
  if (path.startsWith('/api/partners/admin/')) {
   requireManager(ctx);
   const sub = path.slice('/api/partners/admin/'.length);
   if (method === 'GET' && sub === 'overview') { send(200, {...adminOverview(db), settings: publicSettings(), capabilities: {billingWebhook: !!env.PARTNER_BILLING_WEBHOOK_SECRET, mail: platformMailStatus(env).status === 'CONFIGURED', encryption: encryptionConfigured(env)}}); return true; }

   // applications
   if (sub === 'applications' && method === 'GET') { requireManager(ctx, 'applications'); send(200, listApplications(db, url)); return true; }
   const appOne = sub.match(/^applications\/([\w-]+)(\/decision)?$/);
   if (appOne) {
    requireManager(ctx, 'applications');
    if (method === 'GET' && !appOne[2]) { send(200, getApplication(db, appOne[1])); return true; }
    if (method === 'POST' && appOne[2]) {
     const input = await readJson(req);
     const bps = customBps(input);
     const result = decide(db, actor, appOne[1], bps === undefined ? input : {...input, customCommissionBps: bps});
     if (input.decision === 'approve') notifyMail(result.userId, 'application_approved', {referralCode: db.prepare('SELECT referral_code FROM partner_profiles WHERE user_id=?').get(result.userId)?.referral_code});
     if (input.decision === 'reject') notifyMail(result.userId, 'application_rejected', {reason: result.decisionReason});
     if (input.decision === 'needs_information') notifyMail(result.userId, 'application_needs_information', {message: result.infoRequest});
     send(200, result);
     return true;
    }
   }

   // partners
   if (sub === 'partners' && method === 'GET') { requireManager(ctx, 'partners'); send(200, listPartners(db, url)); return true; }
   const partnerOne = sub.match(/^partners\/([\w-]+)(?:\/(plan|regenerate-code|notes|commissions|referrals))?$/);
   if (partnerOne) {
    requireManager(ctx, 'partners');
    const id = partnerOne[1], what = partnerOne[2];
    getProfileById(db, id);
    if (method === 'GET' && !what) { send(200, getPartnerDetail(db, id)); return true; }
    if (method === 'GET' && what === 'commissions') { requireManager(ctx, 'commissions'); send(200, listCommissions(db, forceParam(url, 'partnerId', id))); return true; }
    if (method === 'GET' && what === 'referrals') { send(200, listReferralsForPartner(db, id, url)); return true; }
    if (method === 'PATCH' && !what) {
     const input = await readJson(req);
     if (input.status !== undefined) { const row = setPartnerStatus(db, actor, id, input.status, input.reason); if (input.status === 'suspended') notifyMail(row.user_id, 'account_suspended', {}); }
     const bps = customBps(input);
     if (bps !== undefined) setCustomCommission(db, actor, id, bps);
     else if (input.customCommissionBps !== undefined) setCustomCommission(db, actor, id, input.customCommissionBps);
     send(200, getPartnerDetail(db, id));
     return true;
    }
    if (method === 'POST' && what === 'plan') {
     requireManager(ctx, 'plans');
     const input = await readJson(req);
     assignPlan(db, actor, getProfileById(db, id), input.planId, {endsAt: input.endsAt === undefined ? undefined : input.endsAt, trial: input.trial === true, status: input.status});
     send(200, getPartnerDetail(db, id));
     return true;
    }
    if (method === 'POST' && what === 'regenerate-code') { regenerateReferralCode(db, actor, id); send(200, getPartnerDetail(db, id)); return true; }
    if (method === 'POST' && what === 'notes') { send(201, addNote(db, actor, id, (await readJson(req)).note)); return true; }
   }
   const refCancel = sub.match(/^referrals\/([\w-]+)\/cancel$/);
   if (method === 'POST' && refCancel) { requireManager(ctx, 'partners'); send(200, cancelReferral(db, actor, refCancel[1], (await readJson(req)).reason)); return true; }

   // plans
   if (sub === 'plans' && method === 'GET') { send(200, {items: listPlans(db, {includeArchived: true}), subscribers: planSubscriberCounts(db), entitlementCatalog: ENTITLEMENTS}); return true; }
   if (sub === 'plans' && method === 'POST') { requireManager(ctx, 'plans'); send(201, createPlan(db, actor, normalizePlanInput(await readJson(req)))); return true; }
   const planOne = sub.match(/^plans\/([\w-]+)$/);
   if (planOne && method === 'PATCH') { requireManager(ctx, 'plans'); send(200, updatePlan(db, actor, planOne[1], normalizePlanInput(await readJson(req)))); return true; }
   if (planOne && method === 'GET') { requireManager(ctx, 'plans'); send(200, getPlan(db, planOne[1])); return true; }

   // commissions + billing events
   if (sub === 'commissions' && method === 'GET') { requireManager(ctx, 'commissions'); send(200, listCommissions(db, url)); return true; }
   const commDecision = sub.match(/^commissions\/([\w-]+)\/decision$/);
   if (commDecision && method === 'POST') { requireManager(ctx, 'commissions'); const i = await readJson(req); send(200, decideCommission(db, actor, commDecision[1], i.action, i.reason)); return true; }
   if (sub === 'commissions/bulk' && method === 'POST') {
    requireManager(ctx, 'commissions');
    const i = await readJson(req);
    if (!Array.isArray(i.ids) || !i.ids.length || i.ids.length > 100) fail(400, 'ids must be 1-100 commission ids');
    const results = tx(db, () => i.ids.map(id => { try { return {id, ok: true, status: decideCommission(db, actor, String(id), i.action, i.reason).status}; } catch (e) { return {id, ok: false, error: e.message}; } }));
    send(200, {results});
    return true;
   }
   if (sub === 'billing-events' && method === 'GET') { requireManager(ctx, 'commissions'); send(200, listBillingEvents(db, url)); return true; }
   if (sub === 'billing-events' && method === 'POST') {
    requireManager(ctx, 'commissions');
    const i = await readJson(req);
    const amountMinor = i.amountMinor !== undefined ? i.amountMinor : toMinor(i.amount, 'amount');
    if (i.customerEmail !== undefined && !isEmail(String(i.customerEmail).trim().toLowerCase())) fail(400, 'customerEmail is invalid');
    const r = recordBillingEvent(db, env, actor, 'manual', {externalId: i.externalId || `manual-${newId()}`, type: i.type || 'payment_succeeded', customerEmail: i.customerEmail, customerUserId: i.customerUserId, planRef: i.planRef, amountMinor, currency: i.currency || getSettings(db).default_currency, occurredAt: i.occurredAt || now(), refersToExternalId: i.refersToExternalId});
    send(r.duplicate ? 200 : 201, {duplicate: r.duplicate, result: r.event.result, event: r.event.id, commissionId: r.commission?.id || null});
    return true;
   }

   // payouts
   if (sub === 'payouts' && method === 'GET') { requireManager(ctx, 'payouts'); send(200, listPayouts(db, url)); return true; }
   const payOne = sub.match(/^payouts\/([\w-]+)(?:\/(decision|details|receipt))?$/);
   if (payOne) {
    requireManager(ctx, 'payouts');
    const id = payOne[1], what = payOne[2];
    if (method === 'GET' && !what) { send(200, getPayoutAdmin(db, id)); return true; }
    if (method === 'GET' && what === 'details') { send(200, revealPayoutDetails(db, env, actor, id)); return true; }
    if (method === 'POST' && what === 'decision') {
     const i = await readJson(req);
     const result = decidePayout(db, actor, id, i.action, {reason: i.reason, paymentReference: i.paymentReference});
     const owner = db.prepare('SELECT user_id FROM partner_profiles WHERE id=?').get(result.partnerId);
     if (i.action === 'pay') notifyMail(owner.user_id, 'payout_paid', {amountMinor: result.amountMinor, currency: result.currency});
     if (i.action === 'reject') notifyMail(owner.user_id, 'payout_rejected', {reason: result.rejectReason});
     send(200, result);
     return true;
    }
    if (method === 'PUT' && what === 'receipt') {
     const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
     send(200, saveReceipt(db, actor, id, {mimeType: mime, fileName: decodeName(req.headers['x-file-name']), data: await readBinary(req, 2 * 1024 * 1024 + 1)}));
     return true;
    }
    if (method === 'GET' && what === 'receipt') { sendFile(res, getReceipt(db, id), true); return true; }
   }

   // marketing assets
   if (sub === 'assets' && method === 'GET') { requireManager(ctx, 'assets'); send(200, {items: listAssetsAdmin(db)}); return true; }
   if (sub === 'assets' && method === 'POST') { requireManager(ctx, 'assets'); send(201, createAsset(db, actor, await readJson(req))); return true; }
   const assetOne = sub.match(/^assets\/([\w-]+)(?:\/(file))?$/);
   if (assetOne) {
    requireManager(ctx, 'assets');
    if (method === 'PATCH' && !assetOne[2]) { send(200, updateAsset(db, actor, assetOne[1], await readJson(req))); return true; }
    if (method === 'PUT' && assetOne[2]) {
     const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
     send(200, saveAssetFile(db, actor, assetOne[1], {mimeType: mime, fileName: decodeName(req.headers['x-file-name']), data: await readBinary(req, 5 * 1024 * 1024 + 1)}));
     return true;
    }
    if (method === 'GET' && assetOne[2]) { const f = getAssetFile(db, assetOne[1]); sendFile(res, {file_name: f.name, mime_type: f.mime, data: f.data}, url.searchParams.get('download') === '1'); return true; }
   }

   // settings / staff / invites / audit
   if (sub === 'settings' && method === 'GET') { requireManager(ctx, 'settings'); send(200, getSettings(db)); return true; }
   if (sub === 'settings' && method === 'PUT') { requireManager(ctx, 'settings'); send(200, saveSettings(db, actor, normalizeSettingsInput(await readJson(req)))); return true; }
   if (sub === 'staff' && method === 'GET') { requireAdmin(ctx); send(200, {items: listStaff(db), permissionCatalog: [...STAFF_PERMISSIONS, 'settings', 'staff']}); return true; }
   if (sub === 'staff' && method === 'PUT') {
    requireAdmin(ctx);
    const i = await readJson(req);
    upsertStaff(db, actor, {identity: i.identity, permissions: (Array.isArray(i.permissions) ? i.permissions : []), status: i.status || 'active'});
    send(200, {items: listStaff(db)});
    return true;
   }
   if (sub === 'invites' && method === 'GET') { requireManager(ctx, 'partners'); send(200, {items: listInvites(db).map(x => ({...x, url: `${origin}/partners/register?invite=${x.code}`}))}); return true; }
   if (sub === 'invites' && method === 'POST') { requireManager(ctx, 'partners'); const r = createInvite(db, actor, await readJson(req)); send(201, {...r, url: `${origin}/partners/register?invite=${r.code}`}); return true; }
   if (sub === 'audit' && method === 'GET') {
    requireManager(ctx, 'partners');
    const pageSize = Math.min(100, Number(url.searchParams.get('limit')) || 50);
    const partnerFilter = url.searchParams.get('partnerId');
    const rows = partnerFilter
     ? db.prepare('SELECT * FROM partner_audit_logs WHERE partner_id=? ORDER BY created_at DESC LIMIT ?').all(partnerFilter, pageSize)
     : db.prepare('SELECT * FROM partner_audit_logs ORDER BY created_at DESC LIMIT ?').all(pageSize);
    send(200, {items: rows.map(r => ({id: r.id, actorName: r.actor_name, actorRole: r.actor_role, action: r.action, entityType: r.entity_type, entityId: r.entity_id, partnerId: r.partner_id, detail: r.detail_json ? JSON.parse(r.detail_json) : null, createdAt: r.created_at}))});
    return true;
   }
   fail(404, 'Unknown partner admin operation');
  }
  fail(404, 'Unknown partner operation');
 };
}

function sendFile(res, row, forceDownload) {
 const mime = row.mime_type;
 const inline = !forceDownload && /^image\/(png|jpeg|webp)$/.test(mime);
 const name = String(row.file_name || 'file').replace(/[^\w.\- ]/g, '_');
 res.writeHead(200, {'Content-Type': mime, 'Content-Length': row.data.length, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`, 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store'});
 res.end(row.data);
}
