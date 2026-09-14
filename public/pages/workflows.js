// Frost Command Center Phase 7C — native Workflow Engine Builder UI (spec Part 29-31).
// Deliberately a structured step builder, not a drag-and-drop canvas (spec item 30) — reuses
// the exact same design system/components as every other page here. One canonical backend
// model (src/runtime/workflow-engine.js) is shared with Frost chat: a workflow Frost creates
// appears here automatically, and a workflow edited here is understood by Frost the same way.
import {escape,button,badge,empty,skeleton,drawer,confirmAction,table,tabs,icon,toast as showToast} from '../components/ui/index.js';
import {t,getLocale} from '../i18n.js';
import {fmtDateTime} from '../format.js';

const $=s=>document.querySelector('#workflows '+s);
let apiClient,meta={stepTypes:[],triggerTypes:[],conditionOperators:[],eventTypes:[]},agents=[],renderGeneration=0;
let workflowLists={},searchQuery='',activePanel=null;
function toast(text){showToast(text,'success');}
function toastError(text){showToast(text,'error');}
function staleGuard(generation){return generation!==renderGeneration;}
async function api(path,body,method){return apiClient(path,body,method);}

export function installWorkflowsPage() {
 const root=document.querySelector('[data-page="workflows"] #workflows');
 root.innerHTML=`
  <header class="wf-hero"><div class="wf-hero-copy"><p class="wf-eyebrow">HYPERCOOL / AUTOMATION</p>
   <h1>${escape(t('workflows.design.heading'))}</h1><p>${escape(t('workflows.design.intro'))}</p>
   <div class="wf-hero-actions"><button type="button" id="wf-new">${icon('plus')}${escape(t('workflows.newWorkflow'))}</button><a class="wf-frost-link" href="#command-center">${icon('agent')}${escape(t('workflows.design.askFrost'))}</a></div></div>
   <div class="wf-flow-guide"><span class="wf-guide-label">${escape(t('workflows.design.howItWorks'))}</span><div class="wf-flow-nodes">${[['clock','trigger'],['agent','execute'],['check','review']].map(([glyph,key],i)=>`<div class="wf-flow-node"><span>${icon(glyph)}</span><strong>${escape(t('workflows.design.'+key))}</strong><small>0${i+1}</small></div>`).join('')}</div><p>${escape(t('workflows.design.guideNote'))}</p></div>
  </header>
  <div id="wf-metrics" class="wf-metrics" aria-live="polite"></div>
  <section class="wf-library"><div class="wf-library-head"><div><h2>${escape(t('workflows.design.library'))}</h2><p>${escape(t('workflows.design.libraryHint'))}</p></div><label class="wf-search">${icon('search')}<input id="wf-search" type="search" aria-label="${escape(t('workflows.design.search'))}" placeholder="${escape(t('workflows.design.search'))}"></label></div>
   <div id="wf-list-status" role="status"></div><div id="wf-tabs"></div></section>`;
 $('#wf-new').onclick=()=>openWorkflowEditor(null);
 $('#wf-search').oninput=event=>{searchQuery=event.target.value;if(activePanel)paintList(activePanel);};
}

