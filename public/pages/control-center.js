// Multi-Tenant Phase 4C-2 — Control Center. Reuses the existing design system entirely (no
// new component library, no framework): drawer/promptDrawer/dropdown/tabs/badge/metric/empty/
// skeleton from components/ui/index.js, the same `api()`/toast conventions app.js already
// uses. Every number and status here comes from GET /api/control-center/summary (one real,
// tenant-scoped aggregation — src/runtime/control-center.js) plus the existing Phase 4B/4B.1
// per-agent/per-connection endpoints for drill-down drawers. No fake data anywhere: an empty
// or not-configured state is rendered as a real empty state, never a placeholder number.
import {escape,button,badge,empty,metric,skeleton,tabs,drawer,promptDrawer,table,toast as showToast} from '../components/ui/index.js';
import {t,getLocale} from '../i18n.js';
import {openConnectorWizardBySlug} from './platform.js';

const $=s=>document.querySelector('#control-center '+s);
let apiClient,currentAuth,summary=null,onboardingStatus=null,catalogBySlug=new Map(),renderGeneration=0;
let filters={status:'all',query:''};

const AGENT_STATUS_VARIANT={READY:'CONNECTED',PARTIAL:'DEGRADED',BLOCKED:'ERROR',DISABLED:'DISCONNECTED'};
const CONNECTION_MODE_LABEL=mode=>t('controlCenter.connectionMode.'+(mode||'SINGLE'));
const TOOL_STATUS_LABEL=status=>t('controlCenter.toolStatus.'+status)||status;
// Phase 6G — driven by the connector's REAL authType (control-center.js's own
// buildIntegrationsSummary now reports it), never a hardcoded slug allowlist: ANY OAuth2
// connector — a hand-built one (Salla/Zid) or a brand-new one defined entirely through the
// Generic OAuth2 Framework (docs/GENERIC_OAUTH2.md) — uses the exact same "Add Store"/OAuth-
// start UI with zero frontend change per future provider.
const isOAuth2Provider=provider=>!!provider.supportsGenericOAuth;

function statusBadge(status,map=AGENT_STATUS_VARIANT){return badge(t('controlCenter.status.'+status)||status,map[status]||status);}

export function installControlCenter(){
 const root=document.querySelector('[data-page="control-center"] #control-center');
 root.innerHTML=`<div id="cc-trial-banner" hidden></div>
  <div id="cc-summary" class="kpi-grid"></div>
  <section id="cc-attention" class="report-section" hidden><div class="report-section-head"><h3>${escape(t('controlCenter.needsAttention'))}</h3></div><div id="cc-attention-list"></div></section>
  <div id="cc-tabs"></div>`;
 const panels=['overview','integrations','ai','agents','agentMap','health','settings'].map(key=>{const el=document.createElement('div');el.id='cc-panel-'+key;el.className='cc-panel';return el;});
 root.querySelector('#cc-tabs').append(...panels);
 tabs(root.querySelector('#cc-tabs'),[
  [t('controlCenter.tabs.overview'),panels[0]],
  [t('controlCenter.tabs.integrations'),panels[1]],
  [t('controlCenter.tabs.ai'),panels[2]],
  [t('controlCenter.tabs.agents'),panels[3]],
  [t('controlCenter.tabs.agentMap'),panels[4]],
  [t('controlCenter.tabs.health'),panels[5]],
  [t('controlCenter.tabs.settings'),panels[6]]
 ]);
 const header=document.querySelector('[data-page="control-center"] .page-actions');
 const testButton=button(t('controlCenter.runSystemCheck'),{variant:'secondary',iconName:'check'});
 testButton.onclick=()=>runSystemCheck();
 header.append(testButton);
}

async function api(path,body,method){return apiClient(path,body,method);}

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
 let data,catalog;
 try{[data,onboardingStatus,catalog]=await Promise.all([api('/api/control-center/summary'),api('/api/onboarding').catch(()=>null),api('/api/integrations/catalog').catch(()=>[])]);}
 catch(error){
  if(staleGuard(generation))return;
  $('#cc-summary').innerHTML=empty(t('controlCenter.loadFailed'),error.message);
  return;
 }
 if(staleGuard(generation))return;
 summary=data;
 // Universal Integration Platform (Phase 6D) — the Integrations tab reads the same data-driven
 // catalog the Integration Builder publishes to (GET /api/integrations/catalog); a brand-new
 // Builder-published connector needs zero change here to start appearing and being connectable.
 catalogBySlug=new Map((catalog||[]).map(c=>[c.slug,c]));
 renderTrialBanner();
 renderKpis();
 renderAttention();
 renderIntegrationsTab();
 renderAiTab();
 renderAgentsTab();
 renderAgentMapTab();
 renderHealthTab();
 renderSettingsTab();
}

/** Multi-Tenant Phase 4C-7 (Part 12/13) — real, backend-derived trial state; the day count
 * and threshold both come straight from `workspace.trial` (Part 12: "No hardcoded 14 if
 * config differs" — the actual number is never assumed client-side). A stronger visual
 * treatment (not a block — Part 13: "لكن لا تمنع الاستخدام") kicks in once the backend itself
 * classifies the trial as `EXPIRING_SOON` (≤3 days), never a second, duplicated threshold
 * computed here. No fake "Upgrade"/"Pay now" button anywhere (Part 16) — Billing does not
 * exist yet, so none is offered. */
