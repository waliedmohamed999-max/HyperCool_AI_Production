import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {isPlatformAdmin} from '../platform-admin.js';
import {recordPlatformAudit, registerPublicUser, checkSignupRateLimit} from '../platform-identity.js';
import {sendVerificationEmail, sendInvitationEmail, platformMailStatus} from '../runtime/platform-mail.js';
import {checkGlobalSignupLimit} from '../runtime/pilot-limits.js';
import {captchaRequiredFor, verifyBotProtection} from '../runtime/bot-protection.js';
import {checkInvitationRateLimit, resendInvitation} from '../invitations.js';
import {decideApproval} from '../runtime/approvals.js';
import {listRuns, getRun} from '../runtime/runtime.js';
import {attributeRegistration} from '../partners/referrals.js';
import {getTenant} from '../tenancy.js';
import {LEGACY_ROLE, ROLE_PERMISSIONS, audit, clean, getSettings, listAudit, notify, saveSettings, sha} from './core.js';
import {isCatalogAgent, listCatalog} from './catalog.js';
import {ALL_ENTITLEMENTS, assignPlan, createPlan, getProfile, grantGrace, listPlans, planCustomerCounts, setOverrides, syncLifecycle, updatePlan, usageFor} from './plans.js';
import {agentView, agentViews, setAgentAdminControl, setAgentClientSettings, setPlatformAvailability, syncAgentConfigs} from './agents.js';
import {acceptClientInvitation, approvePending, changeMemberRole, completeOnboarding, getOnboarding, inviteMember, leaveWorkspace, listMembers, previewClientInvitation, registerClient, resendMemberInvitation, revokeMemberInvitation, roleForValidToken, saveOnboardingStep, setAccountStatus, setMemberStatus, transferOwnership, BUSINESS_SIZES, BUSINESS_TYPES, GOALS, PLATFORMS} from './accounts.js';
import {can, publicAccess, requireEntitlement, requirePermission, requireState, resolveClientContext} from './context.js';
import {cancelTask, createTask, dispatchTask, getTask, listTasks, onTaskApprovalDecided, pauseTask, requeueTask, runDueTasks, settleTaskAfterToolApproval, taskDetail} from './tasks.js';
import {SUPPORT_COOKIE, canStartSupport, endSupportSession, expireSupportSessions, listSupportSessions, logSupportEvent, startSupportSession, supportSessionDetail} from './support.js';
import {analyticsFor, approvalsView, billingView, connectApiKeyIntegration, dashboardFor, integrationsView, listClientNotifications, markNotificationsRead, testClientConnection} from './views.js';
import {cancelRun as cancelWorkflowRun, createFromTemplate, lifecycle as workflowLifecycle, listTemplates, runDetail as workflowRunDetail, runNow as runWorkflowNow, runsOf as workflowRunsOf, updateFromTemplate, workflowDetail, workflowsView} from './workflows.js';
import {disconnectByConnectionId, disconnectBySlug, handleOAuthCallback, providerStatus, startOAuth} from './oauth.js';
import {getOAuthProvider} from '../integrations/oauth-providers.js';
import {addCustomerNote, adminOverview, agentsAdminView, customerDetail, globalAudit, integrationsTable, listCustomers, permissionsCatalog, usageTable} from './admin.js';

// HTTP surface of the merchant portal (/api/client/*) and of the platform-admin customer management
// (/api/client-admin/*). Authentication is the platform's own session; tenant identity is derived from the
// server (client_members / a validated support session), never from the request.

