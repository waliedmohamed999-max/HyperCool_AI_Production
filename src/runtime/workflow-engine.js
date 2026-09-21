import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {recordAudit} from '../audit.js';
import {getTenant,tenantOperationalBlockReason} from '../tenancy.js';
import {createApproval} from './approvals.js';
import {createEscalation} from './escalations.js';
import {canUseTool,levelOf,effectiveLevel} from './permissions.js';
import {resolveToolConnection} from './tool-assignments.js';
import {getConnectionOrNull} from '../integrations/connections.js';
import {evaluateCondition,validateCondition} from './workflow-conditions.js';
import {EVENT_TYPES} from './events.js';
import {evaluateAllToolsReadiness} from './agent-readiness.js';
import {getToolDefinition} from './tool-definitions.js';

// Frost Command Center Phase 7C — the native Workflow Engine (spec Part 2, CORE
// ARCHITECTURAL RULE). This module is deliberately ONLY: definition + trigger + conditions +
// step graph + execution state. Every real action a step performs is dispatched to an
// EXISTING system — agentRuntime.run() for AGENT steps, the EXISTING Tool Registry
// (canUseTool/resolveToolConnection/tool.handler — the exact same functions runtime.js's own
// executeTool already calls) for TOOL steps, createApproval/decideApproval for APPROVAL
// steps, createEscalation for CREATE_TASK/NOTIFY_INTERNAL steps, and the EXISTING
// scheduler.js tick / events.js EventBus for SCHEDULE/EVENT triggers. No second Agent
// Runtime, Tool Registry, Event Bus, Scheduler, or Approval Engine is created here.

export const WORKFLOW_STEP_TYPES=['AGENT','TOOL','CONDITION','DELAY','APPROVAL','CREATE_TASK','NOTIFY_INTERNAL'];
export const WORKFLOW_TRIGGER_TYPES=['MANUAL','SCHEDULE','EVENT'];
// Conservative, configurable limits (spec item 78) — defaults chosen to comfortably cover
// every real example in the spec (longest example workflow has 4 steps) while still being a
// real, enforced ceiling, not a documentation-only number.
const DEFAULT_LIMITS={MAX_WORKFLOW_STEPS:30,MAX_PARALLEL_WORKFLOW_STEPS:5,MAX_ACTIVE_WORKFLOWS_PER_TENANT:50,MAX_AUTOMATION_DEPTH:5};
function limits(env={}) {
 return {
  MAX_WORKFLOW_STEPS:Number(env.MAX_WORKFLOW_STEPS)||DEFAULT_LIMITS.MAX_WORKFLOW_STEPS,
  MAX_PARALLEL_WORKFLOW_STEPS:Number(env.MAX_PARALLEL_WORKFLOW_STEPS)||DEFAULT_LIMITS.MAX_PARALLEL_WORKFLOW_STEPS,
  MAX_ACTIVE_WORKFLOWS_PER_TENANT:Number(env.MAX_ACTIVE_WORKFLOWS_PER_TENANT)||DEFAULT_LIMITS.MAX_ACTIVE_WORKFLOWS_PER_TENANT,
  MAX_AUTOMATION_DEPTH:Number(env.MAX_AUTOMATION_DEPTH)||DEFAULT_LIMITS.MAX_AUTOMATION_DEPTH
 };
}
export const WORKFLOW_ACTOR={id:'agent:workflow_engine',name:'محرك الأتمتة',role:'automation'};

