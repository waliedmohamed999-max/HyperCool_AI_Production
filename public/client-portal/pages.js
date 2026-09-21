import {api, login} from '../partner-portal/api.js';
import {t, pick, getLocale} from '../partner-portal/i18n.js';
import {h, icon, button, field, input, textarea, select, formData, showFormError, skeleton, errorState, emptyState, lockedState, badge, money, num, date, toast} from '../partner-portal/ui.js';

export const goalLabel = g => t(`c.goal.${g}`);
const safeNext = next => (next && /^\/client(\/[a-z-]+)?$/.test(next) ? next : null);

// ---- landing ------------------------------------------------------------------------------------------------------------------
export async function landingPage(ctx) {
 const root = h('div', {class: 'landing'});
 let cfg;
 try { cfg = await api.get('/api/client/public/config'); } catch (error) { return errorState(error, () => ctx.navigate('/client')); }
 const cta = () => h('div', {class: 'cta-row'}, h('a', {class: 'btn btn-primary btn-lg', href: '/client/register', text: t('c.landing.start')}), h('a', {class: 'btn btn-secondary btn-lg', href: ctx.me && !ctx.me.noWorkspace ? ctx.homeFor(ctx.me) : '/client/login', text: ctx.me && !ctx.me.noWorkspace ? t('c.landing.openDashboard') : t('c.landing.login')}));
 const agents = h('div', {class: 'agent-grid'}, cfg.agents.map(a => h('article', {class: 'card agent-mini'}, h('span', {class: 'pill', dataset: {status: 'info'}, text: t(`c.cat.${a.category}`)}), h('h3', {text: pick(a, 'name')}), h('p', {class: 'muted', text: pick(a, 'description')}))));
 const plans = h('div', {class: 'plan-grid'}, cfg.plans.map(p => {
  const agentCount = p.entitlements.filter(e => e.startsWith('agent.')).length;
  return h('article', {class: `plan-card ${p.highlighted ? 'is-featured' : ''}`}, p.highlighted ? h('span', {class: 'plan-flag', text: t('c.landing.popular')}) : null, h('h3', {text: pick(p, 'name')}), h('p', {class: 'plan-desc', text: pick(p, 'description')}),
   h('div', {class: 'plan-price', text: p.priceMinor ? `${money(p.priceMinor, p.currency)} / ${t(`period.${p.billingPeriod}`)}` : t('c.landing.priceOnRequest')}),
   h('ul', {class: 'plan-features'},
    h('li', {class: 'has'}, icon('check', 16), h('span', {text: t('c.landing.agentsIncluded', {n: agentCount})})),
    p.limits.users ? h('li', {class: 'has'}, icon('check', 16), h('span', {text: t('c.landing.users', {n: p.limits.users})})) : null,
    p.limits.tasks_per_month ? h('li', {class: 'has'}, icon('check', 16), h('span', {text: t('c.landing.tasks', {n: num(p.limits.tasks_per_month)})})) : null,
    p.limits.integrations ? h('li', {class: 'has'}, icon('check', 16), h('span', {text: t('c.landing.integrations', {n: p.limits.integrations})})) : null,
    p.trialDays ? h('li', {class: 'has'}, icon('check', 16), h('span', {text: t('c.landing.trial', {n: p.trialDays})})) : null));
 }));
 root.append(
  h('section', {class: 'hero'}, h('div', {class: 'hero-copy'}, h('span', {class: 'eyebrow', text: t('c.landing.eyebrow')}), h('h1', {text: t('c.landing.title')}), h('p', {class: 'lead', text: t('c.landing.subtitle')}), cta())),
  h('section', {class: 'section'}, h('h2', {text: t('c.landing.howTitle')}), h('ol', {class: 'steps'}, ['register', 'onboard', 'agents', 'approve'].map((k, i) => h('li', {class: 'step'}, h('span', {class: 'step-n', text: String(i + 1)}), h('div', null, h('strong', {text: t(`c.landing.step.${k}.title`)}), h('p', {text: t(`c.landing.step.${k}.body`)})))))),
  h('section', {class: 'section'}, h('h2', {text: t('c.landing.agentsTitle', {n: cfg.agents.length})}), h('p', {class: 'muted', text: t('c.landing.agentsHint')}), agents),
  h('section', {class: 'section'}, h('h2', {text: t('c.landing.plansTitle')}), plans),
  h('section', {class: 'section final-cta'}, h('h2', {text: t('c.landing.finalTitle')}), cta()));
 return root;
}

