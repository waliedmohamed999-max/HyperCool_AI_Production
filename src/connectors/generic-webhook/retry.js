// Universal Integration Platform (Phase 6H, Part 13-18) — Automatic Webhook Retry. Reuses the
// EXISTING webhook_events ledger and its atomic CAS transition (transitionWebhookEventStatus,
// runtime/webhook-events.js) — never a second queue table — and the EXISTING scheduler
// architecture (runtime/scheduler.js's own tick, Part 17) rather than a bespoke timer. A failed
// event moves FAILED -> RETRY_SCHEDULED (bounded backoff) -> (re-attempt) -> PROCESSED, or, once
// its retry budget is exhausted, -> DEAD_LETTER (still manually reprocessable — Part 18 — via
// generic-webhook/operations.js's reprocessFailedWebhookEvent, which now also accepts
// DEAD_LETTER as a starting state). An event that already reached PROCESSED/DUPLICATE is a
// terminal state this module never selects, so a retry can never re-dispatch an
// already-successfully-processed event onto the Event Bus (Part 18's core idempotency
// requirement).
import {getConnection} from '../../integrations/connections.js';
import {transitionWebhookEventStatus} from '../../runtime/webhook-events.js';
import {resolveConnectorDynamic} from '../dynamic/registry.js';
import {applyMapping,MappingError} from '../core/mapping.js';

