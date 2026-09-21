import {api, login} from './api.js';
import {t, pick, getLocale} from './i18n.js';
import {h, icon, button, field, input, textarea, select, formData, showFormError, errorText, skeleton, errorState, emptyState, money, pct, num, date, badge, toast, modal} from './ui.js';

const PARTNER_TYPES = ['affiliate', 'agency', 'reseller', 'influencer', 'consultant', 'other'];
const ENTITLEMENTS = ['partner.dashboard', 'partner.referrals', 'partner.customers', 'partner.commissions', 'partner.payouts', 'partner.marketing_assets', 'partner.analytics', 'partner.export_data', 'partner.custom_branding', 'partner.team_members'];

// ---- landing ---------------------------------------------------------------------------------------------------
export async function landingPage(ctx) {
 const root = h('div', {class: 'landing'});
 root.append(skeleton(6));
 let data;
 try { data = await api.get('/api/partners/public/plans'); } catch (error) { root.replaceChildren(errorState(error, () => ctx.navigate(location.pathname))); return root; }
 const s = data.settings;
 const cta = h('div', {class: 'cta-row'},
  h('a', {class: 'btn btn-primary btn-lg', href: '/partners/register', text: ctx.me?.partner ? t('landing.openDashboard') : t('landing.apply')}),
  h('a', {class: 'btn btn-secondary btn-lg', href: ctx.me ? '/partners/dashboard' : '/partners/login', text: ctx.me ? t('landing.openDashboard') : t('landing.login')}));
 if (ctx.me?.partner) cta.firstChild.setAttribute('href', '/partners/dashboard');
 const steps = ['apply', 'share', 'convert', 'paid'].map((k, i) => h('li', {class: 'step'}, h('span', {class: 'step-n', text: String(i + 1)}), h('div', null, h('strong', {text: t(`landing.step.${k}.title`)}), h('p', {text: t(`landing.step.${k}.body`)}))));
 const facts = [
  [t('landing.fact.attribution'), t('landing.fact.days', {n: s.attributionWindowDays})],
  [t('landing.fact.hold'), t('landing.fact.days', {n: s.commissionHoldDays})],
  [t('landing.fact.minPayout'), money(s.minPayoutMinor, s.currency)],
  [t('landing.fact.methods'), s.payoutMethods.map(m => t(`method.${m}`)).join(' · ')]
 ];
 const plans = data.plans.length
  ? h('div', {class: 'plan-grid'}, data.plans.map(plan => h('article', {class: `plan-card ${plan.highlighted ? 'is-featured' : ''}`},
   plan.highlighted ? h('span', {class: 'plan-flag', text: t('landing.popular')}) : null,
   h('h3', {text: pick(plan, 'name')}),
   h('p', {class: 'plan-desc', text: pick(plan, 'description')}),
   h('div', {class: 'plan-rate'}, h('strong', {text: pct(plan.defaultCommissionBps)}), h('span', {text: t('landing.commission')})),
   h('div', {class: 'plan-price', text: plan.priceMinor ? `${money(plan.priceMinor, plan.currency)} / ${t(`period.${plan.billingPeriod}`)}` : t('landing.freePlan')}),
   h('ul', {class: 'plan-features'}, ENTITLEMENTS.map(key => {
    const has = plan.entitlements.includes(key);
    return h('li', {class: has ? 'has' : 'lacks'}, icon(has ? 'check' : 'close', 16), h('span', {text: t(`ent.${key}`)}), has ? null : h('span', {class: 'sr-only', text: t('landing.notIncluded')}));
   })))))
  : emptyState(t('landing.noPlans'));
 root.replaceChildren(
  h('section', {class: 'hero'}, h('div', {class: 'hero-copy'},
   h('span', {class: 'eyebrow', text: t('landing.eyebrow')}), h('h1', {text: t('landing.title')}), h('p', {class: 'lead', text: t('landing.subtitle')}), cta)),
  h('section', {class: 'section', 'aria-labelledby': 'how'}, h('h2', {id: 'how', text: t('landing.howTitle')}), h('ol', {class: 'steps'}, steps)),
  h('section', {class: 'section', 'aria-labelledby': 'plans'}, h('h2', {id: 'plans', text: t('landing.plansTitle')}), h('p', {class: 'muted', text: t('landing.plansHint')}), plans),
  h('section', {class: 'section', 'aria-labelledby': 'rules'}, h('h2', {id: 'rules', text: t('landing.rulesTitle')}), h('dl', {class: 'facts'}, facts.map(([k, v]) => h('div', null, h('dt', {text: k}), h('dd', {text: v}))))),
  h('section', {class: 'section final-cta'}, h('h2', {text: t('landing.finalTitle')}), cta.cloneNode(true)));
 return root;
}

