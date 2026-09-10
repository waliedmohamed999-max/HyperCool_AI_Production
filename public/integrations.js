import {escape,badge,empty,button,drawer,tabs,enhance} from './components/ui/index.js';
import {t,getLocale} from './i18n.js';
const $=selector=>document.querySelector(selector);
const categoryNames=new Proxy({},{get:(_,code)=>{const key='integrations.category'+code;const value=t(key);return value===key?undefined:value;}});
const statusNames=new Proxy({},{get:(_,code)=>{const key='statuses.'+code;const value=t(key);return value===key?undefined:value;}});
const errorLabels=new Proxy({},{get:(_,code)=>{const key='integrations.error'+code.split('_').map(p=>p.charAt(0)+p.slice(1).toLowerCase()).join('');const value=t(key);return value===key?undefined:value;}});
let dashboard=null,apiClient=null,currentCategory='';
function dateLocale(){return getLocale()==='en'?'en-US':'ar-SA';}

function kpiCard(label,value,hint,filterStatus){
 return `<article class="kpi-card clickable" data-integration-kpi="${filterStatus}"><span class="kpi-label">${escape(label)}</span><strong class="kpi-value">${escape(value)}</strong><span class="kpi-context">${escape(hint)}</span></article>`;
}
function renderSummary(){
 const s=dashboard.summary;
 $('#integrations-summary').innerHTML=[
  kpiCard(t('integrations.kpiConnectedLabel'),s.connected,t('integrations.kpiConnectedHint'),'CONNECTED'),
  kpiCard(t('integrations.kpiNeedsSetupLabel'),s.needsSetup,t('integrations.kpiNeedsSetupHint'),'NEEDS_SETUP'),
  kpiCard(t('integrations.kpiAttentionLabel'),s.attentionRequired,t('integrations.kpiAttentionHint'),'CONFIGURED_NO_CONNECTOR'),
  kpiCard(t('integrations.kpiErrorsLabel'),s.errors,t('integrations.kpiErrorsHint'),'ERROR')
 ].join('');
}
function renderCategoryFilters(){
 const counts={};for(const i of dashboard.integrations)counts[i.category]=(counts[i.category]||0)+1;
 const cats=['','AI','Commerce','Messaging','Social','Productivity'];
 $('#integrations-category-filters').innerHTML=cats.map(c=>`<button type="button" class="tab${c===currentCategory?' active':''}" data-integration-category="${c}">${c?escape(categoryNames[c]):escape(t('integrations.categoryAll'))}<span class="count">${c?counts[c]||0:dashboard.integrations.length}</span></button>`).join('');
}
function statusFor(id){return dashboard.integrations.find(i=>i.id===id);}
function primaryLabel(status){return status==='CONNECTED'?t('integrations.manage'):status==='ERROR'?t('integrations.reconnect'):status==='CONFIGURED_NO_CONNECTOR'?t('integrations.viewDetails'):status==='NOT_SUPPORTED'?t('integrations.notSupportedLabel'):t('integrations.connect');}
function healthLabel(i){
 if(!i.connectorImplemented)return t('integrations.healthNotMeasurable');
 if(i.status==='ERROR')return t('integrations.healthNeedsAttention');
 if(i.status==='CONNECTED')return t('integrations.healthGood');
 return '—';
}
function renderCards(){
 const list=dashboard.integrations.filter(i=>!currentCategory||i.category===currentCategory);
 const locale=dateLocale();
 $('#integration-list').className='grid integrations-grid';
 $('#integration-list').innerHTML=list.map(i=>`<article class="card integration-card">
  <div class="row-between"><span class="integration-logo" dir="ltr">${escape(i.name.slice(0,2))}</span>${badge(statusNames[i.status],i.status)}</div>
  <h3 dir="ltr">${escape(i.name)}</h3><p>${escape(i.description)}</p>
  <div class="integration-meta">
   <div><span>${i.id==='salla'?escape(t('integrations.lastSyncLabel')):escape(t('integrations.lastActivityLabel'))}</span><strong>${i.lastActivity?new Date(i.lastActivity.at).toLocaleDateString(locale,{timeZone:'Asia/Riyadh'}):escape(t('integrations.noneYet'))}</strong></div>
   <div><span>${escape(t('integrations.healthLabel'))}</span><strong>${escape(healthLabel(i))}</strong></div>
  </div>
  <div class="row"><button type="button" data-integration-primary="${i.id}"${i.status==='NOT_SUPPORTED'?` disabled title="${escape(t('integrations.notSupportedTooltip'))}"`:''}>${escape(primaryLabel(i.status))}</button><button type="button" class="secondary" data-integration-details="${i.id}">${escape(t('integrations.viewDetails'))}</button></div>
 </article>`).join('')||empty(t('integrations.noCategoryIntegrations'));
}
function renderSyncLog(){
 const rows=dashboard.recentSyncActivity;
 const locale=dateLocale();
 if(!rows.length){$('#integrations-sync-log').innerHTML=empty(t('integrations.noSyncActivity'));return;}
 $('#integrations-sync-log').innerHTML=`<table><thead><tr><th>${escape(t('integrations.syncTableTime'))}</th><th>${escape(t('integrations.syncTableIntegration'))}</th><th>${escape(t('integrations.syncTableOperation'))}</th><th>${escape(t('integrations.syncTableStatus'))}</th><th>${escape(t('integrations.syncTableRecords'))}</th><th>${escape(t('integrations.syncTableDuration'))}</th></tr></thead><tbody>${rows.map(r=>`<tr><td dir="ltr">${new Date(r.at).toLocaleString(locale,{timeZone:'Asia/Riyadh'})}</td><td dir="ltr">${escape(r.integration)}</td><td>${escape(r.operation)}</td><td>${badge(r.status==='COMPLETED'?t('integrations.syncCompleted'):r.status==='ERROR'||r.status==='FAILED'?t('integrations.syncFailed'):escape(r.status),r.status)}</td><td dir="ltr">${r.records??'—'}</td><td dir="ltr">${r.durationMs!=null?(r.durationMs/1000).toFixed(1)+'s':'—'}</td></tr>`).join('')}</tbody></table>`;
}
function renderErrorsList(){
 const rows=dashboard.integrations.flatMap(i=>i.recentErrors.map(e=>({...e,integration:i.name})));
 const locale=dateLocale();
 if(!rows.length){$('#integrations-errors').innerHTML=empty(t('integrations.noErrorsRecorded'));return;}
 $('#integrations-errors').innerHTML=`<div class="risk-list">${rows.slice(0,15).map(e=>`<div class="risk-item"><div class="risk-body"><span class="risk-title" dir="ltr">${escape(e.integration)} — ${escape(errorLabels[e.code]||e.code)}</span><span class="risk-meta">${escape(e.action)}</span></div><small dir="ltr">${new Date(e.at).toLocaleString(locale,{timeZone:'Asia/Riyadh'})}</small></div>`).join('')}</div>`;
}
function renderDependencyMap(){
 const rows=dashboard.integrations.filter(i=>i.agentsUsing.length);
 const listSep=getLocale()==='en'?', ':'، ';
 if(!rows.length){$('#integrations-dependency-map').innerHTML=empty(t('integrations.noDependencies'));return;}
 $('#integrations-dependency-map').innerHTML=`<div class="risk-list">${rows.map(i=>`<div class="risk-item"><div class="risk-body"><span class="risk-title" dir="ltr">${escape(i.name)}</span><span class="risk-meta">${escape(t('integrations.usedByLabel'))} ${i.agentsUsing.map(a=>escape(a.name)).join(listSep)}</span></div>${badge(statusNames[i.status],i.status)}</div>`).join('')}</div>`;
}
function envGuidance(i){
 if(!i.envVars.length)return `<p>${escape(t('integrations.noEnvPath'))}</p>`;
 const rows=i.envVars.map(v=>`<p>${escape(v.name)}: ${badge(v.configured?t('integrations.envConfigured'):t('integrations.envNotConfigured'),v.configured?'CONNECTED':'NEEDS_SETUP')}</p>`).join('');
 return `${rows}<p><small>${escape(t('integrations.envManagedNote'))}</small></p>`;
}
async function openDetail(id,initialTab=0){
 const i=statusFor(id);if(!i)return;
 const locale=dateLocale();
 const overview=document.createElement('div');
 overview.innerHTML=`<div class="row-between">${badge(statusNames[i.status],i.status)}<span>${escape(i.authType)}</span></div>
  <p>${escape(i.description)}</p>
  ${i.id==='salla'&&i.lastActivity?`<p>${escape(t('integrations.lastSuccessfulSyncLine',{date:new Date(i.lastActivity.at).toLocaleString(locale,{timeZone:'Asia/Riyadh'}),by:i.lastActivity.by||'—',count:i.lastActivity.count}))}</p>`:''}
  ${i.id==='anthropic'&&i.lastActivity?`<p>${escape(t('integrations.lastSuccessfulActivityLine',{date:new Date(i.lastActivity.at).toLocaleString(locale,{timeZone:'Asia/Riyadh'}),note:i.lastActivity.note}))}</p>`:''}
  ${!i.lastActivity?`<p>${i.connectorImplemented?escape(t('integrations.noActivityYet')):escape(t('integrations.noRealConnectionNote'))}</p>`:''}
  <p>${escape(t('integrations.healthLine',{health:healthLabel(i)}))}</p>`;

 const config=document.createElement('div');
 config.innerHTML=envGuidance(i);
 if(i.connectorImplemented){
  const testBtn=button(t('integrations.testConnection'),{variant:'secondary'});
  const result=document.createElement('p');
  testBtn.onclick=async()=>{testBtn.disabled=true;result.textContent=t('integrations.testingInProgress');try{const r=await apiClient(`/api/integrations/${i.id}/test`,{});result.textContent=r.result==='OK'?t('integrations.testResultOk'):r.result==='AUTH_FAILED'?t('integrations.testResultAuthFailed'):r.result==='NOT_CONFIGURED'?t('integrations.testResultNotConfigured'):errorLabels[r.result]||r.result;}catch(error){result.textContent=error.message;}finally{testBtn.disabled=false;}};
  config.append(testBtn,result);
 } else {
  const disabled=button(t('integrations.testConnection'),{variant:'secondary'});disabled.disabled=true;disabled.title=t('integrations.testDisabledTooltip');
  config.append(disabled);
 }

 const permissions=document.createElement('div');
 permissions.innerHTML=i.scopes.length?i.scopes.map(s=>`<p dir="ltr">${escape(s.name)}</p><p><small>${escape(s.note)} — <b>${escape(t('integrations.scopeUnverifiedNote'))}</b></small></p>`).join(''):`<p>${escape(t('integrations.noScopesNote'))}</p>`;

 const history=document.createElement('div');
 const relevant=dashboard.recentSyncActivity.filter(r=>r.integration===i.name);
 history.innerHTML=relevant.length?`<table><thead><tr><th>${escape(t('integrations.syncTableTime'))}</th><th>${escape(t('integrations.syncTableOperation'))}</th><th>${escape(t('integrations.syncTableStatus'))}</th><th>${escape(t('integrations.syncTableRecords'))}</th></tr></thead><tbody>${relevant.map(r=>`<tr><td dir="ltr">${new Date(r.at).toLocaleString(locale,{timeZone:'Asia/Riyadh'})}</td><td>${escape(r.operation)}</td><td>${badge(r.status,r.status)}</td><td dir="ltr">${r.records??'—'}</td></tr>`).join('')}</tbody></table>`:empty(t('integrations.noSyncLogForIntegration'));

 const usage=document.createElement('div');
 usage.innerHTML=i.agentsUsing.length?`<p>${escape(t('integrations.dependentAgentsLabel'))}</p><ul>${i.agentsUsing.map(a=>`<li>${escape(a.name)}</li>`).join('')}</ul><p><small>${escape(t('integrations.dependencyImpactNote'))}</small></p>`:`<p>${escape(t('integrations.noAgentDependency'))}</p>`;

 const errors=document.createElement('div');
 errors.innerHTML=i.recentErrors.length?`<div class="risk-list">${i.recentErrors.map(e=>`<div class="risk-item"><div class="risk-body"><span class="risk-title">${escape(errorLabels[e.code]||e.code)}</span><span class="risk-meta">${escape(e.action)}</span></div><small dir="ltr">${new Date(e.at).toLocaleString(locale,{timeZone:'Asia/Riyadh'})}</small></div>`).join('')}</div>`:empty(t('integrations.noErrorsForIntegration'));

 const node=document.createElement('div');
 node.append(overview,config,permissions,history,usage,errors);
 tabs(node,[[t('integrations.overview'),overview],[t('integrations.setup'),config],[t('integrations.permissions'),permissions],[t('integrations.syncLog'),history],[t('integrations.usage'),usage],[t('integrations.errors'),errors]]);
 const dialog=drawer(i.name,node,{restore:true});
 enhance(node);
 const tabButtons=dialog.querySelectorAll('.ui-tabs .tab');
 if(tabButtons[initialTab])tabButtons[initialTab].click();
}
export async function renderIntegrations({api}){
 apiClient=api;
 try{dashboard=await api('/api/integrations/dashboard');}catch(error){dashboard=null;console.error('integrations dashboard failed to load:',error);}
 if(!dashboard){$('#integration-list').innerHTML=empty(t('integrations.dashboardLoadFailed'));return;}
 renderSummary();renderCategoryFilters();renderCards();renderSyncLog();renderErrorsList();renderDependencyMap();
}
export function installIntegrationInteractions(){
 document.addEventListener('click',e=>{
  const cat=e.target.closest('[data-integration-category]');
  if(cat){currentCategory=cat.dataset.integrationCategory;renderCategoryFilters();renderCards();return;}
  const kpi=e.target.closest('[data-integration-kpi]');
  if(kpi){currentCategory='';renderCategoryFilters();renderCards();$('#integration-list').scrollIntoView({behavior:'smooth',block:'start'});return;}
  const primary=e.target.closest('[data-integration-primary]');
  if(primary){openDetail(primary.dataset.integrationPrimary,1);return;}
  const details=e.target.closest('[data-integration-details]');
  if(details){openDetail(details.dataset.integrationDetails,0);return;}
 });
}
export async function checkAllIntegrations(api,message){
 const implemented=dashboard?.integrations.filter(i=>i.connectorImplemented)||[];
 for(const i of implemented){
  try{const r=await api(`/api/integrations/${i.id}/test`,{});message(`${i.name}: ${r.result==='OK'?t('integrations.errorOk'):errorLabels[r.result]||r.result}`);}
  catch(error){message(`${i.name}: ${error.message}`);}
 }
 if(!implemented.length)message(t('integrations.checkAllNoneToTest'));
}
