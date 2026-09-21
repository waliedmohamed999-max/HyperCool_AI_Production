import {api} from './api.js';
import {t, pick, getLocale, setLocale} from './i18n.js';
import {h, icon, button, field, input, textarea, select, formData, showFormError, errorText, skeleton, errorState, emptyState, lockedState, metric, table, pager, badge, statusBadge, sparkChart, money, num, pct, date, toast, copyText, modal, confirmModal} from './ui.js';

const ENTITLEMENTS = ['partner.dashboard', 'partner.referrals', 'partner.customers', 'partner.commissions', 'partner.payouts', 'partner.marketing_assets', 'partner.analytics', 'partner.export_data', 'partner.custom_branding', 'partner.team_members'];

/** UI-side mirror of the server's entitlement check (the server is always the authority). */
export function gate(ctx, key) {
 const p = ctx.me.partner;
 if (!p) return lockedState({reason: 'NOT_A_PARTNER'});
 if (p.status === 'suspended') return lockedState({reason: 'PARTNER_SUSPENDED', title: t('state.suspendedTitle')});
 if (p.status === 'closed') return lockedState({reason: 'PARTNER_CLOSED'});
 if (!p.entitlements.includes(key)) return lockedState({reason: p.status === 'limited' ? 'PLAN_EXPIRED' : 'ENTITLEMENT_REQUIRED', title: t('state.lockedTitle')});
 return null;
}
const methodName = (label, type) => (label === type ? t(`method.${type}`) : label);
const has = (ctx, key) => !!ctx.me.partner?.entitlements.includes(key);
const currency = ctx => ctx.me.settings.currency;

function pageHead(title, subtitle, ...actions) {
 return h('header', {class: 'page-head'}, h('div', null, h('h1', {text: title}), subtitle ? h('p', {class: 'muted', text: subtitle}) : null), h('div', {class: 'page-actions'}, actions));
}
/** Renders `build(data)` with skeleton/error/retry around an async loader. */
function loadable(loader, build) {
 const host = h('div', {class: 'loadable'});
 async function run() {
  host.replaceChildren(skeleton(4));
  try { host.replaceChildren(await build(await loader(), run)); }
  catch (error) { host.replaceChildren(errorState(error, run)); }
 }
 run();
 return host;
}

