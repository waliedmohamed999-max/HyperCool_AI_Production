// Multi-Tenant Phase 4C-7 — Platform Operations Dashboard. A minimal foundation, NOT a
// Super Admin SaaS product (Part 19). Reuses the same design system as every other page here.
// Visible/reachable only when the backend itself says this session is a platform admin
// (`auth.isPlatformAdmin`, from `/api/auth`) — the nav link stays hidden otherwise, and every
// route this page calls is independently, server-side gated by `requirePlatformAdmin` (Part
// 58: a normal tenant owner/reviewer/operator gets a real 403, never a client-side illusion).
import {escape,button,badge,empty,skeleton,promptDrawer,drawer,tabs,table,toast as showToast} from '../components/ui/index.js';
import {t,getLocale} from '../i18n.js';

const $=s=>document.querySelector('#platform '+s);
let apiClient,currentAuth,renderGeneration=0;

function toast(text){showToast(text,'success');}
function toastError(text){showToast(text,'error');}
function staleGuard(generation){return generation!==renderGeneration;}

export function installPlatformPage(){
 const root=document.querySelector('[data-page="platform"] #platform');
 root.innerHTML=`<div id="pf-overview" class="kpi-grid"></div><div id="pf-directory"></div><div id="pf-connectors"></div>`;
}

export async function renderPlatformPage({api:client,auth}){
 apiClient=client;currentAuth=auth;
 const navLink=document.querySelector('#nav-platform');
 const visible=!!auth.isPlatformAdmin;
 navLink.hidden=!visible;
 // Someone navigating straight to #platform's URL without the nav link (never authorized
 // either way — every real route this page calls is independently gated server-side, Part
 // 58) still sees a clear, honest message instead of a blank page.
 if(!visible){$('#pf-overview').innerHTML='';$('#pf-directory').innerHTML=empty(t('platform.notPlatformAdmin'));return;}
 const generation=++renderGeneration;
 $('#pf-overview').innerHTML=skeleton(t('common.loading'));
 let overview,directory;
 try{[overview,directory]=await Promise.all([apiClient('/api/platform/overview'),apiClient('/api/platform/tenants')]);}
 catch(error){
  if(staleGuard(generation))return;
  $('#pf-overview').innerHTML=empty(t('controlCenter.loadFailed'),error.message);
  return;
 }
 if(staleGuard(generation))return;
 renderOverview(overview);
 renderDirectory(directory);
 renderConnectorsSection();
}

function renderOverview(overview){
 const kpi=(label,value)=>`<article class="kpi-card"><span class="kpi-label">${escape(label)}</span><strong class="kpi-value">${escape(value)}</strong></article>`;
 $('#pf-overview').innerHTML=
  kpi(t('platform.kpi.totalTenants'),overview.tenants.total)+
  kpi(t('platform.kpi.active'),overview.tenants.ACTIVE||0)+
  kpi(t('platform.kpi.trial'),overview.tenants.TRIAL||0)+
  kpi(t('platform.kpi.suspended'),overview.tenants.SUSPENDED||0)+
  kpi(t('platform.kpi.expiredTrials'),overview.tenants.expiredTrials)+
  kpi(t('platform.kpi.totalUsers'),overview.users.total)+
  kpi(t('platform.kpi.verifiedUsers'),overview.users.verified)+
  kpi(t('platform.kpi.connectionsNeedingAttention'),overview.connectionsNeedingAttention)+
  kpi(t('platform.kpi.agentsFailing'),overview.agentsFailing)+
  kpi(t('platform.kpi.recentCriticalErrors'),overview.recentCriticalErrors);
}

