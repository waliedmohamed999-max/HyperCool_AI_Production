import {api} from '../partner-portal/api.js';
import {t, pick, getLocale} from '../partner-portal/i18n.js';
import {h, icon, button, field, input, textarea, select, formData, showFormError, skeleton, errorState, emptyState, lockedState, metric, table, pager, badge, sparkChart, num, money, date, toast, modal, confirmModal, errorText} from '../partner-portal/ui.js';
import {pageHead, taskBadge, dt, reasonText, meter, agentName} from './kit.js';

const gateEnt = (ctx, key) => (ctx.has(key) ? null : lockedState({reason: 'ENTITLEMENT_REQUIRED', title: t('c.lockedFeature'), hint: t('c.lockedFeatureHint')}));
const supportConfirm = async ctx => (ctx.me.support ? confirmModal(t('c.support.confirmTitle'), t('c.support.confirmBody')) : true);
const sup = ctx => (ctx.me.support ? {confirmSupport: true} : {});

// ---- integrations ----------------------------------------------------------------------------------------------------------------------------
const OAUTH_REASONS = ['state_invalid', 'state_used', 'state_expired', 'denied', 'not_permitted', 'account_blocked', 'provider_error', 'verification_failed', 'limit_reached', 'session_mismatch', 'unknown_provider'];
export async function integrationsPage(ctx) {
 const locked = gateEnt(ctx, 'client.integrations'); if (locked) return locked;
 const root = h('div'), grid = h('div', {class: 'agent-grid'}), banner = h('div');
 const canManage = ctx.can('integrations.manage');
 const canConnect = canManage && !ctx.me.support; // authorizing a third-party account is the customer's own act, never a support session's
 const BRAND = {salla: 'Salla', zid: 'Zid', meta: 'Meta', microsoft365: 'Microsoft 365', x: 'X', linkedin: 'LinkedIn'};
 // the provider sends the browser back here with ?oauth=success|error&provider=..&reason=..
 const params = new URLSearchParams(location.search);
 if (params.get('oauth')) {
  const provider = params.get('provider') || '', reason = params.get('reason') || '';
  const shown = params.get('oauth') === 'success'
   ? h('p', {class: 'notice success', role: 'status', text: t('c.conn.oauthSuccess', {name: BRAND[provider] || provider})})
   : h('p', {class: 'form-error', role: 'alert', text: t(`c.conn.oauthError.${OAUTH_REASONS.includes(reason) ? reason : 'provider_error'}`, {name: BRAND[provider] || provider})});
  banner.append(shown);
  history.replaceState(null, '', location.pathname);
 }
 async function startOauth(slug, connectionId = null) {
  try {
   const r = await api.post(`/api/client/integrations/${slug}/connect`, connectionId ? {connectionId} : {});
   toast(t('c.conn.redirecting'), 'success');
   location.assign(r.authorizeUrl);
  } catch (error) { toast(errorText(error), 'error'); }
 }
 const connectionBlock = (i, c, n) => h('div', {class: 'conn-row'},
  h('div', {class: 'row-between'}, h('strong', {text: c.accountName || (i.multiple ? `${pick(i, 'name')} #${n}` : pick(i, 'name'))}), h('span', {class: 'pill', dataset: {status: c.status === 'CONNECTED' ? 'active' : 'pending'}, text: t(`c.conn.${c.status}`)})),
  h('dl', {class: 'facts'}, h('div', null, h('dt', {text: t('c.conn.lastCheck')}), h('dd', {text: c.lastHealthCheck ? dt(c.lastHealthCheck) : '—'})), h('div', null, h('dt', {text: t('c.conn.lastSuccess')}), h('dd', {text: c.lastSuccessAt ? dt(c.lastSuccessAt) : '—'}))),
  c.lastError && c.status !== 'CONNECTED' ? h('p', {class: 'form-error', text: `${t('c.conn.lastError')}: ${c.lastError}`}) : null,
  canManage ? h('div', {class: 'row-actions'},
   button(t('c.conn.test'), {onClick: async () => { try { const r2 = await api.post(`/api/client/integrations/${c.id}/test`, {}); toast(t(`c.conn.${r2.status}`), r2.status === 'CONNECTED' ? 'success' : 'error'); load(); } catch (error) { toast(errorText(error), 'error'); } }}),
   canConnect && i.method === 'oauth' && i.availability.state === 'available' ? button(t('c.conn.reconnect'), {onClick: () => startOauth(i.connectVia, i.multiple ? c.id : null)}) : null,
   button(t('c.conn.disconnect'), {variant: 'ghost', onClick: async () => { if (!(await confirmModal(t('c.conn.disconnect'), pick(i, 'name'), {danger: true}))) return; try { await api.post(`/api/client/integrations/${c.id}/disconnect`, sup(ctx)); toast(t('common.saved'), 'success'); load(); } catch (error) { toast(errorText(error), 'error'); } }})) : null);
 async function load() {
  grid.replaceChildren(skeleton(3));
  try {
   const r = await api.get('/api/client/integrations');
   grid.replaceChildren(...r.items.map(i => {
    const list = i.connections || [], state = i.availability.state;
    const pillText = list.length ? t(`c.conn.${list[0].status}`) : state === 'coming_soon' ? t('c.conn.COMING_SOON') : state === 'unavailable' ? t('c.conn.UNAVAILABLE') : t('c.conn.NONE');
    return h('article', {class: 'card integration', dataset: {provider: i.slug, availability: state}},
     h('div', {class: 'row-between'}, h('h3', {text: pick(i, 'name')}), h('span', {class: 'pill', dataset: {status: list.some(c => c.status === 'CONNECTED') ? 'active' : list.length ? 'pending' : ''}, text: pillText})),
     h('p', {class: 'muted', text: pick(i, 'description')}),
     state !== 'available' ? h('p', {class: 'muted small', text: t(`c.conn.reason.${i.availability.reason}`)}) : null,
     i.slug === 'whatsapp' && state === 'available' && !list.length ? h('p', {class: 'muted small', text: t('c.conn.viaMeta')}) : null,
     ...list.map((c, idx) => connectionBlock(i, c, idx + 1)),
     canManage && state === 'available' && (!list.length || i.multiple) ? h('div', {class: 'row-actions'},
      i.method === 'api_key' && !list.length ? button(t('c.conn.connect'), {variant: 'primary', onClick: () => connectModal(i)}) : null,
      canConnect && i.method === 'oauth' ? button(list.length ? t('c.conn.addAnother') : t('c.conn.connectOauth'), {variant: list.length ? 'secondary' : 'primary', onClick: () => startOauth(i.connectVia)}) : null) : null);
   }));
  } catch (error) { grid.replaceChildren(errorState(error, load)); }
 }
 async function connectModal(i) {
  const ok = await modal(t('c.conn.connectTitle', {name: pick(i, 'name')}), body => {
   const form = h('form', {class: 'stack', novalidate: true}, h('p', {class: 'muted', text: t('c.conn.keyHint')}), field(t('c.conn.name'), input('name', {maxlength: 80, value: pick(i, 'name')})), field(t('c.conn.apiKey'), input('apiKey', {type: 'password', required: true, autocomplete: 'off', maxlength: 400})));
   body.append(form);
   return {validate: () => form.reportValidity(), value: () => api.post('/api/client/integrations/connect', {slug: i.slug, ...formData(form)})};
  }, {confirmLabel: t('c.conn.connect')});
  if (ok) { toast(t('c.conn.connected'), 'success'); load(); }
 }
 root.append(...[pageHead(t('c.nav.integrations'), t('c.conn.subtitle')), banner, canManage ? null : h('p', {class: 'notice small', text: t('c.conn.viewOnly')}), h('p', {class: 'muted small', text: t('c.conn.oauthNote')}), grid].filter(Boolean));
 load();
 return root;
}

