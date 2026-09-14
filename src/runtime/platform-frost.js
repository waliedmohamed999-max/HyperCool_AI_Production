import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {createLLMProvider} from './llmProvider.js';
import {validateAgentDecision} from '../agents.js';
import {recordPlatformAudit} from '../platform-identity.js';
import {buildPlatformOverview,listPlatformDeadLetterWebhooks,listTenantsWithUnhealthyIntegrations} from '../platform-admin.js';

// Frost Command Center Phase 7C — Platform Command Center Chat (spec Part 37-42). Deliberately
// NOT a second Agent Runtime and NOT tenant Frost reused across tenants: `createAgentRuntime()`
// is built entirely around a single real tenant_id (tenant config, tool assignments, approval
// gating, agent_runs) — there is no "platform tenant" to bind it to, and retrofitting one would
// either weaken tenant isolation or literally BE the "second agent system for a different
// scope" the architecture rule forbids. Instead this reuses the one genuinely tenant-agnostic
// layer that already exists — `createLLMProvider(...).run()`, the same tool-calling primitive
// AgentRuntime itself is built on — with a small, FIXED, read-only tool set that only ever
// calls the existing platform-admin.js aggregate functions. No tenant business data is ever
// reachable from here (see the tool list below) — spec item 33/38's aggregate-only guarantee
// is structural, not a prompt instruction.
const PLATFORM_FROST_TOOLS=[
 {name:'get_platform_overview',description:'Real, platform-wide aggregate counts: tenants by status, users, connections needing attention, agents failing, recent critical errors, failed webhooks, connections needing re-authorization, and whether the scheduler is running.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'list_dead_letter_webhooks',description:'List real, platform-wide dead-letter/failed webhook deliveries (never their raw payload).',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'list_unhealthy_tenants',description:'List which tenants currently have an unhealthy integration connection, with the real count only (never the connection\'s credentials or the tenant\'s business data).',inputSchema:{type:'object',properties:{},additionalProperties:false}}
];
function buildExecuteTool({db,env,schedulerRunning}) {
 return async(name)=>{
  if(name==='get_platform_overview')return {...buildPlatformOverview(db,env),schedulerRunning};
  if(name==='list_dead_letter_webhooks')return listPlatformDeadLetterWebhooks(db,{limit:20});
  if(name==='list_unhealthy_tenants')return listTenantsWithUnhealthyIntegrations(db,env);
  return {status:'ERROR',error:'UNKNOWN_TOOL'};
 };
}
const SYSTEM_PROMPT=`SYSTEM — PLATFORM COMMAND CENTER ASSISTANT
أنت مساعد تشغيل المنصة (وليس مساعد أعمال أي منشأة/Tenant). مستخدمك هو مسؤول منصة (Platform Admin) حقيقي.
- أجب فقط من نتائج الأدوات المتاحة لك (بيانات مجمّعة عبر كل المنشآت) — لا تخترع رقمًا أو اسمًا أبدًا.
- لا تكشف أبدًا بيانات عمل خاصة بمنشأة واحدة (اسم عميل، محتوى، مبالغ) — أنت ترى فقط أرقامًا مجمّعة وحالات تشغيلية. إن سُئلت عن تفاصيل منشأة محددة، وضّح أن ذلك يتطلب فتح تلك المنشأة صراحة من لوحة المنصة.
- إن لم تخدم أي أداة السؤال، وضّح ذلك بصراحة بدل التخمين.
أعد كائن JSON فقط مطابقًا للمخطط التالي، بدون أي نص خارجه:
{"status":"OK|NEEDS_DATA|ERROR","action":"ANSWER","rationale":"...","verification":[],"risk_level":"LOW","escalation_required":false,"missing_data":[],"payload":{"answer":"...","data_sources":["..."]}}`;

export function installPlatformFrostChat(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS platform_frost_messages (
  id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
  actor_id TEXT, actor_name TEXT, created_at TEXT NOT NULL
 );`);
}
function hydrate(row) {return {id:row.id,role:row.role,content:row.content,actorName:row.actor_name,createdAt:row.created_at};}
export function listPlatformFrostMessages(db,{limit=50}={}) {
 return db.prepare('SELECT * FROM platform_frost_messages ORDER BY created_at DESC LIMIT ?').all(limit).map(hydrate).reverse();
}
function insertMessage(db,{role,content,actor}) {
 const id=randomUUID(),now=new Date().toISOString();
 db.prepare('INSERT INTO platform_frost_messages (id,role,content,actor_id,actor_name,created_at) VALUES (?,?,?,?,?,?)')
  .run(id,role,content,actor?.id||null,actor?.name||null,now);
 return hydrate(db.prepare('SELECT * FROM platform_frost_messages WHERE id=?').get(id));
}
/**
 * The one real entry point (spec item 42 — every command audited). `schedulerRunning` is
 * passed in by the caller (application.js has the real scheduler instance) rather than this
 * module reaching for a global — keeps this file fully testable without a live scheduler.
 */
export async function sendPlatformFrostMessage({db,env,fetcher,schedulerRunning,actor,text}) {
 const cleanText=typeof text==='string'?text.trim():'';
 if(!cleanText||cleanText.length>2000)fail(400,'الرسالة مطلوبة (حتى 2000 حرف)');
 insertMessage(db,{role:'user',content:cleanText,actor});
 const llm=createLLMProvider(env,fetcher);
 if(!llm.configured) {
  const content='يلزم إعداد اتصال ذكاء اصطناعي لتفعيل محادثة غرفة قيادة المنصة.';
  const assistantMessage=insertMessage(db,{role:'assistant',content,actor:null});
  recordPlatformAudit(db,{id:randomUUID(),action:'PLATFORM_FROST_COMMAND_FAILED_AI_NOT_CONFIGURED',itemId:assistantMessage.id,actorId:actor?.id||null,actorName:actor?.name||null,at:new Date().toISOString()});
  return {assistantMessage,status:'FAILED'};
 }
 const executeTool=buildExecuteTool({db,env,schedulerRunning});
 let content,status='OK';
 try {
  const {decision}=await llm.run({systemPrompt:SYSTEM_PROMPT,context:{message:cleanText,current_datetime:new Date().toISOString()},tools:PLATFORM_FROST_TOOLS,executeTool,maxTurns:4});
  validateAgentDecision('platform_frost',decision);
  content=decision.payload?.answer||'تم.';
 } catch(error) {
  content='تعذر تنفيذ الطلب: '+error.message;
  status='FAILED';
 }
 const assistantMessage=insertMessage(db,{role:'assistant',content,actor:null});
 recordPlatformAudit(db,{id:randomUUID(),action:'PLATFORM_FROST_COMMAND',itemId:assistantMessage.id,actorId:actor?.id||null,actorName:actor?.name||null,at:new Date().toISOString()});
 return {assistantMessage,status};
}
