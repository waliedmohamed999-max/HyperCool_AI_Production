// Marketing & Social Operating Module (Phase MKT-1). A department view assembled ENTIRELY
// from real, already-existing systems (CRM leads/messages, content, agent runtime, approvals,
// Company Brain, Control Center/Platform integrations) plus the two genuinely new entities
// (campaigns, richer campaign content items — see src/marketing.js). Never a second CRM,
// never a second inbox, never a second orchestrator: Publishing/Brand/Integrations/Leads all
// deep-link into the existing pages that already own that data instead of duplicating it.
import {escape,button,badge,empty,metric,drawer,promptDrawer,confirmAction,table,tabs,enhance,icon,toast} from '../components/ui/index.js';
import {navigate} from '../components/layout/app-shell.js';
import {t,getLocale} from '../i18n.js';
import {fmtDateTime} from '../format.js';

const $=s=>document.querySelector('#marketing '+s);
let apiClient,currentAuth,renderGeneration=0;
async function api(path,body,method){return apiClient(path,body,method);}
function staleGuard(generation){return generation!==renderGeneration;}
function toastError(error){toast(error.message||String(error),'error');}

let campaignsCache=[],contentCache=[],metaCache={contentChannels:[],contentFormats:[],campaignStatuses:[],contentStatuses:[]};

export function installMarketingPage() {
 const root=document.querySelector('[data-page="marketing"] #marketing');
 // No page-level title here — app-shell.js's installShell() already prepends a real
 // header (title+description from navigation.json's "marketing" entry) to this route's
 // outer .page container for every entry in ROUTE_ICONS; rendering a second one here would
 // duplicate it (confirmed visually — this is the exact reason app-shell.js's own duplicate-
 // detection exists, which only catches a <section>'s OWN pre-existing .section-title at
 // installShell() time, before this function has populated the section at all).
 root.innerHTML=`
  <div id="mkt-health" class="kpi-grid"></div>
  <div id="mkt-tabs"></div>`;
 const panels=['overview','campaigns','content','calendar','inbox','widget','assets','performance'].map(key=>{const el=document.createElement('div');el.id='mkt-panel-'+key;return el;});
 $('#mkt-tabs').append(...panels);
 tabs($('#mkt-tabs'),[
  [t('marketing.tabOverview'),panels[0]],
  [t('marketing.tabCampaigns'),panels[1]],
  [t('marketing.tabContent'),panels[2]],
  [t('marketing.tabCalendar'),panels[3]],
  [t('marketing.tabInbox'),panels[4]],
  [t('marketing.tabWidget'),panels[5]],
  [t('marketing.tabAssets'),panels[6]],
  [t('marketing.tabPerformance'),panels[7]]
 ]);
 panels[1].innerHTML=`<div class="report-actions"><button type="button" id="mkt-new-campaign" class="button primary">${escape(t('marketing.newCampaign'))}</button></div><div id="mkt-campaigns-list"></div>`;
 panels[2].innerHTML=`<div class="report-actions"><button type="button" id="mkt-new-content" class="button primary">${escape(t('marketing.newContent'))}</button></div><div id="mkt-content-list"></div>`;
 panels[3].innerHTML=`<div id="mkt-calendar-list"></div>`;
 panels[4].innerHTML=`<div class="mkt-inbox-layout"><div id="mkt-inbox-list" class="mkt-inbox-conversations"></div><div id="mkt-inbox-thread" class="mkt-inbox-thread"></div></div>`;
 panels[5].innerHTML=`<div id="mkt-widget-config"></div>`;
 panels[6].innerHTML=`<div class="report-actions"><button type="button" id="mkt-new-asset-upload" class="button primary">${escape(t('marketing.assetsNewUpload'))}</button><button type="button" id="mkt-new-asset-external" class="button secondary">${escape(t('marketing.assetsNewExternal'))}</button></div><div id="mkt-assets-list"></div>`;
 panels[7].innerHTML=`<div id="mkt-performance"></div>`;
 $('#mkt-new-campaign').onclick=onNewCampaign;
 $('#mkt-new-content').onclick=()=>onNewContent();
 $('#mkt-new-asset-upload').onclick=onUploadAsset;
 $('#mkt-new-asset-external').onclick=onAddExternalAsset;
 // The Inbox is the one tab where staleness is actually misleading (a new conversation, e.g.
 // from the public website widget, can arrive at any moment) — refresh it on open rather than
 // only on a full page navigation, the same way Command Center's Live Operations panel stays
 // current without a full re-render.
 $('#mkt-tabs .ui-tabs').children[4]?.addEventListener('click',()=>{renderInbox().catch(toastError);});
 $('#mkt-tabs .ui-tabs').children[6]?.addEventListener('click',()=>{renderAssets().catch(toastError);});
 $('#mkt-tabs .ui-tabs').children[7]?.addEventListener('click',()=>{renderPerformance().catch(toastError);});
}

export async function renderMarketingPage({api:client,auth}) {
 apiClient=client;currentAuth=auth;
 const generation=++renderGeneration;
 let overview,campaigns,content,meta,analyticsSummary;
 try {
  [overview,campaigns,content,meta,analyticsSummary]=await Promise.all([
   api('/api/marketing/overview'),api('/api/marketing/campaigns'),api('/api/marketing/content'),api('/api/marketing/meta'),api('/api/marketing/analytics/summary')
  ]);
 } catch(error) {toastError(error);return;}
 if(staleGuard(generation))return;
 campaignsCache=campaigns;contentCache=content;metaCache=meta;
 renderHealth(overview);
 renderOverviewTab(overview,analyticsSummary);
 renderCampaignsList();
 renderContentList();
 renderCalendar();
 await renderInbox();
 await renderWidgetConfig();
 await renderAssets();
 await renderPerformance();
}

function renderHealth(overview) {
 const m=overview.marketing;
 $('#mkt-health').innerHTML=[
  metric(t('marketing.kpiLeads'),overview.kpis.leadsCreated.value,t('marketing.kpiThisWeek'),'users'),
  metric(t('marketing.kpiConversion'),(overview.kpis.conversionRate.value==null?'—':overview.kpis.conversionRate.value+'%'),t('marketing.kpiThisWeek'),'chart'),
  metric(t('marketing.kpiActiveCampaigns'),m.campaigns.active,t('marketing.kpiRightNow'),'calendar'),
  metric(t('marketing.kpiScheduledContent'),m.content.scheduled,t('marketing.kpiRightNow'),'file'),
  metric(t('marketing.kpiPendingApproval'),m.content.pendingApproval,t('marketing.kpiRightNow'),'file'),
  metric(t('marketing.kpiInboxVolume'),m.inboxVolume,t('marketing.kpiAllTime'),'agent')
 ].join('');
}