// ---- analytics -----------------------------------------------------------------------------------------------------------------------------------
export async function analyticsPage(ctx) {
 const locked = gateEnt(ctx, 'client.analytics'); if (locked) return locked;
 const root = h('div'), body = h('div');
 let days = 30;
 const rng = select('range', [[7, t('dashboard.days', {n: 7})], [30, t('dashboard.days', {n: 30})], [90, t('dashboard.days', {n: 90})]], 30);
 rng.setAttribute('aria-label', t('dashboard.range'));
 rng.addEventListener('change', () => { days = Number(rng.value); load(); });
 async function load() {
  body.replaceChildren(skeleton(4));
  try {
   const d = await api.get(`/api/client/analytics${api.qs({days})}`);
   body.replaceChildren(
    h('section', {class: 'metric-grid'}, metric(t('c.an.tasks'), num(d.tasks.total), null, 'check'), metric(t('c.an.completionRate'), `${(d.tasks.completionRateBps / 100).toFixed(d.tasks.completionRateBps % 100 === 0 ? 0 : 1)}%`, null, 'chart'), metric(t('c.an.runs'), num(d.usage.runs), null, 'agent'), metric(t('c.an.tokens'), num(d.usage.tokens), t('c.an.cost', {cost: (d.usage.cost || 0).toFixed(4)}), 'coins'), metric(t('c.an.approvalsPending'), num(d.approvals.pending), t('c.an.approvalsDecided', {a: d.approvals.approved, r: d.approvals.rejected}), 'lock')),
    h('section', {class: 'chart-grid'}, h('div', {class: 'card'}, h('h3', {text: t('c.an.createdPerDay')}), sparkChart(d.tasks.created, {label: t('c.an.createdPerDay')})), h('div', {class: 'card'}, h('h3', {text: t('c.an.completedPerDay')}), sparkChart(d.tasks.completed, {label: t('c.an.completedPerDay')}))),
    h('section', {class: 'card'}, h('h3', {text: t('c.an.byStatus')}), Object.keys(d.tasks.byStatus).length ? h('div', {class: 'chips'}, Object.entries(d.tasks.byStatus).map(([s, n]) => h('span', {class: 'chip', text: `${t(`c.tstatus.${s}`)}: ${n}`}))) : emptyState(t('dashboard.noDataYet'), t('dashboard.noDataHint'))),
    h('section', {class: 'card'}, h('h3', {text: t('c.an.byAgent')}), d.agents.length ? table([t('c.task.agent'), t('c.an.runs'), t('c.an.failed'), t('c.an.tokens')], d.agents.map(a => [a.agentId, num(a.runs), num(a.failed), num(a.tokens)])) : emptyState(t('dashboard.noDataYet'), t('dashboard.noDataHint'))),
    h('section', {class: 'card'}, h('h3', {text: t('c.an.integrationsHealth')}), Object.keys(d.integrations).length ? h('div', {class: 'chips'}, Object.entries(d.integrations).map(([s, n]) => h('span', {class: 'chip', text: `${t(`c.conn.${s}`)}: ${n}`}))) : emptyState(t('c.an.noIntegrations'))));
  } catch (error) { body.replaceChildren(errorState(error, load)); }
 }
 root.append(pageHead(t('c.nav.analytics'), t('c.an.subtitle'), rng), body);
 load();
 return root;
}