// ---- login ------------------------------------------------------------------------------------------------------------------------
export function loginPage(ctx) {
 const next = new URLSearchParams(location.search).get('next');
 const form = h('form', {class: 'card auth-card', novalidate: true}, h('h1', {text: t('c.login.title')}), h('p', {class: 'muted', text: t('c.login.subtitle')}),
  field(t('login.identity'), input('username', {required: true, autocomplete: 'username', dir: 'ltr'})), field(t('login.password'), input('password', {type: 'password', required: true, autocomplete: 'current-password'})),
  button(t('login.submit'), {variant: 'primary', type: 'submit', cls: 'btn-block'}),
  h('p', {class: 'auth-links'}, h('a', {href: '/app#forgot-password', text: t('login.forgot')}), ' · ', h('a', {href: '/client/register', text: t('c.login.noAccount')})));
 form.addEventListener('submit', async event => {
  event.preventDefault();
  const v = formData(form);
  if (!v.username?.trim() || !v.password) { showFormError(form, {code: 'FILL_REQUIRED'}); return; }
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try { await login(v.username.trim(), v.password); await ctx.reload(); ctx.navigate(safeNext(next) || ctx.homeFor(ctx.me), {replace: true}); }
  catch (error) { showFormError(form, error.status === 401 ? {code: 'LOGIN_FAILED'} : error); } finally { submit.disabled = false; }
 });
 return h('div', {class: 'auth-wrap'}, form);
}

