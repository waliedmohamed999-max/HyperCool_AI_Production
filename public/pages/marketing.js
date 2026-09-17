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
 const panels=['overview','campaigns','content','calendar','inbox','widget'].map(key=>{const el=document.createElement('div');el.id='mkt-panel-'+key;return el;});
 $('#mkt-tabs').append(...panels);
 tabs($('#mkt-tabs'),[
  [t('marketing.tabOverview'),panels[0]],
  [t('marketing.tabCampaigns'),panels[1]],
  [t('marketing.tabContent'),panels[2]],
  [t('marketing.tabCalendar'),panels[3]],
  [t('marketing.tabInbox'),panels[4]],
  [t('marketing.tabWidget'),panels[5]]
 ]);
 panels[1].innerHTML=`<div class="report-actions"><button type="button" id="mkt-new-campaign" class="button primary">${escape(t('marketing.newCampaign'))}</button></div><div id="mkt-campaigns-list"></div>`;
 panels[2].innerHTML=`<div class="report-actions"><button type="button" id="mkt-new-content" class="button primary">${escape(t('marketing.newContent'))}</button></div><div id="mkt-content-list"></div>`;
 panels[3].innerHTML=`<div id="mkt-calendar-list"></div>`;
 panels[4].innerHTML=`<div class="mkt-inbox-layout"><div id="mkt-inbox-list" class="mkt-inbox-conversations"></div><div id="mkt-inbox-thread" class="mkt-inbox-thread"></div></div>`;
 panels[5].innerHTML=`<div id="mkt-widget-config"></div>`;
 $('#mkt-new-campaign').onclick=onNewCampaign;
 $('#mkt-new-content').onclick=()=>onNewContent();
 // The Inbox is the one tab where staleness is actually misleading (a new conversation, e.g.
 // from the public website widget, can arrive at any moment) — refresh it on open rather than
 // only on a full page navigation, the same way Command Center's Live Operations panel stays
 // current without a full re-render.
 $('#mkt-tabs .ui-tabs').children[4]?.addEventListener('click',()=>{renderInbox().catch(toastError);});
}

export async function renderMarketingPage({api:client,auth}) {
 apiClient=client;currentAuth=auth;
 const generation=++renderGeneration;
 let overview,campaigns,content,meta;
 try {
  [overview,campaigns,content,meta]=await Promise.all([
   api('/api/marketing/overview'),api('/api/marketing/campaigns'),api('/api/marketing/content'),api('/api/marketing/meta')
  ]);
 } catch(error) {toastError(error);return;}
 if(staleGuard(generation))return;
 campaignsCache=campaigns;contentCache=content;metaCache=meta;
 renderHealth(overview);
 renderOverviewTab(overview);
 renderCampaignsList();
 renderContentList();
 renderCalendar();
 await renderInbox();
 await renderWidgetConfig();
}

function renderHealth(overview) {
 const m=overview.marketing;
 $('#mkt-health').innerHTML=[
  metric(t('marketing.kpiLeads'),overview.kpis.leadsCreated.value,t('marketing.kpiThisWeek'),'users'),
  metric(t('marketing.kpiConversion'),overview.kpis.conversionRate.value+'%',t('marketing.kpiThisWeek'),'chart'),
  metric(t('marketing.kpiActiveCampaigns'),m.campaigns.active,t('marketing.kpiRightNow'),'calendar'),
  metric(t('marketing.kpiScheduledContent'),m.content.scheduled,t('marketing.kpiRightNow'),'file'),
  metric(t('marketing.kpiPendingApproval'),m.content.pendingApproval,t('marketing.kpiRightNow'),'file'),
  metric(t('marketing.kpiInboxVolume'),m.inboxVolume,t('marketing.kpiAllTime'),'agent')
 ].join('');
}

