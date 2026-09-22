// IntegrationOpsService — a thin, read-only aggregation layer for the Integration &
// Connection Center. Creates no new connection model: it only reshapes the two disjoint
// status sources that already exist (connectionStatus in connectors.js for Anthropic/Salla,
// integrationStatus in runtime/tools.js for the other six) plus real usage evidence already
// recorded in ai_runs, compliance_runs and audit_logs. Never invents a "connected" state —
// six of these eight services have zero real HTTP client code today, and this file says so.
import {AGENT_INTEGRATIONS} from './runtime/tools.js';
import {agents as AGENT_DEFS} from './domain.js';
import {listContent} from './content.js';
import {listAuditLog} from './audit.js';

// Real, documented facts about each integration: which env vars it needs, whether this
// codebase actually has a connector that calls it, and — for services with a real OAuth/API
// permission model — which scopes that connector would need once built. Scopes are shown as
// documentation of what will be required, never as a live "granted" check, since no OAuth
// flow or permission API exists anywhere in this app.
export const INTEGRATIONS=[
 {id:'anthropic',name:'Anthropic',category:'AI',description:'تشغيل الوكلاء وتوليد المحتوى بالذكاء الاصطناعي.',envVars:['ANTHROPIC_API_KEY','ANTHROPIC_MODEL'],authType:'API Key',connectorImplemented:true,scopes:[]},
 // Real second AgentRuntime provider (src/runtime/llmProvider.js) — used only by the 12-agent
 // runtime today, not by the separate content-draft/compliance-check flow in this file's
 // Anthropic-only connectors above, which is why its activity is read from agent_runs rather
 // than ai_runs/compliance_runs.
 {id:'openai',name:'OpenAI',category:'AI',description:'مزود ذكاء اصطناعي بديل لتشغيل فريق الوكلاء.',envVars:['OPENAI_API_KEY','OPENAI_DEFAULT_MODEL'],authType:'API Key',connectorImplemented:true,scopes:[]},
 {id:'salla',name:'Salla',category:'Commerce',description:'استيراد كتالوج المنتجات والأسعار والمخزون.',envVars:['SALLA_ACCESS_TOKEN'],webhookVar:'SALLA_WEBHOOK_SECRET',authType:'Bearer Token',connectorImplemented:true,scopes:[]},
 // Real Graph/Cloud API connector (src/runtime/whatsapp.js) — webhook receive, template
 // sync, and send are all implemented; activity is read from crm_messages (channel=WhatsApp)
 // and webhook_events (source=meta), not a separate log table.
 // Real Graph/Cloud API connector (src/runtime/whatsapp.js) — webhook receive, template
 // sync, and send are all implemented. "configured" is special-cased below (OAuth via the
 // Meta connection OR the legacy static WHATSAPP_ACCESS_TOKEN), since envVars alone (kept
 // here only for the visible env-var table) can't express "either/or with OAuth".
 {id:'whatsapp',name:'WhatsApp Business',category:'Messaging',description:'استقبال محادثات العملاء وتشغيل الردود والمتابعات.',envVars:['WHATSAPP_ACCESS_TOKEN'],webhookVar:'META_WEBHOOK_SECRET',authType:'Bearer Token / OAuth',connectorImplemented:true,scopes:[{name:'whatsapp_business_messaging',note:'إرسال واستقبال رسائل واتساب للأعمال'}]},
 // Real connector (src/runtime/meta-oauth.js, meta-publishing.js) for Page/Instagram
 // publishing; messaging webhooks are shared with WhatsApp above (same Meta App subscription).
 {id:'meta',name:'Meta',category:'Social',description:'نشر محتوى على Instagram وFacebook.',envVars:['META_ACCESS_TOKEN'],webhookVar:'META_WEBHOOK_SECRET',authType:'OAuth Token',connectorImplemented:true,scopes:[{name:'pages_read_engagement',note:'قراءة تفاعل صفحة فيسبوك'},{name:'instagram_basic',note:'الوصول الأساسي لحساب إنستغرام'},{name:'pages_manage_posts',note:'نشر منشورات على الصفحة'},{name:'whatsapp_business_messaging',note:'إرسال واستقبال رسائل واتساب للأعمال'}]},
 // Real connector (src/runtime/x-oauth.js, x-publishing.js) — publishing requires the OAuth
 // user-context token; X_BEARER_TOKEN (app-only) is read-only and cannot publish, so it is
 // not listed as a sufficient env var here (see integrationStatus in runtime/tools.js).
 {id:'x',name:'X',category:'Social',description:'نشر محتوى على منصة X.',envVars:['X_CLIENT_ID','X_CLIENT_SECRET','X_REDIRECT_URI'],authType:'OAuth 2.0 + PKCE',connectorImplemented:true,scopes:[{name:'tweet.write',note:'نشر تغريدات'},{name:'tweet.read',note:'قراءة التغريدات ومقاييسها'},{name:'users.read',note:'قراءة هوية الحساب المتصل'},{name:'offline_access',note:'الحصول على refresh token'}]},
 // Real connector (src/runtime/linkedin-oauth.js, linkedin-publishing.js) — publishing to a
 // personal profile is never implemented by design (spec Part G); only a resolved Company
 // Page/Organization can be published to.
 {id:'linkedin',name:'LinkedIn',category:'Social',description:'نشر محتوى الأعمال B2B على صفحة الشركة في لينكدإن.',envVars:['LINKEDIN_CLIENT_ID','LINKEDIN_CLIENT_SECRET','LINKEDIN_REDIRECT_URI'],authType:'OAuth 2.0',connectorImplemented:true,scopes:[{name:'w_organization_social',note:'النشر نيابة عن صفحة الشركة'},{name:'r_organization_social',note:'قراءة منشورات الصفحة ومقاييسها'},{name:'rw_organization_admin',note:'تحديد صفحات الشركة التي يديرها الحساب المتصل'},{name:'openid / profile / email',note:'هوية الحساب المتصل'}]},
 // Real connector (src/runtime/microsoft-oauth.js, microsoft-graph.js) — mail send/receive
 // and calendar are implemented; activity is read from crm_messages (channel=Email) and
 // webhook_events (source=microsoft365), not a separate log table.
 {id:'microsoft365',name:'Microsoft 365',category:'Productivity',description:'إرسال واستقبال البريد الإلكتروني وجدولة الاجتماعات.',envVars:['MICROSOFT_ACCESS_TOKEN'],webhookVar:'MICROSOFT_WEBHOOK_SECRET',authType:'OAuth Token',connectorImplemented:true,scopes:[{name:'Mail.Read',note:'قراءة البريد الوارد لالتقاط ردود العملاء'},{name:'Mail.Send',note:'إرسال بريد إلكتروني نيابة عن المستخدم'},{name:'User.Read',note:'قراءة الهوية المتصلة (الاسم والبريد)'},{name:'Calendars.ReadWrite',note:'إنشاء اجتماعات المبيعات والعروض التوضيحية (اختياري)'}]},
 // Real OAuth2+PKCE identity connector now exists (src/runtime/canva-oauth.js) — this legacy
 // env-var monitor still only tracks the server-level static vars, never the per-tenant OAuth
 // credential the real connector actually uses; real Canva activity/errors are visible in the
 // Control Center's Integrations tab (the modern ConnectorRuntime path), not here.
 {id:'canva',name:'Canva',category:'Productivity',description:'ربط حساب Canva للتحقق من الهوية — توليد التصاميم غير مبني بعد.',envVars:['CANVA_CLIENT_ID','CANVA_CLIENT_SECRET','CANVA_REDIRECT_URI'],authType:'OAuth 2.0 + PKCE',connectorImplemented:false,scopes:[{name:'profile:read',note:'التحقق من هوية الحساب المتصل'}]}
];
export const ERROR_ACTIONS={
 CREDENTIALS_REJECTED:'تحقق من صحة المفتاح أو الرمز في إعدادات الخادم',
 RATE_LIMITED:'انتظر قليلًا ثم أعد المحاولة، أو راجع حدود خطة الخدمة',
 NETWORK_OR_TIMEOUT:'تحقق من اتصال الخادم بالإنترنت وأعد المحاولة',
 PROVIDER_ERROR:'الخدمة الخارجية أعادت خطأ غير متوقع، أعد المحاولة لاحقًا',
 INVALID_PROVIDER_RESPONSE:'استجابة غير متوقعة من الخدمة، أعد المحاولة',
 ANTHROPIC_NOT_CONFIGURED:'أضف مفتاح Anthropic واسم الموديل في إعدادات الخادم',
 OPENAI_NOT_CONFIGURED:'أضف مفتاح OpenAI واسم الموديل في إعدادات الخادم',
 SALLA_NOT_CONFIGURED:'أضف رمز وصول سلة في إعدادات الخادم',
 INVALID_SALLA_RESPONSE:'استجابة سلة غير متوقعة، أعد المحاولة لاحقًا',
 INVALID_SALLA_PRODUCT:'بيانات منتج غير صالحة وردت من سلة',
 INVALID_SALLA_PRODUCT_URL:'رابط منتج غير صالح من سلة',
 STORE_DOMAIN_MISMATCH:'رابط منتج لا يطابق نطاق hyper-cool.com المعتمد',
 DUPLICATE_SALLA_PRODUCT:'معرف منتج مكرر ورد من سلة',
 INVALID_SALLA_PAGINATION:'بيانات ترقيم صفحات غير صالحة من سلة',
 SALLA_PAGE_LIMIT:'تجاوزت المزامنة الحد الأقصى لعدد الصفحات',
 INCOMPLETE_MODEL_OUTPUT:'توقف النموذج قبل اكتمال الرد، أعد المحاولة',
 INVALID_MODEL_OUTPUT:'مخرجات النموذج لا تطابق العقد المتوقع',
 CONTEXT_CHANGED:'تغيّرت البيانات المرتبطة أثناء التنفيذ',
 MODEL_LINK_MISMATCH:'رابط الناتج غير مطابق لرابط المنتج المطلوب',
 HUMAN_REVIEW_REQUIRED:'يتطلب مراجعة بشرية قبل المتابعة',
 UNKNOWN:'خطأ غير معروف، راجع سجل الخادم'
};
function agentsUsing(integrationId) {
 return Object.entries(AGENT_INTEGRATIONS).filter(([,keys])=>keys.includes(integrationId)).map(([agentId])=>{
  const def=AGENT_DEFS.find(a=>a.id===agentId);return {id:agentId,name:def?.name||agentId};
 });
}
// Anthropic has no dedicated "connect" event to log — activity is the ai_runs/compliance_runs
// history itself. Merges both real tables into one timeline, since both are genuine calls to
// the same provider and there is no separate per-provider table to keep them apart.
function durationMs(run) {
 return run.finishedAt&&run.createdAt?Date.parse(run.finishedAt)-Date.parse(run.createdAt):null;
}
function anthropicActivity(aiRuns,complianceRuns) {
 const events=[
  ...aiRuns.map(r=>({at:r.finishedAt||r.createdAt,status:r.status,errorCode:r.errorCode||null,kind:'توليد محتوى',durationMs:durationMs(r)})),
  ...complianceRuns.map(r=>({at:r.finishedAt||r.createdAt,status:r.status,errorCode:r.errorCode||null,kind:'فحص امتثال',durationMs:durationMs(r)}))
 ].filter(e=>e.at).sort((a,b)=>b.at.localeCompare(a.at));
 const lastSuccess=events.find(e=>e.status==='COMPLETED');
 const lastError=events.find(e=>['ERROR','FAILED'].includes(e.status));
 const hasNewerError=lastError&&(!lastSuccess||lastError.at>lastSuccess.at);
 return {events,lastSuccess,lastError,hasNewerError};
}
// OpenAI has no dedicated log table either — its only real call site today is the Agent
// Runtime (src/runtime/runtime.js), which already tags every run with the provider that
// actually executed it. Runs where used_fallback=1 count as OpenAI activity only if OpenAI
// is literally the provider that ran (i.e. Anthropic failed over TO OpenAI), never the other
// way around — this is a real usage record, not an assumption.
function openaiActivity(agentRuns) {
 const events=agentRuns.filter(r=>r.provider==='openai').map(r=>({at:r.finished_at||r.started_at,status:r.status,errorCode:r.status==='FAILED'?(r.error||'UNKNOWN'):null,kind:'تشغيل وكيل ('+r.agent_id+')',durationMs:r.latency_ms||null}))
  .filter(e=>e.at).sort((a,b)=>b.at.localeCompare(a.at));
 const lastSuccess=events.find(e=>['COMPLETED','ESCALATED','WAITING_APPROVAL'].includes(e.status));
 const lastError=events.find(e=>e.status==='FAILED');
 const hasNewerError=lastError&&(!lastSuccess||lastError.at>lastSuccess.at);
 return {events,lastSuccess,lastError,hasNewerError};
}
function sallaActivity(audit) {
 const events=audit.filter(a=>a.action==='SALLA_CATALOG_SYNCED'||a.action==='SALLA_CATALOG_SYNC_FAILED').sort((a,b)=>b.at.localeCompare(a.at));
 const lastSuccess=events.find(e=>e.action==='SALLA_CATALOG_SYNCED');
 const lastError=events.find(e=>e.action==='SALLA_CATALOG_SYNC_FAILED');
 const hasNewerError=lastError&&(!lastSuccess||lastError.at>lastSuccess.at);
 return {events,lastSuccess,lastError,hasNewerError};
}
// WhatsApp has no dedicated log table — real activity is the crm_messages history itself
// (channel='WhatsApp'), inbound and outbound alike, which is genuine evidence the
// integration is actually working end to end (not just configured).
function whatsappActivity(db) {
 let rows=[];
 try{rows=db.prepare("SELECT json FROM crm_messages ORDER BY rowid DESC LIMIT 500").all().map(r=>JSON.parse(r.json)).filter(m=>m.channel==='WhatsApp');}catch{rows=[];}
 const events=rows.map(m=>({at:m.recordedAt,status:m.status==='FAILED'?'FAILED':'COMPLETED',errorCode:m.errorCode||null,kind:m.direction==='OUTBOUND'?'رسالة صادرة':'رسالة واردة',durationMs:null}))
  .filter(e=>e.at).sort((a,b)=>b.at.localeCompare(a.at));
 const lastSuccess=events.find(e=>e.status==='COMPLETED');
 const lastError=events.find(e=>e.status==='FAILED');
 const hasNewerError=lastError&&(!lastSuccess||lastError.at>lastSuccess.at);
 return {events,lastSuccess,lastError,hasNewerError};
}
// Meta (Instagram/Facebook publishing + shared webhook subscription) — real activity is the
// webhook_events ledger (source='meta') plus CONTENT_PUBLISHED audit entries.
function metaActivity(db,audit) {
 let webhookRows=[];
 try{webhookRows=db.prepare("SELECT * FROM webhook_events WHERE source='meta' ORDER BY received_at DESC LIMIT 200").all();}catch{webhookRows=[];}
 const events=[
  ...webhookRows.map(r=>({at:r.received_at,status:r.status==='ERROR'?'FAILED':'COMPLETED',errorCode:r.error||null,kind:r.type,durationMs:null})),
  ...audit.filter(a=>a.action==='CONTENT_PUBLISHED').map(a=>({at:a.at,status:'COMPLETED',errorCode:null,kind:'نشر محتوى',durationMs:null}))
 ].filter(e=>e.at).sort((a,b)=>b.at.localeCompare(a.at));
 const lastSuccess=events.find(e=>e.status==='COMPLETED');
 const lastError=events.find(e=>e.status==='FAILED');
 const hasNewerError=lastError&&(!lastSuccess||lastError.at>lastSuccess.at);
 return {events,lastSuccess,lastError,hasNewerError};
}
function metaOAuthConnected(db) {
 try{return !!db.prepare("SELECT 1 FROM integration_credentials WHERE provider='meta'").get();}catch{return false;}
}
// Microsoft 365 — real activity is crm_messages (channel='Email') plus the webhook_events
// ledger (source='microsoft365') for ingestion/subscription notifications.
function microsoftActivity(db,audit) {
 let emailRows=[],webhookRows=[];
 try{emailRows=db.prepare("SELECT json FROM crm_messages ORDER BY rowid DESC LIMIT 500").all().map(r=>JSON.parse(r.json)).filter(m=>m.channel==='Email');}catch{emailRows=[];}
 try{webhookRows=db.prepare("SELECT * FROM webhook_events WHERE source='microsoft365' ORDER BY received_at DESC LIMIT 200").all();}catch{webhookRows=[];}
 const events=[
  ...emailRows.map(m=>({at:m.recordedAt,status:m.status==='FAILED'?'FAILED':'COMPLETED',errorCode:m.errorCode||null,kind:m.direction==='OUTBOUND'?'بريد صادر':'بريد وارد',durationMs:null})),
  ...webhookRows.map(r=>({at:r.received_at,status:r.status==='ERROR'?'FAILED':'COMPLETED',errorCode:r.error||null,kind:'إشعار Graph',durationMs:null})),
  ...audit.filter(a=>a.action==='MICROSOFT_TOKEN_FAILED'||a.action==='EMAIL_INGEST_FAILED').map(a=>({at:a.at,status:'FAILED',errorCode:a.errorCode||null,kind:'خطأ Microsoft',durationMs:null}))
 ].filter(e=>e.at).sort((a,b)=>b.at.localeCompare(a.at));
 const lastSuccess=events.find(e=>e.status==='COMPLETED');
 const lastError=events.find(e=>e.status==='FAILED');
 const hasNewerError=lastError&&(!lastSuccess||lastError.at>lastSuccess.at);
 return {events,lastSuccess,lastError,hasNewerError};
}
function microsoftOAuthConnected(db) {
 try{return !!db.prepare("SELECT 1 FROM integration_credentials WHERE provider='microsoft365'").get();}catch{return false;}
}
// X — real activity is CONTENT_PUBLISHED audit entries for X content plus this platform's
// own failure/status-unknown audit actions (see runtime/tools.js finalizePublishResult).
function xActivity(audit,content) {
 const events=content.filter(c=>c.platform==='X'&&c.status==='PUBLISHED').map(c=>({at:c.publishedAt,status:'COMPLETED',errorCode:null,kind:'نشر منشور',durationMs:null}))
  .concat(audit.filter(a=>a.action==='X_PUBLISH_FAILED'||a.action==='X_PUBLISH_STATUS_UNKNOWN').map(a=>({at:a.at,status:'FAILED',errorCode:a.errorCode||null,kind:'خطأ نشر',durationMs:null})))
  .filter(e=>e.at).sort((a,b)=>b.at.localeCompare(a.at));
 const lastSuccess=events.find(e=>e.status==='COMPLETED');
 const lastError=events.find(e=>e.status==='FAILED');
 const hasNewerError=lastError&&(!lastSuccess||lastError.at>lastSuccess.at);
 return {events,lastSuccess,lastError,hasNewerError};
}
function xOAuthConnectedCheck(db) {
 try{return !!db.prepare("SELECT 1 FROM integration_credentials WHERE provider='x'").get();}catch{return false;}
}
// LinkedIn — same shape as xActivity, kept separate (not a shared helper) since each
// platform's audit action names and content platform tag are real, distinct strings.
function linkedinActivity(audit,content) {
 const events=content.filter(c=>c.platform==='LinkedIn'&&c.status==='PUBLISHED').map(c=>({at:c.publishedAt,status:'COMPLETED',errorCode:null,kind:'نشر منشور',durationMs:null}))
  .concat(audit.filter(a=>a.action==='LINKEDIN_PUBLISH_FAILED'||a.action==='LINKEDIN_PUBLISH_STATUS_UNKNOWN').map(a=>({at:a.at,status:'FAILED',errorCode:a.errorCode||null,kind:'خطأ نشر',durationMs:null})))
  .filter(e=>e.at).sort((a,b)=>b.at.localeCompare(a.at));
 const lastSuccess=events.find(e=>e.status==='COMPLETED');
 const lastError=events.find(e=>e.status==='FAILED');
 const hasNewerError=lastError&&(!lastSuccess||lastError.at>lastSuccess.at);
 return {events,lastSuccess,lastError,hasNewerError};
}
function linkedinOAuthConnectedCheck(db) {
 try{return !!db.prepare("SELECT 1 FROM integration_credentials WHERE provider='linkedin'").get();}catch{return false;}
}
function envRows(integration,env) {
 const rows=integration.envVars.map(name=>({name,configured:!!env[name]}));
 if(integration.webhookVar)rows.push({name:integration.webhookVar,configured:!!env[integration.webhookVar]});
 return rows;
}
export function buildIntegrationsDashboard(store,{env,aiRuns,complianceRuns,agentRuns=[],tenantId=null}) {
 const content=listContent(store.db,tenantId);
 const audit=listAuditLog(store.db,{tenantId});
 const anthropic=anthropicActivity(aiRuns,complianceRuns);
 const openai=openaiActivity(agentRuns);
 const salla=sallaActivity(audit);
 const whatsapp=whatsappActivity(store.db);
 const meta=metaActivity(store.db,audit);
 const metaConnected=metaOAuthConnected(store.db);
 const microsoft=microsoftActivity(store.db,audit);
 const microsoftConnected=microsoftOAuthConnected(store.db);
 const x=xActivity(audit,content);
 const xConnected=xOAuthConnectedCheck(store.db);
 const linkedin=linkedinActivity(audit,content);
 const linkedinConnected=linkedinOAuthConnectedCheck(store.db);
 const integrations=INTEGRATIONS.map(integration=>{
  const rows=envRows(integration,env);
  const configured=rows.filter(r=>r.name!==integration.webhookVar).every(r=>r.configured)&&integration.envVars.length>0;
  let status,lastActivity=null,recentErrors=[];
  if(integration.supported===false) {
   status='NOT_SUPPORTED';
  } else if(integration.id==='anthropic') {
   status=!configured?'NEEDS_SETUP':anthropic.hasNewerError?'ERROR':'CONNECTED';
   lastActivity=anthropic.lastSuccess?{at:anthropic.lastSuccess.at,note:anthropic.lastSuccess.kind}:null;
   recentErrors=anthropic.events.filter(e=>e.errorCode).slice(0,10).map(e=>({at:e.at,code:e.errorCode,action:ERROR_ACTIONS[e.errorCode]||ERROR_ACTIONS.UNKNOWN}));
  } else if(integration.id==='openai') {
   status=!configured?'NEEDS_SETUP':openai.hasNewerError?'ERROR':openai.lastSuccess?'CONNECTED':'CONFIGURED_NO_CONNECTOR';
   lastActivity=openai.lastSuccess?{at:openai.lastSuccess.at,note:openai.lastSuccess.kind}:null;
   recentErrors=openai.events.filter(e=>e.errorCode).slice(0,10).map(e=>({at:e.at,code:e.errorCode,action:ERROR_ACTIONS[e.errorCode]||ERROR_ACTIONS.UNKNOWN}));
  } else if(integration.id==='salla') {
   status=!configured?'NEEDS_SETUP':salla.hasNewerError?'ERROR':'CONNECTED';
   lastActivity=salla.lastSuccess?{at:salla.lastSuccess.at,by:salla.lastSuccess.actorName,count:salla.lastSuccess.count}:null;
   recentErrors=salla.events.filter(e=>e.action==='SALLA_CATALOG_SYNC_FAILED').slice(0,10).map(e=>({at:e.at,code:e.errorCode,action:ERROR_ACTIONS[e.errorCode]||ERROR_ACTIONS.UNKNOWN}));
  } else if(integration.id==='whatsapp') {
   // "Configured" via either the legacy static token OR a connected Meta OAuth session —
   // WhatsApp rides on the same Meta connection, never a second credential to set up.
   const wConfigured=configured||metaConnected;
   status=!wConfigured?'NEEDS_SETUP':whatsapp.hasNewerError?'ERROR':whatsapp.lastSuccess?'CONNECTED':'CONFIGURED_NO_CONNECTOR';
   lastActivity=whatsapp.lastSuccess?{at:whatsapp.lastSuccess.at,note:whatsapp.lastSuccess.kind}:null;
   recentErrors=whatsapp.events.filter(e=>e.errorCode).slice(0,10).map(e=>({at:e.at,code:e.errorCode,action:ERROR_ACTIONS[e.errorCode]||ERROR_ACTIONS.UNKNOWN}));
  } else if(integration.id==='meta') {
   const mConfigured=configured||metaConnected;
   status=!mConfigured?'NEEDS_SETUP':meta.hasNewerError?'ERROR':meta.lastSuccess?'CONNECTED':'CONFIGURED_NO_CONNECTOR';
   lastActivity=meta.lastSuccess?{at:meta.lastSuccess.at,note:meta.lastSuccess.kind}:null;
   recentErrors=meta.events.filter(e=>e.errorCode).slice(0,10).map(e=>({at:e.at,code:e.errorCode,action:ERROR_ACTIONS[e.errorCode]||ERROR_ACTIONS.UNKNOWN}));
  } else if(integration.id==='microsoft365') {
   const msConfigured=configured||microsoftConnected;
   status=!msConfigured?'NEEDS_SETUP':microsoft.hasNewerError?'ERROR':microsoft.lastSuccess?'CONNECTED':'CONFIGURED_NO_CONNECTOR';
   lastActivity=microsoft.lastSuccess?{at:microsoft.lastSuccess.at,note:microsoft.lastSuccess.kind}:null;
   recentErrors=microsoft.events.filter(e=>e.errorCode).slice(0,10).map(e=>({at:e.at,code:e.errorCode,action:ERROR_ACTIONS[e.errorCode]||ERROR_ACTIONS.UNKNOWN}));
  } else if(integration.id==='x') {
   const xConfigured=configured||xConnected;
   status=!xConfigured?'NEEDS_SETUP':x.hasNewerError?'ERROR':x.lastSuccess?'CONNECTED':'CONFIGURED_NO_CONNECTOR';
   lastActivity=x.lastSuccess?{at:x.lastSuccess.at,note:x.lastSuccess.kind}:null;
   recentErrors=x.events.filter(e=>e.errorCode).slice(0,10).map(e=>({at:e.at,code:e.errorCode,action:ERROR_ACTIONS[e.errorCode]||ERROR_ACTIONS.UNKNOWN}));
  } else if(integration.id==='linkedin') {
   const liConfigured=configured||linkedinConnected;
   status=!liConfigured?'NEEDS_SETUP':linkedin.hasNewerError?'ERROR':linkedin.lastSuccess?'CONNECTED':'CONFIGURED_NO_CONNECTOR';
   lastActivity=linkedin.lastSuccess?{at:linkedin.lastSuccess.at,note:linkedin.lastSuccess.kind}:null;
   recentErrors=linkedin.events.filter(e=>e.errorCode).slice(0,10).map(e=>({at:e.at,code:e.errorCode,action:ERROR_ACTIONS[e.errorCode]||ERROR_ACTIONS.UNKNOWN}));
  } else {
   // No real connector exists yet — configured or not, nothing in this app can actually use
   // the credential, so "Connected" would be false regardless of the env var's presence.
   status=configured?'CONFIGURED_NO_CONNECTOR':'NEEDS_SETUP';
  }
  return {
   id:integration.id,name:integration.name,category:integration.category,description:integration.description,
   authType:integration.authType,connectorImplemented:integration.connectorImplemented,
   status,envVars:rows,scopes:integration.scopes,lastActivity,recentErrors,
   agentsUsing:agentsUsing(integration.id)
  };
 });
 const summary={
  connected:integrations.filter(i=>i.status==='CONNECTED').length,
  needsSetup:integrations.filter(i=>i.status==='NEEDS_SETUP').length,
  attentionRequired:integrations.filter(i=>i.status==='CONFIGURED_NO_CONNECTOR').length,
  errors:integrations.filter(i=>i.status==='ERROR').length,
  total:integrations.length
 };
 const recentSyncActivity=[
  ...anthropic.events.slice(0,15).map(e=>({at:e.at,integration:'Anthropic',operation:e.kind,status:e.status,records:null,durationMs:e.durationMs,errorCode:e.errorCode})),
  ...openai.events.slice(0,15).map(e=>({at:e.at,integration:'OpenAI',operation:e.kind,status:e.status,records:null,durationMs:e.durationMs,errorCode:e.errorCode})),
  ...salla.events.slice(0,15).map(e=>({at:e.at,integration:'Salla',operation:'مزامنة الكتالوج',status:e.action==='SALLA_CATALOG_SYNCED'?'COMPLETED':'ERROR',records:e.count??null,durationMs:null,errorCode:e.errorCode||null})),
  ...whatsapp.events.slice(0,15).map(e=>({at:e.at,integration:'WhatsApp Business',operation:e.kind,status:e.status,records:null,durationMs:e.durationMs,errorCode:e.errorCode})),
  ...meta.events.slice(0,15).map(e=>({at:e.at,integration:'Meta',operation:e.kind,status:e.status,records:null,durationMs:e.durationMs,errorCode:e.errorCode})),
  ...microsoft.events.slice(0,15).map(e=>({at:e.at,integration:'Microsoft 365',operation:e.kind,status:e.status,records:null,durationMs:e.durationMs,errorCode:e.errorCode})),
  ...x.events.slice(0,15).map(e=>({at:e.at,integration:'X',operation:e.kind,status:e.status,records:null,durationMs:e.durationMs,errorCode:e.errorCode})),
  ...linkedin.events.slice(0,15).map(e=>({at:e.at,integration:'LinkedIn',operation:e.kind,status:e.status,records:null,durationMs:e.durationMs,errorCode:e.errorCode}))
 ].sort((a,b)=>b.at.localeCompare(a.at)).slice(0,20);
 return {summary,integrations,recentSyncActivity};
}