// ---- dashboard ------------------------------------------------------------------------------------------------------
export async function dashboardPage(ctx) {
 const locked = gate(ctx, 'partner.dashboard'); if (locked) return locked;
 let days = 30;
 const root = h('div');
 const body = h('div');
 const rangeSelect = select('range', [[7, t('dashboard.days', {n: 7})], [30, t('dashboard.days', {n: 30})], [90, t('dashboard.days', {n: 90})]], 30);
 rangeSelect.setAttribute('aria-label', t('dashboard.range'));
 rangeSelect.addEventListener('change', () => { days = Number(rangeSelect.value); load(); });
 root.append(pageHead(t('nav.dashboard'), t('dashboard.subtitle'), rangeSelect), body);
 async function load() {
  body.replaceChildren(skeleton(6));
  try {
   const [d, methods] = await Promise.all([api.get(`/api/partners/dashboard${api.qs({days})}`), has(ctx, 'partner.payouts') ? api.get('/api/partners/payout-methods').catch(() => null) : null]);
   const tt = d.totals, cur = currency(ctx);
   const link = ctx.me.partner.links[0];
   const linkCard = h('section', {class: 'card link-card'}, h('div', null, h('h2', {text: t('dashboard.yourLink')}), h('p', {class: 'muted', text: t('dashboard.yourLinkHint', {days: ctx.me.settings.attributionWindowDays})})),
    h('div', {class: 'copy-row'}, h('input', {readonly: true, dir: 'ltr', value: link?.url || '', 'aria-label': t('dashboard.yourLink')}), button(t('common.copy'), {variant: 'primary', iconName: 'copy', onClick: () => copyText(link?.url || '')})),
    h('p', {class: 'muted small'}, t('dashboard.yourCode'), ' ', h('strong', {dir: 'ltr', text: ctx.me.partner.referralCode})));
   const checklist = [
    [t('dashboard.check.verify'), ctx.me.user.emailVerified, null],
    [t('dashboard.check.payout'), methods ? methods.methods.length > 0 : true, '/partners/payouts'],
    [t('dashboard.check.share'), tt.clicks > 0, null]
   ].filter(([, done]) => !done);
   const cards = [
    metric(t('dashboard.m.clicks'), num(tt.clicks), t('dashboard.m.clicksHint', {n: num(tt.uniqueVisitors)}), 'link'),
    metric(t('dashboard.m.registered'), num(tt.registered), null, 'users'),
    metric(t('dashboard.m.paying'), num(tt.paidCustomers), null, 'check'),
    metric(t('dashboard.m.conversion'), pct(tt.conversionBps), t('dashboard.m.conversionHint'), 'chart'),
    metric(t('dashboard.m.total'), money(tt.commissionsTotalMinor, cur), null, 'coins'),
    metric(t('dashboard.m.pending'), money(tt.commissionsPendingMinor, cur), t('dashboard.m.pendingHint', {n: ctx.me.settings.commissionHoldDays}), 'clock'),
    metric(t('dashboard.m.approved'), money(tt.commissionsApprovedMinor, cur), null, 'check'),
    metric(t('dashboard.m.withdrawable'), money(tt.withdrawableMinor, cur), tt.reservedMinor ? t('dashboard.m.reserved', {amount: money(tt.reservedMinor, cur)}) : null, 'wallet'),
    metric(t('dashboard.m.withdrawn'), money(tt.withdrawnMinor, cur), null, 'wallet')
   ];
   body.replaceChildren(
    linkCard,
    checklist.length ? h('section', {class: 'card'}, h('h2', {text: t('dashboard.getStarted')}), h('ul', {class: 'todo'}, checklist.map(([label, , href]) => h('li', null, icon('alert', 16), href ? h('a', {href, text: label}) : h('span', {text: label}))))) : null,
    h('section', {class: 'metric-grid', 'aria-label': t('dashboard.overview')}, cards),
    h('section', {class: 'chart-grid'},
     h('div', {class: 'card'}, h('h3', {text: t('dashboard.chart.visitors')}), sparkChart(d.series.visitors, {label: t('dashboard.chart.visitors')})),
     h('div', {class: 'card'}, h('h3', {text: t('dashboard.chart.registrations')}), sparkChart(d.series.registrations, {label: t('dashboard.chart.registrations')})),
     h('div', {class: 'card'}, h('h3', {text: t('dashboard.chart.commissions')}), sparkChart(d.series.commissions, {label: t('dashboard.chart.commissions'), format: v => money(v, cur)}))),
    h('section', {class: 'card'}, h('h3', {text: t('dashboard.topLinks')}), d.topLinks.length
     ? table([t('ref.link'), t('ref.clicks'), t('ref.registrations'), t('ref.conversions')], d.topLinks.map(l => [l.label, num(l.stats.clicks), num(l.stats.registrations), num(l.stats.conversions)]))
     : emptyState(t('dashboard.noLinksActivity'), t('dashboard.noLinksActivityHint'))));
  } catch (error) { body.replaceChildren(errorState(error, load)); }
 }
 load();
 return root;
}

