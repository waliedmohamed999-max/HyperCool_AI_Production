// Portal i18n: one flat JSON per locale (Arabic default, English fallback). Shares the
// dashboard's `hc_locale` preference so the language choice follows the user across both apps.
const KEY = 'hc_locale';
const SUPPORTED = ['ar', 'en'];
let locale = 'ar', dict = {}, fallback = {};
const listeners = new Set();
let extraPrefix = null;
const fetchJson = async url => { const r = await fetch(url); return r.ok ? r.json() : {}; };
// Other portals (e.g. /client) reuse this module and add their own dictionary on top of the shared base.
const load = async loc => ({...(await fetchJson(`/partner-portal/i18n/${loc}.json`)), ...(extraPrefix ? await fetchJson(`${extraPrefix}${loc}.json`) : {})});
export const useExtraDictionary = prefix => { extraPrefix = prefix; };

export function t(key, vars) {
 let value = dict[key] ?? fallback[key];
 if (value === undefined) return key;
 if (vars) value = value.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
 return value;
}
export const getLocale = () => locale;
export const onLocaleChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export async function setLocale(next, {notify = true} = {}) {
 if (!SUPPORTED.includes(next)) next = 'ar';
 locale = next;
 const [own, en] = await Promise.all([load(next), next === 'en' ? null : load('en')]);
 dict = own; fallback = en || own;
 try { localStorage.setItem(KEY, next); } catch { /* private mode */ }
 document.documentElement.lang = next;
 document.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr';
 if (notify) for (const fn of listeners) fn(next);
}
export async function initI18n() {
 let stored = null;
 try { stored = localStorage.getItem(KEY); } catch { /* ignore */ }
 await setLocale(SUPPORTED.includes(stored) ? stored : 'ar', {notify: false});
}
export const pick = (obj, base) => (locale === 'en' ? obj[`${base}En`] || obj[`${base}Ar`] : obj[`${base}Ar`] || obj[`${base}En`]) || '';
