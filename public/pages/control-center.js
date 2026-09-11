// Multi-Tenant Phase 4C-2 — Control Center. Reuses the existing design system entirely (no
// new component library, no framework): drawer/promptDrawer/dropdown/tabs/badge/metric/empty/
// skeleton from components/ui/index.js, the same `api()`/toast conventions app.js already
// uses. Every number and status here comes from GET /api/control-center/summary (one real,
// tenant-scoped aggregation — src/runtime/control-center.js) plus the existing Phase 4B/4B.1
// per-agent/per-connection endpoints for drill-down drawers. No fake data anywhere: an empty
// or not-configured state is rendered as a real empty state, never a placeholder number.
import {escape,button,badge,empty,metric,skeleton,tabs,drawer,promptDrawer,table,toast as showToast} from '../components/ui/index.js';
import {t,getLocale} from '../i18n.js';

const $=s=>document.querySelector('#control-center '+s);
let apiClient,currentAuth,summary=null,renderGeneration=0;
let filters={status:'all',query:''};

const AGENT_STATUS_VARIANT={READY:'CONNECTED',PARTIAL:'DEGRADED',BLOCKED:'ERROR',DISABLED:'DISCONNECTED'};
const CONNECTION_MODE_LABEL=mode=>t('controlCenter.connectionMode.'+(mode||'SINGLE'));
const TOOL_STATUS_LABEL=status=>t('controlCenter.toolStatus.'+status)||status;

function statusBadge(status,map=AGENT_STATUS_VARIANT){return badge(t('controlCenter.status.'+status)||status,map[status]||status);}

export function installControlCenter(){
 const root=document.querySelector('[data-page="control-center"] #control-center');
 root.innerHTML=`<div id="cc-summary" class="kpi-grid"></div>
  <section id="cc-attention" class="report-section" hidden><div class="report-section-head"><h3>${escape(t('controlCenter.needsAttention'))}</h3></div><div id="cc-attention-list"></div></section>
  <div id="cc-tabs"></div>`;
 const panels=['overview','integrations','ai','agents','health','settings'].map(key=>{const el=document.createElement('div');el.id='cc-panel-'+key;el.className='cc-panel';return el;});
 root.querySelector('#cc-tabs').append(...panels);
 tabs(root.querySelector('#cc-tabs'),[
  [t('controlCenter.tabs.overview'),panels[0]],
  [t('controlCenter.tabs.integrations'),panels[1]],
  [t('controlCenter.tabs.ai'),panels[2]],
  [t('controlCenter.tabs.agents'),panels[3]],
  [t('controlCenter.tabs.health'),panels[4]],
  [t('controlCenter.tabs.settings'),panels[5]]
 ]);
 const header=document.querySelector('[data-page="control-center"] .page-actions');
 const testButton=button(t('controlCenter.runSystemCheck'),{variant:'secondary',iconName:'check'});
 testButton.onclick=()=>runSystemCheck();
 header.append(testButton);
}

async function api(path,body){return apiClient(path,body);}

/** Phase 4C-2 Part 55 — async race guard: a workspace switch re-renders everything (app.js's
 * existing render() cycle already refetches from scratch); this only ensures a slow, now-
 * superseded fetch from the PREVIOUS workspace can never paint over the new one's DOM. */
function staleGuard(generation){return generation!==renderGeneration;}

export async function renderControlCenter({api:client,auth}){
 apiClient=client;currentAuth=auth;
 const navLink=document.querySelector('#nav-control-center');
 const visible=auth.user && ['owner','operator'].includes(auth.user.role);
 navLink.hidden=!visible;
 if(!visible)return;
 const generation=++renderGeneration;
 $('#cc-summary').innerHTML=skeleton(t('common.loading'));
 let data;
 try{data=await api('/api/control-center/summary');}
 catch(error){
  if(staleGuard(generation))return;
  $('#cc-summary').innerHTML=empty(t('controlCenter.loadFailed'),error.message);
  return;
 }
 if(staleGuard(generation))return;
 summary=data;
 renderKpis();
 renderAttention();
 renderIntegrationsTab();
 renderAiTab();
 renderAgentsTab();
 renderHealthTab();
 renderSettingsTab();
}

