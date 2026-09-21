import {api} from '../partner-portal/api.js';
import {t, pick, getLocale} from '../partner-portal/i18n.js';
import {h, icon, button, field, input, textarea, select, formData, showFormError, skeleton, errorState, emptyState, lockedState, metric, table, pager, badge, sparkChart, num, date, toast, modal, confirmModal, errorText} from '../partner-portal/ui.js';
import {pageHead, taskBadge, agentBadge, dt, reasonText, meter, agentName} from './kit.js';

const gateEnt = (ctx, key) => (ctx.has(key) ? null : lockedState({reason: 'ENTITLEMENT_REQUIRED', title: t('c.lockedFeature'), hint: t('c.lockedFeatureHint')}));
const isSensitiveSupport = ctx => !!ctx.me.support;
const supportConfirm = async ctx => (ctx.me.support ? confirmModal(t('c.support.confirmTitle'), t('c.support.confirmBody')) : true);

// ---- dashboard ------------------------------------------------------------------------------------------------------------------------
export async function dashboardPage(ctx) {
 const locked = gateEnt(ctx, 'client.dashboard'); if (locked) return locked;
 const d = await api.get('/api/client/dashboard');
 const c = d.counts;
 const root = h('div');
 const actions = [ctx.can('tasks.create') ? button(t('c.dash.newTask'), {variant: 'primary', iconName: 'plus', onClick: () => newTaskModal(ctx, {onDone: () => ctx.navigate('/client/tasks')})}) : null,
  ctx.can('integrations.manage') && ctx.has('client.integrations') ? h('a', {class: 'btn btn-secondary', href: '/client/integrations'}, icon('link', 16), h('span', {text: t('c.dash.connect')})) : null,
  ctx.can('team.manage') && ctx.has('client.team') ? h('a', {class: 'btn btn-secondary', href: '/client/team'}, icon('users', 16), h('span', {text: t('c.dash.invite')})) : null];
 root.append(pageHead(t('c.dash.welcome', {name: ctx.me.user.name}), `${ctx.me.workspace.name} · ${ctx.me.access.plan ? pick(ctx.me.access.plan, 'name') : '—'}`, ...actions));
 if (d.nextSteps.length) root.append(h('section', {class: 'card'}, h('h2', {text: t('c.dash.nextSteps')}), h('ul', {class: 'todo'}, d.nextSteps.map(s => h('li', null, icon('alert', 16), h('a', {href: {finish_onboarding: '/client/onboarding', connect_integration: '/client/integrations', invite_member: '/client/team', setup_agents: '/client/agents'}[s], text: t(`c.dash.next.${s}`)}))))));
 root.append(h('section', {class: 'metric-grid'},
  metric(t('c.dash.activeAgents'), `${c.activeAgents} / ${c.totalAgents}`, t('c.dash.lockedHint', {n: c.lockedAgents}), 'agent'), metric(t('c.dash.running'), num(c.tasksRunning), null, 'clock'), metric(t('c.dash.completed'), num(c.tasksCompleted), t('c.dash.last30'), 'check'),
  metric(t('c.dash.waitingApproval'), num(c.waitingApproval), null, 'lock'), metric(t('c.dash.integrations'), num(c.integrationsConnected), c.integrationsBroken ? t('c.dash.brokenHint', {n: c.integrationsBroken}) : null, 'link'), metric(t('c.dash.failed'), num(c.tasksFailed), t('c.dash.last30'), 'alert')));
 root.append(h('div', {class: 'two-col'},
  h('section', {class: 'card'}, h('div', {class: 'row-between'}, h('h2', {text: t('c.dash.agents')}), h('a', {href: '/client/agents', text: t('c.viewAll')})),
   h('ul', {class: 'list'}, d.agents.map(a => h('li', {class: 'list-row'}, h('a', {href: `/client/agents/${a.key}`, text: pick(a, 'name')}), agentBadge(a.status))))),
  h('div', {class: 'stack'},
   h('section', {class: 'card'}, h('div', {class: 'row-between'}, h('h2', {text: t('c.dash.pendingApprovals')}), h('a', {href: '/client/approvals', text: t('c.viewAll')})),
    d.pendingApprovals.length ? h('ul', {class: 'list'}, d.pendingApprovals.map(a => h('li', {class: 'list-row'}, h('span', {text: t(`c.atype.${a.actionType}`)}), badge(t(`c.risk.${a.riskLevel.toLowerCase()}`), a.riskLevel.toLowerCase())))) : emptyState(t('c.dash.noApprovals'))),
   h('section', {class: 'card'}, h('h2', {text: t('c.dash.usage')}), Object.entries(d.usage).filter(([k]) => ['users', 'integrations', 'workflows', 'tasks_per_month', 'agent_runs_per_month'].includes(k)).map(([k, v]) => meter(t(`c.limit.${k}`), v.used, v.limit))))));
 root.append(h('section', {class: 'card'}, h('div', {class: 'row-between'}, h('h2', {text: t('c.dash.recentTasks')}), h('a', {href: '/client/tasks', text: t('c.viewAll')})),
  d.recentTasks.length ? table([t('c.task.title'), t('c.task.agent'), t('c.task.status'), t('c.task.created')], d.recentTasks.map(r => [h('a', {href: '/client/tasks', text: r.title}), (() => { const ag = d.agents.find(x => x.key === r.agentId); return ag ? pick(ag, 'name') : r.agentId; })(), taskBadge(r.status), dt(r.createdAt)]))
   : emptyState(t('c.dash.noTasks'), t('c.dash.noTasksHint'), ctx.can('tasks.create') ? button(t('c.dash.newTask'), {variant: 'primary', onClick: () => newTaskModal(ctx, {onDone: () => ctx.navigate('/client/tasks')})}) : null)));
 root.append(h('section', {class: 'card'}, h('h2', {text: t('c.dash.activity')}), d.activity.length ? h('ul', {class: 'list'}, d.activity.map(a => h('li', {class: 'list-row'}, h('span', {text: t(`c.audit.${a.action}`) === `c.audit.${a.action}` ? a.action : t(`c.audit.${a.action}`)}), h('small', {class: 'muted', text: `${a.actorName || ''} · ${dt(a.at)}`})))) : emptyState(t('c.dash.noActivity'))));
 return root;
}