function renderOverviewTab(overview) {
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
    <p class="cmdc-muted">${escape(t('marketing.reachEngagementUnavailable'))}</p>
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
function campaignFormFields(node,campaign) {
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
   ${metaCache.contentChannels.map(c=>`<label class="check"><input type="checkbox" name="channel" value="${c}" ${(d.channels||[]).includes(c)?'checked':''}> ${escape(c)}</label>`).join('')}
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
  intelligencePanel=document.createElement('div'),contentPanel=document.createElement('div');
 node.append(overviewPanel,strategyPanel,intelligencePanel,contentPanel);
 tabs(node,[
  [t('marketing.tabDetailOverview'),overviewPanel],[t('marketing.tabDetailStrategy'),strategyPanel],
  [t('marketing.tabDetailIntelligence'),intelligencePanel],[t('marketing.tabDetailContent'),contentPanel]
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
 paintOverview();paintStrategy();paintIntelligence();await paintContent();
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
function renderContentList() {
 const host=$('#mkt-content-list');
 if(!contentCache.length){host.innerHTML=empty(t('marketing.noContentYet'),t('marketing.noContentHint'));return;}
 host.innerHTML=contentCache.map(item=>`<article class="card" data-content-id="${escape(item.id)}">
   <div class="row-between"><strong>${escape(item.channel)} · ${escape(t('marketing.format.'+item.format))}</strong>${badge(t('marketing.contentStatus.'+item.status),item.status==='PUBLISHED'?'CONNECTED':item.status==='APPROVED'||item.status==='SCHEDULED'?'PENDING':item.status==='FAILED'?'ERROR':'DEFAULT')}</div>
   <p>${escape(item.body.slice(0,180))}${item.body.length>180?'…':''}</p>
   ${item.hashtags?.length?`<p class="cmdc-muted">${item.hashtags.map(h=>'#'+escape(h)).join(' ')}</p>`:''}
   <div class="row" data-content-actions></div>
  </article>`).join('');
 for(const item of contentCache) {
  const actionsHost=host.querySelector(`[data-content-id="${CSS.escape(item.id)}"] [data-content-actions]`);
  const next=CONTENT_NEXT_STATUS[item.status];
  if(next) {
   const advance=button(t('marketing.advanceTo.'+next),{variant:'primary'});
   advance.onclick=async()=>{
    const patch={status:next};
    // Moving to SCHEDULED without a real time would silently disappear from the Calendar
    // tab (it filters on scheduledAt/publishedAt) — ask for one instead of leaving it null.
    if(next==='SCHEDULED') {
     const when=await promptDrawer(t('marketing.advanceTo.SCHEDULED'),node=>{
      node.innerHTML=`<label>${escape(t('marketing.colWhen'))}<input name="scheduledAt" type="datetime-local" required></label>`;
      const input=node.querySelector('[name=scheduledAt]');
      return {value:()=>input.value?new Date(input.value).toISOString():null,validate:()=>{if(!input.value){input.setCustomValidity(t('common.reasonRequired'));input.reportValidity();return false;}input.setCustomValidity('');return true;},focus:()=>input.focus()};
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
}

// -----------------------------------------------------------------------------------------
// Calendar (List view — see docs/UI_DESIGN_SYSTEM.md marketing section for the honest scope
// note on Month/Week views).
// -----------------------------------------------------------------------------------------
function renderCalendar() {
 const host=$('#mkt-calendar-list');
 const items=contentCache.filter(i=>i.scheduledAt||i.publishedAt).sort((a,b)=>(a.scheduledAt||a.publishedAt).localeCompare(b.scheduledAt||b.publishedAt));
 if(!items.length){host.innerHTML=empty(t('marketing.noScheduledContent'));return;}
 host.innerHTML=table(
  [t('marketing.colWhen'),t('marketing.fieldChannel'),t('marketing.fieldFormat'),t('controlCenter.statusLabel')],
  items.map(i=>[escape(fmtDateTime(i.scheduledAt||i.publishedAt)),escape(i.channel),escape(t('marketing.format.'+i.format)),badge(t('marketing.contentStatus.'+i.status),i.status==='PUBLISHED'?'CONNECTED':'PENDING')])
 );
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