function renderKpis(){
 const {agents,tools,integrations}=summary;
 $('#cc-summary').innerHTML=
  metric(t('controlCenter.kpi.connected'),integrations.healthyConnections,t('controlCenter.kpi.connectedHint'),'plug')+
  metric(t('controlCenter.kpi.needsAttention'),integrations.unhealthyConnections,t('controlCenter.kpi.needsAttentionHint'),'info')+
  metric(t('controlCenter.kpi.agentsReady'),agents.ready+'/'+agents.total,t('controlCenter.kpi.agentsReadyHint'),'agent')+
  metric(t('controlCenter.kpi.agentsPartial'),agents.partial,t('controlCenter.kpi.agentsPartialHint'),'agent')+
  metric(t('controlCenter.kpi.agentsBlocked'),agents.blocked,t('controlCenter.kpi.agentsBlockedHint'),'agent')+
  metric(t('controlCenter.kpi.aiProviders'),summary.aiProviders.filter(c=>c.status==='CONNECTED').length,t('controlCenter.kpi.aiProvidersHint'),'chart')+
  metric(t('controlCenter.kpi.tools'),tools.available+'/'+tools.total,t('controlCenter.kpi.toolsHint'),'file');
}

/** Real, clickable "needs attention" items — never invented: every entry traces to a real
 * blocked/partial agent (from evaluateAgentReadiness) or an unhealthy real connection. */
function renderAttention(){
 const section=$('#cc-attention'),list=$('#cc-attention-list');
 const items=[];
 for(const agent of summary.agents.items){
  if(agent.status==='BLOCKED')items.push({text:t('controlCenter.attentionAgentBlocked',{agent:agent.name,reason:agent.blockers[0]||''}),jump:()=>openAgentDrawer(agent.id)});
  else if(agent.status==='PARTIAL')for(const slug of agent.optionalMissing)items.push({text:t('controlCenter.attentionAgentPartial',{agent:agent.name,tool:slug}),jump:()=>openAgentDrawer(agent.id)});
 }
 for(const provider of summary.integrations.providers)for(const c of provider.connections)if(!['CONNECTED','DEGRADED'].includes(c.status))items.push({text:t('controlCenter.attentionConnection',{name:c.name,provider:provider.nameAr,status:t('controlCenter.status.'+c.status)}),jump:()=>selectTab(1)});
 section.hidden=items.length===0;
 list.innerHTML='';
 for(const item of items){
  const row=document.createElement('div');row.className='audit-row row-between';
  const text=document.createElement('span');text.textContent=item.text;
  const go=button(t('controlCenter.configure'),{variant:'ghost',iconName:'arrow'});go.onclick=item.jump;
  row.append(text,go);list.append(row);
 }
}
function selectTab(index){document.querySelectorAll('#cc-tabs [role=tab]')[index]?.click();}

// --- Integrations tab ------------------------------------------------------------------

function renderIntegrationsTab(){
 const container=document.getElementById('cc-panel-integrations');
 if(summary.integrations.providers.length===0){container.innerHTML=empty(t('controlCenter.noIntegrations'));return;}
 container.innerHTML='<div class="grid" id="cc-integration-cards"></div>';
 const grid=container.querySelector('#cc-integration-cards');
 for(const provider of summary.integrations.providers){
  const card=document.createElement('article');card.className='card';
  const healthy=provider.connections.filter(c=>['CONNECTED','DEGRADED'].includes(c.status)).length;
  card.innerHTML=`<div class="meta"><span>${escape(provider.category)}</span>${provider.isAvailable?badge(CONNECTION_MODE_LABEL(provider.connectionMode),provider.connectionMode):badge(t('controlCenter.unavailable'),'ERROR')}</div>
   <h3>${escape(getLocale()==='en'?provider.nameEn:provider.nameAr)}</h3>
   <p>${provider.connections.length?t('controlCenter.connectionsSummary',{healthy,total:provider.connections.length}):t('controlCenter.noConnectionYet')}</p>`;
  const actions=document.createElement('div');actions.className='report-actions';
  if(provider.connections.length){
   const manage=button(t('controlCenter.manage'),{variant:'secondary'});manage.onclick=()=>openProviderDrawer(provider);
   actions.append(manage);
  }
  if(canAddConnection(provider)){
   const add=button(provider.slug==='salla'?t('controlCenter.addStore'):t('controlCenter.addConnection'),{variant:'primary',iconName:'plus'});
   add.onclick=()=>startAddConnection(provider);
   actions.append(add);
  } else if(!provider.isAvailable){
   const note=document.createElement('p');note.className='kpi-context';note.textContent=t('controlCenter.notAvailableNote');actions.append(note);
  } else if(provider.connectionMode==='SINGLE' && provider.connections.length){
   const note=document.createElement('p');note.className='kpi-context';note.textContent=t('controlCenter.singleConnectionNote');actions.append(note);
  }
  card.append(actions);grid.append(card);
 }
}
/** Honest add-connection gating (Phase 4C-2 Part 10/73): Salla's real multi-store OAuth and
 * Anthropic/OpenAI's real API-key flow are the ONLY backend-supported "add" paths today — a
 * SINGLE-mode provider that already has one connection never offers "add another", and an
 * UNAVAILABLE provider (Canva) never offers anything at all. */
