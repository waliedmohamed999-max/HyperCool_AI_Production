import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {contextSummaryForPlanner} from './context-items.js';

// Frost Command Center chat (Phase 7A). Deliberately NOT a second orchestrator/runtime: every
// message is answered by exactly one call to the SAME `agentRuntime.run('frost_commander', …)`
// every other agent already goes through (src/runtime/runtime.js) — permission checks, tool
// dispatch, connection resolution, approval-gating, audit and `agent_runs`/`agent_tool_calls`
// persistence all come from there, unchanged. This module only adds the thin chat-session
// bookkeeping (conversations/messages) that concept genuinely has no existing home for.
export function installCommandChat(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS command_conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
 );
 CREATE INDEX IF NOT EXISTS idx_command_conversations_tenant_user ON command_conversations(tenant_id,user_id);
 CREATE TABLE IF NOT EXISTS command_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  run_id TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_command_messages_conversation ON command_messages(conversation_id,created_at);`);
}
function hydrateConversation(row) {
 if(!row)return null;
 return {id:row.id,tenantId:row.tenant_id,userId:row.user_id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at,archivedAt:row.archived_at};
}
function hydrateMessage(row) {
 if(!row)return null;
 return {id:row.id,conversationId:row.conversation_id,role:row.role,content:row.content,runId:row.run_id,
  meta:row.meta_json?JSON.parse(row.meta_json):null,createdAt:row.created_at};
}
export function createConversation(db,user,tenantId=null,title=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const now=new Date().toISOString();
 const row={id:randomUUID(),tenantId:resolvedTenantId,userId:user.id,title:title||'محادثة جديدة',createdAt:now,updatedAt:now};
 db.prepare('INSERT INTO command_conversations (id,tenant_id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  .run(row.id,row.tenantId,row.userId,row.title,row.createdAt,row.updatedAt);
 return getConversation(db,row.id,resolvedTenantId);
}
// Every tenant member sees every conversation for this tenant (matches this app's existing
// "any authenticated tenant member" visibility for shared operational surfaces like Reports),
// not per-user-private — a Command Center is a team tool, not a personal inbox.
export function listConversations(db,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 return db.prepare('SELECT * FROM command_conversations WHERE tenant_id=? AND archived_at IS NULL ORDER BY updated_at DESC').all(resolvedTenantId).map(hydrateConversation);
}
export function getConversation(db,id,tenantId=null) {
 const row=db.prepare('SELECT * FROM command_conversations WHERE id=? AND tenant_id=?').get(id,tenantId||resolveActiveTenantId(db));
 if(!row)fail(404,'المحادثة غير موجودة');
 return hydrateConversation(row);
}
export function renameConversation(db,id,title,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 getConversation(db,id,resolvedTenantId);
 const cleanTitle=typeof title==='string'?title.trim().slice(0,200):'';
 if(!cleanTitle)fail(400,'العنوان مطلوب');
 db.prepare('UPDATE command_conversations SET title=?,updated_at=? WHERE id=? AND tenant_id=?').run(cleanTitle,new Date().toISOString(),id,resolvedTenantId);
 return getConversation(db,id,resolvedTenantId);
}
export function archiveConversation(db,id,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 getConversation(db,id,resolvedTenantId);
 db.prepare('UPDATE command_conversations SET archived_at=?,updated_at=? WHERE id=? AND tenant_id=?').run(new Date().toISOString(),new Date().toISOString(),id,resolvedTenantId);
 return {archived:true};
}
export function listMessages(db,conversationId,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 getConversation(db,conversationId,resolvedTenantId); // 404s if missing or wrong tenant
 return db.prepare('SELECT * FROM command_messages WHERE conversation_id=? AND tenant_id=? ORDER BY created_at').all(conversationId,resolvedTenantId).map(hydrateMessage);
}
function insertMessage(db,{conversationId,tenantId,role,content,runId=null,meta=null}) {
 const id=randomUUID(),createdAt=new Date().toISOString();
 db.prepare('INSERT INTO command_messages (id,conversation_id,tenant_id,role,content,run_id,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(id,conversationId,tenantId,role,content,runId,meta?JSON.stringify(meta):null,createdAt);
 db.prepare('UPDATE command_conversations SET updated_at=? WHERE id=?').run(createdAt,conversationId);
 return hydrateMessage(db.prepare('SELECT * FROM command_messages WHERE id=?').get(id));
}

// Fixed, human-readable labels — never the model's own reasoning text (spec item 6: no hidden
// chain-of-thought, only real operational steps). Falls back to the raw tool name for any
// tool this map hasn't been extended for yet, so a new tool never renders as literally blank.
const STEP_LABELS={
 get_company_health:'قراءة الحالة التشغيلية العامة',
 get_metrics:'قراءة تقرير الأداء الأسبوعي',
 get_followups_needing_attention:'قراءة المتابعات المتأخرة والعملاء المهتمين',
 get_integrations_health:'قراءة حالة التكاملات',
 get_agent_tool_status:'قراءة خريطة الوكلاء والأدوات',
 search_context:'البحث في سياق الشركة المسجّل',
 search_crm:'البحث في قاعدة العملاء',
 get_lead:'قراءة تفاصيل عميل',
 get_conversation:'قراءة سجل محادثة عميل',
 search_brand_memory:'قراءة ذاكرة العلامة المعتمدة',
 get_competitor_data:'قراءة رصد المنافسين',
 update_agent_tool_connection:'تغيير اتصال أداة لوكيل',
 run_followup_sweep:'تشغيل جولة فحص المتابعات المتأخرة',
 list_scheduled_content_jobs:'قراءة الأعمال المجدولة للمحتوى',
 cancel_scheduled_content_job:'إيقاف عمل مجدول للمحتوى',
 explain_followup_status:'قراءة سبب حالة متابعة عميل',
 prepare_bulk_followup_plan:'تجهيز معاينة متابعة جماعية (بدون إرسال)'
};
const DELEGATE_AGENT_LABEL_AR={performance:'وكيل الأداء',intelligence:'وكيل رصد السوق',leads:'وكيل العملاء المحتملين',strategy:'وكيل استراتيجية المحتوى'};
// Phase 7B — Multi-Agent UI (spec Part 9): a `delegate_to_agent` step is labeled with the REAL
// target agent and the REAL child-run outcome (status/summary come straight from the tool's own
// structured result — tools.js's delegate_to_agent handler — never invented here), so the chat
// timeline shows genuine per-agent progress, not a generic "tool called" line.
function stepsFromToolCalls(toolCalls) {
 return toolCalls.map(tc=>{
  if(tc.tool==='delegate_to_agent') {
   const agent=tc.input?.agent;
   return {tool:tc.tool,label:`تفويض إلى ${DELEGATE_AGENT_LABEL_AR[agent]||agent}`,status:tc.status,
    delegatedAgent:agent,delegatedStatus:tc.output?.status||null,delegatedRunId:tc.output?.artifacts?.runId||null,at:tc.at};
  }
  return {tool:tc.tool,label:STEP_LABELS[tc.tool]||tc.tool,status:tc.status,connectionId:tc.connectionId||null,at:tc.at};
 });
}
function honestFailureMessage(run) {
 const error=run.error||run.output?.reason||'';
 if(/NOT_CONFIGURED|AI_NOT_CONFIGURED|AI_CONNECTION/.test(error))return 'يلزم إعداد اتصال ذكاء اصطناعي لهذه المنشأة لتفعيل المحادثة — باقي أقسام غرفة القيادة (العمليات، البيانات، الاقتراحات) تعمل بدونه.';
 if(error==='AGENT_DISABLED')return 'مساعد غرفة القيادة معطّل حاليًا لهذه المنشأة.';
 if(error==='AGENT_NOT_READY')return 'مساعد غرفة القيادة غير جاهز حاليًا (أداة مطلوبة غير متاحة).';
 if(run.output?.reason==='TENANT_NOT_OPERATIONAL'||/SUSPENDED|TRIAL_EXPIRED|ARCHIVED/.test(error))return 'الحساب غير نشط حاليًا.';
 return 'تعذر تنفيذ الطلب' + (error?`: ${error}`:'') + '.';
}
/**
 * The one real entry point a chat message goes through — a single `agentRuntime.run(...)`
 * call, never a direct provider/tool call. `pendingApproval` (if any) is derived from the
 * REAL tool-call list, not from `run.status` — a run can finish COMPLETED overall while one of
 * its own tool calls is paused at WAITING_APPROVAL (the model still produces a final reply
 * acknowledging that), so status alone would miss it.
 */
export async function sendCommandMessage({store,agentRuntime,env,tenantId,user,conversationId,text,attachmentContext=null}) {
 const db=store.db;
 const cleanText=typeof text==='string'?text.trim():'';
 if(!cleanText||cleanText.length>4000)fail(400,'الرسالة مطلوبة (حتى 4000 حرف)');
 getConversation(db,conversationId,tenantId); // 404s if missing or wrong tenant
 insertMessage(db,{conversationId,tenantId,role:'user',content:cleanText,meta:attachmentContext?{attachmentId:attachmentContext.attachment.id}:null});
 const recentHistory=listMessages(db,conversationId,tenantId).slice(-10).map(m=>({role:m.role,content:m.content}));
 const companyContext=contextSummaryForPlanner(db,tenantId);
 // Spec item 18 — an attachment referenced in-conversation is passed as real, size-bounded
 // context for THIS run only; it never touches context_items (Company Brain) unless the human
 // explicitly pins it (see POST /api/command/attachments/:id/pin-to-brain).
 const run=await agentRuntime.run('frost_commander',{
  triggerType:'COMMAND',input:{message:cleanText,recentHistory,companyContext,
   ...(attachmentContext?{attachment:{filename:attachmentContext.attachment.filename,mimeType:attachmentContext.attachment.mimeType,text:attachmentContext.text,note:attachmentContext.note}}:{}),
   current_datetime:new Date().toISOString(),timezone:'Asia/Riyadh'},
  user,tenantId
 });
 const steps=stepsFromToolCalls(run.toolCalls||[]);
 const pendingApproval=(run.toolCalls||[]).find(tc=>tc.status==='WAITING_APPROVAL');
 let content,meta={steps,runId:run.id};
 if(run.status==='FAILED'||run.status==='CANCELLED') {
  content=honestFailureMessage(run);
 } else {
  const payload=run.output?.payload||null;
  content=payload?.answer||run.output?.rationale||'تم التنفيذ.';
  if(payload?.dataSources||payload?.data_sources)meta.dataSources=payload.data_sources||payload.dataSources;
  if(payload?.follow_up_suggestions?.length)meta.followUpSuggestions=payload.follow_up_suggestions;
 }
 if(pendingApproval) {
  meta.pendingApprovalId=pendingApproval.output?.approvalId||null;
  content+= (content.endsWith('.')?' ':'. ')+'بانتظار موافقتك على الإجراء المقترح.';
 }
 const assistantMessage=insertMessage(db,{conversationId,tenantId,role:'assistant',content,runId:run.id,meta});
 return {run,assistantMessage};
}