const STATUS_VARIANT={ACTIVE:'CONNECTED',DRAFT:'PENDING',PAUSED:'PENDING',ARCHIVED:'DISCONNECTED'};
let currentFilter='ACTIVE';
export async function renderWorkflowsPage({api:client}) {
 apiClient=client;
 const generation=++renderGeneration;
 installWorkflowsPage();
 $('#wf-new').disabled=true;
 $('#wf-list-status').innerHTML=skeleton(t('common.loading'));
 let lists;
 try{[meta,agents,...lists]=await Promise.all([api('/api/workflows/meta'),api('/api/agents'),...['ACTIVE','DRAFT','PAUSED','ARCHIVED'].map(status=>api('/api/workflows?status='+status))]);}
 catch(error){if(staleGuard(generation))return;$('#wf-list-status').innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
 if(staleGuard(generation))return;
 workflowLists=Object.fromEntries(['ACTIVE','DRAFT','PAUSED','ARCHIVED'].map((status,i)=>[status,lists[i]]));
 $('#wf-new').disabled=false;
 $('#wf-metrics').innerHTML=['ACTIVE','DRAFT','PAUSED'].map((status,i)=>`<div class="wf-metric" data-status="${status}"><span class="wf-metric-icon">${icon(['check','file','clock'][i])}</span><div><span>${escape(t('workflows.status.'+status))}</span><strong>${new Intl.NumberFormat(getLocale()).format(workflowLists[status].length)}</strong></div><small>${escape(t('workflows.design.metric'+status))}</small></div>`).join('');
 $('#wf-list-status').innerHTML='';
 const panels=['ACTIVE','DRAFT','PAUSED','ARCHIVED','FAILED_RUNS'].map(()=>{const el=document.createElement('div');return el;});
 $('#wf-tabs').innerHTML='';
 $('#wf-tabs').append(...panels);
 const {select}=tabs($('#wf-tabs'),[
  [t('workflows.tabActive')+' · '+lists[0].length,panels[0]],[t('workflows.tabDraft')+' · '+lists[1].length,panels[1]],[t('workflows.tabPaused')+' · '+lists[2].length,panels[2]],
  [t('workflows.tabArchived')+' · '+lists[3].length,panels[3]],[t('workflows.tabFailedRuns'),panels[4]]
 ]);
 const order=['ACTIVE','DRAFT','PAUSED','ARCHIVED','FAILED_RUNS'];
 $('#wf-tabs').querySelectorAll('[role=tab]').forEach((tabButton,index)=>{tabButton.addEventListener('click',()=>{currentFilter=order[index];activePanel=panels[index];paintList(activePanel);});});
 select(order.indexOf(currentFilter));
 activePanel=panels[order.indexOf(currentFilter)];
 $('#wf-search').value=searchQuery;
 await paintList(activePanel);
}
function paintWorkflowEmpty(panel,key,canCreate=false){
 panel.innerHTML=`<div class="wf-empty"><div class="wf-empty-symbol">${icon(key==='healthy'?'check':'clock')}</div><h3>${escape(t('workflows.design.'+key+'Title'))}</h3><p>${escape(t('workflows.design.'+key+'Hint'))}</p><div class="wf-empty-actions"></div></div>`;
 if(canCreate){const create=button(t('workflows.newWorkflow'),{variant:'primary'});create.onclick=()=>openWorkflowEditor(null);panel.querySelector('.wf-empty-actions').append(create);}
}
async function paintList(panel) {
 if(currentFilter==='FAILED_RUNS'){try{await paintFailedRuns(panel);}catch(error){panel.innerHTML=empty(t('controlCenter.loadFailed'),error.message);}return;}
 const filter=currentFilter,generation=renderGeneration;
 let list;
 try{list=await api('/api/workflows?status='+filter);}catch(error){if(!staleGuard(generation))panel.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
 if(staleGuard(generation)||currentFilter!==filter)return;
 workflowLists[filter]=list;
 const workflows=list.filter(w=>(w.nameAr+' '+(w.description||'')).toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()));
 if(!workflows.length){paintWorkflowEmpty(panel,searchQuery.trim()?'search':currentFilter==='ACTIVE'?'active':currentFilter==='DRAFT'?'draft':currentFilter==='PAUSED'?'paused':'archived',!searchQuery.trim()&&['ACTIVE','DRAFT'].includes(currentFilter));return;}
 panel.innerHTML=`<div class="wf-card-grid">${workflows.map(w=>`<article class="wf-card" data-workflow="${escape(w.id)}">
   <div class="row-between"><span class="wf-card-icon">${icon('clock')}</span>${badge(t('workflows.status.'+w.status),STATUS_VARIANT[w.status])}</div>
   <h3>${escape(w.nameAr)}</h3><p>${escape(w.description||t('workflows.design.noDescription'))}</p>
   <div class="wf-card-bottom"><span>${escape(t('workflows.design.updated'))}<br>${fmtDateTime(w.updatedAt)}</span><div data-wf-actions></div></div>
  </article>`).join('')}</div>`;
 for(const w of workflows) {
  const cell=panel.querySelector(`[data-workflow="${CSS.escape(w.id)}"] [data-wf-actions]`);
  const openButton=button(t('workflows.open'),{variant:'secondary'});
  openButton.onclick=()=>openWorkflowDetail(w.id);
  cell.append(openButton);
 }
}
async function paintFailedRuns(panel) {
 panel.innerHTML=skeleton(t('common.loading'));
 const workflows=['ACTIVE','DRAFT','PAUSED'].flatMap(status=>workflowLists[status]||[]);
 const allRuns=(await Promise.all(workflows.map(w=>api(`/api/workflows/${w.id}/runs`)))).flat();
 const failed=allRuns.filter(r=>r.status==='FAILED').filter(r=>{const w=workflows.find(w=>w.id===r.workflowId);return ((w?.nameAr||'')+' '+(r.error||'')).toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase());}).sort((a,b)=>(b.startedAt||'').localeCompare(a.startedAt||'')).slice(0,30);
 if(!failed.length){paintWorkflowEmpty(panel,searchQuery.trim()?'search':'healthy');return;}
 panel.innerHTML=table([t('workflows.table.workflow'),t('workflows.table.startedAt'),t('workflows.table.error'),''],
  failed.map(r=>{
   const workflow=workflows.find(w=>w.id===r.workflowId);
   return [escape(workflow?.nameAr||r.workflowId),fmtDateTime(r.startedAt),escape(r.error||'—'),`<span data-run-open="${escape(r.id)}"></span>`];
  })
 );
 for(const r of failed) {
  const cell=panel.querySelector(`[data-run-open="${CSS.escape(r.id)}"]`);
  const openButton=button(t('workflows.viewRun'),{variant:'ghost'});
  openButton.onclick=()=>openRunDetail(r.id);
  cell.append(openButton);
 }
}

