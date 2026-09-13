import {initI18n,onLocaleChange,getLocale,setLocale,t} from './i18n.js';
import {installShell,shellPage,shellData} from './components/layout/app-shell.js';
import {installWorkspace,renderWorkspace,beforeWorkspaceRender,workspaceAuth} from './pages/workspace.js';
import {toast,confirmAction,button} from './components/ui/index.js';
const $=selector=>document.querySelector(selector);
import {renderKnowledge,submitKnowledge} from './knowledge.js';
import {installPlanningFields,addContentActions,renderPlanning,submitPlanning} from './planning.js';
import {renderCRM,submitCRM,clickCRM,resetCRM,installCRMInteractions,crmSearch,applyStageChange} from './crm.js';
import {renderComplianceCheck,clickCompliance,resetCompliance} from './compliance.js';
import {renderAgents,submitAutonomy,submitAgentTest,renderFrostControl,clickFrost,renderApprovalCenter,clickApprovalCenter} from './autonomy.js';
import {renderReports,clickSaveReport,clickReportAction,changeReportAction} from './reporting.js';
import {renderContent,enrichContentCards,installContentInteractions,beginGeneration,endGeneration} from './content.js';
import {renderMemory,installMemoryInteractions} from './memory.js';
import {renderIntegrations,installIntegrationInteractions,checkAllIntegrations} from './integrations.js';
import {renderTeam,installTeamInteractions,clickTeam} from './team.js';
import {resolveActiveWorkspace,renderWorkspaceGate,hideWorkspaceGate,renderWorkspaceSwitcher} from './components/workspace-switcher.js';
import {installControlCenter,renderControlCenter} from './pages/control-center.js';
import {installOnboardingPage,renderOnboardingPage} from './pages/onboarding.js';
import {installAccountPage,renderAccountPage} from './pages/account.js';
import {isRecoveryRoute,installRecoveryPage,renderRecoveryPage} from './pages/recovery.js';
import {isNewWorkspaceRoute,installNewWorkspacePage,renderNewWorkspacePage} from './pages/new-workspace.js';
import {installPlatformPage,renderPlatformPage} from './pages/platform.js';
import {isInviteRoute,renderInvitePage} from './pages/invite.js';
// Action/status codes stay the real enum values everywhere (DB, audit rows, data-status
// attributes); only this lookup's *display* text is locale-aware, computed fresh on every
// access so a language switch relabels the whole audit trail with no other code touched.
const labels=new Proxy({},{get:(_,code)=>{const key='operationsLog.actions.'+code,value=t(key);return value===key?undefined:value;}});
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
await initI18n();
function translateAuthExperience(){
 document.querySelectorAll('[data-auth-copy]').forEach(el=>{el.textContent=t('common.authExperience.'+el.dataset.authCopy);});
 $('#auth-language').textContent=getLocale()==='ar'?'English':'العربية';
 document.querySelectorAll('[data-auth-go]').forEach(el=>el.setAttribute('aria-label',t('common.authExperience.banner'+el.dataset.authGo)));
}
translateAuthExperience();
onLocaleChange(translateAuthExperience);
$('#auth-language').addEventListener('click',()=>setLocale(getLocale()==='ar'?'en':'ar'));
document.querySelectorAll('[data-auth-go]').forEach(control=>control.addEventListener('click',()=>{
 document.querySelectorAll('[data-auth-slide]').forEach(slide=>{slide.hidden=slide.dataset.authSlide!==control.dataset.authGo;});
 document.querySelectorAll('[data-auth-go]').forEach(el=>el.setAttribute('aria-pressed',String(el===control)));
}));
installPlanningFields();
installShell();
installWorkspace();
installControlCenter();
installOnboardingPage();
installAccountPage();
installRecoveryPage();
installNewWorkspacePage();
installPlatformPage();
installCRMInteractions();
installContentInteractions();
installMemoryInteractions();
installIntegrationInteractions();
installTeamInteractions();
const navLinks=[...document.querySelectorAll('nav a')];
const pages=[...document.querySelectorAll('[data-page]')].map(el=>el.dataset.page);
let auth={};
let accountLocaleApplied=false;
function currentPage(){
  const id=location.hash.slice(1);
  if(id==='users' && auth.user?.role!=='owner')return 'overview';
  return pages.includes(id)?id:'overview';
}
function showPage(page){
  shellPage(page);
  document.querySelectorAll('[data-page]').forEach(el=>{el.hidden=el.dataset.page!==page;});
  navLinks.forEach(a=>a.classList.toggle('active',a.getAttribute('href')==='#'+page));
  window.scrollTo(0,0);
}
// Item 17 — this app's nav links only ever toggled DOM visibility; they never refetched a
// page's own data, so publishing a new connector in the Integration Builder and then clicking
// straight to Control Center → Integrations (same tab, no reload) showed stale data until the
// next full login/render(). Real, but small and targeted: only these two pages currently have
// a "did something change elsewhere" problem worth solving this way — every other page already
// gets a fresh render() on login, and neither `renderControlCenter` nor `renderPlatformPage`
// needs this treatment to stay correct (both already guard reentrancy with their own
// `renderGeneration`/staleGuard, so calling either again here is always safe, never a race).
function refetchPageIfNeeded(page){
  if(page==='control-center')renderControlCenter({api,auth}).catch(error=>message(error.message,'error'));
  else if(page==='platform')renderPlatformPage({api,auth}).catch(error=>message(error.message,'error'));
}
navLinks.forEach(a=>a.addEventListener('click',event=>{
  const page=a.getAttribute('href').slice(1);
  if(page==='users' && auth.user?.role!=='owner')return;
  event.preventDefault();
  if(location.hash!==a.getAttribute('href'))history.pushState(null,'',a.getAttribute('href'));
  showPage(page);
  refetchPageIfNeeded(page);
}));
window.addEventListener('popstate',()=>{const page=currentPage();showPage(page);refetchPageIfNeeded(page);});
// The "Integration Builder" sidebar entry shares #platform's real route (never a second page,
// see app-shell.js's `data-route-key`) but should visibly land the admin ON the Builder
// section, not wherever the page happened to scroll before.
document.getElementById('nav-integration-builder')?.addEventListener('click',()=>{
  setTimeout(()=>document.getElementById('pf-connectors')?.scrollIntoView({behavior:'smooth',block:'start'}),80);
});
// A same-tab navigation INTO or OUT OF the standalone recovery/invite flows (e.g. clicking
// "Forgot password?" from the login screen) needs a full `render()` cycle, not just
// `showPage()` — those flows force auth-panel/protected/session-bar hidden directly (see
// pages/recovery.js), and only `render()` re-evaluates the route and restores normal
// visibility. Leaving them (their own "back to app" actions) uses a full page reload instead,
// so this only needs to handle the "entering" direction.
window.addEventListener('hashchange',()=>{
  if(isInviteRoute()||isRecoveryRoute()||isNewWorkspaceRoute())render().catch(error=>message(error.message,'error'));
  else {const page=currentPage();showPage(page);refetchPageIfNeeded(page);}
});
const roles=new Proxy({},{get:(_,role)=>t('navigation.role'+role.charAt(0).toUpperCase()+role.slice(1))});
let viewData=new Map();
// `method` (Phase 4C-2/4C-3 addition): optional HTTP method override for the routes that are
// genuinely PATCH/PUT/DELETE on the backend (agent config, tool assignment, connection
// credential, member management) — every pre-existing call site that omits it keeps its exact
// original behavior (GET with no body, POST with one), byte-for-byte unchanged.
async function api(path,body,method){const hasBody=body!==undefined&&body!==null;const response=await fetch(path,method||hasBody?{method:method||'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':auth.csrf||''},...(hasBody?{body:JSON.stringify(body)}:{})}:{});const value=await response.json();if(!response.ok){if(response.status===401){$('#protected').hidden=true;$('#auth-panel').hidden=false;$('#session-bar').hidden=true;}throw new Error(value.error);}if(!body)viewData.set(path,value);return value;}
function message(text,type='info'){toast(text,type);}
// One confirmation layer for consequential button actions; existing handlers execute once after acceptance.
const confirmedButtons=new WeakSet();
document.addEventListener('click',async event=>{const b=event.target.closest('[data-approval-decide],[data-escalation-resolve],[data-cancel-content],[data-team-danger]');if(!b)return;if(confirmedButtons.has(b)){confirmedButtons.delete(b);return;}event.preventDefault();event.stopImmediatePropagation();if(await confirmAction(t('common.confirmActionTitle'),t('common.confirmActionBody'))){confirmedButtons.add(b);b.click();}},true);
// Phase 4C-5 (Part 47/69) — a non-blocking, dismissible notice for a legacy account with no
// email at all yet. Never shown once an email exists (verified OR merely pending — the user
// has already taken the action this banner exists to prompt). Dismissal is per-browser-tab
// only (sessionStorage, not persisted server-side) so it never nags again this session but
// still reappears on the next real login, matching "not every page, but don't hide it either".
function renderEmailBanner(auth){
  const banner=$('#email-banner');
  let dismissed=false;
  try{dismissed=sessionStorage.getItem('hc_email_banner_dismissed')==='1';}catch{}
  if(!auth.user || dismissed || auth.user.email || auth.user.pendingEmail){banner.hidden=true;return;}
  banner.hidden=false;
  banner.innerHTML=`<span>${escape(t('account.banner.text'))}</span>`;
  const go=button(t('account.banner.action'),{variant:'primary'});
  go.onclick=()=>{location.hash='#account';};
  const dismiss=button(t('account.banner.dismiss'),{variant:'ghost'});
  dismiss.onclick=()=>{try{sessionStorage.setItem('hc_email_banner_dismissed','1');}catch{}banner.hidden=true;};
  banner.append(go,dismiss);
}
async function render(){
  beforeWorkspaceRender();
  viewData=new Map();
  auth=await api('/api/auth');
  // Phase 4C-3 — the invitation-accept page lives OUTSIDE the normal auth-gated flow (an
  // invitee may have no session at all yet): handled first, short-circuiting the rest of
  // this render entirely, whether or not the visitor is currently authenticated.
  if(isInviteRoute()){await renderInvitePage(auth,api);return;}
  // Phase 4C-5 — email verification / forgot-password / reset-password: same
  // outside-the-auth-gate rationale as the invitation page above (a visitor may have no
  // session at all, or an expired one, or be on a different device than where they're
  // logged in).
  if(isRecoveryRoute()){await renderRecoveryPage();return;}
  // Multi-Tenant Phase 4C-6 — Create Workspace deliberately lives OUTSIDE the normal
  // `workspace.ready` gate below: the very case it exists for is "no workspace is ready yet"
  // (Part 8), and an already-established user may also reach it later for a SECOND workspace
  // (Part 48). Requires a real session, though — an unauthenticated visitor on this hash just
  // falls through to the ordinary login screen.
  if(isNewWorkspaceRoute() && auth.user){await renderNewWorkspacePage(auth,api);return;}
  workspaceAuth(auth);
  $('#auth-panel').hidden=!!auth.user;
  $('#email-banner').hidden=true;
  $('#auth-panel').classList.remove('is-signup');
  $('#protected').hidden=!auth.user;
  $('#session-bar').hidden=!auth.user;
  $('#auth-title').textContent=auth.needsSetup?t('common.setupOwnerTitle'):t('common.loginTitle');
  $('#setup-name').hidden=!auth.needsSetup;
  $('#setup-name input').required=auth.needsSetup;
  $('#auth-form button').textContent=auth.needsSetup?t('common.createAccountAndStart'):t('common.login');
  // The public-signup toggle only makes sense once the platform's very first owner already
  // exists — during needsSetup, `#auth-form` itself IS that one-time setup flow.
  $('#show-signup-link').hidden=auth.needsSetup||!!auth.user;
  // Every render() while logged out resets to the DEFAULT login view — a plain toggle click
  // (see the two listeners below) never itself calls render(), so this only ever runs again
  // after something else already ended that toggle's context (a real submit, a fresh page
  // load, a locale switch); starting over at login each time is correct, not a loss of state.
  // (A real bug this phase's own regression testing found: gating this reset behind
  // `auth.needsSetup||auth.user` left BOTH forms stuck hidden after a later logout, since
  // neither condition holds true then — see docs/SAAS_ENTRY_FLOW.md.)
  if(!auth.user){$('#signup-form').hidden=true;$('#show-login-link').hidden=true;$('#auth-form').hidden=false;$('#forgot-password-link').hidden=false;}
  shellData(auth,viewData,api);
  // Submit only after the handlers and the initial authentication state are ready.
  $('#auth-form button').disabled=false;
  $('#signup-form button').disabled=false;
  if(!auth.user)return;
  if(!accountLocaleApplied){accountLocaleApplied=true;if(auth.user.preferredLocale&&auth.user.preferredLocale!==getLocale()){await setLocale(auth.user.preferredLocale);return;}}
  // Phase 4C-1 — Workspace Selection. Resolved BEFORE anything tenant-scoped renders: a
  // multi-membership user with no active selection sees only the workspace-choice gate, never
  // a half-loaded dashboard (Part L). Single-membership users (the one real deployment today)
  // resolve here with zero visible change — `ready` is true on the very first check.
  const workspace=await resolveActiveWorkspace(auth.csrf);
  // A real, pre-existing gap this phase's own testing found: Account Settings and the
  // Platform Admin dashboard both live inside `#protected` in the DOM, which the workspace
  // gate hides entirely — so the gate's own "Go to Account Settings" button (and a platform
  // admin who happens to have zero workspaces of their own) led to a page that never actually
  // became visible. Both pages are legitimately workspace-INDEPENDENT (personal identity;
  // cross-tenant platform authority), so a zero-workspace session viewing exactly one of
  // those two hashes gets the real page instead of the gate, keeping the rest of the app
  // shell reachable — everything ELSE that genuinely needs a resolved tenant is skipped below.
  // 'platform' only counts as workspace-independent for an ACTUAL platform admin — otherwise a
  // stale '#platform' hash (left over from a previous session/tab, or a direct URL guess) would
  // wrongly skip the workspace gate for an ordinary user who has zero ready workspaces, leaving
  // them stuck on a page they have no authority to view instead of the real selection/creation
  // prompt (a real bug this phase's own suspend/reactivate journey testing surfaced).
  const page=currentPage();
  const viewingWorkspaceIndependentPage=page==='account'||(page==='platform'&&auth.isPlatformAdmin);
  $('#protected').hidden=!workspace.ready && !viewingWorkspaceIndependentPage;
  if(!workspace.ready && !viewingWorkspaceIndependentPage){
    renderWorkspaceGate(workspace,auth.csrf,()=>render().catch(error=>message(error.message,'error')),auth.user);
    return;
  }
  hideWorkspaceGate();
  if(!workspace.ready){
    showPage(currentPage());
    await renderAccountPage({api,auth});
    await renderPlatformPage({api,auth});
    return;
  }
  await renderWorkspaceSwitcher(workspace.workspace,auth.csrf,()=>render().catch(error=>message(error.message,'error')));
  $('#session-name').textContent=`${auth.user.name} · ${roles[auth.user.role]}`;
  $('#draft').hidden=auth.user.role==='reviewer';
  $('#nav-users').hidden=auth.user.role!=='owner';
  renderEmailBanner(auth);
  await renderAccountPage({api,auth});
  showPage(currentPage());
  if(auth.user.role==='owner')await renderTeam({api});
  const state=await api('/api/state');
  $('#stats').innerHTML=[[t('content.draftsNeedReview'),state.content.filter(i=>i.status==='DRAFT').length],[t('content.waitingApproval'),state.content.filter(i=>i.status==='REVIEWED').length],[t('content.approvedContent'),state.content.filter(i=>i.status==='APPROVED').length]].map(([label,count])=>`<div class="stat"><span>${label}</span><strong>${count}</strong></div>`).join('');
  await renderFrostControl({api,auth,escape});
  await renderApprovalCenter({api,auth,escape});
  await renderAgents({api,auth,escape});
  $('#items').innerHTML=state.content.length?state.content.map(item=>`<article class="card"><div class="meta"><span>${escape(item.platform)} · ${escape(item.date)}</span><span class="pill" data-status="${escape(item.status)}">${labels[item.status]}</span></div><h3>${escape(item.title)}</h3>${item.assetUrl?`<img class="content-asset-preview" src="${escape(item.assetUrl)}" alt="${escape(t('content.designPreviewAlt'))}" loading="lazy">`:''}<p>${escape(item.body)}</p><a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">${t('content.openStoreLink')}</a>${item.status==='DRAFT'?(auth.user.role!=='operator'?renderComplianceCheck(item,escape):'')+`<details><summary>${t('content.complianceReviewLog')}</summary><form data-id="${item.id}" data-action="review"><label>${t('content.reviewerName')}<input name="reviewer" required></label><label>${t('content.evidenceLabel')}<textarea name="evidence" required></textarea></label>${[['facts',t('content.checkFacts')],['claims',t('content.checkClaims')],['link',t('content.checkLink')]].map(([name,label])=>`<label class="check"><input type="checkbox" name="${name}" required>${label}</label>`).join('')}<button>${t('content.recordReview')}</button></form></details>`:item.status==='REVIEWED'?`<form data-id="${item.id}" data-action="approve"><p>${t('content.reviewerLabel')}: ${escape(item.review.reviewer)}</p><p>${escape(item.review.evidence)}</p><label>${t('content.approverName')}<input name="owner" required></label><button>${t('content.approveContent')}</button></form>`:`<p>${t('content.approvalSavedNote')}</p>`}</article>`).join(''):`<div class="empty">${t('content.noDraftsYet')}<br>${t('content.addFirstIdea')}</div>`;
  $('#items').querySelectorAll('form[data-action]').forEach(form=>{if((form.dataset.action==='review' && auth.user.role==='operator') || (form.dataset.action==='approve' && auth.user.role!=='owner'))form.closest('details')?form.closest('details').remove():form.remove();});
  $('#items').querySelectorAll('input[name="reviewer"],input[name="owner"]').forEach(input=>{input.value=auth.user.name;input.readOnly=true;});
  $('#audit-list').innerHTML=state.audit.length?state.audit.map(a=>`<div class="audit-row">${labels[a.action]||escape(a.action)} · ${escape(a.actorName||t('operationsLog.unattributedLegacyRecord'))}<time>${new Date(a.at).toLocaleString(getLocale()==='en'?'en-US':'ar-SA',{timeZone:'Asia/Riyadh'})}</time></div>`).join(''):t('operationsLog.noneRecordedYet');
  $('#items').querySelectorAll('article').forEach((card,index)=>{const item=state.content[index];if(item.englishCopy){const details=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('p');summary.textContent=t('content.generatedEnglishCopy');text.textContent=item.englishCopy;details.append(summary,text);card.append(details);}});
  enrichContentCards(state,escape);
  await renderKnowledge({api,auth,escape});
  await renderMemory({api,auth});
  await renderIntegrations({api});
  await renderControlCenter({api,auth});
  await renderPlatformPage({api,auth});
  await renderOnboardingPage({api,auth});
  $('#items').querySelectorAll(':scope > article').forEach((card,index)=>addContentActions(card,state.content[index],auth,escape));
  await renderPlanning({api,auth,state,escape});
  await renderCRM({api,auth,escape});
  await renderContent({api,auth,escape});
  $('#save-report').hidden=auth.user.role!=='owner';
  await renderReports({api,escape});
  renderWorkspace(viewData,auth,api,labels);
  shellData(auth,viewData,api);
}
document.addEventListener('submit',async event=>{
  event.preventDefault();const form=event.target;const submitter=event.submitter;const button=submitter&&submitter.form===form?submitter:form.querySelector('button');if(!button)return;
  // FormData must be built before disabling the submitter — a disabled form control (the
  // button itself, once we disable it below) is excluded from its own form's data set.
  const input=Object.fromEntries(new FormData(form,submitter&&submitter.form===form?submitter:undefined));
  // Multi-Tenant Phase 4C-6 — client-side-only guard (the backend never receives or checks
  // `confirmPassword` at all); a real mismatch is still just a normal, correctable form error.
  if(form.id==='signup-form') {
    if(input.password!==input.confirmPassword){const note=document.createElement('p');note.className='field-error';note.setAttribute('role','alert');note.textContent=t('common.passwordsDontMatch');button.before(note);return;}
    delete input.confirmPassword;
  }
  button.disabled=true;
  form.querySelector('.field-error')?.remove();
  if(form.dataset.autonomy||['approve','reject'].includes(form.dataset.action)){const accepted=await confirmAction(t('common.confirmActionGeneric'),t('common.confirmActionGenericBody'));if(!accepted){button.disabled=false;return;}}
  form.setAttribute('aria-busy','true');
  if(form.id==='ai-form')beginGeneration();
  try {const result=await submitCRM(form,input,api)||await submitPlanning(form,input,api)||await submitKnowledge(form,input,api)||await submitAutonomy(form,input,api)||await submitAgentTest(form,input,api);if(result){if(form.id==='memory-form')form.reset();await render();message(result);return;}if(form.dataset.action==='review') for(const key of ['facts','claims','link','asset'])input[key]=input[key]==='on';const path=form.id==='auth-form'?(auth.needsSetup?'/api/setup':'/api/login'):form.id==='signup-form'?'/api/signup':form.id==='user-form'?'/api/users':form.id==='draft'?'/api/content':`/api/content/${form.dataset.id}/${form.dataset.action}`;await api(path,input);form.reset();await render();message(t('common.savedSuccessfully'));}catch(error){const note=document.createElement('p');note.className='field-error';note.setAttribute('role','alert');note.textContent=error.message;button.before(note);message(error.message,'error');}finally{if(form.id==='ai-form')endGeneration();button.disabled=false;form.removeAttribute('aria-busy');}
});
$('#salla-sync').addEventListener('click',async event=>{event.target.disabled=true;try{const result=await api('/api/salla/sync',{});await render();message(t('common.importedProducts',{count:result.count}));}catch(error){message(error.message,'error');}finally{event.target.disabled=false;}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button)return;let path,input={};if(button.id==='save-brief')path='/api/brief';else if(button.id==='prepare-due')path='/api/schedule/prepare';else if(button.dataset.cancelContent){path='/api/schedule/cancel';input.contentId=button.dataset.cancelContent;}if(!path)return;button.disabled=true;try{const result=await api(path,input);await render();message(result.replayed?t('common.todayBundleAlreadySaved'):t('common.savedLocallySuccessfully'));}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
$('#save-report').addEventListener('click',async event=>{event.target.disabled=true;try{const text=await clickSaveReport(api);await render();message(text);}catch(error){message(error.message,'error');}finally{event.target.disabled=false;}});
document.addEventListener('click',async event=>{const target=event.target.closest('#report-refresh, #report-retry, #report-print, #report-export-xlsx, #report-export-pdf, [data-report-nav], [data-view-saved]');if(!target)return;try{await clickReportAction(target,api,escape);}catch(error){message(error.message,'error');}});
document.addEventListener('change',async event=>{const target=event.target.closest('#report-week-select');if(!target)return;try{await changeReportAction(target,api,escape);}catch(error){message(error.message,'error');}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button||!['frost-pause','frost-resume','frost-run-now'].includes(button.id))return;button.disabled=true;try{const text=await clickFrost(button,api);await render();message(text);}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button||button.id!=='integrations-check-all')return;button.disabled=true;try{await checkAllIntegrations(api,message);await render();}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
document.addEventListener('click',async event=>{const button=event.target.closest('[data-team-action]');if(!button)return;button.disabled=true;try{const result=await clickTeam(button);if(result){await render();message(result);}}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
document.addEventListener('team-refresh',async event=>{try{await render();message(event.detail);}catch(error){message(error.message,'error');}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button||!(button.dataset.approvalDecide||button.dataset.escalationResolve))return;button.disabled=true;try{const text=await clickApprovalCenter(button,api);await render();message(text);}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
$('#logout').addEventListener('click',async()=>{try{await api('/api/logout',{});resetCRM();resetCompliance();await render();message(t('common.loggedOut'));}catch(error){message(error.message,'error');}});
// Multi-Tenant Phase 4C-6 (Part 42/43) — a plain show/hide toggle between the login and
// public signup forms on the same auth screen; no route/hash change, so it works even before
// initI18n's very first render() has resolved anything about the visitor.
$('#show-signup-link').addEventListener('click',()=>{$('#auth-panel').classList.add('is-signup');$('#auth-form').hidden=true;$('#forgot-password-link').hidden=true;$('#show-signup-link').hidden=true;$('#signup-form').hidden=false;$('#show-login-link').hidden=false;});
$('#show-login-link').addEventListener('click',()=>{$('#auth-panel').classList.remove('is-signup');$('#signup-form').hidden=true;$('#show-login-link').hidden=true;$('#auth-form').hidden=false;$('#forgot-password-link').hidden=false;$('#show-signup-link').hidden=false;});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button||!button.dataset.complianceCheck)return;button.disabled=true;try{const result=await clickCompliance(button,api);await render();message(result);}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
document.addEventListener('click',async event=>{const button=event.target.closest('button,[data-open-lead],[data-crm-scroll]');if(!button||!(button.dataset.leadId||button.dataset.openLead||button.dataset.followupApprove||button.dataset.crmStop||button.id==='crm-prepare'||button.id==='crm-run-frost'||button.dataset.followupTab||button.dataset.inboxTab||button.dataset.quickAction))return;if(button.tagName==='BUTTON')button.disabled=true;try{const result=await clickCRM(button,api);if(result){await render();message(result);}}catch(error){message(error.message,'error');}finally{if(button.tagName==='BUTTON')button.disabled=false;}});
let crmSearchTimer=null;
document.addEventListener('input',event=>{if(event.target.id!=='crm-search')return;clearTimeout(crmSearchTimer);const query=event.target.value;crmSearchTimer=setTimeout(()=>crmSearch(query,api,escape).catch(error=>message(error.message)),300);});
window.addEventListener('crm-stage-drop',async event=>{try{await applyStageChange(event.detail,api);await render();message(t('common.stageUpdated'));}catch(error){message(error.message,'error');}});
onLocaleChange(()=>render().catch(error=>message(error.message)));
render().catch(error=>message(error.message));
