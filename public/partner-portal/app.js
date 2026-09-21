import {initI18n, t, getLocale, setLocale, onLocaleChange} from './i18n.js';
import {api, loadSession, logout} from './api.js';
import {h, icon, button, skeleton, errorState, toast, date, errorText} from './ui.js';
import {landingPage, loginPage, registerPage, onboardingPage} from './pages-public.js';
import {dashboardPage, referralsPage, customersPage, commissionsPage, payoutsPage, marketingPage, settingsPage, notificationText} from './pages-partner.js';

// Frost Partners portal shell + History-API router. Public: /partners, /login, /register.
// Everything else requires a session; the server re-checks every call (this file only decides
// what to show, never what is allowed).

const NAV = [
 ['dashboard', 'grid', 'partner.dashboard'], ['referrals', 'link', 'partner.referrals'], ['customers', 'users', 'partner.customers'],
 ['commissions', 'coins', 'partner.commissions'], ['payouts', 'wallet', 'partner.payouts'], ['marketing', 'gift', 'partner.marketing_assets'], ['settings', 'settings', null]
];
const PAGES = {
 '/partners': {public: true, render: landingPage, title: 'landing'},
 '/partners/login': {public: true, render: loginPage, title: 'login', guestOnly: true},
 '/partners/register': {public: true, render: registerPage, title: 'register'},
 '/partners/onboarding': {render: onboardingPage, title: 'onboarding'},
 '/partners/dashboard': {render: dashboardPage, title: 'dashboard', nav: 'dashboard', partner: true},
 '/partners/referrals': {render: referralsPage, title: 'referrals', nav: 'referrals', partner: true},
 '/partners/customers': {render: customersPage, title: 'customers', nav: 'customers', partner: true},
 '/partners/commissions': {render: commissionsPage, title: 'commissions', nav: 'commissions', partner: true},
 '/partners/payouts': {render: payoutsPage, title: 'payouts', nav: 'payouts', partner: true},
 '/partners/marketing': {render: marketingPage, title: 'marketing', nav: 'marketing', partner: true},
 '/partners/settings': {render: settingsPage, title: 'settings', nav: 'settings', partner: true}
};

const app = document.getElementById('app');
let me = null;
let generation = 0;

const ctx = {
 get me() { return me; },
 navigate,
 async reload() { const s = await loadSession(); me = s.me; return me; },
 homeFor(m) {
  if (!m) return '/partners/login';
  if (m.partner) return '/partners/dashboard';
  if (m.application) return '/partners/onboarding';
  if (m.isManager) return '/app#partnerships';
  return '/partners/register';
 }
};

export function navigate(path, {replace = false} = {}) {
 if (path.startsWith('/app')) { location.assign(path); return; }
 if (path === location.pathname + location.search) { render(); return; }
 history[replace ? 'replaceState' : 'pushState'](null, '', path);
 render();
}

document.addEventListener('click', event => {
 const a = event.target.closest('a[href]');
 if (!a || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0 || a.target || a.hasAttribute('download')) return;
 const url = new URL(a.href, location.origin);
 if (url.origin !== location.origin || !url.pathname.startsWith('/partners')) return;
 event.preventDefault();
 navigate(url.pathname + url.search);
});
window.addEventListener('popstate', render);
onLocaleChange(render);

// ---- layouts ------------------------------------------------------------------------------------------------------------------
function langSwitch() {
 return h('div', {class: 'lang-switch', role: 'group', 'aria-label': t('common.language')}, ['ar', 'en'].map(l => h('button', {type: 'button', class: getLocale() === l ? 'active' : '', 'aria-pressed': String(getLocale() === l), onClick: () => setLocale(l), text: l.toUpperCase()})));
}
const brand = (href = '/partners') => h('a', {class: 'brand', href, 'aria-label': t('common.brand')}, h('span', {class: 'brand-mark', text: 'F'}), h('span', {class: 'brand-word', dir: 'ltr', text: 'FROST'}), h('span', {class: 'brand-sub', text: t('common.partners')}));

function publicLayout(content) {
 const nav = h('nav', {class: 'top-actions', 'aria-label': t('common.mainNav')},
  h('a', {class: 'link', href: '/', text: t('common.site')}),
  me ? h('a', {class: 'btn btn-secondary', href: ctx.homeFor(me), text: t('landing.openDashboard')}) : [h('a', {class: 'link', href: '/partners/login', text: t('landing.login')}), h('a', {class: 'btn btn-primary', href: '/partners/register', text: t('landing.apply')})],
  langSwitch());
 return h('div', {class: 'public-shell'}, h('a', {class: 'skip-link', href: '#main', text: t('common.skip')}), h('header', {class: 'public-header'}, brand('/'), nav), h('main', {id: 'main', tabindex: '-1'}, content), h('footer', {class: 'public-footer'}, h('span', {text: `© ${new Date().getFullYear()} Frost`}), h('a', {href: '/', text: t('common.site')})));
}