function canAddConnection(provider){
 if(!provider.isAvailable)return false;
 if(provider.slug==='salla')return true;
 if(['anthropic','openai'].includes(provider.slug))return true;
 return provider.connections.length===0 && provider.connectionMode!=='UNAVAILABLE';
}
function startAddConnection(provider){
 if(provider.slug==='salla'){
  promptDrawer(t('controlCenter.addStore'),node=>{
   const input=document.createElement('input');input.name='name';input.required=true;input.maxLength=100;input.placeholder=t('controlCenter.storeNamePlaceholder');
   const label=document.createElement('label');label.textContent=t('controlCenter.connectionNameLabel');label.append(input);node.append(label);
   return {value:()=>input.value.trim(),focus:()=>input.focus()};
  },{confirmLabel:t('controlCenter.startOAuth')}).then(name=>{
   if(name===null)return;
   window.location.href=`/api/integrations/oauth/salla/start?name=${encodeURIComponent(name||t('controlCenter.storeNamePlaceholder'))}`;
  });
  return;
 }
 if(['anthropic','openai'].includes(provider.slug)){
  promptDrawer(t('controlCenter.addConnection'),node=>{
   const nameInput=document.createElement('input');nameInput.name='name';nameInput.required=true;nameInput.maxLength=100;nameInput.value=provider.nameEn;
   const nameLabel=document.createElement('label');nameLabel.textContent=t('controlCenter.connectionNameLabel');nameLabel.append(nameInput);
   const keyInput=document.createElement('input');keyInput.name='apiKey';keyInput.type='password';keyInput.required=true;keyInput.autocomplete='off';
   const keyLabel=document.createElement('label');keyLabel.textContent=t('controlCenter.apiKeyLabel');keyLabel.append(keyInput);
   node.append(nameLabel,keyLabel);
   // Never keep the key around longer than the one synchronous read needed to submit it.
   return {value:()=>({name:nameInput.value.trim(),apiKey:keyInput.value}),focus:()=>nameInput.focus()};
  },{confirmLabel:t('common.save')}).then(async result=>{
   if(!result)return;
   const {name,apiKey}=result;
   try{
    const connection=await api('/api/integrations/connections',{integrationDefinitionId:provider.slug,name});
    await api(`/api/integrations/connections/${connection.id}/credential`,{apiKey});
    toastAndRefresh(t('controlCenter.connectionAdded'));
   }catch(error){toastError(error.message);}
  });
 }
}

// --- AI Providers tab -------------------------------------------------------------------

function renderAiTab(){
 const container=document.getElementById('cc-panel-ai');
 if(summary.aiProviders.length===0){container.innerHTML=empty(t('controlCenter.noAiProvider'),t('controlCenter.noAiProviderHint'));return;}
 container.innerHTML='<div class="grid" id="cc-ai-cards"></div>';
 const grid=container.querySelector('#cc-ai-cards');
 for(const connection of summary.aiProviders){
  const card=document.createElement('article');card.className='card';
  card.innerHTML=`<div class="meta"><span>${escape(connection.provider)}</span>${connection.isDefault?badge(t('controlCenter.default'),'CONNECTED'):''}</div>
   <h3>${escape(connection.name)}</h3>${statusBadge(connection.status==='CONNECTED'?'CONNECTED':'ERROR',{CONNECTED:'CONNECTED',ERROR:'ERROR'})}
   <p>${connection.agentsUsing.length?t('controlCenter.agentsUsingCount',{count:connection.agentsUsing.length}):t('controlCenter.noAgentsUsing')}</p>`;
  grid.append(card);
 }
}

