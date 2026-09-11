import {initI18n,onLocaleChange,getLocale,setLocale,t} from './i18n.js';
import {installShell,shellPage,shellData} from './components/layout/app-shell.js';
import {installWorkspace,renderWorkspace,beforeWorkspaceRender,workspaceAuth} from './pages/workspace.js';
import {toast,confirmAction} from './components/ui/index.js';
const $=selector=>document.querySelector(selector);
import {renderKnowledge,submitKnowledge} from './knowledge.js';
import {installPlanningFields,addContentActions,renderPlanning,submitPlanning} from './planning.js';
import {renderCRM,submitCRM,clickCRM,resetCRM,installCRMInteractions,crmSearch,applyStageChange} from './crm.js';
import {renderComplianceCheck,clickCompliance,resetCompliance} from './compliance.js';
import {renderAgents,submitAutonomy,submitAgentTest,renderFrostControl,clickFrost,renderApprovalCenter,clickApprovalCenter} from './autonomy.js';
import {renderReports,clickSaveReport,clickReportAction} from './reporting.js';
import {renderContent,enrichContentCards,installContentInteractions,beginGeneration,endGeneration} from './content.js';
import {renderMemory,installMemoryInteractions} from './memory.js';
import {renderIntegrations,installIntegrationInteractions,checkAllIntegrations} from './integrations.js';
import {renderTeam,installTeamInteractions,clickTeam} from './team.js';
import {resolveActiveWorkspace,renderWorkspaceGate,hideWorkspaceGate,renderWorkspaceSwitcher} from './components/workspace-switcher.js';
import {installControlCenter,renderControlCenter} from './pages/control-center.js';
// Action/status codes stay the real enum values everywhere (DB, audit rows, data-status
// attributes); only this lookup's *display* text is locale-aware, computed fresh on every
// access so a language switch relabels the whole audit trail with no other code touched.
const labels=new Proxy({},{get:(_,code)=>{const key='operationsLog.actions.'+code,value=t(key);return value===key?undefined:value;}});
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
await initI18n();
installPlanningFields();
installShell();
installWorkspace();
installControlCenter();
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
navLinks.forEach(a=>a.addEventListener('click',event=>{
  const page=a.getAttribute('href').slice(1);
  if(page==='users' && auth.user?.role!=='owner')return;
  event.preventDefault();
  if(location.hash!==a.getAttribute('href'))history.pushState(null,'',a.getAttribute('href'));
  showPage(page);
}));
window.addEventListener('popstate',()=>showPage(currentPage()));
window.addEventListener('hashchange',()=>showPage(currentPage()));
const roles=new Proxy({},{get:(_,role)=>t('navigation.role'+role.charAt(0).toUpperCase()+role.slice(1))});
let viewData=new Map();
async function api(path,body){const response=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':auth.csrf||''},body:JSON.stringify(body)}:{});const value=await response.json();if(!response.ok){if(response.status===401){$('#protected').hidden=true;$('#auth-panel').hidden=false;$('#session-bar').hidden=true;}throw new Error(value.error);}if(!body)viewData.set(path,value);return value;}
function message(text,type='info'){toast(text,type);}
// One confirmation layer for consequential button actions; existing handlers execute once after acceptance.
const confirmedButtons=new WeakSet();
document.addEventListener('click',async event=>{const b=event.target.closest('[data-approval-decide],[data-escalation-resolve],[data-cancel-content],[data-team-danger]');if(!b)return;if(confirmedButtons.has(b)){confirmedButtons.delete(b);return;}event.preventDefault();event.stopImmediatePropagation();if(await confirmAction(t('common.confirmActionTitle'),t('common.confirmActionBody'))){confirmedButtons.add(b);b.click();}},true);
async function render(){
  beforeWorkspaceRender();
  viewData=new Map();
  auth=await api('/api/auth');
  workspaceAuth(auth);
  $('#auth-panel').hidden=!!auth.user;
  $('#protected').hidden=!auth.user;
  $('#session-bar').hidden=!auth.user;
  $('#auth-title').textContent=auth.needsSetup?t('common.setupOwnerTitle'):t('common.loginTitle');
  $('#setup-name').hidden=!auth.needsSetup;
  $('#setup-name input').required=auth.needsSetup;
  $('#auth-form button').textContent=auth.needsSetup?t('common.createAccountAndStart'):t('common.login');
  shellData(auth,viewData,api);
  if(!auth.user)return;
  if(!accountLocaleApplied){accountLocaleApplied=true;if(auth.user.preferredLocale&&auth.user.preferredLocale!==getLocale()){await setLocale(auth.user.preferredLocale);return;}}
  // Phase 4C-1 — Workspace Selection. Resolved BEFORE anything tenant-scoped renders: a
  // multi-membership user with no active selection sees only the workspace-choice gate, never
  // a half-loaded dashboard (Part L). Single-membership users (the one real deployment today)
  // resolve here with zero visible change — `ready` is true on the very first check.
  const workspace=await resolveActiveWorkspace(auth.csrf);
  $('#protected').hidden=!workspace.ready;
  if(!workspace.ready){
    renderWorkspaceGate(workspace,auth.csrf,()=>render().catch(error=>message(error.message,'error')));
    return;
  }
  hideWorkspaceGate();
  await renderWorkspaceSwitcher(workspace.workspace,auth.csrf,()=>render().catch(error=>message(error.message,'error')));
  $('#session-name').textContent=`${auth.user.name} · ${roles[auth.user.role]}`;
  $('#draft').hidden=auth.user.role==='reviewer';
  $('#nav-users').hidden=auth.user.role!=='owner';
  showPage(currentPage());
  if(auth.user.role==='owner')await renderTeam({api});
  const state=await api('/api/state');
  $('#stats').innerHTML=[[t('content.draftsNeedReview'),state.content.filter(i=>i.status==='DRAFT').length],[t('content.waitingApproval'),state.content.filter(i=>i.status==='REVIEWED').length],[t('content.approvedContent'),state.content.filter(i=>i.status==='APPROVED').length]].map(([label,count])=>`<div class="stat"><span>${label}</span><strong>${count}</strong></div>`).join('');
  await renderFrostControl({api,auth,escape});
  await renderApprovalCenter({api,auth,escape});
  await renderAgents({api,auth,escape});
  $('#items').innerHTML=state.content.length?state.content.map(item=>`<article class="card"><div class="meta"><span>${escape(item.platform)} · ${escape(item.date)}</span><span class="pill" data-status="${escape(item.status)}">${labels[item.status]}</span></div><h3>${escape(item.title)}</h3><p>${escape(item.body)}</p><a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">${t('content.openStoreLink')}</a>${item.status==='DRAFT'?(auth.user.role!=='operator'?renderComplianceCheck(item,escape):'')+`<details><summary>${t('content.complianceReviewLog')}</summary><form data-id="${item.id}" data-action="review"><label>${t('content.reviewerName')}<input name="reviewer" required></label><label>${t('content.evidenceLabel')}<textarea name="evidence" required></textarea></label>${[['facts',t('content.checkFacts')],['claims',t('content.checkClaims')],['link',t('content.checkLink')]].map(([name,label])=>`<label class="check"><input type="checkbox" name="${name}" required>${label}</label>`).join('')}<button>${t('content.recordReview')}</button></form></details>`:item.status==='REVIEWED'?`<form data-id="${item.id}" data-action="approve"><p>${t('content.reviewerLabel')}: ${escape(item.review.reviewer)}</p><p>${escape(item.review.evidence)}</p><label>${t('content.approverName')}<input name="owner" required></label><button>${t('content.approveContent')}</button></form>`:`<p>${t('content.approvalSavedNote')}</p>`}</article>`).join(''):`<div class="empty">${t('content.noDraftsYet')}<br>${t('content.addFirstIdea')}</div>`;
  $('#items').querySelectorAll('form[data-action]').forEach(form=>{if((form.dataset.action==='review' && auth.user.role==='operator') || (form.dataset.action==='approve' && auth.user.role!=='owner'))form.closest('details')?form.closest('details').remove():form.remove();});
  $('#items').querySelectorAll('input[name="reviewer"],input[name="owner"]').forEach(input=>{input.value=auth.user.name;input.readOnly=true;});
  $('#audit-list').innerHTML=state.audit.length?state.audit.map(a=>`<div class="audit-row">${labels[a.action]||escape(a.action)} · ${escape(a.actorName||t('operationsLog.unattributedLegacyRecord'))}<time>${new Date(a.at).toLocaleString(getLocale()==='en'?'en-US':'ar-SA',{timeZone:'Asia/Riyadh'})}</time></div>`).join(''):t('operationsLog.noneRecordedYet');
  $('#items').querySelectorAll('article').forEach((card,index)=>{const item=state.content[index];if(item.englishCopy){const details=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('p');summary.textContent=t('content.generatedEnglishCopy');text.textContent=item.englishCopy;details.append(summary,text);card.append(details);}});
  enrichContentCards(state,escape);
  await renderKnowledge({api,auth,escape});
  await renderMemory({api,auth});
  await renderIntegrations({api});
  await renderControlCenter({api,auth});
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
  button.disabled=true;
  form.querySelector('.field-error')?.remove();
  if(form.dataset.autonomy||['approve','reject'].includes(form.dataset.action)){const accepted=await confirmAction(t('common.confirmActionGeneric'),t('common.confirmActionGenericBody'));if(!accepted){button.disabled=false;return;}}
  form.setAttribute('aria-busy','true');
  if(form.id==='ai-form')beginGeneration();
  try {const result=await submitCRM(form,input,api)||await submitPlanning(form,input,api)||await submitKnowledge(form,input,api)||await submitAutonomy(form,input,api)||await submitAgentTest(form,input,api);if(result){if(form.id==='memory-form')form.reset();await render();message(result);return;}if(form.dataset.action==='review') for(const key of ['facts','claims','link','asset'])input[key]=input[key]==='on';const path=form.id==='auth-form'?(auth.needsSetup?'/api/setup':'/api/login'):form.id==='user-form'?'/api/users':form.id==='draft'?'/api/content':`/api/content/${form.dataset.id}/${form.dataset.action}`;await api(path,input);form.reset();await render();message(t('common.savedSuccessfully'));}catch(error){const note=document.createElement('p');note.className='field-error';note.setAttribute('role','alert');note.textContent=error.message;button.before(note);message(error.message,'error');}finally{if(form.id==='ai-form')endGeneration();button.disabled=false;form.removeAttribute('aria-busy');}
});
$('#salla-sync').addEventListener('click',async event=>{event.target.disabled=true;try{const result=await api('/api/salla/sync',{});await render();message(t('common.importedProducts',{count:result.count}));}catch(error){message(error.message,'error');}finally{event.target.disabled=false;}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button)return;let path,input={};if(button.id==='save-brief')path='/api/brief';else if(button.id==='prepare-due')path='/api/schedule/prepare';else if(button.dataset.cancelContent){path='/api/schedule/cancel';input.contentId=button.dataset.cancelContent;}if(!path)return;button.disabled=true;try{const result=await api(path,input);await render();message(result.replayed?t('common.todayBundleAlreadySaved'):t('common.savedLocallySuccessfully'));}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
$('#save-report').addEventListener('click',async event=>{event.target.disabled=true;try{const text=await clickSaveReport(api);await render();message(text);}catch(error){message(error.message,'error');}finally{event.target.disabled=false;}});
document.addEventListener('click',async event=>{const target=event.target.closest('#report-refresh, #report-retry, #report-print, [data-report-nav], [data-view-saved]');if(!target)return;try{await clickReportAction(target,api,escape);}catch(error){message(error.message,'error');}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button||!['frost-pause','frost-resume','frost-run-now'].includes(button.id))return;button.disabled=true;try{const text=await clickFrost(button,api);await render();message(text);}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button||button.id!=='integrations-check-all')return;button.disabled=true;try{await checkAllIntegrations(api,message);await render();}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
document.addEventListener('click',async event=>{const button=event.target.closest('[data-team-action]');if(!button)return;button.disabled=true;try{const result=await clickTeam(button);if(result){await render();message(result);}}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
document.addEventListener('team-refresh',async event=>{try{await render();message(event.detail);}catch(error){message(error.message,'error');}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button||!(button.dataset.approvalDecide||button.dataset.escalationResolve))return;button.disabled=true;try{const text=await clickApprovalCenter(button,api);await render();message(text);}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
$('#logout').addEventListener('click',async()=>{try{await api('/api/logout',{});resetCRM();resetCompliance();await render();message(t('common.loggedOut'));}catch(error){message(error.message,'error');}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button||!button.dataset.complianceCheck)return;button.disabled=true;try{const result=await clickCompliance(button,api);await render();message(result);}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
document.addEventListener('click',async event=>{const button=event.target.closest('button,[data-open-lead],[data-crm-scroll]');if(!button||!(button.dataset.leadId||button.dataset.openLead||button.dataset.followupApprove||button.dataset.crmStop||button.id==='crm-prepare'||button.id==='crm-run-frost'||button.dataset.followupTab||button.dataset.inboxTab||button.dataset.quickAction))return;if(button.tagName==='BUTTON')button.disabled=true;try{const result=await clickCRM(button,api);if(result){await render();message(result);}}catch(error){message(error.message,'error');}finally{if(button.tagName==='BUTTON')button.disabled=false;}});
let crmSearchTimer=null;
document.addEventListener('input',event=>{if(event.target.id!=='crm-search')return;clearTimeout(crmSearchTimer);const query=event.target.value;crmSearchTimer=setTimeout(()=>crmSearch(query,api,escape).catch(error=>message(error.message)),300);});
window.addEventListener('crm-stage-drop',async event=>{try{await applyStageChange(event.detail,api);await render();message(t('common.stageUpdated'));}catch(error){message(error.message,'error');}});
onLocaleChange(()=>render().catch(error=>message(error.message)));
render().catch(error=>message(error.message));
