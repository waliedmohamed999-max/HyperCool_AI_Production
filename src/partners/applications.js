import {fail} from '../auth.js';
import {OPEN_APPLICATION_STATUSES, PARTNER_TYPES, audit, clean, cleanMultiline, getSettings, isEmail, newId, notifyStaff, notifyUser, now, pageParams, paged, tx} from './core.js';
import {getPlan, getPlanOrNull} from './plans.js';
import {checkInvite, consumeInvite, createPartnerFromApplication, validWebsite} from './partners.js';

const hydrate = row => row && ({
 id: row.id, userId: row.user_id, fullName: row.full_name, email: row.email, phone: row.phone, country: row.country, companyName: row.company_name, website: row.website,
 partnerType: row.partner_type, marketingMethod: row.marketing_method, expectedCustomers: row.expected_customers,
 requestedPlanId: row.requested_plan_id, assignedPlanId: row.assigned_plan_id, customCommissionBps: row.custom_commission_bps,
 termsVersion: row.terms_version, termsAcceptedAt: row.terms_accepted_at,
 status: row.status, infoRequest: row.info_request, applicantResponse: row.applicant_response, decisionReason: row.decision_reason,
 reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, createdAt: row.created_at, updatedAt: row.updated_at
});

export function validateApplication(input) {
 const out = {};
 out.fullName = clean(input.fullName, 100);
 if (out.fullName.length < 2) fail(400, 'fullName is required');
 out.email = clean(input.email, 254).toLowerCase();
 if (!isEmail(out.email)) fail(400, 'a valid email is required');
 out.phone = clean(input.phone, 30);
 if (!/^[+\d][\d\s()-]{5,29}$/.test(out.phone)) fail(400, 'a valid phone number is required');
 out.country = clean(input.country, 60);
 if (out.country.length < 2) fail(400, 'country is required');
 out.companyName = clean(input.companyName, 120) || null;
 out.website = validWebsite(input.website);
 if (!PARTNER_TYPES.includes(input.partnerType)) fail(400, 'partnerType is invalid');
 out.partnerType = input.partnerType;
 out.marketingMethod = cleanMultiline(input.marketingMethod, 2000);
 if (out.marketingMethod.length < 10) fail(400, 'marketingMethod must describe how you plan to promote (10+ characters)');
 if (!Number.isInteger(input.expectedCustomers) || input.expectedCustomers < 0 || input.expectedCustomers > 1000000) fail(400, 'expectedCustomers must be a whole number');
 out.expectedCustomers = input.expectedCustomers;
 if (input.acceptTerms !== true) fail(400, 'TERMS_NOT_ACCEPTED');
 out.requestedPlanId = input.requestedPlanId || null;
 return out;
}