// ---- agents -------------------------------------------------------------------------------------------------------------------------------
export async function agentsPage(ctx) {
 const r = await api.get('/api/client/agents');
 const root = h('div');
 let cat = '', st = '';
 const grid = h('div', {class: 'agent-grid'});
 const cats = [...new Set(r.items.map(a => a.category))];
 const draw = () => {
  const list = r.items.filter(a => (!cat || a.category === cat) && (!st || a.status === st));
  grid.replaceChildren(...(list.length ? list.map(agentCard) : [emptyState(t('c.agents.none'))]));
 };
 const agentCard = a => h('article', {class: `card agent-card ${!a.usable ? 'is-locked' : ''}`},
  h('div', {class: 'row-between'}, h('span', {class: 'pill', dataset: {status: 'info'}, text: t(`c.cat.${a.category}`)}), agentBadge(a.status)),
  h('h3', null, h('a', {href: `/client/agents/${a.key}`, text: agentName(a)})), h('p', {class: 'muted', text: pick(a, 'description')}),
  a.reasons.length ? h('ul', {class: 'reasons'}, a.reasons.slice(0, 3).map(x => h('li', {text: reasonText(x)}))) : null,
  h('div', {class: 'row-actions'}, h('a', {class: 'btn btn-secondary', href: `/client/agents/${a.key}`, text: t('c.agents.open')}),
   a.usable && !a.paused && ctx.can('tasks.create') ? button(t('c.agents.createTask'), {variant: 'primary', onClick: () => newTaskModal(ctx, {agentKey: a.key, onDone: () => ctx.navigate('/client/tasks')})}) : null));
 const catSel = select('cat', [['', t('c.filter.allCategories')], ...cats.map(c => [c, t(`c.cat.${c}`)])], '');
 const stSel = select('st', [['', t('c.filter.allStatuses')], ...['available', 'connected', 'running', 'setup_required', 'paused', 'degraded', 'unavailable', 'disabled_by_admin', 'locked_by_plan'].map(s => [s, t(`c.status.${s}`)])], '');
 catSel.setAttribute('aria-label', t('c.agents.category')); stSel.setAttribute('aria-label', t('c.task.status'));
 catSel.addEventListener('change', () => { cat = catSel.value; draw(); }); stSel.addEventListener('change', () => { st = stSel.value; draw(); });
 root.append(pageHead(t('c.nav.agents'), t('c.agents.subtitle', {n: r.items.length})), h('div', {class: 'toolbar'}, catSel, stSel), grid);
 draw();
 return root;
}

