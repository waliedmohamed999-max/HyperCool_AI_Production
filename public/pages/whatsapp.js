// WhatsApp Hub — connection status, templates, WhatsApp-filtered campaigns (with a bounded
// campaign-blast action), and WhatsApp-filtered follow-ups. Reuses existing engines entirely:
// the Meta OAuth flow (runtime/meta-oauth.js), template sync (runtime/whatsapp.js), the
// Marketing campaign system (src/marketing.js, via marketing.js's own exported
// campaignFormFields so the form is never duplicated), and CRM follow-ups
// (src/crm.js/runtime/scheduler.js). The only genuinely new capability behind this page is the
// bounded (max 50) campaign-blast send, POST /api/marketing/campaigns/:id/whatsapp-blast,
// which is the exact same function the whatsapp_campaign_send agent tool calls — so Frost and
// a human operator can never diverge on eligibility rules.
import {escape,badge,empty,metric,drawer,promptDrawer,confirmAction,table,tabs,icon,toast} from '../components/ui/index.js';
import {campaignFormFields} from './marketing.js';
import {t} from '../i18n.js';
import {fmtDateTime} from '../format.js';

const $=s=>document.querySelector('#whatsapp '+s);
let apiClient,currentAuth,renderGeneration=0;
async function api(path,body,method){return apiClient(path,body,method);}
function staleGuard(generation){return generation!==renderGeneration;}
function toastError(error){toast(error.message||String(error),'error');}

let leadsCache=[],campaignsCache=[],followupsCache=[];

export function installWhatsAppPage() {
 const root=document.querySelector('[data-page="whatsapp"] #whatsapp');
 root.innerHTML=`
  <div class="wa-hero"><div class="wa-hero-copy"><span class="wa-eyebrow">WHATSAPP BUSINESS</span><h2>${escape(t('whatsapp.heroTitle'))}</h2><p>${escape(t('whatsapp.heroHint'))}</p><div class="wa-hero-tags"><span>${icon('file')}${escape(t('whatsapp.tabTemplates'))}</span><span>${icon('chart')}${escape(t('whatsapp.tabCampaigns'))}</span><span>${icon('clock')}${escape(t('whatsapp.tabFollowups'))}</span></div></div><div class="wa-guide"><span class="wa-guide-title">${escape(t('whatsapp.guideTitle'))}</span>${['connectStep','templateStep','campaignStep'].map((key,i)=>`<div class="wa-guide-step"><span>${i+1}</span><strong>${escape(t('whatsapp.'+key))}</strong></div>`).join('')}</div></div>
  <div id="wa-summary" class="wa-summary"></div>
  <div id="wa-connection" class="panel wa-connection"></div>
  <div id="wa-library" class="wa-library">
  <div id="wa-tab-templates"></div>
  <div id="wa-tab-campaigns"></div>
  <div id="wa-tab-followups"></div></div>`;
 const panels=[$('#wa-tab-templates'),$('#wa-tab-campaigns'),$('#wa-tab-followups')];
 tabs($('#wa-library'),[
  [t('whatsapp.tabTemplates'),panels[0]],
  [t('whatsapp.tabCampaigns'),panels[1]],
  [t('whatsapp.tabFollowups'),panels[2]]
 ]);
 panels[0].innerHTML=`<div class="report-section-head"><h3>${escape(t('whatsapp.tabTemplates'))}</h3><button type="button" id="wa-sync-templates" class="secondary">${escape(t('whatsapp.syncTemplates'))}</button></div><div id="wa-templates-list"></div>`;
 panels[1].innerHTML=`<div class="report-section-head"><h3>${escape(t('whatsapp.tabCampaigns'))}</h3><button type="button" id="wa-new-campaign" class="secondary">${escape(t('whatsapp.newCampaign'))}</button></div><div id="wa-campaigns-list"></div>`;
 panels[2].innerHTML=`<div class="report-section-head"><h3>${escape(t('whatsapp.tabFollowups'))}</h3><button type="button" id="wa-run-sweep" class="secondary">${escape(t('whatsapp.runSweep'))}</button></div><div id="wa-followups-list"></div>`;
 $('#wa-sync-templates').onclick=onSyncTemplates;
 $('#wa-new-campaign').onclick=onNewCampaign;
 $('#wa-run-sweep').onclick=onRunSweep;
 for(const [id,name] of [['wa-sync-templates','plug'],['wa-new-campaign','plus'],['wa-run-sweep','clock']])$('#'+id).insertAdjacentHTML('afterbegin',icon(name));
 renderSummary();
}