// ---- referrals (links + campaigns + referral list) ----------------------------------------------------------------------------
export async function referralsPage(ctx) {
 const locked = gate(ctx, 'partner.referrals'); if (locked) return locked;
 const root = h('div');
 const tabs = h('div', {class: 'tabs', role: 'tablist'});
 const panel = h('div', {role: 'tabpanel'});
 let active = 'links';
 const names = [['links', t('ref.tab.links')], ['list', t('ref.tab.list')]];
 const draw = () => {
  tabs.replaceChildren(...names.map(([id, label]) => h('button', {type: 'button', role: 'tab', class: `tab ${id === active ? 'active' : ''}`, 'aria-selected': String(id === active), onClick: () => { active = id; draw(); }, text: label})));
  panel.replaceChildren(active === 'links' ? linksTab(ctx) : referralListTab(ctx));
 };
 root.append(pageHead(t('nav.referrals'), t('ref.subtitle')), tabs, panel);
 draw();
 return root;
}
function linksTab(ctx) {
 const host = h('div');
 async function load() {
  host.replaceChildren(skeleton(4));
  try {
   const {links, campaigns} = await api.get('/api/partners/links');
   const newLink = () => modal(t('ref.newLink'), body => {
    const form = h('form', {class: 'stack'},
     field(t('ref.label'), input('label', {required: true, maxlength: 80})),
     field(t('ref.landing'), select('landingPath', [['/', t('ref.landing.home')], ['/partners', t('ref.landing.partners')], ['/app', t('ref.landing.app')]])),
     field(t('ref.campaign'), select('campaignId', [['', t('ref.noCampaign')], ...campaigns.map(c => [c.id, c.name])])),
     h('details', null, h('summary', {text: t('ref.utm')}), ...['utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent'].map(k => field(t(`ref.${k}`), input(k, {maxlength: 80, dir: 'ltr'})))));
    body.append(form);
    return {value: async () => { const v = formData(form); for (const k of Object.keys(v)) if (v[k] === '') delete v[k]; return api.post('/api/partners/links', v); }, validate: () => form.reportValidity(), focus: () => form.querySelector('input')?.focus()};
   }, {confirmLabel: t('common.create')});
   const newCampaign = () => modal(t('ref.newCampaign'), body => {
    const form = h('form', null, field(t('ref.campaignName'), input('name', {required: true, maxlength: 80})));
    body.append(form);
    return {value: () => api.post('/api/partners/campaigns', formData(form)), validate: () => form.reportValidity(), focus: () => form.querySelector('input')?.focus()};
   }, {confirmLabel: t('common.create')});
   const toggle = async l => { if (await confirmModal(l.status === 'active' ? t('ref.disable') : t('ref.enable'), l.label)) { await api.patch(`/api/partners/links/${l.id}`, {status: l.status === 'active' ? 'disabled' : 'active'}); await load(); } };
   host.replaceChildren(
    h('div', {class: 'toolbar'}, button(t('ref.newLink'), {variant: 'primary', iconName: 'plus', onClick: async () => { if (await newLink()) { toast(t('common.saved'), 'success'); await load(); } }}), button(t('ref.newCampaign'), {iconName: 'plus', onClick: async () => { if (await newCampaign()) { toast(t('common.saved'), 'success'); await load(); } }})),
    campaigns.length ? h('p', {class: 'chips'}, h('span', {class: 'muted', text: t('ref.campaigns')}), campaigns.map(c => h('span', {class: 'chip', text: `${c.name} · ${c.links}`}))) : null,
    links.length ? table([t('ref.link'), t('ref.url'), t('ref.clicks'), t('ref.visitors'), t('ref.registrations'), t('ref.conversions'), t('ref.status'), ''], links.map(l => [
     h('div', null, h('strong', {text: l.label}), l.utm.source || l.utm.campaign ? h('small', {class: 'block muted', dir: 'ltr', text: [l.utm.source, l.utm.medium, l.utm.campaign].filter(Boolean).join(' / ')}) : null),
     h('div', {class: 'copy-row tight'}, h('code', {dir: 'ltr', text: l.url}), button('', {variant: 'ghost', iconName: 'copy', ariaLabel: t('common.copy'), onClick: () => copyText(l.url)})),
     num(l.stats.clicks), num(l.stats.uniqueVisitors), num(l.stats.registrations), num(l.stats.conversions),
     statusBadge('linkstatus', l.status),
     l.isDefault ? h('span', {class: 'muted small', text: t('ref.default')}) : button(l.status === 'active' ? t('ref.disable') : t('ref.enable'), {variant: 'ghost', onClick: () => toggle(l)})]))
     : emptyState(t('ref.noLinks')));
  } catch (error) { host.replaceChildren(errorState(error, load)); }
 }
 load();
 return host;
}
function referralListTab(ctx) {
 const host = h('div');
 let status = '', page = 1;
 const filter = select('status', [['', t('common.all')], ...['registered', 'qualified', 'converted', 'rejected', 'cancelled'].map(s => [s, t(`refstatus.${s}`)])], '');
 filter.setAttribute('aria-label', t('ref.status'));
 filter.addEventListener('change', () => { status = filter.value; page = 1; load(); });
 const list = h('div');
 async function load() {
  list.replaceChildren(skeleton(4));
  try {
   const r = await api.get(`/api/partners/referrals${api.qs({status, page})}`);
   list.replaceChildren(r.items.length
    ? h('div', null, table([t('ref.registeredAt'), t('ref.customer'), t('ref.status'), t('ref.source'), t('ref.link'), t('ref.commission')], r.items.map(i => [
     date(i.registeredAt), h('div', null, h('span', {text: i.customerName || '—'}), h('small', {class: 'block muted', dir: 'ltr', text: i.customerEmail || ''})),
     h('div', null, statusBadge('refstatus', i.status), i.rejectReason ? h('small', {class: 'block muted', text: t(`rejectreason.${i.rejectReason}`)}) : null),
     [i.source, i.medium, i.campaign].filter(Boolean).join(' / ') || '—', i.link || '—', i.commissionMinor ? money(i.commissionMinor, currency(ctx)) : '—'])), pager(r, p => { page = p; load(); }))
    : emptyState(t('ref.noReferrals'), t('ref.noReferralsHint')));
  } catch (error) { list.replaceChildren(errorState(error, load)); }
 }
 host.append(h('div', {class: 'toolbar'}, filter), list);
 load();
 return host;
}