// ---- team --------------------------------------------------------------------------------------------------------------------------------------------
const ROLES = ['workspace_admin', 'manager', 'operator', 'analyst', 'viewer'];
export async function teamPage(ctx) {
 const locked = gateEnt(ctx, 'client.team'); if (locked) return locked;
 const root = h('div'), host = h('div');
 const canManage = ctx.can('team.manage');
 async function load() {
  host.replaceChildren(skeleton(3));
  try {
   const r = await api.get('/api/client/team');
   const roleSel = m => { const sel = select('role', [...(ctx.me.role === 'workspace_owner' ? ['workspace_owner'] : []), ...ROLES].map(v => [v, t(`c.role.${v}`)]), m.role); sel.setAttribute('aria-label', t('c.team.role')); sel.addEventListener('change', async () => { if (!(await supportConfirm(ctx))) { sel.value = m.role; return; } try { await api.patch(`/api/client/team/members/${m.userId}`, {role: sel.value, ...sup(ctx)}); toast(t('common.saved'), 'success'); load(); } catch (error) { toast(errorText(error), 'error'); sel.value = m.role; } }); return sel; };
    const act = (m, status) => async () => { if (!(await confirmModal(t(`c.team.${status}Title`), m.name, {danger: true}))) return; try { await api.patch(`/api/client/team/members/${m.userId}`, {status, ...sup(ctx)}); toast(t('common.saved'), 'success'); load(); } catch (error) { toast(errorText(error), 'error'); } };
    host.replaceChildren(
     h('div', {class: 'metric-grid'}, metric(t('c.team.members'), r.limit === null ? num(r.used) : `${num(r.used)} / ${num(r.limit)}`, t('c.team.limitHint'), 'users')),
     h('section', {class: 'card'}, h('h2', {text: t('c.team.members')}), table([t('c.team.name'), t('c.team.role'), t('c.task.status'), t('c.team.lastLogin'), ''], r.members.map(m => [h('div', null, h('strong', {text: m.name}), h('small', {class: 'block muted', dir: 'ltr', text: m.email || m.username})),
      canManage && m.userId !== ctx.me.user.id ? roleSel(m) : t(`c.role.${m.role}`), badge(t(`c.member.${m.status}`), m.status === 'active' ? 'active' : 'pending'), m.lastLoginAt ? dt(m.lastLoginAt) : '—',
      canManage && m.userId !== ctx.me.user.id ? h('div', {class: 'row-actions'}, m.status === 'active' ? button(t('c.team.suspend'), {variant: 'ghost', onClick: act(m, 'suspended')}) : button(t('c.team.reactivate'), {variant: 'ghost', onClick: act(m, 'active')}), button(t('c.team.remove'), {variant: 'ghost', onClick: act(m, 'removed')}), m.status === 'active' && ctx.me.role === 'workspace_owner' && !ctx.me.support && m.emailVerified ? button(t('c.team.makeOwner'), {variant: 'ghost', onClick: () => transferModal(m)}) : null) : ''])),
      ctx.me.support || ctx.me.role === 'workspace_owner' ? null : button(t('c.team.leave'), {variant: 'ghost', onClick: async () => { if (await confirmModal(t('c.team.leaveTitle'), t('c.team.leaveBody'), {danger: true})) { try { await api.post('/api/client/team/leave'); location.assign('/client'); } catch (error) { toast(errorText(error), 'error'); } } }})),
     h('section', {class: 'card'}, h('div', {class: 'row-between'}, h('h2', {text: t('c.team.invitations')}), canManage ? button(t('c.team.invite'), {variant: 'primary', iconName: 'plus', onClick: inviteModal}) : null),
      r.invitations.length ? table([t('c.team.email'), t('c.team.role'), t('c.team.expires'), ''], r.invitations.map(i => [i.email, t(`c.role.${i.role}`), dt(i.expiresAt), canManage ? h('div', {class: 'row-actions'}, button(t('c.team.resend'), {variant: 'ghost', onClick: async () => { try { const x = await api.post(`/api/client/team/invitations/${i.id}/resend`, {}); toast(x.delivered ? t('c.team.sent') : t('c.team.linkOnly'), 'success'); if (!x.delivered && x.acceptUrl) await navigator.clipboard?.writeText(x.acceptUrl).catch(() => {}); } catch (error) { toast(errorText(error), 'error'); } }}), button(t('c.team.revoke'), {variant: 'ghost', onClick: async () => { if (!(await supportConfirm(ctx))) return; try { await api.post(`/api/client/team/invitations/${i.id}/revoke`, sup(ctx)); load(); } catch (error) { toast(errorText(error), 'error'); } }})) : ''])) : emptyState(t('c.team.noInvitations'))));
  } catch (error) { host.replaceChildren(errorState(error, load)); }
 }
 async function inviteModal() {
  const r = await modal(t('c.team.invite'), body => {
   const form = h('form', {class: 'stack', novalidate: true}, field(t('c.team.email'), input('email', {type: 'email', required: true})), field(t('c.team.role'), select('role', ROLES.map(v => [v, t(`c.role.${v}`)]), 'operator')), h('dl', {class: 'facts'}, ...ROLES.map(v => h('div', null, h('dt', {text: t(`c.role.${v}`)}), h('dd', {class: 'small', text: t(`c.roledesc.${v}`)})))));
   body.append(form);
   return {validate: () => form.reportValidity(), value: () => api.post('/api/client/team/invitations', formData(form))};
  }, {confirmLabel: t('c.team.sendInvite')});
  if (r) { toast(r.delivered ? t('c.team.sent') : t('c.team.linkOnly'), 'success'); if (!r.delivered && r.acceptUrl) await navigator.clipboard?.writeText(r.acceptUrl).catch(() => {}); load(); }
 }
 async function transferModal(m) {
  const r = await modal(t('c.team.transferTitle'), body => {
   const form = h('form', {class: 'stack', novalidate: true}, h('p', {text: t('c.team.transferBody', {name: m.name})}), field(t('c.team.confirmName'), input('confirmName', {required: true, maxlength: 100}), ctx.me.workspace.name));
   body.append(form);
   return {validate: () => form.reportValidity(), value: () => api.post('/api/client/team/transfer-ownership', {userId: m.userId, confirmName: form.elements.confirmName.value})};
  }, {confirmLabel: t('c.team.transfer'), danger: true});
  if (r) { toast(t('common.saved'), 'success'); await ctx.reload(); ctx.navigate('/client/team'); }
 }
 root.append(pageHead(t('c.nav.team'), t('c.team.subtitle')), host);
 load();
 return root;
}

