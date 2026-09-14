// Multi-Tenant Phase 4C-7 — Platform Operations Dashboard. A minimal foundation, NOT a
// Super Admin SaaS product (Part 19). Reuses the same design system as every other page here.
// Visible/reachable only when the backend itself says this session is a platform admin
// (`auth.isPlatformAdmin`, from `/api/auth`) — the nav link stays hidden otherwise, and every
// route this page calls is independently, server-side gated by `requirePlatformAdmin` (Part
// 58: a normal tenant owner/reviewer/operator gets a real 403, never a client-side illusion).
import {escape,button,badge,empty,skeleton,promptDrawer,drawer,tabs,table,metric,toast as showToast} from '../components/ui/index.js';
import {t,getLocale} from '../i18n.js';

const $=s=>document.querySelector('#platform '+s);
let apiClient,currentAuth,renderGeneration=0;

function toast(text){showToast(text,'success');}
function toastError(text){showToast(text,'error');}
function staleGuard(generation){return generation!==renderGeneration;}

export function installPlatformPage(){
 const root=document.querySelector('[data-page="platform"] #platform');
 root.innerHTML=`<div id="pf-command-center"></div><div id="pf-integration-card"></div><div id="pf-overview" class="kpi-grid"></div><div id="pf-directory"></div><div id="pf-pending-custom"></div><div id="pf-webhook-ops"></div><div id="pf-connectors"></div>`;
}

export async function renderPlatformPage({api:client,auth}){
 apiClient=client;currentAuth=auth;
 const visible=!!auth.isPlatformAdmin;
 document.querySelector('#nav-platform').hidden=!visible;
 document.querySelector('#nav-integration-builder').hidden=!visible;
 // Someone navigating straight to #platform's URL without the nav link (never authorized
 // either way — every real route this page calls is independently gated server-side, Part
 // 58) still sees a clear, honest message instead of a blank page.
 if(!visible){$('#pf-integration-card').innerHTML='';$('#pf-overview').innerHTML='';$('#pf-directory').innerHTML=empty(t('platform.notPlatformAdmin'));$('#pf-connectors').innerHTML='';return;}
 const generation=++renderGeneration;
 $('#pf-overview').innerHTML=skeleton(t('common.loading'));
 let overview,directory,connectors;
 try{[overview,directory,connectors]=await Promise.all([apiClient('/api/platform/overview'),apiClient('/api/platform/tenants'),apiClient('/api/platform/connectors')]);}
 catch(error){
  if(staleGuard(generation))return;
  $('#pf-overview').innerHTML=empty(t('controlCenter.loadFailed'),error.message);
  return;
 }
 if(staleGuard(generation))return;
 renderPlatformCommandCenter(overview);
 renderIntegrationPlatformCard(connectors,overview);
 renderOverview(overview);
 renderDirectory(directory);
 renderConnectorsSection(connectors);
 renderPendingCustomConnectors();
 renderWebhookOperations();
}
/** Phase 6H, Part 46-48 — Platform Operations visibility: real, live, cross-tenant Dead Letter
 * Webhooks and Pending Retries (Automatic Webhook Retry, Part 13-18) plus the most recent Bulk
 * Operations (version migrations + webhook reprocesses, Part 6-12) — never a summarized/cached
 * copy, every row a live read of the same ledgers the rest of this phase already built. A
 * separate fetch (like the pending-custom-connectors queue above) so a slow/erroring read here
 * never blocks the rest of this already-critical page from rendering. */
async function renderWebhookOperations(){
 const host=$('#pf-webhook-ops');
 let deadLetters,pendingRetries,bulkOps;
 try{[deadLetters,pendingRetries,bulkOps]=await Promise.all([
  apiClient('/api/platform/webhooks/dead-letters'),apiClient('/api/platform/webhooks/pending-retries'),apiClient('/api/platform/bulk/operations?limit=10')
 ]);}catch{host.innerHTML='';return;}
 if(!deadLetters.length && !pendingRetries.length && !bulkOps.length){host.innerHTML='';return;}
 host.innerHTML=`<h3>${escape(t('platform.operations.title'))}</h3>`;
 if(deadLetters.length){
  host.innerHTML+=`<h4>${escape(t('platform.operations.deadLetters',{count:deadLetters.length}))}</h4>`+table(
   [t('platform.operations.connector'),t('platform.operations.tenantId'),t('platform.operations.trigger'),'errorCode',t('platform.operations.retryCount'),t('platform.operations.receivedAt')],
   deadLetters.map(e=>[`<span dir="ltr">${escape(e.connectorSlug)}</span>`,`<span dir="ltr" class="kpi-context">${escape(e.tenantId)}</span>`,escape(e.triggerSlug),escape(e.errorCode||'—'),escape(e.retryCount),new Date(e.receivedAt).toLocaleString(getLocale()==='en'?'en-US':'ar-SA')])
  );
 }
 if(pendingRetries.length){
  host.innerHTML+=`<h4>${escape(t('platform.operations.pendingRetries',{count:pendingRetries.length}))}</h4>`+table(
   [t('platform.operations.connector'),t('platform.operations.tenantId'),t('platform.operations.trigger'),'errorCode',t('platform.operations.retryCount'),t('platform.operations.nextRetryAt')],
   pendingRetries.map(e=>[`<span dir="ltr">${escape(e.connectorSlug)}</span>`,`<span dir="ltr" class="kpi-context">${escape(e.tenantId)}</span>`,escape(e.triggerSlug),escape(e.errorCode||'—'),escape(e.retryCount),new Date(e.nextRetryAt).toLocaleString(getLocale()==='en'?'en-US':'ar-SA')])
  );
 }
 if(bulkOps.length){
  host.innerHTML+=`<h4>${escape(t('platform.operations.recentBulkOps'))}</h4>`+table(
   [t('platform.operations.type'),t('platform.operations.createdAt'),t('platform.operations.summary')],
   bulkOps.map(o=>[escape(o.type),new Date(o.createdAt).toLocaleString(getLocale()==='en'?'en-US':'ar-SA'),`<span dir="ltr">${escape(JSON.stringify(o.results.length?Object.fromEntries(Object.entries(o.results.reduce((acc,r)=>{acc[r.status]=(acc[r.status]||0)+1;return acc;},{}))):{}))}</span>`])
  );
 }
}
/** Phase 6G, Part 35 — Platform Review queue for Tenant Custom Connector drafts. A separate
 * fetch (not part of the Promise.all above) so a slow/erroring pending-list never blocks the
 * rest of this already-critical page from rendering. */