// ---- register ---------------------------------------------------------------------------------------------------------------------------
export async function registerPage(ctx) {
 let cfg;
 try { cfg = await api.get('/api/client/public/config'); } catch (error) { return errorState(error, () => ctx.navigate('/client/register')); }
 if (ctx.me && !ctx.me.noWorkspace) { ctx.navigate(ctx.homeFor(ctx.me), {replace: true}); return h('div'); }
 const preselect = new URLSearchParams(location.search).get('plan') || '';
 const opts = list => list.map(v => [v, ''] );
 const form = h('form', {class: 'card auth-card wide', novalidate: true},
  h('h1', {text: t('c.register.title')}), h('p', {class: 'muted', text: t('c.register.subtitle')}),
  cfg.registrationMode === 'approval' ? h('p', {class: 'notice', text: t('c.register.approvalMode')}) : null,
  h('fieldset', null, h('legend', {text: t('c.register.account')}),
   field(t('register.name'), input('name', {required: true, maxlength: 100, autocomplete: 'name'})), field(t('register.username'), input('username', {required: true, maxlength: 40, autocomplete: 'username', dir: 'ltr'}), t('register.usernameHint')),
   field(t('register.email'), input('email', {type: 'email', required: true, autocomplete: 'email'})), field(t('app.phone'), input('phone', {type: 'tel', required: true, maxlength: 30, placeholder: '+9665XXXXXXXX'})),
   field(t('register.password'), input('password', {type: 'password', required: true, autocomplete: 'new-password'}), t('register.passwordHint')), field(t('register.confirmPassword'), input('confirmPassword', {type: 'password', required: true, autocomplete: 'new-password'}))),
  h('fieldset', null, h('legend', {text: t('c.register.business')}),
   field(t('c.register.businessName'), input('businessName', {required: true, maxlength: 100})), field(t('app.country'), input('country', {required: true, maxlength: 60})),
   field(t('c.register.businessType'), select('businessType', cfg.options.businessTypes.map(v => [v, t(`c.btype.${v}`)]))), field(t('c.register.businessSize'), select('businessSize', cfg.options.businessSizes.map(v => [v, t(`c.bsize.${v}`)]), 'small')),
   field(t('c.register.storeUrl'), input('storeUrl', {type: 'url', maxlength: 300, placeholder: 'https://'})), field(t('c.register.platform'), select('ecommercePlatform', cfg.options.platforms.map(v => [v, t(`c.platform.${v}`)]))),
   field(t('c.register.teamSize'), input('teamSize', {type: 'number', required: true, value: '1'}))),
  h('fieldset', null, h('legend', {text: t('c.register.goals')}), h('div', {class: 'check-grid'}, cfg.options.goals.map(g => h('label', {class: 'check'}, h('input', {type: 'checkbox', name: `goal:${g}`}), h('span', {text: goalLabel(g)}))))),
  h('fieldset', null, h('legend', {text: t('c.register.plan')}), h('div', {class: 'plan-pick'}, cfg.plans.map((p, i) => h('label', {class: 'plan-radio'}, h('input', {type: 'radio', name: 'planSlug', value: p.slug, ...((preselect ? preselect === p.slug : p.highlighted || i === 0) ? {checked: true} : {})}), h('span', null, h('strong', {text: pick(p, 'name')}), h('small', {class: 'block muted', text: pick(p, 'description')}), p.trialDays ? h('small', {class: 'block', text: t('c.landing.trial', {n: p.trialDays})}) : null))))),
  h('div', {class: 'terms'}, (getLocale() === 'en' ? cfg.termsEn || cfg.termsAr : cfg.termsAr || cfg.termsEn) ? h('details', null, h('summary', {text: t('app.readTerms', {v: cfg.termsVersion})}), h('pre', {class: 'terms-text', text: getLocale() === 'en' ? cfg.termsEn || cfg.termsAr : cfg.termsAr || cfg.termsEn})) : null,
   h('label', {class: 'check'}, h('input', {type: 'checkbox', name: 'acceptTerms', required: true}), h('span', {text: t('c.register.accept')}))),
  button(t('c.register.submit'), {variant: 'primary', type: 'submit', cls: 'btn-block'}), h('p', {class: 'auth-links'}, h('a', {href: '/client/login', text: t('register.haveAccount')})));
 form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const v = formData(form);
  if (v.password !== v.confirmPassword) { showFormError(form, {code: 'PASSWORD_MISMATCH'}); return; }
  const goals = cfg.options.goals.filter(g => v[`goal:${g}`] === 'on');
  if (!goals.length) { showFormError(form, {code: 'GOALS_REQUIRED'}); return; }
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try {
   const body = {name: v.name, username: v.username, email: v.email, password: v.password, phone: v.phone, country: v.country, businessName: v.businessName, businessType: v.businessType, businessSize: v.businessSize, storeUrl: v.storeUrl || undefined, ecommercePlatform: v.ecommercePlatform, teamSize: Number(v.teamSize), goals, planSlug: v.planSlug, acceptTerms: v.acceptTerms === 'on', locale: document.documentElement.lang, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone};
   const result = await api.post('/api/client/register', body);
   api.setCsrf(result.csrf);
   await ctx.reload();
   toast(t('c.register.done'), 'success');
   ctx.navigate(ctx.homeFor(ctx.me), {replace: true});
  } catch (error) { showFormError(form, error); form.scrollIntoView({block: 'start'}); } finally { submit.disabled = false; }
 });
 return h('div', {class: 'auth-wrap'}, form);
}