export function installWorkflowEngine(db) {
 db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_definitions (
   id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
   name_ar TEXT NOT NULL, name_en TEXT, description TEXT,
   status TEXT NOT NULL CHECK(status IN ('DRAFT','ACTIVE','PAUSED','ARCHIVED')),
   draft_version_id TEXT, active_version_id TEXT,
   created_by TEXT, created_by_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
   command_run_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_definitions_tenant ON workflow_definitions(tenant_id,status);
  CREATE TABLE IF NOT EXISTS workflow_versions (
   id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, tenant_id TEXT NOT NULL, version INTEGER NOT NULL,
   trigger_json TEXT NOT NULL, conditions_json TEXT, steps_json TEXT NOT NULL,
   status TEXT NOT NULL CHECK(status IN ('DRAFT','PUBLISHED')),
   readiness_json TEXT, created_by TEXT, created_by_name TEXT, created_at TEXT NOT NULL,
   UNIQUE(workflow_id,version)
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow ON workflow_versions(workflow_id);
  CREATE TABLE IF NOT EXISTS workflow_runs (
   id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workflow_id TEXT NOT NULL, workflow_version_id TEXT NOT NULL,
   trigger_type TEXT NOT NULL, trigger_context_json TEXT,
   status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','WAITING','WAITING_APPROVAL','COMPLETED','FAILED','CANCEL_REQUESTED','CANCELLED')),
   context_json TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, error TEXT,
   causation_depth INTEGER NOT NULL DEFAULT 0,
   started_at TEXT NOT NULL, finished_at TEXT, next_resume_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_tenant ON workflow_runs(tenant_id,status);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_resume ON workflow_runs(status,next_resume_at);
  CREATE TABLE IF NOT EXISTS workflow_step_runs (
   id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workflow_run_id TEXT NOT NULL, step_id TEXT NOT NULL, step_type TEXT NOT NULL,
   status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','WAITING','WAITING_APPROVAL','COMPLETED','FAILED','SKIPPED','CANCELLED')),
   input_json TEXT, output_json TEXT, error TEXT, approval_id TEXT, agent_run_id TEXT,
   started_at TEXT, finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_step_runs_run ON workflow_step_runs(workflow_run_id);
 `);
}

function hydrateDefinition(row) {
 if(!row)return null;
 return {id:row.id,tenantId:row.tenant_id,nameAr:row.name_ar,nameEn:row.name_en,description:row.description,
  status:row.status,draftVersionId:row.draft_version_id,activeVersionId:row.active_version_id,
  createdBy:row.created_by,createdByName:row.created_by_name,createdAt:row.created_at,updatedAt:row.updated_at,
  commandRunId:row.command_run_id};
}
function hydrateVersion(row) {
 if(!row)return null;
 return {id:row.id,workflowId:row.workflow_id,tenantId:row.tenant_id,version:row.version,
  trigger:JSON.parse(row.trigger_json),conditions:row.conditions_json?JSON.parse(row.conditions_json):null,
  steps:JSON.parse(row.steps_json),status:row.status,readiness:row.readiness_json?JSON.parse(row.readiness_json):null,
  createdBy:row.created_by,createdByName:row.created_by_name,createdAt:row.created_at};
}
function hydrateRun(row) {
 if(!row)return null;
 return {id:row.id,tenantId:row.tenant_id,workflowId:row.workflow_id,workflowVersionId:row.workflow_version_id,
  triggerType:row.trigger_type,triggerContext:row.trigger_context_json?JSON.parse(row.trigger_context_json):null,
  status:row.status,context:JSON.parse(row.context_json),cancelRequested:!!row.cancel_requested,error:row.error,
  causationDepth:row.causation_depth,startedAt:row.started_at,finishedAt:row.finished_at,nextResumeAt:row.next_resume_at};
}
function hydrateStepRun(row) {
 if(!row)return null;
 return {id:row.id,tenantId:row.tenant_id,workflowRunId:row.workflow_run_id,stepId:row.step_id,stepType:row.step_type,
  status:row.status,input:row.input_json?JSON.parse(row.input_json):null,output:row.output_json?JSON.parse(row.output_json):null,
  error:row.error,approvalId:row.approval_id,agentRunId:row.agent_run_id,startedAt:row.started_at,finishedAt:row.finished_at};
}

// ------------------------------------------------------------------------------------------
// DAG validation (spec Part 17) — every workflow version is validated BEFORE it can ever be
// published/activated. Cycle detection via DFS; join semantics computed from the reverse of
// each step's own `next`/`elseNext` arrays — no separate "parallel group" concept needed.
// ------------------------------------------------------------------------------------------
export function predecessorsOf(stepId,steps) {
 return steps.filter(s=>(s.next||[]).includes(stepId)||(s.elseNext||[]).includes(stepId));
}
export function validateWorkflowSteps(steps,env={}) {
 const errors=[];
 const cap=limits(env);
 if(!Array.isArray(steps)||!steps.length){errors.push('يجب أن تحتوي الخطوات على خطوة واحدة على الأقل');return errors;}
 if(steps.length>cap.MAX_WORKFLOW_STEPS)errors.push(`عدد الخطوات (${steps.length}) يتجاوز الحد الأقصى ${cap.MAX_WORKFLOW_STEPS}`);
 const ids=new Set();
 for(const step of steps) {
  if(!step.id||typeof step.id!=='string')errors.push('كل خطوة يجب أن يكون لها id نصي');
  else if(ids.has(step.id))errors.push(`معرّف خطوة مكرر: ${step.id}`);
  else ids.add(step.id);
  if(!WORKFLOW_STEP_TYPES.includes(step.type))errors.push(`نوع خطوة غير معروف: ${step.type}`);
  if(step.type==='CONDITION')errors.push(...validateCondition(step.condition,`step[${step.id}].condition`));
  if(step.type==='AGENT' && typeof step.agentId!=='string')errors.push(`step[${step.id}]: agentId مطلوب`);
  if(step.type==='TOOL' && typeof step.toolName!=='string')errors.push(`step[${step.id}]: toolName مطلوب`);
  if(step.type==='DELAY' && !(Number(step.durationMinutes)>0))errors.push(`step[${step.id}]: durationMinutes يجب أن تكون رقمًا موجبًا`);
 }
 for(const step of steps) {
  for(const targetId of [...(step.next||[]),...(step.elseNext||[])])
   if(!ids.has(targetId))errors.push(`step[${step.id}] يشير إلى خطوة غير موجودة: ${targetId}`);
  if(step.type!=='CONDITION' && step.elseNext?.length)errors.push(`step[${step.id}]: elseNext غير مسموح إلا لخطوات CONDITION`);
  const fanOut=(step.next||[]).length;
  if(fanOut>cap.MAX_PARALLEL_WORKFLOW_STEPS)errors.push(`step[${step.id}]: عدد الفروع المتوازية (${fanOut}) يتجاوز الحد الأقصى ${cap.MAX_PARALLEL_WORKFLOW_STEPS}`);
 }
 const roots=steps.filter(s=>predecessorsOf(s.id,steps).length===0);
 if(roots.length!==1)errors.push(`يجب أن تحتوي كل Workflow على نقطة بداية واحدة فقط (وُجد ${roots.length})`);
 // Cycle detection — DFS with a recursion stack; a cycle here would otherwise hang the
 // executor forever waiting on a predecessor that can never complete.
 const stepsById=new Map(steps.map(s=>[s.id,s]));
 const WHITE=0,GRAY=1,BLACK=2;const color=new Map(steps.map(s=>[s.id,WHITE]));
 function dfs(id) {
  color.set(id,GRAY);
  for(const next of [...(stepsById.get(id)?.next||[]),...(stepsById.get(id)?.elseNext||[])]) {
   if(!stepsById.has(next))continue;
   if(color.get(next)===GRAY){errors.push(`تسلسل دائري (Cycle) مكتشف عند الخطوة: ${next}`);return;}
   if(color.get(next)===WHITE)dfs(next);
  }
  color.set(id,BLACK);
 }
 for(const step of steps)if(color.get(step.id)===WHITE)dfs(step.id);
 return errors;
}
export function validateTrigger(trigger) {
 const errors=[];
 if(!trigger||!WORKFLOW_TRIGGER_TYPES.includes(trigger.type)){errors.push('نوع المُشغّل يجب أن يكون MANUAL أو SCHEDULE أو EVENT');return errors;}
 if(trigger.type==='SCHEDULE') {
  if(!['DAILY','WEEKLY'].includes(trigger.schedule?.frequency))errors.push('جدولة Workflow تدعم DAILY أو WEEKLY فقط');
  if(!(Number.isInteger(trigger.schedule?.hour)&&trigger.schedule.hour>=0&&trigger.schedule.hour<24))errors.push('ساعة الجدولة غير صالحة (0-23)');
  if(trigger.schedule?.frequency==='WEEKLY' && !(Number.isInteger(trigger.schedule?.weekday)&&trigger.schedule.weekday>=0&&trigger.schedule.weekday<=6))errors.push('يوم الأسبوع مطلوب لجدولة أسبوعية (0-6)');
 }
 if(trigger.type==='EVENT' && !EVENT_TYPES.includes(trigger.eventType))errors.push(`نوع الحدث غير معروف في سجل الأحداث الحقيقي: ${trigger.eventType}`);
 return errors;
}

// ------------------------------------------------------------------------------------------
// Definition + Version CRUD (spec Part 3, 19)
// ------------------------------------------------------------------------------------------
export function listWorkflows(db,tenantId=null,{status}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const rows=status?db.prepare('SELECT * FROM workflow_definitions WHERE tenant_id=? AND status=? ORDER BY updated_at DESC').all(resolvedTenantId,status)
  :db.prepare('SELECT * FROM workflow_definitions WHERE tenant_id=? AND status!=? ORDER BY updated_at DESC').all(resolvedTenantId,'ARCHIVED');
 return rows.map(hydrateDefinition);
}
export function getWorkflow(db,id,tenantId=null) {
 const row=db.prepare('SELECT * FROM workflow_definitions WHERE id=? AND tenant_id=?').get(id,tenantId||resolveActiveTenantId(db));
 if(!row)fail(404,'Workflow غير موجود');
 return hydrateDefinition(row);
}
export function getWorkflowWithVersion(db,id,tenantId=null) {
 const workflow=getWorkflow(db,id,tenantId);
 const versionId=workflow.draftVersionId||workflow.activeVersionId;
 const version=versionId?hydrateVersion(db.prepare('SELECT * FROM workflow_versions WHERE id=?').get(versionId)):null;
 return {...workflow,version};
}
function insertVersion(db,{workflowId,tenantId,version,trigger,conditions,steps,status,readiness,user}) {
 const id=randomUUID(),now=new Date().toISOString();
 db.prepare(`INSERT INTO workflow_versions (id,workflow_id,tenant_id,version,trigger_json,conditions_json,steps_json,status,readiness_json,created_by,created_by_name,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(id,workflowId,tenantId,version,JSON.stringify(trigger),conditions?JSON.stringify(conditions):null,JSON.stringify(steps),status,
   readiness?JSON.stringify(readiness):null,user?.id||null,user?.name||null,now);
 return id;
}
/** Creates a brand-new workflow in DRAFT (spec item 27 — never auto-published). `source`
 * ('builder'|'frost_chat') and `commandRunId` are for traceability only (spec item 70). */
export function createWorkflowDraft(db,env,tenantId,{nameAr,nameEn,description,trigger,conditions,steps},user,commandRunId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const cleanNameAr=typeof nameAr==='string'?nameAr.trim().slice(0,200):'';
 if(!cleanNameAr)fail(400,'اسم Workflow مطلوب');
 const triggerErrors=validateTrigger(trigger);
 const stepErrors=validateWorkflowSteps(steps,env);
 if(triggerErrors.length||stepErrors.length)fail(400,'Workflow غير صالح: '+[...triggerErrors,...stepErrors].join('؛ '));
 const now=new Date().toISOString();
 const workflowId=randomUUID();
 const versionId=insertVersion(db,{workflowId,tenantId:resolvedTenantId,version:1,trigger,conditions,steps,status:'DRAFT',user});
 db.prepare(`INSERT INTO workflow_definitions (id,tenant_id,name_ar,name_en,description,status,draft_version_id,active_version_id,created_by,created_by_name,created_at,updated_at,command_run_id)
  VALUES (?,?,?,?,?,'DRAFT',?,NULL,?,?,?,?,?)`)
  .run(workflowId,resolvedTenantId,cleanNameAr,(nameEn||'').trim().slice(0,200)||null,(description||'').trim().slice(0,1000)||null,versionId,user?.id||null,user?.name||null,now,now,commandRunId);
 recordAudit(db,{id:randomUUID(),action:'WORKFLOW_CREATED',itemId:workflowId,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getWorkflowWithVersion(db,workflowId,resolvedTenantId);
}
/** Editing (spec item 19): an ACTIVE workflow is immutable — editing creates a NEW DRAFT
 * version (next integer) that sits alongside it until published; a workflow already in DRAFT
 * just has its one draft version replaced in place (no version-number churn for unpublished
 * work). Existing runs keep pointing at whichever version.id they started with — never
 * re-pointed, so no version drift is possible even mid-execution. */
export function updateWorkflowDraft(db,env,workflowId,{nameAr,nameEn,description,trigger,conditions,steps},user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const workflow=getWorkflow(db,workflowId,resolvedTenantId);
 if(workflow.status==='ARCHIVED')fail(400,'لا يمكن تعديل Workflow مؤرشف');
 const triggerErrors=validateTrigger(trigger);
 const stepErrors=validateWorkflowSteps(steps,env);
 if(triggerErrors.length||stepErrors.length)fail(400,'Workflow غير صالح: '+[...triggerErrors,...stepErrors].join('؛ '));
 const now=new Date().toISOString();
 let draftVersionId=workflow.draftVersionId;
 if(workflow.status==='DRAFT' && draftVersionId) {
  db.prepare('UPDATE workflow_versions SET trigger_json=?,conditions_json=?,steps_json=?,readiness_json=NULL WHERE id=?')
   .run(JSON.stringify(trigger),conditions?JSON.stringify(conditions):null,JSON.stringify(steps),draftVersionId);
 } else {
  const maxVersion=db.prepare('SELECT COALESCE(MAX(version),0) v FROM workflow_versions WHERE workflow_id=?').get(workflowId).v;
  draftVersionId=insertVersion(db,{workflowId,tenantId:resolvedTenantId,version:maxVersion+1,trigger,conditions,steps,status:'DRAFT',user});
 }
 db.prepare(`UPDATE workflow_definitions SET name_ar=COALESCE(?,name_ar),name_en=COALESCE(?,name_en),description=COALESCE(?,description),
  draft_version_id=?,updated_at=? WHERE id=?`)
  .run(nameAr?.trim()||null,nameEn?.trim()||null,description?.trim()??null,draftVersionId,now,workflowId);
 recordAudit(db,{id:randomUUID(),action:'WORKFLOW_EDITED',itemId:workflowId,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getWorkflowWithVersion(db,workflowId,resolvedTenantId);
}

// ------------------------------------------------------------------------------------------
// Readiness + Activation (spec Part 66-67)
// ------------------------------------------------------------------------------------------
/** Real readiness — never a stored "looks ready" flag: for every AGENT step, the target
 * agent must be enabled and pass the SAME `evaluateAllToolsReadiness`-derived check used
 * elsewhere; for every TOOL step, the tool must resolve a real, healthy connection (or need
 * none); for every APPROVAL step, nothing extra is required (the Approval Engine always
 * exists). Blocking reasons are exact step ids + real reasons, never generic. */
export function computeWorkflowReadiness(db,env,tenantId,version) {
 const blockers=[];
 for(const step of version.steps) {
  if(step.type==='AGENT') {
   const registryRow=db.prepare('SELECT enabled FROM agent_registry WHERE id=?').get(step.agentId);
   if(!registryRow)blockers.push({stepId:step.id,reason:`الوكيل غير موجود: ${step.agentId}`});
   else if(!registryRow.enabled)blockers.push({stepId:step.id,reason:`الوكيل معطّل: ${step.agentId}`});
  }
  if(step.type==='TOOL') {
   // Workflow TOOL steps always execute AS frost_commander (spec item 65's "exact connection
   // assignment" is per-agent, and this is the one real acting identity a workflow has) — a
   // tool restricted to a different agent via `allowedAgents` (e.g. meta_publish/'publishing'
   // only) is a real, exact blocker here, not just discovered as a surprise FORBIDDEN at run
   // time. Checked directly (not only via evaluateAllToolsReadiness, which SILENTLY excludes
   // an agent-restricted tool from its list rather than reporting it blocked).
   const definition=getToolDefinition(db,step.toolName);
   if(!definition)blockers.push({stepId:step.id,reason:`الأداة غير معروفة: ${step.toolName}`});
   else if(definition.allowedAgents?.length && !definition.allowedAgents.includes('frost_commander'))blockers.push({stepId:step.id,reason:`الأداة ${step.toolName} غير متاحة لهذا النوع من التنفيذ (مقيّدة بوكيل آخر)`});
   else {
    const readiness=evaluateAllToolsReadiness(db,env,{tenantId,agentId:'frost_commander'}).find(r=>r.toolSlug===step.toolName);
    if(readiness && readiness.status!=='READY')blockers.push({stepId:step.id,reason:`الأداة غير جاهزة: ${step.toolName} (${readiness.status})`});
   }
  }
 }
 return {ready:blockers.length===0,blockers,computedAt:new Date().toISOString()};
}
export function activateWorkflow(db,env,workflowId,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const workflow=getWorkflowWithVersion(db,workflowId,resolvedTenantId);
 if(!workflow.version||workflow.version.status==='PUBLISHED')fail(400,'لا يوجد إصدار مسودة جاهز للتفعيل');
 const readiness=computeWorkflowReadiness(db,env,resolvedTenantId,workflow.version);
 if(!readiness.ready)fail(409,'Workflow غير جاهز للتفعيل: '+readiness.blockers.map(b=>b.reason).join('؛ '));
 const activeCount=db.prepare("SELECT COUNT(*) n FROM workflow_definitions WHERE tenant_id=? AND status='ACTIVE'").get(resolvedTenantId).n;
 const cap=limits(env);
 if(activeCount>=cap.MAX_ACTIVE_WORKFLOWS_PER_TENANT)fail(409,`تجاوزت الحد الأقصى لعدد الـWorkflows النشطة (${cap.MAX_ACTIVE_WORKFLOWS_PER_TENANT})`);
 const now=new Date().toISOString();
 db.prepare('UPDATE workflow_versions SET status=?,readiness_json=? WHERE id=?').run('PUBLISHED',JSON.stringify(readiness),workflow.version.id);
 db.prepare('UPDATE workflow_definitions SET status=?,active_version_id=?,draft_version_id=NULL,updated_at=? WHERE id=?').run('ACTIVE',workflow.version.id,now,workflowId);
 recordAudit(db,{id:randomUUID(),action:'WORKFLOW_ACTIVATED',itemId:workflowId,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getWorkflowWithVersion(db,workflowId,resolvedTenantId);
}
function setWorkflowStatus(db,workflowId,status,user,tenantId,auditAction) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 getWorkflow(db,workflowId,resolvedTenantId);
 const now=new Date().toISOString();
 db.prepare('UPDATE workflow_definitions SET status=?,updated_at=? WHERE id=? AND tenant_id=?').run(status,now,workflowId,resolvedTenantId);
 recordAudit(db,{id:randomUUID(),action:auditAction,itemId:workflowId,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getWorkflow(db,workflowId,resolvedTenantId);
}
export const pauseWorkflow=(db,id,user,tenantId)=>setWorkflowStatus(db,id,'PAUSED',user,tenantId,'WORKFLOW_PAUSED');
export const resumeWorkflow=(db,id,user,tenantId)=>setWorkflowStatus(db,id,'ACTIVE',user,tenantId,'WORKFLOW_RESUMED');
export const archiveWorkflow=(db,id,user,tenantId)=>setWorkflowStatus(db,id,'ARCHIVED',user,tenantId,'WORKFLOW_ARCHIVED');

// ------------------------------------------------------------------------------------------
// Execution engine (spec Part 17-25) — one synchronous "advance" pass, called at run-creation
// and again at every resume (delay elapsed / approval decided). AND-join with skip
// propagation: a step becomes SKIPPED only if EVERY predecessor was SKIPPED; it runs once AT
// LEast one predecessor is COMPLETED and none are still pending.
// ------------------------------------------------------------------------------------------
function insertStepRun(db,{tenantId,workflowRunId,stepId,stepType,status='PENDING'}) {
 const id=randomUUID();
 db.prepare('INSERT INTO workflow_step_runs (id,tenant_id,workflow_run_id,step_id,step_type,status) VALUES (?,?,?,?,?,?)')
  .run(id,tenantId,workflowRunId,stepId,stepType,status);
 return id;
}
function updateStepRun(db,id,patch) {
 const sets=[],values=[];
 for(const [key,column] of [['status','status'],['input','input_json'],['output','output_json'],['error','error'],['approvalId','approval_id'],['agentRunId','agent_run_id'],['startedAt','started_at'],['finishedAt','finished_at']]) {
  if(key in patch){sets.push(`${column}=?`);values.push(key==='input'||key==='output'?(patch[key]==null?null:JSON.stringify(patch[key])):patch[key]);}
 }
 if(!sets.length)return;
 values.push(id);
 db.prepare(`UPDATE workflow_step_runs SET ${sets.join(',')} WHERE id=?`).run(...values);
}
function listStepRuns(db,workflowRunId) {
 return db.prepare('SELECT * FROM workflow_step_runs WHERE workflow_run_id=? ORDER BY rowid').all(workflowRunId).map(hydrateStepRun);
}
function updateRun(db,id,patch) {
 const sets=[],values=[];
 for(const [key,column] of [['status','status'],['context','context_json'],['error','error'],['finishedAt','finished_at'],['nextResumeAt','next_resume_at'],['cancelRequested','cancel_requested']]) {
  if(key in patch){sets.push(`${column}=?`);values.push(key==='context'?JSON.stringify(patch[key]):key==='cancelRequested'?(patch[key]?1:0):patch[key]);}
 }
 if(!sets.length)return;
 values.push(id);
 db.prepare(`UPDATE workflow_runs SET ${sets.join(',')} WHERE id=?`).run(...values);
}
export function getRunWithSteps(db,runId,tenantId=null) {
 const row=db.prepare('SELECT * FROM workflow_runs WHERE id=? AND tenant_id=?').get(runId,tenantId||resolveActiveTenantId(db));
 if(!row)fail(404,'تشغيلة Workflow غير موجودة');
 return {...hydrateRun(row),steps:listStepRuns(db,runId)};
}
export function listWorkflowRuns(db,tenantId=null,{workflowId,limit=50}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const rows=workflowId?db.prepare('SELECT * FROM workflow_runs WHERE tenant_id=? AND workflow_id=? ORDER BY started_at DESC LIMIT ?').all(resolvedTenantId,workflowId,limit)
  :db.prepare('SELECT * FROM workflow_runs WHERE tenant_id=? ORDER BY started_at DESC LIMIT ?').all(resolvedTenantId,limit);
 return rows.map(hydrateRun);
}
function classify(status) {return ['COMPLETED','SKIPPED','FAILED','CANCELLED'].includes(status);}
/** The effective status of predecessor `p` FOR THIS SPECIFIC EDGE into `step` — a plain
 * COMPLETED is not enough for a CONDITION predecessor: the edge taken (next=true-branch vs
 * elseNext=false-branch) must match the condition's own stored result, or this edge counts as
 * SKIPPED even though the CONDITION step itself is COMPLETED (spec Part 13 — IF/ELSE). */
function effectivePredecessorStatus(pred,stepId,stepRunByStepId) {
 const predRun=stepRunByStepId.get(pred.id);
 const status=predRun?.status||'PENDING';
 if(pred.type!=='CONDITION'||status!=='COMPLETED')return status;
 const result=!!predRun.output?.result;
 const isTrueEdge=(pred.next||[]).includes(stepId);
 const isFalseEdge=(pred.elseNext||[]).includes(stepId);
 if(isTrueEdge && !result)return 'SKIPPED';
 if(isFalseEdge && result)return 'SKIPPED';
 return 'COMPLETED';
}
function stepReadiness(step,steps,stepRunByStepId) {
 const preds=predecessorsOf(step.id,steps);
 if(!preds.length)return 'READY';
 const statuses=preds.map(p=>effectivePredecessorStatus(p,step.id,stepRunByStepId));
 if(statuses.some(s=>!classify(s)))return 'WAITING';
 if(statuses.every(s=>s==='SKIPPED'||s==='CANCELLED'))return 'SKIP';
 return 'READY';
}
/** Extracts a summary/evidence from an agent run's decision envelope — the SAME shared shape
 * every agent decision already carries (RUNTIME CONTRACT ADAPTER in agents.js), matching
 * exactly what tools.js's delegate_to_agent already does for the same reason. */
function summarizeAgentRun(run) {
 return {status:run.status,summary:run.output?.rationale||null,payload:run.output?.payload||null,runId:run.id,
  errors:run.status==='FAILED'?[run.error||'UNKNOWN_ERROR']:[]};
}
function renderTemplate(template,context) {
 if(typeof template!=='string')return template;
 return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g,(match,path)=>{
  const value=path.split('.').reduce((node,key)=>(node==null?undefined:node[key]),context);
  return value===undefined?match:String(value);
 });
}
/** TOOL steps (spec Part 12): a second, thin CALL SITE for the exact same handler/connection-
 * resolution/approval-gate every agent's own executeTool already uses — precedent already
 * exists in this codebase for exactly this shape (see runtime.js's own `resumeToolApproval`,
 * which independently resolves a connection and calls `tool.handler` directly). This is NOT a
 * second Tool Registry: the registry (tools.js's TOOL_METADATA/HANDLERS) stays the one source
 * of truth; only the CALL to it is duplicated, exactly as resumeToolApproval already does. */
async function executeWorkflowToolStep({store,env,fetcher,toolRegistry,toolName,input,tenantId,stepRunId}) {
 const db=store.db;
 const tool=toolRegistry.get(toolName);
 if(!tool)return {status:'ERROR',error:'UNKNOWN_TOOL'};
 const tenant=getTenant(db,tenantId);
 const level=effectiveLevel(levelOf(db,'frost_commander',tenantId),env,tenant?.maxAgentLevel||null);
 if(!canUseTool(level,tool,'frost_commander'))return {status:'FORBIDDEN',reason:'PERMISSION_LEVEL',required:tool.minLevel,current:level};
 const resolution=resolveToolConnection(db,{tenantId,agentId:'frost_commander',toolSlug:toolName});
 if(resolution.blocked)return {status:resolution.reason==='CONNECTION_UNHEALTHY'?'CONNECTION_UNHEALTHY':'CONNECTION_REQUIRED',reason:resolution.reason};
 const connectionId=resolution.connectionId||null;
 if(connectionId) {
  const connection=getConnectionOrNull(db,connectionId,tenantId);
  if(!connection||['DISCONNECTED','ERROR','TOKEN_EXPIRED'].includes(connection.status))return {status:'CONNECTION_NO_LONGER_AVAILABLE',connectionId};
 }
 if(tool.requiresApprovalBelowLevel) {
  // Workflow write actions never bypass the same approval gate a live agent run would hit
  // (spec item 75) — a real agent_tool_send approval is created; the workflow step itself
  // pauses (see the caller, which sets WAITING_APPROVAL) until it is decided.
  const approval=createApproval(db,{runId:stepRunId,agentId:'frost_commander',actionType:'agent_tool_send',
   proposedOutput:{toolName,input},riskLevel:tool.riskLevel||'MEDIUM',reason:`Workflow step requires human approval before executing ${toolName}.`,
   tenantId,toolSlug:toolName,assignmentId:resolution.assignmentId||null,connectionId});
  return {status:'WAITING_APPROVAL',approvalId:approval.id};
 }
 try {
  const actor={id:'workflow:'+toolName,name:'خطوة Workflow',role:'automation'};
  const output=await tool.handler(input,{store,env,actor,runId:stepRunId,agentId:'frost_commander',tenantId,connectionId,assignmentId:resolution.assignmentId||null});
  return {status:output?.status==='INTEGRATION_REQUIRED'?'INTEGRATION_REQUIRED':'OK',...((typeof output==='object'&&output)||{})};
 } catch(error) {return {status:'ERROR',error:error.message};}
}

/** The one real executor. Called synchronously at creation and at every resume — never keeps
 * the process sleeping (spec item 14): a DELAY step returns immediately after persisting
 * next_resume_at, an APPROVAL step returns immediately after creating a real approval. */
export async function advanceWorkflowRun(deps,runId) {
 const {store,env,fetcher,agentRuntime,toolRegistry}=deps;
 const db=store.db;
 const runRow=db.prepare('SELECT tenant_id,workflow_id,workflow_version_id FROM workflow_runs WHERE id=?').get(runId);
 if(!runRow)fail(404,'تشغيلة Workflow غير موجودة');
 const tenantId=runRow.tenant_id;
 let run=getRunWithSteps(db,runId,tenantId);
 if(['COMPLETED','FAILED','CANCELLED'].includes(run.status))return run;
 // A resume (delay elapsed / approval decided) starts from a STALE 'WAITING'/'WAITING_APPROVAL'
 // status left over from the PREVIOUS pause — reset to RUNNING now so the end-of-function
 // "did everything finish" check below isn't fooled into thinking the run is still paused
 // when it just successfully advanced all the way to completion in this very call.
 updateRun(db,runId,{status:'RUNNING'});
 const version=hydrateVersion(db.prepare('SELECT * FROM workflow_versions WHERE id=?').get(runRow.workflow_version_id));
 const steps=version.steps;
 let stepRuns=run.steps;
 for(const step of steps)if(!stepRuns.find(sr=>sr.stepId===step.id))insertStepRun(db,{tenantId,workflowRunId:runId,stepId:step.id,stepType:step.type});
 stepRuns=listStepRuns(db,runId);
 const context={...run.context};
 let advanced=true;
 while(advanced) {
  advanced=false;
  // Cancellation checkpoint (spec item 22-23): checked at the TOP of every loop iteration,
  // i.e. before any NEW step starts — a step already RUNNING/WAITING is left to finish
  // naturally (never force-killed), matching "no fake hard cancellation".
  const runNow=db.prepare('SELECT cancel_requested FROM workflow_runs WHERE id=?').get(runId);
  if(runNow.cancel_requested) {
   for(const sr of stepRuns)if(sr.status==='PENDING')updateStepRun(db,sr.id,{status:'CANCELLED'});
   updateRun(db,runId,{status:'CANCELLED',finishedAt:new Date().toISOString()});
   recordAudit(db,{id:randomUUID(),action:'WORKFLOW_RUN_CANCELLED',itemId:runId,at:new Date().toISOString()},tenantId);
   return getRunWithSteps(db,runId,tenantId);
  }
  const stepRunByStepId=new Map(stepRuns.map(sr=>[sr.stepId,sr]));
  const ready=steps.filter(s=>stepRunByStepId.get(s.id)?.status==='PENDING' && stepReadiness(s,steps,stepRunByStepId)==='READY');
  const toSkip=steps.filter(s=>stepRunByStepId.get(s.id)?.status==='PENDING' && stepReadiness(s,steps,stepRunByStepId)==='SKIP');
  for(const s of toSkip){updateStepRun(db,stepRunByStepId.get(s.id).id,{status:'SKIPPED'});advanced=true;}
  if(!ready.length){
   if(!advanced)break;
   stepRuns=listStepRuns(db,runId);
   continue;
  }
  // Same READ/ANALYSIS-only parallel rule as the LLM tool-batch (spec item 18/83): AGENT/TOOL
  // steps whose target is a real write run one at a time; independent read-only steps run
  // concurrently for a real wall-clock benefit.
  const isSafeParallel=s=>s.type==='CONDITION'||s.type==='AGENT'; // AGENT steps are objectives, not raw external writes — the target agent's OWN tool gates still apply per-call
  const batch=ready.every(isSafeParallel)?ready:ready.slice(0,1);
  await Promise.all(batch.map(async step=>{
   const stepRun=stepRunByStepId.get(step.id);
   updateStepRun(db,stepRun.id,{status:'RUNNING',startedAt:new Date().toISOString()});
   await executeStep({store,env,fetcher,agentRuntime,toolRegistry,step,stepRun,context,tenantId,runId});
  }));
  advanced=true;
  stepRuns=listStepRuns(db,runId);
  // A step that just paused the whole run (DELAY/APPROVAL) stops the loop here.
  const runAfter=db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(runId);
  if(['WAITING','WAITING_APPROVAL','FAILED'].includes(runAfter.status))break;
 }
 stepRuns=listStepRuns(db,runId);
 const runAfter=db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(runId);
 if(!['WAITING','WAITING_APPROVAL','CANCELLED','FAILED'].includes(runAfter.status)) {
  const allDone=steps.every(s=>classify(stepRunByStepIdFinal(stepRuns,s.id)));
  if(allDone) {
   const anyFailed=stepRuns.some(sr=>sr.status==='FAILED');
   updateRun(db,runId,{status:anyFailed?'FAILED':'COMPLETED',finishedAt:new Date().toISOString()});
   recordAudit(db,{id:randomUUID(),action:anyFailed?'WORKFLOW_RUN_FAILED':'WORKFLOW_RUN_COMPLETED',itemId:runId,at:new Date().toISOString()},tenantId);
  }
 }
 return getRunWithSteps(db,runId,tenantId);
}
function stepRunByStepIdFinal(stepRuns,stepId) {return stepRuns.find(sr=>sr.stepId===stepId)?.status||'PENDING';}

async function executeStep({store,env,fetcher,agentRuntime,toolRegistry,step,stepRun,context,tenantId,runId}) {
 const db=store.db;
 const finish=(status,patch={})=>updateStepRun(db,stepRun.id,{status,finishedAt:new Date().toISOString(),...patch});
 try {
  if(step.type==='CONDITION') {
   const result=evaluateCondition(step.condition,context);
   finish('COMPLETED',{output:{result}});
   return;
  }
  if(step.type==='DELAY') {
   const resumeAt=new Date(Date.now()+Number(step.durationMinutes)*60000).toISOString();
   updateStepRun(db,stepRun.id,{status:'WAITING',output:{resumeAt}});
   updateRun(db,runId,{status:'WAITING',nextResumeAt:resumeAt});
   return;
  }
  if(step.type==='AGENT') {
   if(!agentRuntime)return finish('FAILED',{error:'RUNTIME_NOT_READY'});
   const objective=renderTemplate(step.objective||'',context);
   // Phase MKT-2, Part B — an OPTIONAL, template-rendered static input object, exactly
   // mirroring the TOOL step type's existing `step.input`/renderTemplate pattern (never a new
   // capability, just applying the one that already exists to AGENT steps too). Every existing
   // workflow that doesn't set `step.input` is completely unaffected — it still gets exactly
   // the same generic {scenario, current_datetime, timezone} input as before. This lets a real
   // campaign-orchestration workflow give each agent step real campaign fields (via
   // `{{trigger.name}}` etc., since `context.trigger` is the real triggerContext the run
   // started with) instead of only a human-readable one-line objective string.
   const templatedInput=step.input&&typeof step.input==='object'
    ?Object.fromEntries(Object.entries(step.input).map(([k,v])=>[k,renderTemplate(v,context)]))
    :{};
   const run=await agentRuntime.run(step.agentId,{triggerType:'WORKFLOW',parentRunId:null,
    input:{scenario:`خطوة ضمن Workflow: ${objective}`,current_datetime:new Date().toISOString(),timezone:'Asia/Riyadh',...templatedInput},
    user:WORKFLOW_ACTOR,tenantId});
   const summary=summarizeAgentRun(run);
   const patch={agentRunId:run.id,output:summary};
   if(run.status==='COMPLETED')finish('COMPLETED',patch);
   else if(run.status==='WAITING_APPROVAL')updateStepRun(db,stepRun.id,{status:'WAITING_APPROVAL',...patch});
   else finish('FAILED',{...patch,error:run.error||'AGENT_RUN_FAILED'});
   return;
  }
  if(step.type==='TOOL') {
   const input=Object.fromEntries(Object.entries(step.input||{}).map(([k,v])=>[k,renderTemplate(v,context)]));
   const output=await executeWorkflowToolStep({store,env,fetcher,toolRegistry,toolName:step.toolName,input,tenantId,stepRunId:stepRun.id});
   if(output.status==='WAITING_APPROVAL') {
    updateStepRun(db,stepRun.id,{status:'WAITING_APPROVAL',approvalId:output.approvalId,output});
    updateRun(db,runId,{status:'WAITING_APPROVAL'});
   } else if(output.status==='OK') finish('COMPLETED',{output});
   else finish('FAILED',{output,error:output.error||output.status});
   return;
  }
  if(step.type==='APPROVAL') {
   const approval=createApproval(db,{runId:stepRun.id,agentId:'frost_commander',actionType:'workflow_step_approval',
    proposedOutput:{workflowRunId:runId,stepId:step.id},riskLevel:step.riskLevel||'MEDIUM',reason:step.reason||'Workflow step requires human approval.',tenantId});
   updateStepRun(db,stepRun.id,{status:'WAITING_APPROVAL',approvalId:approval.id});
   updateRun(db,runId,{status:'WAITING_APPROVAL'});
   return;
  }
  if(step.type==='CREATE_TASK'||step.type==='NOTIFY_INTERNAL') {
   // NOTIFY_INTERNAL note (spec item 16, honesty): no push/email-to-staff channel exists in
   // this codebase yet, so "notify" creates a real, visible LOW-priority Task instead of a
   // silent no-op or a fabricated notification — reuses the exact same Tasks/Escalations
   // service as CREATE_TASK, just with a distinguishing priority/reason.
   const escalation=createEscalation(db,{runId:stepRun.id,agentId:'frost_commander',
    priority:step.type==='NOTIFY_INTERNAL'?'P4':(step.priority||'P2'),
    reason:renderTemplate(step.reason||'إجراء من Workflow',context),context:{workflowRunId:runId,stepId:step.id},tenantId});
   finish('COMPLETED',{output:{escalationId:escalation.id}});
   return;
  }
  finish('FAILED',{error:'UNKNOWN_STEP_TYPE'});
 } catch(error) {
  finish('FAILED',{error:error.message});
 }
}

/** Starts a real run. `causationDepth` (spec item 79-80): 0 for MANUAL/SCHEDULE; for EVENT
 * triggers, the caller passes the triggering event's own depth+1 — refused outright once it
 * would exceed MAX_AUTOMATION_DEPTH, recorded honestly rather than silently dropped. */
export async function startWorkflowRun(deps,workflowId,{triggerType,triggerContext={},causationDepth=0,tenantId=null,commandRunId=null,now=Date.now()}) {
 const {store,env}=deps;
 const db=store.db;
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const workflow=getWorkflow(db,workflowId,resolvedTenantId);
 if(workflow.status!=='ACTIVE')fail(409,'Workflow ليس نشطًا حاليًا');
 const tenant=getTenant(db,resolvedTenantId);
 const blockReason=tenantOperationalBlockReason(tenant);
 if(blockReason)fail(409,'المنشأة غير نشطة حاليًا: '+blockReason);
 // Optional hook from the host application (the merchant portal): a workspace whose account is not operational starts no run at all.
 const startGateReason=deps.startGate?.(resolvedTenantId);
 if(startGateReason)fail(409,'حساب المنشأة لا يسمح بتشغيل Workflow حاليًا: '+startGateReason);
 const cap=limits(env);
 if(causationDepth>cap.MAX_AUTOMATION_DEPTH) {
  recordAudit(db,{id:randomUUID(),action:'WORKFLOW_LOOP_PROTECTION_TRIGGERED',itemId:workflowId,detail:{causationDepth},at:new Date().toISOString()},resolvedTenantId);
  fail(409,'تم رفض تشغيل Workflow لتفادي حلقة تلقائية لا نهائية (تجاوز الحد الأقصى لعمق الأتمتة)');
 }
 const id=randomUUID(),startedAtIso=new Date(now).toISOString();
 db.prepare(`INSERT INTO workflow_runs (id,tenant_id,workflow_id,workflow_version_id,trigger_type,trigger_context_json,status,context_json,causation_depth,started_at)
  VALUES (?,?,?,?,?,?,'RUNNING',?,?,?)`)
  .run(id,resolvedTenantId,workflowId,workflow.activeVersionId,triggerType,JSON.stringify(triggerContext),JSON.stringify({trigger:triggerContext}),causationDepth,startedAtIso);
 recordAudit(db,{id:randomUUID(),action:'WORKFLOW_RUN_STARTED',itemId:id,detail:{workflowId,triggerType},at:startedAtIso},resolvedTenantId);
 return advanceWorkflowRun(deps,id);
}
export function requestCancelWorkflowRun(db,runId,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const run=getRunWithSteps(db,runId,resolvedTenantId);
 if(['COMPLETED','FAILED','CANCELLED'].includes(run.status))fail(409,'التشغيلة انتهت بالفعل — لا يمكن إيقافها');
 const wasWaiting=run.status==='WAITING';
 db.prepare("UPDATE workflow_runs SET cancel_requested=1,status=CASE WHEN status='WAITING' THEN 'CANCELLED' ELSE 'CANCEL_REQUESTED' END,finished_at=CASE WHEN status='WAITING' THEN ? ELSE finished_at END WHERE id=?")
  .run(new Date().toISOString(),runId);
 // A safe WAITING (delay) run cancels immediately and completely (spec item 23) — nothing
 // external was ever in flight for it, so every remaining PENDING/WAITING step is CANCELLED
 // right now, not left for a resume that will never come (the run is already terminal). A
 // run that was actively RUNNING is left alone; the NEXT advance() call's own cancellation
 // checkpoint is what turns the request into a real CANCELLED state for it instead.
 if(wasWaiting)for(const sr of run.steps)if(['WAITING','PENDING'].includes(sr.status))updateStepRun(db,sr.id,{status:'CANCELLED',finishedAt:new Date().toISOString()});
 recordAudit(db,{id:randomUUID(),action:'WORKFLOW_CANCEL_REQUESTED',itemId:runId,actorId:user?.id||null,actorName:user?.name||null,at:new Date().toISOString()},resolvedTenantId);
 return getRunWithSteps(db,runId,resolvedTenantId);
}
/** The approval-decide resume path (spec Part 15) — called from the SAME
 * `/api/approvals/:id/decide` route as every other approval type, for `action_type` values
 * `workflow_step_approval` (a dedicated APPROVAL step) and `agent_tool_send` when its
 * `runId` happens to be a workflow_step_runs id (a TOOL step's own write action needing
 * approval) — both resolve back to one real workflow_run to resume. */
export async function resumeWorkflowApproval(deps,decidedApproval) {
 const db=deps.store.db;
 const proposed=typeof decidedApproval.proposed_output==='string'?JSON.parse(decidedApproval.proposed_output):decidedApproval.proposed_output;
 const stepRun=db.prepare('SELECT * FROM workflow_step_runs WHERE id=? OR approval_id=?').get(decidedApproval.run_id,decidedApproval.id);
 if(!stepRun)return {status:'ERROR',error:'WORKFLOW_STEP_NOT_FOUND'};
 const approved=decidedApproval.status==='APPROVED';
 if(decidedApproval.action_type==='agent_tool_send' && approved) {
  // Reuse the exact resume-tool-approval execution the agent runtime already provides — a
  // TOOL step's approval decision performs the real write through the SAME handler call.
  const output=await deps.agentRuntime.resumeToolApproval(decidedApproval);
  updateStepRun(db,stepRun.id,{status:output?.status==='ERROR'?'FAILED':'COMPLETED',output,finishedAt:new Date().toISOString(),error:output?.status==='ERROR'?output.error:null});
 } else {
  updateStepRun(db,stepRun.id,{status:approved?'COMPLETED':'FAILED',finishedAt:new Date().toISOString(),
   output:{approved},error:approved?null:'APPROVAL_REJECTED'});
 }
 // If rejected, the whole run fails honestly here (no configured reject-branch concept in v1
 // — spec item 15 allows either "follow configured branch or stop"; v1 always stops, which is
 // the safe default and is documented as such rather than silently guessing a branch).
 if(!approved) {
  updateRun(db,stepRun.workflow_run_id,{status:'FAILED',error:'APPROVAL_REJECTED',finishedAt:new Date().toISOString()});
  return getRunWithSteps(db,stepRun.workflow_run_id,stepRun.tenant_id);
 }
 return advanceWorkflowRun(deps,stepRun.workflow_run_id);
}

// ------------------------------------------------------------------------------------------
// Scheduler + Event Bus integration (spec Part 61-62) — no new timer loop, no new event
// system: this hooks into the EXISTING scheduler.js tick (one more per-tenant job, exactly
// like FOLLOWUP_SWEEP) and the EXISTING createEventBus's `.on()`.
// ------------------------------------------------------------------------------------------
function scheduleDue(trigger,now) {
 const parts=new Date(now);
 const hour=parts.getUTCHours()+3; // Asia/Riyadh, matches scheduler.js's own riyadhParts()
 const riyadhHour=hour>=24?hour-24:hour;
 if(trigger.schedule.hour!==riyadhHour)return false;
 if(trigger.schedule.frequency==='WEEKLY' && trigger.schedule.weekday!==parts.getUTCDay())return false;
 return true;
}
/** One tick of the workflow scheduler — resumes any due DELAY and fires any due SCHEDULE
 * trigger, for one tenant. Never fires the SAME schedule twice in one calendar
 * day/ISO-week — checked against real workflow_runs history, not a separate "last fired"
 * column (same "derive, don't cache" ethic as context freshness in Phase 7B). */
export async function tickWorkflowsForTenant(deps,tenantId,now=Date.now()) {
 const db=deps.store.db;
 const resumed=[];
 const dueDelays=db.prepare("SELECT id FROM workflow_runs WHERE tenant_id=? AND status='WAITING' AND next_resume_at<=?").all(tenantId,new Date(now).toISOString());
 for(const row of dueDelays) {
  const stepRun=db.prepare("SELECT id FROM workflow_step_runs WHERE workflow_run_id=? AND status='WAITING' LIMIT 1").get(row.id);
  if(stepRun)updateStepRun(db,stepRun.id,{status:'COMPLETED',finishedAt:new Date(now).toISOString()});
  resumed.push(await advanceWorkflowRun(deps,row.id));
 }
 const started=[];
 if(deps.startGate?.(tenantId))return {resumed:resumed.length,started:0};
 const active=db.prepare("SELECT wd.id,wv.trigger_json FROM workflow_definitions wd JOIN workflow_versions wv ON wv.id=wd.active_version_id WHERE wd.tenant_id=? AND wd.status='ACTIVE'").all(tenantId);
 for(const row of active) {
  const trigger=JSON.parse(row.trigger_json);
  if(trigger.type!=='SCHEDULE'||!scheduleDue(trigger,now))continue;
  const periodExpr=trigger.schedule.frequency==='WEEKLY'?"strftime('%Y-%W',started_at)=strftime('%Y-%W',?)":"date(started_at)=date(?)";
  const already=db.prepare(`SELECT 1 FROM workflow_runs WHERE workflow_id=? AND trigger_type='SCHEDULE' AND ${periodExpr} LIMIT 1`).get(row.id,new Date(now).toISOString());
  if(already)continue;
  started.push(await startWorkflowRun(deps,row.id,{triggerType:'SCHEDULE',triggerContext:{firedAt:new Date(now).toISOString()},tenantId,now}));
 }
 return {resumed:resumed.length,started:started.length};
}
/** Installed once at boot (mirrors installOrchestrator's own shape) — subscribes to every
 * real event type in the canonical registry; each handler is a cheap, tenant-scoped query for
 * "does an ACTIVE workflow of THIS tenant listen for THIS event type", so adding a new
 * EVENT-triggered workflow later never needs a new subscription wired here. */
export function installWorkflowEventTriggers(eventBus,deps) {
 const db=deps.store.db;
 for(const eventType of EVENT_TYPES) {
  eventBus.on(eventType,async payload=>{
   const tenantId=payload.tenantId;
   if(!tenantId)return;
   const candidates=db.prepare("SELECT wd.id,wv.trigger_json FROM workflow_definitions wd JOIN workflow_versions wv ON wv.id=wd.active_version_id WHERE wd.tenant_id=? AND wd.status='ACTIVE'").all(tenantId);
   for(const row of candidates) {
    const trigger=JSON.parse(row.trigger_json);
    if(trigger.type==='EVENT' && trigger.eventType===eventType) {
     const depth=(payload.__workflowDepth||0)+1;
     try{await startWorkflowRun(deps,row.id,{triggerType:'EVENT',triggerContext:payload,causationDepth:depth,tenantId});}
     catch(error){recordAudit(db,{id:randomUUID(),action:'WORKFLOW_EVENT_TRIGGER_FAILED',itemId:row.id,errorCode:error.message,at:new Date().toISOString()},tenantId);}
    }
   }
  });
 }
}
export {limits as workflowLimits};

/** Command Center Workflow widget (spec Part 36) — real counts only, no new aggregation
 * beyond a few direct COUNT queries over the tables this module already owns. */
export function summarizeWorkflowsForCommandCenter(db,tenantId) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const active=db.prepare("SELECT COUNT(*) n FROM workflow_definitions WHERE tenant_id=? AND status='ACTIVE'").get(resolvedTenantId).n;
 const running=db.prepare("SELECT COUNT(*) n FROM workflow_runs WHERE tenant_id=? AND status IN ('PENDING','RUNNING','WAITING')").get(resolvedTenantId).n;
 const waitingApproval=db.prepare("SELECT COUNT(*) n FROM workflow_runs WHERE tenant_id=? AND status='WAITING_APPROVAL'").get(resolvedTenantId).n;
 const failedRecent=db.prepare("SELECT COUNT(*) n FROM workflow_runs WHERE tenant_id=? AND status='FAILED' AND started_at>=?").get(resolvedTenantId,new Date(Date.now()-7*86400000).toISOString()).n;
 const scheduledToday=db.prepare(`SELECT wd.id,wv.trigger_json FROM workflow_definitions wd JOIN workflow_versions wv ON wv.id=wd.active_version_id WHERE wd.tenant_id=? AND wd.status='ACTIVE'`).all(resolvedTenantId)
  .filter(row=>JSON.parse(row.trigger_json).type==='SCHEDULE').length;
 return {active,running,waitingApproval,failedRecent,scheduledToday};
}
