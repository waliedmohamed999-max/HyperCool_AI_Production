// Real i18n architecture: translation-key lookup against JSON files per locale/domain —
// never a manual `locale==='ar'?...:...` ternary scattered through page code. Arabic is the
// primary/default locale; English is the secondary, fallback locale (falls back to English,
// then to the raw key, never a blank string) per the product's language requirements.
const STORAGE_KEY = 'hc_locale';
const SUPPORTED = ['ar', 'en'];
const DEFAULT_LOCALE = 'ar';
export const DOMAINS = ['common', 'navigation', 'overview', 'sales', 'calendar', 'weeklyReport', 'content', 'agents', 'memory', 'integrations', 'operationsLog', 'team', 'forms', 'validation', 'statuses', 'errors', 'workspace', 'controlCenter', 'invitations', 'onboarding', 'account', 'platform', 'commandCenter', 'workflows', 'marketing', 'whatsapp'];

let locale = DEFAULT_LOCALE;
let dict = {};
let fallbackDict = {};
const listeners = new Set();
const cache = new Map();

async function loadDomain(loc, domain) {
  const cacheKey = `${loc}/${domain}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const promise = fetch(`/locales/${loc}/${domain}.json`).then(res => res.ok ? res.json() : {}).catch(() => ({}));
  cache.set(cacheKey, promise);
  return promise;
}
async function loadAll(loc) {
  const parts = await Promise.all(DOMAINS.map(d => loadDomain(loc, d)));
  const merged = {};
  DOMAINS.forEach((d, i) => { merged[d] = parts[i]; });
  return merged;
}
function lookup(root, path) {
  if (!root) return undefined;
  return path.split('.').reduce((node, key) => (node && typeof node === 'object') ? node[key] : undefined, root);
}
function interpolate(value, vars) {
  if (typeof value !== 'string' || !vars) return value;
  return value.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}
export function t(key, vars) {
  const dot = key.indexOf('.');
  if (dot < 0) return key;
  const domain = key.slice(0, dot), path = key.slice(dot + 1);
  let value = lookup(dict[domain], path);
  if (value === undefined) value = lookup(fallbackDict[domain], path);
  if (value === undefined) {
    if (locale !== 'production') console.warn(`[i18n] missing translation key: ${key}`);
    return key;
  }
  return interpolate(value, vars);
}
export function getLocale() { return locale; }
export function isRtl() { return locale === 'ar'; }
export function onLocaleChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export async function setLocale(next) {
  if (!SUPPORTED.includes(next)) next = DEFAULT_LOCALE;
  locale = next;
  const [own, fallback] = await Promise.all([loadAll(next), next === 'en' ? Promise.resolve(null) : loadAll('en')]);
  dict = own;
  fallbackDict = fallback || own;
  try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  document.documentElement.lang = next;
  document.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr';
  for (const fn of listeners) fn(next);
}
export async function initI18n({ preferredLocale } = {}) {
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch {}
  // Priority: an explicit account/profile preference (if the caller has one), then the
  // viewer's own saved client preference, then the product default (Arabic) — never the
  // browser's Accept-Language, since Arabic must stay the default regardless of OS locale.
  const initial = (preferredLocale && SUPPORTED.includes(preferredLocale)) ? preferredLocale
    : (stored && SUPPORTED.includes(stored)) ? stored
    : DEFAULT_LOCALE;
  await setLocale(initial);
}
