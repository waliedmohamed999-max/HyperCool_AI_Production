import {fail} from '../auth.js';
import {registerPublicUser} from '../platform-identity.js';
import {bootstrapWorkspaceForOwner, selfServicePolicy} from '../workspace-provisioning.js';
import {createInvitation, revokeInvitation, acceptInvitation, previewInvitation, roleForValidToken, resendInvitation} from '../invitations.js';
import {updateTenantAgentConfig} from '../runtime/agent-config.js';
import {AGENT_IDS, isCatalogAgent} from './catalog.js';
import {sha, AUTONOMY_LEVELS, LEGACY_ROLE, ROLE_PERMISSIONS, WORKSPACE_ROLES, audit, clean, cleanMultiline, getSettings, isEmail, newId, notify, notifyMembers, now, parseJson, tx} from './core.js';
import {assertWithinLimit, assignPlan, effectiveState, getPlan, getPlanBySlug, getProfile, resolveAccess, syncLifecycle, usageFor} from './plans.js';
import {agentAccess, agentViews, syncAgentConfigs} from './agents.js';

export const BUSINESS_TYPES = ['retail', 'fashion', 'electronics', 'food', 'beauty', 'services', 'b2b', 'agency', 'other'];
export const BUSINESS_SIZES = ['solo', 'small', 'medium', 'large'];
export const PLATFORMS = ['salla', 'zid', 'shopify', 'woocommerce', 'custom', 'none', 'other'];
export const GOALS = ['grow_sales', 'marketing', 'customer_replies', 'content', 'campaigns', 'operations', 'analytics', 'crm'];
// Which agents help with which goal (used only to *suggest* agents in onboarding).
const GOAL_AGENTS = {
 grow_sales: ['sales', 'leads', 'followup'], marketing: ['strategy', 'publishing', 'copy'], customer_replies: ['sales', 'followup'], content: ['copy', 'creative', 'strategy', 'compliance'],
 campaigns: ['strategy', 'publishing', 'performance'], operations: ['frost', 'memory'], analytics: ['performance', 'intelligence'], crm: ['leads', 'sales', 'followup']
};

// ---- registration -------------------------------------------------------------------------------------------------------
export function validateRegistration(input) {
 const out = {};
 out.name = clean(input.name, 100);
 if (out.name.length < 2) fail(400, 'name is required');
 out.phone = clean(input.phone, 30);
 if (!/^[+\d][\d\s()-]{5,29}$/.test(out.phone)) fail(400, 'a valid phone number is required');
 out.country = clean(input.country, 60);
 if (out.country.length < 2) fail(400, 'country is required');
 out.businessName = clean(input.businessName, 100);
 if (out.businessName.length < 2) fail(400, 'businessName is required');
 if (!BUSINESS_TYPES.includes(input.businessType)) fail(400, 'businessType is invalid');
 out.businessType = input.businessType;
 if (!BUSINESS_SIZES.includes(input.businessSize)) fail(400, 'businessSize is invalid');
 out.businessSize = input.businessSize;
 out.storeUrl = null;
 if (input.storeUrl) {
  try { const u = new URL(String(input.storeUrl).trim()); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('bad'); out.storeUrl = u.toString().slice(0, 300); } catch { fail(400, 'invalid store URL'); }
 }
 if (!PLATFORMS.includes(input.ecommercePlatform)) fail(400, 'ecommercePlatform is invalid');
 out.ecommercePlatform = input.ecommercePlatform;
 out.teamSize = Number.isInteger(input.teamSize) && input.teamSize >= 1 && input.teamSize <= 10000 ? input.teamSize : fail(400, 'teamSize must be a whole number');
 if (!Array.isArray(input.goals) || !input.goals.length || input.goals.some(g => !GOALS.includes(g))) fail(400, 'choose at least one valid goal');
 out.goals = [...new Set(input.goals)];
 out.planSlug = input.planSlug ? String(input.planSlug) : null;
 out.locale = ['ar', 'en'].includes(input.locale) ? input.locale : 'ar';
 if (input.acceptTerms !== true) fail(400, 'TERMS_NOT_ACCEPTED');
 return out;
}

/**
 * Creates the user (via the platform's own public-signup path), the isolated workspace (via the platform's own
 * workspace bootstrap) and the merchant layer (profile, trial subscription, owner role, onboarding row, agent sync).
 */
