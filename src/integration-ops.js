// IntegrationOpsService — a thin, read-only aggregation layer for the Integration &
// Connection Center. Creates no new connection model: it only reshapes the two disjoint
// status sources that already exist (connectionStatus in connectors.js for Anthropic/Salla,
// integrationStatus in runtime/tools.js for the other six) plus real usage evidence already
// recorded in ai_runs, compliance_runs and state.audit. Never invents a "connected" state —
// six of these eight services have zero real HTTP client code today, and this file says so.
import {AGENT_INTEGRATIONS} from './runtime/tools.js';
import {agents as AGENT_DEFS} from './domain.js';

// Real, documented facts about each integration: which env vars it needs, whether this
// codebase actually has a connector that calls it, and — for services with a real OAuth/API
// permission model — which scopes that connector would need once built. Scopes are shown as
// documentation of what will be required, never as a live "granted" check, since no OAuth
// flow or permission API exists anywhere in this app.
export const INTEGRATIONS=[
 {id:'anthropic',name:'Anthropic',category:'AI',description:'تشغيل الوكلاء وتوليد المحتوى بالذكاء الاصطناعي.',envVars:['ANTHROPIC_API_KEY','ANTHROPIC_MODEL'],authType:'API Key',connectorImplemented:true,scopes:[]},
 // Explicitly NOT supported: no env var, no connector, no mention anywhere in this codebase.
 // Listed per request ("OpenAI إذا مدعوم") but marked honestly rather than treated like the
 // six stub services below, which at least have real env-var gating and tool placeholders.
 {id:'openai',name:'OpenAI',category:'AI',description:'مزود ذكاء اصطناعي بديل.',envVars:[],authType:'API Key',connectorImplemented:false,supported:false,scopes:[]},
 {id:'salla',name:'Salla',category:'Commerce',description:'استيراد كتالوج المنتجات والأسعار والمخزون.',envVars:['SALLA_ACCESS_TOKEN'],webhookVar:'SALLA_WEBHOOK_SECRET',authType:'Bearer Token',connectorImplemented:true,scopes:[]},
 {id:'whatsapp',name:'WhatsApp Business',category:'Messaging',description:'استقبال محادثات العملاء وتشغيل الردود والمتابعات.',envVars:['WHATSAPP_ACCESS_TOKEN'],authType:'Bearer Token',connectorImplemented:false,scopes:[{name:'whatsapp_business_messaging',note:'إرسال واستقبال رسائل واتساب للأعمال'}]},
 {id:'meta',name:'Meta',category:'Social',description:'نشر محتوى على Instagram وFacebook.',envVars:['META_ACCESS_TOKEN'],authType:'OAuth Token',connectorImplemented:false,scopes:[{name:'pages_read_engagement',note:'قراءة تفاعل صفحة فيسبوك'},{name:'instagram_basic',note:'الوصول الأساسي لحساب إنستغرام'},{name:'pages_manage_posts',note:'نشر منشورات على الصفحة'}]},
 {id:'x',name:'X',category:'Social',description:'نشر محتوى على منصة X.',envVars:['X_BEARER_TOKEN'],authType:'Bearer Token',connectorImplemented:false,scopes:[{name:'tweet.write',note:'نشر تغريدات'},{name:'tweet.read',note:'قراءة التغريدات'}]},
 {id:'linkedin',name:'LinkedIn',category:'Social',description:'نشر محتوى الأعمال B2B على لينكدإن.',envVars:['LINKEDIN_ACCESS_TOKEN'],authType:'OAuth Token',connectorImplemented:false,scopes:[{name:'w_organization_social',note:'النشر نيابة عن صفحة الشركة'}]},
 {id:'microsoft365',name:'Microsoft 365',category:'Productivity',description:'إرسال البريد الإلكتروني وأدوات الفريق.',envVars:['MICROSOFT_ACCESS_TOKEN'],authType:'OAuth Token',connectorImplemented:false,scopes:[{name:'Mail.Send',note:'إرسال بريد إلكتروني نيابة عن المستخدم'}]},
 {id:'canva',name:'Canva',category:'Productivity',description:'توليد الأصول البصرية للمحتوى.',envVars:['CANVA_API_KEY'],authType:'API Key',connectorImplemented:false,scopes:[{name:'design:content:write',note:'إنشاء تصاميم جديدة'}]}
];
export const ERROR_ACTIONS={
 CREDENTIALS_REJECTED:'تحقق من صحة المفتاح أو الرمز في إعدادات الخادم',
 RATE_LIMITED:'انتظر قليلًا ثم أعد المحاولة، أو راجع حدود خطة الخدمة',
 NETWORK_OR_TIMEOUT:'تحقق من اتصال الخادم بالإنترنت وأعد المحاولة',
 PROVIDER_ERROR:'الخدمة الخارجية أعادت خطأ غير متوقع، أعد المحاولة لاحقًا',
 INVALID_PROVIDER_RESPONSE:'استجابة غير متوقعة من الخدمة، أعد المحاولة',
 ANTHROPIC_NOT_CONFIGURED:'أضف مفتاح Anthropic واسم الموديل في إعدادات الخادم',
 SALLA_NOT_CONFIGURED:'أضف رمز وصول سلة في إعدادات الخادم',
 INVALID_SALLA_RESPONSE:'استجابة سلة غير متوقعة، أعد المحاولة لاحقًا',
 INVALID_SALLA_PRODUCT:'بيانات منتج غير صالحة وردت من سلة',
 INVALID_SALLA_PRODUCT_URL:'رابط منتج غير صالح من سلة',
 STORE_DOMAIN_MISMATCH:'رابط منتج لا يطابق نطاق متجر HyperCool',
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
function sallaActivity(audit) {
 const events=audit.filter(a=>a.action==='SALLA_CATALOG_SYNCED'||a.action==='SALLA_CATALOG_SYNC_FAILED').sort((a,b)=>b.at.localeCompare(a.at));
 const lastSuccess=events.find(e=>e.action==='SALLA_CATALOG_SYNCED');
 const lastError=events.find(e=>e.action==='SALLA_CATALOG_SYNC_FAILED');
 const hasNewerError=lastError&&(!lastSuccess||lastError.at>lastSuccess.at);
 return {events,lastSuccess,lastError,hasNewerError};
}
function envRows(integration,env) {
 const rows=integration.envVars.map(name=>({name,configured:!!env[name]}));
 if(integration.webhookVar)rows.push({name:integration.webhookVar,configured:!!env[integration.webhookVar]});
 return rows;
}
export function buildIntegrationsDashboard(store,{env,aiRuns,complianceRuns}) {
 const state=store.read();
 const anthropic=anthropicActivity(aiRuns,complianceRuns);
 const salla=sallaActivity(state.audit);
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
  } else if(integration.id==='salla') {
   status=!configured?'NEEDS_SETUP':salla.hasNewerError?'ERROR':'CONNECTED';
   lastActivity=salla.lastSuccess?{at:salla.lastSuccess.at,by:salla.lastSuccess.actorName,count:salla.lastSuccess.count}:null;
   recentErrors=salla.events.filter(e=>e.action==='SALLA_CATALOG_SYNC_FAILED').slice(0,10).map(e=>({at:e.at,code:e.errorCode,action:ERROR_ACTIONS[e.errorCode]||ERROR_ACTIONS.UNKNOWN}));
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
  ...salla.events.slice(0,15).map(e=>({at:e.at,integration:'Salla',operation:'مزامنة الكتالوج',status:e.action==='SALLA_CATALOG_SYNCED'?'COMPLETED':'ERROR',records:e.count??null,durationMs:null,errorCode:e.errorCode||null}))
 ].sort((a,b)=>b.at.localeCompare(a.at)).slice(0,20);
 return {summary,integrations,recentSyncActivity};
}