function fail(status,code,message){const e=new Error(message||code);e.status=status;e.code=code;throw e;}
function requirePlatformAdmin(env,user) {
 const allowlist=(env.PLATFORM_ADMIN_USERNAMES||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
 if(!user?.username||!allowlist.includes(user.username.toLowerCase()))fail(403,'PLATFORM_ADMIN_REQUIRED','هذا الإجراء متاح فقط لمسؤول المنصة');
}

const DEFAULT_MAX_RETRIES=3;
// Part 15 — a bounded, fixed backoff ladder (1min/5min/15min); the last entry repeats for any
// retry beyond the ladder's own length, so a caller with WEBHOOK_MAX_RETRIES set higher than 3
// still gets a sane (if flat) delay rather than an out-of-bounds lookup.
const BACKOFF_MS=[60000,300000,900000];
const MAX_SWEEP_BATCH=100;

export function maxWebhookRetries(env={}) {
 const n=Number(env.WEBHOOK_MAX_RETRIES);
 return Number.isFinite(n) && n>=0 ? n : DEFAULT_MAX_RETRIES;
}
function backoffMsFor(retryCount) {
 return BACKOFF_MS[Math.min(retryCount,BACKOFF_MS.length-1)];
}
function resolveConnectionForRetry(db,tenantId,connectorSlug) {
 const row=db.prepare('SELECT id FROM integration_connections WHERE tenant_id=? AND integration_definition_id=? ORDER BY created_at ASC LIMIT 1').get(tenantId,connectorSlug);
 if(!row)return null;
 try{return getConnection(db,row.id,tenantId);}catch{return null;}
}
/** Runs the SAME mapping+dispatch step webhook.js's own first attempt (and the manual
 * "Reprocess" button) use, against the ORIGINAL stored payload — never a second, looser
 * retry-only implementation. Returns the resolved trigger + normalized data on success; throws
 * a coded error (never touches `webhook_events` itself — the caller owns every status
 * transition) on any failure. */
function attemptDispatch(db,connection,row) {
 const entry=resolveConnectorDynamic(db,connection.integrationDefinitionId,{connectorVersion:connection.connectorVersion??null});
 const trigger=(entry?.manifest?.triggers||[]).find(t=>t.slug===row.type);
 if(!trigger){const e=new Error('TRIGGER_NO_LONGER_EXISTS');e.code='TRIGGER_NO_LONGER_EXISTS';throw e;}
 let normalizedData;
 try {
  const parsedBody=JSON.parse(row.raw_payload);
  normalizedData=applyMapping(trigger.mappingDefinition,{payload:parsedBody,headers:{},connection:{externalAccountId:connection.externalAccountId}});
 } catch(error) {
  const code=error instanceof MappingError?error.code:'WEBHOOK_MAPPING_FAILED';
  const e=new Error(code);e.code=code;throw e;
 }
 return {trigger,normalizedData};
}

/** Part 13/14 — Phase A of the sweep: every genuinely FAILED event that has never been queued
 * for a retry yet (`next_retry_at IS NULL`) either gets a first bounded backoff window
 * (RETRY_SCHEDULED) or, if the retry budget is already zero (`WEBHOOK_MAX_RETRIES=0`), goes
 * straight to DEAD_LETTER. Bounded per call (Part 47 — no unbounded synchronous loop). */
export function scheduleNewlyFailedRetries(db,env,{now=Date.now(),limit=MAX_SWEEP_BATCH}={}) {
 const max=maxWebhookRetries(env);
 const rows=db.prepare("SELECT id,tenant_id,retry_count FROM webhook_events WHERE status='FAILED' AND next_retry_at IS NULL AND raw_payload IS NOT NULL ORDER BY received_at ASC LIMIT ?").all(limit);
 let scheduled=0,deadLettered=0;
 for(const row of rows) {
  if(max<=0) {
   if(transitionWebhookEventStatus(db,row.id,row.tenant_id,{fromStatus:'FAILED',toStatus:'DEAD_LETTER',error:row.error}))deadLettered++;
   continue;
  }
  const nextRetryAt=new Date(now+backoffMsFor(row.retry_count||0)).toISOString();
  const result=db.prepare("UPDATE webhook_events SET status='RETRY_SCHEDULED',next_retry_at=? WHERE id=? AND tenant_id=? AND status='FAILED'").run(nextRetryAt,row.id,row.tenant_id);
  if(result.changes>0)scheduled++;
 }
 return {scheduled,deadLettered};
}

/** Part 16/17 — Phase B of the sweep: every RETRY_SCHEDULED event whose `next_retry_at` has
 * arrived gets exactly one real attempt, claimed atomically (RETRY_SCHEDULED -> PROCESSING, the
 * automatic-retry in-flight state — kept distinct from manual reprocess's own REPROCESSING so
 * the two flows can never collide on the same CAS guard). A failed attempt either reschedules
 * with the next backoff step (retry budget remaining) or moves to DEAD_LETTER (budget
 * exhausted); a successful one dispatches through the real Event Bus exactly once and becomes
 * PROCESSED — a terminal state this sweep never revisits. */
export async function attemptDueRetries({db,env,eventBus,now=Date.now(),limit=MAX_SWEEP_BATCH}) {
 const nowIso=new Date(now).toISOString();
 const rows=db.prepare("SELECT id,tenant_id,type,source,raw_payload,retry_count FROM webhook_events WHERE status='RETRY_SCHEDULED' AND next_retry_at<=? ORDER BY next_retry_at ASC LIMIT ?").all(nowIso,limit);
 const max=maxWebhookRetries(env);
 let processed=0,rescheduled=0,deadLettered=0,skipped=0;
 for(const row of rows) {
  const claimed=transitionWebhookEventStatus(db,row.id,row.tenant_id,{fromStatus:'RETRY_SCHEDULED',toStatus:'PROCESSING'});
  if(!claimed){skipped++;continue;}
  const connectorSlug=row.source.replace(/^connector:/,'');
  const connection=resolveConnectionForRetry(db,row.tenant_id,connectorSlug);
  let attempt=null,errorCode=null;
  if(!connection)errorCode='NO_CONNECTION_FOUND';
  else {
   try{attempt=attemptDispatch(db,connection,row);}
   catch(error){errorCode=error.code||'UNKNOWN_ERROR';}
  }
  if(errorCode) {
   const retryCount=(row.retry_count||0)+1;
   if(retryCount>max) {
    transitionWebhookEventStatus(db,row.id,row.tenant_id,{fromStatus:'PROCESSING',toStatus:'DEAD_LETTER',error:errorCode});
    deadLettered++;
   } else {
    const nextRetryAt=new Date(now+backoffMsFor(retryCount)).toISOString();
    db.prepare("UPDATE webhook_events SET status='RETRY_SCHEDULED',retry_count=?,next_retry_at=?,error=? WHERE id=? AND tenant_id=? AND status='PROCESSING'").run(retryCount,nextRetryAt,errorCode,row.id,row.tenant_id);
    rescheduled++;
   }
   continue;
  }
  eventBus.emit(attempt.trigger.normalizedEventType,{...attempt.normalizedData,tenantId:connection.tenantId,connectionId:connection.id,connectorId:connection.integrationDefinitionId,correlationId:row.id,reprocessed:true,automaticRetry:true});
  transitionWebhookEventStatus(db,row.id,row.tenant_id,{fromStatus:'PROCESSING',toStatus:'PROCESSED'});
  processed++;
 }
 return {processed,rescheduled,deadLettered,skipped};
}

/** Part 48 — Platform Operations visibility: the real, live cross-tenant lists a "Dead Letter
 * Webhooks" / "Pending Retries" screen needs, Platform-Admin gated like every other bulk-ops
 * read in this phase (bulk-operations.js). Never a second summarized/cached copy — every row is
 * a live read of the same `webhook_events` ledger everything else in this module uses. */
export function listDeadLetterEvents(db,env,actorUser,{limit=50}={}) {
 requirePlatformAdmin(env,actorUser);
 return db.prepare("SELECT id,tenant_id,source,type,error,retry_count,received_at FROM webhook_events WHERE status='DEAD_LETTER' ORDER BY received_at DESC LIMIT ?").all(limit)
  .map(r=>({id:r.id,tenantId:r.tenant_id,connectorSlug:r.source.replace(/^connector:/,''),triggerSlug:r.type,errorCode:r.error,retryCount:r.retry_count||0,receivedAt:r.received_at}));
}
export function listPendingRetries(db,env,actorUser,{limit=50}={}) {
 requirePlatformAdmin(env,actorUser);
 return db.prepare("SELECT id,tenant_id,source,type,error,retry_count,next_retry_at,received_at FROM webhook_events WHERE status='RETRY_SCHEDULED' ORDER BY next_retry_at ASC LIMIT ?").all(limit)
  .map(r=>({id:r.id,tenantId:r.tenant_id,connectorSlug:r.source.replace(/^connector:/,''),triggerSlug:r.type,errorCode:r.error,retryCount:r.retry_count||0,nextRetryAt:r.next_retry_at,receivedAt:r.received_at}));
}

/** The scheduler's own single entry point — runs Phase A then Phase B in one tick. */
export async function processWebhookRetries({db,env,eventBus,now=Date.now()}) {
 const phaseA=scheduleNewlyFailedRetries(db,env,{now});
 const phaseB=await attemptDueRetries({db,env,eventBus,now});
 return {
  scheduled:phaseA.scheduled,
  deadLettered:phaseA.deadLettered+phaseB.deadLettered,
  processed:phaseB.processed,
  rescheduled:phaseB.rescheduled,
  skipped:phaseB.skipped
 };
}