// --- Agent Connections tab ---------------------------------------------------------------

function renderAgentsTab(){
 const container=document.getElementById('cc-panel-agents');
 container.innerHTML=`<div class="table-toolbar"><input type="search" id="cc-agent-search" placeholder="${escape(t('controlCenter.searchAgents'))}"><select id="cc-agent-filter">${['all','READY','PARTIAL','BLOCKED','DISABLED'].map(s=>`<option value="${s}">${escape(s==='all'?t('common.all'):t('controlCenter.status.'+s))}</option>`).join('')}</select></div><div class="grid" id="cc-agent-cards"></div>`;
 container.querySelector('#cc-agent-search').oninput=e=>{filters.query=e.target.value;paintAgentCards();};
 container.querySelector('#cc-agent-filter').onchange=e=>{filters.status=e.target.value;paintAgentCards();};
 paintAgentCards();
}
function paintAgentCards(){
 const grid=document.getElementById('cc-agent-cards');if(!grid)return;
 const items=summary.agents.items.filter(a=>(filters.status==='all'||a.status===filters.status)&&(!filters.query||a.name.includes(filters.query)));
 if(!items.length){grid.innerHTML=empty(t('common.noResults'));return;}
 grid.innerHTML=items.map(a=>`<article class="card" data-agent="${escape(a.id)}"><div class="row-between"><h3>${escape(a.name)}</h3>${statusBadge(a.status)}</div><p>${a.enabled?t('controlCenter.enabled'):t('controlCenter.disabledLabel')}</p>${a.status==='BLOCKED'?`<p class="kpi-context">${escape(a.blockers[0]||'')}</p>`:''}</article>`).join('');
 grid.querySelectorAll('article').forEach(card=>{card.onclick=()=>openAgentDrawer(card.dataset.agent);const b=button(t('controlCenter.manage'),{variant:'secondary',iconName:'arrow'});b.onclick=e=>{e.stopPropagation();openAgentDrawer(card.dataset.agent);};card.append(b);});
}

