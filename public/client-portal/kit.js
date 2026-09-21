import {t, pick} from '../partner-portal/i18n.js';
import {h, icon, statusBadge, num, date} from '../partner-portal/ui.js';

export function pageHead(title, subtitle, ...actions) {
 return h('header', {class: 'page-head'}, h('div', null, h('h1', {text: title}), subtitle ? h('p', {class: 'muted', text: subtitle}) : null), h('div', {class: 'page-actions'}, actions));
}
export const taskBadge = s => statusBadge('c.tstatus', s);
export const agentBadge = s => statusBadge('c.status', s);
export const dt = v => date(v, {time: true});

/** Human text for a reason/blocker code such as AGENT_LOCKED_BY_PLAN or REQUIRED_TOOL:search_brand_memory. */
export function reasonText(code) {
 if (!code) return '';
 const [base, arg] = String(code).split(':');
 const key = `c.reason.${base}`;
 const text = t(key, {arg: arg || ''});
 return text === key ? String(code) : text;
}
/** Native <progress> (CSP-safe): used vs limit. limit null = unlimited. */
export function meter(label, used, limit) {
 const wrap = h('div', {class: 'meter'}, h('div', {class: 'row-between'}, h('span', {text: label}), h('strong', {text: limit === null || limit === undefined ? `${num(used)} / ${t('c.unlimited')}` : `${num(used)} / ${num(limit)}`})));
 if (limit !== null && limit !== undefined && limit > 0) {
  const bar = h('progress', {max: String(limit), value: String(Math.min(used, limit)), 'aria-label': label});
  if (used / limit >= 0.9) bar.classList.add('hot'); else if (used / limit >= 0.7) bar.classList.add('warm');
  wrap.append(bar);
 } else if (limit === 0) wrap.append(h('small', {class: 'muted', text: t('c.notIncluded')}));
 return wrap;
}
export const agentName = a => pick(a, 'name');
export {h, icon};