export async function agentDetailPage(ctx) {
 const id = ctx.params.id;
 const r = await api.get(`/api/client/agents/${id}`);
 const a = r.agent;
 const root = h('div');
 const actions = [];
 if (a.usable && ctx.can('tasks.create') && !a.paused) actions.push(button(t('c.agents.createTask'), {variant: 'primary', iconName: 'plus', onClick: () => newTaskModal(ctx, {agentKey: id, onDone: () => ctx.navigate('/client/tasks')})}));
 if (ctx.can('agents.configure') && a.status !== 'locked_by_plan' && a.status !== 'disabled_by_admin') actions.push(button(a.paused ? t('c.agents.resume') : t('c.agents.pause'), {variant: 'secondary', onClick: async () => { if (await supportConfirm(ctx)) { await api.patch(`/api/client/agents/${id}/settings`, {paused: !a.paused}); toast(t('common.saved'), 'success'); ctx.navigate(`/client/agents/${id}`); } }}));
 root.append(h('a', {class: 'back-link', href: '/client/agents', text: `← ${t('c.nav.agents')}`}), pageHead(agentName(a), pick(a, 'description'), agentBadge(a.status), ...actions));
 if (!a.usable || a.reasons.length) root.append(h('div', {class: 'banner banner-warn', role: 'status'}, icon('alert', 18), h('div', null, h('strong', {text: a.usable ? t('c.agents.needsSetup') : t('c.agents.notAvailable')}), h('ul', {class: 'reasons'}, a.reasons.map(x => h('li', {text: reasonText(x)}))))));
 root.append(h('section', {class: 'metric-grid'}, metric(t('c.agents.runs30'), num(a.health.runs30), t('c.agents.failed30', {n: a.health.failed30}), 'chart'), metric(t('c.agents.usageMonth'), a.usageLimitMonthly === null ? num(a.usageThisMonth) : `${num(a.usageThisMonth)} / ${num(a.usageLimitMonthly)}`, null, 'clock'), metric(t('c.agents.tokens30'), num(a.health.tokens30), null, 'coins'), metric(t('c.agents.risk'), t(`c.risk.${a.riskLevel}`), t(`c.autonomy.${a.approvalLevel}`), 'lock')));
 root.append(h('div', {class: 'two-col'},
  h('section', {class: 'card'}, h('h2', {text: t('c.agents.canDo')}), a.supportedActions.length ? h('ul', {class: 'chips-col'}, a.supportedActions.map(x => h('li', {class: 'chip', text: t(`c.tool.${x}`) === `c.tool.${x}` ? x : t(`c.tool.${x}`)}))) : emptyState(t('c.agents.noActions')),
   a.blockedActions?.length ? h('p', {class: 'notice small', text: `${t('c.agents.blocked')}: ${a.blockedActions.join(', ')}`}) : null),
  h('section', {class: 'card'}, h('h2', {text: t('c.agents.requirements')}), h('dl', {class: 'facts'}, h('div', null, h('dt', {text: t('c.agents.requiredTools')}), h('dd', {text: a.requiredTools.join(', ') || '—'})), h('div', null, h('dt', {text: t('c.agents.readiness')}), h('dd', {text: t(`c.ready.${a.readiness.status}`) === `c.ready.${a.readiness.status}` ? a.readiness.status : t(`c.ready.${a.readiness.status}`)})), h('div', null, h('dt', {text: t('c.agents.entitlement')}), h('dd', {text: a.requiredEntitlements.join(', ')})), h('div', null, h('dt', {text: t('c.agents.adminState')}), h('dd', {text: t(`c.adminstate.${a.adminState}`)}))),
   a.adminNote ? h('p', {class: 'notice small', text: a.adminNote}) : null,
   ctx.has('client.integrations') ? h('a', {href: '/client/integrations', text: t('c.agents.manageIntegrations')}) : null)));
 if (ctx.can('agents.view') && a.status !== 'locked_by_plan') root.append(settingsCard(ctx, a, id));
 root.append(h('section', {class: 'card'}, h('h2', {text: t('c.agents.recentTasks')}), r.tasks.length ? table([t('c.task.title'), t('c.task.status'), t('c.task.created')], r.tasks.map(x => [x.title, taskBadge(x.status), dt(x.createdAt)])) : emptyState(t('c.dash.noTasks'))));
 if (r.scheduled.length) root.append(h('section', {class: 'card'}, h('h2', {text: t('c.agents.scheduled')}), table([t('c.task.title'), t('c.task.scheduledAt')], r.scheduled.map(x => [x.title, dt(x.scheduledAt)]))));
 root.append(h('section', {class: 'card'}, h('h2', {text: t('c.agents.runs')}), r.runs.length ? table([t('c.task.status'), t('c.task.created'), t('c.task.error')], r.runs.map(x => [x.status, dt(x.startedAt), x.error || '—'])) : emptyState(t('c.agents.noRuns'))));
 root.append(h('section', {class: 'card'}, h('h2', {text: t('c.agents.activity')}), r.activity.length ? h('ul', {class: 'list'}, r.activity.map(x => h('li', {class: 'list-row'}, h('span', {text: t(`c.audit.${x.action}`) === `c.audit.${x.action}` ? x.action : t(`c.audit.${x.action}`)}), h('small', {class: 'muted', text: `${x.actorName || ''} · ${dt(x.at)}`})))) : emptyState(t('c.dash.noActivity'))));
 return root;
}
function settingsCard(ctx, a, id) {
 const canEdit = ctx.can('agents.configure');
 const s = a.settings || {};
 const levels = ['manual', 'approval_required', 'limited_autonomy'];
 const floor = levels.indexOf(a.approvalFloor || 'limited_autonomy');
 const form = h('form', {class: 'card stack', novalidate: true}, h('h2', {text: t('c.agents.settings')}),
  field(t('c.agents.approvalLevel'), (() => { const sel = select('approvalLevel', levels.map(v => [v, t(`c.autonomy.${v}`)]), a.approvalLevel); [...sel.options].forEach((o, i) => { if (i > floor) o.disabled = true; }); return sel; })(), t('c.agents.approvalHint')),
  field(t('c.agents.tone'), select('tone', [['', '—'], ...['formal', 'friendly', 'professional', 'playful'].map(v => [v, t(`c.tone.${v}`)])], s.tone || '')),
  field(t('c.agents.language'), select('language', [['', '—'], ['ar', 'العربية'], ['en', 'English'], ['both', t('c.agents.both')]], s.language || '')),
  field(t('c.agents.brandNotes'), textarea('brandNotes', {maxlength: 1000, rows: 3, value: s.brandNotes || ''})), field(t('c.agents.maxItems'), input('maxItemsPerRun', {type: 'number', value: s.maxItemsPerRun ?? ''})),
  canEdit ? button(t('common.save'), {variant: 'primary', type: 'submit'}) : h('p', {class: 'muted small', text: t('c.agents.readOnly')}));
 for (const el of form.elements) if (!canEdit && el.tagName !== 'BUTTON') el.disabled = true;
 form.addEventListener('submit', async e => {
  e.preventDefault();
  if (!canEdit) return;
  const v = formData(form);
  try {
   if (!(await supportConfirm(ctx))) return;
   await api.patch(`/api/client/agents/${id}/settings`, {approvalLevel: v.approvalLevel, settings: {tone: v.tone || undefined, language: v.language || undefined, brandNotes: v.brandNotes || undefined, maxItemsPerRun: v.maxItemsPerRun ? Number(v.maxItemsPerRun) : undefined}});
   toast(t('common.saved'), 'success'); ctx.navigate(`/client/agents/${id}`);
  } catch (error) { showFormError(form, error); }
 });
 return form;
}

