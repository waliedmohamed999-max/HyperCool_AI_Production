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
const labels={DRAFT:'مسودة',REVIEWED:'تمت المراجعة',APPROVED:'معتمد · غير منشور',DRAFT_CREATED:'إنشاء مسودة',COMPLIANCE_REVIEWED:'تسجيل مراجعة الامتثال',OWNER_APPROVED:'اعتماد المالك',AI_DRAFT_CREATED:'إنشاء مسودة بالذكاء الاصطناعي',MEMORY_VERSION_SAVED:'حفظ إصدار ذاكرة',SALLA_CATALOG_SYNCED:'تحديث كتالوج سلة',SALLA_CATALOG_SYNC_FAILED:'فشل تحديث كتالوج سلة'};
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
Object.assign(labels,{REJECTED:'مرفوض',SUPERSEDED:'نسخة سابقة',CONTENT_REVISED:'إنشاء نسخة معدلة',CONTENT_REJECTED:'رفض محتوى',CALENDAR_CREATED:'إنشاء تقويم',CONTENT_SCHEDULED:'جدولة محتوى',SCHEDULE_CANCELLED:'إلغاء جدولة',SCHEDULE_PREPARED:'تجهيز موعد مستحق',SCHEDULE_BLOCKED:'إيقاف جدولة',DAILY_BRIEF_CREATED:'حفظ حزمة يومية'});
installPlanningFields();
installShell();
installWorkspace();
installCRMInteractions();
installContentInteractions();
installMemoryInteractions();
installIntegrationInteractions();
installTeamInteractions();
Object.assign(labels,{CRM_LEAD_CREATED:'إنشاء سجل عميل',CRM_LEAD_UPDATED:'تحديث تأهيل فرصة',CRM_INBOUND_RECORDED:'تسجيل محادثة واردة',CRM_CONTACT_POLICY_CHANGED:'تحديث موافقة التواصل',CRM_FOLLOWUPS_DRAFTED:'تجهيز متابعات',CRM_FOLLOWUP_APPROVED:'اعتماد متابعة',CRM_FOLLOWUP_PREPARED:'تجهيز متابعة مستحقة',CRM_FOLLOWUPS_STOPPED:'إيقاف متابعات'});
Object.assign(labels,{AI_COMPLIANCE_CHECKED:'فحص امتثال آلي (مساعد)',AGENT_PROMOTED:'ترقية مستوى صلاحية وكيل',AGENT_DEMOTED:'خفض مستوى صلاحية وكيل',WEEKLY_REPORT_CREATED:'حفظ تقرير أسبوعي'});
const navLinks=[...document.querySelectorAll('nav a')];
const pages=[...document.querySelectorAll('[data-page]')].map(el=>el.dataset.page);
let auth={};
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
const roles={owner:'مالك',reviewer:'مراجع',operator:'مشغل'};
let viewData=new Map();
async function api(path,body){const response=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':auth.csrf||''},body:JSON.stringify(body)}:{});const value=await response.json();if(!response.ok){if(response.status===401){$('#protected').hidden=true;$('#auth-panel').hidden=false;$('#session-bar').hidden=true;}throw new Error(value.error);}if(!body)viewData.set(path,value);return value;}
function message(text,type='info'){toast(text,type);}
// One confirmation layer for consequential button actions; existing handlers execute once after acceptance.
const confirmedButtons=new WeakSet();
document.addEventListener('click',async event=>{const b=event.target.closest('[data-approval-decide],[data-escalation-resolve],[data-cancel-content],[data-team-danger]');if(!b)return;if(confirmedButtons.has(b)){confirmedButtons.delete(b);return;}event.preventDefault();event.stopImmediatePropagation();if(await confirmAction('تأكيد القرار','سيُحفظ هذا الإجراء باسم حسابك. راجع التفاصيل قبل المتابعة.')){confirmedButtons.add(b);b.click();}},true);
async function render(){
  beforeWorkspaceRender();
  viewData=new Map();
  auth=await api('/api/auth');
  workspaceAuth(auth);
  $('#auth-panel').hidden=!!auth.user;
  $('#protected').hidden=!auth.user;
  $('#session-bar').hidden=!auth.user;
  $('#auth-title').textContent=auth.needsSetup?'إنشاء حساب المالك لأول مرة':'تسجيل الدخول';
  $('#setup-name').hidden=!auth.needsSetup;
  $('#setup-name input').required=auth.needsSetup;
  $('#auth-form button').textContent=auth.needsSetup?'إنشاء الحساب والبدء':'دخول';
  shellData(auth,viewData,api);
  if(!auth.user)return;
  $('#session-name').textContent=`${auth.user.name} · ${roles[auth.user.role]}`;
  $('#draft').hidden=auth.user.role==='reviewer';
  $('#nav-users').hidden=auth.user.role!=='owner';
  showPage(currentPage());
  if(auth.user.role==='owner')await renderTeam({api});
  const state=await api('/api/state');
  $('#stats').innerHTML=[['مسودات تحتاج مراجعة',state.content.filter(i=>i.status==='DRAFT').length],['بانتظار الاعتماد',state.content.filter(i=>i.status==='REVIEWED').length],['محتوى معتمد',state.content.filter(i=>i.status==='APPROVED').length]].map(([label,count])=>`<div class="stat"><span>${label}</span><strong>${count}</strong></div>`).join('');
  await renderFrostControl({api,auth,escape});
  await renderApprovalCenter({api,auth,escape});
  await renderAgents({api,auth,escape});
  $('#items').innerHTML=state.content.length?state.content.map(item=>`<article class="card"><div class="meta"><span>${escape(item.platform)} · ${escape(item.date)}</span><span class="pill" data-status="${escape(item.status)}">${labels[item.status]}</span></div><h3>${escape(item.title)}</h3><p>${escape(item.body)}</p><a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">فتح رابط المتجر ↗</a>${item.status==='DRAFT'?(auth.user.role!=='operator'?renderComplianceCheck(item,escape):'')+`<details><summary>تسجيل مراجعة الامتثال</summary><form data-id="${item.id}" data-action="review"><label>اسم المراجع<input name="reviewer" required></label><label>مصادر التحقق وملاحظات المراجعة<textarea name="evidence" required></textarea></label>${[['facts','تحققت من الأسعار والمواصفات المذكورة'],['claims','راجعت الادعاءات مقابل المعلومات المعتمدة'],['link','فتحت الرابط وتأكدت من صحته']].map(([name,label])=>`<label class="check"><input type="checkbox" name="${name}" required>${label}</label>`).join('')}<button>تسجيل المراجعة</button></form></details>`:item.status==='REVIEWED'?`<form data-id="${item.id}" data-action="approve"><p>المراجع: ${escape(item.review.reviewer)}</p><p>${escape(item.review.evidence)}</p><label>اسم صاحب الاعتماد<input name="owner" required></label><button>اعتماد المحتوى</button></form>`:'<p>تم حفظ الاعتماد. النشر ينتظر ربط المنصة وتفعيل الصلاحيات.</p>'}</article>`).join(''):'<div class="empty">لا توجد مسودات بعد.<br>أضف أول فكرة لبدء مسار المراجعة والاعتماد.</div>';
  $('#items').querySelectorAll('form[data-action]').forEach(form=>{if((form.dataset.action==='review' && auth.user.role==='operator') || (form.dataset.action==='approve' && auth.user.role!=='owner'))form.closest('details')?form.closest('details').remove():form.remove();});
  $('#items').querySelectorAll('input[name="reviewer"],input[name="owner"]').forEach(input=>{input.value=auth.user.name;input.readOnly=true;});
  $('#audit-list').innerHTML=state.audit.length?state.audit.map(a=>`<div class="audit-row">${labels[a.action]||escape(a.action)} · ${escape(a.actorName||'سجل قديم غير موثق بحساب')}<time>${new Date(a.at).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'})}</time></div>`).join(''):'لا توجد عمليات مسجلة بعد.';
  $('#items').querySelectorAll('article').forEach((card,index)=>{const item=state.content[index];if(item.englishCopy){const details=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('p');summary.textContent='النص الإنجليزي المولّد';text.textContent=item.englishCopy;details.append(summary,text);card.append(details);}});
  enrichContentCards(state,escape);
  await renderKnowledge({api,auth,escape});
  await renderMemory({api,auth});
  await renderIntegrations({api});
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
  if(form.dataset.autonomy||['approve','reject'].includes(form.dataset.action)){const accepted=await confirmAction('تأكيد الإجراء','سيُحفظ هذا القرار باسمك في سجل العمليات. هل تريد المتابعة؟');if(!accepted){button.disabled=false;return;}}
  form.setAttribute('aria-busy','true');
  if(form.id==='ai-form')beginGeneration();
  try {const result=await submitCRM(form,input,api)||await submitPlanning(form,input,api)||await submitKnowledge(form,input,api)||await submitAutonomy(form,input,api)||await submitAgentTest(form,input,api);if(result){if(form.id==='memory-form')form.reset();await render();message(result);return;}if(form.dataset.action==='review') for(const key of ['facts','claims','link','asset'])input[key]=input[key]==='on';const path=form.id==='auth-form'?(auth.needsSetup?'/api/setup':'/api/login'):form.id==='user-form'?'/api/users':form.id==='draft'?'/api/content':`/api/content/${form.dataset.id}/${form.dataset.action}`;await api(path,input);form.reset();await render();message('تم الحفظ بنجاح');}catch(error){const note=document.createElement('p');note.className='field-error';note.setAttribute('role','alert');note.textContent=error.message;button.before(note);message(error.message,'error');}finally{if(form.id==='ai-form')endGeneration();button.disabled=false;form.removeAttribute('aria-busy');}
});
$('#salla-sync').addEventListener('click',async event=>{event.target.disabled=true;try{const result=await api('/api/salla/sync',{});await render();message(`تم استيراد ${result.count} منتج`);}catch(error){message(error.message,'error');}finally{event.target.disabled=false;}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button)return;let path,input={};if(button.id==='save-brief')path='/api/brief';else if(button.id==='prepare-due')path='/api/schedule/prepare';else if(button.dataset.cancelContent){path='/api/schedule/cancel';input.contentId=button.dataset.cancelContent;}if(!path)return;button.disabled=true;try{const result=await api(path,input);await render();message(result.replayed?'حزمة اليوم محفوظة بالفعل':'تم الحفظ محليًا بنجاح');}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
$('#save-report').addEventListener('click',async event=>{event.target.disabled=true;try{const text=await clickSaveReport(api);await render();message(text);}catch(error){message(error.message,'error');}finally{event.target.disabled=false;}});
document.addEventListener('click',async event=>{const target=event.target.closest('#report-refresh, #report-retry, #report-print, [data-report-nav], [data-view-saved]');if(!target)return;try{await clickReportAction(target,api,escape);}catch(error){message(error.message,'error');}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button||!['frost-pause','frost-resume','frost-run-now'].includes(button.id))return;button.disabled=true;try{const text=await clickFrost(button,api);await render();message(text);}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button||button.id!=='integrations-check-all')return;button.disabled=true;try{await checkAllIntegrations(api,message);await render();}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
document.addEventListener('click',async event=>{const button=event.target.closest('[data-team-action]');if(!button)return;button.disabled=true;try{const result=await clickTeam(button);if(result){await render();message(result);}}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
document.addEventListener('team-refresh',async event=>{try{await render();message(event.detail);}catch(error){message(error.message,'error');}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button||!(button.dataset.approvalDecide||button.dataset.escalationResolve))return;button.disabled=true;try{const text=await clickApprovalCenter(button,api);await render();message(text);}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
$('#logout').addEventListener('click',async()=>{try{await api('/api/logout',{});resetCRM();resetCompliance();await render();message('تم تسجيل الخروج');}catch(error){message(error.message,'error');}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button||!button.dataset.complianceCheck)return;button.disabled=true;try{const result=await clickCompliance(button,api);await render();message(result);}catch(error){message(error.message,'error');}finally{button.disabled=false;}});
document.addEventListener('click',async event=>{const button=event.target.closest('button,[data-open-lead],[data-crm-scroll]');if(!button||!(button.dataset.leadId||button.dataset.openLead||button.dataset.followupApprove||button.dataset.crmStop||button.id==='crm-prepare'||button.id==='crm-run-frost'||button.dataset.followupTab||button.dataset.inboxTab||button.dataset.quickAction))return;if(button.tagName==='BUTTON')button.disabled=true;try{const result=await clickCRM(button,api);if(result){await render();message(result);}}catch(error){message(error.message,'error');}finally{if(button.tagName==='BUTTON')button.disabled=false;}});
let crmSearchTimer=null;
document.addEventListener('input',event=>{if(event.target.id!=='crm-search')return;clearTimeout(crmSearchTimer);const query=event.target.value;crmSearchTimer=setTimeout(()=>crmSearch(query,api,escape).catch(error=>message(error.message)),300);});
window.addEventListener('crm-stage-drop',async event=>{try{await applyStageChange(event.detail,api);await render();message('تم تحديث مرحلة الفرصة');}catch(error){message(error.message,'error');}});
render().catch(error=>message(error.message));
