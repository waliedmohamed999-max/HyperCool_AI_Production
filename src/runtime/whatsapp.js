import {randomUUID} from 'node:crypto';
import {ConnectorError} from '../connectors.js';
import {resolveMetaAccessToken,connectedWhatsAppPhoneNumberId} from './meta-oauth.js';
import {resolveActiveTenantId} from '../tenancy.js';

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
export function whatsappConfigured({store,env}) {
 const resolved=resolveMetaAccessToken({store,env},'whatsapp');
 const phoneNumberId=connectedWhatsAppPhoneNumberId(store.db,env);
 return !!(resolved&&phoneNumberId);
}
/**
 * Real WhatsApp Cloud API send — text or template. Never called directly by an agent: the
 * whatsapp_send TOOL (runtime/tools.js) is the only caller, and it only runs after the
 * permission engine + opt-out + approval checks in Part O of the integration spec already
 * passed. This function itself still enforces nothing beyond "is the integration usable" —
 * it is a thin, honest HTTP client, not a second policy layer.
 */
export async function sendWhatsAppMessage({store,env,fetcher=fetch},{to,text,templateName,templateLanguage,templateComponents}) {
 const resolved=resolveMetaAccessToken({store,env},'whatsapp');
 const phoneNumberId=connectedWhatsAppPhoneNumberId(store.db,env);
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
