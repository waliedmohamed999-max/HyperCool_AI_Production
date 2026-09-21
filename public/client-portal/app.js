import {initI18n, t, getLocale, setLocale, onLocaleChange, useExtraDictionary} from '../partner-portal/i18n.js';
import {api, loadSession, logout} from '../partner-portal/api.js';
import {h, icon, button, skeleton, errorState, date, num} from '../partner-portal/ui.js';
import {landingPage, loginPage, registerPage, verifyEmailPage, invitePage, stateGate, onboardingPage} from './pages.js';
import {dashboardPage, agentsPage, agentDetailPage, tasksPage, workflowsPage, approvalsPage} from './pages-work.js';
import {integrationsPage, analyticsPage, teamPage, notificationsPage, billingPage, settingsPage, supportPage} from './pages-account.js';

// Frost merchant portal shell + History-API router. The server decides everything that matters (tenant,
// role, plan, support mode); this file only chooses what to render from /api/client/me.

useExtraDictionary('/client-portal/i18n/');

const NAV = [
 ['dashboard', 'grid', 'client.dashboard'], ['agents', 'agent', null], ['tasks', 'check', null], ['workflows', 'clock', 'client.workflows'], ['approvals', 'lock', 'client.approvals'],
 ['integrations', 'link', 'client.integrations'], ['analytics', 'chart', 'client.analytics'], ['team', 'users', 'client.team'], ['notifications', 'bell', null], ['billing', 'wallet', null], ['settings', 'settings', null], ['support', 'info', null]
];
const PAGES = {
 '/client': {public: true, render: landingPage, title: 'landing'},
 '/client/login': {public: true, render: loginPage, title: 'login', guestOnly: true},
 '/client/register': {public: true, render: registerPage, title: 'register'},
 '/client/onboarding': {render: onboardingPage, title: 'onboarding', bare: true},
 '/client/dashboard': {render: dashboardPage, title: 'dashboard', nav: 'dashboard'},
 '/client/agents': {render: agentsPage, title: 'agents', nav: 'agents'},
 '/client/tasks': {render: tasksPage, title: 'tasks', nav: 'tasks'},
 '/client/workflows': {render: workflowsPage, title: 'workflows', nav: 'workflows'},
 '/client/approvals': {render: approvalsPage, title: 'approvals', nav: 'approvals'},
 '/client/integrations': {render: integrationsPage, title: 'integrations', nav: 'integrations'},
 '/client/analytics': {render: analyticsPage, title: 'analytics', nav: 'analytics'},
 '/client/team': {render: teamPage, title: 'team', nav: 'team'},
 '/client/notifications': {render: notificationsPage, title: 'notifications', nav: 'notifications'},
 '/client/billing': {render: billingPage, title: 'billing', nav: 'billing'},
 '/client/settings': {render: settingsPage, title: 'settings', nav: 'settings'},
 '/client/support': {render: supportPage, title: 'support', nav: 'support'}
};
function matchRoute(path) {
 if (PAGES[path]) return {route: PAGES[path], params: {}};
 let m;
 if ((m = path.match(/^\/client\/agents\/([a-z_]+)$/))) return {route: {render: agentDetailPage, title: 'agent', nav: 'agents'}, params: {id: m[1]}};
 if ((m = path.match(/^\/client\/verify-email\/([a-f0-9]+)$/))) return {route: {public: true, render: verifyEmailPage, title: 'verify'}, params: {token: m[1]}};
 if ((m = path.match(/^\/client\/invite\/([a-f0-9]+)$/))) return {route: {public: true, render: invitePage, title: 'invite'}, params: {token: m[1]}};
 return null;
}

const app = document.getElementById('app');
let me = null, authState = null, generation = 0, supportTimer = null;

const ctx = {
 get me() { return me; },
 navigate,
 async reload() { const s = await loadSession0(); return me; },
 homeFor(m) {
  if (!m) return '/client/login';
  if (m.noWorkspace) return authState?.isPlatformAdmin ? '/app#customers' : '/client/register';
  return !m.onboarding.completed && !['suspended', 'pending'].includes(m.access.accountStatus) ? '/client/onboarding' : '/client/dashboard';
 },
 has: key => !key || !!me?.access.entitlements.includes(key),
 can: perm => !!me?.permissions.includes(perm)
};
async function loadSession0() {
 const s = await loadSession().catch(error => { throw error; });
 authState = s.auth;
 me = null;
 if (s.signedIn) {
  try { me = await api.get('/api/client/me'); } catch (error) { if (error.code !== 'NO_CLIENT_WORKSPACE') throw error; me = {noWorkspace: true, user: s.auth.user}; }
 }
 return s;
}