// ---- customers ---------------------------------------------------------------------------------------------------------------------
export async function customersPage(ctx) {
 const locked = gate(ctx, 'partner.customers'); if (locked) return locked;
 const root = h('div'), list = h('div');
 let page = 1;
 async function load() {
  list.replaceChildren(skeleton(4));
  try {
   const r = await api.get(`/api/partners/customers${api.qs({page})}`);
   list.replaceChildren(r.items.length
    ? h('div', null, table([t('cust.since'), t('ref.customer'), t('cust.converted'), t('cust.revenue'), t('ref.commission')], r.items.map(i => [date(i.registeredAt), h('div', null, h('span', {text: i.customerName || '—'}), h('small', {class: 'block muted', dir: 'ltr', text: i.customerEmail || ''})), date(i.convertedAt), money(i.grossMinor, currency(ctx)), money(i.commissionMinor, currency(ctx))])), pager(r, p => { page = p; load(); }))
    : emptyState(t('cust.none'), t('cust.noneHint')));
  } catch (error) { list.replaceChildren(errorState(error, load)); }
 }
 root.append(pageHead(t('nav.customers'), t('cust.subtitle')), h('p', {class: 'notice small', text: t('cust.privacy')}), list);
 load();
 return root;
}

// ---- commissions ----------------------------------------------------------------------------------------------------------------------
export async function commissionsPage(ctx) {
 const locked = gate(ctx, 'partner.commissions'); if (locked) return locked;
 const root = h('div');
 let status = '', page = 1, tab = 'commissions';
 const cur = currency(ctx);
 const summary = h('div', {class: 'metric-grid'});
 const tabs = h('div', {class: 'tabs', role: 'tablist'});
 const list = h('div');
 const filter = select('status', [['', t('common.all')], ...['pending', 'on_hold', 'approved', 'available', 'paid', 'rejected', 'cancelled'].map(s => [s, t(`comstatus.${s}`)])], '');
 filter.setAttribute('aria-label', t('ref.status'));
 filter.addEventListener('change', () => { status = filter.value; page = 1; load(); });
 const drawTabs = () => tabs.replaceChildren(...[['commissions', t('com.tab.list')], ['ledger', t('com.tab.ledger')]].map(([id, label]) => h('button', {type: 'button', role: 'tab', class: `tab ${id === tab ? 'active' : ''}`, 'aria-selected': String(id === tab), text: label, onClick: () => { tab = id; page = 1; drawTabs(); load(); }})));
 async function load() {
  list.replaceChildren(skeleton(4));
  try {
   if (tab === 'commissions') {
    const r = await api.get(`/api/partners/commissions${api.qs({status, page})}`);
    const b = r.balances;
    summary.replaceChildren(metric(t('dashboard.m.pending'), money(b.pendingMinor, cur), t('com.pendingHint'), 'clock'), metric(t('com.available'), money(b.withdrawableMinor, cur), null, 'wallet'), metric(t('com.reserved'), money(b.reservedMinor, cur), null, 'lock'), metric(t('dashboard.m.withdrawn'), money(b.paidMinor, cur), null, 'check'));
    list.replaceChildren(r.items.length
     ? h('div', null, table([t('ref.registeredAt'), t('ref.status'), t('cust.revenue'), t('com.rate'), t('ref.commission'), t('com.holdUntil')], r.items.map(c => [
      date(c.createdAt), h('div', null, statusBadge('comstatus', c.status), c.rejectionReason ? h('small', {class: 'block muted', text: t(`rejectreason.${c.rejectionReason}`) === `rejectreason.${c.rejectionReason}` ? c.rejectionReason : t(`rejectreason.${c.rejectionReason}`)}) : null),
      money(c.grossMinor, c.currency), pct(c.rateBps), money(c.netMinor ?? c.commissionMinor, c.currency), ['pending', 'approved', 'on_hold'].includes(c.status) ? date(c.holdUntil) : '—'])), pager(r, p => { page = p; load(); }))
     : emptyState(t('com.none'), t('com.noneHint')));
   } else {
    const r = await api.get(`/api/partners/ledger${api.qs({page})}`);
    list.replaceChildren(r.items.length
     ? h('div', null, table([t('ref.registeredAt'), t('com.entry'), t('com.bucket'), t('com.amount')], r.items.map(e => [date(e.createdAt, {time: true}), t(`ledger.${e.type}`) === `ledger.${e.type}` ? e.type : t(`ledger.${e.type}`), t(`bucket.${e.bucket}`), h('span', {class: e.amountMinor < 0 ? 'neg' : 'pos', dir: 'ltr', text: money(e.amountMinor, e.currency)})])), pager(r, p => { page = p; load(); }))
     : emptyState(t('com.noLedger')));
   }
  } catch (error) { list.replaceChildren(errorState(error, load)); }
 }
 const exportLink = has(ctx, 'partner.export_data') ? h('a', {class: 'btn btn-secondary', href: '/api/partners/export/commissions.csv', download: 'commissions.csv'}, icon('download', 16), h('span', {text: t('common.exportCsv')})) : null;
 root.append(pageHead(t('nav.commissions'), t('com.subtitle', {days: ctx.me.settings.commissionHoldDays}), exportLink), summary, tabs, h('div', {class: 'toolbar'}, filter), list);
 drawTabs(); load();
 return root;
}