// Phase MKT-2, Part N — real analytics + performance summary, never fake zeroes. A provider
// with zero rows ever synced shows "not connected", not a 0 — matching
// getMarketingAnalyticsSummary's own connected/metrics:null distinction exactly.
function analyticsOverviewHtml(analyticsSummary) {
 if(!analyticsSummary?.hasAnyData)return `<p class="cmdc-muted">${escape(t('marketing.analyticsNoDataConnected'))}</p>`;
 return analyticsSummary.providers.filter(p=>p.connected).map(p=>{
  const m=p.metrics||{};
  const parts=['impressions','reach','engagement_rate','followers'].filter(k=>m[k]!=null)
   .map(k=>`${escape(k)}: <strong>${k==='engagement_rate'?(m[k]*100).toFixed(1)+'%':m[k]}</strong>`);
  return `<div class="row-between"><span>${escape(p.provider.toUpperCase())}</span><span class="cmdc-muted">${parts.join(' · ')||'—'}</span></div>`;
 }).join('');
}
function renderOverviewTab(overview,analyticsSummary) {
 const m=overview.marketing;
 const topChannelsHtml=m.topChannels.length
  ?`<div class="mkt-channel-list">${m.topChannels.map(c=>`<div class="row-between"><span>${escape(c.channel)}</span><strong>${c.count}</strong></div>`).join('')}</div>`
  :empty(t('marketing.noChannelActivity'));
 const recentCampaigns=campaignsCache.slice(0,5);
 const recentCampaignsHtml=recentCampaigns.length
  ?recentCampaigns.map(c=>`<div class="row-between"><span>${escape(c.name)}</span>${badge(t('marketing.status.'+c.status),c.status==='ACTIVE'?'CONNECTED':c.status==='DRAFT'?'PENDING':c.status)}</div>`).join('')
  :empty(t('marketing.noCampaignsYet'));
 $('#mkt-panel-overview').innerHTML=`
  <div class="mkt-overview-grid">
   <div class="report-section">
    <div class="report-section-head"><h3>${escape(t('marketing.analyticsNote'))}</h3></div>
    ${analyticsOverviewHtml(analyticsSummary)}
    ${analyticsSummary?.hasAnyData&&analyticsSummary.providers.some(p=>p.lastSyncedAt)?`<p class="cmdc-muted">${escape(t('marketing.analyticsLastSynced'))}: ${escape(fmtDateTime(analyticsSummary.providers.find(p=>p.lastSyncedAt)?.lastSyncedAt))}</p>`:''}
    <div class="report-actions"><button type="button" id="mkt-sync-analytics" class="button secondary">${escape(t('marketing.analyticsSyncNow'))}</button></div>
    <h4>${escape(t('marketing.topChannels'))}</h4>
    ${topChannelsHtml}
   </div>
   <div class="report-section">
    <div class="report-section-head"><h3>${escape(t('marketing.recentCampaigns'))}</h3></div>
    ${recentCampaignsHtml}
   </div>
   <div class="report-section">
    <div class="report-section-head"><h3>${escape(t('marketing.quickLinks'))}</h3></div>
    <div class="report-actions" id="mkt-quick-links"></div>
   </div>
  </div>`;
 $('#mkt-sync-analytics').onclick=async()=>{
  try {await api('/api/marketing/analytics/sync',{});toast(t('common.savedSuccessfully'));await renderMarketingPage({api:apiClient,auth:currentAuth});}
  catch(error) {toastError(error);}
 };
 const links=[
  [t('marketing.linkBrand'),'command-center'],[t('marketing.linkPublishingHealth'),'control-center'],
  [t('marketing.linkIntegrations'),'platform'],[t('marketing.linkLeadsCrm'),'crm']
 ];
 const host=$('#mkt-quick-links');
 for(const [label,route] of links) {
  const b=button(label,{variant:'secondary'});
  b.onclick=()=>navigate(route);
  host.append(b);
 }
}