// ---- tasks ------------------------------------------------------------------------------------------------------------------------------------
export async function newTaskModal(ctx, {agentKey = null, onDone} = {}) {
 const agents = (await api.get('/api/client/agents')).items.filter(a => a.usable && !a.paused);
 if (!agents.length) { toast(t('c.task.noUsableAgents'), 'error'); return null; }
 const result = await modal(t('c.task.new'), body => {
  const form = h('form', {class: 'stack', novalidate: true},
   field(t('c.task.agent'), select('agentId', agents.map(a => [a.key, agentName(a)]), agentKey || agents[0].key)),
   field(t('c.task.title'), input('title', {required: true, maxlength: 140})), field(t('c.task.description'), textarea('description', {maxlength: 4000, rows: 4})),
   h('div', {class: 'row'}, field(t('c.task.priority'), select('priority', ['low', 'normal', 'high', 'urgent'].map(v => [v, t(`c.priority.${v}`)]), 'normal')), field(t('c.task.risk'), select('riskLevel', [['', t('c.task.riskDefault')], ...['low', 'medium', 'high'].map(v => [v, t(`c.risk.${v}`)])], ''), t('c.task.riskHint'))),
   field(t('c.task.scheduledAt'), input('scheduledAt', {type: 'datetime-local', dir: 'ltr'}), t('c.task.scheduleHint')), h('label', {class: 'check'}, h('input', {type: 'checkbox', name: 'draft'}), h('span', {text: t('c.task.saveDraft')})));
  body.append(form);
  return {validate: () => form.reportValidity(), focus: () => form.querySelector('input[name=title]').focus(), value: async () => {
   const v = formData(form);
   const payload = {agentId: v.agentId, title: v.title, description: v.description, priority: v.priority, draft: v.draft === 'on'};
   if (v.riskLevel) payload.riskLevel = v.riskLevel;
   if (v.scheduledAt) payload.scheduledAt = new Date(v.scheduledAt).toISOString();
   return api.post('/api/client/tasks', payload);
  }};
 }, {confirmLabel: t('c.task.create')});
 if (result) { toast(t('c.task.created'), 'success'); onDone?.(result); }
 return result;
}