const PILOT_STATUS_VARIANT={READY:'CONNECTED',NEEDS_ATTENTION:'PENDING',BLOCKED:'ERROR'};
function renderDirectory(directory){
 const host=$('#pf-directory');
 if(!directory.length){host.innerHTML=`<h3>${escape(t('platform.directoryTitle'))}</h3>`+empty(t('common.noResults'));return;}
 host.innerHTML=`<h3>${escape(t('platform.directoryTitle'))}</h3>
  <table><thead><tr>
   <th>${escape(t('platform.table.name'))}</th><th>${escape(t('platform.table.status'))}</th>
   <th>${escape(t('platform.table.trial'))}</th><th>${escape(t('platform.table.owner'))}</th>
   <th>${escape(t('platform.table.onboarding'))}</th><th>${escape(t('platform.table.agents'))}</th>
   <th>${escape(t('platform.table.connections'))}</th><th>${escape(t('platform.table.pilotStatus'))}</th>
   <th>${escape(t('platform.table.actions'))}</th>
  </tr></thead><tbody>${directory.map(rowHtml).join('')}</tbody></table>`;
 for(const tenant of directory) {
  const manage=host.querySelector(`[data-manage="${CSS.escape(tenant.id)}"]`);
  if(manage)manage.onclick=()=>openTenantDetail(tenant);
 }
}
function trialLabel(trial){
 if(trial.status==='NOT_TRIAL')return '—';
 if(trial.status==='EXPIRED')return t('workspace.trialEndedTitle');
 return t('controlCenter.trialBanner',{days:trial.daysRemaining});
}
function rowHtml(tenant){
 return `<tr>
  <td>${escape(tenant.name)} <span dir="ltr" class="kpi-context">${escape(tenant.slug)}</span></td>
  <td>${badge(tenant.status,tenant.status==='ACTIVE'?'CONNECTED':tenant.status==='TRIAL'?'PENDING':'ERROR')}</td>
  <td>${escape(trialLabel(tenant.trial))}</td>
  <td>${tenant.owner?escape(tenant.owner.name):'—'}</td>
  <td>${escape(tenant.onboarding)}</td>
  <td>${escape(tenant.agents.ready)}/${escape(tenant.agents.total)}</td>
  <td>${escape(tenant.connections.healthy)} / ${escape(tenant.connections.unhealthy)}</td>
  <td>${badge(t('platform.pilotStatus.'+tenant.pilotStatus),PILOT_STATUS_VARIANT[tenant.pilotStatus])}</td>
  <td><button type="button" data-manage="${escape(tenant.id)}" class="button secondary">${escape(t('platform.manage'))}</button></td>
 </tr>`;
}