// ---- login ---------------------------------------------------------------------------------------------------------
export function loginPage(ctx) {
 const next = new URLSearchParams(location.search).get('next');
 const form = h('form', {class: 'card auth-card', novalidate: true},
  h('h1', {text: t('login.title')}), h('p', {class: 'muted', text: t('login.subtitle')}),
  field(t('login.identity'), input('username', {required: true, autocomplete: 'username', dir: 'ltr'})),
  field(t('login.password'), input('password', {type: 'password', required: true, autocomplete: 'current-password'})),
  button(t('login.submit'), {variant: 'primary', type: 'submit', cls: 'btn-block'}),
  h('p', {class: 'auth-links'}, h('a', {href: '/app#forgot-password', text: t('login.forgot')}), ' · ', h('a', {href: '/partners/register', text: t('login.noAccount')})));
 form.addEventListener('submit', async event => {
  event.preventDefault();
  const v = formData(form);
  if (!v.username?.trim() || !v.password) { showFormError(form, {code: 'FILL_REQUIRED'}); return; }
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try {
   await login(v.username.trim(), v.password);
   await ctx.reload();
   ctx.navigate(safeNext(next) || ctx.homeFor(ctx.me), {replace: true});
  } catch (error) { showFormError(form, error.status === 401 ? {code: 'LOGIN_FAILED'} : error); }
  finally { submit.disabled = false; }
 });
 return h('div', {class: 'auth-wrap'}, form);
}
const safeNext = next => (next && /^\/partners(\/[a-z]+)?$/.test(next) ? next : null);

// ---- register (account + application) ----------------------------------------------------------------------------------
function applicationFields(prefill = {}) {
 return [
  field(t('app.fullName'), input('fullName', {required: true, maxlength: 100, value: prefill.fullName || ''})),
  field(t('app.phone'), input('phone', {type: 'tel', required: true, maxlength: 30, placeholder: '+9665XXXXXXXX', value: prefill.phone || ''})),
  field(t('app.country'), input('country', {required: true, maxlength: 60, value: prefill.country || ''})),
  field(t('app.company'), input('companyName', {maxlength: 120, value: prefill.companyName || ''})),
  field(t('app.website'), input('website', {type: 'url', maxlength: 300, placeholder: 'https://', value: prefill.website || ''})),
  field(t('app.partnerType'), select('partnerType', PARTNER_TYPES.map(p => [p, t(`ptype.${p}`)]), prefill.partnerType || 'affiliate')),
  field(t('app.marketingMethod'), textarea('marketingMethod', {required: true, maxlength: 2000, rows: 4, value: prefill.marketingMethod || ''}), t('app.marketingHint')),
  field(t('app.expectedCustomers'), input('expectedCustomers', {type: 'number', required: true, min: '0', value: prefill.expectedCustomers ?? ''}))
 ];
}
function applicationBody(v, {plans, extra = {}} = {}) {
 return {
  fullName: v.fullName, phone: v.phone, country: v.country, companyName: v.companyName, website: v.website || undefined, partnerType: v.partnerType,
  marketingMethod: v.marketingMethod, expectedCustomers: Number(v.expectedCustomers), acceptTerms: v.acceptTerms === 'on', requestedPlanId: v.requestedPlanId || undefined, ...extra
 };
}
function termsBlock(settings) {
 const text = getLocale() === 'en' ? settings.termsEn || settings.termsAr : settings.termsAr || settings.termsEn;
 return h('div', {class: 'terms'},
  text ? h('details', null, h('summary', {text: t('app.readTerms', {v: settings.termsVersion})}), h('pre', {class: 'terms-text', text})) : null,
  h('label', {class: 'check'}, h('input', {type: 'checkbox', name: 'acceptTerms', required: true}), h('span', {text: t('app.acceptTerms')})));
}
function planSelect(plans, current) {
 if (!plans.length) return null;
 return field(t('app.requestedPlan'), select('requestedPlanId', [['', t('app.noPreference')], ...plans.map(p => [p.id, `${pick(p, 'name')} — ${pct(p.defaultCommissionBps)}`])], current || ''), t('app.planHint'));
}