export async function tasksPage(ctx) {
 const root = h('div'), list = h('div');
 let page = 1, status = '', agent = '', q = '';
 const agents = (await api.get('/api/client/agents')).items;
 const stSel = select('status', [['', t('c.filter.allStatuses')], ...['draft', 'queued', 'waiting_for_integration', 'waiting_for_approval', 'running', 'completed', 'failed', 'cancelled', 'paused'].map(s => [s, t(`c.tstatus.${s}`)])], '');
 const agSel = select('agent', [['', t('c.filter.allAgents')], ...agents.map(a => [a.key, agentName(a)])], '');
 const search = input('q', {type: 'search', placeholder: t('c.filter.search')});
 stSel.setAttribute('aria-label', t('c.task.status')); agSel.setAttribute('aria-label', t('c.task.agent')); search.setAttribute('aria-label', t('c.filter.search'));
 let timer;
 stSel.addEventListener('change', () => { status = stSel.value; page = 1; load(); }); agSel.addEventListener('change', () => { agent = agSel.value; page = 1; load(); });
 search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value; page = 1; load(); }, 300); });
 async function load() {
  list.replaceChildren(skeleton(4));
  try {
   const r = await api.get(`/api/client/tasks${api.qs({status, agent, q, page})}`);
   list.replaceChildren(r.items.length ? h('div', null, table([t('c.task.title'), t('c.task.agent'), t('c.task.status'), t('c.task.priority'), t('c.task.created'), ''], r.items.map(x => [h('div', null, h('strong', {text: x.title}), x.error ? h('small', {class: 'block warn', text: reasonText(x.error)}) : null), agents.find(a => a.key === x.agentId) ? agentName(agents.find(a => a.key === x.agentId)) : x.agentId, taskBadge(x.status), t(`c.priority.${x.priority}`), dt(x.createdAt), button(t('c.task.details'), {variant: 'ghost', onClick: () => taskDrawer(ctx, x.id, load)})])), pager(r, p => { page = p; load(); }))
    : emptyState(t('c.task.none'), t('c.task.noneHint'), ctx.can('tasks.create') ? button(t('c.task.new'), {variant: 'primary', onClick: () => newTaskModal(ctx, {onDone: load})}) : null));
  } catch (error) { list.replaceChildren(errorState(error, load)); }
 }
 const exportLink = ctx.has('client.export') && ctx.can('analytics.view') ? h('a', {class: 'btn btn-secondary', href: '/api/client/export/tasks.csv', download: 'tasks.csv'}, icon('download', 16), h('span', {text: t('common.exportCsv')})) : null;
 root.append(pageHead(t('c.nav.tasks'), t('c.task.subtitle'), exportLink, ctx.can('tasks.create') ? button(t('c.task.new'), {variant: 'primary', iconName: 'plus', onClick: () => newTaskModal(ctx, {onDone: load})}) : null), h('div', {class: 'toolbar'}, search, stSel, agSel), list);
 load();
 return root;
}
async function taskDrawer(ctx, id, reload) {
 const d = await api.get(`/api/client/tasks/${id}`);
 const act = async (action, label) => { if (action === 'cancel' && !(await confirmModal(t('c.task.cancelTitle'), d.title, {danger: true}))) return null; try { await api.post(`/api/client/tasks/${id}/${action}`, {}); toast(t('common.saved'), 'success'); reload?.(); return true; } catch (error) { toast(errorText(error), 'error'); return null; } };
 await modal(d.title, body => {
  body.append(h('div', {class: 'row-between'}, taskBadge(d.status), h('span', {class: 'muted small', text: dt(d.createdAt)})),
   d.description ? h('p', {text: d.description}) : null,
   h('dl', {class: 'facts'}, h('div', null, h('dt', {text: t('c.task.agent')}), h('dd', {text: d.agentId})), h('div', null, h('dt', {text: t('c.task.priority')}), h('dd', {text: t(`c.priority.${d.priority}`)})), h('div', null, h('dt', {text: t('c.task.risk')}), h('dd', {text: t(`c.risk.${d.riskLevel}`)})), h('div', null, h('dt', {text: t('c.task.approval')}), h('dd', {text: t(`c.tapproval.${d.approvalStatus}`)})), h('div', null, h('dt', {text: t('c.task.attempts')}), h('dd', {text: String(d.attempts)})), h('div', null, h('dt', {text: t('c.task.scheduledAt')}), h('dd', {text: d.scheduledAt ? dt(d.scheduledAt) : '—'}))),
   d.error ? h('p', {class: 'form-error', text: reasonText(d.error)}) : null,
   d.result ? h('div', null, h('h3', {text: t('c.task.result')}), d.result.summary ? h('p', {text: d.result.summary}) : null, d.result.payload ? h('pre', {class: 'asset-text', text: JSON.stringify(d.result.payload, null, 2).slice(0, 4000)}) : null) : null,
   d.usage ? h('p', {class: 'muted small', text: t('c.task.usage', {input: num(d.usage.tokensInput || 0), output: num(d.usage.tokensOutput || 0)})}) : null,
   d.toolCalls.length ? h('div', null, h('h3', {text: t('c.task.toolCalls')}), table([t('c.task.tool'), t('c.task.status'), t('c.task.created')], d.toolCalls.map(c => [c.tool, c.status, dt(c.at)]))) : null);
  const buttons = h('div', {class: 'row-actions'});
  if (ctx.can('tasks.cancel') && ['draft', 'queued', 'waiting_for_integration', 'waiting_for_approval', 'paused'].includes(d.status)) buttons.append(button(t('c.task.cancel'), {variant: 'danger', onClick: async () => { if (await act('cancel')) body.closest('dialog').close(); }}));
  if (ctx.can('tasks.create') && ['failed', 'waiting_for_integration'].includes(d.status)) buttons.append(button(t('c.task.retry'), {variant: 'secondary', onClick: async () => { if (await act('retry')) body.closest('dialog').close(); }}));
  if (ctx.can('tasks.create') && d.status === 'draft') buttons.append(button(t('c.task.submit'), {variant: 'primary', onClick: async () => { if (await act('submit')) body.closest('dialog').close(); }}));
  if (ctx.can('tasks.create') && d.status === 'queued') buttons.append(button(t('c.task.pause'), {variant: 'secondary', onClick: async () => { if (await act('pause')) body.closest('dialog').close(); }}));
  if (ctx.can('tasks.create') && d.status === 'paused') buttons.append(button(t('c.task.resume'), {variant: 'secondary', onClick: async () => { if (await act('resume')) body.closest('dialog').close(); }}));
  if (d.status === 'waiting_for_approval' && ctx.has('client.approvals')) buttons.append(h('a', {class: 'btn btn-secondary', href: '/client/approvals', text: t('c.task.goApprovals')}));
  body.append(buttons);
 }, {hideActions: true});
}