let templateCount=null,summaryLoaded=false;
function renderSummary(){
 const values=[templateCount,summaryLoaded?campaignsCache.filter(c=>(c.channels||[]).includes('WhatsApp')).length:null,summaryLoaded?followupsCache.filter(f=>f.channel==='WhatsApp').length:null];
 $('#wa-summary').innerHTML=['tabTemplates','tabCampaigns','tabFollowups'].map((key,i)=>metric(t('whatsapp.'+key),values[i]??'—',t('whatsapp.'+['templatesMetric','campaignsMetric','followupsMetric'][i]),['file','chart','clock'][i])).join('');
}

// ------------------------------------------------------------------------------------------
// Connection tab
// ------------------------------------------------------------------------------------------
async function renderConnection() {
 let status;
 try {status=await api('/api/integrations/meta/oauth/status');}
 catch(error) {$('#wa-connection').innerHTML=empty(t('whatsapp.connectionUnavailable'));return;}
 const wa=status.connected?status.whatsapp:null;
 const host=$('#wa-connection');
 if(!status.connected||!wa) {
  host.innerHTML=`
   <div class="row-between"><div class="wa-connection-heading"><span class="wa-connection-icon">${icon('plug')}</span><div><span class="wa-overline">META BUSINESS</span><h3>${escape(t('whatsapp.connectionTitle'))}</h3></div></div>${badge(t('whatsapp.notConnected'),'PENDING')}</div>
   <p>${escape(t('whatsapp.connectHint'))}</p>
   <a class="button primary" href="/api/integrations/meta/oauth/start">${icon('plus')}${escape(t('whatsapp.connectButton'))}</a>`;
  return;
 }
 host.innerHTML=`
  <div class="row-between"><h3>${escape(t('whatsapp.connectionTitle'))}</h3>${badge(t('whatsapp.connected'),status.tokenExpired?'ERROR':'CONNECTED')}</div>
  <div class="kpi-grid">
   ${metric(t('whatsapp.phoneNumber'),wa.displayPhoneNumber||wa.phoneNumberId||'—','','plug')}
   ${metric(t('whatsapp.verifiedName'),wa.verifiedName||'—','','users')}
  </div>
  ${status.tokenExpired?`<p class="notice">${escape(t('whatsapp.tokenExpired'))}</p>`:''}
  <div class="row">
   <button type="button" id="wa-test-connection" class="secondary">${escape(t('whatsapp.testConnection'))}</button>
   <button type="button" id="wa-disconnect" class="secondary">${escape(t('whatsapp.disconnect'))}</button>
  </div>`;
 $('#wa-test-connection').onclick=onTestConnection;
 $('#wa-disconnect').onclick=onDisconnect;
}
async function onTestConnection() {
 try {const result=await api('/api/integrations/whatsapp/test',{});toast(result.result==='OK'?t('whatsapp.testOk'):t('whatsapp.testFailed'),result.result==='OK'?'success':'error');}
 catch(error) {toastError(error);}
}
async function onDisconnect() {
 if(!await confirmAction(t('whatsapp.disconnect'),t('whatsapp.disconnectConfirm')))return;
 try {await api('/api/integrations/meta/disconnect',{});toast(t('common.savedSuccessfully'));await renderConnection();}
 catch(error) {toastError(error);}
}