export async function registerPage(ctx) {
 const wrap = h('div', {class: 'auth-wrap'}, skeleton(5));
 let data;
 try { data = await api.get('/api/partners/public/plans'); } catch (error) { wrap.replaceChildren(errorState(error, () => ctx.navigate(location.pathname + location.search))); return wrap; }
 const invite = new URLSearchParams(location.search).get('invite') || '';
 const inviteOnly = data.settings.registrationMode === 'invite_only';
 const signedIn = !!ctx.me;
 if (signedIn && ctx.me.partner) { ctx.navigate('/partners/dashboard', {replace: true}); return wrap; }
 if (signedIn && ctx.me.application && ['pending', 'under_review', 'needs_information'].includes(ctx.me.application.status)) { ctx.navigate('/partners/onboarding', {replace: true}); return wrap; }
 const form = h('form', {class: 'card auth-card wide', novalidate: true},
  h('h1', {text: t('register.title')}), h('p', {class: 'muted', text: t('register.subtitle')}),
  inviteOnly ? h('p', {class: 'notice', text: t('register.inviteOnly')}) : null,
  inviteOnly ? field(t('register.inviteCode'), input('inviteCode', {required: true, value: invite, maxlength: 20, dir: 'ltr'})) : null,
  signedIn ? [h('p', {class: 'notice', text: t('register.signedInAs', {name: ctx.me.user.name})}), ctx.me.user.email ? null : field(t('register.email'), input('email', {type: 'email', required: true, autocomplete: 'email'}))] : h('fieldset', null,
   h('legend', {text: t('register.accountSection')}),
   field(t('register.name'), input('name', {required: true, maxlength: 100, autocomplete: 'name'})),
   field(t('register.username'), input('username', {required: true, maxlength: 40, autocomplete: 'username', dir: 'ltr'}), t('register.usernameHint')),
   field(t('register.email'), input('email', {type: 'email', required: true, autocomplete: 'email'})),
   field(t('register.password'), input('password', {type: 'password', required: true, autocomplete: 'new-password'}), t('register.passwordHint')),
   field(t('register.confirmPassword'), input('confirmPassword', {type: 'password', required: true, autocomplete: 'new-password'}))),
  h('fieldset', null, h('legend', {text: t('register.applicationSection')}), applicationFields(), planSelect(data.plans)),
  termsBlock(data.settings),
  button(t('register.submit'), {variant: 'primary', type: 'submit', cls: 'btn-block'}),
  h('p', {class: 'auth-links'}, signedIn ? null : [h('a', {href: '/partners/login', text: t('register.haveAccount')})]));
 form.addEventListener('submit', async event => {
  event.preventDefault();
  const v = formData(form);
  if (!form.reportValidity()) return;
  if (!signedIn && v.password !== v.confirmPassword) { showFormError(form, {code: 'PASSWORD_MISMATCH'}); return; }
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try {
   const application = applicationBody(v, {extra: {inviteCode: v.inviteCode || undefined}});
   if (signedIn) await api.post('/api/partners/applications', {...application, email: ctx.me.user.email || v.email});
   else {
    const result = await api.post('/api/partners/register', {...application, name: v.name, username: v.username, email: v.email, password: v.password, locale: document.documentElement.lang});
    api.setCsrf(result.csrf);
   }
   await ctx.reload();
   toast(t('register.submitted'), 'success');
   ctx.navigate('/partners/onboarding', {replace: true});
  } catch (error) { showFormError(form, error); form.scrollIntoView({block: 'start'}); }
  finally { submit.disabled = false; }
 });
 wrap.replaceChildren(form);
 return wrap;
}