// ---- notifications --------------------------------------------------------------------------------------------------------------------------------------------
export async function notificationsPage(ctx) {
 const root = h('div'), list = h('div');
 let page = 1;
 async function load() {
  list.replaceChildren(skeleton(3));
  try {
   const r = await api.get(`/api/client/notifications${api.qs({page})}`);
   list.replaceChildren(r.items.length ? h('div', null, h('ul', {class: 'list'}, r.items.map(n => h('li', {class: `list-row ${n.read ? '' : 'unread'}`}, h('span', {text: notifText(n)}), h('small', {class: 'muted', text: dt(n.createdAt)})))), pager(r, p => { page = p; load(); })) : emptyState(t('c.notif.none')));
  } catch (error) { list.replaceChildren(errorState(error, load)); }
 }
 root.append(pageHead(t('c.nav.notifications'), t('c.notif.subtitle'), ctx.me.support ? null : button(t('c.notif.markAll'), {variant: 'secondary', onClick: async () => { await api.post('/api/client/notifications/read', {}); await ctx.reload(); load(); }})), list);
 load();
 return root;
}
function notifText(n) {
 const p = n.params || {};
 const key = `c.notif.${n.kind}`;
 const text = t(key, {title: p.title || '', reason: p.reason || '', plan: getLocale() === 'ar' ? p.planAr || p.plan || '' : p.planEn || p.plan || '', status: p.status || '', level: p.level ? t(`c.support.level.${p.level}`) : '', admin: p.admin || '', name: p.name || '', role: p.role ? t(`c.role.${p.role}`) : '', date: p.until || p.expiresAt ? date(p.until || p.expiresAt) : '', agent: p.agentId || ''});
 return text === key ? n.kind : text;
}