// -----------------------------------------------------------------------------------------
// Campaigns
// -----------------------------------------------------------------------------------------
// `channels` defaults to the shared metaCache (populated by this page's own render) but can be
// overridden by a caller that hasn't warmed that cache — e.g. the WhatsApp page reusing this
// exact form pre-filtered to a single channel without depending on Marketing having rendered.
export function campaignFormFields(node,campaign,channels=metaCache.contentChannels) {
 const d=campaign||{};
 node.innerHTML=`
  <label>${escape(t('marketing.fieldName'))}<input name="name" required maxlength="200" value="${escape(d.name||'')}"></label>
  <label>${escape(t('marketing.fieldGoal'))}<input name="goal" maxlength="500" value="${escape(d.goal||'')}"></label>
  <div class="row">
   <label>${escape(t('marketing.fieldProduct'))}<input name="product" maxlength="200" value="${escape(d.product||'')}"></label>
   <label>${escape(t('marketing.fieldMarket'))}<input name="market" maxlength="200" value="${escape(d.market||'')}"></label>
  </div>
  <label>${escape(t('marketing.fieldAudience'))}<textarea name="audience" maxlength="500">${escape(d.audience||'')}</textarea></label>
  <label>${escape(t('marketing.fieldOffer'))}<textarea name="offer" maxlength="500">${escape(d.offer||'')}</textarea></label>
  <fieldset><legend>${escape(t('marketing.fieldChannels'))}</legend>
   ${channels.map(c=>`<label class="check"><input type="checkbox" name="channel" value="${c}" ${(d.channels||[]).includes(c)?'checked':''}> ${escape(c)}</label>`).join('')}
  </fieldset>
  <div class="row">
   <label>${escape(t('marketing.fieldTone'))}<input name="tone" maxlength="100" value="${escape(d.tone||'')}"></label>
   <label>${escape(t('marketing.fieldCta'))}<input name="cta" maxlength="200" value="${escape(d.cta||'')}"></label>
  </div>`;
 const nameInput=node.querySelector('[name=name]');
 return {
  value:()=>({
   name:nameInput.value.trim(),goal:node.querySelector('[name=goal]').value.trim(),
   product:node.querySelector('[name=product]').value.trim(),market:node.querySelector('[name=market]').value.trim(),
   audience:node.querySelector('[name=audience]').value.trim(),offer:node.querySelector('[name=offer]').value.trim(),
   channels:[...node.querySelectorAll('[name=channel]:checked')].map(el=>el.value),
   tone:node.querySelector('[name=tone]').value.trim(),cta:node.querySelector('[name=cta]').value.trim()
  }),
  validate:()=>{if(!nameInput.value.trim()){nameInput.setCustomValidity(t('common.reasonRequired'));nameInput.reportValidity();return false;}nameInput.setCustomValidity('');return true;},
  focus:()=>nameInput.focus()
 };
}
async function onNewCampaign() {
 const input=await promptDrawer(t('marketing.newCampaign'),node=>campaignFormFields(node,null),{confirmLabel:t('common.save')});
 if(!input)return;
 try {await api('/api/marketing/campaigns',input);toast(t('common.savedSuccessfully'));await renderMarketingPage({api:apiClient,auth:currentAuth});}
 catch(error) {toastError(error);}
}
function renderCampaignsList() {
 const host=$('#mkt-campaigns-list');
 if(!campaignsCache.length){host.innerHTML=empty(t('marketing.noCampaignsYet'),t('marketing.noCampaignsHint'));return;}
 host.innerHTML=table(
  [t('marketing.fieldName'),t('controlCenter.statusLabel'),t('marketing.fieldChannels'),t('marketing.colUpdated')],
  campaignsCache.map(c=>[
   `<a href="#" data-open-campaign="${escape(c.id)}">${escape(c.name)}</a>`,
   badge(t('marketing.status.'+c.status),c.status==='ACTIVE'?'CONNECTED':c.status==='DRAFT'||c.status==='PLANNING'?'PENDING':c.status==='FAILED'?'ERROR':'DEFAULT'),
   escape((c.channels||[]).join('، ')||'—'),
   escape(fmtDateTime(c.updatedAt))
  ])
 );
 enhance(host);
 host.querySelectorAll('[data-open-campaign]').forEach(a=>a.onclick=e=>{e.preventDefault();openCampaignDetail(a.dataset.openCampaign);});
}
async function openCampaignDetail(id) {
 let campaign;
 try {campaign=await api(`/api/marketing/campaigns/${id}`);} catch(error) {toastError(error);return;}
 const node=document.createElement('div');
 const overviewPanel=document.createElement('div'),strategyPanel=document.createElement('div'),
  intelligencePanel=document.createElement('div'),contentPanel=document.createElement('div'),orchestrationPanel=document.createElement('div');
 node.append(overviewPanel,strategyPanel,intelligencePanel,contentPanel,orchestrationPanel);
 tabs(node,[
  [t('marketing.tabDetailOverview'),overviewPanel],[t('marketing.tabDetailStrategy'),strategyPanel],
  [t('marketing.tabDetailIntelligence'),intelligencePanel],[t('marketing.tabDetailContent'),contentPanel],
  [t('marketing.orchestrationTitle'),orchestrationPanel]
 ]);
 function paintOverview() {
  overviewPanel.innerHTML=`
   <p><strong>${escape(t('marketing.fieldGoal'))}:</strong> ${escape(campaign.goal||'—')}</p>
   <p><strong>${escape(t('marketing.fieldProduct'))}:</strong> ${escape(campaign.product||'—')} · <strong>${escape(t('marketing.fieldMarket'))}:</strong> ${escape(campaign.market||'—')}</p>
   <p><strong>${escape(t('marketing.fieldAudience'))}:</strong> ${escape(campaign.audience||'—')}</p>
   <p><strong>${escape(t('marketing.fieldOffer'))}:</strong> ${escape(campaign.offer||'—')}</p>
   <p><strong>${escape(t('marketing.fieldChannels'))}:</strong> ${escape((campaign.channels||[]).join('، ')||'—')}</p>
   <div class="row" id="campaign-status-actions"></div>`;
  const statusSelect=document.createElement('select');
  metaCache.campaignStatuses.forEach(s=>{const opt=document.createElement('option');opt.value=s;opt.textContent=t('marketing.status.'+s);opt.selected=s===campaign.status;statusSelect.append(opt);});
  const saveStatus=button(t('common.save'),{variant:'primary'});
  saveStatus.onclick=async()=>{
   try {campaign=await api(`/api/marketing/campaigns/${campaign.id}`,{status:statusSelect.value},'PATCH');toast(t('common.savedSuccessfully'));renderCampaignsListSilently();}
   catch(error) {toastError(error);}
  };
  overviewPanel.querySelector('#campaign-status-actions').append(statusSelect,saveStatus);
 }
 function paintStrategy() {
  strategyPanel.innerHTML=campaign.strategy
   ?`<pre class="mkt-strategy-json" dir="auto">${escape(JSON.stringify(campaign.strategy,null,2))}</pre>`
   :empty(t('marketing.noStrategyYet'),t('marketing.noStrategyHint'));
  const genButton=button(t('marketing.generateStrategy'),{variant:'primary'});
  genButton.onclick=async()=>{
   genButton.disabled=true;
   try {
    const result=await api(`/api/marketing/campaigns/${campaign.id}/generate-strategy`,{});
    campaign=result.campaign;
    if(result.run.status==='FAILED')toast(t('marketing.aiNotAvailable'),'error');else toast(t('common.savedSuccessfully'));
    paintStrategy();
   } catch(error) {toastError(error);} finally {genButton.disabled=false;}
  };
  strategyPanel.append(genButton);
 }
 function paintIntelligence() {
  intelligencePanel.innerHTML=campaign.intelligence
   ?`<pre class="mkt-strategy-json" dir="auto">${escape(JSON.stringify(campaign.intelligence,null,2))}</pre>`
   :empty(t('marketing.noIntelligenceYet'),t('marketing.noIntelligenceHint'));
  const genButton=button(t('marketing.generateIntelligence'),{variant:'primary'});
  genButton.onclick=async()=>{
   genButton.disabled=true;
   try {
    const result=await api(`/api/marketing/campaigns/${campaign.id}/generate-intelligence`,{});
    campaign=result.campaign;
    if(result.run.status==='FAILED')toast(t('marketing.aiNotAvailable'),'error');else toast(t('common.savedSuccessfully'));
    paintIntelligence();
   } catch(error) {toastError(error);} finally {genButton.disabled=false;}
  };
  intelligencePanel.append(genButton);
 }
 async function paintContent() {
  let items;
  try {items=await api(`/api/marketing/content?campaignId=${campaign.id}`);} catch(error) {toastError(error);return;}
  contentPanel.innerHTML=items.length
   ?table([t('marketing.fieldChannel'),t('marketing.fieldFormat'),t('controlCenter.statusLabel')],
     items.map(i=>[escape(i.channel),escape(i.format),badge(t('marketing.contentStatus.'+i.status),i.status==='PUBLISHED'?'CONNECTED':i.status==='APPROVED'||i.status==='SCHEDULED'?'PENDING':i.status==='FAILED'?'ERROR':'DEFAULT')]))
   :empty(t('marketing.noCampaignContentYet'));
  const addButton=button(t('marketing.newContent'),{variant:'primary',iconName:'plus'});
  addButton.onclick=()=>onNewContent(campaign.id,paintContent);
  contentPanel.append(addButton);
 }
 // Phase MKT-2, Part B/N — the real automated orchestration workflow this campaign may have
 // (built entirely on the existing native Workflow Engine, see src/marketing.js). Manual mode
 // (Strategy/Intelligence tabs above) stays fully independent either way.
 async function paintOrchestration() {
  let data;
  try {data=await api(`/api/marketing/campaigns/${campaign.id}/orchestration`);} catch(error) {toastError(error);return;}
  if(!data.workflow) {
   orchestrationPanel.innerHTML=empty(t('marketing.orchestrationNotCreated'));
   const createButton=button(t('marketing.orchestrationCreate'),{variant:'primary'});
   createButton.onclick=async()=>{
    try {await api(`/api/marketing/campaigns/${campaign.id}/orchestration`,{});toast(t('common.savedSuccessfully'));await paintOrchestration();}
    catch(error) {toastError(error);}
   };
   orchestrationPanel.append(createButton);
   return;
  }
  const latestRun=data.runs[0];
  orchestrationPanel.innerHTML=`
   <p><strong>${escape(t('marketing.orchestrationStatus'))}:</strong> ${badge(data.workflow.status,data.workflow.status==='ACTIVE'?'CONNECTED':'DEFAULT')}</p>
   ${latestRun?`<div class="report-section"><div class="report-section-head"><h4>${escape(fmtDateTime(latestRun.createdAt||latestRun.startedAt))}</h4>${badge(latestRun.status,latestRun.status==='COMPLETED'?'CONNECTED':latestRun.status==='FAILED'?'ERROR':'PENDING')}</div>
     ${(latestRun.steps||[]).map(s=>`<div class="row-between"><span>${escape(s.stepId||s.stepType)}</span>${badge(s.status,s.status==='COMPLETED'?'CONNECTED':s.status==='FAILED'?'ERROR':'PENDING')}</div>`).join('')}
    </div>`:empty(t('commandCenter.noOperationsTitle'))}
   <div class="report-actions" id="mkt-orchestration-actions"></div>`;
  const runButton=button(t('marketing.orchestrationRun'),{variant:'primary'});
  runButton.onclick=async()=>{
   try {await api(`/api/marketing/campaigns/${campaign.id}/orchestration/run`,{});toast(t('common.savedSuccessfully'));await paintOrchestration();}
   catch(error) {toastError(error);}
  };
  orchestrationPanel.querySelector('#mkt-orchestration-actions').append(runButton);
 }
 paintOverview();paintStrategy();paintIntelligence();await paintContent();await paintOrchestration();
 drawer(campaign.name,node);
}
function renderCampaignsListSilently() {renderCampaignsList();}