// ------------------------------------------------------------------------------------------
// Workflow detail: trigger + textual step sequence (spec item 28's Trigger -> Condition ->
// Delay -> Agent/Tool -> Approval -> Task preview), readiness, activate/pause/resume/archive,
// run now, and real run history.
// ------------------------------------------------------------------------------------------
function stepSummaryLine(step) {
 const label=t('workflows.stepType.'+step.type);
 if(step.type==='AGENT')return `${label}: ${escape(step.agentId)} — ${escape(step.objective||'')}`;
 if(step.type==='TOOL')return `${label}: ${escape(step.toolName)}`;
 if(step.type==='CONDITION')return `${label}: ${escape(step.condition?.field||'')} ${escape(step.condition?.op||'')} ${escape(JSON.stringify(step.condition?.value))}`;
 if(step.type==='DELAY')return `${label}: ${escape(step.durationMinutes)} ${escape(t('workflows.minutes'))}`;
 if(step.type==='APPROVAL')return `${label}: ${escape(step.reason||'')}`;
 if(step.type==='CREATE_TASK'||step.type==='NOTIFY_INTERNAL')return `${label}: ${escape(step.reason||'')}`;
 return label;
}
function triggerSummary(trigger) {
 if(trigger.type==='MANUAL')return t('workflows.trigger.manual');
 if(trigger.type==='SCHEDULE')return t('workflows.trigger.schedule',{frequency:t('workflows.frequency.'+trigger.schedule.frequency),hour:trigger.schedule.hour});
 if(trigger.type==='EVENT')return t('workflows.trigger.event',{eventType:trigger.eventType});
 return trigger.type;
}
async function openWorkflowDetail(id) {
 let initial;
 try{initial=await api(`/api/workflows/${id}`);}catch(error){toastError(error.message);return;}
 const node=document.createElement('div');node.innerHTML=skeleton(t('common.loading'));
 const dialog=drawer(initial.nameAr,node,{restore:true});
 async function reload() {
  let workflow,readiness,runs;
  try{[workflow,readiness,runs]=await Promise.all([api(`/api/workflows/${id}`),api(`/api/workflows/${id}/readiness`),api(`/api/workflows/${id}/runs`)]);}
  catch(error){node.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
  const stepsHtml=(workflow.version?.steps||[]).map(s=>`<li>${stepSummaryLine(s)}</li>`).join('');
  node.innerHTML=`
   <div class="row-between"><h3>${escape(workflow.nameAr)}</h3>${badge(t('workflows.status.'+workflow.status),STATUS_VARIANT[workflow.status])}</div>
   <p class="kpi-context">${escape(workflow.description||'')}</p>
   <h4>${escape(t('workflows.triggerLabel'))}</h4><p>${escape(triggerSummary(workflow.version.trigger))}</p>
   <h4>${escape(t('workflows.stepsLabel'))}</h4><ol>${stepsHtml}</ol>
   ${readiness.ready?'':`<p class="notice trial-banner-warning">${escape(t('workflows.notReady'))}<br>${readiness.blockers.map(b=>escape(b.reason)).join('<br>')}</p>`}
   <div class="report-actions" id="wf-detail-actions"></div>
   <h4>${escape(t('workflows.runsLabel'))}</h4>
   <div id="wf-detail-runs"></div>`;
  const actions=node.querySelector('#wf-detail-actions');
  if(workflow.status==='DRAFT') {
   const editButton=button(t('workflows.edit'),{variant:'secondary'});
   editButton.onclick=()=>{dialog.close();openWorkflowEditor(workflow);};
   const activateButton=button(t('workflows.activate'),{variant:'primary'});
   activateButton.disabled=!readiness.ready;
   activateButton.onclick=async()=>{
    const confirmed=await confirmAction(t('workflows.activate'),t('workflows.activateConfirm'));
    if(!confirmed)return;
    try{await api(`/api/workflows/${id}/activate`,{});toast(t('common.savedSuccessfully'));await reload();}catch(error){toastError(error.message);}
   };
   actions.append(editButton,activateButton);
  } else if(workflow.status==='ACTIVE') {
   const runButton=button(t('workflows.runNow'),{variant:'primary'});
   runButton.onclick=async()=>{
    const confirmed=await confirmAction(t('workflows.runNow'),t('workflows.runNowConfirm'));
    if(!confirmed)return;
    try{await api(`/api/workflows/${id}/run`,{});toast(t('common.savedSuccessfully'));await reload();}catch(error){toastError(error.message);}
   };
   const pauseButton=button(t('workflows.pause'),{variant:'secondary'});
   pauseButton.onclick=async()=>{try{await api(`/api/workflows/${id}/pause`,{});toast(t('common.savedSuccessfully'));await reload();}catch(error){toastError(error.message);}};
   actions.append(runButton,pauseButton);
  } else if(workflow.status==='PAUSED') {
   const resumeButton=button(t('workflows.resume'),{variant:'primary'});
   resumeButton.onclick=async()=>{try{await api(`/api/workflows/${id}/resume`,{});toast(t('common.savedSuccessfully'));await reload();}catch(error){toastError(error.message);}};
   actions.append(resumeButton);
  }
  if(workflow.status!=='ARCHIVED') {
   const archiveButton=button(t('workflows.archive'),{variant:'danger'});
   archiveButton.onclick=async()=>{
    const confirmed=await confirmAction(t('workflows.archive'),t('workflows.archiveConfirm'));
    if(!confirmed)return;
    try{await api(`/api/workflows/${id}/archive`,{});toast(t('common.savedSuccessfully'));dialog.close();await renderWorkflowsPage({api:apiClient});}catch(error){toastError(error.message);}
   };
   actions.append(archiveButton);
  }
  const runsHost=node.querySelector('#wf-detail-runs');
  runsHost.innerHTML=runs.length?table([t('workflows.table.startedAt'),t('workflows.table.status'),t('workflows.table.duration'),''],
   runs.map(r=>[fmtDateTime(r.startedAt),badge(r.status,r.status==='COMPLETED'?'CONNECTED':r.status==='FAILED'?'ERROR':'PENDING'),
    r.finishedAt?Math.round((new Date(r.finishedAt)-new Date(r.startedAt))/1000)+t('workflows.seconds'):'—',
    `<span data-run-open="${escape(r.id)}"></span>`])
  ):empty(t('workflows.noRunsYet'));
  for(const r of runs) {
   const cell=runsHost.querySelector(`[data-run-open="${CSS.escape(r.id)}"]`);
   const viewButton=button(t('workflows.viewRun'),{variant:'ghost'});
   viewButton.onclick=()=>openRunDetail(r.id);
   const cancellable=['PENDING','RUNNING','WAITING','WAITING_APPROVAL','CANCEL_REQUESTED'].includes(r.status);
   cell.append(viewButton);
   if(cancellable) {
    const cancelButton=button(t('workflows.cancelRun'),{variant:'danger'});
    cancelButton.onclick=async()=>{
     const confirmed=await confirmAction(t('workflows.cancelRun'),t('workflows.cancelRunConfirm'));
     if(!confirmed)return;
     try{await api(`/api/workflow-runs/${r.id}/cancel`,{});toast(t('common.savedSuccessfully'));await reload();}catch(error){toastError(error.message);}
    };
    cell.append(cancelButton);
   }
  }
 }
 await reload();
}
async function openRunDetail(runId) {
 const node=document.createElement('div');node.innerHTML=skeleton(t('common.loading'));
 drawer(t('workflows.runDetailTitle'),node);
 let run;
 try{run=await api(`/api/workflow-runs/${runId}`);}catch(error){node.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
 node.innerHTML=`<p>${escape(t('workflows.table.status'))}: ${badge(run.status,run.status==='COMPLETED'?'CONNECTED':run.status==='FAILED'?'ERROR':'PENDING')}</p>
  ${run.error?`<p class="notice trial-banner-warning">${escape(run.error)}</p>`:''}
  <div class="cmdc-ops-list">${run.steps.map(s=>`<div class="cmdc-op-row"><span>${escape(t('workflows.stepType.'+s.stepType))} (${escape(s.stepId)})</span>${badge(s.status,s.status==='COMPLETED'?'CONNECTED':s.status==='FAILED'?'ERROR':s.status==='SKIPPED'||s.status==='CANCELLED'?'DISCONNECTED':'PENDING')}${s.error?`<small>${escape(s.error)}</small>`:''}</div>`).join('')}</div>`;
}

// ------------------------------------------------------------------------------------------
// Structured step builder (spec item 30) — a plain, real "+ Add Step" list, no canvas.
// ------------------------------------------------------------------------------------------
function stepFieldsHtml(step={}) {
 const type=step.type||'AGENT';
 return `
  <select data-field="type">${meta.stepTypes.map(t2=>`<option value="${t2}" ${type===t2?'selected':''}>${escape(t('workflows.stepType.'+t2))}</option>`).join('')}</select>
  <div data-type-fields></div>
  <label>${escape(t('workflows.fieldNext'))}<input data-field="next" placeholder="id1,id2" value="${escape((step.next||[]).join(','))}"></label>`;
}
function typeFieldsHtml(type,step={}) {
 if(type==='AGENT')return `
  <select data-field="agentId">${agents.map(a=>`<option value="${a.id}" ${step.agentId===a.id?'selected':''}>${escape(a.name)}</option>`).join('')}</select>
  <input data-field="objective" placeholder="${escape(t('workflows.fieldObjective'))}" value="${escape(step.objective||'')}">`;
 if(type==='TOOL')return `<input data-field="toolName" placeholder="${escape(t('workflows.fieldToolName'))}" value="${escape(step.toolName||'')}">
  <textarea data-field="inputJson" placeholder='{"key":"value"}'>${escape(JSON.stringify(step.input||{}))}</textarea>`;
 if(type==='CONDITION')return `
  <input data-field="condField" placeholder="trigger.value" value="${escape(step.condition?.field||'')}">
  <select data-field="condOp">${meta.conditionOperators.map(op=>`<option value="${op}" ${step.condition?.op===op?'selected':''}>${op}</option>`).join('')}</select>
  <input data-field="condValue" placeholder="value" value="${escape(step.condition?.value??'')}">
  <label>${escape(t('workflows.fieldElseNext'))}<input data-field="elseNext" value="${escape((step.elseNext||[]).join(','))}"></label>`;
 if(type==='DELAY')return `<input type="number" min="1" data-field="durationMinutes" placeholder="${escape(t('workflows.fieldMinutes'))}" value="${escape(step.durationMinutes||60)}">`;
 if(type==='APPROVAL')return `<input data-field="reason" placeholder="${escape(t('workflows.fieldReason'))}" value="${escape(step.reason||'')}">`;
 if(type==='CREATE_TASK'||type==='NOTIFY_INTERNAL')return `<input data-field="reason" placeholder="${escape(t('workflows.fieldReason'))}" value="${escape(step.reason||'')}">
  <select data-field="priority">${['P1','P2','P3','P4'].map(p=>`<option value="${p}" ${step.priority===p?'selected':''}>${p}</option>`).join('')}</select>`;
 return '';
}
function buildStepFromCard(card) {
 const val=name=>card.querySelector(`[data-field="${name}"]`)?.value?.trim()||'';
 const type=val('type');
 const id=card.dataset.stepId;
 const next=val('next').split(',').map(s=>s.trim()).filter(Boolean);
 if(type==='AGENT')return {id,type,agentId:val('agentId'),objective:val('objective'),next};
 if(type==='TOOL'){let input={};try{input=JSON.parse(val('inputJson')||'{}');}catch{/* left empty on invalid JSON */}return {id,type,toolName:val('toolName'),input,next};}
 if(type==='CONDITION')return {id,type,condition:{field:val('condField'),op:val('condOp'),value:val('condValue')},next,elseNext:val('elseNext').split(',').map(s=>s.trim()).filter(Boolean)};
 if(type==='DELAY')return {id,type,durationMinutes:Number(val('durationMinutes'))||60,next};
 if(type==='APPROVAL')return {id,type,reason:val('reason'),next};
 if(type==='CREATE_TASK'||type==='NOTIFY_INTERNAL')return {id,type,reason:val('reason'),priority:val('priority')||'P3',next};
 return {id,type,next};
}
let stepCounter=0;
function addStepCard(host,step=null) {
 const id=step?.id||('step'+(++stepCounter));
 const card=document.createElement('article');
 card.className='card';card.dataset.stepId=id;
 card.innerHTML=`<div class="row-between"><strong dir="ltr">${escape(id)}</strong><button type="button" class="small danger" data-remove-step>${escape(t('workflows.removeStep'))}</button></div>${stepFieldsHtml(step||{})}`;
 host.append(card);
 const typeSelect=card.querySelector('[data-field="type"]');
 const paintTypeFields=()=>{card.querySelector('[data-type-fields]').innerHTML=typeFieldsHtml(typeSelect.value,step||{});};
 typeSelect.onchange=paintTypeFields;
 paintTypeFields();
 card.querySelector('[data-remove-step]').onclick=()=>card.remove();
}
async function openWorkflowEditor(workflow) {
 const node=document.createElement('div');
 const isEdit=!!workflow;
 node.innerHTML=`
  <label>${escape(t('workflows.fieldName'))}<input name="nameAr" required value="${escape(workflow?.nameAr||'')}"></label>
  <label>${escape(t('workflows.fieldDescription'))}<textarea name="description">${escape(workflow?.description||'')}</textarea></label>
  <h4>${escape(t('workflows.triggerLabel'))}</h4>
  <select name="triggerType">${meta.triggerTypes.map(tt=>`<option value="${tt}" ${workflow?.version?.trigger?.type===tt?'selected':''}>${escape(t('workflows.triggerType.'+tt))}</option>`).join('')}</select>
  <div id="wf-trigger-fields"></div>
  <h4>${escape(t('workflows.stepsLabel'))}</h4>
  <div id="wf-steps"></div>
  <button type="button" id="wf-add-step" class="secondary">${escape(t('workflows.addStep'))}</button>
  <div class="report-actions" id="wf-editor-actions"></div>`;
 const dialog=drawer(isEdit?t('workflows.editWorkflow'):t('workflows.newWorkflow'),node,{restore:true});
 const triggerTypeSelect=node.querySelector('[name=triggerType]');
 function paintTriggerFields() {
  const type=triggerTypeSelect.value;
  const host=node.querySelector('#wf-trigger-fields');
  const trig=workflow?.version?.trigger||{};
  if(type==='SCHEDULE')host.innerHTML=`
   <select name="scheduleFrequency"><option value="DAILY" ${trig.schedule?.frequency==='DAILY'?'selected':''}>${escape(t('workflows.frequency.DAILY'))}</option><option value="WEEKLY" ${trig.schedule?.frequency==='WEEKLY'?'selected':''}>${escape(t('workflows.frequency.WEEKLY'))}</option></select>
   <input type="number" min="0" max="23" name="scheduleHour" placeholder="${escape(t('workflows.fieldHour'))}" value="${escape(trig.schedule?.hour??9)}">
   <input type="number" min="0" max="6" name="scheduleWeekday" placeholder="${escape(t('workflows.fieldWeekday'))}" value="${escape(trig.schedule?.weekday??0)}">`;
  else if(type==='EVENT')host.innerHTML=`<select name="eventType">${meta.eventTypes.map(e=>`<option value="${e}" ${trig.eventType===e?'selected':''}>${e}</option>`).join('')}</select>`;
  else host.innerHTML='';
 }
 triggerTypeSelect.onchange=paintTriggerFields;
 paintTriggerFields();
 const stepsHost=node.querySelector('#wf-steps');
 for(const step of workflow?.version?.steps||[])addStepCard(stepsHost,step);
 if(!workflow)addStepCard(stepsHost,null);
 node.querySelector('#wf-add-step').onclick=()=>addStepCard(stepsHost,null);
 const saveButton=button(isEdit?t('common.save'):t('workflows.saveDraft'),{variant:'primary'});
 saveButton.onclick=async()=>{
  const triggerType=triggerTypeSelect.value;
  const trigger=triggerType==='SCHEDULE'?{type:'SCHEDULE',schedule:{frequency:node.querySelector('[name=scheduleFrequency]').value,hour:Number(node.querySelector('[name=scheduleHour]').value),weekday:Number(node.querySelector('[name=scheduleWeekday]')?.value||0)}}
   :triggerType==='EVENT'?{type:'EVENT',eventType:node.querySelector('[name=eventType]').value}:{type:'MANUAL'};
  const steps=[...stepsHost.querySelectorAll('[data-step-id]')].map(buildStepFromCard);
  const payload={nameAr:node.querySelector('[name=nameAr]').value.trim(),description:node.querySelector('[name=description]').value.trim(),trigger,steps};
  try{
   if(isEdit)await api(`/api/workflows/${workflow.id}`,payload,'PATCH');
   else await api('/api/workflows',payload);
   toast(t('common.savedSuccessfully'));
   dialog.close();
   await renderWorkflowsPage({api:apiClient});
  }catch(error){toastError(error.message);}
 };
 node.querySelector('#wf-editor-actions').append(saveButton);
}