// ---- billing -------------------------------------------------------------------------------------------------------------------------------------------------
export async function billingPage(ctx) {
 const b = await api.get('/api/client/billing');
 const root = h('div');
 const plan = b.plan;
 root.append(pageHead(t('c.nav.billing'), t('c.bill.subtitle')));
 root.append(h('div', {class: 'two-col'},
  h('section', {class: 'card'}, h('div', {class: 'row-between'}, h('h2', {text: t('c.bill.currentPlan')}), h('span', {class: 'pill', dataset: {status: b.state}, text: t(`c.account.${b.state}`)})),
   plan ? h('div', {class: 'stack'}, h('p', null, h('strong', {text: pick(plan, 'name')}), ' · ', plan.priceMinor ? `${money(plan.priceMinor, plan.currency)} / ${t(`period.${plan.billingPeriod}`)}` : t('c.landing.priceOnRequest')), h('p', {class: 'muted', text: pick(plan, 'description')}),
    h('dl', {class: 'facts'}, b.trialEndsAt ? h('div', null, h('dt', {text: t('c.bill.trialEnds')}), h('dd', {text: date(b.trialEndsAt)})) : null, b.endsAt ? h('div', null, h('dt', {text: t('c.bill.periodEnds')}), h('dd', {text: date(b.endsAt)})) : null, b.graceUntil ? h('div', null, h('dt', {text: t('c.bill.graceUntil')}), h('dd', {text: date(b.graceUntil)})) : null, h('div', null, h('dt', {text: t('c.bill.support')}), h('dd', {text: plan.supportLevel})))) : emptyState(t('c.bill.noPlan')),
   b.expired ? h('p', {class: 'notice', text: t('c.bill.expiredNotice')}) : null, h('p', {class: 'muted small', text: t('c.bill.noOnline')})),
  h('section', {class: 'card'}, h('h2', {text: t('c.bill.usage')}), Object.keys(b.limits).map(k => meter(t(`c.limit.${k}`), b.usage[k] ?? 0, b.limits[k])), b.limits.retention_days ? h('p', {class: 'muted small', text: t('c.bill.retention', {n: b.limits.retention_days})}) : null)));
 root.append(h('section', {class: 'card'}, h('h2', {text: t('c.bill.plans')}), h('div', {class: 'plan-grid'}, b.availablePlans.map(p => h('article', {class: `plan-card ${plan?.slug === p.slug ? 'is-featured' : ''}`}, plan?.slug === p.slug ? h('span', {class: 'plan-flag', text: t('c.bill.current')}) : null, h('h3', {text: pick(p, 'name')}), h('p', {class: 'plan-desc', text: pick(p, 'description')}), h('ul', {class: 'plan-features compact'}, h('li', {class: 'has'}, icon('check', 16), h('span', {text: t('c.landing.agentsIncluded', {n: p.entitlements.filter(e => e.startsWith('agent.')).length})})), p.limits.users ? h('li', {class: 'has'}, icon('check', 16), h('span', {text: t('c.landing.users', {n: p.limits.users})})) : null, p.limits.tasks_per_month ? h('li', {class: 'has'}, icon('check', 16), h('span', {text: t('c.landing.tasks', {n: num(p.limits.tasks_per_month)})})) : null))))));
 root.append(h('section', {class: 'card'}, h('h2', {text: t('c.bill.history')}), b.history.length ? table([t('c.bill.plan'), t('c.task.status'), t('c.bill.started'), t('c.bill.ends')], b.history.map(s => [getLocale() === 'ar' ? s.nameAr : s.nameEn, s.status, date(s.startedAt), s.endsAt || s.trialEndsAt ? date(s.endsAt || s.trialEndsAt) : '—'])) : emptyState(t('c.bill.noHistory'))));
 return root;
}