// -----------------------------------------------------------------------------------------
// Content Studio
// -----------------------------------------------------------------------------------------
function contentFormFields(node,campaignId) {
 node.innerHTML=`
  <div class="row">
   <label>${escape(t('marketing.fieldChannel'))}<select name="channel" required>${metaCache.contentChannels.map(c=>`<option value="${c}">${escape(c)}</option>`).join('')}</select></label>
   <label>${escape(t('marketing.fieldFormat'))}<select name="format" required>${metaCache.contentFormats.map(f=>`<option value="${f}">${escape(t('marketing.format.'+f))}</option>`).join('')}</select></label>
  </div>
  <label>${escape(t('marketing.fieldHook'))}<input name="hook" maxlength="300"></label>
  <label>${escape(t('marketing.fieldBody'))}<textarea name="body" maxlength="8000" required></textarea></label>
  <label>${escape(t('marketing.fieldCta'))}<input name="cta" maxlength="200"></label>
  <label>${escape(t('marketing.fieldHashtags'))}<input name="hashtags" placeholder="${escape(t('marketing.fieldHashtagsPlaceholder'))}"></label>`;
 const bodyInput=node.querySelector('[name=body]');
 return {
  value:()=>({
   campaignId:campaignId||undefined,channel:node.querySelector('[name=channel]').value,format:node.querySelector('[name=format]').value,
   hook:node.querySelector('[name=hook]').value.trim(),body:bodyInput.value.trim(),cta:node.querySelector('[name=cta]').value.trim(),
   hashtags:node.querySelector('[name=hashtags]').value.split(',').map(s=>s.trim()).filter(Boolean)
  }),
  validate:()=>{if(!bodyInput.value.trim()){bodyInput.setCustomValidity(t('common.reasonRequired'));bodyInput.reportValidity();return false;}bodyInput.setCustomValidity('');return true;},
  focus:()=>node.querySelector('[name=channel]').focus()
 };
}
async function onNewContent(campaignId,after) {
 const input=await promptDrawer(t('marketing.newContent'),node=>contentFormFields(node,campaignId),{confirmLabel:t('common.save')});
 if(!input)return;
 try {
  await api('/api/marketing/content',input);
  toast(t('common.savedSuccessfully'));
  if(after)await after(); else await renderMarketingPage({api:apiClient,auth:currentAuth});
 } catch(error) {toastError(error);}
}
const CONTENT_NEXT_STATUS={DRAFT:'IN_REVIEW',IN_REVIEW:'APPROVED',APPROVED:'SCHEDULED',SCHEDULED:'PUBLISHED'};
function complianceBadgeHtml(item) {
 if(!item.complianceClassification)return badge(t('marketing.complianceNotChecked'),'DEFAULT');
 if(!item.complianceValid)return badge(t('marketing.complianceStale'),'PENDING');
 if(item.complianceClassification==='BLOCK')return badge(t('marketing.complianceBlocked'),'ERROR');
 if(item.complianceClassification==='PASS_WITH_EDITS')return badge(t('marketing.compliancePassWithEdits'),'PENDING');
 return badge(t('marketing.compliancePass'),'CONNECTED');
}
async function refreshContentList() {
 try {contentCache=await api('/api/marketing/content');} catch(error) {toastError(error);return;}
 renderContentList();
}
function renderContentList() {
 const host=$('#mkt-content-list');
 if(!contentCache.length){host.innerHTML=empty(t('marketing.noContentYet'),t('marketing.noContentHint'));return;}
 host.innerHTML=contentCache.map(item=>`<article class="card" data-content-id="${escape(item.id)}">
   <div class="row-between"><strong>${escape(item.channel)} · ${escape(t('marketing.format.'+item.format))}</strong>${badge(t('marketing.contentStatus.'+item.status),item.status==='PUBLISHED'?'CONNECTED':item.status==='APPROVED'||item.status==='SCHEDULED'?'PENDING':item.status==='FAILED'?'ERROR':'DEFAULT')}</div>
   <p>${escape(item.body.slice(0,180))}${item.body.length>180?'…':''}</p>
   ${item.hashtags?.length?`<p class="cmdc-muted">${item.hashtags.map(h=>'#'+escape(h)).join(' ')}</p>`:''}
   <div class="row-between"><span data-compliance-badge></span>${item.creativeBrief?`<span class="cmdc-muted">${escape(t('marketing.creativeBriefTitle'))} ✓</span>`:''}</div>
   <div class="row" data-content-actions></div>
  </article>`).join('');
 for(const item of contentCache) {
  const card=host.querySelector(`[data-content-id="${CSS.escape(item.id)}"]`);
  const actionsHost=card.querySelector('[data-content-actions]');
  card.querySelector('[data-compliance-badge]').innerHTML=complianceBadgeHtml(item);
  // Part C: real gate — IN_REVIEW can only advance to APPROVED once a real, non-stale,
  // non-BLOCK compliance run exists. The button is simply not offered otherwise; the
  // "Run Compliance Check" button (always offered at IN_REVIEW) is the only way forward.
  if(item.status==='IN_REVIEW') {
   const runCompliance=button(t('marketing.runCompliance'),{variant:'secondary'});
   runCompliance.onclick=async()=>{
    runCompliance.disabled=true;
    try {await api(`/api/marketing/content/${item.id}/run-compliance`,{});toast(t('common.savedSuccessfully'));await refreshContentList();}
    catch(error) {toastError(error);} finally {runCompliance.disabled=false;}
   };
   actionsHost.append(runCompliance);
   if(item.complianceClassification && item.complianceValid && item.complianceClassification!=='BLOCK') {
    const approve=button(t('marketing.advanceTo.APPROVED'),{variant:'primary'});
    approve.onclick=async()=>{
     try {await api(`/api/marketing/content/${item.id}`,{status:'APPROVED'},'PATCH');toast(t('common.savedSuccessfully'));await refreshContentList();}
     catch(error) {toastError(error);}
    };
    actionsHost.append(approve);
   }
  } else {
   const next=CONTENT_NEXT_STATUS[item.status];
   if(next) {
    const advance=button(t('marketing.advanceTo.'+next),{variant:'primary'});
    advance.onclick=async()=>{
     const patch={status:next};
     // Moving to SCHEDULED without a real time would silently disappear from the Calendar
     // tab (it filters on scheduledAt/publishedAt) — ask for one instead of leaving it null.
     if(next==='SCHEDULED') {
      const when=await promptDrawer(t('marketing.advanceTo.SCHEDULED'),node=>{
       // Label reuses calendar.scheduleTime ("Time (Riyadh)") rather than the generic
       // marketing.colWhen — makes the single canonical scheduling timezone (item 9) explicit
       // to the person filling this in, matching the Global Calendar's own schedule form.
       node.innerHTML=`<label>${escape(t('calendar.scheduleTime'))}<input name="scheduledAt" type="datetime-local" required></label>`;
       const input=node.querySelector('[name=scheduledAt]');
       // Production-readiness gate item 9 (timezone consistency): this app has one canonical
       // scheduling timezone, Riyadh (+03:00) — see public/planning.js's identical
       // `input.localTime+':00+03:00'` pattern for the Global Calendar's own schedule form.
       // `new Date(input.value)` on a bare datetime-local value (no offset) is interpreted in
       // the VISITOR'S BROWSER-LOCAL timezone by the JS spec, not Riyadh — two people in
       // different timezones typing the identical displayed time would silently schedule two
       // different real UTC instants. Always attach the explicit Riyadh offset before parsing.
       return {value:()=>input.value?new Date(input.value+':00+03:00').toISOString():null,validate:()=>{if(!input.value){input.setCustomValidity(t('common.reasonRequired'));input.reportValidity();return false;}input.setCustomValidity('');return true;},focus:()=>input.focus()};
      },{confirmLabel:t('marketing.advanceTo.SCHEDULED')});
      if(!when)return;
      patch.scheduledAt=when;
     }
     try {await api(`/api/marketing/content/${item.id}`,patch,'PATCH');toast(t('common.savedSuccessfully'));await renderMarketingPage({api:apiClient,auth:currentAuth});}
     catch(error) {toastError(error);}
    };
    actionsHost.append(advance);
   }
  }
  if(item.status==='DRAFT'||item.status==='IN_REVIEW') {
   const genCreative=button(t('marketing.generateCreative'),{variant:'secondary'});
   genCreative.onclick=async()=>{
    genCreative.disabled=true;
    try {await api(`/api/marketing/content/${item.id}/generate-creative`,{});toast(t('common.savedSuccessfully'));await refreshContentList();}
    catch(error) {toastError(error);} finally {genCreative.disabled=false;}
   };
   actionsHost.append(genCreative);
  }
 }
}