async function renderPendingCustomConnectors(){
 const host=$('#pf-pending-custom');
 let pending;
 try{pending=await apiClient('/api/platform/custom-connectors/pending');}catch{host.innerHTML='';return;}
 if(!pending.length){host.innerHTML='';return;}
 host.innerHTML=`<h3>${escape(t('platform.customConnectors.pendingTitle'))}</h3>
  <div class="grid">${pending.map(p=>`<div class="card" data-pending="${escape(p.id)}">
   <strong>${escape(getLocale()==='en'?p.nameEn:p.nameAr)}</strong> <span dir="ltr" class="kpi-context">${escape(p.slug)}</span>
   <p>${escape(t('platform.customConnectors.baseUrl'))}: <span dir="ltr">${escape(p.restConfig?.baseUrl||'—')}</span></p>
   <p>${escape(t('platform.customConnectors.capabilities'))}: <span dir="ltr">${(p.capabilities||[]).join(', ')||'—'}</span></p>
   <div class="report-actions" data-pending-actions></div>
  </div>`).join('')}</div>`;
 for(const p of pending){
  const cell=host.querySelector(`[data-pending="${CSS.escape(p.id)}"] [data-pending-actions]`);
  const view=button(t('platform.customConnectors.viewFull'),{variant:'secondary'});
  view.onclick=()=>openConnectorWizard(p);
  const approve=button(t('platform.customConnectors.approve'),{variant:'primary'});
  approve.onclick=async()=>{
   const confirmed=await promptDrawer(t('platform.customConnectors.approve'),n=>{n.innerHTML=`<p>${escape(t('platform.customConnectors.approveConfirm',{name:getLocale()==='en'?p.nameEn:p.nameAr}))}</p>`;},{confirmLabel:t('platform.customConnectors.approve')});
   if(!confirmed)return;
   try{await apiClient(`/api/platform/custom-connectors/${p.id}/review`,{decision:'APPROVE'},'POST');toast(t('platform.actionSucceeded'));renderPendingCustomConnectors();}
   catch(error){toastError(error.message);}
  };
  const requestChanges=button(t('platform.customConnectors.requestChanges'),{variant:'secondary'});
  requestChanges.onclick=async()=>{
   const notes=await promptDrawer(t('platform.customConnectors.requestChanges'),n=>{
    const textarea=document.createElement('textarea');textarea.name='notes';textarea.required=true;textarea.rows=3;
    const label=document.createElement('label');label.textContent=t('platform.customConnectors.notesLabel');label.append(textarea);n.append(label);
    return {value:()=>textarea.value.trim(),focus:()=>textarea.focus()};
   },{confirmLabel:t('platform.customConnectors.requestChanges')});
   if(!notes)return;
   try{await apiClient(`/api/platform/custom-connectors/${p.id}/review`,{decision:'REQUEST_CHANGES',notes},'POST');toast(t('platform.actionSucceeded'));renderPendingCustomConnectors();}
   catch(error){toastError(error.message);}
  };
  const reject=button(t('platform.customConnectors.reject'),{variant:'danger'});
  reject.onclick=async()=>{
   const confirmed=await promptDrawer(t('platform.customConnectors.reject'),n=>{n.innerHTML=`<p>${escape(t('platform.customConnectors.rejectConfirm'))}</p>`;},{confirmLabel:t('platform.customConnectors.reject')});
   if(!confirmed)return;
   try{await apiClient(`/api/platform/custom-connectors/${p.id}/review`,{decision:'REJECT'},'POST');toast(t('platform.actionSucceeded'));renderPendingCustomConnectors();}
   catch(error){toastError(error.message);}
  };
  cell.append(view,approve,requestChanges,reject);
 }
}
/** Item 2/25 — a prominent, always-visible summary card for the whole Integration Platform.
 * Connector counts come from the SAME list the Builder table below renders (one fetch, two
 * views — never a second, divergent computation); connection/webhook health numbers reuse
 * `buildPlatformOverview`'s own real, already-aggregated platform-wide figures (Part 2 —
 * never a third, separate computation of "how many connections are unhealthy"). */