// ---- settings -----------------------------------------------------------------------------------------------------------------------------------------------------
export async function settingsPage(ctx) {
 const s = await api.get('/api/client/settings');
 const canEdit = ctx.can('settings.manage');
 const form = h('form', {class: 'card stack', novalidate: true}, h('h2', {text: t('c.set.workspace')}),
  field(t('c.register.businessName'), input('name', {required: true, maxlength: 100, value: s.workspace.name})), field(t('c.set.slug'), h('input', {value: s.workspace.slug, readonly: true, dir: 'ltr'})),
  field(t('c.onb.language'), select('locale', [['ar', 'العربية'], ['en', 'English']], s.workspace.locale)), field(t('c.onb.timezone'), input('timezone', {maxlength: 60, value: s.workspace.timezone, dir: 'ltr'})),
  field(t('app.phone'), input('phone', {type: 'tel', maxlength: 30, value: s.profile.phone || ''})),
  field(t('c.set.autonomy'), select('defaultAutonomy', ['manual', 'approval_required', 'limited_autonomy'].map(v => [v, t(`c.autonomy.${v}`)]), s.defaultAutonomy), t('c.set.autonomyHint')),
  canEdit ? button(t('common.save'), {variant: 'primary', type: 'submit'}) : h('p', {class: 'muted small', text: t('c.agents.readOnly')}));
 if (!canEdit) for (const el of form.elements) if (el.tagName !== 'BUTTON') el.disabled = true;
 form.addEventListener('submit', async e => {
  e.preventDefault();
  if (!canEdit || !form.reportValidity()) return;
  const v = formData(form);
  try { if (!(await supportConfirm(ctx))) return; await api.patch('/api/client/settings', {name: v.name, locale: v.locale, timezone: v.timezone, phone: v.phone, defaultAutonomy: v.defaultAutonomy}); await ctx.reload(); toast(t('common.saved'), 'success'); } catch (error) { showFormError(form, error); }
 });
 const root = h('div');
 root.append(pageHead(t('c.nav.settings'), t('c.set.subtitle')), h('div', {class: 'two-col'}, form,
  h('section', {class: 'card stack'}, h('h2', {text: t('c.set.account')}), h('dl', {class: 'facts'}, h('div', null, h('dt', {text: t('register.name')}), h('dd', {text: ctx.me.user.name})), h('div', null, h('dt', {text: t('register.email')}), h('dd', {dir: 'ltr', text: ctx.me.user.email || '—'})), h('div', null, h('dt', {text: t('c.team.role')}), h('dd', {text: t(`c.role.${ctx.me.role}`)}))),
   h('h3', {text: t('c.set.permissions')}), h('ul', {class: 'chips-col'}, ctx.me.permissions.map(p => h('li', {class: 'chip', text: t(`c.perm.${p}`)}))), h('a', {href: '/app#forgot-password', text: t('c.set.changePassword')}))));
 if (ctx.can('audit.view')) root.append(await auditCard());
 return root;
}
async function auditCard() {
 const r = await api.get('/api/client/audit');
 return h('section', {class: 'card'}, h('h2', {text: t('c.set.audit')}), r.items.length ? table([t('c.audit.action'), t('c.audit.by'), t('c.task.created')], r.items.slice(0, 20).map(a => [t(`c.audit.${a.action}`) === `c.audit.${a.action}` ? a.action : t(`c.audit.${a.action}`), h('div', null, a.actorName || '—', a.actorKind === 'admin_support' ? h('small', {class: 'block warn', text: t('c.audit.viaSupport')}) : null), dt(a.createdAt)])) : emptyState(t('c.dash.noActivity')));
}