// ---- payouts ----------------------------------------------------------------------------------------------------------------------------
function methodFields(type, body) {
 body.replaceChildren();
 if (type === 'bank_transfer') body.append(field(t('pay.accountName'), input('accountName', {required: true, maxlength: 100})), field(t('pay.iban'), input('iban', {required: true, maxlength: 40, dir: 'ltr'})), field(t('pay.bankName'), input('bankName', {maxlength: 80})), field(t('pay.swift'), input('swift', {maxlength: 11, dir: 'ltr'})));
 else if (type === 'paypal') body.append(field(t('pay.paypalEmail'), input('email', {type: 'email', required: true, maxlength: 254})));
 else body.append(field(t('pay.instructions'), textarea('instructions', {required: true, maxlength: 500})));
}
export async function payoutsPage(ctx) {
 const locked = gate(ctx, 'partner.payouts'); if (locked) return locked;
 const root = h('div'), cur = currency(ctx);
 const host = h('div');
 async function load() {
  host.replaceChildren(skeleton(5));
  try {
   const [methodsRes, payouts] = await Promise.all([api.get('/api/partners/payout-methods'), api.get('/api/partners/payouts')]);
   const b = payouts.balances, methods = methodsRes.methods;
   const addMethod = () => modal(t('pay.addMethod'), body => {
    if (!methodsRes.encryptionConfigured) body.append(h('p', {class: 'form-error', text: t('err.ENCRYPTION_NOT_CONFIGURED')}));
    const fields = h('div', {class: 'stack'});
    const typeSel = select('type', methodsRes.enabledTypes.map(x => [x, t(`method.${x}`)]));
    const form = h('form', {class: 'stack'}, field(t('pay.method'), typeSel), field(t('pay.label'), input('label', {maxlength: 60})), fields, h('label', {class: 'check'}, h('input', {type: 'checkbox', name: 'isDefault'}), h('span', {text: t('pay.makeDefault')})));
    typeSel.addEventListener('change', () => methodFields(typeSel.value, fields));
    methodFields(typeSel.value, fields);
    body.append(form);
    return {validate: () => form.reportValidity(), value: () => { const v = formData(form); const {type, label, isDefault, ...details} = v; return api.post('/api/partners/payout-methods', {type, label, isDefault: isDefault === 'on', details}); }, focus: () => typeSel.focus()};
   }, {confirmLabel: t('common.save')});
   const requestPayout = () => modal(t('pay.request'), body => {
    const form = h('form', {class: 'stack'},
     h('p', null, t('pay.withdrawable'), ': ', h('strong', {text: money(b.withdrawableMinor, cur)})),
     h('p', {class: 'muted small', text: t('pay.minimumHint', {amount: money(payouts.minPayoutMinor, cur)})}),
     field(t('pay.method'), select('methodId', methods.map(m => [m.id, `${methodName(m.label, m.type)} — ${m.masked}`]), (methods.find(m => m.isDefault) || methods[0])?.id)),
     field(t('pay.amountOptional'), input('amount', {type: 'text', placeholder: t('pay.amountAll'), dir: 'ltr'}), t('pay.amountHint')));
    body.append(form);
    return {validate: () => form.reportValidity(), value: () => { const v = formData(form); return api.post('/api/partners/payouts', {methodId: v.methodId, ...(v.amount.trim() ? {amount: v.amount.trim()} : {})}); }};
   }, {confirmLabel: t('pay.submitRequest')});
   const canRequest = methods.length > 0 && b.withdrawableMinor > 0 && !payouts.items.some(p => ['requested', 'under_review', 'approved', 'processing'].includes(p.status));
   host.replaceChildren(
    h('section', {class: 'metric-grid'}, metric(t('pay.withdrawable'), money(b.withdrawableMinor, cur), null, 'wallet'), metric(t('com.reserved'), money(b.reservedMinor, cur), t('pay.reservedHint'), 'lock'), metric(t('dashboard.m.withdrawn'), money(b.paidMinor, cur), null, 'check'), metric(t('dashboard.m.pending'), money(b.pendingMinor, cur), t('com.pendingHint'), 'clock')),
    h('div', {class: 'toolbar'}, button(t('pay.request'), {variant: 'primary', iconName: 'wallet', disabled: !canRequest, onClick: async () => { const r = await requestPayout(); if (r) { toast(t('pay.requested'), 'success'); await load(); } }}),
     !methods.length ? h('span', {class: 'muted small', text: t('pay.needMethod')}) : b.withdrawableMinor <= 0 ? h('span', {class: 'muted small', text: t('pay.noBalance')}) : !canRequest ? h('span', {class: 'muted small', text: t('pay.openExists')}) : null),
    h('section', {class: 'card'}, h('div', {class: 'row-between'}, h('h2', {text: t('pay.methods')}), button(t('pay.addMethod'), {iconName: 'plus', onClick: async () => { if (await addMethod()) { toast(t('common.saved'), 'success'); await load(); } }})),
     methods.length ? h('ul', {class: 'list'}, methods.map(m => h('li', {class: 'list-row'}, h('div', null, h('strong', {text: methodName(m.label, m.type)}), h('small', {class: 'block muted', dir: 'ltr', text: `${t(`method.${m.type}`)} · ${m.masked}`})), h('div', {class: 'row-actions'}, m.isDefault ? badge(t('pay.default'), 'active') : button(t('pay.makeDefault'), {variant: 'ghost', onClick: async () => { await api.post(`/api/partners/payout-methods/${m.id}/default`); await load(); }}), button(t('common.delete'), {variant: 'ghost', onClick: async () => { if (await confirmModal(t('pay.deleteMethod'), `${methodName(m.label, m.type)} — ${m.masked}`, {danger: true, confirmLabel: t('common.delete')})) { await api.del(`/api/partners/payout-methods/${m.id}`); await load(); } }})))))
      : emptyState(t('pay.noMethods'), t('pay.noMethodsHint'))),
    h('section', {class: 'card'}, h('h2', {text: t('pay.history')}), payouts.items.length
     ? h('div', null, table([t('ref.registeredAt'), t('com.amount'), t('pay.method'), t('ref.status'), t('pay.reference'), ''], payouts.items.map(p => [date(p.requestedAt), money(p.amountMinor, p.currency), `${methodName(p.methodLabel, p.methodType)} — ${p.methodMasked}`,
      h('div', null, statusBadge('paystatus', p.status), p.rejectReason ? h('small', {class: 'block muted', text: p.rejectReason}) : null), p.paymentReference || '—',
      h('div', {class: 'row-actions'}, p.status === 'requested' ? button(t('common.cancel'), {variant: 'ghost', onClick: async () => { if (await confirmModal(t('pay.cancelTitle'), t('pay.cancelBody'))) { await api.post(`/api/partners/payouts/${p.id}/cancel`); toast(t('common.saved'), 'success'); await load(); } }}) : null,
       p.hasReceipt ? h('a', {class: 'btn btn-ghost', href: `/api/partners/payouts/${p.id}/receipt`, download: true}, icon('download', 16), h('span', {text: t('pay.receipt')})) : null)])))
     : emptyState(t('pay.noPayouts'))));
  } catch (error) { host.replaceChildren(errorState(error, load)); }
 }
 root.append(pageHead(t('nav.payouts'), t('pay.subtitle')), host);
 load();
 return root;
}