// ---- workflows (templates) ---------------------------------------------------------------------------------------------------------------------
export async function workflowsPage(ctx) {
 const locked = gateEnt(ctx, 'client.workflows'); if (locked) return locked;
 const catalog = Object.fromEntries((await api.get('/api/client/agents')).items.map(a => [a.key, a]));
 const agentLabel = id => (catalog[id] ? pick(catalog[id], 'name') : id);
 const blockerText = b => (b.agentId ? `${agentLabel(b.agentId)}: ` : '') + reasonText(b.reason);
 const root = h('div'), list = h('div');
 const canEdit = ctx.can('agents.configure'), canRun = ctx.can('agents.run');
 const weekdays = [0, 1, 2, 3, 4, 5, 6].map(d => [String(d), t(`c.wf.weekday.${d}`)]);
 async function act(id, action, {confirm = false} = {}) {
  if (confirm && !(await confirmModal(t(`c.wf.${action}`), t('c.wf.archiveHint'), {danger: true}))) return;
  if (!(await supportConfirm(ctx))) return;
  try { await api.post(`/api/client/workflows/${id}/${action}`, ctx.me.support ? {confirmSupport: true} : {}); toast(t('common.saved'), 'success'); load(); }
  catch (error) { toast(error.data?.details?.blockers?.length ? error.data.details.blockers.map(blockerText).join(' · ') : errorText(error), 'error'); }
 }
 async function runNow(id) {
  try { const r = await api.post(`/api/client/workflows/${id}/run`, {}); toast(t(`c.wf.run.${r.status}`) === `c.wf.run.${r.status}` ? r.status : t(`c.wf.run.${r.status}`), r.status === 'FAILED' ? 'error' : 'success'); load(); }
  catch (error) { toast(error.data?.details?.blockers?.length ? error.data.details.blockers.map(blockerText).join(' · ') : errorText(error), 'error'); }
 }
 async function runsModal(w) {
  await modal(pick(w, 'name'), body => {
   body.append(h('p', {class: 'muted', text: t('c.wf.runsHint')}));
   const holder = h('div', null, skeleton(2));
   body.append(holder);
   api.get(`/api/client/workflows/${w.id}/runs`).then(r => {
    if (!r.items.length) return holder.replaceChildren(emptyState(t('c.wf.noRuns')));
    holder.replaceChildren(h('ul', {class: 'list'}, r.items.map(run => h('li', {class: 'list-row'}, h('div', null, h('strong', {text: dt(run.startedAt)}), h('small', {class: 'block muted', text: t(`c.wf.trigger.${run.triggerType}`)})), h('div', {class: 'row-actions'}, badge(t(`c.wf.run.${run.status}`) === `c.wf.run.${run.status}` ? run.status : t(`c.wf.run.${run.status}`), run.status.toLowerCase()),
     canRun && ['RUNNING', 'WAITING', 'WAITING_APPROVAL'].includes(run.status) ? button(t('c.wf.cancelRun'), {variant: 'ghost', onClick: async () => { try { await api.post(`/api/client/workflow-runs/${run.id}/cancel`, ctx.me.support ? {confirmSupport: true} : {}); toast(t('common.saved'), 'success'); body.closest('dialog').close(); load(); } catch (error) { toast(errorText(error), 'error'); } }}) : null,
     run.status === 'WAITING_APPROVAL' && ctx.has('client.approvals') ? h('a', {class: 'btn btn-secondary', href: '/client/approvals', text: t('c.task.goApprovals')}) : null)))));
   }).catch(error => holder.replaceChildren(errorState(error)));
  }, {hideActions: true});
 }
 // create / edit share one form: only the template's bounded inputs exist
 async function formModal(templates, existing) {
  const tpl = existing ? templates.find(x => x.key === existing.templateKey) : null;
  await modal(existing ? t('c.wf.editTitle') : t('c.wf.newTitle'), body => {
   const chosen = tpl || templates.find(x => x.available) || templates[0];
   const params = existing?.params || {};
   const trig = params.trigger || chosen.defaultTrigger || {type: 'MANUAL'};
   const templateSelect = select('templateKey', templates.map(x => [x.key, `${pick(x, 'name')}${x.available ? '' : ` — ${t('c.wf.notInPlan')}`}`]), chosen.key);
   templateSelect.disabled = !!existing;
   const describe = h('div', {class: 'stack'});
   const objective = textarea('objective', {value: params.objective || '', maxlength: 500, rows: 3});
   const nameInput = input('name', {value: params.name || '', maxlength: 120});
   const trigger = select('triggerType', [['MANUAL', t('c.wf.trigger.MANUAL')], ['SCHEDULE', t('c.wf.trigger.SCHEDULE')]], trig.type);
   const frequency = select('frequency', [['DAILY', t('c.wf.freq.DAILY')], ['WEEKLY', t('c.wf.freq.WEEKLY')]], trig.schedule?.frequency || 'WEEKLY');
   const hour = select('hour', Array.from({length: 24}, (_, i) => [String(i), `${String(i).padStart(2, '0')}:00`]), String(trig.schedule?.hour ?? 8));
   const weekday = select('weekday', weekdays, String(trig.schedule?.weekday ?? 0));
   const schedule = h('div', {class: 'grid-2'}, field(t('c.wf.frequency'), frequency), field(t('c.wf.hour'), hour), field(t('c.wf.weekdayLabel'), weekday));
   const syncSchedule = () => { schedule.hidden = trigger.value !== 'SCHEDULE'; weekday.parentElement && (weekday.closest('.field') || weekday.parentElement).toggleAttribute('hidden', frequency.value !== 'WEEKLY'); };
   trigger.addEventListener('change', syncSchedule); frequency.addEventListener('change', syncSchedule);
   const renderDescribe = () => {
    const x = templates.find(y => y.key === templateSelect.value);
    describe.replaceChildren(...[h('p', {class: 'muted', text: pick(x, 'description')}),
     h('ol', {class: 'steps-outline'}, x.outline.map(([type, agent]) => h('li', {text: type === 'AGENT' ? t('c.wf.step.AGENT', {agent: agentLabel(agent)}) : t(`c.wf.step.${type}`)}))),
     x.sensitive ? h('p', {class: 'notice small', text: t('c.wf.sensitiveNote')}) : null,
     x.available ? null : h('p', {class: 'form-error', text: x.blockers.map(blockerText).join(' · ')})].filter(Boolean));
    objective.required = x.objectiveRequired;
   };
   templateSelect.addEventListener('change', renderDescribe);
   const form = h('form', {class: 'stack', novalidate: true},
    h('p', {class: 'notice small', text: t('c.wf.templatesNote')}),
    field(t('c.wf.template'), templateSelect), describe,
    field(t('c.wf.wfName'), nameInput), field(t('c.wf.objective'), objective, t('c.wf.objectiveHint')),
    field(t('c.wf.runs'), trigger), schedule);
   body.append(form); renderDescribe(); syncSchedule();
   return {
    validate: () => form.reportValidity(),
    value: () => {
     const data = formData(form);
     const body2 = {name: data.name || undefined, objective: data.objective || '', trigger: data.triggerType === 'SCHEDULE' ? {type: 'SCHEDULE', frequency: data.frequency, hour: Number(data.hour), ...(data.frequency === 'WEEKLY' ? {weekday: Number(data.weekday)} : {})} : {type: 'MANUAL'}};
     return existing ? api.patch(`/api/client/workflows/${existing.id}`, body2) : api.post('/api/client/workflows', {templateKey: templateSelect.value, ...body2});
    }
   };
  }, {confirmLabel: t('common.save')});
  load();
 }
 async function load() {
  list.replaceChildren(skeleton(3));
  try {
   const r = await api.get('/api/client/workflows');
   const head = h('div', {class: 'row-between'}, h('p', {class: 'muted', text: t('c.wf.templatesNote')}), canEdit ? button(t('c.wf.new'), {variant: 'primary', iconName: 'plus', onClick: () => formModal(r.templates)}) : null);
   if (!r.items.length) { list.replaceChildren(head, emptyState(t('c.wf.none'), t('c.wf.noneHint'))); return; }
   list.replaceChildren(head, table([t('c.wf.name'), t('c.task.status'), t('c.wf.runs'), ''], r.items.map(w => [
    h('div', null, h('strong', {text: pick(w, 'name')}), h('small', {class: 'block muted', text: w.templateKey ? pick(r.templates.find(x => x.key === w.templateKey) || {}, 'name') : ''}),
     !w.ready && w.status !== 'ARCHIVED' ? h('small', {class: 'block form-error', text: w.blockers.map(blockerText).join(' · ')}) : null),
    badge(t(`c.wfstatus.${w.status}`) === `c.wfstatus.${w.status}` ? w.status : t(`c.wfstatus.${w.status}`), w.status.toLowerCase()),
    w.trigger ? (w.trigger.type === 'SCHEDULE' ? t('c.wf.scheduleShort', {freq: t(`c.wf.freq.${w.trigger.schedule.frequency}`), hour: String(w.trigger.schedule.hour).padStart(2, '0')}) : t('c.wf.trigger.MANUAL')) : '—',
    h('div', {class: 'row-actions'},
     canEdit && w.editable ? button(t('c.wf.edit'), {onClick: () => formModal(r.templates, w)}) : null,
     canEdit && ['DRAFT'].includes(w.status) ? button(t('c.wf.activate'), {variant: 'primary', onClick: () => act(w.id, 'activate')}) : null,
     canEdit && w.status === 'ACTIVE' ? button(t('c.wf.pause'), {onClick: () => act(w.id, 'pause')}) : null,
     canEdit && w.status === 'PAUSED' ? button(t('c.wf.resume'), {onClick: () => act(w.id, 'resume')}) : null,
     canRun && w.status === 'ACTIVE' ? button(t('c.wf.runNow'), {onClick: () => runNow(w.id)}) : null,
     button(t('c.wf.history'), {variant: 'ghost', onClick: () => runsModal(w)}),
     canEdit && w.status !== 'ARCHIVED' ? button(t('c.wf.archive'), {variant: 'ghost', onClick: () => act(w.id, 'archive', {confirm: true})}) : null)])));
  } catch (error) { list.replaceChildren(errorState(error, load)); }
 }
 root.append(pageHead(t('c.nav.workflows'), t('c.wf.subtitle')), list);
 load();
 return root;
}

