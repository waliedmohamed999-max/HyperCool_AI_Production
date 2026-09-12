// Universal Integration Platform (Phase 6H, Part 6-9) — Bulk Connection Version Migration.
// Reuses the EXACT same single-connection safe-migration pipeline (`migrateConnectionVersion`,
// src/connectors/dynamic/connection-versions.js — capability-compatibility gate + a real health
// check against the candidate version before anything is written) for every connection in the
// batch — never a blind, unvalidated bulk UPDATE. Every bulk operation (migration or, later,
// webhook reprocess) is persisted to `bulk_operations` so its exact results are auditable and a
// migration batch can be safely rolled back later (Part 9 — "only for connections previously
// migrated in THAT operation").
import {randomUUID} from 'node:crypto';
import {getIntegrationDefinition} from '../../integrations/definitions.js';
import {getVersionSnapshot} from './store.js';
import {migrateConnectionVersion} from './connection-versions.js';
import {findAssignmentsUsingConnection} from '../../runtime/tool-assignments.js';
import {getToolDefinition} from '../../runtime/tool-definitions.js';
import {reprocessFailedWebhookEvent} from '../generic-webhook/operations.js';

function fail(status,code,message){const e=new Error(message||code);e.status=status;e.code=code;throw e;}
function requirePlatformAdmin(env,user) {
 const allowlist=(env.PLATFORM_ADMIN_USERNAMES||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
 if(!user?.username||!allowlist.includes(user.username.toLowerCase()))fail(403,'PLATFORM_ADMIN_REQUIRED','هذا الإجراء متاح فقط لمسؤول المنصة');
}

export function installBulkOperations(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS bulk_operations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  actor_id TEXT,
  created_at TEXT NOT NULL,
  params TEXT NOT NULL,
  results TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_bulk_operations_type ON bulk_operations(type);`);
}
function recordBulkOperation(db,{type,actorId,params,results}) {
 const id=randomUUID();
 db.prepare('INSERT INTO bulk_operations (id,type,actor_id,created_at,params,results) VALUES (?,?,?,?,?,?)')
  .run(id,type,actorId||null,new Date().toISOString(),JSON.stringify(params),JSON.stringify(results));
 return id;
}
export function getBulkOperation(db,env,actorUser,operationId) {
 requirePlatformAdmin(env,actorUser);
 const row=db.prepare('SELECT * FROM bulk_operations WHERE id=?').get(operationId);
 if(!row)fail(404,'OPERATION_NOT_FOUND','لا توجد عملية جماعية بهذا المعرّف');
 return {id:row.id,type:row.type,actorId:row.actor_id,createdAt:row.created_at,params:JSON.parse(row.params),results:JSON.parse(row.results)};
}
export function listBulkOperations(db,env,actorUser,{type,limit=20}={}) {
 requirePlatformAdmin(env,actorUser);
 const rows=type
  ?db.prepare('SELECT * FROM bulk_operations WHERE type=? ORDER BY created_at DESC LIMIT ?').all(type,limit)
  :db.prepare('SELECT * FROM bulk_operations ORDER BY created_at DESC LIMIT ?').all(limit);
 return rows.map(row=>({id:row.id,type:row.type,actorId:row.actor_id,createdAt:row.created_at,params:JSON.parse(row.params),results:JSON.parse(row.results)}));
}

const MAX_BULK_MIGRATION_BATCH=200;

function capabilityImpactFor(db,tenantId,connectionId,targetManifest) {
 const impacted=[];
 for(const assignment of findAssignmentsUsingConnection(db,tenantId,connectionId)) {
  const tool=getToolDefinition(db,assignment.toolSlug);
  if(tool?.capability && !targetManifest.capabilities.includes(tool.capability))impacted.push(assignment.toolSlug);
 }
 return impacted;
}

/** Part 6 — a real, live, read-only preview: exactly which connections would be attempted, how
 * many distinct tenants, and (cheaply, without any network call) which ones already show a
 * capability regression against the target version — real health checks only ever run at
 * EXECUTION time (Part 7), never during preview, so browsing a preview never has a network
 * side effect. */
export function previewBulkVersionMigration(db,env,actorUser,{connectorSlug,fromVersion,toVersion}) {
 requirePlatformAdmin(env,actorUser);
 const definition=getIntegrationDefinition(db,connectorSlug);
 if(!definition||definition.adapterType!=='GENERIC_REST')fail(400,'NOT_VERSIONED','هذا التكامل لا يدعم نظام الإصدارات');
 const targetManifest=getVersionSnapshot(db,definition.id,Number(toVersion));
 if(!targetManifest)fail(404,'VERSION_NOT_FOUND','الإصدار الهدف غير موجود');
 const rows=db.prepare('SELECT id,tenant_id,name FROM integration_connections WHERE integration_definition_id=? AND connector_version=?').all(connectorSlug,Number(fromVersion));
 const connections=rows.map(r=>{
  const impactedTools=capabilityImpactFor(db,r.tenant_id,r.id,targetManifest);
  return {id:r.id,tenantId:r.tenant_id,name:r.name,capabilityImpacted:impactedTools.length>0,impactedTools};
 });
 return {
  connectorSlug,fromVersion:Number(fromVersion),toVersion:Number(toVersion),
  totalAffected:connections.length,
  tenants:[...new Set(connections.map(c=>c.tenantId))].length,
  capabilityRegressionCount:connections.filter(c=>c.capabilityImpacted).length,
  connections
 };
}

/** Part 7/8 — the real bulk migration itself. Every connection goes through the EXACT SAME
 * `migrateConnectionVersion` safety gate one at a time (capability check, then a real health
 * check against the candidate version, then — only on success — the pin update); a failure for
 * one connection never affects any other. Bounded to `MAX_BULK_MIGRATION_BATCH` connections per
 * call (Part 47 — no unbounded synchronous loop). Requires an explicit, pre-confirmed
 * `connectionIds` list (Part 8 — never "all matching connections" inferred silently at
 * execution time; the caller must have already reviewed the preview and chosen exactly which
 * ids to attempt). */
export async function bulkMigrateConnections({db,env,fetcher,resolver,transport,actorUser,connectorSlug,fromVersion,toVersion,connectionIds}) {
 requirePlatformAdmin(env,actorUser);
 if(!Array.isArray(connectionIds)||!connectionIds.length)fail(400,'NO_CONNECTIONS_SELECTED','لم يتم اختيار أي اتصال');
 if(connectionIds.length>MAX_BULK_MIGRATION_BATCH)fail(400,'BATCH_TOO_LARGE',`الحد الأقصى لكل عملية جماعية هو ${MAX_BULK_MIGRATION_BATCH} اتصال`);
 const results=[];
 for(const connectionId of connectionIds) {
  const row=db.prepare('SELECT tenant_id FROM integration_connections WHERE id=?').get(connectionId);
  if(!row){results.push({connectionId,status:'SKIPPED',reason:'CONNECTION_NOT_FOUND'});continue;}
  const tenantId=row.tenant_id;
  try {
   const outcome=await migrateConnectionVersion({db,env,fetcher,resolver,transport,tenantId,connectionId,targetVersion:toVersion});
   results.push({connectionId,tenantId,status:'READY',fromVersion:outcome.fromVersion,toVersion:outcome.toVersion});
  } catch(error) {
   const skippable=new Set(['CAPABILITY_REGRESSION','TARGET_VERSION_UNHEALTHY','VERSION_NOT_FOUND','CONNECTOR_DISABLED','NOT_VERSIONED']);
   results.push({connectionId,tenantId,status:skippable.has(error.code)?'SKIPPED':'FAILED',reason:error.code||'UNKNOWN_ERROR'});
  }
 }
 const summary={ready:results.filter(r=>r.status==='READY').length,skipped:results.filter(r=>r.status==='SKIPPED').length,failed:results.filter(r=>r.status==='FAILED').length};
 const operationId=recordBulkOperation(db,{type:'VERSION_MIGRATION',actorId:actorUser.id,params:{connectorSlug,fromVersion:Number(fromVersion),toVersion:Number(toVersion),connectionIds},results});
 return {operationId,summary,results};
}

/** Part 9 — rollback ONLY the connections a specific prior bulk operation actually migrated
 * (`status==='READY'`), and ONLY back to the EXACT version each one was on before that specific
 * operation (never a blind "nearest lower version" guess — Part 9: "no unsafe global
 * rollback"). Each connection still goes through the same safe-migration gate in reverse. */
export async function bulkRollbackOperation({db,env,fetcher,resolver,transport,actorUser,operationId}) {
 requirePlatformAdmin(env,actorUser);
 const operation=getBulkOperation(db,env,actorUser,operationId);
 if(operation.type!=='VERSION_MIGRATION')fail(400,'NOT_A_MIGRATION_OPERATION','هذه العملية ليست عملية ترقية إصدارات');
 const migrated=operation.results.filter(r=>r.status==='READY');
 const results=[];
 for(const entry of migrated) {
  try {
   const outcome=await migrateConnectionVersion({db,env,fetcher,resolver,transport,tenantId:entry.tenantId,connectionId:entry.connectionId,targetVersion:entry.fromVersion});
   results.push({connectionId:entry.connectionId,tenantId:entry.tenantId,status:'READY',fromVersion:outcome.fromVersion,toVersion:outcome.toVersion});
  } catch(error) {
   results.push({connectionId:entry.connectionId,status:'FAILED',reason:error.code||'UNKNOWN_ERROR'});
  }
 }
 const summary={ready:results.filter(r=>r.status==='READY').length,skipped:0,failed:results.filter(r=>r.status==='FAILED').length};
 const newOperationId=recordBulkOperation(db,{type:'VERSION_MIGRATION_ROLLBACK',actorId:actorUser.id,params:{sourceOperationId:operationId},results});
 return {operationId:newOperationId,summary,results};
}

// ---------------------------------------------------------------------------------------------
// Phase 6H, Part 10-12 — Bulk Webhook Reprocess. Reuses the EXACT SAME single-event safe
// reprocess pipeline (`reprocessFailedWebhookEvent`, generic-webhook/operations.js — the
// FAILED->REPROCESSING->PROCESSED/FAILED CAS transition against the ORIGINAL stored payload)
// for every selected event, one at a time — never a second reprocessing implementation. Only
// ever selects rows with status='FAILED' at the DB level (PROCESSED/DUPLICATE rows are
// structurally never matched, so "duplicate" in the summary is always 0 — reported anyway so the
// caller sees the same four counters the spec calls for). `webhook_events` rows are scoped by
// (tenant_id, source=connector:<slug>), not by an individual connection id (Phase 6C's own
// design — see webhook-events.js), so for a connector used more than once by the same tenant
// (MULTI connectionMode) reprocessing attaches to that tenant's oldest connection for this
// connector; this is an existing, documented framework limitation, not something introduced here.
const MAX_BULK_REPROCESS_BATCH=100;

function buildFailedEventFilter({connectorSlug,tenantId,fromDate,toDate,errorCode}) {
 const conditions=['source=?',"status='FAILED'"];
 const params=[`connector:${connectorSlug}`];
 if(tenantId){conditions.push('tenant_id=?');params.push(tenantId);}
 if(fromDate){conditions.push('received_at>=?');params.push(fromDate);}
 if(toDate){conditions.push('received_at<=?');params.push(toDate);}
 if(errorCode){conditions.push('error=?');params.push(errorCode);}
 return {where:conditions.join(' AND '),params};
}

/** Part 10 — a real, live, read-only preview: the exact total count of matching FAILED events
 * (never capped) plus a bounded sample (`MAX_BULK_REPROCESS_BATCH`, oldest-first — the same
 * order execution uses) so the operator can see exactly what a first execution batch would
 * contain, and a breakdown by tenant/error code to judge whether the filter is well-targeted
 * before running anything. */
export function previewBulkWebhookReprocess(db,env,actorUser,{connectorSlug,tenantId=null,fromDate=null,toDate=null,errorCode=null}={}) {
 requirePlatformAdmin(env,actorUser);
 if(!connectorSlug)fail(400,'CONNECTOR_REQUIRED','يجب تحديد الموصل');
 const {where,params}=buildFailedEventFilter({connectorSlug,tenantId,fromDate,toDate,errorCode});
 const totalMatched=db.prepare(`SELECT COUNT(*) c FROM webhook_events WHERE ${where}`).get(...params).c;
 const rows=db.prepare(`SELECT id,tenant_id,error,received_at FROM webhook_events WHERE ${where} ORDER BY received_at ASC LIMIT ${MAX_BULK_REPROCESS_BATCH}`).all(...params);
 const byErrorCode={};
 for(const row of rows)byErrorCode[row.error||'UNKNOWN']=(byErrorCode[row.error||'UNKNOWN']||0)+1;
 return {
  connectorSlug,totalMatched,willAttempt:rows.length,
  tenants:[...new Set(rows.map(r=>r.tenant_id))].length,
  byErrorCode,
  events:rows.map(r=>({id:r.id,tenantId:r.tenant_id,errorCode:r.error,receivedAt:r.received_at}))
 };
}

/** Part 11 — the real bulk reprocess. Selects either an explicit, pre-confirmed `eventIds` list
 * (mirroring Part 8's "never inferred silently at execution time" rule for version migration) or
 * — if none given — the same filter used by the preview, oldest-first, bounded to
 * `MAX_BULK_REPROCESS_BATCH` (Part 47 — no unbounded synchronous loop). Every event goes through
 * the exact same atomic CAS-guarded single-event reprocess; a mapping failure on retry (the event
 * genuinely still fails) is reported as `STILL_FAILED`, distinct from `SKIPPED` (a structurally
 * safe refusal — already claimed by another operator, its trigger no longer exists, etc.) and
 * from an unexpected `FAILED`. */
export async function bulkReprocessWebhookEvents({db,env,eventBus,actorUser,connectorSlug,tenantId=null,fromDate=null,toDate=null,errorCode=null,eventIds=null}) {
 requirePlatformAdmin(env,actorUser);
 if(!connectorSlug)fail(400,'CONNECTOR_REQUIRED','يجب تحديد الموصل');
 let rows;
 if(Array.isArray(eventIds) && eventIds.length) {
  if(eventIds.length>MAX_BULK_REPROCESS_BATCH)fail(400,'BATCH_TOO_LARGE',`الحد الأقصى لكل عملية جماعية هو ${MAX_BULK_REPROCESS_BATCH} حدث`);
  const placeholders=eventIds.map(()=>'?').join(',');
  rows=db.prepare(`SELECT id,tenant_id,error FROM webhook_events WHERE source=? AND status='FAILED' AND id IN (${placeholders})`).all(`connector:${connectorSlug}`,...eventIds);
 } else {
  const {where,params}=buildFailedEventFilter({connectorSlug,tenantId,fromDate,toDate,errorCode});
  rows=db.prepare(`SELECT id,tenant_id,error FROM webhook_events WHERE ${where} ORDER BY received_at ASC LIMIT ${MAX_BULK_REPROCESS_BATCH}`).all(...params);
 }
 if(!rows.length)fail(400,'NO_EVENTS_SELECTED','لا توجد أحداث فاشلة مطابقة لإعادة المعالجة');

 const connectionCache=new Map();
 function resolveConnectionId(tid) {
  if(connectionCache.has(tid))return connectionCache.get(tid);
  const row=db.prepare('SELECT id FROM integration_connections WHERE tenant_id=? AND integration_definition_id=? ORDER BY created_at ASC LIMIT 1').get(tid,connectorSlug);
  connectionCache.set(tid,row?.id||null);
  return row?.id||null;
 }

 const results=[];
 for(const row of rows) {
  const connectionId=resolveConnectionId(row.tenant_id);
  if(!connectionId){results.push({eventId:row.id,tenantId:row.tenant_id,status:'SKIPPED',reason:'NO_CONNECTION_FOUND'});continue;}
  try {
   reprocessFailedWebhookEvent({db,eventBus,connectionId,tenantId:row.tenant_id,eventId:row.id});
   results.push({eventId:row.id,tenantId:row.tenant_id,status:'PROCESSED'});
  } catch(error) {
   const skippable=new Set(['NOT_REPROCESSABLE','CONCURRENT_REPROCESS','TRIGGER_NO_LONGER_EXISTS','EVENT_NOT_FOUND']);
   if(error.code==='WEBHOOK_MAPPING_FAILED')results.push({eventId:row.id,tenantId:row.tenant_id,status:'STILL_FAILED',reason:error.code});
   else if(skippable.has(error.code))results.push({eventId:row.id,tenantId:row.tenant_id,status:'SKIPPED',reason:error.code});
   else results.push({eventId:row.id,tenantId:row.tenant_id,status:'FAILED',reason:error.code||'UNKNOWN_ERROR'});
  }
 }
 const summary={
  processed:results.filter(r=>r.status==='PROCESSED').length,
  stillFailed:results.filter(r=>r.status==='STILL_FAILED').length,
  skipped:results.filter(r=>r.status==='SKIPPED').length,
  duplicate:0, // structurally impossible — only FAILED-status rows are ever selected (see comment above)
  failed:results.filter(r=>r.status==='FAILED').length
 };
 const operationId=recordBulkOperation(db,{type:'WEBHOOK_REPROCESS',actorId:actorUser.id,params:{connectorSlug,tenantId,fromDate,toDate,errorCode,eventIds},results});
 return {operationId,summary,results};
}