// ---- support (what Frost staff did in this workspace) -----------------------------------------------------------------------------------------------------------------------
export async function supportPage(ctx) {
 if (!ctx.can('audit.view')) return lockedState({reason: 'ENTITLEMENT_REQUIRED', title: t('c.lockedFeature'), hint: t('c.support.permission')});
 const r = await api.get('/api/client/support');
 const root = h('div');
 root.append(pageHead(t('c.nav.support'), t('c.support.subtitle')));
 root.append(h('p', {class: 'notice small', text: t('c.support.explain')}));
 root.append(r.items.length ? table([t('c.support.admin'), t('c.support.levelLabel'), t('c.support.reason'), t('c.task.status'), t('c.task.created'), ''], r.items.map(s => [s.adminName, t(`c.support.level.${s.accessLevel}`), h('div', null, s.reason, s.ticket ? h('small', {class: 'block muted', text: `#${s.ticket}`}) : null), badge(t(`c.sstatus.${s.status}`), s.status === 'active' ? 'active' : 'pending'), dt(s.startedAt), button(t('c.task.details'), {variant: 'ghost', onClick: () => sessionDrawer(s.id)})])) : emptyState(t('c.support.none'), t('c.support.noneHint')));
 return root;
}
async function sessionDrawer(id) {
 const d = await api.get(`/api/client/support/${id}`);
 await modal(t('c.support.sessionTitle', {name: d.adminName}), body => {
  body.append(h('dl', {class: 'facts'}, h('div', null, h('dt', {text: t('c.support.levelLabel')}), h('dd', {text: t(`c.support.level.${d.accessLevel}`)})), h('div', null, h('dt', {text: t('c.task.created')}), h('dd', {text: dt(d.startedAt)})), h('div', null, h('dt', {text: t('c.support.expires')}), h('dd', {text: dt(d.expiresAt)})), h('div', null, h('dt', {text: t('c.support.endReason')}), h('dd', {text: d.endReason || (d.status === 'active' ? '—' : d.status)}))),
   h('p', null, h('strong', {text: t('c.support.reason')}), ': ', d.reason),
   h('h3', {text: t('c.support.actions')}), d.actions.length ? table([t('c.audit.action'), t('c.task.created')], d.actions.map(a => [t(`c.audit.${a.action}`) === `c.audit.${a.action}` ? a.action : t(`c.audit.${a.action}`), dt(a.at)])) : emptyState(t('c.support.noActions')),
   h('h3', {text: t('c.support.activity')}), d.events.length ? table([t('c.support.event'), t('c.support.path'), t('c.task.created')], d.events.slice(0, 60).map(e => [e.kind, e.path || e.detail || '—', dt(e.at)])) : emptyState(t('c.support.noActions')));
 }, {hideActions: true});
}