export const CLIENT_PAGES_PREFIX = '/client';
const cookieOf = (req, name) => req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) || null;
const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
const clientIp = (req, env) => (env.PUBLIC_ORIGIN ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '';

export function createClientRoutes({store, env, auth, fetcher, agentRuntime, workflowDeps, readJson, secureCookie, applyApproval}) {
 const db = store.db;
 const deps = {db, env, agentRuntime};
 const mailCtx = () => ({db, env, fetcher});
 const sessionCookie = result => `hc_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie}`;
 const last = new WeakMap();
 async function maintenance(force = false) {
  const t = Date.now();
  if (!force && t - (last.get(db) || 0) < 20000) return;
  last.set(db, t);
  try { syncLifecycle(db); expireSupportSessions(db); await runDueTasks(deps, t); } catch (error) { console.error(JSON.stringify({level: 'ERROR', source: 'client-maintenance', message: String(error.message).slice(0, 200)})); }
 }
 // Timer so scheduled tasks and expiries progress even with no traffic (unref'd: never keeps the process alive).
 const timer = setInterval(() => { maintenance(true).catch(() => {}); }, 30000);
 timer.unref?.();

 const publicPlans = () => listPlans(db, {publicOnly: true}).filter(p => p.planType !== 'partner').map(p => ({slug: p.slug, nameAr: p.nameAr, nameEn: p.nameEn, descriptionAr: p.descriptionAr, descriptionEn: p.descriptionEn, priceMinor: p.priceMinor, currency: p.currency, billingPeriod: p.billingPeriod, highlighted: p.highlighted, trialDays: p.trialDays, entitlements: p.entitlements, limits: p.limits, supportLevel: p.supportLevel}));

 function guard(ctx, req, {perm = null, ent = null, write = false, sensitive = false, input = null, deny = null} = {}) {
  requireState(ctx, {write});
  if (write && ctx.readOnly) { if (ctx.support) logSupportEvent(db, ctx.support, {kind: 'blocked', method: req.method, path: req.url.split('?')[0], detail: 'read-only support session'}); fail(403, 'SUPPORT_READ_ONLY'); }
  if (deny && ctx.support) fail(403, `SUPPORT_FORBIDDEN:${deny}`);
  if (ent) requireEntitlement(ctx, ent);
  if (perm) requirePermission(ctx, perm);
  if (sensitive && ctx.support && input?.confirmSupport !== true) fail(428, 'SUPPORT_CONFIRMATION_REQUIRED');
 }

 return async function handle(req, res, url, session, {send, baseUrl}) {
  const path = url.pathname, method = req.method;
  const isClient = path.startsWith('/api/client/'), isAdmin = path.startsWith('/api/client-admin/');
  if (!isClient && !isAdmin) return false;
  await maintenance();

  // ================================== public ==================================
  if (isClient && method === 'GET' && path === '/api/client/public/config') {
   const s = getSettings(db);
   send(200, {agents: listCatalog().map(a => ({key: a.key, nameAr: a.nameAr, nameEn: a.nameEn, descriptionAr: a.descriptionAr, descriptionEn: a.descriptionEn, category: a.category, riskLevel: a.riskLevel})), plans: publicPlans(), registrationMode: s.registration_mode, termsVersion: s.terms_version, termsAr: s.terms_ar, termsEn: s.terms_en, privacyAr: s.privacy_ar, privacyEn: s.privacy_en, options: {businessTypes: BUSINESS_TYPES, businessSizes: BUSINESS_SIZES, platforms: PLATFORMS, goals: GOALS}});
   return true;
  }
  if (isClient && method === 'POST' && path === '/api/client/register') {
   if (env.ALLOW_PUBLIC_SIGNUP === 'false') fail(403, 'REGISTRATION_CLOSED');
   checkSignupRateLimit(req.socket.remoteAddress);
   checkGlobalSignupLimit(env);
   const input = await readJson(req);
   if (captchaRequiredFor(env, 'signup')) {
    const captcha = await verifyBotProtection({env, fetcher}, input.captchaToken, req.socket.remoteAddress);
    if (!captcha.ok) fail(400, captcha.errorCode);
   }
   const r = registerClient(db, env, auth, input);
   attributeRegistration(db, env, {userId: r.user.id, email: r.normalizedEmail, visitorId: cookieOf(req, 'frost_ref'), ip: clientIp(req, env)});
   const locale = ['ar', 'en'].includes(input.locale) ? input.locale : 'ar';
   const delivery = await sendVerificationEmail(mailCtx(), {to: r.normalizedEmail, locale, verifyUrl: `${baseUrl}/client/verify-email/${r.token}`});
   recordPlatformAudit(db, {id: randomUUID(), action: 'USER_REGISTERED', itemId: r.user.id, actorId: r.user.id, actorName: r.user.name, at: new Date().toISOString()});
   const result = auth.session(db.prepare('SELECT * FROM users WHERE id=?').get(r.user.id));
   res.setHeader('Set-Cookie', sessionCookie(result));
   send(201, {user: result.user, csrf: result.csrf, tenantId: r.tenantId, pending: r.pending, delivered: delivery.delivered});
   return true;
  }
  const invPublic = path.match(/^\/api\/client\/invitations\/([\w-]+)\/(preview|register|accept)$/);
  if (isClient && invPublic) {
   checkInvitationRateLimit(req.socket.remoteAddress);
   const token = invPublic[1];
   if (method === 'GET' && invPublic[2] === 'preview') { send(200, previewClientInvitation(db, token)); return true; }
   if (method === 'POST' && invPublic[2] === 'register') {
    const input = await readJson(req);
    const legacy = roleForValidToken(db, token);
    const created = auth.createUser({username: input.username, name: input.name, password: input.password}, legacy);
    const accepted = acceptClientInvitation(db, token, created.id, {isNewAccount: true});
    const result = auth.session(db.prepare('SELECT * FROM users WHERE id=?').get(created.id));
    res.setHeader('Set-Cookie', sessionCookie(result));
    send(200, {user: result.user, csrf: result.csrf, workspace: accepted});
    return true;
   }
   if (method === 'POST' && invPublic[2] === 'accept') {
    if (!session) fail(401, 'سجل الدخول أولًا');
    if (req.headers['x-csrf-token'] !== session.csrf) fail(403, 'رمز حماية الجلسة غير صالح');
    send(200, {workspace: acceptClientInvitation(db, token, session.user.id)});
    return true;
   }
  }
  // The provider's redirect back to us. Its authority is the signed, single-use state (bound to workspace + initiating user),
  // not a session: the browser arrives cross-site, so the SameSite=Strict session cookie is not sent.
  const oauthCallback = path.match(/^\/api\/client\/integrations\/([\w-]+)\/callback$/);
  if (isClient && method === 'GET' && oauthCallback) {
   const outcome = await handleOAuthCallback({db, env, fetcher, baseUrl, slug: oauthCallback[1], query: url.searchParams, session});
   res.writeHead(302, {Location: outcome.redirect});
   res.end();
   return true;
  }
  if (!session) fail(401, 'سجل الدخول أولًا');
  if (method !== 'GET' && req.headers['x-csrf-token'] !== session.csrf) fail(403, 'رمز حماية الجلسة غير صالح');

  // ============================ platform admin API ============================
  if (isAdmin) {
   if (!isPlatformAdmin(env, session.user)) fail(403, 'هذا الإجراء متاح فقط لمسؤول المنصة');
   return handleAdmin(req, res, url, session, {send});
  }

  // ================================ merchant API ================================
  const ctx = resolveClientContext(db, env, session, cookieOf(req, SUPPORT_COOKIE));
  if (ctx.error) fail(ctx.error.status, ctx.error.code);
  if (ctx.support) logSupportEvent(db, ctx.support, {kind: method === 'GET' ? 'read' : 'write', method, path});
  const sub = path.slice('/api/client/'.length);
  const q = re => sub.match(re);

  if (method === 'GET' && sub === 'me') {
   const onboarding = db.prepare('SELECT current_step, completed_at FROM client_onboarding WHERE tenant_id=?').get(ctx.tenantId);
   const unread = db.prepare('SELECT COUNT(*) n FROM client_notifications WHERE tenant_id=? AND (user_id IS NULL OR user_id=?) AND read_at IS NULL').get(ctx.tenantId, ctx.user.id).n;
   send(200, {
    user: {id: ctx.user.id, name: ctx.user.name, username: ctx.user.username, email: ctx.user.email || ctx.user.pendingEmail || null, emailVerified: !!ctx.user.emailVerifiedAt, isPlatformAdmin: isPlatformAdmin(env, ctx.user)},
    workspace: {id: ctx.tenantId, name: ctx.tenant.name, slug: ctx.tenant.slug, locale: ctx.tenant.defaultLocale, timezone: ctx.tenant.timezone},
    role: ctx.role, permissions: [...ctx.permissions], access: publicAccess(ctx), onboarding: {completed: !!onboarding?.completed_at, step: onboarding?.current_step || 1},
    support: ctx.support ? {id: ctx.support.id, level: ctx.support.access_level, expiresAt: ctx.support.expires_at, adminName: ctx.support.admin_name, reason: ctx.support.reason, readOnly: ctx.readOnly} : null,
    unreadNotifications: unread, capabilities: {mailConfigured: platformMailStatus(env).status === 'CONFIGURED', partnerReferral: false}
   });
   return true;
  }
  if (method === 'GET' && sub === 'dashboard') { guard(ctx, req, {ent: 'client.dashboard'}); send(200, dashboardFor(db, env, ctx)); return true; }

  // ---- onboarding
  if (sub === 'onboarding' || sub.startsWith('onboarding/')) {
   if (method === 'GET' && sub === 'onboarding') { guard(ctx, req, {}); send(200, getOnboarding(db, env, ctx.tenantId)); return true; }
   const step = q(/^onboarding\/(\d)$/);
   if (method === 'PUT' && step) { guard(ctx, req, {perm: 'settings.manage', write: false}); if (ctx.readOnly) fail(403, 'SUPPORT_READ_ONLY'); send(200, saveOnboardingStep(db, env, ctx.actor, ctx.tenantId, Number(step[1]), await readJson(req))); return true; }
   if (method === 'POST' && sub === 'onboarding/complete') { guard(ctx, req, {perm: 'settings.manage'}); if (ctx.readOnly) fail(403, 'SUPPORT_READ_ONLY'); send(200, completeOnboarding(db, env, ctx.actor, ctx.tenantId)); return true; }
  }

  // ---- agents
  if (method === 'GET' && sub === 'agents') { guard(ctx, req, {perm: 'agents.view'}); send(200, {items: agentViews(db, env, ctx.tenantId), autonomyLevels: ['manual', 'approval_required', 'limited_autonomy']}); return true; }
  const agentOne = q(/^agents\/([a-z_]+)(?:\/(settings))?$/);
  if (agentOne) {
   if (!isCatalogAgent(agentOne[1])) fail(404, 'Unknown agent');
   const id = agentOne[1];
   if (method === 'GET' && !agentOne[2]) {
    guard(ctx, req, {perm: 'agents.view'});
    send(200, {agent: agentView(db, env, ctx.tenantId, id),
     tasks: db.prepare('SELECT id,title,status,priority,created_at,error FROM client_tasks WHERE tenant_id=? AND agent_id=? ORDER BY created_at DESC, rowid DESC LIMIT 10').all(ctx.tenantId, id).map(r => ({id: r.id, title: r.title, status: r.status, priority: r.priority, createdAt: r.created_at, error: r.error})),
     scheduled: db.prepare("SELECT id,title,scheduled_at FROM client_tasks WHERE tenant_id=? AND agent_id=? AND status='queued' AND scheduled_at>? ORDER BY scheduled_at LIMIT 10").all(ctx.tenantId, id, new Date().toISOString()).map(r => ({id: r.id, title: r.title, scheduledAt: r.scheduled_at})),
     runs: listRuns(db, {agentId: id, limit: 10}, ctx.tenantId).map(r => ({id: r.id, status: r.status, startedAt: r.startedAt || r.started_at, finishedAt: r.finishedAt || r.finished_at, error: r.error || null, triggerType: r.triggerType || r.trigger_type})),
     activity: db.prepare("SELECT action,actor_name,actor_kind,created_at FROM client_audit_logs WHERE tenant_id=? AND entity_type='agent' AND entity_id=? ORDER BY created_at DESC LIMIT 15").all(ctx.tenantId, id).map(r => ({action: r.action, actorName: r.actor_name, actorKind: r.actor_kind, at: r.created_at}))});
    return true;
   }
   if (method === 'PATCH' && agentOne[2] === 'settings') {
    const input = await readJson(req);
    guard(ctx, req, {perm: 'agents.configure', write: true});
    setAgentClientSettings(db, ctx.actor, ctx.tenantId, id, input);
    send(200, {agent: agentView(db, env, ctx.tenantId, id)});
    return true;
   }
  }

  // ---- tasks
  if (sub === 'tasks' && method === 'GET') { guard(ctx, req, {perm: 'agents.view'}); send(200, listTasks(db, ctx.tenantId, url)); return true; }
  if (sub === 'tasks' && method === 'POST') {
   const input = await readJson(req);
   guard(ctx, req, {perm: 'tasks.create', write: true});
   if (ctx.profile.workspace_status === 'onboarding') fail(409, 'ONBOARDING_INCOMPLETE');
   let task = createTask(db, env, ctx, input);
   if (task.status === 'queued' && !task.scheduledAt) {
    const running = dispatchTask(deps, ctx.tenantId, task.id, {id: ctx.actor.id, name: ctx.actor.name, kind: ctx.actor.kind});
    if (input.wait === true) task = await running; else running.catch(() => {});
   }
   send(201, task);
   return true;
  }
  if (sub === 'export/tasks.csv' && method === 'GET') {
   guard(ctx, req, {ent: 'client.export', perm: 'analytics.view'});
   const big = new URL(url); big.searchParams.set('limit', '100');
   const rows = [['id', 'agent', 'title', 'status', 'priority', 'created_at', 'completed_at'], ...listTasks(db, ctx.tenantId, big).items.map(t => [t.id, t.agentId, t.title, t.status, t.priority, t.createdAt, t.completedAt])];
   res.writeHead(200, {'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tasks.csv"'});
   res.end('﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'));
   return true;
  }
  const taskOne = q(/^tasks\/([\w-]+)(?:\/(cancel|pause|resume|retry|submit))?$/);
  if (taskOne) {
   const id = taskOne[1], action = taskOne[2];
   if (method === 'GET' && !action) { guard(ctx, req, {perm: 'agents.view'}); send(200, taskDetail(db, ctx.tenantId, id)); return true; }
   if (method === 'POST' && action) {
    guard(ctx, req, {perm: action === 'cancel' ? 'tasks.cancel' : 'tasks.create', write: true});
    let task;
    if (action === 'cancel') task = cancelTask(db, ctx, id);
    else if (action === 'pause') task = pauseTask(db, ctx, id, true);
    else if (action === 'resume') task = pauseTask(db, ctx, id, false);
    else { task = requeueTask(db, ctx, id); const p = dispatchTask(deps, ctx.tenantId, id, {id: ctx.actor.id, name: ctx.actor.name, kind: ctx.actor.kind}); const body = await readJson(req).catch(() => ({})); if (body.wait === true) task = await p; else p.catch(() => {}); }
    send(200, task);
    return true;
   }
  }

  // ---- approvals
  if (sub === 'approvals' && method === 'GET') { guard(ctx, req, {ent: 'client.approvals', perm: 'agents.view'}); send(200, approvalsView(db, ctx.tenantId, url)); return true; }
  const approvalDecide = q(/^approvals\/([\w-]+)\/decide$/);
  if (approvalDecide && method === 'POST') {
   const input = await readJson(req);
   guard(ctx, req, {ent: 'client.approvals', perm: 'approvals.review', write: true, sensitive: true, input});
   if (!['APPROVED', 'REJECTED'].includes(input.decision)) fail(400, 'decision must be APPROVED or REJECTED');
   if (input.decision === 'REJECTED' && !clean(input.reason, 500)) fail(400, 'a reason is required to reject');
   const decided = decideApproval(db, approvalDecide[1], input.decision, ctx.user, ctx.tenantId);
   audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: `CLIENT_APPROVAL_${input.decision}`, entityType: 'approval', entityId: decided.id, reason: clean(input.reason, 500) || null, detail: {actionType: decided.action_type, agentId: decided.agent_id}});
   let extra = {};
   if (decided.action_type === 'client_task_execution') { const task = await onTaskApprovalDecided(deps, decided, ctx.actor); extra = {task}; }
   else {
    const full = await applyApproval(decided, {user: ctx.user, tenantId: ctx.tenantId});
    extra = Object.fromEntries(Object.entries(full || {}).filter(([k]) => !(k in decided)));
    const settled = settleTaskAfterToolApproval(db, decided);
    if (settled) extra = {...extra, task: settled};
   }
   send(200, {id: decided.id, status: decided.status, actionType: decided.action_type, ...extra});
   return true;
  }

  // ---- workflows: TEMPLATES only (see workflows.js). Creation/edit accept bounded inputs; lifecycle goes through the engine.
  if (sub === 'workflows' && method === 'GET') { guard(ctx, req, {ent: 'client.workflows', perm: 'agents.view'}); send(200, {items: workflowsView(db, env, ctx), templates: listTemplates(db, env, ctx)}); return true; }
  if (sub === 'workflows/templates' && method === 'GET') { guard(ctx, req, {ent: 'client.workflows', perm: 'agents.view'}); send(200, {items: listTemplates(db, env, ctx)}); return true; }
  if (sub === 'workflows' && method === 'POST') {
   const input = await readJson(req);
   guard(ctx, req, {ent: 'client.workflows', perm: 'agents.configure', write: true});
   send(201, createFromTemplate(db, env, ctx, input));
   return true;
  }
  const wfRun = q(/^workflow-runs\/([\w-]+)(?:\/(cancel))?$/);
  if (wfRun) {
   if (method === 'GET' && !wfRun[2]) { guard(ctx, req, {ent: 'client.workflows', perm: 'agents.view'}); send(200, workflowRunDetail(db, ctx, wfRun[1])); return true; }
   if (method === 'POST' && wfRun[2]) { guard(ctx, req, {ent: 'client.workflows', perm: 'agents.run', write: true}); send(200, cancelWorkflowRun(db, ctx, wfRun[1])); return true; }
  }
  const wfOne = q(/^workflows\/([\w-]+)(?:\/(activate|pause|resume|archive|run|runs))?$/);
  if (wfOne && wfOne[1] !== 'templates') {
   const [, id, action] = wfOne;
   if (method === 'GET' && !action) { guard(ctx, req, {ent: 'client.workflows', perm: 'agents.view'}); send(200, workflowDetail(db, env, ctx, id)); return true; }
   if (method === 'GET' && action === 'runs') { guard(ctx, req, {ent: 'client.workflows', perm: 'agents.view'}); send(200, {items: workflowRunsOf(db, ctx, id)}); return true; }
   if (method === 'PATCH' && !action) {
    const input = await readJson(req);
    guard(ctx, req, {ent: 'client.workflows', perm: 'agents.configure', write: true});
    send(200, updateFromTemplate(db, env, ctx, id, input));
    return true;
   }
   if (method === 'POST' && action === 'run') {
    guard(ctx, req, {ent: 'client.workflows', perm: 'agents.run', write: true});
    const run = await runWorkflowNow(workflowDeps, db, env, ctx, id);
    send(201, run);
    return true;
   }
   if (method === 'POST' && ['activate', 'pause', 'resume', 'archive'].includes(action)) {
    const input = await readJson(req).catch(() => ({}));
    guard(ctx, req, {ent: 'client.workflows', perm: 'agents.configure', write: true, sensitive: action === 'archive', input});
    send(200, workflowLifecycle(db, env, ctx, id, action));
    return true;
   }
  }

  // ---- integrations
  if (sub === 'integrations' && method === 'GET') { guard(ctx, req, {ent: 'client.integrations', perm: 'agents.view'}); send(200, {items: integrationsView(db, ctx.tenantId, {env, baseUrl})}); return true; }
  if (sub === 'integrations/connect' && method === 'POST') {
   const input = await readJson(req);
   guard(ctx, req, {ent: 'client.integrations', perm: 'integrations.manage', write: true});
   const id = await connectApiKeyIntegration(db, env, fetcher, ctx, input);
   send(201, {id, items: integrationsView(db, ctx.tenantId, {env, baseUrl})});
   return true;
  }
  // OAuth providers: /integrations/:provider/(connect|status|disconnect). Anything else under /integrations/:id/ is a connection id.
  const oauthProvider = q(/^integrations\/([a-z0-9]+)\/(connect|status|disconnect)$/);
  if (oauthProvider && getOAuthProvider(oauthProvider[1])) {
   const [, slug, action] = oauthProvider;
   if (action === 'status' && method === 'GET') { guard(ctx, req, {ent: 'client.integrations', perm: 'agents.view'}); send(200, providerStatus(db, env, ctx, slug, {baseUrl})); return true; }
   if (action === 'connect' && method === 'POST') {
    const input = await readJson(req).catch(() => ({}));
    guard(ctx, req, {ent: 'client.integrations', perm: 'integrations.manage', write: true, deny: 'oauth_connect'});
    send(200, startOAuth(db, env, ctx, slug, {baseUrl, connectionId: input.connectionId ?? null}));
    return true;
   }
   if (action === 'disconnect' && method === 'POST') {
    const input = await readJson(req).catch(() => ({}));
    guard(ctx, req, {ent: 'client.integrations', perm: 'integrations.manage', write: true, sensitive: true, input});
    send(200, await disconnectBySlug(db, env, fetcher, ctx, slug, input.connectionId ?? null));
    return true;
   }
  }
  const integ = q(/^integrations\/([\w-]+)\/(test|disconnect)$/);
  if (integ && method === 'POST') {
   const input = await readJson(req).catch(() => ({}));
   guard(ctx, req, {ent: 'client.integrations', perm: 'integrations.manage', write: true, sensitive: integ[2] === 'disconnect', input});
   send(200, integ[2] === 'test' ? await testClientConnection(db, env, fetcher, ctx, integ[1], store) : await disconnectByConnectionId(db, env, fetcher, ctx, integ[1]));
   return true;
  }

  // ---- analytics / notifications / billing / audit
  if (sub === 'analytics' && method === 'GET') { guard(ctx, req, {ent: 'client.analytics', perm: 'analytics.view'}); send(200, analyticsFor(db, ctx.tenantId, Number(url.searchParams.get('days')) || 30)); return true; }
  if (sub === 'notifications' && method === 'GET') { requireState(ctx, {write: false}); send(200, listClientNotifications(db, ctx, url)); return true; }
  if (sub === 'notifications/read' && method === 'POST') { const i = await readJson(req); if (ctx.readOnly) fail(403, 'SUPPORT_READ_ONLY'); markNotificationsRead(db, ctx, i.ids); send(200, {ok: true}); return true; }
  if (sub === 'billing' && method === 'GET') { guard(ctx, req, {}); send(200, billingView(db, ctx.tenantId)); return true; }
  if (sub === 'audit' && method === 'GET') { guard(ctx, req, {perm: 'audit.view'}); send(200, listAudit(db, ctx.tenantId, url)); return true; }

  // ---- team
  if (sub === 'team' && method === 'GET') { guard(ctx, req, {ent: 'client.team', perm: 'agents.view'}); send(200, {...listMembers(db, ctx.tenantId), roles: Object.keys(ROLE_PERMISSIONS), limit: ctx.access.limits.users, used: usageFor(db, ctx.tenantId).users}); return true; }
  if (sub === 'team/invitations' && method === 'POST') {
   const input = await readJson(req);
   guard(ctx, req, {ent: 'client.team', perm: 'team.manage', write: true});
   const {invitation, token} = inviteMember(db, ctx.actor, ctx.tenantId, input);
   const acceptUrl = `${baseUrl}/client/invite/${token}`;
   const delivery = await sendInvitationEmail(mailCtx(), {to: invitation.email, locale: ctx.tenant.defaultLocale === 'en' ? 'en' : 'ar', workspaceName: ctx.tenant.name, acceptUrl, role: invitation.role});
   send(201, {invitation, delivered: delivery.delivered, acceptUrl: delivery.delivered ? undefined : acceptUrl});
   return true;
  }
  const invAct = q(/^team\/invitations\/([\w-]+)\/(resend|revoke)$/);
  if (invAct && method === 'POST') {
   const input = await readJson(req).catch(() => ({}));
   guard(ctx, req, {ent: 'client.team', perm: 'team.manage', write: true, sensitive: invAct[2] === 'revoke', input});
   if (invAct[2] === 'revoke') { send(200, revokeMemberInvitation(db, ctx.actor, ctx.tenantId, invAct[1])); return true; }
   const r = resendMemberInvitation(db, ctx.actor, ctx.tenantId, invAct[1]);
   const inv = db.prepare('SELECT email FROM workspace_invitations WHERE id=? AND tenant_id=?').get(invAct[1], ctx.tenantId);
   const acceptUrl = `${baseUrl}/client/invite/${r.token}`;
   const delivery = await sendInvitationEmail(mailCtx(), {to: inv.email, locale: 'ar', workspaceName: ctx.tenant.name, acceptUrl, role: 'member'});
   send(200, {delivered: delivery.delivered, acceptUrl: delivery.delivered ? undefined : acceptUrl});
   return true;
  }
  const memberAct = q(/^team\/members\/([\w-]+)$/);
  if (memberAct && method === 'PATCH') {
   const input = await readJson(req);
   guard(ctx, req, {ent: 'client.team', perm: 'team.manage', write: true, sensitive: true, input});
   if (memberAct[1] === ctx.user.id && !ctx.support) fail(400, 'use the leave action to remove yourself');
   if (input.role !== undefined) {
    if (input.role === 'workspace_owner' && ctx.role !== 'workspace_owner') fail(403, 'only an owner can create another owner');
    changeMemberRole(db, ctx.actor, ctx.tenantId, memberAct[1], input.role);
   }
   if (input.status !== undefined) setMemberStatus(db, auth, ctx.actor, ctx.tenantId, memberAct[1], input.status);
   send(200, listMembers(db, ctx.tenantId));
   return true;
  }
  if (sub === 'team/transfer-ownership' && method === 'POST') {
   const input = await readJson(req);
   guard(ctx, req, {ent: 'client.team', perm: 'team.manage', write: true, deny: 'ownership'});
   if (ctx.role !== 'workspace_owner') fail(403, 'only the owner can transfer ownership');
   transferOwnership(db, ctx.actor, ctx.tenantId, input.userId, input.confirmName);
   send(200, {ok: true});
   return true;
  }
  if (sub === 'team/leave' && method === 'POST') {
   guard(ctx, req, {write: true, deny: 'leave'});
   leaveWorkspace(db, auth, ctx.actor, ctx.tenantId);
   send(200, {ok: true});
   return true;
  }

  // ---- settings
  if (sub === 'settings' && method === 'GET') {
   guard(ctx, req, {});
   const onboarding = db.prepare('SELECT default_autonomy FROM client_onboarding WHERE tenant_id=?').get(ctx.tenantId);
   send(200, {workspace: {name: ctx.tenant.name, slug: ctx.tenant.slug, locale: ctx.tenant.defaultLocale, timezone: ctx.tenant.timezone}, defaultAutonomy: onboarding?.default_autonomy || 'approval_required', profile: {phone: ctx.profile.phone, country: ctx.profile.country, storeUrl: ctx.profile.store_url, ecommercePlatform: ctx.profile.ecommerce_platform, businessType: ctx.profile.business_type, businessSize: ctx.profile.business_size}});
   return true;
  }
  if (sub === 'settings' && method === 'PATCH') {
   const input = await readJson(req);
   guard(ctx, req, {perm: 'settings.manage', write: true});
   const t = new Date().toISOString();
   if (input.name !== undefined) { const name = clean(input.name, 100); if (name.length < 2) fail(400, 'name is required'); db.prepare('UPDATE tenants SET name=?,updated_at=? WHERE id=?').run(name, t, ctx.tenantId); db.prepare('UPDATE client_profiles SET business_name=?,updated_at=? WHERE tenant_id=?').run(name, t, ctx.tenantId); }
   if (input.locale !== undefined) { if (!['ar', 'en'].includes(input.locale)) fail(400, 'invalid locale'); db.prepare('UPDATE tenants SET default_locale=?,updated_at=? WHERE id=?').run(input.locale, t, ctx.tenantId); }
   if (input.timezone !== undefined) { const tz = clean(input.timezone, 60); try { new Intl.DateTimeFormat('en', {timeZone: tz}); } catch { fail(400, 'invalid timezone'); } db.prepare('UPDATE tenants SET timezone=?,updated_at=? WHERE id=?').run(tz, t, ctx.tenantId); }
   if (input.defaultAutonomy !== undefined) { if (!['manual', 'approval_required', 'limited_autonomy'].includes(input.defaultAutonomy)) fail(400, 'invalid autonomy'); db.prepare('UPDATE client_onboarding SET default_autonomy=? WHERE tenant_id=?').run(input.defaultAutonomy, ctx.tenantId); }
   if (input.phone !== undefined) db.prepare('UPDATE client_profiles SET phone=?,updated_at=? WHERE tenant_id=?').run(clean(input.phone, 30), t, ctx.tenantId);
   audit(db, {tenantId: ctx.tenantId, actor: ctx.actor, action: 'CLIENT_SETTINGS_CHANGED', entityType: 'settings', detail: Object.keys(input)});
   send(200, {ok: true});
   return true;
  }

  // ---- support (customer's view of who was inside their workspace)
  if (sub === 'support' && method === 'GET') { guard(ctx, req, {perm: 'audit.view'}); send(200, {items: listSupportSessions(db, {tenantId: ctx.tenantId})}); return true; }
  const supOne = q(/^support\/([\w-]+)$/);
  if (supOne && method === 'GET' && supOne[1] !== 'end' && supOne[1] !== 'page-view') { guard(ctx, req, {perm: 'audit.view'}); send(200, supportSessionDetail(db, supOne[1], {tenantId: ctx.tenantId})); return true; }
  if (sub === 'support/end' && method === 'POST') {
   if (!ctx.support) fail(400, 'NOT_IN_SUPPORT_MODE');
   const ended = endSupportSession(db, env, ctx.support.id, session.user, {reason: 'ended by the admin from the portal'});
   res.setHeader('Set-Cookie', `${SUPPORT_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`);
   send(200, {session: ended});
   return true;
  }
  if (sub === 'support/page-view' && method === 'POST') {
   if (ctx.support) { const i = await readJson(req); logSupportEvent(db, ctx.support, {kind: 'page_view', path: String(i.path || '').slice(0, 200)}); }
   send(200, {ok: true});
   return true;
  }
  fail(404, 'Unknown client operation');
 };

 // ============================================================================================
 //  Platform admin
 // ============================================================================================
 async function handleAdmin(req, res, url, session, {send}) {
  const path = url.pathname, method = req.method;
  const sub = path.slice('/api/client-admin/'.length);
  const actor = {id: session.user.id, name: session.user.name, kind: 'admin'};
  const m = re => sub.match(re);
  const reasonOf = input => { const r = clean(input.reason, 300); if (!r) fail(400, 'a reason is required'); return r; };

  if (method === 'GET' && sub === 'overview') { send(200, {...adminOverview(db, env), settings: getSettings(db), supportAuthorized: canStartSupport(env, session.user), mailConfigured: platformMailStatus(env).status === 'CONFIGURED'}); return true; }
  if (method === 'GET' && sub === 'customers') { send(200, listCustomers(db, url)); return true; }
  if (method === 'GET' && sub === 'applications') { send(200, listCustomers(db, url, {statusFixed: 'pending'})); return true; }
  if (method === 'GET' && sub === 'usage') { send(200, usageTable(db, url)); return true; }
  if (method === 'GET' && sub === 'integrations') { send(200, integrationsTable(db, url)); return true; }
  if (method === 'GET' && sub === 'audit') { send(200, globalAudit(db, url)); return true; }
  if (method === 'GET' && sub === 'permissions') { send(200, permissionsCatalog()); return true; }
  if (method === 'GET' && sub === 'agents') { send(200, {items: agentsAdminView(db), plans: listPlans(db).map(p => ({slug: p.slug, nameEn: p.nameEn, nameAr: p.nameAr}))}); return true; }
  const agentPlatform = m(/^agents\/([a-z_]+)\/platform$/);
  if (agentPlatform && method === 'PUT') { const i = await readJson(req); setPlatformAvailability(db, actor, agentPlatform[1], {available: i.available !== false, allowedPlans: i.allowedPlans ?? null, note: i.note}, reasonOf(i)); for (const p of db.prepare('SELECT tenant_id FROM client_profiles').all()) syncAgentConfigs(db, p.tenant_id); send(200, {items: agentsAdminView(db)}); return true; }
  if (method === 'GET' && sub === 'plans') { send(200, {items: listPlans(db), customers: planCustomerCounts(db), entitlementCatalog: ALL_ENTITLEMENTS}); return true; }
  if (method === 'POST' && sub === 'plans') { send(201, createPlan(db, actor, normalizePlan(await readJson(req)))); return true; }
  const planOne = m(/^plans\/([\w-]+)$/);
  if (planOne && method === 'PATCH') {
   const plan = updatePlan(db, actor, planOne[1], normalizePlan(await readJson(req)));
   for (const p of db.prepare('SELECT tenant_id FROM client_profiles').all()) syncAgentConfigs(db, p.tenant_id);
   send(200, plan);
   return true;
  }
  if (method === 'GET' && sub === 'settings') { send(200, getSettings(db)); return true; }
  if (method === 'PUT' && sub === 'settings') { send(200, saveSettings(db, actor, await readJson(req))); return true; }

  // support sessions
  if (method === 'GET' && sub === 'support-sessions') { send(200, {items: listSupportSessions(db, {limit: 100}), canStart: canStartSupport(env, session.user)}); return true; }
  const supOne = m(/^support-sessions\/([\w-]+)(?:\/(end|revoke))?$/);
  if (supOne) {
   if (method === 'GET' && !supOne[2]) { send(200, supportSessionDetail(db, supOne[1])); return true; }
   if (method === 'POST' && supOne[2]) {
    const i = await readJson(req).catch(() => ({}));
    const ended = endSupportSession(db, env, supOne[1], session.user, {revoked: supOne[2] === 'revoke', reason: clean(i.reason, 300) || null});
    if (supOne[2] === 'end') res.setHeader('Set-Cookie', `${SUPPORT_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`);
    send(200, ended);
    return true;
   }
  }

  // customer detail + actions
  const cust = m(/^customers\/([\w-]+)(?:\/([\w-]+))?(?:\/([\w-]+))?(?:\/([\w-]+))?$/);
  if (cust) {
   const tenantId = cust[1], what = cust[2];
   if (!getProfile(db, tenantId)) fail(404, 'Customer not found');
   if (method === 'GET' && !what) { send(200, customerDetail(db, env, tenantId)); return true; }
   if (method !== 'GET' || what) {
    const input = method === 'GET' ? {} : await readJson(req).catch(() => ({}));
    if (what === 'status' && method === 'POST') { setAccountStatus(db, auth, actor, tenantId, input.status, input.reason); send(200, customerDetail(db, env, tenantId)); return true; }
    if (what === 'approve' && method === 'POST') { approvePending(db, auth, actor, tenantId); send(200, customerDetail(db, env, tenantId)); return true; }
    if (what === 'plan' && method === 'POST') { assignPlan(db, actor, tenantId, input.planId, {trial: input.trial === true, endsAt: input.endsAt || undefined, graceUntil: input.graceUntil || null, reason: reasonOf(input)}); syncAgentConfigs(db, tenantId); send(200, customerDetail(db, env, tenantId)); return true; }
    if (what === 'grace' && method === 'POST') { grantGrace(db, actor, tenantId, input.until, input.reason); send(200, customerDetail(db, env, tenantId)); return true; }
    if (what === 'overrides' && method === 'PUT') { setOverrides(db, actor, tenantId, {entitlements: input.entitlements || {}, limits: input.limits || {}}, input.reason); syncAgentConfigs(db, tenantId); send(200, customerDetail(db, env, tenantId)); return true; }
    if (what === 'agents' && method === 'PUT' && cust[3]) { setAgentAdminControl(db, actor, tenantId, cust[3], input, input.reason); send(200, customerDetail(db, env, tenantId)); return true; }
    if (what === 'notes' && method === 'POST') { send(201, addCustomerNote(db, {id: actor.id, name: actor.name}, tenantId, input.note)); return true; }
    if (what === 'force-logout' && method === 'POST') {
     const r = reasonOf(input);
     for (const mem of db.prepare("SELECT user_id FROM client_members WHERE tenant_id=? AND status='active'").all(tenantId)) auth.revokeSessions(mem.user_id);
     audit(db, {tenantId, actor, action: 'CLIENT_FORCE_LOGOUT', entityType: 'account', reason: r});
     notify(db, tenantId, 'sessions_revoked', {});
     send(200, {ok: true});
     return true;
    }
    if (what === 'invitations' && method === 'POST' && cust[3] && cust[4] === 'resend') {
     const inv = db.prepare("SELECT email FROM workspace_invitations WHERE id=? AND tenant_id=? AND status='PENDING'").get(cust[3], tenantId);
     if (!inv) fail(404, 'Invitation not found');
     const r = resendInvitation(db, tenantId, cust[3]);
     audit(db, {tenantId, actor, action: 'CLIENT_INVITATION_RESENT_BY_ADMIN', entityType: 'invitation', entityId: cust[3], reason: clean(input.reason, 300) || null});
     const tenant = getTenant(db, tenantId);
     const base = url.origin;
     const delivery = await sendInvitationEmail(mailCtx(), {to: inv.email, locale: 'ar', workspaceName: tenant.name, acceptUrl: `${base}/client/invite/${r.token}`, role: 'member'});
     send(200, {delivered: delivery.delivered});
     return true;
    }
    if (what === 'support-sessions' && method === 'POST') {
     const minutes = Number.isInteger(input.minutes) ? input.minutes : 30;
     const started = startSupportSession(db, env, session.user, tenantId, {reason: input.reason, ticket: input.ticket, minutes, level: input.level || 'view_only'});
     res.setHeader('Set-Cookie', `${SUPPORT_COOKIE}=${started.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${minutes * 60}${secureCookie}`);
     send(201, {session: started.session, redirect: '/client/dashboard'});
     return true;
    }
   }
  }
  fail(404, 'Unknown client admin operation');
 }
 function normalizePlan(i) {
  const o = {...i};
  if (o.price !== undefined) { const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(o.price).trim()); if (!m) fail(400, 'price: invalid amount'); o.priceMinor = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0); delete o.price; }
  return o;
 }
}
export {getTask, LEGACY_ROLE, can};