// -----------------------------------------------------------------------------------------
// Calendar — Month/Week/List (Phase MKT-2, Part L). Reuses the exact grid math and CSS
// classes (.calendar-grid/.calendar-day/.calendar-heading/.calendar-event) already proven by
// the legacy Planning calendar (public/pages/workspace.js's renderCalendar) — no new grid
// system, no new CSS. Filters by channel/campaign/status/date; RTL/Arabic stays correct
// because it's the same i18n (`t()`) + CSS this whole page already uses.
// -----------------------------------------------------------------------------------------
let calendarMode='list',calendarDate='',calendarChannel='',calendarCampaign='',calendarStatus='';
function renderCalendar() {
 const host=$('#mkt-calendar-list');
 const items=contentCache.filter(i=>i.scheduledAt||i.publishedAt);
 if(!calendarDate)calendarDate=(items.sort((a,b)=>(a.scheduledAt||a.publishedAt).localeCompare(b.scheduledAt||b.publishedAt))[0]?.scheduledAt||items[0]?.publishedAt||new Date().toISOString()).slice(0,10);
 host.innerHTML='<div class="calendar-controls"></div><div class="calendar-output"></div>';
 const controls=host.firstChild;
 for(const [key,label] of [['month',t('marketing.calendarViewMonth')],['week',t('marketing.calendarViewWeek')],['list',t('marketing.calendarViewList')]]) {
  const b=button(label,{variant:calendarMode===key?'primary':'secondary','aria-pressed':String(calendarMode===key)});
  b.onclick=()=>{calendarMode=key;renderCalendar();};
  controls.append(b);
 }
 const dateInput=document.createElement('input');
 dateInput.type='date';dateInput.value=calendarDate;dateInput.setAttribute('aria-label',t('marketing.calendarDateLabel'));
 dateInput.onchange=()=>{if(dateInput.value)calendarDate=dateInput.value;renderCalendar();};
 const channelSelect=document.createElement('select');
 channelSelect.setAttribute('aria-label',t('marketing.fieldChannel'));
 channelSelect.innerHTML=`<option value="">${escape(t('marketing.calendarAllChannels'))}</option>`+metaCache.contentChannels.map(c=>`<option ${c===calendarChannel?'selected':''}>${escape(c)}</option>`).join('');
 channelSelect.onchange=()=>{calendarChannel=channelSelect.value;renderCalendar();};
 const campaignSelect=document.createElement('select');
 campaignSelect.setAttribute('aria-label',t('marketing.fieldName'));
 campaignSelect.innerHTML=`<option value="">${escape(t('marketing.calendarAllCampaigns'))}</option>`+campaignsCache.map(c=>`<option value="${escape(c.id)}" ${c.id===calendarCampaign?'selected':''}>${escape(c.name)}</option>`).join('');
 campaignSelect.onchange=()=>{calendarCampaign=campaignSelect.value;renderCalendar();};
 const statusSelect=document.createElement('select');
 statusSelect.setAttribute('aria-label',t('controlCenter.statusLabel'));
 statusSelect.innerHTML=`<option value="">${escape(t('marketing.calendarAllStatuses'))}</option>`+metaCache.contentStatuses.map(s=>`<option value="${escape(s)}" ${s===calendarStatus?'selected':''}>${escape(t('marketing.contentStatus.'+s))}</option>`).join('');
 statusSelect.onchange=()=>{calendarStatus=statusSelect.value;renderCalendar();};
 controls.append(dateInput,channelSelect,campaignSelect,statusSelect);
 const filtered=items.filter(i=>(!calendarChannel||i.channel===calendarChannel)&&(!calendarCampaign||i.campaignId===calendarCampaign)&&(!calendarStatus||i.status===calendarStatus));
 const output=host.lastChild;
 if(!filtered.length){output.innerHTML=empty(t('marketing.noScheduledContent'));return;}
 if(calendarMode==='list') {
  output.innerHTML=table(
   [t('marketing.colWhen'),t('marketing.fieldChannel'),t('marketing.fieldFormat'),t('controlCenter.statusLabel')],
   filtered.sort((a,b)=>(a.scheduledAt||a.publishedAt).localeCompare(b.scheduledAt||b.publishedAt))
    .map(i=>[escape(fmtDateTime(i.scheduledAt||i.publishedAt)),escape(i.channel),escape(t('marketing.format.'+i.format)),badge(t('marketing.contentStatus.'+i.status),i.status==='PUBLISHED'?'CONNECTED':'PENDING')])
  );
  return;
 }
 const selected=new Date(calendarDate+'T00:00:00Z'),start=new Date(selected);
 if(calendarMode==='month')start.setUTCDate(1);
 start.setUTCDate(start.getUTCDate()-start.getUTCDay());
 const dayCount=calendarMode==='week'?7:Math.ceil((new Date(selected.getUTCFullYear(),selected.getUTCMonth()+1,0).getDate()+new Date(Date.UTC(selected.getUTCFullYear(),selected.getUTCMonth(),1)).getUTCDay())/7)*7;
 const dayNames=t('weeklyReport.dayNames');
 let html=dayNames.map(day=>`<div class="calendar-heading">${escape(day)}</div>`).join('');
 for(let i=0;i<dayCount;i++) {
  const d=new Date(start);d.setUTCDate(start.getUTCDate()+i);
  const key=d.toISOString().slice(0,10);
  const dayItems=filtered.filter(it=>(it.scheduledAt||it.publishedAt||'').slice(0,10)===key);
  html+=`<div class="calendar-day"><time datetime="${key}">${d.getUTCDate()} / ${d.getUTCMonth()+1}</time>${dayItems.map(it=>`<span class="calendar-event">${escape(it.channel)} · ${escape(t('marketing.format.'+it.format))}<br>${badge(t('marketing.contentStatus.'+it.status),it.status==='PUBLISHED'?'CONNECTED':'PENDING')}</span>`).join('')}</div>`;
 }
 output.innerHTML=`<div class="table-scroll" tabindex="0" role="region" aria-label="${escape(t('calendar.scrollableAriaLabel'))}"><div class="calendar-grid">${html}</div></div>`;
}