export function navigate(path, {replace = false} = {}) {
 if (/^\/(app|partners)(\/|#|$)/.test(path)) { location.assign(path); return; }
 if (path === location.pathname + location.search) { render(); return; }
 history[replace ? 'replaceState' : 'pushState'](null, '', path);
 render();
}
document.addEventListener('click', event => {
 const a = event.target.closest('a[href]');
 if (!a || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0 || a.target || a.hasAttribute('download')) return;
 const url = new URL(a.href, location.origin);
 if (url.origin !== location.origin || !(url.pathname === '/client' || url.pathname.startsWith('/client/'))) return;
 event.preventDefault();
 navigate(url.pathname + url.search);
});
window.addEventListener('popstate', render);
onLocaleChange(render);

// ---- layouts -------------------------------------------------------------------------------------------------------------------
const langSwitch = () => h('div', {class: 'lang-switch', role: 'group', 'aria-label': t('common.language')}, ['ar', 'en'].map(l => h('button', {type: 'button', class: getLocale() === l ? 'active' : '', 'aria-pressed': String(getLocale() === l), onClick: () => setLocale(l), text: l.toUpperCase()})));
const brand = (href = '/client') => h('a', {class: 'brand', href, 'aria-label': t('c.brand')}, h('span', {class: 'brand-mark', text: 'F'}), h('span', {class: 'brand-word', dir: 'ltr', text: 'FROST'}), h('span', {class: 'brand-sub', text: t('c.merchants')}));

function publicLayout(content) {
 const nav = h('nav', {class: 'top-actions', 'aria-label': t('common.mainNav')},
  h('a', {class: 'link', href: '/', text: t('common.site')}),
  me && !me.noWorkspace ? h('a', {class: 'btn btn-secondary', href: ctx.homeFor(me), text: t('c.landing.openDashboard')}) : [h('a', {class: 'link', href: '/client/login', text: t('c.landing.login')}), h('a', {class: 'btn btn-primary', href: '/client/register', text: t('c.landing.start')})],
  langSwitch());
 return h('div', {class: 'public-shell client'}, h('a', {class: 'skip-link', href: '#main', text: t('common.skip')}), h('header', {class: 'public-header'}, brand('/'), nav), h('main', {id: 'main', tabindex: '-1'}, content), h('footer', {class: 'public-footer'}, h('span', {text: `© ${new Date().getFullYear()} Frost`}), h('a', {href: '/', text: t('common.site')})));
}

function supportBar() {
 const s = me.support;
 if (!s) return null;
 const left = h('strong', {class: 'support-left'});
 const tick = () => {
  const ms = Date.parse(s.expiresAt) - Date.now();
  if (ms <= 0) { clearInterval(supportTimer); navigate('/client/support', {replace: true}); location.reload(); return; }
  const m = Math.floor(ms / 60000), sec = Math.floor((ms % 60000) / 1000);
  left.textContent = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
 };
 clearInterval(supportTimer); tick(); supportTimer = setInterval(tick, 1000);
 return h('div', {class: 'support-bar', role: 'alert'},
  h('div', {class: 'support-text'}, icon('alert', 18), h('span', null, h('strong', {text: t('c.support.bar')}), ' · ', me.workspace.name, ' · ', t(`c.support.level.${s.level}`))),
  h('div', {class: 'support-actions'}, h('span', {class: 'support-time'}, t('c.support.remaining'), ' ', left),
   h('a', {class: 'btn btn-secondary', href: '/app#customers', text: t('c.support.back')}),
   button(t('c.support.end'), {variant: 'danger', onClick: async () => { await api.post('/api/client/support/end'); clearInterval(supportTimer); location.assign('/app#customers'); }})));
}

function banners() {
 const out = [];
 const a = me.access;
 if (a.accountStatus === 'limited') out.push(h('div', {class: 'banner banner-warn', role: 'status'}, icon('alert', 18), h('div', null, h('strong', {text: t('c.state.limitedTitle')}), h('p', {text: t('c.state.limitedBody')}), h('a', {href: '/client/billing', text: t('c.state.viewBilling')}))));
 if (a.accountStatus === 'past_due') out.push(h('div', {class: 'banner banner-warn', role: 'status'}, icon('alert', 18), h('div', null, h('strong', {text: t('c.state.graceTitle')}), h('p', {text: t('c.state.graceBody', {date: date(a.graceUntil)})}))));
 if (a.accountStatus === 'trial' && a.trialEndsAt) out.push(h('div', {class: 'banner banner-info', role: 'status'}, icon('info', 18), h('p', {text: t('c.state.trialBody', {date: date(a.trialEndsAt)})})));
 if (!me.user.emailVerified && !me.support) out.push(h('div', {class: 'banner banner-info', role: 'status'}, icon('info', 18), h('p', {text: t('c.state.verifyEmail', {email: me.user.email || ''})})));
 if (!me.onboarding.completed && !['pending', 'suspended'].includes(a.accountStatus)) out.push(h('div', {class: 'banner banner-info', role: 'status'}, icon('info', 18), h('div', null, h('p', {text: t('c.state.onboardingBody')}), h('a', {href: '/client/onboarding', text: t('c.state.continueOnboarding')}))));
 return out;
}

function workspaceLayout(route, content) {
 const a = me.access;
 const side = h('aside', {class: 'sidebar', id: 'sidebar', 'aria-label': t('common.mainNav')}, brand(),
  h('div', {class: 'workspace-card'}, h('strong', {text: me.workspace.name}), h('div', {class: 'row-actions'}, h('span', {class: 'pill', dataset: {status: a.accountStatus}, text: t(`c.account.${a.accountStatus}`)}), a.plan ? h('span', {class: 'chip', text: getLocale() === 'en' ? a.plan.nameEn : a.plan.nameAr}) : null)),
  h('nav', null, NAV.map(([id, ic, key]) => {
   const locked = !ctx.has(key);
   return h('a', {href: `/client/${id}`, class: `nav-link ${route.nav === id ? 'active' : ''}`, 'aria-current': route.nav === id ? 'page' : null}, icon(ic, 18), h('span', {text: t(`c.nav.${id}`)}), locked ? h('span', {class: 'nav-lock', title: t('c.locked')}, icon('lock', 14)) : null);
  })),
  h('div', {class: 'sidebar-foot'}, authState?.isPlatformAdmin ? h('a', {class: 'nav-link', href: '/app#customers'}, icon('settings', 18), h('span', {text: t('c.nav.admin')})) : null, h('a', {class: 'nav-link', href: '/'}, icon('globe', 18), h('span', {text: t('common.site')}))));
 const scrim = h('div', {class: 'scrim', hidden: true, onClick: () => closeMenu()});
 const menuBtn = button('', {variant: 'ghost', iconName: 'menu', ariaLabel: t('common.menu'), onClick: () => { const open = side.classList.toggle('open'); menuBtn.setAttribute('aria-expanded', String(open)); scrim.hidden = !open; }});
 menuBtn.classList.add('menu-btn'); menuBtn.setAttribute('aria-expanded', 'false');
 function closeMenu() { side.classList.remove('open'); scrim.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); }
 side.addEventListener('click', e => { if (e.target.closest('a')) closeMenu(); });
 const bell = h('a', {class: 'btn btn-ghost bell-link', href: '/client/notifications', 'aria-label': t('c.nav.notifications')}, icon('bell', 18), me.unreadNotifications ? h('span', {class: 'bell-count', text: String(me.unreadNotifications)}) : null);
 const top = h('header', {class: 'topbar'}, menuBtn, h('div', {class: 'top-title'}, h('strong', {text: me.workspace.name}), h('small', {class: 'muted', text: `${me.user.name} · ${t(`c.role.${me.role}`)}`})),
  h('div', {class: 'top-actions'}, bell, langSwitch(), me.support ? null : button(t('common.logout'), {variant: 'ghost', iconName: 'out', onClick: async () => { await logout(); me = null; navigate('/client/login', {replace: true}); }})));
 const shell = h('div', {class: 'app-shell client'}, h('a', {class: 'skip-link', href: '#main', text: t('common.skip')}), side, scrim, h('div', {class: 'app-main'}, top, h('main', {id: 'main', tabindex: '-1'}, banners(), content)));
 return me.support ? h('div', {class: 'support-wrap'}, supportBar(), shell) : shell;
}

// ---- render ------------------------------------------------------------------------------------------------------------------------------
async function render() {
 const mine = ++generation;
 clearInterval(supportTimer);
 const path = location.pathname.replace(/\/+$/, '') || '/client';
 const found = matchRoute(path);
 if (!found) { history.replaceState(null, '', '/client'); return render(); }
 const {route, params} = found;
 app.replaceChildren(h('div', {class: 'boot'}, skeleton(3)));
 try {
  if (!authState) await loadSession0();
  if (mine !== generation) return;
  const signedIn = !!me;
  const member = signedIn && !me.noWorkspace;
  if (!route.public && !signedIn) return navigate(`/client/login?next=${encodeURIComponent(path)}`, {replace: true});
  if (!route.public && signedIn && !member) { app.replaceChildren(publicLayout(h('div', {class: 'auth-wrap'}, h('div', {class: 'card auth-card'}, h('h1', {text: t('c.noWorkspace.title')}), h('p', {class: 'muted', text: t('c.noWorkspace.body')}), h('a', {class: 'btn btn-primary', href: '/client/register', text: t('c.noWorkspace.register')}), button(t('common.logout'), {variant: 'ghost', onClick: async () => { await logout(); authState = null; me = null; navigate('/client/login', {replace: true}); }}))))); return; }
  if (route.guestOnly && member) return navigate(ctx.homeFor(me), {replace: true});
  document.title = `${t(`c.title.${route.title}`)} | Frost`;
  let content;
  if (member && !route.public) {
   const gate = stateGate(ctx, route);
   try { content = gate || await route.render({...ctx, params}); } catch (error) { content = errorState(error, render); }
  } else {
   try { content = await route.render({...ctx, params}); } catch (error) { content = errorState(error, render); }
  }
  if (mine !== generation) return;
  const layout = route.public ? publicLayout(content) : (route.bare ? workspaceLayout({nav: 'dashboard'}, content) : workspaceLayout(route, content));
  app.replaceChildren(layout);
  if (me?.support) api.post('/api/client/support/page-view', {path}).catch(() => {});
  window.scrollTo(0, 0);
  document.getElementById('main')?.focus({preventScroll: true});
 } catch (error) {
  if (mine === generation) app.replaceChildren(h('div', {class: 'auth-wrap'}, errorState(error, () => { authState = null; render(); })));
 }
}

await initI18n();
render();