async function openTenantDetail(tenant){
 const node=document.createElement('div');node.innerHTML=skeleton(t('common.loading'));
 const dialog=drawer(tenant.name,node);
 let detail;
 try{detail=await apiClient(`/api/platform/tenants/${tenant.id}`);}
 catch(error){node.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
 node.innerHTML=`<p><strong>${escape(t('platform.table.status'))}:</strong> ${badge(detail.tenant.status,detail.tenant.status==='ACTIVE'?'CONNECTED':detail.tenant.status==='TRIAL'?'PENDING':'ERROR')}</p>
  <p><strong>${escape(t('platform.table.trial'))}:</strong> ${escape(trialLabel(detail.trial))}</p>
  <p><strong>${escape(t('platform.table.agents'))}:</strong> ${escape(detail.agents.ready)}/${escape(detail.agents.total)}</p>
  <h4>${escape(t('platform.members'))}</h4>
  <div class="grid">${detail.members.map(m=>`<div class="card"><strong>${escape(m.name)}</strong><p dir="ltr">${escape(m.username)}</p><p>${escape(m.role)}${m.isOwner?' · '+escape(t('invitations.ownerBadge')):''}</p></div>`).join('')}</div>
  <h4>${escape(t('platform.recentAudit'))}</h4>
  <div>${detail.recentAudit.slice(0,10).map(a=>`<div class="audit-row">${escape(a.action)}<time>${new Date(a.at).toLocaleString(getLocale()==='en'?'en-US':'ar-SA')}</time></div>`).join('')||empty(t('operationsLog.noneRecordedYet'))}</div>`;
 const actions=document.createElement('div');actions.className='report-actions';
 if(detail.tenant.status==='SUSPENDED') {
  const reactivate=button(t('platform.reactivate'),{variant:'primary'});
  reactivate.onclick=async()=>{
   const confirmed=await promptDrawer(t('platform.reactivate'),n=>{n.innerHTML=`<p>${escape(t('platform.reactivateConfirm',{name:tenant.name}))}</p>`;},{confirmLabel:t('platform.reactivate')});
   if(!confirmed)return;
   try{await apiClient(`/api/platform/tenants/${tenant.id}/reactivate`,{},'POST');toast(t('platform.actionSucceeded'));dialog.close();renderPlatformPage({api:apiClient,auth:currentAuth});}
   catch(error){toastError(error.message);}
  };
  actions.append(reactivate);
 } else {
  const suspend=button(t('platform.suspend'),{variant:'danger'});
  suspend.onclick=async()=>{
   const confirmed=await promptDrawer(t('platform.suspend'),n=>{n.innerHTML=`<p>${escape(t('platform.suspendConfirm',{name:tenant.name}))}</p>`;},{confirmLabel:t('platform.suspend')});
   if(!confirmed)return;
   try{await apiClient(`/api/platform/tenants/${tenant.id}/suspend`,{},'POST');toast(t('platform.actionSucceeded'));dialog.close();renderPlatformPage({api:apiClient,auth:currentAuth});}
   catch(error){toastError(error.message);}
  };
  actions.append(suspend);
 }
 const extend=button(t('platform.extendTrial'),{variant:'secondary'});
 extend.onclick=async()=>{
  const days=await promptDrawer(t('platform.extendTrial'),n=>{
   const input=document.createElement('input');input.name='days';input.type='number';input.min='1';input.max='365';input.value='14';input.required=true;
   const label=document.createElement('label');label.textContent=t('platform.extendTrialDaysLabel');label.append(input);n.append(label);
   return {value:()=>Number(input.value),focus:()=>input.focus()};
  },{confirmLabel:t('platform.extendTrial')});
  if(days===null)return;
  try{await apiClient(`/api/platform/tenants/${tenant.id}/extend-trial`,{days},'POST');toast(t('platform.actionSucceeded'));dialog.close();renderPlatformPage({api:apiClient,auth:currentAuth});}
  catch(error){toastError(error.message);}
 };
 actions.append(extend);
 node.append(actions);
}

// --- Integration Builder (Phase 6D) -------------------------------------------------------
// A data-driven Connector Definition is created/edited/published ENTIRELY through the
// /api/platform/connectors* routes below — this UI never writes a code file, never edits
// application.js, never hardcodes a provider card. Once published, the SAME connector appears
// automatically in every tenant's Control Center (see renderIntegrationsTab in
// control-center.js, which reads GET /api/integrations/catalog) with zero further frontend work.

const HTTP_METHODS=['GET','POST','PUT','PATCH','DELETE'];
const RISK_LEVELS=['LOW','MEDIUM','HIGH'];
const AUTH_TYPES=['API_KEY','BEARER_TOKEN','BASIC','NONE'];
const WEBHOOK_AUTH_TYPES=['HMAC','HEADER_TOKEN','SHARED_SECRET','NONE'];

async function renderConnectorsSection(){
 const host=$('#pf-connectors');
 host.innerHTML=`<div class="report-section-head"><h3>${escape(t('platform.builder.sectionTitle'))}</h3></div><p class="kpi-context">${escape(t('platform.builder.sectionHint'))}</p><div id="pf-connectors-list">${skeleton(t('common.loading'))}</div>`;
 const newButton=button(t('platform.builder.newConnector'),{variant:'primary',iconName:'plus'});
 newButton.onclick=()=>openConnectorWizard(null);
 host.querySelector('.report-section-head').append(newButton);
 let list;
 try{list=await apiClient('/api/platform/connectors');}
 catch(error){host.querySelector('#pf-connectors-list').innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
 paintConnectorsList(host.querySelector('#pf-connectors-list'),list);
}
function paintConnectorsList(container,list){
 if(!list.length){container.innerHTML=empty(t('common.noResults'));return;}
 container.innerHTML=table(
  [t('platform.builder.table.name'),t('platform.builder.table.slug'),t('platform.builder.table.status'),t('platform.builder.table.version'),t('platform.builder.table.connections'),t('platform.builder.table.type'),t('platform.builder.table.actions')],
  list.map(c=>[
   escape(getLocale()==='en'?c.nameEn:c.nameAr),
   `<span dir="ltr">${escape(c.slug)}</span>`,
   badge(t('platform.builder.status.'+c.status)||c.status,c.status==='PUBLISHED'?'CONNECTED':c.status==='DRAFT'?'PENDING':'DISCONNECTED'),
   escape(c.version),
   escape(c.connectionsCount),
   c.isSystem?escape(t('platform.builder.type.system')):escape(t('platform.builder.type.dynamic')),
   `<span data-row-actions="${escape(c.id)}"></span>`
  ])
 );
 for(const c of list){
  const cell=container.querySelector(`[data-row-actions="${CSS.escape(c.id)}"]`);
  const manage=button(t('platform.builder.manage'),{variant:'secondary'});
  manage.onclick=()=>openConnectorWizard(c);
  cell.append(manage);
 }
}

/** `summary` is a row from listConnectorsForBuilder (or null for a brand-new connector) — the
 * wizard fetches the full detail (actions/triggers) itself once a real definitionId exists. */
async function openConnectorWizard(summary){
 if(summary?.isSystem){
  const node=document.createElement('div');
  node.innerHTML=`<p>${escape(t('platform.builder.systemReadonlyNote'))}</p>
   <p><strong>${escape(t('platform.builder.fields.slug'))}:</strong> <span dir="ltr">${escape(summary.slug)}</span></p>
   <p><strong>${escape(t('platform.builder.fields.capabilities'))}:</strong> ${(summary.capabilities||[]).map(escape).join('، ')||'—'}</p>
   <p><strong>${escape(t('platform.builder.table.connections'))}:</strong> ${escape(summary.connectionsCount)}</p>`;
  drawer(getLocale()==='en'?summary.nameEn:summary.nameAr,node);
  return;
 }
 let definitionId=summary?.id||null;
 let capabilityRegistry=[];
 try{capabilityRegistry=await apiClient('/api/platform/capabilities');}catch{capabilityRegistry=[];}

 const node=document.createElement('div');
 const basicPanel=document.createElement('div'),actionsPanel=document.createElement('div'),
       webhooksPanel=document.createElement('div'),healthPanel=document.createElement('div'),reviewPanel=document.createElement('div');
 node.append(basicPanel,actionsPanel,webhooksPanel,healthPanel,reviewPanel);
 const tabBar=tabs(node,[
  [t('platform.builder.tabBasic')+' / '+t('platform.builder.tabAuth')+' / '+t('platform.builder.tabCapabilities'),basicPanel],
  [t('platform.builder.tabActions'),actionsPanel],
  [t('platform.builder.tabWebhooks'),webhooksPanel],
  [t('platform.builder.tabHealth'),healthPanel],
  [t('platform.builder.tabReview'),reviewPanel]
 ]);
 const dialog=drawer(summary?(getLocale()==='en'?summary.nameEn:summary.nameAr):t('platform.builder.wizardTitleNew'),node);
 let detail=summary?null:{actions:[],triggers:[],restConfig:null,authConfig:null,capabilities:[]};

 async function reload(){
  if(!definitionId){paintBasic();gateOtherTabs();return;}
  try{detail=await apiClient(`/api/platform/connectors/${definitionId}`);}
  catch(error){toastError(error.message);return;}
  paintBasic();paintActions();paintWebhooks();paintHealth();paintReview();gateOtherTabs();
 }
 function gateOtherTabs(){
  const disabled=!definitionId;
  [actionsPanel,webhooksPanel,healthPanel,reviewPanel].forEach(panel=>{
   if(disabled)panel.innerHTML=empty(t('platform.builder.createFirst'));
  });
 }

 function paintBasic(){
  const d=detail||{};
  basicPanel.innerHTML=`
   <label>${escape(t('platform.builder.fields.slug'))}<input name="slug" dir="ltr" ${definitionId?'disabled':''} value="${escape(d.slug||'')}" required pattern="[a-z][a-z0-9_-]*" maxlength="60"></label>
   <label>${escape(t('platform.builder.fields.nameAr'))}<input name="nameAr" value="${escape(d.nameAr||'')}" required maxlength="100"></label>
   <label>${escape(t('platform.builder.fields.nameEn'))}<input name="nameEn" dir="ltr" value="${escape(d.nameEn||'')}" required maxlength="100"></label>
   <label>${escape(t('platform.builder.fields.category'))}<input name="category" value="${escape(d.category||'custom')}" maxlength="40"></label>
   <label>${escape(t('platform.builder.fields.descriptionAr'))}<textarea name="descriptionAr" maxlength="500">${escape(d.descriptionAr||'')}</textarea></label>
   <label>${escape(t('platform.builder.fields.descriptionEn'))}<textarea name="descriptionEn" dir="ltr" maxlength="500">${escape(d.descriptionEn||'')}</textarea></label>
   <label>${escape(t('platform.builder.fields.connectionMode'))}<select name="connectionMode" ${definitionId?'disabled':''}>${['SINGLE','MULTI'].map(m=>`<option value="${m}" ${d.connectionMode===m?'selected':''}>${escape(t('controlCenter.connectionMode.'+m))}</option>`).join('')}</select></label>
   <label>${escape(t('platform.builder.fields.baseUrl'))}<input name="baseUrl" dir="ltr" value="${escape(d.restConfig?.baseUrl||'')}" required placeholder="https://api.example.com"></label>
   <label class="check"><input type="checkbox" name="allowHttp" ${d.restConfig?.allowHttp?'checked':''}> ${escape(t('platform.builder.fields.allowHttp'))}</label>
   <label>${escape(t('platform.builder.fields.authType'))}<select name="authType" ${definitionId?'disabled':''}>${AUTH_TYPES.map(a=>`<option value="${a}" ${(d.authConfig?.type||'API_KEY')===a?'selected':''}>${escape(a)}</option>`).join('')}</select></label>
   <label data-header-name-row>${escape(t('platform.builder.fields.headerName'))}<input name="headerName" dir="ltr" value="${escape(d.authConfig?.headerName||'X-Api-Key')}"></label>
   <fieldset><legend>${escape(t('platform.builder.fields.capabilities'))}</legend>
    ${capabilityRegistry.map(c=>`<label class="check"><input type="checkbox" name="cap" value="${escape(c.id)}" ${(d.capabilities||[]).includes(c.id)?'checked':''}> <span dir="ltr">${escape(c.id)}</span> — ${escape(getLocale()==='en'?c.descriptionEn:c.descriptionAr)}</label>`).join('')}
   </fieldset>
   <div class="report-actions" id="basic-actions"></div>`;
  const authSelect=basicPanel.querySelector('[name=authType]');
  const syncHeaderRow=()=>{basicPanel.querySelector('[data-header-name-row]').hidden=authSelect.value!=='API_KEY';};
  authSelect.onchange=syncHeaderRow;syncHeaderRow();
  const saveButton=button(definitionId?t('platform.builder.saveChanges'):t('platform.builder.createDraft'),{variant:'primary'});
  saveButton.onclick=async()=>{
   const val=name=>basicPanel.querySelector(`[name=${name}]`).value.trim();
   const caps=[...basicPanel.querySelectorAll('[name=cap]:checked')].map(el=>el.value);
   const auth=authSelect.value==='API_KEY'?{type:'API_KEY',headerName:val('headerName')||'X-Api-Key'}
    :authSelect.value==='NONE'?{type:'NONE',allowNone:true}:{type:authSelect.value};
   const payload={nameAr:val('nameAr'),nameEn:val('nameEn'),category:val('category')||'custom',descriptionAr:val('descriptionAr'),descriptionEn:val('descriptionEn'),
    capabilities:caps,rest:{baseUrl:val('baseUrl'),allowHttp:basicPanel.querySelector('[name=allowHttp]').checked},auth};
   try{
    if(definitionId){
     await apiClient(`/api/platform/connectors/${definitionId}`,payload,'PATCH');
    } else {
     const created=await apiClient('/api/platform/connectors',{...payload,slug:val('slug'),adapterType:'GENERIC_REST',connectionMode:basicPanel.querySelector('[name=connectionMode]').value});
     definitionId=created.id;
    }
    toast(t('common.savedSuccessfully'));
    await reload();
    refreshConnectorsListInBackground();
   }catch(error){toastError(error.message);}
  };
  basicPanel.querySelector('#basic-actions').append(saveButton);
 }

 function paintActions(){
  if(!definitionId)return;
  const list=detail?.actions||[];
  actionsPanel.innerHTML=(list.length?'':empty(t('platform.builder.noActionsYet')))+
   list.map(a=>`<div class="audit-row row-between" data-action="${escape(a.id)}"><span><strong dir="ltr">${escape(a.httpMethod)} ${escape(a.pathTemplate)}</strong> — <span dir="ltr">${escape(a.slug)}</span> (${escape(a.requiredCapability)})</span><span data-del></span></div>`).join('');
  for(const a of list){
   const del=button(t('platform.builder.deleteAction'),{variant:'danger'});
   del.onclick=async()=>{try{await apiClient(`/api/platform/connectors/${definitionId}/actions/${a.id}`,{},'DELETE');await reload();}catch(error){toastError(error.message);}};
   actionsPanel.querySelector(`[data-action="${CSS.escape(a.id)}"] [data-del]`).append(del);
  }
  const addButton=button(t('platform.builder.addAction'),{variant:'primary',iconName:'plus'});
  addButton.onclick=()=>openActionForm();
  actionsPanel.append(addButton);
 }
 function openActionForm(){
  promptDrawer(t('platform.builder.addAction'),n=>{
   n.innerHTML=`
    <label>${escape(t('platform.builder.fields.actionSlug'))}<input name="slug" dir="ltr" required maxlength="60" pattern="[a-z][a-z0-9_]*"></label>
    <label>${escape(t('platform.builder.fields.actionNameAr'))}<input name="nameAr" required maxlength="100"></label>
    <label>${escape(t('platform.builder.fields.actionNameEn'))}<input name="nameEn" dir="ltr" required maxlength="100"></label>
    <label>${escape(t('platform.builder.fields.httpMethod'))}<select name="httpMethod">${HTTP_METHODS.map(m=>`<option>${m}</option>`).join('')}</select></label>
    <label>${escape(t('platform.builder.fields.pathTemplate'))}<input name="pathTemplate" dir="ltr" required placeholder="/invoices"></label>
    <label>${escape(t('platform.builder.fields.requiredCapability'))}<select name="cap">${(detail.capabilities||[]).map(c=>`<option value="${escape(c)}" dir="ltr">${escape(c)}</option>`).join('')}</select></label>
    <label>${escape(t('platform.builder.fields.riskLevel'))}<select name="riskLevel">${RISK_LEVELS.map(r=>`<option>${r}</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" name="requiresApproval"> ${escape(t('platform.builder.fields.requiresApproval'))}</label>
    <label>${escape(t('platform.builder.fields.responseMappingArrayFrom'))}<input name="arrayFrom" dir="ltr" placeholder="invoices"></label>`;
   return {
    value:()=>{
     const val=name=>n.querySelector(`[name=${name}]`).value.trim();
     const arrayFrom=val('arrayFrom');
     return {
      slug:val('slug'),nameAr:val('nameAr'),nameEn:val('nameEn'),httpMethod:n.querySelector('[name=httpMethod]').value,
      pathTemplate:val('pathTemplate'),requiredCapability:n.querySelector('[name=cap]').value,
      actionType:n.querySelector('[name=httpMethod]').value==='GET'?'READ':'EXTERNAL_WRITE',
      riskLevel:n.querySelector('[name=riskLevel]').value,requiresApprovalDefault:n.querySelector('[name=requiresApproval]').checked,
      responseMapping:arrayFrom?{array:{from:arrayFrom,item:{}}}:undefined
     };
    },
    focus:()=>n.querySelector('[name=slug]').focus()
   };
  },{confirmLabel:t('platform.builder.addAction')}).then(async result=>{
   if(!result)return;
   try{await apiClient(`/api/platform/connectors/${definitionId}/actions`,result);await reload();}
   catch(error){toastError(error.message);}
  });
 }

 function paintWebhooks(){
  if(!definitionId)return;
  const list=detail?.triggers||[];
  webhooksPanel.innerHTML=(list.length?'':empty(t('platform.builder.noTriggersYet')))+
   list.map(tr=>`<div class="audit-row row-between" data-trigger="${escape(tr.id)}"><span><strong dir="ltr">${escape(tr.slug)}</strong> → <span dir="ltr">${escape(tr.normalizedEventType)}</span> (${escape(tr.authentication?.type)})</span><span data-del></span></div>`).join('');
  for(const tr of list){
   const del=button(t('platform.builder.deleteTrigger'),{variant:'danger'});
   del.onclick=async()=>{try{await apiClient(`/api/platform/connectors/${definitionId}/triggers/${tr.id}`,{},'DELETE');await reload();}catch(error){toastError(error.message);}};
   webhooksPanel.querySelector(`[data-trigger="${CSS.escape(tr.id)}"] [data-del]`).append(del);
  }
  const addButton=button(t('platform.builder.addTrigger'),{variant:'primary',iconName:'plus'});
  addButton.onclick=()=>openTriggerForm();
  webhooksPanel.append(addButton);
 }
 function openTriggerForm(){
  promptDrawer(t('platform.builder.addTrigger'),n=>{
   n.innerHTML=`
    <label>${escape(t('platform.builder.fields.triggerSlug'))}<input name="slug" dir="ltr" required maxlength="60" pattern="[a-z][a-z0-9_]*"></label>
    <label>${escape(t('platform.builder.fields.triggerName'))}<input name="name" required maxlength="100"></label>
    <label>${escape(t('platform.builder.fields.webhookAuthType'))}<select name="authType">${WEBHOOK_AUTH_TYPES.map(a=>`<option>${a}</option>`).join('')}</select></label>
    <label>${escape(t('platform.builder.fields.signatureHeader'))}<input name="signatureHeader" dir="ltr" placeholder="X-Signature"></label>
    <label>${escape(t('platform.builder.fields.signaturePrefix'))}<input name="signaturePrefix" dir="ltr" placeholder="sha256="></label>
    <label>${escape(t('platform.builder.fields.eventIdPath'))}<input name="eventIdPath" dir="ltr" placeholder="id"></label>
    <label>${escape(t('platform.builder.fields.eventIdPolicy'))}<select name="eventIdPolicy"><option value="OPTIONAL">OPTIONAL</option><option value="REQUIRED">REQUIRED</option><option value="NONE">NONE</option></select></label>
    <label>${escape(t('platform.builder.fields.normalizedEventType'))}<input name="normalizedEventType" dir="ltr" required placeholder="INVOICE_CREATED"></label>`;
   return {
    value:()=>{
     const val=name=>n.querySelector(`[name=${name}]`).value.trim();
     const authType=n.querySelector('[name=authType]').value;
     return {
      slug:val('slug'),name:val('name'),
      authentication:authType==='NONE'?{type:'NONE',allowNone:true}:{type:authType,signatureHeader:val('signatureHeader')||undefined,signaturePrefix:val('signaturePrefix')||undefined,headerName:val('signatureHeader')||undefined},
      eventIdPath:val('eventIdPath')||undefined,eventIdPolicy:n.querySelector('[name=eventIdPolicy]').value,
      mappingDefinition:{object:{}},normalizedEventType:val('normalizedEventType')
     };
    },
    focus:()=>n.querySelector('[name=slug]').focus()
   };
  },{confirmLabel:t('platform.builder.addTrigger')}).then(async result=>{
   if(!result)return;
   try{await apiClient(`/api/platform/connectors/${definitionId}/triggers`,result);await reload();}
   catch(error){toastError(error.message);}
  });
 }

 function paintHealth(){
  if(!definitionId)return;
  const health=detail?.restConfig?.health||{};
  healthPanel.innerHTML=`
   <label>${escape(t('platform.builder.fields.healthMethod'))}<select name="method">${['GET','HEAD'].map(m=>`<option ${health.method===m?'selected':''}>${m}</option>`).join('')}</select></label>
   <label>${escape(t('platform.builder.fields.healthPath'))}<input name="path" dir="ltr" value="${escape(health.path||'')}" placeholder="/health"></label>
   <label>${escape(t('platform.builder.fields.healthExpectedStatus'))}<input name="expectedStatus" type="number" value="${escape(health.expectedStatus??200)}"></label>
   <div class="report-actions" id="health-actions"></div>`;
  const save=button(t('platform.builder.saveChanges'),{variant:'primary'});
  save.onclick=async()=>{
   const path=healthPanel.querySelector('[name=path]').value.trim();
   const method=healthPanel.querySelector('[name=method]').value;
   const expectedStatus=Number(healthPanel.querySelector('[name=expectedStatus]').value)||200;
   try{
    await apiClient(`/api/platform/connectors/${definitionId}`,{rest:{...detail.restConfig,health:path?{method,path,expectedStatus}:undefined}},'PATCH');
    toast(t('common.savedSuccessfully'));await reload();
   }catch(error){toastError(error.message);}
  };
  healthPanel.querySelector('#health-actions').append(save);
 }

 function paintReview(){
  if(!definitionId)return;
  reviewPanel.innerHTML=`<p><strong>${escape(t('platform.builder.table.status'))}:</strong> ${badge(t('platform.builder.status.'+detail.status)||detail.status,detail.status==='PUBLISHED'?'CONNECTED':detail.status==='DRAFT'?'PENDING':'DISCONNECTED')}</p>
   <p><strong>${escape(t('platform.builder.table.version'))}:</strong> ${escape(detail.version)}</p>
   <p>${escape(t('platform.builder.connectionsCount',{count:detail.connectionsCount??0}))}</p>
   <div id="review-validation"></div>
   <div class="report-actions" id="review-actions"></div>`;
  const validateButton=button(t('platform.builder.runValidation'),{variant:'secondary'});
  validateButton.onclick=async()=>{
   const out=reviewPanel.querySelector('#review-validation');
   try{await apiClient(`/api/platform/connectors/${definitionId}/validate`,{});out.innerHTML=`<p class="notice">${escape(t('platform.builder.validationOk'))}</p>`;}
   catch(error){out.innerHTML=`<p class="notice trial-banner-warning">${escape(t('platform.builder.validationFailed',{error:error.message}))}</p>`;}
  };
  const publishButton=button(t('platform.builder.publishNow'),{variant:'primary'});
  publishButton.onclick=async()=>{
   const confirmed=await promptDrawer(t('platform.builder.publishNow'),n=>{n.innerHTML=`<p>${escape(t('platform.builder.publishConfirm'))}</p>`;},{confirmLabel:t('platform.builder.publishNow')});
   if(!confirmed)return;
   try{
    const published=await apiClient(`/api/platform/connectors/${definitionId}/publish`,{});
    toast(t('platform.builder.publishSucceeded',{version:published.version}));
    await reload();refreshConnectorsListInBackground();
   }catch(error){toastError(error.message);}
  };
  const actions=[validateButton,publishButton];
  if(detail.status==='PUBLISHED'){
   const disableButton=button(t('platform.builder.disable'),{variant:'danger'});
   disableButton.onclick=async()=>{
    const confirmed=await promptDrawer(t('platform.builder.disable'),n=>{n.innerHTML=`<p>${escape(t('platform.builder.disableConfirm'))}</p>`;},{confirmLabel:t('platform.builder.disable')});
    if(!confirmed)return;
    try{await apiClient(`/api/platform/connectors/${definitionId}/disable`,{});toast(t('platform.actionSucceeded'));await reload();refreshConnectorsListInBackground();}
    catch(error){toastError(error.message);}
   };
   actions.push(disableButton);
  } else if(detail.status==='DISABLED'){
   const reactivateButton=button(t('platform.builder.reactivate'),{variant:'secondary'});
   reactivateButton.onclick=async()=>{
    try{await apiClient(`/api/platform/connectors/${definitionId}/reactivate`,{});toast(t('platform.actionSucceeded'));await reload();refreshConnectorsListInBackground();}
    catch(error){toastError(error.message);}
   };
   actions.push(reactivateButton);
  }
  reviewPanel.querySelector('#review-actions').append(...actions);
 }

 function refreshConnectorsListInBackground(){
  apiClient('/api/platform/connectors').then(list=>paintConnectorsList($('#pf-connectors-list'),list)).catch(()=>{});
 }

 await reload();
 dialog.addEventListener('close',()=>refreshConnectorsListInBackground(),{once:true});
}
