import {randomUUID} from 'node:crypto';
import {ConnectorError} from '../connectors.js';
import {resolveMetaAccessToken,connectedWhatsAppPhoneNumberId} from './meta-oauth.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {getLead,listLeads,stages,recordChannelMessage} from '../crm.js';
import {recordAudit} from '../audit.js';

const GRAPH_VERSION='v21.0';
const GRAPH_BASE='https://graph.facebook.com/'+GRAPH_VERSION;

// Multi-Tenant Phase 3 (deferred table, now closed): the old UNIQUE(name,language) table
// constraint would have let a second tenant's own approved WhatsApp template collide with
// (and silently overwrite, via the ON CONFLICT upsert below) the first tenant's template of
// the same name/language — table recreation needed since SQLite can't ALTER a table-level
// UNIQUE constraint in place, same as calendar_slots in planning.js.
export function installWhatsAppTemplates(db) {
 const legacy=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='whatsapp_templates'").get();
 if(legacy) {
  const columns=db.prepare('PRAGMA table_info(whatsapp_templates)').all().map(c=>c.name);
  if(!columns.includes('tenant_id')) {
   const tenantId=resolveActiveTenantId(db);
   db.exec('ALTER TABLE whatsapp_templates RENAME TO whatsapp_templates_pre_tenant;');
   db.exec(`CREATE TABLE whatsapp_templates (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, template_external_id TEXT, name TEXT NOT NULL, language TEXT NOT NULL,
    category TEXT, status TEXT NOT NULL, components TEXT NOT NULL, last_synced_at TEXT NOT NULL,
    UNIQUE(tenant_id,name,language)
   );`);
   db.prepare('INSERT INTO whatsapp_templates (id,tenant_id,template_external_id,name,language,category,status,components,last_synced_at) SELECT id,?,template_external_id,name,language,category,status,components,last_synced_at FROM whatsapp_templates_pre_tenant').run(tenantId);
   db.exec('DROP TABLE whatsapp_templates_pre_tenant;');
  }
  return;
 }
 db.exec(`CREATE TABLE whatsapp_templates (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, template_external_id TEXT, name TEXT NOT NULL, language TEXT NOT NULL,
  category TEXT, status TEXT NOT NULL, components TEXT NOT NULL, last_synced_at TEXT NOT NULL,
  UNIQUE(tenant_id,name,language)
 );`);
}
export function listWhatsAppTemplates(db,{status}={},tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const rows=status?db.prepare('SELECT * FROM whatsapp_templates WHERE tenant_id=? AND status=? ORDER BY name').all(resolvedTenantId,status)
  :db.prepare('SELECT * FROM whatsapp_templates WHERE tenant_id=? ORDER BY name').all(resolvedTenantId);
 return rows.map(row=>({...row,components:JSON.parse(row.components)}));
}
async function requestJson(fetcher,url,options={}) {
 let response;
 try {response=await fetcher(url,{...options,signal:AbortSignal.timeout(20000)});}
 catch {throw new ConnectorError('NETWORK_OR_TIMEOUT');}
 let data;
 try {data=await response.json();} catch {throw new ConnectorError('INVALID_PROVIDER_RESPONSE');}
 return {ok:response.ok,status:response.status,data};
}
// Meta's own error sub-codes mapped to the fixed vocabulary the integration spec asks for
// (Part U) — never a random retry, always a classified, actionable failure.
function classifySendError(status,data) {
 const code=data?.error?.code,subcode=data?.error?.error_subcode,message=data?.error?.message||'';
 if(status===401||code===190)return 'AUTH';
 if(status===429||code===4||code===80007)return 'RATE_LIMIT';
 if(code===131030||code===131026||/recipient/i.test(message))return 'INVALID_RECIPIENT';
 if(code===131047||subcode===2494010)return 'TEMPLATE_REQUIRED'; // outside the 24h customer-service window, a template is required
 if(code===132001||code===132000||/template/i.test(message))return 'TEMPLATE_REJECTED';
 if(status>=500)return 'API_UNAVAILABLE';
 return 'OTHER';
}
export function whatsappConfigured({store,env},tenantId=null) {
 const resolved=resolveMetaAccessToken({store,env},'whatsapp',tenantId);
 const phoneNumberId=connectedWhatsAppPhoneNumberId(store.db,env,tenantId);
 return !!(resolved&&phoneNumberId);
}
/**
 * Real WhatsApp Cloud API send — text or template. Never called directly by an agent: the
 * whatsapp_send TOOL (runtime/tools.js) is the only caller, and it only runs after the
 * permission engine + opt-out + approval checks in Part O of the integration spec already
 * passed. This function itself still enforces nothing beyond "is the integration usable" —
 * it is a thin, honest HTTP client, not a second policy layer.
 */