export function submitApplication(db, env, user, input, {inviteCode = null} = {}) {
 const v = validateApplication(input);
 const settings = getSettings(db);
 return tx(db, () => {
  if (db.prepare('SELECT 1 FROM partner_profiles WHERE user_id=?').get(user.id)) fail(409, 'ALREADY_A_PARTNER');
  if (db.prepare("SELECT 1 FROM partner_applications WHERE user_id=? AND status IN ('pending','under_review','needs_information')").get(user.id)) fail(409, 'APPLICATION_ALREADY_OPEN');
  let invite = null;
  if (settings.registration_mode === 'invite_only') invite = checkInvite(db, inviteCode, v.email);
  let requestedPlan = null;
  if (v.requestedPlanId) {
   requestedPlan = getPlanOrNull(db, v.requestedPlanId);
   if (!requestedPlan || requestedPlan.status !== 'active') fail(400, 'requested plan is not available');
  }
  if (invite?.plan_id && !requestedPlan) requestedPlan = getPlanOrNull(db, invite.plan_id);
  const id = newId(), t = now();
  db.prepare(`INSERT INTO partner_applications (id,user_id,full_name,email,phone,country,company_name,website,partner_type,marketing_method,expected_customers,requested_plan_id,terms_version,terms_accepted_at,status,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(id, user.id, v.fullName, v.email, v.phone, v.country, v.companyName, v.website, v.partnerType, v.marketingMethod, v.expectedCustomers, requestedPlan?.id || null, settings.terms_version, t, t, t);
  if (invite) consumeInvite(db, invite.id, user.id);
  audit(db, {actor: {id: user.id, name: user.name, role: 'user'}, action: 'PARTNER_APPLICATION_SUBMITTED', entityType: 'application', entityId: id});
  notifyUser(db, user.id, 'application_received', {});
  notifyStaff(db, env, 'applications', 'application_submitted', {applicationId: id, name: v.fullName});
  let outcome = 'pending';
  const dbUser = db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(user.id);
  // Auto-approval is deliberately narrow: only for verified emails, invited or free-plan requests.
  if (settings.approval_mode === 'auto' && dbUser?.email_verified_at) {
   const plan = requestedPlan || db.prepare("SELECT id FROM partner_plans WHERE status='active' AND price_minor=0 ORDER BY sort_order LIMIT 1").get();
   const full = plan ? getPlan(db, plan.id) : null;
   if (full && full.priceMinor === 0 && full.status === 'active') {
    decide(db, {id: null, name: 'auto-approval', role: 'system'}, id, {decision: 'approve', planId: full.id});
    outcome = 'approved';
   }
  }
  return {application: getApplication(db, id), outcome};
 });
}

export const getApplication = (db, id) => {
 const row = db.prepare('SELECT * FROM partner_applications WHERE id=?').get(id);
 if (!row) fail(404, 'Application not found');
 return hydrate(row);
};
export function latestApplicationForUser(db, userId) {
 return hydrate(db.prepare('SELECT * FROM partner_applications WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(userId)) || null;
}

export function listApplications(db, url) {
 const p = pageParams(url);
 const where = ['1=1'], args = [];
 const status = url.searchParams.get('status');
 if (status) { where.push('a.status=?'); args.push(status); }
 const q = clean(url.searchParams.get('q') || '', 80).replace(/[%_]/g, '');
 if (q) { where.push('(a.full_name LIKE ? OR a.email LIKE ? OR a.company_name LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
 const total = db.prepare(`SELECT COUNT(*) n FROM partner_applications a WHERE ${where.join(' AND ')}`).get(...args).n;
 const rows = db.prepare(`SELECT a.*, u.email_verified_at FROM partner_applications a JOIN users u ON u.id=a.user_id WHERE ${where.join(' AND ')} ORDER BY CASE a.status WHEN 'pending' THEN 0 WHEN 'under_review' THEN 1 WHEN 'needs_information' THEN 2 ELSE 3 END, a.created_at DESC LIMIT ? OFFSET ?`).all(...args, p.limit, p.offset);
 return paged(rows.map(r => ({...hydrate(r), emailVerified: !!r.email_verified_at})), total, p);
}

/** Staff decision. Approval creates the partner profile + default link + plan subscription atomically. */
export function decide(db, actor, id, {decision, reason, message, planId, customCommissionBps = null}) {
 return tx(db, () => {
  const row = db.prepare('SELECT * FROM partner_applications WHERE id=?').get(id);
  if (!row) fail(404, 'Application not found');
  if (row.status === 'approved') fail(409, 'application already approved');
  const t = now();
  const stamp = (status, extra = {}) => db.prepare('UPDATE partner_applications SET status=?,decision_reason=?,info_request=?,assigned_plan_id=?,custom_commission_bps=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?')
   .run(status, extra.reason ?? row.decision_reason, extra.info ?? row.info_request, extra.planId ?? row.assigned_plan_id, extra.bps ?? row.custom_commission_bps, actor?.id || null, t, t, id);
  if (decision === 'under_review') {
   if (!['pending', 'needs_information'].includes(row.status)) fail(409, 'application cannot move to review from its current status');
   stamp('under_review');
  } else if (decision === 'needs_information') {
   const text = cleanMultiline(message, 1500);
   if (!text) fail(400, 'message is required');
   if (!OPEN_APPLICATION_STATUSES.includes(row.status)) fail(409, 'application is closed');
   stamp('needs_information', {info: text});
   notifyUser(db, row.user_id, 'application_needs_information', {message: text});
  } else if (decision === 'reject') {
   const text = cleanMultiline(reason, 1500);
   if (!text) fail(400, 'a rejection reason is required');
   if (!OPEN_APPLICATION_STATUSES.includes(row.status)) fail(409, 'application is closed');
   stamp('rejected', {reason: text});
   notifyUser(db, row.user_id, 'application_rejected', {reason: text});
  } else if (decision === 'approve') {
   if (!OPEN_APPLICATION_STATUSES.includes(row.status)) fail(409, 'application is closed');
   const chosen = planId || row.requested_plan_id;
   if (!chosen) fail(400, 'a plan must be assigned');
   if (customCommissionBps !== null && (!Number.isInteger(customCommissionBps) || customCommissionBps < 0 || customCommissionBps > 10000)) fail(400, 'commission must be 0..10000 basis points');
   stamp('approved', {planId: chosen, bps: customCommissionBps});
   const profile = createPartnerFromApplication(db, actor, {...row, id}, {planId: chosen, customCommissionBps});
   notifyUser(db, row.user_id, 'application_approved', {referralCode: profile.referral_code});
  } else fail(400, 'decision must be approve, reject, needs_information or under_review');
  audit(db, {actor, action: `PARTNER_APPLICATION_${decision.toUpperCase()}`, entityType: 'application', entityId: id, detail: {reason: reason || null, planId: planId || null}});
  return getApplication(db, id);
 });
}

export function respondToInformationRequest(db, env, user, id, response) {
 const row = db.prepare('SELECT * FROM partner_applications WHERE id=? AND user_id=?').get(id, user.id);
 if (!row) fail(404, 'Application not found');
 if (row.status !== 'needs_information') fail(409, 'no information was requested');
 const text = cleanMultiline(response, 2000);
 if (text.length < 2) fail(400, 'a response is required');
 db.prepare("UPDATE partner_applications SET status='pending',applicant_response=?,updated_at=? WHERE id=?").run(text, now(), id);
 audit(db, {actor: {id: user.id, name: user.name, role: 'user'}, action: 'PARTNER_APPLICATION_RESPONDED', entityType: 'application', entityId: id});
 notifyStaff(db, env, 'applications', 'application_updated', {applicationId: id});
 return getApplication(db, id);
}
