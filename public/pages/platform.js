// Multi-Tenant Phase 4C-7 — Platform Operations Dashboard. A minimal foundation, NOT a
// Super Admin SaaS product (Part 19). Reuses the same design system as every other page here.
// Visible/reachable only when the backend itself says this session is a platform admin
// (`auth.isPlatformAdmin`, from `/api/auth`) — the nav link stays hidden otherwise, and every
// route this page calls is independently, server-side gated by `requirePlatformAdmin` (Part
// 58: a normal tenant owner/reviewer/operator gets a real 403, never a client-side illusion).
import {escape,button,badge,empty,skeleton,promptDrawer,drawer,toast as showToast} from '../components/ui/index.js';
import {t,getLocale} from '../i18n.js';

const $=s=>document.querySelector('#platform '+s);
let apiClient,currentAuth,renderGeneration=0;

function toast(text){showToast(text,'success');}
function toastError(text){showToast(text,'error');}
function staleGuard(generation){return generation!==renderGeneration;}

export function installPlatformPage(){
 const root=document.querySelector('[data-page="platform"] #platform');
 root.innerHTML=`<div id="pf-overview" class="kpi-grid"></div><div id="pf-directory"></div>`;
}

export async function renderPlatformPage({api:client,auth}){
 apiClient=client;currentAuth=auth;
 const navLink=document.querySelector('#nav-platform');
 const visible=!!auth.isPlatformAdmin;
 navLink.hidden=!visible;
 if(!visible)return;
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