// -----------------------------------------------------------------------------------------
// Unified Inbox — real CRM leads/messages, no second model.
// -----------------------------------------------------------------------------------------
let inboxConversations=[],selectedLeadId=null;
async function renderInbox() {
 try {inboxConversations=await api('/api/marketing/inbox');} catch(error) {toastError(error);return;}
 const host=$('#mkt-inbox-list');
 if(!inboxConversations.length){host.innerHTML=empty(t('marketing.noConversationsYet'));return;}
 host.innerHTML=inboxConversations.map(c=>`<button type="button" class="mkt-inbox-row" data-lead="${escape(c.leadId)}">
   <strong>${escape(c.name)}</strong><span class="cmdc-muted">${escape(c.channel||'—')}</span>
   <time>${escape(fmtDateTime(c.lastInboundAt||c.lastOutboundAt))}</time>
  </button>`).join('');
 host.querySelectorAll('[data-lead]').forEach(b=>b.onclick=()=>openConversation(b.dataset.lead));
 if(selectedLeadId)await openConversation(selectedLeadId);
}
async function openConversation(leadId) {
 selectedLeadId=leadId;
 const conversation=inboxConversations.find(c=>c.leadId===leadId);
 let messages;
 try {messages=await api(`/api/marketing/inbox/${leadId}/messages`);} catch(error) {toastError(error);return;}
 const host=$('#mkt-inbox-thread');
 host.innerHTML=`
  <div class="mkt-inbox-thread-head">
   <div><strong>${escape(conversation?.name||'—')}</strong><span class="cmdc-muted"> · ${escape(conversation?.channel||'—')}</span></div>
   <button type="button" class="small secondary" id="mkt-open-crm">${escape(t('marketing.openInCrm'))}</button>
  </div>
  <div class="mkt-inbox-messages">${messages.map(m=>`<div class="cmdc-message cmdc-message-${m.direction==='INBOUND'?'assistant':'user'}"><p>${escape(m.text)}</p><small class="cmdc-muted">${escape(fmtDateTime(m.recordedAt))}</small></div>`).join('')}</div>`;
 $('#mkt-open-crm').onclick=()=>navigate('crm');
}