export function registerClient(db, env, auth, input) {
 const v = validateRegistration(input);
 const settings = getSettings(db);
 if (!selfServicePolicy(env).allowed) fail(403, 'REGISTRATION_CLOSED');
 const plan = getPlanBySlug(db, v.planSlug || settings.default_plan_slug);
 if (!plan || plan.status !== 'active' || plan.planType === 'partner') fail(400, 'the requested plan is not available');
 const {user, token, normalizedEmail} = registerPublicUser(db, auth, {name: v.name, username: input.username, email: input.email, password: input.password});
 let ws;
 try {
  ws = bootstrapWorkspaceForOwner(db, env, {companyName: v.businessName, defaultLocale: v.locale, timezone: input.timezone}, user.id);
  tx(db, () => provisionMerchantLayer(db, env, user, ws.tenantId, v, plan, settings));
 } catch (error) {
  try { if (ws) db.prepare("UPDATE tenants SET status='ARCHIVED',updated_at=? WHERE id=?").run(now(), ws.tenantId); db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id); } catch { /* best effort */ }
  throw error;
 }
 return {user, token, normalizedEmail, tenantId: ws.tenantId, slug: ws.slug, pending: settings.registration_mode === 'approval'};
}
function provisionMerchantLayer(db, env, user, tenantId, v, plan, settings) {
 const t = now();
 const pending = settings.registration_mode === 'approval';
 // the client layer owns the trial; clear the platform's own env-driven trial clock so it can never suspend the tenant
 db.prepare("UPDATE tenants SET status='ACTIVE',trial_started_at=NULL,trial_expires_at=NULL,plan=?,updated_at=? WHERE id=?").run(plan.slug, t, tenantId);
 db.prepare(`INSERT INTO client_profiles (tenant_id,owner_user_id,phone,country,business_name,business_type,business_size,store_url,ecommerce_platform,team_size,goals_json,requested_plan_id,terms_version,terms_accepted_at,account_status,workspace_status,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'onboarding',?,?)`).run(tenantId, user.id, v.phone, v.country, v.businessName, v.businessType, v.businessSize, v.storeUrl, v.ecommercePlatform, v.teamSize, JSON.stringify(v.goals), plan.id, settings.terms_version, t, pending ? 'pending' : 'trial', t, t);
 db.prepare("INSERT INTO client_members (tenant_id,user_id,workspace_role,status,created_at,updated_at) VALUES (?,?,'workspace_owner','active',?,?)").run(tenantId, user.id, t, t);
 db.prepare('INSERT INTO client_onboarding (tenant_id,current_step,data_json,default_autonomy,updated_at) VALUES (?,1,?,?,?)').run(tenantId, JSON.stringify({goals: v.goals}), 'approval_required', t);
 const trialEnds = plan.trialDays > 0 ? new Date(Date.now() + plan.trialDays * 86400000).toISOString() : null;
 db.prepare("INSERT INTO client_subscriptions (id,tenant_id,plan_id,status,started_at,trial_ends_at,ends_at,source,created_by,created_at) VALUES (?,?,?,?,?,?,?,'signup',?,?)")
  .run(newId(), tenantId, plan.id, plan.trialDays > 0 ? 'trial' : 'active', t, trialEnds, plan.trialDays > 0 ? null : null, user.id, t);
 syncAgentConfigs(db, tenantId);
 audit(db, {tenantId, actor: {id: user.id, name: user.name, kind: 'user'}, action: 'CLIENT_REGISTERED', entityType: 'account', detail: {plan: plan.slug, pending}});
 notify(db, tenantId, 'registration_complete', {pending}, user.id);
}