function renderIntegrationPlatformCard(connectors,overview){
 const counts={total:connectors.length,published:connectors.filter(c=>c.status==='PUBLISHED').length,draft:connectors.filter(c=>c.status==='DRAFT').length,disabled:connectors.filter(c=>c.status==='DISABLED').length,
  active:overview.healthyConnections??0,unhealthy:overview.connectionsNeedingAttention??0,failedWebhooks:overview.failedWebhooks??0};
 const host=$('#pf-integration-card');
 host.innerHTML=`<article class="card pf-integration-card">
  <div class="row-between"><h3>${escape(t('platform.builder.dashboardCardTitle'))}</h3></div>
  <div class="kpi-grid">
   ${['total','published','draft','disabled','active','unhealthy','failedWebhooks'].map(k=>`<div class="kpi-card"><span class="kpi-label">${escape(t('platform.builder.dashboardCard.'+k))}</span><strong class="kpi-value">${counts[k]}</strong></div>`).join('')}
  </div>
  <div class="report-actions"></div>
 </article>`;
 const manage=button(t('platform.builder.manageIntegrations'),{variant:'secondary'});
 manage.onclick=()=>document.getElementById('pf-connectors').scrollIntoView({behavior:'smooth'});
 const add=button(t('platform.builder.newConnector'),{variant:'primary',iconName:'plus'});
 add.onclick=()=>openConnectorWizard(null);
 host.querySelector('.report-actions').append(manage,add);
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

/**
 * Frost Command Center Phase 7B — Platform Command Center (spec Part 24-28). Deliberately NOT
 * a second, retrofitted copy of the tenant-scoped Frost chat: `frost_commander`'s whole tool
 * registry/permission model is built around a single real tenant_id threaded through every
 * call, and there is no cross-tenant "pseudo-tenant" concept anywhere in this codebase to
 * safely bind a free-text LLM loop to. Rather than inventing one (exactly the kind of "second
 * agent system for a different scope" the architecture rule forbids), platform-level questions
 * are a small, fixed set of REAL, deterministic buttons — each one a direct call to the exact
 * same `buildPlatformOverview`/`listPlatformDeadLetterWebhooks`/`listTenantsWithUnhealthyIntegrations`
 * functions the rest of this page already uses. No new aggregation, no fabricated answer, and —
 * critically — zero risk of ever leaking one tenant's business data to another (spec item 26),
 * since nothing here is a general-purpose query interface.
 */
function renderPlatformCommandCenter(overview) {
 const host=$('#pf-command-center');
 const hasIssue=overview.connectionsNeedingAttention>0||overview.agentsFailing>0||overview.failedWebhooks>0||overview.recentCriticalErrors>0;
 host.innerHTML=`<article class="card pfcc-card">
  <div class="row-between"><h3>${escape(t('platform.commandCenter.title'))}</h3>${badge(overview.schedulerRunning?t('platform.commandCenter.schedulerRunning'):t('platform.commandCenter.schedulerStopped'),overview.schedulerRunning?'CONNECTED':'ERROR')}</div>
  <div class="kpi-grid">
   ${metric(t('platform.commandCenter.anyIssues'),hasIssue?t('platform.commandCenter.yes'):t('platform.commandCenter.no'),'',hasIssue?'bell':'check')}
   ${metric(t('platform.commandCenter.reauthRequired'),overview.reauthRequired,'','plug')}
   ${metric(t('platform.commandCenter.failedWebhooks'),overview.failedWebhooks,'','plug')}
  </div>
  <div class="report-actions" id="pfcc-actions"></div>
  <div id="pfcc-result"></div>
  <h4>${escape(t('platform.commandCenter.chatTitle'))}</h4>
  <div id="pfcc-chat-messages" class="cmdc-messages pfcc-chat-messages"></div>
  <form id="pfcc-chat-form"><textarea name="text" required maxlength="2000" placeholder="${escape(t('platform.commandCenter.chatPlaceholder'))}"></textarea><button type="submit">${escape(t('platform.commandCenter.chatSend'))}</button></form>
 </article>`;
 renderPlatformFrostMessages();
 host.querySelector('#pfcc-chat-form').addEventListener('submit',onPlatformFrostSend);
 const deadLetterButton=button(t('platform.commandCenter.showDeadLetter'),{variant:'secondary'});
 deadLetterButton.onclick=async()=>{
  const resultHost=host.querySelector('#pfcc-result');
  try{
   const rows=await apiClient('/api/platform/webhooks/dead-letter');
   resultHost.innerHTML=rows.length?table([t('platform.operations.tenantId'),t('platform.operations.connector'),'status',t('platform.operations.receivedAt')],
    rows.map(r=>[`<span dir="ltr" class="kpi-context">${escape(r.tenantId||'—')}</span>`,escape(r.source),escape(r.status),new Date(r.receivedAt).toLocaleString(getLocale()==='en'?'en-US':'ar-SA')])
   ):empty(t('platform.commandCenter.noDeadLetter'));
  }catch(error){toastError(error.message);}
 };
 const unhealthyButton=button(t('platform.commandCenter.showUnhealthyTenants'),{variant:'secondary'});
 unhealthyButton.onclick=async()=>{
  const resultHost=host.querySelector('#pfcc-result');
  try{
   const rows=await apiClient('/api/platform/tenants/unhealthy-integrations');
   resultHost.innerHTML=rows.length?table([t('platform.table.name'),t('platform.commandCenter.unhealthyCount')],
    rows.map(r=>[escape(r.tenantName),escape(r.unhealthyConnections)])
   ):empty(t('platform.commandCenter.noUnhealthyTenants'));
  }catch(error){toastError(error.message);}
 };
 host.querySelector('#pfcc-actions').append(deadLetterButton,unhealthyButton);
}
// Deliberately its OWN class names, not command-center.js's `.cmdc-message-*` — those are a
// real, page-global CSS selector (queried directly by document.querySelectorAll elsewhere),
// and Platform Frost is a genuinely separate chat (different table, different page) that must
// never be found by a selector meant for tenant Command Center messages.
function platformFrostBubble(message) {
 return `<div class="cmdc-message pfcc-message-${escape(message.role)}"><p>${escape(message.content)}</p></div>`;
}
async function renderPlatformFrostMessages() {
 const host=$('#pfcc-chat-messages');
 if(!host)return;
 try {
  const messages=await apiClient('/api/platform/frost/messages');
  host.innerHTML=messages.length?messages.map(platformFrostBubble).join(''):empty(t('platform.commandCenter.noMessages'));
  host.scrollTop=host.scrollHeight;
 } catch { host.innerHTML=''; }
}
async function onPlatformFrostSend(event) {
 // Same reason as command-center.js's onSendMessage: app.js's global submit handler must not
 // also treat this as a generic /api/content/:id/:action form.
 event.preventDefault();
 event.stopPropagation();
 const form=event.target,textarea=form.querySelector('textarea'),submitButton=form.querySelector('button');
 const text=textarea.value.trim();
 if(!text)return;
 submitButton.disabled=true;
 try {
  const host=$('#pfcc-chat-messages');
  if(host.querySelector('.empty'))host.innerHTML='';
  host.insertAdjacentHTML('beforeend',platformFrostBubble({role:'user',content:text}));
  textarea.value='';
  const result=await apiClient('/api/platform/frost/messages',{text});
  host.insertAdjacentHTML('beforeend',platformFrostBubble(result.assistantMessage));
  host.scrollTop=host.scrollHeight;
 } catch(error) { toastError(error.message); }
 finally { submitButton.disabled=false; textarea.focus(); }
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
  <h4>${escape(t('platform.customConnectorLimit.title'))}</h4>
  <p class="kpi-context">${escape(t('platform.customConnectorLimit.hint'))}</p>
  <p>${escape(t('platform.customConnectorLimit.current',{count:detail.customConnectors.count,limit:detail.customConnectors.effectiveLimit}))} ${detail.customConnectors.limitOverride!=null?badge(t('platform.customConnectorLimit.overridden'),'PENDING'):badge(t('platform.customConnectorLimit.globalDefault'),'CONNECTED')}</p>
  <div id="pf-custom-limit-form"></div>
  <h4>${escape(t('platform.recentAudit'))}</h4>
  <div>${detail.recentAudit.slice(0,10).map(a=>`<div class="audit-row">${escape(a.action)}<time>${new Date(a.at).toLocaleString(getLocale()==='en'?'en-US':'ar-SA')}</time></div>`).join('')||empty(t('operationsLog.noneRecordedYet'))}</div>`;
 // Phase 6H, Part 37-42 — Per-tenant Custom Connector Limit Override.
 const limitForm=node.querySelector('#pf-custom-limit-form');
 limitForm.innerHTML=`<label class="check"><input type="radio" name="limitMode" value="default" ${detail.customConnectors.limitOverride==null?'checked':''}> ${escape(t('platform.customConnectorLimit.useDefault'))}</label>
  <label class="check"><input type="radio" name="limitMode" value="custom" ${detail.customConnectors.limitOverride!=null?'checked':''}> ${escape(t('platform.customConnectorLimit.useCustom'))}</label>
  <label>${escape(t('platform.customConnectorLimit.customValue'))}<input type="number" name="limitValue" min="0" max="1000" value="${escape(detail.customConnectors.limitOverride??3)}" ${detail.customConnectors.limitOverride==null?'disabled':''}></label>`;
 const limitValueInput=limitForm.querySelector('[name=limitValue]');
 limitForm.querySelectorAll('[name=limitMode]').forEach(radio=>radio.onchange=()=>{limitValueInput.disabled=limitForm.querySelector('[name=limitMode]:checked').value==='default';});
 const saveLimit=button(t('common.save'),{variant:'secondary'});
 saveLimit.onclick=async()=>{
  const mode=limitForm.querySelector('[name=limitMode]:checked').value;
  const limit=mode==='default'?null:Number(limitValueInput.value);
  if(mode==='custom' && (!Number.isInteger(limit)||limit<0)){toastError(t('platform.customConnectorLimit.invalidValue'));return;}
  try{await apiClient(`/api/platform/tenants/${tenant.id}/custom-connector-limit`,{limit},'POST');toast(t('platform.actionSucceeded'));dialog.close();openTenantDetail(tenant);}
  catch(error){toastError(error.message);}
 };
 limitForm.append(saveLimit);
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
const AUTH_TYPES=['API_KEY','BEARER_TOKEN','BASIC','NONE','OAUTH2'];
const WEBHOOK_AUTH_TYPES=['HMAC','HEADER_TOKEN','SHARED_SECRET','NONE'];

let lastConnectorsList=[],connectorsFilter='ALL';
/** The Builder landing page (item 5): a prominent create action, status tabs, and a full,
 * real-data table — `connectors` is the SAME list `renderPlatformPage` already fetched once
 * (shared with the dashboard card above), never a second, divergent fetch. */
function renderConnectorsSection(connectors){
 lastConnectorsList=connectors;
 const host=$('#pf-connectors');
 host.innerHTML=`<div class="report-section-head"><h3>${escape(t('platform.builder.sectionTitle'))}</h3></div>
  <p class="kpi-context">${escape(t('platform.builder.sectionHint'))}</p>
  <div id="pf-connectors-tabs"></div>
  <div id="pf-connectors-list"></div>`;
 const newButton=button(t('platform.builder.newConnector'),{variant:'primary',iconName:'plus'});
 newButton.onclick=()=>openConnectorWizard(null);
 const importButton=button(t('platform.builder.import'),{variant:'secondary'});
 const fileInput=document.createElement('input');fileInput.type='file';fileInput.accept='application/json';fileInput.hidden=true;
 importButton.onclick=()=>fileInput.click();
 fileInput.onchange=async()=>{
  const file=fileInput.files?.[0];fileInput.value='';
  if(!file)return;
  let parsed;
  try{parsed=JSON.parse(await file.text());}catch{toastError(t('platform.builder.importInvalidFile'));return;}
  const newSlug=await promptDrawer(t('platform.builder.import'),node=>{
   const input=document.createElement('input');input.name='slug';input.required=true;input.pattern='[a-z][a-z0-9_-]*';input.maxLength=60;input.dir='ltr';input.value=parsed.slug||'';
   const label=document.createElement('label');label.textContent=t('platform.builder.fields.slug');label.append(input);node.append(label);
   return {value:()=>input.value.trim(),focus:()=>input.focus()};
  },{confirmLabel:t('platform.builder.import')});
  if(!newSlug)return;
  try{
   const imported=await apiClient('/api/platform/connectors/import',{definition:parsed,slug:newSlug});
   toast(t('common.savedSuccessfully'));
   await renderConnectorsSectionRefresh();
   openConnectorWizard(imported);
  }catch(error){toastError(error.message);}
 };
 host.querySelector('.report-section-head').append(newButton,importButton,fileInput);
 const tabsHost=host.querySelector('#pf-connectors-tabs');
 const filterPanels=['ALL','DRAFT','PUBLISHED','DISABLED'].map(()=>{const el=document.createElement('div');el.hidden=true;return el;});
 tabsHost.append(...filterPanels);
 const {select}=tabs(tabsHost,[
  [t('platform.builder.filters.all'),filterPanels[0]],
  [t('platform.builder.filters.draft'),filterPanels[1]],
  [t('platform.builder.filters.published'),filterPanels[2]],
  [t('platform.builder.filters.disabled'),filterPanels[3]]
 ]);
 const statusByIndex=['ALL','DRAFT','PUBLISHED','DISABLED'];
 tabsHost.querySelectorAll('[role=tab]').forEach((tabButton,index)=>{tabButton.addEventListener('click',()=>{connectorsFilter=statusByIndex[index];paintConnectorsList(host.querySelector('#pf-connectors-list'),lastConnectorsList);});});
 select(statusByIndex.indexOf(connectorsFilter)===-1?0:statusByIndex.indexOf(connectorsFilter));
 paintConnectorsList(host.querySelector('#pf-connectors-list'),connectors);
}
function paintConnectorsList(container,list){
 const filtered=connectorsFilter==='ALL'?list:list.filter(c=>c.status===connectorsFilter);
 const noCustomIntegrationsYet=connectorsFilter==='ALL' && list.every(c=>c.isSystem);
 if(!filtered.length){
  container.innerHTML=noCustomIntegrationsYet?empty(t('platform.builder.emptyState'),t('platform.builder.emptyStateHint')):empty(t('common.noResults'));
  if(noCustomIntegrationsYet){
   const createButton=button(t('platform.builder.newConnector'),{variant:'primary',iconName:'plus'});
   createButton.onclick=()=>openConnectorWizard(null);
   container.querySelector('.empty')?.append(createButton);
  }
  return;
 }
 container.innerHTML=table(
  [t('platform.builder.table.name'),t('platform.builder.table.category'),t('platform.builder.table.adapter'),t('platform.builder.table.auth'),t('platform.builder.table.capabilities'),t('platform.builder.table.actionsCount'),t('platform.builder.table.webhooksCount'),t('platform.builder.table.status'),t('platform.builder.table.version'),t('platform.builder.table.connections'),t('platform.builder.table.updated'),t('platform.builder.table.actions')],
  filtered.map(c=>[
   `${escape(getLocale()==='en'?c.nameEn:c.nameAr)} <span dir="ltr" class="kpi-context">${escape(c.slug)}</span>`,
   escape(c.category),
   `<span dir="ltr">${escape(c.adapterType)}</span>`,
   escape(c.authConfig?.type||c.authType),
   `<span dir="ltr">${(c.capabilities||[]).map(escape).join(', ')||'—'}</span>`,
   escape(c.actionsCount??0),
   escape(c.triggersCount??0),
   badge(t('platform.builder.status.'+c.status)||c.status,c.status==='PUBLISHED'?'CONNECTED':c.status==='DRAFT'?'PENDING':'DISCONNECTED'),
   escape(c.version),
   escape(c.connectionsCount),
   c.updatedAt?new Date(c.updatedAt).toLocaleDateString(getLocale()==='en'?'en-US':'ar-SA'):'—',
   `<span data-row-actions="${escape(c.id)}"></span>`
  ])
 );
 for(const c of filtered){
  const cell=container.querySelector(`[data-row-actions="${CSS.escape(c.id)}"]`);
  const manage=button(t('platform.builder.manage'),{variant:'secondary'});
  manage.onclick=()=>openConnectorWizard(c);
  cell.append(manage);
  if(!c.isSystem){
   const clone=button(t('platform.builder.clone'),{variant:'ghost'});
   clone.onclick=()=>startCloneConnector(c);
   const exportButton=button(t('platform.builder.export'),{variant:'ghost'});
   exportButton.onclick=()=>exportConnectorToFile(c);
   cell.append(clone,exportButton);
  }
 }
}
/** Item 7/23/24 — a real, new DRAFT copy of the declarative shape (never a system connector,
 * never a credential — see cloneConnectorDefinition's own doc comment). */
function startCloneConnector(summary){
 promptDrawer(t('platform.builder.clone'),node=>{
  const input=document.createElement('input');input.name='slug';input.required=true;input.pattern='[a-z][a-z0-9_-]*';input.maxLength=60;input.dir='ltr';input.value=summary.slug+'_copy';
  const label=document.createElement('label');label.textContent=t('platform.builder.fields.slug');label.append(input);node.append(label);
  return {value:()=>input.value.trim(),focus:()=>input.focus()};
 },{confirmLabel:t('platform.builder.clone')}).then(async newSlug=>{
  if(!newSlug)return;
  try{
   const cloned=await apiClient(`/api/platform/connectors/${summary.id}/clone`,{slug:newSlug});
   toast(t('common.savedSuccessfully'));
   await renderConnectorsSectionRefresh();
   openConnectorWizard(cloned);
  }catch(error){toastError(error.message);}
 });
}
/** Item 8/22 — safe, portable JSON, declarative shape only (verified secret-free by
 * construction). The viewer's sandbox blocks script-driven file saves in a published Artifact,
 * but this is the real app, not an artifact — a plain download anchor works normally here. */
async function exportConnectorToFile(summary){
 try{
  const exported=await apiClient(`/api/platform/connectors/${summary.id}/export`);
  const blob=new Blob([JSON.stringify(exported,null,1)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=`${summary.slug}.connector.json`;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(error){toastError(error.message);}
}
async function renderConnectorsSectionRefresh(){
 try{const list=await apiClient('/api/platform/connectors');renderConnectorsSection(list);}catch{/* best-effort refresh only */}
}
/** Cross-page shortcut (item 20/M): the Control Center's "إدارة التكامل" button imports this
 * directly rather than depending on the Builder table already being rendered — it fetches the
 * one real definition it needs and opens the SAME wizard, whether or not this page has loaded
 * its own list yet. */
export async function openConnectorWizardBySlug(slug){
 if(!apiClient)return;
 let list;
 try{list=await apiClient('/api/platform/connectors');}catch(error){toastError(error.message);return;}
 const summary=list.find(c=>c.slug===slug);
 if(!summary){toastError(t('platform.builder.notFound'));return;}
 openConnectorWizard(summary);
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
 // Phase 6H, Part 1/4 — a persistent, always-visible banner (never buried in one tab) so a
 // Platform Admin editing a draft never forgets the LIVE version keeps serving new connections
 // completely unaffected the whole time.
 const draftBanner=document.createElement('div');draftBanner.hidden=true;
 const basicPanel=document.createElement('div');basicPanel.className='builder-basic-panel';
 const actionsPanel=document.createElement('div'),
       webhooksPanel=document.createElement('div'),healthPanel=document.createElement('div'),
       versionsPanel=document.createElement('div'),reviewPanel=document.createElement('div'),
       analyticsPanel=document.createElement('div');
 node.append(draftBanner,basicPanel,actionsPanel,webhooksPanel,healthPanel,versionsPanel,reviewPanel,analyticsPanel);
 // Item 7 — the numbered steps stay visible in every tab label even though steps 1-3 share one
 // panel (the Builder's create call is atomic — see the Basics panel's own doc comment) — a
 // Platform Admin always sees where they are in the full 8-step flow.
 const tabBar=tabs(node,[
  [`1-3. ${t('platform.builder.tabBasic')} / ${t('platform.builder.tabAuth')} / ${t('platform.builder.tabCapabilities')}`,basicPanel],
  [`4. ${t('platform.builder.tabActions')}`,actionsPanel],
  [`5. ${t('platform.builder.tabWebhooks')}`,webhooksPanel],
  [`6. ${t('platform.builder.tabHealth')}`,healthPanel],
  [`7. ${t('platform.builder.tabVersions')}`,versionsPanel],
  [`8. ${t('platform.builder.tabReview')}`,reviewPanel],
  [`9. ${t('platform.builder.tabAnalytics')}`,analyticsPanel]
 ]);
 const dialog=drawer(summary?(getLocale()==='en'?summary.nameEn:summary.nameAr):t('platform.builder.wizardTitleNew'),node);
 let detail=summary?null:{actions:[],triggers:[],restConfig:null,authConfig:null,capabilities:[]};

 async function reload(){
  if(!definitionId){paintBasic();gateOtherTabs();return;}
  try{detail=await apiClient(`/api/platform/connectors/${definitionId}`);}
  catch(error){toastError(error.message);return;}
  paintDraftBanner();
  paintBasic();paintActions();paintWebhooks();paintHealth();paintVersions();paintReview();paintAnalytics();gateOtherTabs();
 }
 function paintDraftBanner(){
  draftBanner.hidden=!detail?.hasDraft;
  if(!detail?.hasDraft)return;
  draftBanner.innerHTML=`<p class="notice">${escape(t('platform.builder.draftBanner',{version:detail.liveVersion}))}</p>`;
  const discard=button(t('platform.builder.discardDraft'),{variant:'ghost'});
  discard.onclick=async()=>{
   const confirmed=await promptDrawer(t('platform.builder.discardDraft'),n=>{n.innerHTML=`<p>${escape(t('platform.builder.discardDraftConfirm'))}</p>`;},{confirmLabel:t('platform.builder.discardDraft')});
   if(!confirmed)return;
   try{await apiClient(`/api/platform/connectors/${definitionId}/versions/discard`,{},'POST');toast(t('platform.actionSucceeded'));await reload();}
   catch(error){toastError(error.message);}
  };
  draftBanner.append(discard);
 }
 function gateOtherTabs(){
  const disabled=!definitionId;
  [actionsPanel,webhooksPanel,healthPanel,versionsPanel,reviewPanel,analyticsPanel].forEach(panel=>{
   if(disabled)panel.innerHTML=empty(t('platform.builder.createFirst'));
  });
 }

 function paintBasic(){
  const d=detail||{};
  basicPanel.innerHTML=`
   <h4>${escape(t('platform.builder.stepBasicInfo'))}</h4>
   <label>${escape(t('platform.builder.fields.slug'))}<input name="slug" dir="ltr" ${definitionId?'disabled':''} value="${escape(d.slug||'')}" required pattern="[a-z][a-z0-9_-]*" maxlength="60"></label>
   <label>${escape(t('platform.builder.fields.nameAr'))}<input name="nameAr" value="${escape(d.nameAr||'')}" required maxlength="100"></label>
   <label>${escape(t('platform.builder.fields.nameEn'))}<input name="nameEn" dir="ltr" value="${escape(d.nameEn||'')}" required maxlength="100"></label>
   <label>${escape(t('platform.builder.fields.category'))}<input name="category" value="${escape(d.category||'custom')}" maxlength="40"></label>
   <label>${escape(t('platform.builder.fields.descriptionAr'))}<textarea name="descriptionAr" maxlength="500">${escape(d.descriptionAr||'')}</textarea></label>
   <label>${escape(t('platform.builder.fields.descriptionEn'))}<textarea name="descriptionEn" dir="ltr" maxlength="500">${escape(d.descriptionEn||'')}</textarea></label>
   <label>${escape(t('platform.builder.fields.connectionMode'))}<select name="connectionMode" ${definitionId?'disabled':''}>${['SINGLE','MULTI'].map(m=>`<option value="${m}" ${d.connectionMode===m?'selected':''}>${escape(t('controlCenter.connectionMode.'+m))}</option>`).join('')}</select></label>
   <label>${escape(t('platform.builder.fields.baseUrl'))}<input name="baseUrl" dir="ltr" value="${escape(d.restConfig?.baseUrl||'')}" required placeholder="https://api.example.com"></label>
   <label class="check"><input type="checkbox" name="allowHttp" ${d.restConfig?.allowHttp?'checked':''}> ${escape(t('platform.builder.fields.allowHttp'))}</label>
   <h4>${escape(t('platform.builder.stepAuth'))}</h4>
   <label>${escape(t('platform.builder.fields.authType'))}<select name="authType" ${definitionId?'disabled':''}>${AUTH_TYPES.map(a=>`<option value="${a}" ${(d.authConfig?.type||'API_KEY')===a?'selected':''}>${escape(a)}</option>`).join('')}</select></label>
   <label data-header-name-row>${escape(t('platform.builder.fields.headerName'))}<input name="headerName" dir="ltr" value="${escape(d.authConfig?.headerName||'X-Api-Key')}"></label>
   <div data-oauth2-fields>
    <p class="notice">${escape(t('platform.builder.oauth2Note'))}</p>
    <label>${escape(t('platform.builder.fields.authorizeUrl'))}<input name="authorizeUrl" dir="ltr" value="${escape(d.authConfig?.authorizeUrl||'')}" placeholder="https://provider.example.com/oauth/authorize"></label>
    <label>${escape(t('platform.builder.fields.tokenUrl'))}<input name="tokenUrl" dir="ltr" value="${escape(d.authConfig?.tokenUrl||'')}" placeholder="https://provider.example.com/oauth/token"></label>
    <label>${escape(t('platform.builder.fields.scopes'))}<input name="scopes" dir="ltr" value="${escape((d.authConfig?.scopes||[]).join(' '))}" placeholder="read_orders read_customers"></label>
    <label>${escape(t('platform.builder.fields.identityEndpoint'))}<input name="identityEndpoint" dir="ltr" value="${escape(d.authConfig?.identityEndpoint||'')}" placeholder="https://provider.example.com/me (optional)"></label>
    <label>${escape(t('platform.builder.fields.clientAuthMethod'))}<select name="clientAuthMethod">${['body','basic'].map(m=>`<option value="${m}" ${(d.authConfig?.clientAuthMethod||'body')===m?'selected':''}>${escape(m)}</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" name="pkce" ${d.authConfig?.pkce?'checked':''}> ${escape(t('platform.builder.fields.pkce'))}</label>
    <label>${escape(t('platform.builder.fields.clientIdEnvKey'))}<input name="clientIdEnvKey" dir="ltr" value="${escape(d.authConfig?.clientIdEnvKey||'')}" placeholder="ACME_CLIENT_ID"></label>
    <label>${escape(t('platform.builder.fields.clientSecretEnvKey'))}<input name="clientSecretEnvKey" dir="ltr" value="${escape(d.authConfig?.clientSecretEnvKey||'')}" placeholder="ACME_CLIENT_SECRET"></label>
    <p class="kpi-context">${escape(t('platform.builder.oauthNote'))}</p>
   </div>
   <h4>${escape(t('platform.builder.stepCapabilities'))}</h4>
   <fieldset><legend>${escape(t('platform.builder.fields.capabilities'))}</legend>
    ${capabilityRegistry.map(c=>`<label class="check"><input type="checkbox" name="cap" value="${escape(c.id)}" ${(d.capabilities||[]).includes(c.id)?'checked':''}> <span dir="ltr">${escape(c.id)}</span> — ${escape(getLocale()==='en'?c.descriptionEn:c.descriptionAr)}</label>`).join('')}
   </fieldset>
   <div class="report-actions" id="basic-actions"></div>`;
  const authSelect=basicPanel.querySelector('[name=authType]');
  const syncHeaderRow=()=>{
   basicPanel.querySelector('[data-header-name-row]').hidden=authSelect.value!=='API_KEY';
   basicPanel.querySelector('[data-oauth2-fields]').hidden=authSelect.value!=='OAUTH2';
  };
  authSelect.onchange=syncHeaderRow;syncHeaderRow();
  const saveButton=button(definitionId?t('platform.builder.saveChanges'):t('platform.builder.createDraft'),{variant:'primary'});
  saveButton.onclick=async()=>{
   const val=name=>basicPanel.querySelector(`[name=${name}]`).value.trim();
   const caps=[...basicPanel.querySelectorAll('[name=cap]:checked')].map(el=>el.value);
   const auth=authSelect.value==='API_KEY'?{type:'API_KEY',headerName:val('headerName')||'X-Api-Key'}
    :authSelect.value==='NONE'?{type:'NONE',allowNone:true}
    :authSelect.value==='OAUTH2'?{
     type:'OAUTH2',authorizeUrl:val('authorizeUrl'),tokenUrl:val('tokenUrl'),
     scopes:val('scopes')?val('scopes').split(/\s+/).filter(Boolean):[],
     identityEndpoint:val('identityEndpoint')||undefined,clientAuthMethod:basicPanel.querySelector('[name=clientAuthMethod]').value,
     pkce:basicPanel.querySelector('[name=pkce]').checked,clientIdEnvKey:val('clientIdEnvKey'),clientSecretEnvKey:val('clientSecretEnvKey')
    }:{type:authSelect.value};
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
    <label>${escape(t('platform.builder.fields.responseMappingArrayFrom'))}<input name="arrayFrom" dir="ltr" placeholder="invoices"></label>
    <h4>${escape(t('platform.builder.mappingPreviewTitle'))}</h4>
    <label>${escape(t('platform.builder.samplePayloadLabel'))}<textarea name="samplePayload" dir="ltr" rows="4" placeholder='{"invoices":[{"id":"inv1","total":250}]}'></textarea></label>
    <div id="mapping-preview-actions" class="report-actions"></div>
    <div id="mapping-preview-result"></div>`;
   const previewButton=button(t('platform.builder.previewMapping'),{variant:'secondary'});
   previewButton.onclick=async()=>{
    const resultHost=n.querySelector('#mapping-preview-result');
    let samplePayload;
    try{samplePayload=JSON.parse(n.querySelector('[name=samplePayload]').value||'{}');}
    catch{resultHost.innerHTML=`<p class="notice trial-banner-warning">${escape(t('controlCenter.invalidJson'))}</p>`;return;}
    const arrayFrom=n.querySelector('[name=arrayFrom]').value.trim();
    const mapping=arrayFrom?{array:{from:arrayFrom,item:{}}}:{object:{}};
    try{
     const preview=await apiClient('/api/platform/mapping-preview',{mapping,samplePayload});
     resultHost.innerHTML=preview.ok?`<pre dir="ltr">${escape(JSON.stringify(preview.result,null,1)).slice(0,1500)}</pre>`:`<p class="notice trial-banner-warning">${escape(preview.message||preview.errorCode)}</p>`;
    }catch(error){resultHost.innerHTML=`<p class="notice trial-banner-warning">${escape(error.message)}</p>`;}
   };
   n.querySelector('#mapping-preview-actions').append(previewButton);
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
  // Phase 6H, Part 10-12 — Bulk Webhook Reprocess, offered whenever this connector declares at
  // least one trigger (the only case any webhook_events row could ever exist for it).
  if(list.length){
   const reprocessButton=button(t('platform.builder.bulkReprocess.button'),{variant:'secondary'});
   reprocessButton.onclick=()=>openBulkReprocessDrawer();
   webhooksPanel.append(reprocessButton);
  }
 }
 // Phase 6H, Part 10-12 — Bulk Webhook Reprocess drawer: a real, live, network-free preview
 // (exact total count + a bounded oldest-first sample + a per-error-code breakdown) before any
 // reprocessing runs, an explicit per-event selection (never a silent "all matching" at execution
 // time), and results that clearly distinguish PROCESSED from STILL_FAILED/SKIPPED/FAILED.
 function openBulkReprocessDrawer(){
  const node=document.createElement('div');
  node.innerHTML=`
   <label>${escape(t('platform.builder.bulkReprocess.tenantId'))}<input name="tenantId" dir="ltr" placeholder="${escape(t('platform.builder.bulkReprocess.optional'))}"></label>
   <label>${escape(t('platform.builder.bulkReprocess.errorCode'))}<input name="errorCode" dir="ltr" placeholder="WEBHOOK_MAPPING_FAILED"></label>
   <label>${escape(t('platform.builder.bulkReprocess.fromDate'))}<input name="fromDate" type="date"></label>
   <label>${escape(t('platform.builder.bulkReprocess.toDate'))}<input name="toDate" type="date"></label>
   <div class="report-actions" id="reprocess-filter-actions"></div>
   <div id="reprocess-preview"></div>
   <div id="reprocess-list"></div>
   <div class="report-actions" id="reprocess-actions"></div>
   <div id="reprocess-results"></div>`;
  const dialog=drawer(t('platform.builder.bulkReprocess.button'),node);
  function filterParams(){
   const val=name=>node.querySelector(`[name=${name}]`).value.trim();
   const tenantId=val('tenantId'),errorCode=val('errorCode'),fromDate=val('fromDate'),toDate=val('toDate');
   return {tenantId:tenantId||null,errorCode:errorCode||null,fromDate:fromDate||null,toDate:toDate||null};
  }
  async function refreshPreview(){
   const {tenantId,errorCode,fromDate,toDate}=filterParams();
   const previewHost=node.querySelector('#reprocess-preview'),listHost=node.querySelector('#reprocess-list'),actionsHost=node.querySelector('#reprocess-actions');
   actionsHost.innerHTML='';node.querySelector('#reprocess-results').innerHTML='';
   previewHost.innerHTML=skeleton(t('common.loading'));
   const qs=new URLSearchParams({connectorSlug:detail.slug});
   if(tenantId)qs.set('tenantId',tenantId);if(errorCode)qs.set('errorCode',errorCode);
   if(fromDate)qs.set('fromDate',fromDate);if(toDate)qs.set('toDate',toDate);
   let preview;
   try{preview=await apiClient(`/api/platform/bulk/webhook-reprocess/preview?${qs.toString()}`);}
   catch(error){previewHost.innerHTML=empty(t('controlCenter.loadFailed'),error.message);listHost.innerHTML='';return;}
   previewHost.innerHTML=`<div class="kpi-grid">
    ${['totalMatched','willAttempt','tenants'].map(k=>`<div class="kpi-card"><span class="kpi-label">${escape(t('platform.builder.bulkReprocess.'+k))}</span><strong class="kpi-value">${preview[k]}</strong></div>`).join('')}
   </div>`+(Object.keys(preview.byErrorCode).length?`<p>${Object.entries(preview.byErrorCode).map(([code,count])=>`<span dir="ltr">${escape(code)}: ${count}</span>`).join(' · ')}</p>`:'');
   if(!preview.events.length){listHost.innerHTML=empty(t('common.noResults'));return;}
   listHost.innerHTML=preview.events.map(e=>`<label class="check"><input type="checkbox" name="evt" value="${escape(e.id)}" checked> <span dir="ltr">${escape(e.errorCode||'—')}</span> — <span dir="ltr" class="kpi-context">${escape(e.tenantId)}</span> — ${new Date(e.receivedAt).toLocaleString(getLocale()==='en'?'en-US':'ar-SA')}</label>`).join('');
   const reprocessButton=button(t('platform.builder.bulkReprocess.reprocessSelected'),{variant:'primary'});
   reprocessButton.onclick=async()=>{
    const selected=[...listHost.querySelectorAll('[name=evt]:checked')].map(el=>el.value);
    if(!selected.length){toastError(t('platform.builder.bulk.noneSelected'));return;}
    const confirmed=await promptDrawer(t('platform.builder.bulkReprocess.reprocessSelected'),n=>{n.innerHTML=`<p>${escape(t('platform.builder.bulkReprocess.reprocessConfirm',{count:selected.length}))}</p>`;},{confirmLabel:t('platform.builder.bulkReprocess.reprocessSelected')});
    if(!confirmed)return;
    try{
     const result=await apiClient('/api/platform/bulk/webhook-reprocess',{connectorSlug:detail.slug,eventIds:selected});
     renderReprocessResults(node.querySelector('#reprocess-results'),result);
    }catch(error){toastError(error.message);}
   };
   actionsHost.append(reprocessButton);
  }
  const filterButton=button(t('platform.builder.bulkReprocess.applyFilter'),{variant:'ghost'});
  filterButton.onclick=refreshPreview;
  node.querySelector('#reprocess-filter-actions').append(filterButton);
  refreshPreview();
 }
 function renderReprocessResults(host,result){
  host.innerHTML=`<h4>${escape(t('platform.builder.bulk.resultsTitle'))}</h4>
   <div class="kpi-grid">
    ${['processed','stillFailed','skipped','failed'].map(k=>`<div class="kpi-card"><span class="kpi-label">${escape(t('platform.builder.bulkReprocess.'+k))}</span><strong class="kpi-value">${result.summary[k]}</strong></div>`).join('')}
   </div>`+table(
    [t('platform.builder.bulkReprocess.eventId'),t('controlCenter.statusLabel'),'reason'],
    result.results.map(r=>[`<span dir="ltr">${escape(r.eventId)}</span>`,badge(r.status,r.status==='PROCESSED'?'CONNECTED':r.status==='SKIPPED'?'PENDING':'ERROR'),escape(r.reason||'—')])
   );
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

 // Phase 6G, Part 2-4 — Versions tab: every real, permanent snapshot plus a synthetic "working
 // copy" row while a new draft version is being prepared, real connectionsPinned counts, and a
 // "Create New Draft Version" action that never touches the currently published snapshot.
 async function paintVersions(){
  if(!definitionId)return;
  if(detail.isSystem){versionsPanel.innerHTML=empty(t('platform.builder.systemReadonlyNote'));return;}
  versionsPanel.innerHTML=skeleton(t('common.loading'));
  let versions;
  try{versions=await apiClient(`/api/platform/connectors/${definitionId}/versions`);}
  catch(error){versionsPanel.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
  versionsPanel.innerHTML=`<div id="versions-table"></div><div id="versions-diff"></div><div class="report-actions" id="versions-actions"></div>`;
  versionsPanel.querySelector('#versions-table').innerHTML=table(
   [t('platform.builder.versions.version'),t('platform.builder.versions.status'),t('platform.builder.versions.publishedAt'),t('platform.builder.versions.connectionsPinned'),t('platform.builder.versions.changeType'),t('platform.builder.versions.diff')],
   versions.map(v=>[
    escape(v.version),
    badge(t('platform.builder.versions.statusValue.'+v.status)||v.status,v.status==='LIVE'?'CONNECTED':v.status==='DRAFT'?'PENDING':'DISCONNECTED'),
    v.publishedAt?new Date(v.publishedAt).toLocaleString(getLocale()==='en'?'en-US':'ar-SA'):'—',
    escape(v.connectionsPinned),
    escape(v.changeType),
    `<span data-diff-btn="${v.version}"></span>`
   ])
  );
  const publishedVersions=versions.filter(v=>v.status!=='DRAFT').map(v=>v.version);
  for(const v of versions){
   if(v.status==='DRAFT'||v.version===Math.min(...publishedVersions))continue;
   const diffButton=button(t('platform.builder.versions.compareToPrevious'),{variant:'ghost'});
   diffButton.onclick=()=>showVersionDiff(v.version-1,v.version);
   versionsPanel.querySelector(`[data-diff-btn="${v.version}"]`).append(diffButton);
  }
  const actionsHost=versionsPanel.querySelector('#versions-actions');
  // Phase 6H, Part 6-9 — Bulk Connection Version Migration, offered whenever at least 2 real
  // versions exist (something to migrate FROM and TO).
  const realVersions=versions.filter(v=>v.status!=='DRAFT');
  if(realVersions.length>=2){
   const bulkButton=button(t('platform.builder.bulk.button'),{variant:'secondary'});
   bulkButton.onclick=()=>openBulkMigrationDrawer(realVersions);
   actionsHost.append(bulkButton);
  }
  if(detail.status==='PUBLISHED' && !detail.hasDraft){
   const draftButton=button(t('platform.builder.versions.createDraftVersion'),{variant:'primary'});
   draftButton.onclick=async()=>{
    const confirmed=await promptDrawer(t('platform.builder.versions.createDraftVersion'),n=>{n.innerHTML=`<p>${escape(t('platform.builder.versions.createDraftVersionConfirm'))}</p>`;},{confirmLabel:t('platform.builder.versions.createDraftVersion')});
    if(!confirmed)return;
    try{await apiClient(`/api/platform/connectors/${definitionId}/versions/draft`,{},'POST');toast(t('common.savedSuccessfully'));await reload();refreshConnectorsListInBackground();}
    catch(error){toastError(error.message);}
   };
   actionsHost.append(draftButton);
  }
 }
 async function showVersionDiff(from,to){
  const host=versionsPanel.querySelector('#versions-diff');
  host.innerHTML=skeleton(t('common.loading'));
  try{
   const {diff}=await apiClient(`/api/platform/connectors/${definitionId}/versions/diff?from=${from}&to=${to}`);
   const lines=[];
   if(diff.capabilities.added.length)lines.push(`+ ${t('platform.builder.fields.capabilities')}: ${diff.capabilities.added.join(', ')}`);
   if(diff.capabilities.removed.length)lines.push(`- ${t('platform.builder.fields.capabilities')}: ${diff.capabilities.removed.join(', ')}`);
   for(const a of diff.actions.added)lines.push(`+ action: ${a}`);
   for(const a of diff.actions.removed)lines.push(`- action: ${a}`);
   for(const a of diff.actions.changed)lines.push(`~ action ${a.slug}: ${a.changedFields.join(', ')}`);
   for(const tr of diff.triggers.added)lines.push(`+ trigger: ${tr}`);
   for(const tr of diff.triggers.removed)lines.push(`- trigger: ${tr}`);
   for(const tr of diff.triggers.changed)lines.push(`~ trigger ${tr.slug}: ${tr.changedFields.join(', ')}`);
   if(diff.auth.changed)lines.push(`~ auth: ${diff.auth.from} → ${diff.auth.to}`);
   if(diff.health.changed)lines.push(`~ health check changed`);
   if(diff.connectionMode.changed)lines.push(`~ connectionMode: ${diff.connectionMode.from} → ${diff.connectionMode.to}`);
   host.innerHTML=`<h4>${escape(t('platform.builder.versions.diffTitle',{from,to}))}</h4>`+(lines.length?`<pre dir="ltr">${escape(lines.join('\n'))}</pre>`:empty(t('platform.builder.versions.noDifferences')));
  }catch(error){host.innerHTML=empty(t('controlCenter.loadFailed'),error.message);}
 }

 // Phase 6H, Part 6-9 — Bulk Connection Version Migration.
 function openBulkMigrationDrawer(realVersions){
  const node=document.createElement('div');
  const options=realVersions.map(v=>v.version);
  node.innerHTML=`
   <label>${escape(t('platform.builder.bulk.fromVersion'))}<select name="from">${options.map(v=>`<option value="${v}" ${v===options[0]?'selected':''}>${v}</option>`).join('')}</select></label>
   <label>${escape(t('platform.builder.bulk.toVersion'))}<select name="to">${options.map(v=>`<option value="${v}" ${v===options[options.length-1]?'selected':''}>${v}</option>`).join('')}</select></label>
   <div id="bulk-preview"></div>
   <div id="bulk-list"></div>
   <div class="report-actions" id="bulk-actions"></div>
   <div id="bulk-results"></div>`;
  const dialog=drawer(t('platform.builder.bulk.button'),node);
  let currentPreview=null;
  async function refreshPreview(){
   const from=Number(node.querySelector('[name=from]').value),to=Number(node.querySelector('[name=to]').value);
   const previewHost=node.querySelector('#bulk-preview'),listHost=node.querySelector('#bulk-list'),actionsHost=node.querySelector('#bulk-actions');
   actionsHost.innerHTML='';node.querySelector('#bulk-results').innerHTML='';
   if(from===to){previewHost.innerHTML=empty(t('platform.builder.bulk.samePicked'));listHost.innerHTML='';return;}
   previewHost.innerHTML=skeleton(t('common.loading'));
   try{currentPreview=await apiClient(`/api/platform/bulk/version-migration/preview?connectorSlug=${detail.slug}&fromVersion=${from}&toVersion=${to}`);}
   catch(error){previewHost.innerHTML=empty(t('controlCenter.loadFailed'),error.message);listHost.innerHTML='';return;}
   previewHost.innerHTML=`<div class="kpi-grid">
    ${['totalAffected','tenants','capabilityRegressionCount'].map(k=>`<div class="kpi-card"><span class="kpi-label">${escape(t('platform.builder.bulk.'+k))}</span><strong class="kpi-value">${currentPreview[k]}</strong></div>`).join('')}
   </div>`;
   if(!currentPreview.connections.length){listHost.innerHTML=empty(t('common.noResults'));return;}
   listHost.innerHTML=currentPreview.connections.map(c=>`<label class="check"><input type="checkbox" name="conn" value="${escape(c.id)}" ${c.capabilityImpacted?'':'checked'}> ${escape(c.name)} <span dir="ltr" class="kpi-context">${escape(c.tenantId)}</span>${c.capabilityImpacted?` — <strong>${escape(t('platform.builder.bulk.capabilityWarning'))}</strong>`:''}</label>`).join('');
   const migrateButton=button(t('platform.builder.bulk.migrateSelected'),{variant:'primary'});
   migrateButton.onclick=async()=>{
    const selected=[...listHost.querySelectorAll('[name=conn]:checked')].map(el=>el.value);
    if(!selected.length){toastError(t('platform.builder.bulk.noneSelected'));return;}
    const confirmed=await promptDrawer(t('platform.builder.bulk.migrateSelected'),n=>{n.innerHTML=`<p>${escape(t('platform.builder.bulk.migrateConfirm',{count:selected.length}))}</p>`;},{confirmLabel:t('platform.builder.bulk.migrateSelected')});
    if(!confirmed)return;
    try{
     const result=await apiClient('/api/platform/bulk/version-migration',{connectorSlug:detail.slug,fromVersion:from,toVersion:to,connectionIds:selected});
     renderBulkResults(node.querySelector('#bulk-results'),result);
     refreshConnectorsListInBackground();
    }catch(error){toastError(error.message);}
   };
   actionsHost.append(migrateButton);
  }
  node.querySelector('[name=from]').onchange=refreshPreview;
  node.querySelector('[name=to]').onchange=refreshPreview;
  refreshPreview();
 }
 function renderBulkResults(host,result){
  host.innerHTML=`<h4>${escape(t('platform.builder.bulk.resultsTitle'))}</h4>
   <div class="kpi-grid">
    ${['ready','skipped','failed'].map(k=>`<div class="kpi-card"><span class="kpi-label">${escape(t('platform.builder.bulk.'+k))}</span><strong class="kpi-value">${result.summary[k]}</strong></div>`).join('')}
   </div>`+table(
    [t('platform.builder.bulk.connectionId'),t('controlCenter.statusLabel'),'reason'],
    result.results.map(r=>[`<span dir="ltr">${escape(r.connectionId)}</span>`,badge(r.status,r.status==='READY'?'CONNECTED':r.status==='SKIPPED'?'PENDING':'ERROR'),escape(r.reason||'—')])
   );
  if(result.summary.ready>0){
   const rollbackButton=button(t('platform.builder.bulk.rollbackOperation'),{variant:'danger'});
   rollbackButton.onclick=async()=>{
    const confirmed=await promptDrawer(t('platform.builder.bulk.rollbackOperation'),n=>{n.innerHTML=`<p>${escape(t('platform.builder.bulk.rollbackConfirm'))}</p>`;},{confirmLabel:t('platform.builder.bulk.rollbackOperation')});
    if(!confirmed)return;
    try{const rollback=await apiClient(`/api/platform/bulk/version-migration/${result.operationId}/rollback`,{},'POST');renderBulkResults(host,rollback);}
    catch(error){toastError(error.message);}
   };
   host.append(rollbackButton);
  }
 }

 // Phase 6H, Part 22-25 — Platform Connector Analytics: real, live numbers only (Part 25 — an
 // empty window shows 0/—, never a generated demo value), with a real time-window switcher.
 let analyticsWindow='7d';
 async function paintAnalytics(){
  if(!definitionId)return;
  analyticsPanel.innerHTML=`<div class="table-toolbar"><select id="analytics-window">${['24h','7d','30d'].map(w=>`<option value="${w}" ${w===analyticsWindow?'selected':''}>${w}</option>`).join('')}</select></div><div id="analytics-body"></div>`;
  analyticsPanel.querySelector('#analytics-window').onchange=e=>{analyticsWindow=e.target.value;renderAnalyticsBody();};
  await renderAnalyticsBody();
  async function renderAnalyticsBody(){
   const host=analyticsPanel.querySelector('#analytics-body');
   host.innerHTML=skeleton(t('common.loading'));
   let a;
   try{a=await apiClient(`/api/platform/connectors/${definitionId}/analytics?window=${analyticsWindow}`);}
   catch(error){host.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
   host.innerHTML=`<div class="kpi-grid">
    ${metric(t('platform.builder.analytics.connections'),a.connectionsCount)}
    ${metric(t('platform.builder.analytics.activeTenants'),a.activeTenants)}
    ${metric(t('platform.builder.analytics.calls'),a.calls)}
    ${metric(t('platform.builder.analytics.successRate'),a.successRate!=null?a.successRate+'%':'—')}
    ${metric(t('platform.builder.analytics.failures'),a.failures)}
    ${metric(t('platform.builder.analytics.avgLatency'),a.averageLatencyMs!=null?a.averageLatencyMs+' ms':'—')}
    ${metric(t('platform.builder.analytics.webhookReceived'),a.webhookReceived)}
    ${metric(t('platform.builder.analytics.webhookFailed'),a.webhookFailed)}
   </div>
   <h4>${escape(t('platform.builder.analytics.healthDistribution'))}</h4>
   ${Object.keys(a.healthDistribution).length?table([t('controlCenter.statusLabel'),t('platform.builder.analytics.count')],Object.entries(a.healthDistribution).map(([status,count])=>[badge(status,status==='CONNECTED'?'CONNECTED':status==='DEGRADED'?'DEGRADED':'DISCONNECTED'),escape(count)])):empty(t('common.noResults'))}`;
  }
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
    // Item 34/51 — a real, live dependency count fetched fresh right before the confirmation
    // is shown, never a stale number from whenever the drawer first opened.
    let deps={connections:0,tenants:0,agentAssignments:0};
    try{deps=await apiClient(`/api/platform/connectors/${definitionId}/dependencies`);}catch{/* show the confirmation anyway with a conservative "unknown" note */}
    const confirmed=await promptDrawer(t('platform.builder.disable'),n=>{
     n.innerHTML=`<p>${escape(t('platform.builder.disableConfirm'))}</p><p>${escape(t('platform.builder.disableImpact',{connections:deps.connections,tenants:deps.tenants,agents:deps.agentAssignments}))}</p>`;
    },{confirmLabel:t('platform.builder.disable')});
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