// ---- approvals ----------------------------------------------------------------------------------------------------------------------------------------
export async function approvalsPage(ctx) {
 const locked = gateEnt(ctx, 'client.approvals'); if (locked) return locked;
 const root = h('div'), list = h('div');
 let status = 'PENDING', page = 1;
 const sel = select('status', [['PENDING', t('c.approval.pending')], ['', t('c.filter.allStatuses')], ['APPROVED', t('c.approval.approved')], ['REJECTED', t('c.approval.rejected')]], status);
 sel.setAttribute('aria-label', t('c.task.status'));
 sel.addEventListener('change', () => { status = sel.value; page = 1; load(); });
 async function decide(a, decision) {
  let reason = null, confirmSupport;
  if (ctx.me.support && !(await confirmModal(t('c.support.confirmTitle'), t('c.support.confirmBody')))) return;
  if (ctx.me.support) confirmSupport = true;
  if (decision === 'REJECTED') {
   reason = await modal(t('c.approval.rejectTitle'), body => { const f = h('form', null, field(t('c.approval.reason'), textarea('reason', {required: true, maxlength: 500}))); body.append(f); return {validate: () => f.reportValidity(), value: () => f.elements.reason.value.trim()}; }, {confirmLabel: t('c.approval.reject'), danger: true});
   if (!reason) return;
  }
  try { await api.post(`/api/client/approvals/${a.id}/decide`, {decision, reason: reason || undefined, confirmSupport}); toast(t('common.saved'), 'success'); load(); } catch (error) { toast(errorText(error), 'error'); }
 }
 async function load() {
  list.replaceChildren(skeleton(3));
  try {
   const r = await api.get(`/api/client/approvals${api.qs({status, page})}`);
   list.replaceChildren(r.items.length ? h('div', {class: 'stack'}, r.items.map(a => h('article', {class: 'card approval'},
    h('div', {class: 'row-between'}, h('strong', {text: t(`c.atype.${a.actionType}`) === `c.atype.${a.actionType}` ? a.actionType : t(`c.atype.${a.actionType}`)}), h('div', {class: 'row-actions'}, badge(t(`c.risk.${a.riskLevel.toLowerCase()}`), a.riskLevel.toLowerCase()), badge(t(`c.approval.${a.status.toLowerCase()}`), a.status.toLowerCase()))),
    h('p', {class: 'muted', text: a.reason}),
    a.proposed ? h('dl', {class: 'facts'}, Object.entries(a.proposed).filter(([k]) => !['taskId'].includes(k)).slice(0, 6).map(([k, v]) => h('div', null, h('dt', {text: k}), h('dd', {text: String(v)})))) : null,
    h('small', {class: 'muted', text: `${a.agentId} · ${dt(a.createdAt)}${a.decidedByName ? ` · ${a.decidedByName}` : ''}`}),
    a.status === 'PENDING' && ctx.can('approvals.review') ? h('div', {class: 'row-actions'}, button(t('c.approval.approve'), {variant: 'primary', iconName: 'check', onClick: () => decide(a, 'APPROVED')}), button(t('c.approval.reject'), {variant: 'danger', onClick: () => decide(a, 'REJECTED')})) : null)), pager(r, p => { page = p; load(); }))
    : emptyState(t('c.approval.none'), t('c.approval.noneHint')));
  } catch (error) { list.replaceChildren(errorState(error, load)); }
 }
 root.append(pageHead(t('c.nav.approvals'), t('c.approval.subtitle')), h('div', {class: 'toolbar'}, sel), list);
 load();
 return root;
}