// ---- onboarding / application status ------------------------------------------------------------------------------------
export async function onboardingPage(ctx) {
 const {me} = ctx;
 const app = me.application;
 const wrap = h('div', {class: 'onboarding'});
 if (me.partner) {
  wrap.append(h('div', {class: 'state state-success'}, icon('check', 28), h('strong', {text: t('onb.approvedTitle')}), h('p', {text: t('onb.approvedBody', {code: me.partner.referralCode})}), h('a', {class: 'btn btn-primary', href: '/partners/dashboard', text: t('onb.goDashboard')})));
  return wrap;
 }
 if (!app) {
  wrap.append(emptyState(t('onb.noneTitle'), t('onb.noneBody'), h('a', {class: 'btn btn-primary', href: '/partners/register', text: t('landing.apply')})));
  return wrap;
 }
 const steps = ['pending', 'under_review', 'approved'];
 const stepIndex = {pending: 0, needs_information: 1, under_review: 1, approved: 2, rejected: 2}[app.status];
 wrap.append(h('ol', {class: 'progress', 'aria-label': t('onb.progress')}, steps.map((s, i) => h('li', {class: i < stepIndex ? 'done' : i === stepIndex ? 'current' : ''}, h('span', {class: 'dot'}, i < stepIndex ? icon('check', 14) : String(i + 1)), h('span', {text: t(`onb.step.${s}`)})))));
 wrap.append(h('div', {class: 'card status-card'}, h('div', {class: 'row-between'}, h('h2', {text: t('onb.title')}), badge(t(`appstatus.${app.status}`), app.status)), h('p', {class: 'muted', text: t(`onb.body.${app.status}`)}), h('p', {class: 'muted', text: t('onb.submittedAt', {date: date(app.createdAt, {time: true})})})));
 if (app.status === 'needs_information') {
  const form = h('form', {class: 'card'}, h('h3', {text: t('onb.infoRequested')}), h('blockquote', {text: app.infoRequest}), field(t('onb.yourReply'), textarea('response', {required: true, maxlength: 2000})), button(t('onb.sendReply'), {variant: 'primary', type: 'submit'}));
  form.addEventListener('submit', async event => {
   event.preventDefault();
   try { await api.post(`/api/partners/applications/${app.id}/respond`, {response: formData(form).response}); toast(t('onb.replySent'), 'success'); await ctx.reload(); ctx.navigate('/partners/onboarding', {replace: true}); } catch (error) { showFormError(form, error); }
  });
  wrap.append(form);
 }
 if (app.status === 'rejected') {
  wrap.append(h('div', {class: 'card'}, h('h3', {text: t('onb.rejectedReason')}), h('blockquote', {text: app.decisionReason || '—'}), h('a', {class: 'btn btn-primary', href: '/partners/register', text: t('onb.reapply')})));
 }
 if (!me.user.emailVerified) wrap.append(h('p', {class: 'notice', text: t('onb.verifyEmail', {email: me.user.email || ''})}));
 wrap.append(h('details', {class: 'card'}, h('summary', {text: t('onb.yourApplication')}), h('dl', {class: 'facts'}, [
  [t('app.fullName'), app.fullName], [t('app.phone'), app.phone], [t('app.country'), app.country], [t('app.company'), app.companyName || '—'], [t('app.website'), app.website || '—'],
  [t('app.partnerType'), t(`ptype.${app.partnerType}`)], [t('app.expectedCustomers'), num(app.expectedCustomers)], [t('app.marketingMethod'), app.marketingMethod]
 ].map(([k, v]) => h('div', null, h('dt', {text: k}), h('dd', {text: v}))))));
 return wrap;
}