// ------------------------------------------------------------------------------------------
// Templates tab
// ------------------------------------------------------------------------------------------
async function renderTemplates() {
 const host=$('#wa-templates-list');
 let templates;
 try {templates=await api('/api/whatsapp/templates');} catch(error) {templateCount=null;renderSummary();host.innerHTML=empty(t('whatsapp.templatesUnavailable'));return;}
 templateCount=templates.length;renderSummary();
 host.innerHTML=templates.length
  ?table([t('whatsapp.templateName'),t('whatsapp.templateLanguage'),t('whatsapp.templateCategory'),t('whatsapp.templateStatus')],
     templates.map(tpl=>[escape(tpl.name),escape(tpl.language),escape(tpl.category||'—'),badge(tpl.status,tpl.status==='APPROVED'?'CONNECTED':tpl.status==='REJECTED'?'ERROR':'PENDING')]))
  :empty(t('whatsapp.noTemplates'),t('whatsapp.noTemplatesHint'));
}
async function onSyncTemplates() {
 try {const result=await api('/api/whatsapp/templates/sync',{});toast(t('whatsapp.syncedCount').replace('{count}',result.synced));await renderTemplates();}
 catch(error) {toastError(error);}
}

// ------------------------------------------------------------------------------------------
// Campaigns tab (WhatsApp-filtered; reuses src/marketing.js's campaign system entirely)
// ------------------------------------------------------------------------------------------
function renderCampaignsList() {
 renderSummary();
 const host=$('#wa-campaigns-list');
 const whatsappCampaigns=campaignsCache.filter(c=>(c.channels||[]).includes('WhatsApp'));
 host.innerHTML=whatsappCampaigns.length
  ?table([t('marketing.fieldName'),t('marketing.fieldGoal'),t('whatsapp.campaignStatus'),''],
     whatsappCampaigns.map(c=>[escape(c.name),escape(c.goal||'—'),badge(t('marketing.status.'+c.status)),`<button type="button" class="small" data-blast="${escape(c.id)}">${escape(t('whatsapp.sendBlast'))}</button>`]))
  :empty(t('whatsapp.noCampaigns'),t('whatsapp.noCampaignsHint'));
 host.querySelectorAll('[data-blast]').forEach(buttonEl=>{buttonEl.onclick=()=>onSendBlast(buttonEl.dataset.blast);});
}
async function onNewCampaign() {
 const input=await promptDrawer(t('whatsapp.newCampaign'),node=>campaignFormFields(node,{channels:['WhatsApp']},['WhatsApp']),{confirmLabel:t('common.save')});
 if(!input)return;
 try {await api('/api/marketing/campaigns',input);toast(t('common.savedSuccessfully'));campaignsCache=await api('/api/marketing/campaigns');renderCampaignsList();}
 catch(error) {toastError(error);}
}
function eligibleWhatsAppLeads() {
 return leadsCache.filter(lead=>lead.phone&&lead.consent?.WhatsApp&&!lead.optOut);
}
async function onSendBlast(campaignId) {
 const eligible=eligibleWhatsAppLeads();
 const outcome=await promptDrawer(t('whatsapp.sendBlast'),node=>{
  node.innerHTML=`
   <p class="notice">${escape(t('whatsapp.blastCapHint').replace('{cap}',50))}</p>
   <label>${escape(t('whatsapp.blastText'))}<textarea name="text" maxlength="1000"></textarea></label>
   <label>${escape(t('whatsapp.blastTemplateName'))}<input name="templateName" maxlength="200"></label>
   <fieldset class="wa-blast-leads"><legend>${escape(t('whatsapp.blastRecipients'))} (${eligible.length})</legend>
    ${eligible.length?eligible.map(lead=>`<label class="check"><input type="checkbox" name="leadId" value="${escape(lead.id)}"> ${escape(lead.name)}</label>`).join(''):empty(t('whatsapp.noEligibleLeads'))}
   </fieldset>`;
  const textArea=node.querySelector('[name=text]'),templateInput=node.querySelector('[name=templateName]');
  const collect=()=>({leadIds:[...node.querySelectorAll('[name=leadId]:checked')].map(el=>el.value),text:textArea.value.trim()||undefined,templateName:templateInput.value.trim()||undefined});
  return {
   value:collect,
   validate:()=>{
    const {leadIds}=collect();
    if(!leadIds.length){toast(t('whatsapp.noRecipientsSelected'),'error');return false;}
    return true;
   },
   focus:()=>textArea.focus()
  };
 },{confirmLabel:t('whatsapp.send')});
 if(!outcome)return;
 try {
  const preview=await api(`/api/marketing/campaigns/${campaignId}/whatsapp-blast`,{...outcome,dryRun:true});
  if(preview.status==='BLOCKED') {toast(t('whatsapp.blastBlocked')+' ('+preview.reason+')','error');return;}
  const proceed=await confirmAction(t('whatsapp.sendBlast'),t('whatsapp.blastPreviewSummary').replace('{eligible}',preview.eligible.length).replace('{blocked}',preview.blocked.length));
  if(!proceed)return;
  const result=await api(`/api/marketing/campaigns/${campaignId}/whatsapp-blast`,{...outcome,dryRun:false});
  toast(t('whatsapp.blastResultSummary').replace('{sent}',result.sent).replace('{failed}',result.failed).replace('{skipped}',result.skipped));
 } catch(error) {toastError(error);}
}