// ---- verify email / invitation ----------------------------------------------------------------------------------------------------------
export async function verifyEmailPage(ctx) {
 const box = h('div', {class: 'auth-wrap'}, h('div', {class: 'card auth-card'}, skeleton(2)));
 (async () => {
  const card = box.firstChild;
  try { const r = await api.post('/api/account/email/verify', {token: ctx.params.token}); card.replaceChildren(icon('check', 28), h('h1', {text: t('c.verify.done')}), h('p', {class: 'muted', text: t('c.verify.doneBody', {email: r.email})}), h('a', {class: 'btn btn-primary', href: '/client/dashboard', text: t('c.landing.openDashboard')})); }
  catch (error) { card.replaceChildren(icon('alert', 28), h('h1', {text: t('c.verify.failed')}), h('p', {class: 'muted', text: t('c.verify.failedBody')}), h('a', {class: 'btn btn-secondary', href: '/client/login', text: t('c.landing.login')})); }
 })();
 return box;
}
export async function invitePage(ctx) {
 const card = h('div', {class: 'card auth-card'}, skeleton(2));
 const box = h('div', {class: 'auth-wrap'}, card);
 try {
  const info = await api.get(`/api/client/invitations/${ctx.params.token}/preview`);
  if (info.status !== 'PENDING') { card.replaceChildren(icon('alert', 28), h('h1', {text: t('c.invite.invalid')}), h('p', {class: 'muted', text: t('c.invite.invalidBody')})); return box; }
  const signedIn = ctx.me && !ctx.me.noWorkspace || ctx.me?.noWorkspace;
  const head = [h('h1', {text: t('c.invite.title', {name: info.workspaceName})}), h('p', {class: 'muted', text: t('c.invite.body', {role: t(`c.role.${roleOf(info.role)}`)})})];
  if (ctx.me && ctx.me.user) {
   card.replaceChildren(...head, button(t('c.invite.accept'), {variant: 'primary', onClick: async () => { try { await api.post(`/api/client/invitations/${ctx.params.token}/accept`); await ctx.reload(); ctx.navigate('/client/dashboard', {replace: true}); } catch (error) { showFormError(card, error); } }}));
  } else {
   const form = h('form', {class: 'stack', novalidate: true}, field(t('register.name'), input('name', {required: true, maxlength: 100})), field(t('register.username'), input('username', {required: true, maxlength: 40, dir: 'ltr'}), t('register.usernameHint')), field(t('register.password'), input('password', {type: 'password', required: true, autocomplete: 'new-password'}), t('register.passwordHint')), button(t('c.invite.join'), {variant: 'primary', type: 'submit', cls: 'btn-block'}));
   form.addEventListener('submit', async event => { event.preventDefault(); if (!form.reportValidity()) return; try { const r = await api.post(`/api/client/invitations/${ctx.params.token}/register`, formData(form)); api.setCsrf(r.csrf); await ctx.reload(); ctx.navigate('/client/dashboard', {replace: true}); } catch (error) { showFormError(form, error); } });
   card.replaceChildren(...head, form, h('p', {class: 'auth-links'}, h('a', {href: `/client/login?next=${encodeURIComponent(location.pathname)}`, text: t('c.invite.haveAccount')})));
  }
 } catch (error) { card.replaceChildren(icon('alert', 28), h('h1', {text: t('c.invite.invalid')}), h('p', {class: 'muted', text: t('c.invite.invalidBody')})); }
 return box;
}
const roleOf = legacy => ({owner: 'workspace_admin', operator: 'operator', reviewer: 'viewer'}[legacy] || 'operator');

// ---- account-state gate (whole workspace unavailable) --------------------------------------------------------------------------------------
export function stateGate(ctx, route) {
 const s = ctx.me.access.accountStatus;
 if (!['pending', 'suspended', 'cancelled', 'archived'].includes(s)) return null;
 return h('div', {class: 'state state-locked gate'}, icon('lock', 32), h('h2', {text: t(`c.gate.${s}.title`)}), h('p', {text: t(`c.gate.${s}.body`)}), ctx.me.support ? null : h('a', {class: 'btn btn-secondary', href: '/', text: t('common.site')}));
}