// -----------------------------------------------------------------------------------------
// Website Chat Widget config
// -----------------------------------------------------------------------------------------
async function renderWidgetConfig() {
 let widget;
 try {widget=await api('/api/marketing/widget');} catch(error) {toastError(error);return;}
 const host=$('#mkt-widget-config');
 const embedSnippet=`<script src="${location.origin}/widget-embed.js" data-widget-id="${widget.publicWidgetId}" async></` + `script>`;
 host.innerHTML=`
  <form id="mkt-widget-form">
   <label class="check"><input type="checkbox" name="active" ${widget.status==='ACTIVE'?'checked':''}> ${escape(t('marketing.widgetActive'))}</label>
   <label>${escape(t('marketing.widgetDomains'))}<input name="domains" value="${escape((widget.allowedDomains||[]).join(', '))}" placeholder="example.com, shop.example.com"></label>
   <label>${escape(t('marketing.widgetGreeting'))}<textarea name="greeting" maxlength="500">${escape(widget.greeting||'')}</textarea></label>
   <label>${escape(t('marketing.widgetBusinessHours'))}<input name="businessHours" maxlength="300" value="${escape(widget.businessHoursNote||'')}"></label>
   <div class="report-actions"><button type="submit" class="button primary">${escape(t('common.save'))}</button></div>
  </form>
  <h4>${escape(t('marketing.widgetEmbedTitle'))}</h4>
  <p class="cmdc-muted">${escape(t('marketing.widgetEmbedHint'))}</p>
  <textarea readonly class="mkt-embed-snippet" dir="ltr">${escape(embedSnippet)}</textarea>
  <div class="report-actions"><button type="button" id="mkt-widget-regenerate" class="button secondary">${escape(t('marketing.widgetRegenerate'))}</button></div>`;
 $('#mkt-widget-form').addEventListener('submit',async event=>{
  // app.js's global document-level submit delegate treats every unrecognized form as a
  // generic /api/content/:id/:action submit (real for existing content-review forms, wrong
  // for this one) — stopPropagation avoids that stray call, same established fix as
  // command-center.js's onSendMessage/onAddContext.
  event.preventDefault();
  event.stopPropagation();
  const form=event.target;
  try {
   await api('/api/marketing/widget',{
    status:form.active.checked?'ACTIVE':'DISABLED',
    allowedDomains:form.domains.value.split(',').map(s=>s.trim()).filter(Boolean),
    greeting:form.greeting.value.trim(),businessHoursNote:form.businessHours.value.trim()
   },'PATCH');
   toast(t('common.savedSuccessfully'));
   await renderWidgetConfig();
  } catch(error) {toastError(error);}
 });
 $('#mkt-widget-regenerate').onclick=async()=>{
  const confirmed=await confirmAction(t('marketing.widgetRegenerate'),t('marketing.widgetRegenerateConfirm'));
  if(!confirmed)return;
  try {await api('/api/marketing/widget/regenerate',{});toast(t('common.savedSuccessfully'));await renderWidgetConfig();}
  catch(error) {toastError(error);}
 };
}

