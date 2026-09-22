import {escape,badge,empty} from './components/ui/index.js';
import {t,getLocale} from './i18n.js';
const $=selector=>document.querySelector(selector);
const statusNames=new Proxy({},{get:(_,code)=>{const key='statuses.'+code;const value=t(key);return value===key?undefined:value;}});
const errorLabels=new Proxy({},{get:(_,code)=>{const key='integrations.error'+code.split('_').map(p=>p.charAt(0)+p.slice(1).toLowerCase()).join('');const value=t(key);return value===key?undefined:value;}});
function dateLocale(){return getLocale()==='en'?'en-US':'ar-SA';}

// Connecting and managing integrations lives ONLY in the Control Center. This module just fills the
// read-only monitors (sync activity, recent errors, agent dependencies) shown in its Health tab.
function effectiveStatus(integration,workspaceProviders){
 const healthy=(workspaceProviders.find(p=>p.slug===integration.id)?.connections||[]).some(c=>['CONNECTED','DEGRADED'].includes(c.status));
 return healthy&&['NEEDS_SETUP','CONFIGURED_NO_CONNECTOR'].includes(integration.status)?'CONNECTED':integration.status;
}
function renderSyncLog(dashboard){
 const rows=dashboard.recentSyncActivity;
 const locale=dateLocale();
 if(!rows.length){$('#integrations-sync-log').innerHTML=empty(t('integrations.noSyncActivity'));return;}
 $('#integrations-sync-log').innerHTML=`<table><thead><tr><th>${escape(t('integrations.syncTableTime'))}</th><th>${escape(t('integrations.syncTableIntegration'))}</th><th>${escape(t('integrations.syncTableOperation'))}</th><th>${escape(t('integrations.syncTableStatus'))}</th><th>${escape(t('integrations.syncTableRecords'))}</th><th>${escape(t('integrations.syncTableDuration'))}</th></tr></thead><tbody>${rows.map(r=>`<tr><td dir="ltr">${new Date(r.at).toLocaleString(locale,{timeZone:'Asia/Riyadh'})}</td><td dir="ltr">${escape(r.integration)}</td><td>${escape(r.operation)}</td><td>${badge(r.status==='COMPLETED'?t('integrations.syncCompleted'):r.status==='ERROR'||r.status==='FAILED'?t('integrations.syncFailed'):escape(r.status),r.status)}</td><td dir="ltr">${r.records??'—'}</td><td dir="ltr">${r.durationMs!=null?(r.durationMs/1000).toFixed(1)+'s':'—'}</td></tr>`).join('')}</tbody></table>`;
}
function renderErrorsList(dashboard){
 const rows=dashboard.integrations.flatMap(i=>i.recentErrors.map(e=>({...e,integration:i.name})));
 const locale=dateLocale();
 if(!rows.length){$('#integrations-errors').innerHTML=empty(t('integrations.noErrorsRecorded'));return;}
 $('#integrations-errors').innerHTML=`<div class="risk-list">${rows.slice(0,15).map(e=>`<div class="risk-item"><div class="risk-body"><span class="risk-title" dir="ltr">${escape(e.integration)} — ${escape(errorLabels[e.code]||e.code)}</span><span class="risk-meta">${escape(e.action)}</span></div><small dir="ltr">${new Date(e.at).toLocaleString(locale,{timeZone:'Asia/Riyadh'})}</small></div>`).join('')}</div>`;
}
function renderDependencyMap(dashboard,workspaceProviders){
 const rows=dashboard.integrations.filter(i=>i.agentsUsing.length);
 const listSep=getLocale()==='en'?', ':'، ';
 if(!rows.length){$('#integrations-dependency-map').innerHTML=empty(t('integrations.noDependencies'));return;}
 $('#integrations-dependency-map').innerHTML=`<div class="risk-list">${rows.map(i=>{const status=effectiveStatus(i,workspaceProviders);return `<div class="risk-item"><div class="risk-body"><span class="risk-title" dir="ltr">${escape(i.name)}</span><span class="risk-meta">${escape(t('integrations.usedByLabel'))} ${i.agentsUsing.map(a=>escape(a.name)).join(listSep)}</span></div>${badge(statusNames[status],status)}</div>`;}).join('')}</div>`;
}
export async function renderIntegrationMonitors(api,workspaceProviders=[]){
 if(!$('#integrations-sync-log'))return;
 let dashboard=null;
 try{dashboard=await api('/api/integrations/dashboard');}catch(error){console.error('integrations dashboard failed to load:',error);}
 if(!$('#integrations-sync-log'))return; // the tab was re-rendered while this was loading
 if(!dashboard){for(const id of ['#integrations-sync-log','#integrations-errors','#integrations-dependency-map'])$(id).innerHTML=empty(t('integrations.dashboardLoadFailed'));return;}
 renderSyncLog(dashboard);renderErrorsList(dashboard);renderDependencyMap(dashboard,workspaceProviders);
}