// ---- onboarding ---------------------------------------------------------------------------------------------------------------------------------
const STEP_KEYS = ['business', 'goals', 'tools', 'agents', 'autonomy', 'review'];
export async function onboardingPage(ctx) {
 if (!ctx.can('settings.manage')) return emptyState(t('c.onb.ownerOnly'));
 const root = h('div', {class: 'onboarding wide'});
 let state = await api.get('/api/client/onboarding');
 let step = Math.min(state.currentStep, 6);
 const goals = ['grow_sales', 'marketing', 'customer_replies', 'content', 'campaigns', 'operations', 'analytics', 'crm'];
 async function save(n, body) { state = await api.put(`/api/client/onboarding/${n}`, body); step = Math.min(6, n + 1); await ctx.reload(); draw(); }
 const stepper = () => h('ol', {class: 'progress', 'aria-label': t('c.onb.progress')}, STEP_KEYS.map((k, i) => h('li', {class: i + 1 < step ? 'done' : i + 1 === step ? 'current' : ''}, h('button', {type: 'button', class: 'dot-btn', onClick: () => { step = i + 1; draw(); }}, h('span', {class: 'dot'}, i + 1 < step ? icon('check', 14) : String(i + 1)), h('span', {text: t(`c.onb.step.${k}`)})))));
 function draw() {
  const d = state.data || {};
  const body = h('div', {class: 'card stack'});
  if (state.completed) body.append(h('div', {class: 'state state-success'}, icon('check', 28), h('strong', {text: t('c.onb.doneTitle')}), h('p', {text: t('c.onb.doneBody')}), h('a', {class: 'btn btn-primary', href: '/client/dashboard', text: t('c.landing.openDashboard')})));
  else if (step === 1) {
   const form = h('form', {class: 'stack', novalidate: true}, h('h2', {text: t('c.onb.s1')}),
    field(t('c.register.businessName'), input('businessName', {required: true, maxlength: 100, value: d.businessName || state.profile.businessName})), field(t('c.onb.industry'), input('industry', {maxlength: 80, value: d.industry || ''})),
    field(t('app.country'), input('country', {required: true, maxlength: 60, value: d.country || state.profile.country || ''})), field(t('c.onb.currency'), input('currency', {maxlength: 3, value: d.currency || 'SAR', dir: 'ltr'})),
    field(t('c.onb.timezone'), input('timezone', {maxlength: 60, value: d.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, dir: 'ltr'})), field(t('c.onb.language'), select('language', [['ar', 'العربية'], ['en', 'English']], d.language || getLocale())),
    field(t('c.onb.offering'), textarea('offering', {required: true, maxlength: 1000, value: d.offering || ''})), field(t('c.onb.audience'), textarea('audience', {maxlength: 1000, value: d.audience || ''})), button(t('c.onb.next'), {variant: 'primary', type: 'submit'}));
   form.addEventListener('submit', async e => { e.preventDefault(); if (!form.reportValidity()) return; try { await save(1, {...formData(form), currency: formData(form).currency.toUpperCase()}); } catch (error) { showFormError(form, error); } });
   body.append(form);
  } else if (step === 2) {
   const chosen = new Set(d.goals || []);
   const form = h('form', {class: 'stack'}, h('h2', {text: t('c.onb.s2')}), h('div', {class: 'check-grid'}, goals.map(g => h('label', {class: 'check'}, h('input', {type: 'checkbox', name: g, checked: chosen.has(g) ? true : null}), h('span', {text: goalLabel(g)})))), button(t('c.onb.next'), {variant: 'primary', type: 'submit'}));
   form.addEventListener('submit', async e => { e.preventDefault(); const v = formData(form); try { await save(2, {goals: goals.filter(g => v[g] === 'on')}); } catch (error) { showFormError(form, error); } });
   body.append(form);
  } else if (step === 3) {
   body.append(h('h2', {text: t('c.onb.s3')}), h('p', {class: 'muted', text: t('c.onb.s3hint')}));
   const list = h('div'); body.append(list);
   list.append(skeleton(2));
   api.get('/api/client/integrations').then(r => list.replaceChildren(h('ul', {class: 'list'}, r.items.map(i => h('li', {class: 'list-row'}, h('div', null, h('strong', {text: pick(i, 'name')}), h('small', {class: 'block muted', text: pick(i, 'description')})), i.connection ? h('span', {class: 'pill', dataset: {status: i.connection.status === 'CONNECTED' ? 'active' : 'pending'}, text: t(`c.conn.${i.connection.status}`)}) : h('span', {class: 'pill', text: i.available ? t('c.conn.NONE') : t('c.conn.UNAVAILABLE')})))))).catch(err => list.replaceChildren(err.code === 'ENTITLEMENT_REQUIRED' ? lockedState({reason: 'ENTITLEMENT_REQUIRED'}) : errorState(err)));
   body.append(h('p', {class: 'muted small', text: t('c.onb.s3later')}), button(t('c.onb.next'), {variant: 'primary', onClick: () => save(3, {})}));
  } else if (step === 4) {
   const chosen = new Set(d.agents || state.agents.filter(a => a.suggested && a.usable).map(a => a.key));
   const grid = h('div', {class: 'agent-pick'}, state.agents.map(a => {
    const locked = !a.usable && !['account', 'onboarding'].includes(a.lockedReason ? '' : '') && a.status === 'locked_by_plan';
    const dis = a.status === 'locked_by_plan' || a.status === 'disabled_by_admin' || a.status === 'unavailable' && a.lockedReason === 'AGENT_UNAVAILABLE_PLATFORM';
    return h('label', {class: `card agent-option ${dis ? 'is-locked' : ''}`}, h('input', {type: 'checkbox', name: a.key, disabled: dis ? true : null, checked: chosen.has(a.key) && !dis ? true : null}), h('span', null, h('strong', {text: pick(a, 'name')}), h('small', {class: 'block muted', text: pick(a, 'description')}), a.suggested ? h('small', {class: 'block accent', text: t('c.onb.suggested')}) : null, dis ? h('small', {class: 'block warn', text: t(`c.reason.${a.status === 'locked_by_plan' ? 'AGENT_LOCKED_BY_PLAN' : a.lockedReason || 'AGENT_UNAVAILABLE_PLATFORM'}`)}) : null));
   }));
   const form = h('form', {class: 'stack'}, h('h2', {text: t('c.onb.s4')}), h('p', {class: 'muted', text: t('c.onb.s4hint')}), grid, button(t('c.onb.next'), {variant: 'primary', type: 'submit'}));
   form.addEventListener('submit', async e => { e.preventDefault(); const v = formData(form); try { await save(4, {agents: state.agents.map(a => a.key).filter(k => v[k] === 'on')}); } catch (error) { showFormError(form, error); } });
   body.append(form);
  } else if (step === 5) {
   const form = h('form', {class: 'stack'}, h('h2', {text: t('c.onb.s5')}), h('p', {class: 'muted', text: t('c.onb.s5hint')}), ...['manual', 'approval_required', 'limited_autonomy'].map(v => h('label', {class: 'plan-radio'}, h('input', {type: 'radio', name: 'autonomy', value: v, ...(state.defaultAutonomy === v ? {checked: true} : {})}), h('span', null, h('strong', {text: t(`c.autonomy.${v}`)}), h('small', {class: 'block muted', text: t(`c.autonomy.${v}.hint`)})))), h('p', {class: 'muted small', text: t('c.onb.noFullAuto')}), button(t('c.onb.next'), {variant: 'primary', type: 'submit'}));
   form.addEventListener('submit', async e => { e.preventDefault(); try { await save(5, {autonomy: formData(form).autonomy}); } catch (error) { showFormError(form, error); } });
   body.append(form);
  } else {
   const chosen = state.agents.filter(a => !a.paused);
   const ready = chosen.filter(a => a.status === 'available' || a.status === 'connected' || a.status === 'running'), notReady = chosen.filter(a => !ready.includes(a));
   body.append(h('h2', {text: t('c.onb.s6')}),
    h('dl', {class: 'facts'}, h('div', null, h('dt', {text: t('c.register.businessName')}), h('dd', {text: d.businessName || state.profile.businessName})), h('div', null, h('dt', {text: t('c.register.goals')}), h('dd', {text: (d.goals || []).map(goalLabel).join('، ') || '—'})), h('div', null, h('dt', {text: t('c.onb.s5')}), h('dd', {text: t(`c.autonomy.${state.defaultAutonomy}`)}))),
    h('h3', {text: t('c.onb.readyAgents')}), ready.length ? h('div', {class: 'chips'}, ready.map(a => h('span', {class: 'chip', text: pick(a, 'name')}))) : h('p', {class: 'muted', text: t('c.onb.noneReady')}),
    notReady.length ? h('div', null, h('h3', {text: t('c.onb.notReadyAgents')}), h('ul', {class: 'list'}, notReady.map(a => h('li', {class: 'list-row'}, h('strong', {text: pick(a, 'name')}), h('small', {class: 'muted', text: a.reasons.map(r => t(`c.reason.${r.split(':')[0]}`) === `c.reason.${r.split(':')[0]}` ? r : t(`c.reason.${r.split(':')[0]}`)).join(' · ') || t(`c.status.${a.status}`)}))))) : null,
    button(t('c.onb.launch'), {variant: 'primary', iconName: 'check', onClick: async () => { try { state = await api.post('/api/client/onboarding/complete'); await ctx.reload(); toast(t('c.onb.launched'), 'success'); ctx.navigate('/client/dashboard'); } catch (error) { showFormError(body, error); } }}));
  }
  root.replaceChildren(h('h1', {text: t('c.onb.title')}), stepper(), body);
 }
 draw();
 return root;
}