async function openAgentDrawer(agentId){
 const agent=summary.agents.items.find(a=>a.id===agentId);
 const node=document.createElement('div');node.innerHTML=skeleton(t('common.loading'));
 const dialog=drawer(agent?.name||agentId,node);
 let config,tools,readiness;
 try{[config,tools,readiness]=await Promise.all([api(`/api/agents/${agentId}/config`),api(`/api/agents/${agentId}/tools`),api(`/api/agents/${agentId}/readiness`)]);}
 catch(error){node.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
 const overviewPanel=document.createElement('div'),aiPanel=document.createElement('div'),toolsPanel=document.createElement('div'),readinessPanel=document.createElement('div');
 node.replaceChildren();
 tabs(node,[[t('controlCenter.drawerOverview'),overviewPanel],[t('controlCenter.drawerAiModel'),aiPanel],[t('controlCenter.drawerTools'),toolsPanel],[t('controlCenter.drawerReadiness'),readinessPanel]]);
 paintAgentOverview(overviewPanel,agentId,config,readiness);
 paintAgentAiModel(aiPanel,agentId,config);
 paintAgentTools(toolsPanel,agentId,tools);
 paintAgentReadiness(readinessPanel,readiness);
 // Any edit inside this drawer (enabled toggle, AI config, tool assignment) can change
 // readiness/KPIs — refresh the whole Control Center once the drawer closes, matching this
 // app's existing convention (e.g. team.js's `team-refresh` event) rather than tracking
 // exactly which field changed.
 dialog.addEventListener('close',()=>renderControlCenter({api:apiClient,auth:currentAuth}),{once:true});
}
function paintAgentOverview(panel,agentId,config,readiness){
 panel.innerHTML=`<p><strong>${escape(t('controlCenter.enabledLabel'))}:</strong> ${config.enabled?t('controlCenter.enabled'):t('controlCenter.disabledLabel')}</p>
  <p><strong>${escape(t('controlCenter.readinessLabel'))}:</strong> ${statusBadge(readiness.status)}</p>
  ${readiness.blockers.length?`<p><strong>${escape(t('controlCenter.blockers'))}:</strong></p><ul>${readiness.blockers.map(b=>`<li>${escape(b)}</li>`).join('')}</ul>`:''}
  ${readiness.warnings.length?`<p><strong>${escape(t('controlCenter.warnings'))}:</strong></p><ul>${readiness.warnings.map(w=>`<li>${escape(w)}</li>`).join('')}</ul>`:''}`;
 const toggle=button(config.enabled?t('controlCenter.disableAgent'):t('controlCenter.enableAgent'),{variant:'secondary'});
 toggle.onclick=async()=>{try{await api(`/api/agents/${agentId}/config`,{enabled:!config.enabled});config.enabled=!config.enabled;paintAgentOverview(panel,agentId,config,readiness);toast(t('common.savedSuccessfully'));}catch(error){toastError(error.message);}};
 panel.append(toggle);
}
function paintAgentAiModel(panel,agentId,config){
 const aiConnections=summary.aiProviders;
 panel.innerHTML=`<label>${escape(t('controlCenter.aiConnectionLabel'))}<select name="aiConnectionId"><option value="">${escape(t('controlCenter.workspaceDefault'))}</option>${aiConnections.map(c=>`<option value="${c.id}" ${c.id===config.aiConnectionId?'selected':''}>${escape(c.name)} (${escape(c.provider)})</option>`).join('')}</select></label>
  <label>${escape(t('controlCenter.modelLabel'))}<input name="model" value="${escape(config.model||'')}" placeholder="${escape(t('controlCenter.modelPlaceholder'))}"></label>
  <label>${escape(t('controlCenter.temperatureLabel'))}<input name="temperature" type="number" min="0" max="2" step="0.1" value="${config.temperature??''}"></label>
  <label>${escape(t('controlCenter.maxTokensLabel'))}<input name="maxTokens" type="number" min="1" max="32000" value="${config.maxTokens??''}"></label>
  <label>${escape(t('controlCenter.timeoutLabel'))}<input name="timeoutMs" type="number" min="1000" max="300000" value="${config.timeoutMs??''}"></label>`;
 const save=button(t('common.save'),{variant:'primary'});
 save.onclick=async()=>{
  const val=name=>{const v=panel.querySelector(`[name=${name}]`).value;return v===''?null:v;};
  const patch={aiConnectionId:val('aiConnectionId')||null,model:val('model'),temperature:val('temperature')!==null?Number(val('temperature')):null,maxTokens:val('maxTokens')!==null?Number(val('maxTokens')):null,timeoutMs:val('timeoutMs')!==null?Number(val('timeoutMs')):null};
  try{await api(`/api/agents/${agentId}/config`,patch);toast(t('common.savedSuccessfully'));}
  catch(error){toastError(error.message);}
 };
 panel.append(save);
}
function paintAgentTools(panel,agentId,tools){
 const categories=[...new Set(tools.map(t=>t.category))];
 panel.innerHTML=categories.map(cat=>`<h4>${escape(cat)}</h4><div class="report-section" data-category="${escape(cat)}"></div>`).join('');
 for(const tool of tools){
  const host=panel.querySelector(`[data-category="${CSS.escape(tool.category)}"]`);
  const row=document.createElement('div');row.className='audit-row';
  const readinessStatus=tool.readiness?.status||'READY';
  row.innerHTML=`<div class="row-between"><strong>${escape(tool.slug)}</strong>${badge(TOOL_STATUS_LABEL(readinessStatus),readinessStatus==='READY'?'CONNECTED':readinessStatus==='CONNECTION_CAPABILITY_MISSING'?'ERROR':readinessStatus==='DISABLED'?'DISCONNECTED':'PENDING')}</div><p>${escape(tool.description||'')}</p>`;
  if(tool.integrationSlug && tool.requiresConnection!==false){
   const selector=document.createElement('div');selector.className='row';
   const select=document.createElement('select');
   select.innerHTML=`<option value="">${escape(t('controlCenter.noConnectionAssigned'))}</option>`;
   const enableToggle=button(tool.assignment&&tool.assignment.enabled===false?t('controlCenter.enableTool'):t('controlCenter.disableTool'),{variant:'ghost'});
   selector.append(select,enableToggle);
   loadCompatibleConnections(tool.slug).then(connections=>{
    for(const c of connections)select.innerHTML+=`<option value="${c.id}" ${tool.assignment?.connectionId===c.id?'selected':''} ${!c.capabilityGranted?'disabled':''}>${escape(c.name)}${c.capabilityGranted?'':' — '+t('controlCenter.capabilityMissingShort')}</option>`;
   });
   select.onchange=async()=>{
    try{await api(`/api/agents/${agentId}/tools/${tool.slug}`,{connectionId:select.value||null});toast(t('common.savedSuccessfully'));}
    catch(error){toastError(localizeAssignmentError(error.message));}
   };
   enableToggle.onclick=async()=>{
    const nextEnabled=!(tool.assignment?tool.assignment.enabled:true);
    try{await api(`/api/agents/${agentId}/tools/${tool.slug}`,{enabled:nextEnabled});toast(t('common.savedSuccessfully'));enableToggle.textContent=nextEnabled?t('controlCenter.disableTool'):t('controlCenter.enableTool');}
    catch(error){toastError(error.message);}
   };
   row.append(selector);
  }
  host?.append(row);
 }
}
async function loadCompatibleConnections(toolSlug){
 try{return await api(`/api/tools/${toolSlug}/connections`);}catch{return [];}
}
function localizeAssignmentError(message){
 const map={CONNECTION_PROVIDER_MISMATCH:t('controlCenter.errorProviderMismatch'),CONNECTION_CAPABILITY_MISSING:t('controlCenter.errorCapabilityMissing')};
 for(const key of Object.keys(map))if(message.includes(key))return map[key];
 return message;
}
function paintAgentReadiness(panel,readiness){
 panel.innerHTML=`<p>${escape(t('controlCenter.required'))}: ${statusBadge(readiness.required.ai==='READY'&&readiness.required.tools==='READY'?'READY':'BLOCKED')}</p>
  <p>${escape(t('controlCenter.aiStatus'))}: ${escape(readiness.required.ai)}</p>
  <p>${escape(t('controlCenter.toolsStatus'))}: ${escape(readiness.required.tools)}</p>
  ${readiness.optional_missing.length?`<p><strong>${escape(t('controlCenter.optionalMissing'))}:</strong> ${readiness.optional_missing.map(escape).join('، ')}</p>`:''}`;
}

// --- Health & Readiness tab ---------------------------------------------------------------

function renderHealthTab(){
 const container=document.getElementById('cc-panel-health');
 const connectionRows=summary.integrations.providers.flatMap(p=>p.connections.map(c=>[escape(getLocale()==='en'?p.nameEn:p.nameAr),escape(c.name),statusBadge(c.status,{CONNECTED:'CONNECTED',DEGRADED:'DEGRADED',ERROR:'ERROR',TOKEN_EXPIRED:'ERROR',PERMISSION_MISSING:'ERROR',DISCONNECTED:'DISCONNECTED',CONNECTING:'PENDING',NOT_CONFIGURED:'PENDING'}),escape(c.lastHealthCheck||'—'),escape(c.lastErrorMessageSafe||'—')]));
 const agentRows=summary.agents.items.map(a=>[escape(a.name),statusBadge(a.status),escape(a.enabled?t('controlCenter.enabled'):t('controlCenter.disabledLabel')),escape(a.blockers.join('، ')||'—')]);
 container.innerHTML=`<h4>${escape(t('controlCenter.integrationHealth'))}</h4>${connectionRows.length?table([t('controlCenter.provider'),t('controlCenter.connectionNameLabel'),t('common.field'),t('controlCenter.lastChecked'),t('controlCenter.lastError')],connectionRows):empty(t('controlCenter.noConnectionYet'))}
  <h4>${escape(t('controlCenter.agentReadinessTable'))}</h4>${table([t('controlCenter.agent'),t('controlCenter.readinessLabel'),t('controlCenter.enabledLabel'),t('controlCenter.blockers')],agentRows)}`;
}

// --- Workspace Settings tab ---------------------------------------------------------------

function renderSettingsTab(){
 const w=summary.workspace;
 document.getElementById('cc-panel-settings').innerHTML=`<div class="panel">
  <p><strong>${escape(t('controlCenter.workspaceName'))}:</strong> ${escape(w.name)}</p>
  <p><strong>${escape(t('controlCenter.workspaceSlug'))}:</strong> <span dir="ltr">${escape(w.slug)}</span></p>
  <p><strong>${escape(t('controlCenter.yourRole'))}:</strong> ${escape(t('workspace.role'+w.role.charAt(0).toUpperCase()+w.role.slice(1)))}</p>
  <p><strong>${escape(t('controlCenter.locale'))}:</strong> ${escape(w.locale)}</p>
  <p><strong>${escape(t('controlCenter.timezone'))}:</strong> ${escape(w.timezone)}</p>
  <p><strong>${escape(t('controlCenter.workspaceStatus'))}:</strong> ${badge(w.status,w.status==='ACTIVE'?'CONNECTED':'PENDING')}</p>
  ${w.maxAgentLevel?`<p><strong>${escape(t('controlCenter.safetyCeiling'))}:</strong> ${escape(w.maxAgentLevel)}</p>`:''}
 </div>`;
}

// --- Connection detail / provider drawer ---------------------------------------------------

function openProviderDrawer(provider){
 const node=document.createElement('div');
 node.innerHTML=provider.connections.map(c=>`<div class="card" data-connection="${escape(c.id)}"><div class="row-between"><strong>${escape(c.name)}</strong>${c.isDefault?badge(t('controlCenter.default'),'CONNECTED'):''}</div>${statusBadge(c.status,{CONNECTED:'CONNECTED',DEGRADED:'DEGRADED',ERROR:'ERROR',TOKEN_EXPIRED:'ERROR',PERMISSION_MISSING:'ERROR',DISCONNECTED:'DISCONNECTED',CONNECTING:'PENDING',NOT_CONFIGURED:'PENDING'})}<p>${escape(c.externalAccountName||'—')}</p><p class="kpi-context">${escape(t('controlCenter.lastChecked'))}: ${escape(c.lastHealthCheck||'—')}</p><div class="report-actions"></div></div>`).join('');
 for(const c of provider.connections){
  const card=node.querySelector(`[data-connection="${CSS.escape(c.id)}"]`),actions=card.querySelector('.report-actions');
  const test=button(t('controlCenter.testConnection'),{variant:'secondary'});
  test.onclick=async()=>{test.disabled=true;try{const result=await api(`/api/integrations/connections/${c.id}/test`);toast(t('controlCenter.testResult',{result:result.status}));card.querySelector('.pill').outerHTML=statusBadge(result.status,{CONNECTED:'CONNECTED',DEGRADED:'DEGRADED',ERROR:'ERROR',TOKEN_EXPIRED:'ERROR',PERMISSION_MISSING:'ERROR',DISCONNECTED:'DISCONNECTED'});}catch(error){toastError(error.message);}finally{test.disabled=false;}};
  actions.append(test);
  if(!c.isDefault && provider.connections.length>1){
   const setDefault=button(t('controlCenter.setDefault'),{variant:'ghost'});
   setDefault.onclick=async()=>{try{await api(`/api/integrations/connections/${c.id}/set-default`,{});toastAndRefresh(t('common.savedSuccessfully'));}catch(error){toastError(error.message);}};
   actions.append(setDefault);
  }
  const disconnect=button(t('controlCenter.disconnect'),{variant:'danger'});
  disconnect.onclick=async()=>{
   const confirmed=await promptDrawer(t('controlCenter.disconnect'),n=>{n.innerHTML=`<p>${escape(t('controlCenter.disconnectConfirm',{name:c.name}))}</p>`;},{confirmLabel:t('controlCenter.disconnect')});
   if(!confirmed)return;
   try{await api(`/api/integrations/connections/${c.id}/disconnect`,{});toastAndRefresh(t('common.savedSuccessfully'));}catch(error){toastError(error.message);}
  };
  actions.append(disconnect);
 }
 drawer(getLocale()==='en'?provider.nameEn:provider.nameAr,node);
}

// --- System check (Part 51/79 — safe, read-only aggregation only) -------------------------

async function runSystemCheck(){
 try{
  const fresh=await api('/api/control-center/summary');
  toast(t('controlCenter.systemCheckResult',{connections:fresh.integrations.healthyConnections+'/'+(fresh.integrations.healthyConnections+fresh.integrations.unhealthyConnections),ready:fresh.agents.ready+'/'+fresh.agents.total}));
 }catch(error){toastError(error.message);}
}

function toast(text){showToast(text,'success');}
function toastError(text){showToast(text,'error');}
function toastAndRefresh(text){toast(text);renderControlCenter({api:apiClient,auth:currentAuth});}