function renderTrialBanner(){
 const banner=$('#cc-trial-banner'),trial=summary.workspace.trial;
 if(!trial||!trial.active){banner.hidden=true;return;}
 banner.hidden=false;
 banner.className=trial.daysRemaining<=3?'notice trial-banner trial-banner-warning':'notice trial-banner';
 banner.textContent=t('controlCenter.trialBanner',{days:trial.daysRemaining});
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
 if(onboardingStatus && onboardingStatus.status!=='COMPLETED')items.push({text:t('controlCenter.attentionOnboardingIncomplete'),jump:()=>{location.hash='#onboarding';}});
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

/** Universal Integration Platform (Phase 6D) — data-driven marketplace: cards are grouped by
 * real `category` (from the same catalog the Integration Builder publishes to), never a
 * hardcoded per-provider list. A DISABLED dynamic connector (still has `status` from the
 * summary) is shown greyed-out with an honest note rather than silently disappearing while it
 * still has a live connection to manage. */
function renderIntegrationsTab(){
 const container=document.getElementById('cc-panel-integrations');
 container.innerHTML='';
 // Item 3 — a Platform Admin (never a tenant owner/operator/reviewer) sees a direct entry
 // point into the EXISTING Integration Builder right from where they'd naturally look for a
 // new integration — never a second Builder, just a real navigation to the one that exists.
 if(currentAuth?.isPlatformAdmin){
  const header=document.createElement('div');header.className='report-section-head';
  const addIntegration=button(t('controlCenter.addIntegration'),{variant:'primary',iconName:'plus'});
  addIntegration.onclick=()=>{location.hash='#platform';setTimeout(()=>document.getElementById('pf-connectors')?.scrollIntoView({behavior:'smooth',block:'start'}),120);};
  header.append(addIntegration);container.append(header);
 }
 if(summary.integrations.providers.length===0){container.append(Object.assign(document.createElement('div'),{innerHTML:empty(t('controlCenter.noIntegrations'))}));return;}
 const categories=[...new Set(summary.integrations.providers.map(p=>p.category))];
 const categoriesHost=document.createElement('div');
 categoriesHost.innerHTML=categories.map(cat=>`<h4>${escape(cat)}</h4><div class="grid" data-category="${escape(cat)}"></div>`).join('');
 container.append(categoriesHost);
 for(const provider of summary.integrations.providers){
  const grid=container.querySelector(`[data-category="${CSS.escape(provider.category)}"]`);
  const card=document.createElement('article');card.className='card';
  const healthy=provider.connections.filter(c=>['CONNECTED','DEGRADED'].includes(c.status)).length;
  const disabledByPlatform=provider.status==='DISABLED';
  card.innerHTML=`<div class="meta"><span>${escape(provider.category)}</span>${disabledByPlatform?badge(t('controlCenter.providerStatus.DISABLED'),'ERROR'):provider.isAvailable?badge(CONNECTION_MODE_LABEL(provider.connectionMode),provider.connectionMode):badge(t('controlCenter.unavailable'),'ERROR')}</div>
   <h3>${escape(getLocale()==='en'?provider.nameEn:provider.nameAr)}</h3>
   ${provider.capabilities?.length?`<p class="kpi-context" dir="ltr">${provider.capabilities.map(escape).join(' · ')}</p>`:''}
   <p>${provider.connections.length?t('controlCenter.connectionsSummary',{healthy,total:provider.connections.length}):t('controlCenter.noConnectionYet')}</p>`;
  const actions=document.createElement('div');actions.className='report-actions';
  if(provider.connections.length){
   const manage=button(t('controlCenter.manage'),{variant:'secondary'});manage.onclick=()=>openProviderDrawer(provider);
   actions.append(manage);
  }
  if(canAddConnection(provider)){
   const add=button(isOAuth2Provider(provider)?t('controlCenter.addStore'):t('controlCenter.addConnection'),{variant:'primary',iconName:'plus'});
   add.onclick=()=>startAddConnection(provider);
   actions.append(add);
  } else if(disabledByPlatform){
   const note=document.createElement('p');note.className='kpi-context';note.textContent=t('controlCenter.providerStatus.DISABLED');actions.append(note);
  } else if(!provider.isAvailable){
   const note=document.createElement('p');note.className='kpi-context';note.textContent=t('controlCenter.notAvailableNote');actions.append(note);
  } else if(provider.connectionMode==='SINGLE' && provider.connections.length){
   const note=document.createElement('p');note.className='kpi-context';note.textContent=t('controlCenter.singleConnectionNote');actions.append(note);
  }
  // Item 20 — a Platform Admin sees this on EVERY connector card (system or dynamic, connected
  // or not); a tenant owner/operator/reviewer never does (Item 21's visibility rule).
  if(currentAuth?.isPlatformAdmin){
   const manageDefinition=button(t('controlCenter.manageIntegrationDefinition'),{variant:'ghost'});
   manageDefinition.onclick=()=>{location.hash='#platform';openConnectorWizardBySlug(provider.slug);};
   actions.append(manageDefinition);
  }
  card.append(actions);grid.append(card);
 }
 if(currentAuth?.user?.role==='owner')renderTenantCustomConnectors(container);
}
// Phase 6G, Part 28-38 — Tenant Custom Connector Governance. The section itself only renders
// once the backend confirms the flag is actually on for this deployment (never guessed/assumed
// client-side) — `enabled:false` renders nothing at all, matching "when false: no tenant
// creation API/UI" exactly.
async function renderTenantCustomConnectors(container){
 let data;
 try{data=await api('/api/integrations/custom-connectors');}catch{return;}
 if(!data.enabled)return;
 const host=document.createElement('section');host.className='report-section';host.id='cc-custom-connectors';
 host.innerHTML=`<div class="report-section-head"><h3>${escape(t('controlCenter.customConnectors.title'))}</h3></div>
  <p class="kpi-context">${escape(t('controlCenter.customConnectors.hint'))}</p>
  <div id="cc-custom-list"></div>`;
 container.append(host);
 const newButton=button(t('controlCenter.customConnectors.newDraft'),{variant:'primary',iconName:'plus'});
 newButton.onclick=()=>openCustomConnectorDraftForm();
 host.querySelector('.report-section-head').append(newButton);
 paintCustomConnectorsList(host.querySelector('#cc-custom-list'),data.connectors);
}
function paintCustomConnectorsList(host,list){
 if(!list.length){host.innerHTML=empty(t('controlCenter.customConnectors.emptyState'));return;}
 host.innerHTML=table(
  [t('platform.builder.table.name'),t('platform.builder.table.status'),t('controlCenter.customConnectors.reviewStatus'),t('platform.builder.table.actions')],
  list.map(c=>[
   `${escape(getLocale()==='en'?c.nameEn:c.nameAr)} <span dir="ltr" class="kpi-context">${escape(c.slug)}</span>`,
   badge(t('platform.builder.status.'+c.status)||c.status,c.status==='PUBLISHED'?'CONNECTED':'PENDING'),
   c.reviewStatus?badge(t('controlCenter.customConnectors.reviewStatusValue.'+c.reviewStatus)||c.reviewStatus,c.reviewStatus==='APPROVED'?'CONNECTED':c.reviewStatus==='REJECTED'?'ERROR':'PENDING'):'—',
   `<span data-custom-row="${escape(c.id)}"></span>`
  ])
 );
 for(const c of list){
  const cell=host.querySelector(`[data-custom-row="${CSS.escape(c.id)}"]`);
  if(c.status==='DRAFT'){
   const edit=button(t('platform.builder.manage'),{variant:'secondary'});
   edit.onclick=()=>openCustomConnectorDraftForm(c);
   cell.append(edit);
   // Phase 6H, Part 26-32 — Tenant Custom Connector Webhook Triggers.
   const triggers=button(t('controlCenter.customConnectors.webhookTriggers'),{variant:'ghost'});
   triggers.onclick=()=>openCustomConnectorTriggers(c);
   cell.append(triggers);
   if(!c.reviewStatus||c.reviewStatus==='CHANGES_REQUESTED'||c.reviewStatus==='REJECTED'){
    const submit=button(t('controlCenter.customConnectors.submit'),{variant:'primary'});
    submit.onclick=async()=>{
     try{await api(`/api/integrations/custom-connectors/${c.id}/submit`,{},'POST');toast(t('common.savedSuccessfully'));renderControlCenter({api:apiClient,auth:currentAuth});}
     catch(error){toastError(error.message);}
    };
    cell.append(submit);
   }
  }
 }
}
function openCustomConnectorDraftForm(existing){
 promptDrawer(existing?t('platform.builder.manage'):t('controlCenter.customConnectors.newDraft'),n=>{
  n.innerHTML=`
   <label>${escape(t('platform.builder.fields.slug'))}<input name="slug" dir="ltr" ${existing?'disabled':''} value="${escape(existing?.slug||'')}" required pattern="[a-z][a-z0-9_-]*" maxlength="60"></label>
   <label>${escape(t('platform.builder.fields.nameAr'))}<input name="nameAr" value="${escape(existing?.nameAr||'')}" required maxlength="100"></label>
   <label>${escape(t('platform.builder.fields.nameEn'))}<input name="nameEn" dir="ltr" value="${escape(existing?.nameEn||'')}" required maxlength="100"></label>
   <label>${escape(t('platform.builder.fields.baseUrl'))}<input name="baseUrl" dir="ltr" value="${escape(existing?.restConfig?.baseUrl||'')}" required placeholder="https://api.example.com"></label>
   <label>${escape(t('platform.builder.fields.authType'))}<select name="authType" ${existing?'disabled':''}>${['API_KEY','BEARER_TOKEN','BASIC','NONE'].map(a=>`<option value="${a}" ${(existing?.authConfig?.type||'API_KEY')===a?'selected':''}>${escape(a)}</option>`).join('')}</select></label>
   <label>${escape(t('platform.builder.fields.headerName'))}<input name="headerName" dir="ltr" value="${escape(existing?.authConfig?.headerName||'X-Api-Key')}"></label>
   <label>${escape(t('platform.builder.fields.capabilities'))}<input name="capabilities" dir="ltr" value="${escape((existing?.capabilities||[]).join(' '))}" placeholder="commerce.orders.read"></label>
   <p class="notice">${escape(t('controlCenter.customConnectors.policyNote'))}</p>`;
  return {
   value:()=>{
    const val=name=>n.querySelector(`[name=${name}]`).value.trim();
    const authType=n.querySelector('[name=authType]').value;
    return {
     slug:val('slug'),nameAr:val('nameAr'),nameEn:val('nameEn'),connectionMode:'SINGLE',
     auth:authType==='API_KEY'?{type:'API_KEY',headerName:val('headerName')||'X-Api-Key'}:authType==='NONE'?{type:'NONE',allowNone:true}:{type:authType},
     capabilities:val('capabilities')?val('capabilities').split(/\s+/).filter(Boolean):[],
     rest:{baseUrl:val('baseUrl')}
    };
   },
   focus:()=>n.querySelector('[name=slug]').focus()
  };
 },{confirmLabel:t('common.save')}).then(async result=>{
  if(!result)return;
  try{
   if(existing)await api(`/api/integrations/custom-connectors/${existing.id}`,{nameAr:result.nameAr,nameEn:result.nameEn,capabilities:result.capabilities,rest:result.rest},'PATCH');
   else await api('/api/integrations/custom-connectors',result);
   toast(t('common.savedSuccessfully'));
   renderControlCenter({api:apiClient,auth:currentAuth});
  }catch(error){toastError(error.message);}
 });
}
// Phase 6H, Part 26-32 — Tenant Custom Connector Webhook Triggers management.
async function openCustomConnectorTriggers(connector){
 const node=document.createElement('div');node.innerHTML=skeleton(t('common.loading'));
 const dialog=drawer(t('controlCenter.customConnectors.webhookTriggers')+' — '+(getLocale()==='en'?connector.nameEn:connector.nameAr),node);
 async function reload(){
  let triggers;
  try{triggers=await api(`/api/integrations/custom-connectors/${connector.id}/triggers`);}
  catch(error){node.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
  node.innerHTML=(triggers.length?'':empty(t('platform.builder.noTriggersYet')))+
   triggers.map(tr=>`<div class="audit-row row-between" data-trigger="${escape(tr.id)}"><span><strong dir="ltr">${escape(tr.slug)}</strong> → <span dir="ltr">${escape(tr.normalizedEventType)}</span> (${escape(tr.authentication?.type)})</span><span data-del></span></div>`).join('');
  for(const tr of triggers){
   const del=button(t('platform.builder.deleteTrigger'),{variant:'danger'});
   del.onclick=async()=>{try{await api(`/api/integrations/custom-connectors/${connector.id}/triggers/${tr.id}`,{},'DELETE');await reload();}catch(error){toastError(error.message);}};
   node.querySelector(`[data-trigger="${CSS.escape(tr.id)}"] [data-del]`).append(del);
  }
  const addButton=button(t('platform.builder.addTrigger'),{variant:'primary',iconName:'plus'});
  addButton.onclick=()=>openAddCustomTrigger();
  node.append(addButton);
 }
 function openAddCustomTrigger(){
  promptDrawer(t('platform.builder.addTrigger'),n=>{
   n.innerHTML=`
    <p class="notice">${escape(t('controlCenter.customConnectors.webhookPolicyNote'))}</p>
    <label>${escape(t('platform.builder.fields.triggerSlug'))}<input name="slug" dir="ltr" required maxlength="60" pattern="[a-z][a-z0-9_]*"></label>
    <label>${escape(t('platform.builder.fields.triggerName'))}<input name="name" required maxlength="100"></label>
    <label>${escape(t('platform.builder.fields.webhookAuthType'))}<select name="authType"><option>HMAC</option><option>HEADER_TOKEN</option></select></label>
    <label>${escape(t('platform.builder.fields.signatureHeader'))}<input name="signatureHeader" dir="ltr" placeholder="X-Signature"></label>
    <label>${escape(t('platform.builder.fields.signaturePrefix'))}<input name="signaturePrefix" dir="ltr" placeholder="sha256="></label>
    <label>${escape(t('platform.builder.fields.eventIdPath'))}<input name="eventIdPath" dir="ltr" placeholder="id"></label>
    <label>${escape(t('controlCenter.customConnectors.normalizedEventType'))}<select name="normalizedEventType">${['ORDER_CREATED','ORDER_UPDATED','ORDER_COMPLETED','CART_ABANDONED','PRODUCT_UPDATED','PRODUCT_STOCK_UPDATED','CUSTOMER_MESSAGE_RECEIVED','INVOICE_CREATED'].map(e=>`<option value="${e}">${e}</option>`).join('')}</select></label>`;
   return {
    value:()=>{
     const val=name=>n.querySelector(`[name=${name}]`).value.trim();
     const authType=n.querySelector('[name=authType]').value;
     return {
      slug:val('slug'),name:val('name'),
      authentication:authType==='HEADER_TOKEN'?{type:'HEADER_TOKEN',headerName:val('signatureHeader')||'X-Token'}:{type:'HMAC',signatureHeader:val('signatureHeader')||'X-Signature',signaturePrefix:val('signaturePrefix')||undefined},
      eventIdPath:val('eventIdPath')||undefined,eventIdPolicy:'OPTIONAL',
      mappingDefinition:{object:{}},normalizedEventType:n.querySelector('[name=normalizedEventType]').value
     };
    },
    focus:()=>n.querySelector('[name=slug]').focus()
   };
  },{confirmLabel:t('platform.builder.addTrigger')}).then(async result=>{
   if(!result)return;
   try{await api(`/api/integrations/custom-connectors/${connector.id}/triggers`,result);await reload();}
   catch(error){toastError(error.message);}
  });
 }
 await reload();
}
/** Honest add-connection gating (Phase 4C-2 Part 10/73, extended Phase 6D): Salla's real
 * multi-store OAuth and Anthropic/OpenAI's real API-key flow keep their own dedicated paths; any
 * OTHER published connector (built-in or a dynamic/Builder one) falls through to the generic
 * rule already here — a SINGLE-mode provider that already has one connection never offers "add
 * another", a DISABLED one never offers anything, and an UNAVAILABLE provider (Canva) doesn't
 * either. */
function canAddConnection(provider){
 if(!provider.isAvailable||provider.status==='DISABLED')return false;
 if(isOAuth2Provider(provider))return true; // real MULTI-store OAuth providers (Salla, Zid) — always offer "add another store"
 if(['anthropic','openai'].includes(provider.slug))return true;
 return provider.connections.length===0 && provider.connectionMode!=='UNAVAILABLE';
}
/** Generic Connection UI (Phase 6D) — the ONE add-connection form every dynamic/Builder-
 * published connector uses, driven entirely by the real authType the catalog reports. Secret
 * fields are read once synchronously to submit and never stored anywhere client-side (no
 * localStorage/sessionStorage) — the same discipline the existing Anthropic/OpenAI flow above
 * already follows. */
function startGenericConnect(provider){
 const catalogEntry=catalogBySlug.get(provider.slug);
 const authType=catalogEntry?.authType;
 // Only a real GENERIC_REST/Builder-published connector's auth type is handled by this generic
 // form (Part 5) — a built-in OAuth2 provider (whatsapp/meta/microsoft365/x/linkedin) with zero
 // connections yet has no generic "add" path in this pass (each has its own dedicated OAuth
 // start route, not surfaced from this particular button today) — say so honestly rather than
 // attempting a doomed generic-credential call that would just 400.
 if(!['API_KEY','BEARER_TOKEN','BASIC','NONE'].includes(authType)){toastError(t('controlCenter.notAvailableNote'));return;}
 promptDrawer(t('controlCenter.addConnection'),node=>{
  const nameInput=document.createElement('input');nameInput.name='name';nameInput.required=true;nameInput.maxLength=100;nameInput.value=getLocale()==='en'?provider.nameEn:provider.nameAr;
  const nameLabel=document.createElement('label');nameLabel.textContent=t('controlCenter.connectionNameLabel');nameLabel.append(nameInput);
  node.append(nameLabel);
  let secretInput=null,secondInput=null;
  if(authType==='API_KEY'){
   secretInput=document.createElement('input');secretInput.type='password';secretInput.required=true;secretInput.autocomplete='off';
   const label=document.createElement('label');label.textContent=t('controlCenter.apiKeyLabel');label.append(secretInput);node.append(label);
  } else if(authType==='BEARER_TOKEN'){
   secretInput=document.createElement('input');secretInput.type='password';secretInput.required=true;secretInput.autocomplete='off';
   const label=document.createElement('label');label.textContent=t('controlCenter.tokenLabel');label.append(secretInput);node.append(label);
  } else if(authType==='BASIC'){
   secretInput=document.createElement('input');secretInput.required=true;secretInput.autocomplete='off';
   const label=document.createElement('label');label.textContent=t('controlCenter.usernameLabel');label.append(secretInput);node.append(label);
   secondInput=document.createElement('input');secondInput.type='password';secondInput.autocomplete='off';
   const label2=document.createElement('label');label2.textContent=t('controlCenter.passwordLabel');label2.append(secondInput);node.append(label2);
  } else {
   const note=document.createElement('p');note.className='kpi-context';note.textContent=t('controlCenter.connectNoAuth');node.append(note);
  }
  return {value:()=>({name:nameInput.value.trim(),secret:secretInput?.value,second:secondInput?.value}),focus:()=>nameInput.focus()};
 },{confirmLabel:t('common.save')}).then(async result=>{
  if(!result)return;
  try{
   const connection=await api('/api/integrations/connections',{integrationDefinitionId:provider.slug,name:result.name});
   const credentialBody=authType==='API_KEY'?{apiKey:result.secret}:authType==='BEARER_TOKEN'?{token:result.secret}:authType==='BASIC'?{username:result.secret,password:result.second}:{};
   await api(`/api/integrations/connections/${connection.id}/generic-credential`,credentialBody,'PUT');
   toastAndRefresh(t('controlCenter.connectionAdded'));
  }catch(error){toastError(error.message);}
 });
}
function startAddConnection(provider){
 if(isOAuth2Provider(provider)){
  promptDrawer(t('controlCenter.addStore'),node=>{
   const input=document.createElement('input');input.name='name';input.required=true;input.maxLength=100;input.placeholder=t('controlCenter.storeNamePlaceholder');
   const label=document.createElement('label');label.textContent=t('controlCenter.connectionNameLabel');label.append(input);node.append(label);
   return {value:()=>input.value.trim(),focus:()=>input.focus()};
  },{confirmLabel:t('controlCenter.startOAuth')}).then(name=>{
   if(name===null)return;
   window.location.href=`/api/integrations/oauth/${provider.slug}/start?name=${encodeURIComponent(name||t('controlCenter.storeNamePlaceholder'))}`;
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
    await api(`/api/integrations/connections/${connection.id}/credential`,{apiKey},'PUT');
    toastAndRefresh(t('controlCenter.connectionAdded'));
   }catch(error){toastError(error.message);}
  });
  return;
 }
 // Any other published connector — built-in (whatsapp/meta/microsoft365/x/linkedin keep their
 // own OAuth "Manage" flow already surfaced via openProviderDrawer once connected, so this only
 // ever fires for a provider with zero connections and no dedicated flow above) or a dynamic
 // Builder-published one — uses the ONE Generic Connection UI, keyed off the real authType the
 // catalog reports. Zero per-provider branch is added here for a new Builder connector.
 startGenericConnect(provider);
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
 // `tabs()` only builds the tab bar itself (prepended into its container) — it never
 // appends the panel nodes anywhere; the caller must place them, exactly like every other
 // `tabs()` call site in this codebase (e.g. public/pages/workspace.js's content tabs).
 node.append(overviewPanel,aiPanel,toolsPanel,readinessPanel);
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
 toggle.onclick=async()=>{try{await api(`/api/agents/${agentId}/config`,{enabled:!config.enabled},'PATCH');config.enabled=!config.enabled;paintAgentOverview(panel,agentId,config,readiness);toast(t('common.savedSuccessfully'));}catch(error){toastError(error.message);}};
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
  try{await api(`/api/agents/${agentId}/config`,patch,'PATCH');toast(t('common.savedSuccessfully'));}
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
  // Phase 6F fix — a generic, capability-only tool (integrationSlug:null; get_invoices/
  // get_orders/get_customers) used to never show a connection selector at all here, even
  // though the backend has fully supported assigning one since Phase 6D/6E — this condition
  // pre-dates generic capability tools and only ever checked the fixed-provider shape.
  if(tool.requiresConnection!==false){
   const selector=document.createElement('div');selector.className='row';
   const select=document.createElement('select');
   select.innerHTML=`<option value="">${escape(t('controlCenter.noConnectionAssigned'))}</option>`;
   const enableToggle=button(tool.assignment&&tool.assignment.enabled===false?t('controlCenter.enableTool'):t('controlCenter.disableTool'),{variant:'ghost'});
   selector.append(select,enableToggle);
   loadCompatibleConnections(tool.slug).then(connections=>{
    for(const c of connections)select.innerHTML+=`<option value="${c.id}" ${tool.assignment?.connectionId===c.id?'selected':''} ${!c.capabilityGranted?'disabled':''}>${escape(c.name)}${c.capabilityGranted?'':' — '+t('controlCenter.capabilityMissingShort')}</option>`;
   });
   select.onchange=async()=>{
    try{await api(`/api/agents/${agentId}/tools/${tool.slug}`,{connectionId:select.value||null},'PUT');toast(t('common.savedSuccessfully'));}
    catch(error){toastError(localizeAssignmentError(error.message));}
   };
   enableToggle.onclick=async()=>{
    const nextEnabled=!(tool.assignment?tool.assignment.enabled:true);
    try{await api(`/api/agents/${agentId}/tools/${tool.slug}`,{enabled:nextEnabled},'PUT');toast(t('common.savedSuccessfully'));enableToggle.textContent=nextEnabled?t('controlCenter.disableTool'):t('controlCenter.enableTool');}
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

// --- Agent Connection Map (Phase 6G, Part 43-47) ------------------------------------------
// Agent -> Tool -> Capability -> Connector -> Connection -> Version -> Health, one real,
// live table built entirely from the same readiness/compatibility computations the Agents tab
// above already uses — never a second, divergent readiness engine.

let agentMapFilters={agentId:'',connectorSlug:'',status:'',capability:''};
function renderAgentMapTab(){
 const container=document.getElementById('cc-panel-agentMap');
 container.innerHTML=`<p class="kpi-context">${escape(t('controlCenter.agentMap.hint'))}</p>
  <div class="table-toolbar">
   <select id="am-agent"><option value="">${escape(t('common.all'))}</option>${summary.agents.items.map(a=>`<option value="${escape(a.id)}">${escape(a.name)}</option>`).join('')}</select>
   <select id="am-status"><option value="">${escape(t('common.all'))}</option>${['READY','CONNECTION_REQUIRED','CONNECTION_UNHEALTHY','CONNECTION_CAPABILITY_MISSING','DISABLED'].map(s=>`<option value="${s}">${escape(t('controlCenter.toolStatus.'+s)||s)}</option>`).join('')}</select>
   <input type="search" id="am-connector" placeholder="${escape(t('controlCenter.agentMap.connectorFilterPlaceholder'))}" dir="ltr">
  </div>
  <div id="am-table"></div>
  <h4>${escape(t('controlCenter.agentMap.compatibilityTitle'))}</h4>
  <div id="am-compat"></div>`;
 container.querySelector('#am-agent').onchange=e=>{agentMapFilters.agentId=e.target.value;paintAgentMapTable();};
 container.querySelector('#am-status').onchange=e=>{agentMapFilters.status=e.target.value;paintAgentMapTable();};
 container.querySelector('#am-connector').oninput=e=>{agentMapFilters.connectorSlug=e.target.value.trim();paintAgentMapTable();};
 paintAgentMapTable();
 paintToolCompatibility();
}
async function paintAgentMapTable(){
 const host=document.getElementById('am-table');if(!host)return;
 host.innerHTML=skeleton(t('common.loading'));
 const params=new URLSearchParams();
 if(agentMapFilters.agentId)params.set('agentId',agentMapFilters.agentId);
 if(agentMapFilters.status)params.set('status',agentMapFilters.status);
 let rows;
 try{rows=await api(`/api/agent-connection-map?${params}`);}catch(error){host.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
 if(agentMapFilters.connectorSlug)rows=rows.filter(r=>(r.connectorSlug||'').includes(agentMapFilters.connectorSlug));
 if(!rows.length){host.innerHTML=empty(t('common.noResults'));return;}
 host.innerHTML=table(
  [t('controlCenter.agent'),t('controlCenter.agentMap.tool'),t('controlCenter.agentMap.capability'),t('controlCenter.agentMap.connector'),t('controlCenter.agentMap.connection'),t('controlCenter.agentMap.version'),t('controlCenter.agentMap.health'),t('controlCenter.readinessLabel')],
  rows.map(r=>[
   escape(r.agentName),`<span dir="ltr">${escape(r.toolSlug)}</span>`,`<span dir="ltr">${escape(r.capability||'—')}</span>`,
   `<span dir="ltr">${escape(r.connectorSlug||'—')}</span>`,escape(r.connectionName||'—'),escape(r.connectorVersion??'—'),
   r.healthStatus?statusBadge(r.healthStatus,{CONNECTED:'CONNECTED',DEGRADED:'DEGRADED',ERROR:'ERROR',TOKEN_EXPIRED:'ERROR',DISCONNECTED:'DISCONNECTED'}):'—',
   badge(t('controlCenter.toolStatus.'+r.readinessStatus)||r.readinessStatus,r.readinessStatus==='READY'?'CONNECTED':r.readinessStatus==='DISABLED'?'DISCONNECTED':'ERROR')
  ])
 );
}
async function paintToolCompatibility(){
 const host=document.getElementById('am-compat');if(!host)return;
 host.innerHTML=skeleton(t('common.loading'));
 let view;
 try{view=await api('/api/tool-compatibility');}catch(error){host.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
 const withData=view.filter(v=>v.capability);
 if(!withData.length){host.innerHTML=empty(t('common.noResults'));return;}
 host.innerHTML=table(
  [t('controlCenter.agentMap.tool'),t('controlCenter.agentMap.capability'),t('controlCenter.agentMap.compatibleConnections'),t('controlCenter.agentMap.assignedAgents')],
  withData.map(v=>[
   `<span dir="ltr">${escape(v.toolSlug)}</span>`,`<span dir="ltr">${escape(v.capability)}</span>`,
   escape(v.compatibleConnections.length),
   escape(v.assignments.filter(a=>a.connectionId).length)+'/'+escape(v.assignments.length)
  ])
 );
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
 const container=document.getElementById('cc-panel-settings');
 container.innerHTML=`<div class="panel">
  <p><strong>${escape(t('controlCenter.workspaceName'))}:</strong> ${escape(w.name)}</p>
  <p><strong>${escape(t('controlCenter.workspaceSlug'))}:</strong> <span dir="ltr">${escape(w.slug)}</span></p>
  <p><strong>${escape(t('controlCenter.yourRole'))}:</strong> ${escape(t('workspace.role'+w.role.charAt(0).toUpperCase()+w.role.slice(1)))}</p>
  <p><strong>${escape(t('controlCenter.locale'))}:</strong> ${escape(w.locale)}</p>
  <p><strong>${escape(t('controlCenter.timezone'))}:</strong> ${escape(w.timezone)}</p>
  <p><strong>${escape(t('controlCenter.workspaceStatus'))}:</strong> ${badge(w.status,w.status==='ACTIVE'?'CONNECTED':'PENDING')}</p>
  ${w.maxAgentLevel?`<p><strong>${escape(t('controlCenter.safetyCeiling'))}:</strong> ${escape(w.maxAgentLevel)}</p>`:''}
 </div>`;
 // Member Management + Invitations (Phase 4C-3) — owner-only, matching the exact backend
 // bar (GET/PATCH/DELETE .../members and .../invitations are all authorize(['owner'])); an
 // operator viewing Control Center never sees a control here that would just 403.
 if(w.role!=='owner')return;
 const teamHost=document.createElement('div');teamHost.id='cc-team';
 container.append(teamHost);
 renderTeamSection(teamHost);
}
function renderTeamSection(host){
 const membersPanel=document.createElement('div'),invitationsPanel=document.createElement('div');
 host.innerHTML=`<h4>${escape(t('invitations.teamTitle'))}</h4>`;
 host.append(membersPanel,invitationsPanel);
 tabs(host,[[t('invitations.membersTab'),membersPanel],[t('invitations.invitationsTab'),invitationsPanel]]);
 const inviteButton=button(t('invitations.inviteMember'),{variant:'primary',iconName:'plus'});
 inviteButton.onclick=()=>openInviteDrawer(host);
 membersPanel.append(inviteButton);
 loadMembers(membersPanel);
 loadInvitations(invitationsPanel);
}
async function loadMembers(panel){
 let members;
 try{members=await api('/api/workspaces/members');}
 catch(error){panel.append(Object.assign(document.createElement('div'),{innerHTML:empty(t('controlCenter.loadFailed'),error.message)}));return;}
 const list=document.createElement('div');list.className='grid';
 for(const member of members){
  const card=document.createElement('article');card.className='card';
  card.innerHTML=`<div class="row-between"><strong>${escape(member.name)}</strong>${badge(t('invitations.status.'+member.status.toUpperCase()),member.status==='active'?'CONNECTED':member.status==='suspended'?'PENDING':'DISCONNECTED')}</div>
   <p dir="ltr">${escape(member.username)}</p>
   <p>${escape(t('workspace.role'+member.role.charAt(0).toUpperCase()+member.role.slice(1)))}${member.isOwner?' · '+escape(t('invitations.ownerBadge')):''}</p>`;
  const actions=document.createElement('div');actions.className='report-actions';
  const roleSelect=document.createElement('select');
  for(const role of ['owner','reviewer','operator'])roleSelect.innerHTML+=`<option value="${role}" ${member.role===role?'selected':''}>${escape(t('workspace.role'+role.charAt(0).toUpperCase()+role.slice(1)))}</option>`;
  roleSelect.onchange=async()=>{
   try{await api(`/api/workspaces/members/${member.id}`,{role:roleSelect.value},'PATCH');toast(t('common.savedSuccessfully'));renderControlCenter({api:apiClient,auth:currentAuth});}
   catch(error){toastError(error.message);roleSelect.value=member.role;}
  };
  actions.append(roleSelect);
  if(member.status!=='removed'){
   const toggleStatus=button(member.status==='active'?t('invitations.suspend'):t('invitations.reactivate'),{variant:'secondary'});
   toggleStatus.onclick=async()=>{
    try{await api(`/api/workspaces/members/${member.id}`,{status:member.status==='active'?'suspended':'active'},'PATCH');toastAndRefresh(t('common.savedSuccessfully'));}
    catch(error){toastError(error.message);}
   };
   const remove=button(t('invitations.removeMember'),{variant:'danger'});
   remove.onclick=async()=>{
    const confirmed=await promptDrawer(t('invitations.removeMember'),n=>{n.innerHTML=`<p>${escape(t('invitations.removeConfirm',{name:member.name}))}</p>`;},{confirmLabel:t('invitations.removeMember')});
    if(!confirmed)return;
    try{await api(`/api/workspaces/members/${member.id}`,{},'DELETE');toastAndRefresh(t('common.savedSuccessfully'));}
    catch(error){toastError(error.message);}
   };
   actions.append(toggleStatus,remove);
  }
  card.append(actions);list.append(card);
 }
 panel.append(list);
}
async function loadInvitations(panel){
 let invitations;
 try{invitations=await api('/api/workspaces/invitations');}
 catch(error){panel.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
 if(!invitations.length){panel.innerHTML=empty(t('invitations.nonePending'));return;}
 panel.innerHTML='';
 for(const inv of invitations){
  const row=document.createElement('div');row.className='audit-row row-between';
  row.innerHTML=`<span>${escape(inv.email)} · ${escape(t('workspace.role'+inv.role.charAt(0).toUpperCase()+inv.role.slice(1)))} ${badge(t('invitations.status.'+inv.status),inv.status==='PENDING'?'PENDING':inv.status==='ACCEPTED'?'CONNECTED':'DISCONNECTED')}</span>`;
  const actions=document.createElement('div');actions.className='report-actions';
  if(inv.status==='PENDING'){
   const resend=button(t('invitations.resend'),{variant:'secondary'});
   resend.onclick=async()=>{
    try{const result=await api(`/api/workspaces/invitations/${inv.id}/resend`,{});await copyInviteLink(result.token);toastAndRefresh(t('invitations.linkCopied'));}
    catch(error){toastError(error.message);}
   };
   const revoke=button(t('invitations.revoke'),{variant:'danger'});
   revoke.onclick=async()=>{
    try{await api(`/api/workspaces/invitations/${inv.id}/revoke`,{});toastAndRefresh(t('common.savedSuccessfully'));}
    catch(error){toastError(error.message);}
   };
   actions.append(resend,revoke);
  }
  row.append(actions);panel.append(row);
 }
}
async function copyInviteLink(token){
 const url=`${location.origin}/#invite/${token}`;
 try{await navigator.clipboard.writeText(url);}catch{/* clipboard API unavailable — the drawer already shows the link as selectable text */}
 return url;
}
function openInviteDrawer(refreshHost){
 promptDrawer(t('invitations.inviteMember'),node=>{
  const emailInput=document.createElement('input');emailInput.name='email';emailInput.type='email';emailInput.required=true;emailInput.maxLength=254;
  const emailLabel=document.createElement('label');emailLabel.textContent=t('invitations.emailLabel');emailLabel.append(emailInput);
  const roleSelect=document.createElement('select');roleSelect.name='role';
  for(const role of ['operator','reviewer','owner'])roleSelect.innerHTML+=`<option value="${role}">${escape(t('workspace.role'+role.charAt(0).toUpperCase()+role.slice(1)))}</option>`;
  const roleLabel=document.createElement('label');roleLabel.textContent=t('invitations.roleLabel');roleLabel.append(roleSelect);
  node.append(emailLabel,roleLabel);
  return {value:()=>({email:emailInput.value.trim(),role:roleSelect.value}),focus:()=>emailInput.focus()};
 },{confirmLabel:t('invitations.sendInvite')}).then(async result=>{
  if(!result)return;
  try{
   const created=await api('/api/workspaces/invitations',result);
   const link=await copyInviteLink(created.token);
   await promptDrawer(t('invitations.linkReadyTitle'),n=>{n.innerHTML=`<p>${escape(t('invitations.linkReadyHint'))}</p><input readonly value="${escape(link)}" dir="ltr" onclick="this.select()">`;},{confirmLabel:t('common.close')});
   toastAndRefresh(t('invitations.linkCopied'));
  }catch(error){toastError(error.message);}
 });
}

// --- Connection detail / provider drawer ---------------------------------------------------

const TOKEN_EXPIRY_VARIANT={HEALTHY:'CONNECTED',EXPIRING_SOON:'PENDING',EXPIRED:'ERROR',REAUTH_REQUIRED:'ERROR'};
function openProviderDrawer(provider){
 const node=document.createElement('div');
 node.innerHTML=provider.connections.map(c=>`<div class="card" data-connection="${escape(c.id)}"><div class="row-between"><strong>${escape(c.name)}</strong>${c.isDefault?badge(t('controlCenter.default'),'CONNECTED'):''}</div>${statusBadge(c.status,{CONNECTED:'CONNECTED',DEGRADED:'DEGRADED',ERROR:'ERROR',TOKEN_EXPIRED:'ERROR',PERMISSION_MISSING:'ERROR',DISCONNECTED:'DISCONNECTED',CONNECTING:'PENDING',NOT_CONFIGURED:'PENDING'})}<p>${escape(c.externalAccountName||'—')}</p><p class="kpi-context">${escape(t('controlCenter.lastChecked'))}: ${escape(c.lastHealthCheck||'—')}</p><div data-token-expiry></div><div data-reauth></div><div class="report-actions"></div></div>`).join('');
 for(const c of provider.connections){
  const card=node.querySelector(`[data-connection="${CSS.escape(c.id)}"]`),actions=card.querySelector('.report-actions');
  // Phase 6H, Part 19-20 — Token Expiry proactive UI: a real, honest signal computed from the
  // actual stored token `expiresAt` (never a hardcoded/fake status) — shown for EVERY OAuth2
  // connection that has one, not just once something has already gone wrong, so an operator can
  // reconnect BEFORE a real interruption happens.
  if(c.healthView?.tokenExpiry && c.healthView.tokenExpiry.status!=='UNKNOWN'){
   const expiry=c.healthView.tokenExpiry;
   const expiryHost=card.querySelector('[data-token-expiry]');
   const label=t('controlCenter.tokenExpiry.'+expiry.status)+(expiry.expiresAt?` (${new Date(expiry.expiresAt).toLocaleDateString(getLocale()==='en'?'en-US':'ar-SA')})`:'');
   expiryHost.append(badge(label,TOKEN_EXPIRY_VARIANT[expiry.status]||'PENDING'));
  }
  // Phase 6G, Part 25/26 — Reauth UX: an honest, additive signal (never replacing the real
  // status badge above) shown ONLY when the connection's own OAuth2 refresh has genuinely
  // failed or has no refresh token — a direct one-click path to reconnect the SAME logical
  // connection (never a silent duplicate — Part 26).
  if(c.healthView && ['AUTH_FAILED','REAUTH_REQUIRED'].includes(c.healthView.displayStatus)){
   const reauthHost=card.querySelector('[data-reauth]');
   reauthHost.innerHTML=`<p class="notice trial-banner-warning">${escape(t('controlCenter.reauth.'+c.healthView.displayStatus))}</p>`;
   const reconnect=button(t('controlCenter.reauth.reconnectButton'),{variant:'primary'});
   reconnect.onclick=async()=>{
    try{const {reauthorizeUrl}=await api(`/api/integrations/connections/${c.id}/reconnect`,{});window.location.href=reauthorizeUrl;}
    catch(error){toastError(error.message);}
   };
   reauthHost.append(reconnect);
  }
  const test=button(t('controlCenter.testConnection'),{variant:'secondary'});
  test.onclick=async()=>{test.disabled=true;try{const result=await api(`/api/integrations/connections/${c.id}/test`,{});toast(t('controlCenter.testResult',{result:result.status}));card.querySelector('.pill').outerHTML=statusBadge(result.status,{CONNECTED:'CONNECTED',DEGRADED:'DEGRADED',ERROR:'ERROR',TOKEN_EXPIRED:'ERROR',PERMISSION_MISSING:'ERROR',DISCONNECTED:'DISCONNECTED'});}catch(error){toastError(error.message);}finally{test.disabled=false;}};
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
  // Item 16/17/19 — Manual Action Runner + Action History, through the EXACT SAME
  // ConnectorRuntime pipeline (capability/health/approval checks included) the Agent tool
  // path already uses — never a bypass, never a raw secret shown.
  const runAction=button(t('controlCenter.runAction'),{variant:'ghost'});
  runAction.onclick=()=>openActionRunner(c);
  actions.append(runAction);
  // Phase 6G — Versioning/Webhook Console/Usage, consolidated into one "Advanced" drawer
  // rather than three more buttons crowding every card; each of its tabs honestly reports
  // "not applicable" for a connector that doesn't support that particular feature.
  const advanced=button(t('controlCenter.advanced.button'),{variant:'ghost'});
  advanced.onclick=()=>openConnectionAdvancedDrawer(c);
  actions.append(advanced);
 }
 drawer(getLocale()==='en'?provider.nameEn:provider.nameAr,node);
}
async function openActionRunner(connection){
 const node=document.createElement('div');node.innerHTML=skeleton(t('common.loading'));
 const dialog=drawer(t('controlCenter.runAction'),node);
 let actions,history;
 try{[actions,history]=await Promise.all([api(`/api/integrations/connections/${connection.id}/actions`),api(`/api/integrations/connections/${connection.id}/action-history`)]);}
 catch(error){node.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
 if(!actions.length){node.innerHTML=empty(t('controlCenter.noActionsAvailable'));return;}
 node.innerHTML=`
  <label>${escape(t('controlCenter.actionLabel'))}<select name="action">${actions.map(a=>`<option value="${escape(a.slug)}" dir="ltr">${escape(getLocale()==='en'?a.nameEn:a.nameAr)} — ${escape(a.method)} ${escape(a.pathTemplate||'')}</option>`).join('')}</select></label>
  <label>${escape(t('controlCenter.actionInputLabel'))}<textarea name="input" dir="ltr" rows="4" placeholder="{}">{}</textarea></label>
  <div id="runner-result"></div>
  <div class="report-actions" id="runner-actions"></div>
  <h4>${escape(t('controlCenter.actionHistoryTitle'))}</h4>
  <div id="runner-history">${history.length?table([t('controlCenter.actionLabel'),t('controlCenter.statusLabel'),t('controlCenter.lastChecked'),t('common.field')],history.map(h=>[escape(h.actionSlug),badge(h.status,h.status==='OK'?'CONNECTED':'ERROR'),new Date(h.at).toLocaleString(getLocale()==='en'?'en-US':'ar-SA'),escape(h.errorCode||h.latencyMs+' ms')])):empty(t('controlCenter.noActionsRunYet'))}</div>`;
 const runButton=button(t('controlCenter.runAction'),{variant:'primary'});
 runButton.onclick=async()=>{
  const actionSlug=node.querySelector('[name=action]').value;
  let input={};
  try{input=JSON.parse(node.querySelector('[name=input]').value||'{}');}
  catch{toastError(t('controlCenter.invalidJson'));return;}
  runButton.disabled=true;
  try{
   const result=await api(`/api/integrations/connections/${connection.id}/actions/${actionSlug}`,{input});
   const resultHost=node.querySelector('#runner-result');
   if(result.status==='WAITING_APPROVAL'){resultHost.innerHTML=`<p class="notice">${escape(t('controlCenter.actionWaitingApproval'))}</p>`;}
   else if(result.status==='OK'){resultHost.innerHTML=`<p class="notice">${escape(t('controlCenter.actionSucceeded',{latency:result.latencyMs}))}</p><pre dir="ltr">${escape(JSON.stringify(result.output,null,1)).slice(0,2000)}</pre>`;}
   else{resultHost.innerHTML=`<p class="notice trial-banner-warning">${escape(t('controlCenter.actionFailed',{code:result.errorCode||result.status}))}</p>`;}
  }catch(error){toastError(error.message);}
  finally{runButton.disabled=false;}
 };
 node.querySelector('#runner-actions').append(runButton);
}

// --- Phase 6G: Version / Webhook Console / Usage (consolidated "Advanced" drawer) ----------

async function openConnectionAdvancedDrawer(connection){
 const node=document.createElement('div');
 const versionPanel=document.createElement('div'),webhookPanel=document.createElement('div'),usagePanel=document.createElement('div');
 node.append(versionPanel,webhookPanel,usagePanel);
 tabs(node,[[t('controlCenter.advanced.tabVersion'),versionPanel],[t('controlCenter.advanced.tabWebhook'),webhookPanel],[t('controlCenter.advanced.tabUsage'),usagePanel]]);
 drawer(t('controlCenter.advanced.button')+' — '+connection.name,node);
 paintVersionPanel(versionPanel,connection);
 paintWebhookPanel(webhookPanel,connection);
 paintUsagePanel(usagePanel,connection);
}
async function paintVersionPanel(panel,connection){
 panel.innerHTML=skeleton(t('common.loading'));
 let info;
 try{info=await api(`/api/integrations/connections/${connection.id}/version`);}
 catch(error){panel.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
 if(!info.supportsVersioning){panel.innerHTML=empty(t('controlCenter.advanced.versionNotApplicable'));return;}
 panel.innerHTML=`<p><strong>${escape(t('controlCenter.advanced.currentVersion'))}:</strong> ${escape(info.currentVersion??'—')}</p>
  <p><strong>${escape(t('controlCenter.advanced.availableVersion'))}:</strong> ${escape(info.availableVersion??'—')}</p>
  <div id="version-preview"></div>
  <div class="report-actions" id="version-actions"></div>`;
 const actionsHost=panel.querySelector('#version-actions');
 if(info.migrationAvailable){
  const migrateButton=button(t('controlCenter.advanced.migrateToVersion',{version:info.availableVersion}),{variant:'primary'});
  migrateButton.onclick=async()=>{
   const previewHost=panel.querySelector('#version-preview');
   previewHost.innerHTML=skeleton(t('common.loading'));
   let preview;
   try{preview=await api(`/api/integrations/connections/${connection.id}/version/preview?target=${info.availableVersion}`);}
   catch(error){previewHost.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
   previewHost.innerHTML=`<p>${escape(t('controlCenter.advanced.toolAssignmentsAffected',{count:preview.toolAssignmentsAffected}))}</p>`;
   const confirmed=await promptDrawer(t('controlCenter.advanced.migrateToVersion',{version:info.availableVersion}),n=>{
    n.innerHTML=`<p>${escape(t('controlCenter.advanced.migrateConfirm'))}</p>${preview.toolAssignmentsAffected?`<p class="notice trial-banner-warning">${escape(t('controlCenter.advanced.toolAssignmentsAffected',{count:preview.toolAssignmentsAffected}))}</p>`:''}`;
   },{confirmLabel:t('controlCenter.advanced.migrateToVersion',{version:info.availableVersion})});
   if(!confirmed)return;
   try{await api(`/api/integrations/connections/${connection.id}/version/migrate`,{targetVersion:info.availableVersion});toast(t('common.savedSuccessfully'));paintVersionPanel(panel,connection);}
   catch(error){toastError(error.message);}
  };
  actionsHost.append(migrateButton);
 }
 if(info.rollbackAvailable){
  const rollbackButton=button(t('controlCenter.advanced.rollback'),{variant:'secondary'});
  rollbackButton.onclick=async()=>{
   const confirmed=await promptDrawer(t('controlCenter.advanced.rollback'),n=>{n.innerHTML=`<p>${escape(t('controlCenter.advanced.rollbackConfirm'))}</p>`;},{confirmLabel:t('controlCenter.advanced.rollback')});
   if(!confirmed)return;
   try{await api(`/api/integrations/connections/${connection.id}/version/rollback`,{});toast(t('common.savedSuccessfully'));paintVersionPanel(panel,connection);}
   catch(error){toastError(error.message);}
  };
  actionsHost.append(rollbackButton);
 }
}
async function paintWebhookPanel(panel,connection){
 panel.innerHTML=skeleton(t('common.loading'));
 let view;
 try{view=await api(`/api/integrations/connections/${connection.id}/webhook-console`);}
 catch(error){panel.innerHTML=empty(t('controlCenter.advanced.webhookNotApplicable'));return;}
 panel.innerHTML=`<label>${escape(t('controlCenter.webhookUrlLabel'))}<input dir="ltr" readonly value="${escape(view.url)}"></label>
  <p>${escape(t('controlCenter.advanced.failedCount',{count:view.failedCount}))}</p>
  <div class="report-actions" id="webhook-actions"></div>
  <div id="webhook-test"></div>
  <div id="webhook-failed"></div>`;
 const rotateUrl=button(t('controlCenter.advanced.rotateUrl'),{variant:'secondary'});
 rotateUrl.onclick=async()=>{
  const confirmed=await promptDrawer(t('controlCenter.advanced.rotateUrl'),n=>{n.innerHTML=`<p>${escape(t('controlCenter.advanced.rotateUrlConfirm'))}</p>`;},{confirmLabel:t('controlCenter.advanced.rotateUrl')});
  if(!confirmed)return;
  try{await api(`/api/integrations/connections/${connection.id}/webhook/rotate-url`,{},'POST');toast(t('common.savedSuccessfully'));paintWebhookPanel(panel,connection);}
  catch(error){toastError(error.message);}
 };
 const rotateSecret=button(t('controlCenter.advanced.rotateSecret'),{variant:'secondary'});
 rotateSecret.onclick=async()=>{
  const confirmed=await promptDrawer(t('controlCenter.advanced.rotateSecret'),n=>{n.innerHTML=`<p>${escape(t('controlCenter.advanced.rotateSecretConfirm'))}</p>`;},{confirmLabel:t('controlCenter.advanced.rotateSecret')});
  if(!confirmed)return;
  try{
   const {webhookSecret}=await api(`/api/integrations/connections/${connection.id}/webhook/rotate-secret`,{},'POST');
   // Part 12 — shown exactly once, in a plain readonly field the operator can select/copy;
   // this drawer never re-fetches or re-displays it again after it closes.
   await promptDrawer(t('controlCenter.advanced.newSecretTitle'),n=>{
    n.innerHTML=`<p>${escape(t('controlCenter.advanced.newSecretShowOnce'))}</p><label>${escape(t('controlCenter.advanced.newSecretLabel'))}<input dir="ltr" readonly value="${escape(webhookSecret)}" onfocus="this.select()"></label>`;
   },{confirmLabel:t('common.close')});
  }catch(error){toastError(error.message);}
 };
 const testButton=button(t('controlCenter.advanced.sendTestEvent'),{variant:'ghost'});
 testButton.onclick=async()=>{
  const testHost=panel.querySelector('#webhook-test');
  try{
   const result=await api(`/api/integrations/connections/${connection.id}/webhook/test`,{triggerSlug:view.triggers[0]?.slug,samplePayload:{}});
   testHost.innerHTML=`<p class="notice">${escape(t('controlCenter.advanced.testEventResult',{status:result.status}))}</p>`;
  }catch(error){testHost.innerHTML=`<p class="notice trial-banner-warning">${escape(error.message)}</p>`;}
 };
 panel.querySelector('#webhook-actions').append(rotateUrl,rotateSecret,testButton);
 if(view.failedCount){
  const failedHost=panel.querySelector('#webhook-failed');
  const showFailed=button(t('controlCenter.advanced.viewFailedEvents'),{variant:'ghost'});
  showFailed.onclick=async()=>{
   let failed;
   try{failed=await api(`/api/integrations/connections/${connection.id}/webhook/failed`);}catch(error){toastError(error.message);return;}
   failedHost.innerHTML=failed.length?table([t('controlCenter.advanced.receivedAt'),t('controlCenter.advanced.trigger'),t('controlCenter.statusLabel'),'errorCode',t('controlCenter.advanced.reprocess')],
    failed.map(f=>[new Date(f.receivedAt).toLocaleString(getLocale()==='en'?'en-US':'ar-SA'),escape(f.triggerSlug),escape(f.status),escape(f.errorCode||'—'),`<span data-reprocess="${escape(f.id)}"></span>`])
   ):empty(t('common.noResults'));
   for(const f of failed){
    const cell=failedHost.querySelector(`[data-reprocess="${CSS.escape(f.id)}"]`);
    if(!cell)continue;
    const reprocessButton=button(t('controlCenter.advanced.reprocess'),{variant:'ghost'});
    reprocessButton.disabled=!f.hasRawPayload;
    reprocessButton.onclick=async()=>{
     const confirmed=await promptDrawer(t('controlCenter.advanced.reprocess'),n=>{n.innerHTML=`<p>${escape(t('controlCenter.advanced.reprocessConfirm'))}</p>`;},{confirmLabel:t('controlCenter.advanced.reprocess')});
     if(!confirmed)return;
     try{await api(`/api/integrations/connections/${connection.id}/webhook/failed/${f.id}/reprocess`,{},'POST');toast(t('common.savedSuccessfully'));showFailed.onclick();paintWebhookPanel(panel,connection);}
     catch(error){toastError(error.message);}
    };
    cell.append(reprocessButton);
   }
  };
  failedHost.append(showFailed);
 }
}
async function paintUsagePanel(panel,connection){
 panel.innerHTML=skeleton(t('common.loading'));
 let usage;
 try{usage=await api(`/api/integrations/connections/${connection.id}/usage?window=7d`);}
 catch(error){panel.innerHTML=empty(t('controlCenter.loadFailed'),error.message);return;}
 panel.innerHTML=`<div class="kpi-grid">
  ${metric(t('controlCenter.advanced.usageCalls'),usage.actionCalls)}
  ${metric(t('controlCenter.advanced.usageSuccess'),usage.success)}
  ${metric(t('controlCenter.advanced.usageFailure'),usage.failure)}
  ${metric(t('controlCenter.advanced.usageAvgLatency'),usage.averageLatencyMs!=null?usage.averageLatencyMs+' ms':'—')}
  ${metric(t('controlCenter.advanced.usageWebhookReceived'),usage.webhookReceived)}
  ${metric(t('controlCenter.advanced.usageWebhookFailed'),usage.webhookFailed)}
 </div>
 <p class="kpi-context">${escape(t('controlCenter.advanced.usageLastUsed',{when:usage.lastUsedAt?new Date(usage.lastUsedAt).toLocaleString(getLocale()==='en'?'en-US':'ar-SA'):'—'}))}</p>`;
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