// ---- admin lifecycle (pending approval, suspend, cancel, archive, reactivate) -----------------------------------------------
export function setAccountStatus(db, auth, actor, tenantId, status, reason) {
 if (!['pending', 'trial', 'active', 'suspended', 'cancelled', 'archived'].includes(status)) fail(400, 'invalid status');
 if (!clean(reason, 300)) fail(400, 'a reason is required');
 const profile = getProfile(db, tenantId);
 if (!profile) fail(404, 'Customer not found');
 return tx(db, () => {
  const t = now();
  // 'trial'/'active' = "let the subscription decide" (reactivate); the lifecycle sync derives the real state
  const stored = ['trial', 'active'].includes(status) ? 'trial' : status;
  db.prepare('UPDATE client_profiles SET account_status=?,status_reason=?,updated_at=? WHERE tenant_id=?').run(stored, clean(reason, 300), t, tenantId);
  const tenantStatus = status === 'suspended' ? 'SUSPENDED' : ['cancelled', 'archived'].includes(status) ? 'ARCHIVED' : 'ACTIVE';
  db.prepare('UPDATE tenants SET status=?,updated_at=? WHERE id=?').run(tenantStatus, t, tenantId);
  if (['suspended', 'cancelled', 'archived'].includes(status)) {
   for (const m of db.prepare("SELECT user_id FROM client_members WHERE tenant_id=? AND status='active'").all(tenantId)) auth.revokeSessions(m.user_id);
   // freeze work that has not started: queued/scheduled tasks are paused (kept, never deleted)
   db.prepare("UPDATE client_tasks SET status='paused',updated_at=? WHERE tenant_id=? AND status IN ('queued','waiting_for_integration')").run(t, tenantId);
   pauseWorkflows(db, tenantId);
  }
  audit(db, {tenantId, actor, action: `CLIENT_${status.toUpperCase()}`, entityType: 'account', reason, detail: {status}});
  notifyMembers(db, tenantId, 'account_' + status, {reason: clean(reason, 300)});
  syncLifecycle(db);
  syncAgentConfigs(db, tenantId);
  return getProfile(db, tenantId);
 });
}
function pauseWorkflows(db, tenantId) {
 try { db.prepare("UPDATE workflow_definitions SET status='PAUSED',updated_at=? WHERE tenant_id=? AND status='ACTIVE'").run(now(), tenantId); } catch { /* workflow tables absent in minimal fixtures */ }
}
export function approvePending(db, auth, actor, tenantId) {
 const profile = getProfile(db, tenantId);
 if (!profile || profile.account_status !== 'pending') fail(409, 'the account is not pending approval');
 return setAccountStatus(db, auth, actor, tenantId, 'trial', 'application approved');
}