// ---- marketing assets ------------------------------------------------------------------------------------------------------------------------
export async function marketingPage(ctx) {
 const locked = gate(ctx, 'partner.marketing_assets'); if (locked) return locked;
 const root = h('div');
 root.append(pageHead(t('nav.marketing'), t('mkt.subtitle')), loadable(() => api.get('/api/partners/assets'), ({items}) => {
  if (!items.length) return emptyState(t('mkt.none'), t('mkt.noneHint'));
  const byCat = new Map();
  for (const a of items) byCat.set(a.category, [...(byCat.get(a.category) || []), a]);
  return h('div', null, [...byCat].map(([cat, list]) => h('section', {class: 'section-tight'}, h('h2', {text: t(`assetcat.${cat}`)}), h('div', {class: 'asset-grid'}, list.map(a => {
   const isImage = /^image\//.test(a.mimeType || '');
   const text = pick(a, 'text');
   return h('article', {class: 'card asset'},
    isImage ? h('img', {src: `/api/partners/assets/${a.id}/file`, alt: pick(a, 'title'), loading: 'lazy'}) : null,
    h('h3', {text: pick(a, 'title')}), a.descriptionAr || a.descriptionEn ? h('p', {class: 'muted', text: pick(a, 'description')}) : null,
    text ? h('pre', {class: 'asset-text', text}) : null,
    h('div', {class: 'row-actions'}, text ? button(t('common.copy'), {iconName: 'copy', onClick: () => copyText(text)}) : null,
     a.url ? h('a', {class: 'btn btn-secondary', href: a.url, target: '_blank', rel: 'noopener noreferrer'}, h('span', {text: t('mkt.open')})) : null,
     a.hasFile ? h('a', {class: 'btn btn-secondary', href: `/api/partners/assets/${a.id}/file?download=1`, download: a.fileName || true}, icon('download', 16), h('span', {text: t('common.download')})) : null));
  })))));
 }));
 return root;
}