// ------------------------------------------------------------------------------------------
// Follow-ups tab (WhatsApp-filtered; reuses CRM follow-ups entirely — no new entity)
// ------------------------------------------------------------------------------------------
function renderFollowupsList() {
 renderSummary();
 const host=$('#wa-followups-list');
 const whatsappFollowups=followupsCache.filter(f=>f.channel==='WhatsApp');
 const leadName=id=>leadsCache.find(l=>l.id===id)?.name||id;
 host.innerHTML=whatsappFollowups.length
  ?table([t('whatsapp.followupLead'),t('whatsapp.followupSequence'),t('whatsapp.followupDue'),t('whatsapp.followupStatus')],
     whatsappFollowups.map(f=>[escape(leadName(f.leadId)),escape(f.sequence)+` (${f.touch}/${f.maxTouches})`,escape(fmtDateTime(f.dueAt)),badge(f.status,f.status==='HOLD'?'ERROR':f.status==='READY_FOR_CHANNEL'?'CONNECTED':'PENDING')]))
  :empty(t('whatsapp.noFollowups'),t('whatsapp.noFollowupsHint'));
}
async function onRunSweep() {
 try {const result=await api('/api/crm/followups/prepare',{});toast(t('whatsapp.sweepResultSummary').replace('{ready}',result.ready).replace('{held}',result.held));const crm=await api('/api/crm');leadsCache=crm.leads;followupsCache=crm.followups;renderFollowupsList();}
 catch(error) {toastError(error);}
}

// ------------------------------------------------------------------------------------------
export async function renderWhatsAppPage({api:client,auth}) {
 apiClient=client;currentAuth=auth;
 const generation=++renderGeneration;
 summaryLoaded=false;templateCount=null;renderSummary();
 const runSweepButton=$('#wa-run-sweep');
 if(runSweepButton)runSweepButton.hidden=!(auth.user&&auth.user.role==='owner');
 try {
  const [crm,campaigns]=await Promise.all([api('/api/crm'),api('/api/marketing/campaigns')]);
  if(staleGuard(generation))return;
  leadsCache=crm.leads;followupsCache=crm.followups;campaignsCache=campaigns;
  summaryLoaded=true;renderSummary();
  await renderConnection();
  if(staleGuard(generation))return;
  await renderTemplates();
  renderCampaignsList();
  renderFollowupsList();
 } catch(error) {toastError(error);}
}