// ---- onboarding -----------------------------------------------------------------------------------------------------------------
const STEPS = 6;
export function getOnboarding(db, env, tenantId) {
 const row = db.prepare('SELECT * FROM client_onboarding WHERE tenant_id=?').get(tenantId);
 const profile = getProfile(db, tenantId);
 const data = parseJson(row.data_json, {});
 const views = agentViews(db, env, tenantId);
 const goals = data.goals || parseJson(profile.goals_json, []);
 const suggested = [...new Set(goals.flatMap(g => GOAL_AGENTS[g] || []))].filter(id => views.find(a => a.key === id)?.usable !== false || true);
 return {
  currentStep: row.current_step, completed: !!row.completed_at, completedAt: row.completed_at, data, defaultAutonomy: row.default_autonomy, steps: STEPS,
  profile: {businessName: profile.business_name, country: profile.country},
  agents: views.map(a => ({key: a.key, nameAr: a.nameAr, nameEn: a.nameEn, descriptionAr: a.descriptionAr, descriptionEn: a.descriptionEn, status: a.status, usable: a.usable, lockedReason: a.lockedReason, reasons: a.reasons, requiredTools: a.requiredTools, suggested: suggested.includes(a.key), paused: a.paused})),
  workspaceStatus: profile.workspace_status
 };
}
export function saveOnboardingStep(db, env, actor, tenantId, step, input) {
 if (!Number.isInteger(step) || step < 1 || step > STEPS) fail(400, 'invalid step');
 const row = db.prepare('SELECT * FROM client_onboarding WHERE tenant_id=?').get(tenantId);
 const data = parseJson(row.data_json, {});
 return tx(db, () => {
  const t = now();
  if (step === 1) {
   const businessName = clean(input.businessName, 100);
   if (businessName.length < 2) fail(400, 'businessName is required');
   const patch = {businessName, industry: clean(input.industry, 80), country: clean(input.country, 60), currency: /^[A-Z]{3}$/.test(input.currency || '') ? input.currency : 'SAR', timezone: clean(input.timezone, 60) || 'Asia/Riyadh', language: ['ar', 'en'].includes(input.language) ? input.language : 'ar', offering: cleanMultiline(input.offering, 1000), audience: cleanMultiline(input.audience, 1000)};
   if (!patch.country || !patch.offering) fail(400, 'country and offering are required');
   Object.assign(data, patch);
   db.prepare('UPDATE client_profiles SET business_name=?,country=?,updated_at=? WHERE tenant_id=?').run(businessName, patch.country, t, tenantId);
   db.prepare('UPDATE tenants SET name=?,default_locale=?,timezone=?,updated_at=? WHERE id=?').run(businessName, patch.language, patch.timezone, t, tenantId);
  } else if (step === 2) {
   if (!Array.isArray(input.goals) || !input.goals.length || input.goals.some(g => !GOALS.includes(g))) fail(400, 'choose at least one valid goal');
   data.goals = [...new Set(input.goals)];
   db.prepare('UPDATE client_profiles SET goals_json=?,updated_at=? WHERE tenant_id=?').run(JSON.stringify(data.goals), t, tenantId);
  } else if (step === 3) {
   data.integrationsReviewed = true;
  } else if (step === 4) {
   if (!Array.isArray(input.agents) || input.agents.some(a => !isCatalogAgent(a))) fail(400, 'agents must be a list of agent keys');
   const access = resolveAccess(db, tenantId);
   const chosen = new Set(input.agents);
   for (const id of chosen) { const g = agentAccess(db, env, tenantId, id, access); if (!g.usable && !['account', 'onboarding'].includes(g.layer)) fail(403, `AGENT_NOT_AVAILABLE:${id}`); }
   for (const id of AGENT_IDS) {
    db.prepare(`INSERT INTO client_agent_settings (tenant_id,agent_id,client_paused,updated_by,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id,agent_id) DO UPDATE SET client_paused=excluded.client_paused,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).run(tenantId, id, chosen.has(id) ? 0 : 1, actor?.id || null, t);
   }
   data.agents = [...chosen];
   syncAgentConfigs(db, tenantId);
  } else if (step === 5) {
   if (!AUTONOMY_LEVELS.includes(input.autonomy)) fail(400, 'autonomy must be manual, approval_required or limited_autonomy');
   db.prepare('UPDATE client_onboarding SET default_autonomy=? WHERE tenant_id=?').run(input.autonomy, tenantId);
   data.autonomyChosen = true;
  }
  const done = new Set(data.doneSteps || []);
  done.add(step);
  data.doneSteps = [...done];
  db.prepare('UPDATE client_onboarding SET data_json=?,current_step=?,updated_at=? WHERE tenant_id=?').run(JSON.stringify(data), Math.min(STEPS, Math.max(row.current_step, step + 1)), t, tenantId);
  audit(db, {tenantId, actor, action: 'CLIENT_ONBOARDING_STEP', entityType: 'onboarding', detail: {step}});
  return getOnboarding(db, env, tenantId);
 });
}
export function completeOnboarding(db, env, actor, tenantId) {
 const row = db.prepare('SELECT * FROM client_onboarding WHERE tenant_id=?').get(tenantId);
 const data = parseJson(row.data_json, {});
 const done = new Set(data.doneSteps || []);
 for (const s of [1, 2, 4, 5]) if (!done.has(s)) fail(409, `ONBOARDING_INCOMPLETE:${s}`);
 tx(db, () => {
  const t = now();
  db.prepare('UPDATE client_onboarding SET completed_at=?,current_step=?,updated_at=? WHERE tenant_id=?').run(t, STEPS, t, tenantId);
  db.prepare("UPDATE client_profiles SET workspace_status='ready',updated_at=? WHERE tenant_id=? AND workspace_status='onboarding'").run(t, tenantId);
  audit(db, {tenantId, actor, action: 'CLIENT_ONBOARDING_COMPLETED', entityType: 'onboarding'});
  notify(db, tenantId, 'onboarding_complete', {}, actor?.id || null);
  syncLifecycle(db);
 });
 return getOnboarding(db, env, tenantId);
}

// ---- team ---------------------------------------------------------------------------------------------------------------------------------
export function listMembers(db, tenantId) {
 const members = db.prepare(`SELECT m.user_id, m.workspace_role, m.status, m.created_at, u.name, u.username, u.email, u.email_verified_at, u.last_login_at FROM client_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.status!='removed' ORDER BY m.created_at`).all(tenantId)
  .map(r => ({userId: r.user_id, name: r.name, username: r.username, email: r.email, emailVerified: !!r.email_verified_at, role: r.workspace_role, status: r.status, joinedAt: r.created_at, lastLoginAt: r.last_login_at, permissions: ROLE_PERMISSIONS[r.workspace_role]}));
 const invites = db.prepare(`SELECT i.id, i.email, i.role, i.status, i.expires_at, i.created_at, r.workspace_role FROM workspace_invitations i LEFT JOIN client_invitation_roles r ON r.invitation_id=i.id WHERE i.tenant_id=? AND i.status='PENDING' ORDER BY i.created_at DESC`).all(tenantId)
  .map(r => ({id: r.id, email: r.email, role: r.workspace_role || 'operator', status: r.status, expiresAt: r.expires_at, createdAt: r.created_at}));
 return {members, invitations: invites};
}
const activeOwners = (db, tenantId) => db.prepare("SELECT COUNT(*) n FROM client_members WHERE tenant_id=? AND workspace_role='workspace_owner' AND status='active'").get(tenantId).n;
function syncLegacyMembership(db, tenantId, userId, role, status) {
 const legacyStatus = status === 'active' ? 'active' : status === 'suspended' ? 'suspended' : 'removed';
 db.prepare('UPDATE tenant_memberships SET role=?,is_owner=?,status=? WHERE tenant_id=? AND user_id=?').run(LEGACY_ROLE[role] || 'operator', role === 'workspace_owner' ? 1 : 0, legacyStatus, tenantId, userId);
}
export function inviteMember(db, actor, tenantId, {email, role}) {
 if (!isEmail(String(email || '').trim().toLowerCase())) fail(400, 'a valid email is required');
 if (!WORKSPACE_ROLES.includes(role) || role === 'workspace_owner') fail(400, 'role must be workspace_admin, manager, operator, analyst or viewer');
 const normalized = String(email).trim().toLowerCase();
 if (db.prepare("SELECT 1 FROM client_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.status='active' AND u.email=?").get(tenantId, normalized)) fail(409, 'this person is already a member');
 const pendingOther = db.prepare("SELECT COUNT(*) n FROM workspace_invitations WHERE tenant_id=? AND status='PENDING' AND email!=?").get(tenantId, normalized).n;
 const access = resolveAccess(db, tenantId);
 const limit = access?.limits.users;
 if (limit !== null && limit !== undefined && usageFor(db, tenantId).users + pendingOther + 1 > limit) throw Object.assign(new Error('LIMIT_REACHED:users'), {status: 403, code: 'LIMIT_REACHED', limitKey: 'users', limit});
 return tx(db, () => {
  const {invitation, token} = createInvitation(db, tenantId, {email: normalized, role: LEGACY_ROLE[role]}, actor.id);
  db.prepare('INSERT INTO client_invitation_roles (invitation_id,workspace_role) VALUES (?,?) ON CONFLICT(invitation_id) DO UPDATE SET workspace_role=excluded.workspace_role').run(invitation.id, role);
  audit(db, {tenantId, actor, action: 'CLIENT_MEMBER_INVITED', entityType: 'invitation', entityId: invitation.id, detail: {email: normalized, role}});
  return {invitation: {id: invitation.id, email: normalized, role, expiresAt: invitation.expiresAt}, token};
 });
}
export function resendMemberInvitation(db, actor, tenantId, id) {
 const r = resendInvitation(db, tenantId, id);
 audit(db, {tenantId, actor, action: 'CLIENT_INVITATION_RESENT', entityType: 'invitation', entityId: id});
 return r;
}
export function revokeMemberInvitation(db, actor, tenantId, id) {
 revokeInvitation(db, tenantId, id);
 audit(db, {tenantId, actor, action: 'CLIENT_INVITATION_REVOKED', entityType: 'invitation', entityId: id});
 return {ok: true};
}
export const previewClientInvitation = (db, token) => previewInvitation(db, token);
/** Accepts a portal invitation through the platform's own acceptance (single-use, email-bound) and attaches the portal role. */
export function acceptClientInvitation(db, token, userId, opts = {}) {
 const inv = db.prepare('SELECT id, tenant_id FROM workspace_invitations WHERE token_hash=?').get(sha(token));
 if (!inv || !getProfile(db, inv.tenant_id)) fail(404, 'رابط الدعوة غير صالح');
 return tx(db, () => {
  const accepted = acceptInvitation(db, token, userId, opts);
  const role = db.prepare('SELECT workspace_role FROM client_invitation_roles WHERE invitation_id=?').get(inv.id)?.workspace_role || 'operator';
  const t = now();
  db.prepare(`INSERT INTO client_members (tenant_id,user_id,workspace_role,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)
   ON CONFLICT(tenant_id,user_id) DO UPDATE SET workspace_role=excluded.workspace_role,status='active',updated_at=excluded.updated_at`).run(accepted.tenantId, userId, role, t, t);
  syncLegacyMembership(db, accepted.tenantId, userId, role, 'active');
  const user = db.prepare('SELECT name FROM users WHERE id=?').get(userId);
  audit(db, {tenantId: accepted.tenantId, actor: {id: userId, name: user?.name, kind: 'user'}, action: 'CLIENT_INVITATION_ACCEPTED', entityType: 'invitation', entityId: inv.id, detail: {role}});
  notifyMembers(db, accepted.tenantId, 'member_joined', {name: user?.name, role}, 'team.manage');
  return {tenantId: accepted.tenantId, tenantName: accepted.tenantName, role};
 });
}
export {roleForValidToken};
export function changeMemberRole(db, actor, tenantId, userId, role) {
 if (!WORKSPACE_ROLES.includes(role)) fail(400, 'invalid role');
 const m = db.prepare('SELECT * FROM client_members WHERE tenant_id=? AND user_id=?').get(tenantId, userId);
 if (!m || m.status === 'removed') fail(404, 'Member not found');
 if (m.workspace_role === 'workspace_owner' && role !== 'workspace_owner' && activeOwners(db, tenantId) <= 1) fail(409, 'LAST_OWNER');
 tx(db, () => {
  db.prepare('UPDATE client_members SET workspace_role=?,updated_at=? WHERE tenant_id=? AND user_id=?').run(role, now(), tenantId, userId);
  syncLegacyMembership(db, tenantId, userId, role, m.status);
  audit(db, {tenantId, actor, action: 'CLIENT_MEMBER_ROLE_CHANGED', entityType: 'member', entityId: userId, detail: {from: m.workspace_role, to: role}});
  notify(db, tenantId, 'role_changed', {role}, userId);
 });
}
export function setMemberStatus(db, auth, actor, tenantId, userId, status) {
 if (!['active', 'suspended', 'removed'].includes(status)) fail(400, 'invalid status');
 const m = db.prepare('SELECT * FROM client_members WHERE tenant_id=? AND user_id=?').get(tenantId, userId);
 if (!m || m.status === 'removed') fail(404, 'Member not found');
 if (m.workspace_role === 'workspace_owner' && status !== 'active' && activeOwners(db, tenantId) <= 1) fail(409, 'LAST_OWNER');
 tx(db, () => {
  db.prepare('UPDATE client_members SET status=?,updated_at=? WHERE tenant_id=? AND user_id=?').run(status, now(), tenantId, userId);
  syncLegacyMembership(db, tenantId, userId, m.workspace_role, status);
  if (status !== 'active') auth.revokeSessions(userId);
  audit(db, {tenantId, actor, action: `CLIENT_MEMBER_${status.toUpperCase()}`, entityType: 'member', entityId: userId});
 });
}
/** Ownership moves only to an existing active, email-verified member; the old owner becomes an admin. */
export function transferOwnership(db, actor, tenantId, toUserId, confirmName) {
 const profile = getProfile(db, tenantId);
 if (clean(confirmName, 100) !== profile.business_name) fail(400, 'CONFIRM_NAME_MISMATCH');
 const target = db.prepare("SELECT m.*, u.email_verified_at FROM client_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.user_id=? AND m.status='active'").get(tenantId, toUserId);
 if (!target) fail(404, 'Member not found');
 if (!target.email_verified_at) fail(409, 'TARGET_EMAIL_NOT_VERIFIED');
 if (toUserId === actor.id) fail(400, 'already the owner');
 tx(db, () => {
  const t = now();
  db.prepare("UPDATE client_members SET workspace_role='workspace_owner',updated_at=? WHERE tenant_id=? AND user_id=?").run(t, tenantId, toUserId);
  db.prepare("UPDATE client_members SET workspace_role='workspace_admin',updated_at=? WHERE tenant_id=? AND user_id=?").run(t, tenantId, actor.id);
  syncLegacyMembership(db, tenantId, toUserId, 'workspace_owner', 'active');
  syncLegacyMembership(db, tenantId, actor.id, 'workspace_admin', 'active');
  db.prepare('UPDATE client_profiles SET owner_user_id=?,updated_at=? WHERE tenant_id=?').run(toUserId, t, tenantId);
  audit(db, {tenantId, actor, action: 'CLIENT_OWNERSHIP_TRANSFERRED', entityType: 'account', detail: {to: toUserId}});
  notify(db, tenantId, 'ownership_transferred', {}, toUserId);
 });
}
export function leaveWorkspace(db, auth, actor, tenantId) {
 setMemberStatus(db, auth, actor, tenantId, actor.id, 'removed');
}

export {acceptInvitation, assertWithinLimit, assignPlan, effectiveState, getPlan};