export async function sendWhatsAppMessage({store,env,fetcher=fetch},{to,text,templateName,templateLanguage,templateComponents},tenantId=null) {
 const resolved=resolveMetaAccessToken({store,env},'whatsapp',tenantId);
 const phoneNumberId=connectedWhatsAppPhoneNumberId(store.db,env,tenantId);
 if(!resolved||!phoneNumberId)return {status:'INTEGRATION_REQUIRED',integration:'whatsapp'};
 const body=templateName
  ?{messaging_product:'whatsapp',to,type:'template',template:{name:templateName,language:{code:templateLanguage||'ar'},...(templateComponents?{components:templateComponents}:{})}}
  :{messaging_product:'whatsapp',to,type:'text',text:{body:text}};
 const {ok,status,data}=await requestJson(fetcher,`${GRAPH_BASE}/${phoneNumberId}/messages`,{
  method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${resolved.token}`},body:JSON.stringify(body)
 });
 if(!ok)return {status:'FAILED',errorClass:classifySendError(status,data),errorDetail:data?.error?.message||null};
 const externalMessageId=data.messages?.[0]?.id||null;
 if(!externalMessageId)return {status:'FAILED',errorClass:'OTHER',errorDetail:'No message id in provider response'};
 return {status:'SENT',externalMessageId};
}
export async function testWhatsAppConnection({store,env,fetcher=fetch}) {
 const resolved=resolveMetaAccessToken({store,env},'whatsapp');
 const phoneNumberId=connectedWhatsAppPhoneNumberId(store.db,env);
 if(!resolved||!phoneNumberId)return {result:'NOT_CONFIGURED',code:'WHATSAPP_NOT_CONFIGURED'};
 const {ok,status,data}=await requestJson(fetcher,`${GRAPH_BASE}/${phoneNumberId}?fields=display_phone_number,verified_name`,{headers:{authorization:`Bearer ${resolved.token}`}});
 if(!ok)return {result:classifySendError(status,data)==='AUTH'?'AUTH_FAILED':'NETWORK_ERROR',code:data?.error?.message||'WHATSAPP_TEST_FAILED'};
 return {result:'OK',displayPhoneNumber:data.display_phone_number,verifiedName:data.verified_name};
}
/**
 * syncWhatsAppTemplates() — pulls the real approval status of every message template from
 * Meta (never invents an "Approved" status locally). Local statuses are Meta's own,
 * lowercased-mapped 1:1: APPROVED/PENDING/REJECTED/PAUSED/DISABLED.
 */
export async function syncWhatsAppTemplates({store,env,fetcher=fetch},tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(store.db);
 const resolved=resolveMetaAccessToken({store,env},'whatsapp');
 const meta=store.db.prepare('SELECT metadata FROM integration_credentials WHERE provider=?').get('meta');
 const businessAccountId=env.WHATSAPP_BUSINESS_ACCOUNT_ID||(meta?.metadata?JSON.parse(meta.metadata)?.whatsapp?.businessAccountId:null);
 if(!resolved||!businessAccountId)throw new ConnectorError('WHATSAPP_NOT_CONFIGURED');
 const {ok,status,data}=await requestJson(fetcher,`${GRAPH_BASE}/${businessAccountId}/message_templates?limit=100`,{headers:{authorization:`Bearer ${resolved.token}`}});
 if(!ok)throw new ConnectorError(classifySendError(status,data)==='AUTH'?'CREDENTIALS_REJECTED':'PROVIDER_ERROR');
 const now=new Date().toISOString();
 let synced=0;
 for(const tpl of data.data||[]) {
  store.db.prepare(`INSERT INTO whatsapp_templates (id,tenant_id,template_external_id,name,language,category,status,components,last_synced_at) VALUES (?,?,?,?,?,?,?,?,?)
   ON CONFLICT(tenant_id,name,language) DO UPDATE SET template_external_id=excluded.template_external_id,category=excluded.category,status=excluded.status,components=excluded.components,last_synced_at=excluded.last_synced_at`)
   .run(randomUUID(),resolvedTenantId,tpl.id||null,tpl.name,tpl.language,tpl.category||null,String(tpl.status||'UNKNOWN').toUpperCase(),JSON.stringify(tpl.components||[]),now);
  synced++;
 }
 return {synced,syncedAt:now};
}

// Campaign blast — the one deliberately bounded exception to "one recipient per call"
// (whatsapp_send/manualWhatsAppSend above). No queue/retry engine is introduced: this stays a
// plain, capped, synchronous loop reusing sendWhatsAppMessage() per recipient, shared by both
// the agent tool (runtime/tools.js) and the human REST route (application.js) so the two paths
// can never drift apart on eligibility rules.
export const CAMPAIGN_AUDIENCE_CAP=50;
function campaignEligibility(lead) {
 if(lead.optOut)return 'OPT_OUT';
 if(lead.humanHold)return 'HUMAN_HOLD';
 if(!lead.phone)return 'NO_PHONE';
 return null;
}
function withinCustomerServiceWindow(lead) {
 return !!lead.lastInboundAt && Date.now()-Date.parse(lead.lastInboundAt)<=86400000;
}
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
/**
 * Resolves a bounded recipient list from either an explicit leadIds array or a CRM stage
 * filter. Never truncates a too-large result — an oversized audience is reported as an error
 * so the caller can narrow it, rather than silently sending to only some of the intended
 * recipients.
 */
export function resolveCampaignAudience(db,tenantId,{leadIds,stageFilter}={}) {
 if(leadIds && stageFilter)return {error:'AUDIENCE_SELECTION_AMBIGUOUS'};
 if(leadIds) {
  if(!Array.isArray(leadIds)||leadIds.length===0)return {error:'AUDIENCE_SELECTION_REQUIRED'};
  if(leadIds.length>CAMPAIGN_AUDIENCE_CAP)return {error:'AUDIENCE_TOO_LARGE',resolvedCount:leadIds.length,cap:CAMPAIGN_AUDIENCE_CAP};
  return {leadIds};
 }
 if(stageFilter) {
  if(!stages.includes(stageFilter))return {error:'INVALID_STAGE'};
  const resolved=listLeads(db,tenantId).filter(lead=>lead.stage===stageFilter&&lead.phone&&lead.consent?.WhatsApp&&!lead.optOut).map(lead=>lead.id);
  if(resolved.length>CAMPAIGN_AUDIENCE_CAP)return {error:'AUDIENCE_TOO_LARGE',resolvedCount:resolved.length,cap:CAMPAIGN_AUDIENCE_CAP};
  if(resolved.length===0)return {error:'AUDIENCE_EMPTY'};
  return {leadIds:resolved};
 }
 return {error:'AUDIENCE_SELECTION_REQUIRED'};
}
/**
 * Send (or, with dryRun, preview) a WhatsApp campaign blast to a bounded audience. Mirrors
 * whatsapp_send's own per-recipient eligibility checks exactly (opt-out/hold/phone/24h-window)
 * so a lead that couldn't be messaged individually can't be messaged through a campaign either.
 * Every real send is recorded via recordChannelMessage + recordAudit, per recipient — never a
 * single aggregate "success" that hides individual failures.
 */
export async function sendWhatsAppCampaign({store,env,fetcher=fetch},{leadIds,stageFilter,text,templateName,templateLanguage,dryRun,campaignId}={},actor,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(store.db);
 const audience=resolveCampaignAudience(store.db,resolvedTenantId,{leadIds,stageFilter});
 if(audience.error)return {status:'BLOCKED',reason:audience.error,resolvedCount:audience.resolvedCount,cap:audience.cap};

 if(dryRun) {
  const eligible=[],blockedList=[];
  for(const leadId of audience.leadIds) {
   let lead;
   try {lead=getLead(store.db,leadId,resolvedTenantId);} catch {blockedList.push({leadId,reason:'LEAD_NOT_FOUND'});continue;}
   const reason=campaignEligibility(lead)||(!templateName&&!withinCustomerServiceWindow(lead)?'TEMPLATE_REQUIRED_OUTSIDE_WINDOW':null);
   if(reason)blockedList.push({leadId,reason});else eligible.push({leadId});
  }
  return {status:'PREVIEW',totalResolved:audience.leadIds.length,eligible,blocked:blockedList};
 }

 if(!whatsappConfigured({store,env},resolvedTenantId))return {status:'INTEGRATION_REQUIRED',integration:'whatsapp'};
 const results=[];
 for(let i=0;i<audience.leadIds.length;i++) {
  const leadId=audience.leadIds[i];
  let lead;
  try {lead=getLead(store.db,leadId,resolvedTenantId);} catch {results.push({leadId,status:'FAILED',reason:'LEAD_NOT_FOUND'});continue;}
  const skipReason=campaignEligibility(lead)||(!templateName&&!withinCustomerServiceWindow(lead)?'TEMPLATE_REQUIRED_OUTSIDE_WINDOW':null);
  if(skipReason) {results.push({leadId,status:'SKIPPED',reason:skipReason});continue;}
  const sendResult=await sendWhatsAppMessage({store,env,fetcher},{to:lead.phone,text,templateName,templateLanguage},resolvedTenantId);
  const now=new Date().toISOString();
  if(sendResult.status==='SENT') {
   recordChannelMessage(store,{leadId,channel:'WhatsApp',direction:'OUTBOUND',text:text||`[template:${templateName}]`,externalMessageId:sendResult.externalMessageId,messageType:templateName?'template':'text'},actor,resolvedTenantId);
   recordAudit(store.db,{id:randomUUID(),action:'WHATSAPP_CAMPAIGN_MESSAGE_SENT',itemId:leadId,actorId:actor.id,actorName:actor.name,actorRole:actor.role,campaignId:campaignId||null,at:now},resolvedTenantId);
   results.push({leadId,status:'SENT'});
  } else {
   recordAudit(store.db,{id:randomUUID(),action:'WHATSAPP_CAMPAIGN_MESSAGE_FAILED',itemId:leadId,actorId:actor.id,actorName:actor.name,actorRole:actor.role,campaignId:campaignId||null,errorClass:sendResult.errorClass||null,at:now},resolvedTenantId);
   results.push({leadId,status:'FAILED',reason:sendResult.errorClass||'OTHER'});
  }
  if(i<audience.leadIds.length-1)await sleep(300);
 }
 return {status:'OK',sent:results.filter(r=>r.status==='SENT').length,failed:results.filter(r=>r.status==='FAILED').length,skipped:results.filter(r=>r.status==='SKIPPED').length,results};
}