// ---- settings / profile / plan ---------------------------------------------------------------------------------------------------------------
export async function settingsPage(ctx) {
 const p = ctx.me.partner;
 const root = h('div');
 root.append(pageHead(t('nav.settings'), t('set.subtitle')));
 if (!p) { root.append(emptyState(t('set.noProfile'))); return root; }
 const form = h('form', {class: 'card stack'}, h('h2', {text: t('set.profile')}),
  field(t('app.fullName'), input('displayName', {required: true, maxlength: 100, value: p.displayName})),
  field(t('app.company'), input('companyName', {maxlength: 120, value: p.companyName || ''})),
  field(t('app.phone'), input('phone', {type: 'tel', required: true, maxlength: 30, value: p.phone || ''})),
  field(t('app.website'), input('website', {type: 'url', maxlength: 300, value: p.website || ''})),
  field(t('set.email'), h('input', {value: ctx.me.user.email || '', readonly: true, dir: 'ltr'}), ctx.me.user.emailVerified ? t('set.emailVerified') : t('set.emailUnverified')),
  button(t('common.save'), {variant: 'primary', type: 'submit'}));
 form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  try { const v = formData(form); await api.patch('/api/partners/profile', {displayName: v.displayName, companyName: v.companyName, phone: v.phone, website: v.website}); await ctx.reload(); toast(t('common.saved'), 'success'); } catch (error) { showFormError(form, error); }
 });
 const sub = p.subscription;
 const plan = p.plan;
 const planCard = h('section', {class: 'card'}, h('div', {class: 'row-between'}, h('h2', {text: t('set.plan')}), statusBadge('pstatus', p.status)),
  plan ? h('div', null, h('p', null, h('strong', {text: pick(plan, 'name')}), ' · ', t('set.commissionRate', {rate: pct(p.effectiveCommissionBps)})),
   sub ? h('p', {class: 'muted', text: sub.endsAt ? t('set.endsAt', {date: date(sub.endsAt)}) : t('set.noEnd')}) : null,
   p.planExpired ? h('p', {class: 'notice', text: t('set.expiredNotice')}) : null,
   h('ul', {class: 'plan-features compact'}, ENTITLEMENTS.map(key => { const on = p.entitlements.includes(key); return h('li', {class: on ? 'has' : 'lacks'}, icon(on ? 'check' : 'lock', 16), h('span', {text: t(`ent.${key}`)})); })))
   : emptyState(t('set.noPlan')));
 const lang = h('section', {class: 'card'}, h('h2', {text: t('set.language')}), h('div', {class: 'row-actions'}, ['ar', 'en'].map(l => button(l === 'ar' ? 'العربية' : 'English', {variant: getLocale() === l ? 'primary' : 'secondary', onClick: () => setLocale(l)}))));
 root.append(h('div', {class: 'two-col'}, form, h('div', {class: 'stack'}, planCard, lang)));
 return root;
}

/** Notification text; amounts are formatted here, never trusted as strings from the server. */
export function notificationText(n, cur) {
 const p = n.params || {};
 const vars = {amount: p.amountMinor !== undefined ? money(p.amountMinor, p.currency || cur) : '', reason: p.reason || '', message: p.message || '', code: p.referralCode || '', plan: getLocale() === 'ar' ? p.planAr || p.plan || '' : p.plan || ''};
 const key = `notif.${n.kind}`;
 const text = t(key, vars);
 return text === key ? n.kind : text;
}
