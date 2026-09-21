// Frost Partners portal - tiny DOM toolkit. Everything is built with createElement/textContent
// (never innerHTML with data), so partner-supplied strings can never become markup.
import {t, getLocale} from './i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, attrs, ...children) {
 const node = document.createElement(tag);
 if (attrs) {
  for (const [key, value] of Object.entries(attrs)) {
   if (value === undefined || value === null || value === false) continue;
   if (key === 'class') node.className = value;
   else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
   else if (key === 'dataset') Object.assign(node.dataset, value);
   else if (key === 'text') node.textContent = value;
   else if (value === true) node.setAttribute(key, '');
   else node.setAttribute(key, value);
  }
 }
 append(node, children);
 return node;
}
export function append(node, children) {
 for (const child of children.flat(Infinity)) {
  if (child === null || child === undefined || child === false) continue;
  node.append(child instanceof Node ? child : document.createTextNode(String(child)));
 }
 return node;
}
export const svg = (tag, attrs = {}, ...children) => {
 const node = document.createElementNS(SVG_NS, tag);
 for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
 append(node, children);
 return node;
};
export const clear = node => { node.replaceChildren(); return node; };

const ICONS = {
 grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z', users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M20 21v-2a4 4 0 0 0-3-3.87 M16 3a4 4 0 0 1 0 8',
 link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1', wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 7l2-3h12v3 M16 14h.01',
 coins: 'M12 6c4.4 0 8-1 8-2.5S16.4 1 12 1 4 2 4 3.5 7.6 6 12 6z M4 3.5v5C4 10 7.6 11 12 11s8-1 8-2.5v-5 M4 8.5v5C4 15 7.6 16 12 16s8-1 8-2.5v-5', gift: 'M20 12v9H4v-9 M2 7h20v5H2z M12 22V7 M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z',
 settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
 bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4', menu: 'M3 6h18 M3 12h18 M3 18h18', close: 'M6 6l12 12 M18 6 6 18', check: 'm5 12 4 4L19 6', plus: 'M12 5v14 M5 12h14', copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
 download: 'M12 3v12 M7 10l5 5 5-5 M4 21h16', alert: 'M12 9v4 M12 17h.01 M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', lock: 'M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4', chart: 'M3 3v18h18 M7 16v-5 M12 16V7 M17 16V4',
 out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9', globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M2 12h20 M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20', info: 'M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', clock: 'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'
};
export function icon(name, size = 18) {
 const s = svg('svg', {class: 'icon', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'});
 s.append(svg('path', {d: ICONS[name] || ICONS.grid}));
 return s;
}

// ---- formatting ------------------------------------------------------------------------------------
const numLocale = () => (getLocale() === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US');
export const num = value => new Intl.NumberFormat(numLocale()).format(value ?? 0);
export function money(minor, currency = 'SAR') {
 try { return new Intl.NumberFormat(numLocale(), {style: 'currency', currency}).format((minor || 0) / 100); } catch { return `${((minor || 0) / 100).toFixed(2)} ${currency}`; }
}
export const pct = bps => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
export function date(value, {time = false} = {}) {
 if (!value) return '—';
 const d = new Date(value);
 if (Number.isNaN(d.getTime())) return '—';
 return d.toLocaleString(numLocale(), {dateStyle: 'medium', ...(time ? {timeStyle: 'short'} : {}), timeZone: 'Asia/Riyadh'});
}

// ---- small components ---------------------------------------------------------------------------------
export const badge = (label, status) => h('span', {class: 'pill', dataset: {status: status || ''}, text: label});
export const statusBadge = (namespace, status) => badge(t(`${namespace}.${status}`) === `${namespace}.${status}` ? status : t(`${namespace}.${status}`), status);
export const skeleton = (rows = 3) => h('div', {class: 'skeleton', role: 'status', 'aria-label': t('common.loading')}, Array.from({length: rows}, () => h('div', {class: 'skeleton-block'})));
export function emptyState(title, hint, action) {
 return h('div', {class: 'state state-empty'}, icon('info', 28), h('strong', {text: title}), hint ? h('p', {text: hint}) : null, action || null);
}
export function errorState(error, retry) {
 const box = h('div', {class: 'state state-error', role: 'alert'}, icon('alert', 28), h('strong', {text: t('common.somethingWrong')}), h('p', {text: errorText(error)}));
 if (retry) box.append(button(t('common.retry'), {onClick: retry}));
 return box;
}
export function lockedState({reason, title, hint}) {
 return h('div', {class: 'state state-locked'}, icon('lock', 28), h('strong', {text: title || t('state.lockedTitle')}), h('p', {text: hint || t(`err.${reason}`)}));
}
export function errorText(error) {
 const code = error?.code || error?.message;
 if (code && t(`err.${code}`) !== `err.${code}`) return t(`err.${code}`);
 if (typeof code === 'string' && code.includes(':')) { const [base, arg] = code.split(':'); if (t(`err.${base}`) !== `err.${base}`) return t(`err.${base}`, {arg, amount: money(Number(arg) || 0)}); }
 if (typeof code === 'string' && code.startsWith('BELOW_MINIMUM')) return t('err.BELOW_MINIMUM', {amount: money(Number(code.split(':')[1]) || 0)});
 return error?.message || t('common.somethingWrong');
}
export function button(label, {variant = 'secondary', onClick, iconName, type = 'button', disabled, ariaLabel, cls = ''} = {}) {
 const b = h('button', {type, class: `btn btn-${variant} ${cls}`.trim(), 'aria-label': ariaLabel, disabled: disabled ? true : null});
 if (iconName) b.append(icon(iconName, 16));
 if (label) b.append(h('span', {text: label}));
 if (onClick) b.addEventListener('click', async event => {
  if (b.disabled) return;
  b.disabled = true; b.setAttribute('aria-busy', 'true');
  try { await onClick(event); } finally { b.disabled = false; b.removeAttribute('aria-busy'); }
 });
 return b;
}

let toastTimer;
export function toast(message, type = 'info') {
 const region = document.getElementById('toast');
 region.className = `toast toast-${type}`;
 region.replaceChildren(h('span', {text: message}), button('', {variant: 'ghost', iconName: 'close', ariaLabel: t('common.close'), onClick: () => region.replaceChildren()}));
 clearTimeout(toastTimer);
 toastTimer = setTimeout(() => region.replaceChildren(), 7000);
}

// ---- modal (native <dialog>: focus trap + Esc for free) -----------------------------------------------------
export function modal(title, build, {confirmLabel, cancelLabel, danger = false, hideActions = false} = {}) {
 return new Promise(resolve => {
  const dialog = h('dialog', {class: 'modal', 'aria-labelledby': 'modal-title'});
  const body = h('div', {class: 'modal-body'});
  const ctrl = build(body) || {};
  let result = null;
  const close = () => dialog.close();
  const actions = h('div', {class: 'modal-actions'});
  const ok = button(confirmLabel || t('common.confirm'), {variant: danger ? 'danger' : 'primary', type: 'button', onClick: async () => {
   if (ctrl.validate && !ctrl.validate()) return;
   try { result = ctrl.value ? await ctrl.value() : true; close(); } catch (error) { showFormError(body, error); }
  }});
  if (!hideActions) actions.append(ok, button(cancelLabel || t('common.cancel'), {variant: 'ghost', onClick: close}));
  else actions.append(button(t('common.close'), {variant: 'ghost', onClick: close}));
  dialog.append(h('div', {class: 'modal-head'}, h('h2', {id: 'modal-title', text: title}), button('', {variant: 'ghost', iconName: 'close', ariaLabel: t('common.close'), onClick: close})), body, actions);
  dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
  dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
  body.addEventListener('submit', e => { e.preventDefault(); ok.click(); });
  document.body.append(dialog);
  dialog.showModal();
  ctrl.focus?.();
 });
}
export const confirmModal = (title, message, {danger = false, confirmLabel} = {}) => modal(title, body => { body.append(h('p', {text: message})); }, {danger, confirmLabel});
export function showFormError(container, error) {
 container.querySelector('.form-error')?.remove();
 container.prepend(h('p', {class: 'form-error', role: 'alert', text: errorText(error)}));
}

// ---- forms -----------------------------------------------------------------------------------------------------
export function field(label, control, hint) {
 const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
 control.id = id;
 return h('div', {class: 'field'}, h('label', {for: id, text: label}), control, hint ? h('small', {text: hint}) : null);
}
export const input = (name, {type = 'text', value = '', required = false, maxlength, placeholder, autocomplete, min, dir} = {}) =>
 h('input', {name, type: type === 'number' ? 'text' : type, inputmode: type === 'number' ? 'numeric' : null, pattern: type === 'number' ? '[0-9]*' : null, value, required: required ? true : null, maxlength, placeholder, autocomplete, min, dir: dir || (['email', 'url', 'tel', 'password', 'number'].includes(type) ? 'ltr' : null)});
export const textarea = (name, {value = '', required = false, maxlength, rows = 4} = {}) => { const el = h('textarea', {name, rows, maxlength, required: required ? true : null}); el.value = value; return el; };
export const select = (name, options, value) => { const el = h('select', {name}, options.map(([v, label]) => h('option', {value: v, text: label}))); if (value !== undefined) el.value = value; return el; };
export const formData = form => Object.fromEntries(new FormData(form));

// ---- tables -------------------------------------------------------------------------------------------------------
export function table(headers, rows, {caption} = {}) {
 return h('div', {class: 'table-wrap', role: 'region', 'aria-label': caption || '', tabindex: '0'}, h('table', null,
  h('thead', null, h('tr', null, headers.map(text => h('th', {scope: 'col', text})))),
  h('tbody', null, rows.map(cells => h('tr', null, cells.map(cell => h('td', null, cell)))))));
}
export function pager(state, onPage) {
 if (!state || state.pages <= 1) return null;
 return h('div', {class: 'pager'},
  button(t('common.previous'), {variant: 'ghost', disabled: state.page <= 1, onClick: () => onPage(state.page - 1)}),
  h('span', {'aria-live': 'polite', text: t('common.pageOf', {page: state.page, pages: state.pages, total: state.total})}),
  button(t('common.next'), {variant: 'ghost', disabled: state.page >= state.pages, onClick: () => onPage(state.page + 1)}));
}
export function metric(label, value, hint, iconName = 'chart') {
 return h('article', {class: 'metric'}, h('div', {class: 'metric-top'}, h('span', {class: 'metric-label', text: label}), h('span', {class: 'metric-icon'}, icon(iconName, 18))), h('strong', {class: 'metric-value', text: value}), hint ? h('span', {class: 'metric-hint', text: hint}) : null);
}
export async function copyText(text) {
 try { await navigator.clipboard.writeText(text); toast(t('common.copied'), 'success'); }
 catch { const area = h('textarea', {readonly: true}); area.value = text; document.body.append(area); area.select(); try { document.execCommand('copy'); toast(t('common.copied'), 'success'); } catch { toast(t('common.copyFailed'), 'error'); } area.remove(); }
}

/** Bars/line without any inline style: geometry is SVG attributes only. Empty series => empty state. */
export function sparkChart(series, {label, format = num, height = 120} = {}) {
 const total = series.reduce((a, p) => a + p.value, 0);
 if (!total) return emptyState(t('dashboard.noDataYet'), t('dashboard.noDataHint'));
 const w = 600, pad = 4, max = Math.max(...series.map(p => p.value), 1), bw = (w - pad * 2) / series.length;
 const chart = svg('svg', {class: 'chart', viewBox: `0 0 ${w} ${height}`, role: 'img', 'aria-label': label, preserveAspectRatio: 'none'});
 series.forEach((p, i) => {
  const bh = Math.max(p.value ? 3 : 0, (p.value / max) * (height - 10));
  const rect = svg('rect', {x: pad + i * bw + 1, y: height - bh, width: Math.max(1, bw - 2), height: bh, rx: 2, class: 'chart-bar'});
  rect.append(svg('title', {}, `${p.day}: ${format(p.value)}`));
  chart.append(rect);
 });
 return h('figure', {class: 'chart-fig'}, chart, h('figcaption', {text: `${series[0].day} → ${series.at(-1).day} · ${t('dashboard.total')}: ${format(total)}`}));
}