// -----------------------------------------------------------------------------------------
// Marketing Assets (Phase MKT-2, Part K) — uploads reuse the EXISTING /api/command/attachments
// store; this page only ever creates a marketing_assets row pointing at a real, already-
// uploaded attachment id (or a real HTTPS URL / free-text creative reference).
// -----------------------------------------------------------------------------------------
async function renderAssets() {
 let assets;
 try {assets=await api('/api/marketing/assets');} catch(error) {toastError(error);return;}
 const host=$('#mkt-assets-list');
 if(!assets.length){host.innerHTML=empty(t('marketing.assetsNoneYet'),t('marketing.assetsNoneHint'));return;}
 host.innerHTML=assets.map(a=>`<article class="card" data-asset-id="${escape(a.id)}">
   <div class="row-between"><strong>${escape(t('marketing.assetType.'+a.type))}</strong>${a.approved?badge(t('marketing.assetsApproved'),'CONNECTED'):''}</div>
   ${a.source==='upload'&&a.type==='image'?`<img src="/api/command/attachments/${encodeURIComponent(a.fileRef)}/file" alt="" style="max-width:100%;max-height:160px;object-fit:contain" onerror="this.style.display='none'">`:''}
   <p class="cmdc-muted" dir="ltr">${escape(a.fileRef)}</p>
   <div class="row" data-asset-actions></div>
  </article>`).join('');
 for(const asset of assets) {
  const actionsHost=host.querySelector(`[data-asset-id="${CSS.escape(asset.id)}"] [data-asset-actions]`);
  if(!asset.approved) {
   const approveButton=button(t('marketing.assetsApprove'),{variant:'primary'});
   approveButton.onclick=async()=>{
    try {await api(`/api/marketing/assets/${asset.id}`,{approved:true},'PATCH');toast(t('common.savedSuccessfully'));await renderAssets();}
    catch(error) {toastError(error);}
   };
   actionsHost.append(approveButton);
  }
  const deleteButton=button(t('marketing.assetsDelete'),{variant:'danger'});
  deleteButton.onclick=async()=>{
   const confirmed=await confirmAction(t('marketing.assetsDelete'),t('marketing.assetsDelete'));
   if(!confirmed)return;
   try {await api(`/api/marketing/assets/${asset.id}`,undefined,'DELETE');toast(t('common.savedSuccessfully'));await renderAssets();}
   catch(error) {toastError(error);}
  };
  actionsHost.append(deleteButton);
 }
}
async function onUploadAsset() {
 let fileData=null;
 const input=await promptDrawer(t('marketing.assetsNewUpload'),node=>{
  node.innerHTML=`
   <label>${escape(t('marketing.assetsType'))}<select name="type">
     <option value="image">${escape(t('marketing.assetType.image'))}</option>
     <option value="video">${escape(t('marketing.assetType.video'))}</option>
     <option value="document">${escape(t('marketing.assetType.document'))}</option>
    </select></label>
   <label>${escape(t('marketing.assetsNewUpload'))}<input name="file" type="file" accept=".pdf,.csv,.xlsx,.docx,.txt,.png,.jpg,.jpeg" required></label>`;
  const fileInput=node.querySelector('[name=file]');
  // Read eagerly on selection rather than on Save — promptDrawer's value() must return
  // synchronously (see components/ui/index.js), so the base64 has to already be ready by the
  // time the user clicks Save.
  fileInput.onchange=()=>{
   const file=fileInput.files[0];
   if(!file)return;
   const reader=new FileReader();
   reader.onload=()=>{fileData={filename:file.name,mimeType:file.type,contentBase64:String(reader.result).split(',')[1]};};
   reader.readAsDataURL(file);
  };
  return {
   value:()=>({type:node.querySelector('[name=type]').value}),
   validate:()=>{if(!fileInput.files[0]){fileInput.setCustomValidity(t('common.reasonRequired'));fileInput.reportValidity();return false;}fileInput.setCustomValidity('');return true;},
   focus:()=>fileInput.focus()
  };
 },{confirmLabel:t('common.save')});
 if(!input)return;
 for(let waited=0;!fileData&&waited<2000;waited+=50)await new Promise(r=>setTimeout(r,50));
 if(!fileData){toastError(new Error(t('common.reasonRequired')));return;}
 try {
  const uploaded=await api('/api/command/attachments',fileData);
  await api('/api/marketing/assets',{type:input.type,source:'upload',fileRef:uploaded.id});
  toast(t('common.savedSuccessfully'));
  await renderAssets();
 } catch(error) {toastError(error);}
}
async function onAddExternalAsset() {
 const input=await promptDrawer(t('marketing.assetsNewExternal'),node=>{
  node.innerHTML=`
   <label>${escape(t('marketing.assetsType'))}<select name="type">
     ${['image','video','document','creative_reference'].map(type=>`<option value="${type}">${escape(t('marketing.assetType.'+type))}</option>`).join('')}
    </select></label>
   <label>${escape(t('marketing.assetsNewExternal'))}<input name="ref" required placeholder="https://..."></label>`;
  const refInput=node.querySelector('[name=ref]');
  return {
   value:()=>({type:node.querySelector('[name=type]').value,fileRef:refInput.value.trim()}),
   validate:()=>{if(!refInput.value.trim()){refInput.setCustomValidity(t('common.reasonRequired'));refInput.reportValidity();return false;}refInput.setCustomValidity('');return true;},
   focus:()=>refInput.focus()
  };
 },{confirmLabel:t('common.save')});
 if(!input)return;
 try {
  await api('/api/marketing/assets',{type:input.type,source:input.type==='creative_reference'?'creative_reference':'external_url',fileRef:input.fileRef});
  toast(t('common.savedSuccessfully'));
  await renderAssets();
 } catch(error) {toastError(error);}
}

// -----------------------------------------------------------------------------------------
// Performance (Phase MKT-2, Part G/H) — real recommendations from the existing performance
// agent over real synced analytics; acting on one only ever creates a new DRAFT content item
// through the exact same real compliance/approval pipeline every other content item uses.
// -----------------------------------------------------------------------------------------
async function renderPerformance() {
 const host=$('#mkt-performance');
 let reviews;
 try {reviews=await api('/api/marketing/performance/reviews');} catch(error) {toastError(error);return;}
 host.innerHTML=`<div class="report-actions"><button type="button" id="mkt-run-performance-review" class="button primary">${escape(t('marketing.performanceRunReview'))}</button></div><div id="mkt-performance-list"></div>`;
 $('#mkt-run-performance-review').onclick=async()=>{
  try {await api('/api/marketing/performance/review',{});toast(t('common.savedSuccessfully'));await renderPerformance();}
  catch(error) {toastError(error);}
 };
 const list=host.querySelector('#mkt-performance-list');
 if(!reviews.length){list.innerHTML=empty(t('marketing.performanceNoReviewsYet'));return;}
 list.innerHTML=reviews.map(r=>`<article class="card" data-review-id="${escape(r.id)}">
   <div class="row-between"><strong>${escape(fmtDateTime(r.createdAt))}</strong>${badge(r.status,r.status==='ACKNOWLEDGED'?'CONNECTED':r.status==='DISMISSED'?'DEFAULT':'PENDING')}</div>
   <p class="cmdc-muted">${escape(r.result.data_quality||'')}</p>
   <h4>${escape(t('marketing.performanceRecommendationsTitle'))}</h4>
   <ul>${(r.result.experiments_next_week||[]).map(exp=>`<li>${escape(exp.hypothesis)} → ${escape(exp.change)}</li>`).join('')||`<li>${escape(t('marketing.performanceNoReviewsYet'))}</li>`}</ul>
   <div class="row" data-review-actions></div>
  </article>`).join('');
 for(const review of reviews) {
  const actionsHost=list.querySelector(`[data-review-id="${CSS.escape(review.id)}"] [data-review-actions]`);
  if(review.status==='NEW') {
   const ackButton=button(t('marketing.performanceAcknowledge'),{variant:'secondary'});
   ackButton.onclick=async()=>{try {await api(`/api/marketing/performance/reviews/${review.id}/status`,{status:'ACKNOWLEDGED'});toast(t('common.savedSuccessfully'));await renderPerformance();} catch(error) {toastError(error);}};
   const dismissButton=button(t('marketing.performanceDismiss'),{variant:'ghost'});
   dismissButton.onclick=async()=>{try {await api(`/api/marketing/performance/reviews/${review.id}/status`,{status:'DISMISSED'});toast(t('common.savedSuccessfully'));await renderPerformance();} catch(error) {toastError(error);}};
   actionsHost.append(ackButton,dismissButton);
  }
  const createContentButton=button(t('marketing.performanceCreateContent'),{variant:'primary'});
  createContentButton.onclick=()=>onCreateContentFromReview(review);
  actionsHost.append(createContentButton);
 }
}
async function onCreateContentFromReview(review) {
 const input=await promptDrawer(t('marketing.performanceCreateContent'),node=>contentFormFields(node,review.campaignId),{confirmLabel:t('common.save')});
 if(!input)return;
 try {
  await api(`/api/marketing/performance/reviews/${review.id}/create-content`,input);
  toast(t('common.savedSuccessfully'));
  await refreshContentList();
 } catch(error) {toastError(error);}
}