function partnerLayout(route, content) {
 const p = me.partner;
 const side = h('aside', {class: 'sidebar', id: 'sidebar', 'aria-label': t('common.mainNav')}, brand(),
  h('nav', null, NAV.map(([id, ic, key]) => {
   const locked = key && p && !p.entitlements.includes(key);
   return h('a', {href: `/partners/${id}`, class: `nav-link ${route.nav === id ? 'active' : ''}`, 'aria-current': route.nav === id ? 'page' : null}, icon(ic, 18), h('span', {text: t(`nav.${id}`)}), locked ? h('span', {class: 'nav-lock', title: t('state.lockedTitle')}, icon('lock', 14)) : null);
  })),
  h('div', {class: 'sidebar-foot'}, me.isManager ? h('a', {class: 'nav-link', href: '/app#partnerships'}, icon('settings', 18), h('span', {text: t('nav.admin')})) : null, h('a', {class: 'nav-link', href: '/'}, icon('globe', 18), h('span', {text: t('common.site')}))));
 const menuBtn = button('', {variant: 'ghost', iconName: 'menu', ariaLabel: t('common.menu'), onClick: () => { const open = side.classList.toggle('open'); menuBtn.setAttribute('aria-expanded', String(open)); scrim.hidden = !open; }});
 menuBtn.setAttribute('aria-expanded', 'false'); menuBtn.classList.add('menu-btn');
 const scrim = h('div', {class: 'scrim', hidden: true, onClick: () => { side.classList.remove('open'); scrim.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); }});
 side.addEventListener('click', e => { if (e.target.closest('a')) { side.classList.remove('open'); scrim.hidden = true; } });
 const bell = notificationsBell();
 const top = h('header', {class: 'topbar'}, menuBtn, h('div', {class: 'top-title'}, h('strong', {text: p?.displayName || me.user.name}), p ? h('small', {class: 'muted', text: `${t('common.code')}: ${p.referralCode}`}) : null), h('div', {class: 'top-actions'}, bell, langSwitch(),
  button(t('common.logout'), {variant: 'ghost', iconName: 'out', onClick: async () => { await logout(); me = null; navigate('/partners/login', {replace: true}); }})));
 const banners = [];
 if (p?.status === 'suspended') banners.push(h('div', {class: 'banner banner-critical', role: 'alert'}, icon('alert', 18), h('div', null, h('strong', {text: t('state.suspendedTitle')}), h('p', {text: t('state.suspendedBody', {reason: p.suspendedReason || '—'})}))));
 if (p?.status === 'limited') banners.push(h('div', {class: 'banner banner-warn', role: 'status'}, icon('alert', 18), h('div', null, h('strong', {text: t('state.limitedTitle')}), h('p', {text: t('state.limitedBody')}), h('a', {href: '/partners/settings', text: t('state.viewPlan')}))));
 if (!me.user.emailVerified) banners.push(h('div', {class: 'banner banner-info', role: 'status'}, icon('info', 18), h('p', {text: t('state.verifyEmail', {email: me.user.email || ''})})));
 return h('div', {class: 'app-shell'}, h('a', {class: 'skip-link', href: '#main', text: t('common.skip')}), side, scrim, h('div', {class: 'app-main'}, top, h('main', {id: 'main', tabindex: '-1'}, banners, content)));
}

function notificationsBell() {
 const wrap = h('div', {class: 'bell-wrap'});
 const count = h('span', {class: 'bell-count', hidden: true});
 const panel = h('div', {class: 'bell-panel', hidden: true, role: 'dialog', 'aria-label': t('notif.title')});
 const btn = button('', {variant: 'ghost', iconName: 'bell', ariaLabel: t('notif.title'), onClick: async () => {
  panel.hidden = !panel.hidden;
  btn.setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) await drawPanel();
 }});
 btn.setAttribute('aria-expanded', 'false'); btn.append(count);
 count.textContent = String(me.unreadNotifications || ''); count.hidden = !me.unreadNotifications;
 async function drawPanel() {
  panel.replaceChildren(skeleton(2));
  try {
   const r = await api.get('/api/partners/notifications');
   panel.replaceChildren(h('div', {class: 'row-between'}, h('strong', {text: t('notif.title')}), r.unread ? button(t('notif.markAll'), {variant: 'ghost', onClick: async () => { await api.post('/api/partners/notifications/read', {}); count.hidden = true; await drawPanel(); }}) : null),
    r.items.length ? h('ul', {class: 'notif-list'}, r.items.map(n => h('li', {class: n.read ? '' : 'unread'}, h('span', {text: notificationText(n, me.settings.currency)}), h('small', {class: 'muted', text: date(n.createdAt, {time: true})})))) : h('p', {class: 'muted', text: t('notif.none')}));
   count.textContent = String(r.unread); count.hidden = !r.unread;
  } catch (error) { panel.replaceChildren(errorState(error, drawPanel)); }
 }
 document.addEventListener('click', e => { if (!wrap.contains(e.target)) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
 wrap.append(btn, panel);
 return wrap;
}

// ---- render ---------------------------------------------------------------------------------------------------------------------------
async function render() {
 const mine = ++generation;
 const path = location.pathname.replace(/\/+$/, '') || '/partners';
 const route = PAGES[path];
 if (!route) { history.replaceState(null, '', '/partners'); return render(); }
 app.replaceChildren(h('div', {class: 'boot'}, skeleton(3)));
 try {
  if (!me) { const s = await loadSession(); me = s.me; }
  if (mine !== generation) return;
  // guards
  if (!route.public && !me) return navigate(`/partners/login?next=${encodeURIComponent(path)}`, {replace: true});
  if (route.guestOnly && me) return navigate(ctx.homeFor(me), {replace: true});
  if (route.partner && !me.partner) return navigate(ctx.homeFor(me) === '/partners/dashboard' ? '/partners/onboarding' : ctx.homeFor(me), {replace: true});
  let content;
  try { content = await route.render(ctx); } catch (error) { content = errorState(error, render); }
  if (mine !== generation) return;
  document.title = `${t(`title.${route.title}`)} | Frost`;
  const layout = route.public ? publicLayout(content) : partnerLayout(route, content);
  app.replaceChildren(layout);
  window.scrollTo(0, 0);
  document.getElementById('main')?.focus({preventScroll: true});
 } catch (error) {
  if (mine === generation) app.replaceChildren(h('div', {class: 'auth-wrap'}, errorState(error, render)));
 }
}

await initI18n();
render();
