// Universal Integration Platform (Phase 6G, Part 9-17) — Webhook Console operations: real
// rotation (URL + secret), an internal test event, a failed-event inspector, and a safe
// reprocess — all built on the EXISTING generic webhook pipeline (webhook.js) and ledger
// (runtime/webhook-events.js), never a second inbound-processing path.
import {randomBytes,createHmac} from 'node:crypto';
import {getConnection,rotateWebhookPublicId as storeRotatePublicId,getOrCreateWebhookPublicId} from '../../integrations/connections.js';
import {getCredentialForRuntime,storeCredential} from '../../integrations/vault.js';
import {getWebhookEventById,transitionWebhookEventStatus} from '../../runtime/webhook-events.js';
import {resolveConnectorDynamic} from '../dynamic/registry.js';
import {applyMapping,safeLookup,MappingError} from '../core/mapping.js';
import {processGenericWebhook} from './webhook.js';

function fail(status,code,message){const e=new Error(message||code);e.status=status;e.code=code;throw e;}

function requireWebhookCapableConnection(db,connectionId,tenantId) {
 const connection=getConnection(db,connectionId,tenantId);
 const entry=resolveConnectorDynamic(db,connection.integrationDefinitionId,{connectorVersion:connection.connectorVersion??null});
 const triggers=entry?.manifest?.triggers||[];
 if(!triggers.length)fail(400,'NOT_APPLICABLE','هذا الاتصال لا يملك أي Webhook Trigger معلن');
 return {connection,manifest:entry.manifest,triggers};
}

/** Part 9 — the Webhook tab's own summary: URL, public id, per-trigger auth type, last
 * received/processed, and a real failed-count — nothing here is invented; every field is a
 * live read from the connection row + the shared webhook_events ledger. */
export function getWebhookConsoleView(db,connectionId,tenantId,{baseUrl}) {
 const {connection,triggers}=requireWebhookCapableConnection(db,connectionId,tenantId);
 const publicId=getOrCreateWebhookPublicId(db,connectionId,tenantId);
 const source=`connector:${connection.integrationDefinitionId}`;
 const recent=db.prepare('SELECT status,received_at,processed_at FROM webhook_events WHERE tenant_id=? AND source=? ORDER BY received_at DESC LIMIT 1').get(tenantId,source);
 const failedCount=db.prepare("SELECT COUNT(*) c FROM webhook_events WHERE tenant_id=? AND source=? AND status='FAILED'").get(tenantId,source).c;
 return {
  url:`${baseUrl}/api/webhooks/connectors/${publicId}`,publicId,
  triggers:triggers.map(t=>({slug:t.slug,name:t.name,authType:t.authentication.type})),
  lastReceivedAt:recent?.received_at||null,lastProcessedAt:recent?.processed_at||null,failedCount
 };
}

/** Part 10 — Rotate URL: the OLD public id stops resolving to anything immediately (Part
 * 10's "invalid by default" — there is no grace window, matching this platform's existing
 * "a rotated/removed credential takes effect immediately" convention everywhere else). */
export function rotateWebhookUrl(db,connectionId,tenantId) {
 requireWebhookCapableConnection(db,connectionId,tenantId);
 return storeRotatePublicId(db,connectionId,tenantId);
}

/** Part 11/12 — Rotate Secret: a fresh, cryptographically random secret, written ONLY into the
 * Vault (merged with whatever else the connection's credential already holds — Part 32 of
 * vault.js: storeCredential is a full replace, so every OTHER field must be preserved
 * explicitly here). The OLD secret is immediately invalid (nothing besides the Vault ever held
 * it) — Part 12: returned to the caller exactly once; this function's caller (the HTTP route)
 * must never log it and must show it to the operator exactly once. */
export function rotateWebhookSecret(db,env,connectionId,tenantId) {
 requireWebhookCapableConnection(db,connectionId,tenantId);
 const existing=getCredentialForRuntime(db,env,connectionId,tenantId);
 const webhookSecret=randomBytes(32).toString('hex');
 storeCredential(db,env,{connectionId,credentialType:existing?.credentialType||'webhook_secret',payload:{...(existing?.payload||{}),webhookSecret}},tenantId);
 return {webhookSecret};
}

/** Part 13 — Test Webhook: reuses the EXACT SAME `processGenericWebhook` pipeline a real
 * external delivery goes through (auth, mapping, idempotency, Event Bus) — never a second,
 * looser "preview" implementation — but clearly labeled INTERNAL so nothing downstream can
 * mistake it for a genuine provider delivery. The internal event id is namespaced
 * (`internal-test:...`) so it can never collide with — or be confused for — a real one, and a
 * repeated click intentionally produces a fresh id each time (a manual test is not expected to
 * be idempotent against itself).
 */
export async function sendTestWebhookEvent({db,env,eventBus,connectionId,tenantId,triggerSlug,samplePayload}) {
 const {connection,triggers}=requireWebhookCapableConnection(db,connectionId,tenantId);
 const trigger=triggers.find(t=>t.slug===triggerSlug)||triggers[0];
 if(!trigger)fail(404,'TRIGGER_NOT_FOUND','لا يوجد Trigger بهذا الاسم');
 const publicId=getOrCreateWebhookPublicId(db,connectionId,tenantId);
 const credential=getCredentialForRuntime(db,env,connectionId,tenantId);
 const secret=credential?.payload?.webhookSecret;
 const body={...(samplePayload&&typeof samplePayload==='object'?samplePayload:{}),__internalTest:true};
 if(trigger.eventTypeField && trigger.eventTypeValue!==undefined)body[trigger.eventTypeField]=trigger.eventTypeValue;
 const rawBody=JSON.stringify(body);
 const headers={};
 if(trigger.authentication.type==='HMAC' && secret) {
  headers[trigger.authentication.signatureHeader.toLowerCase()]=(trigger.authentication.signaturePrefix||'')+createHmac('sha256',secret).update(rawBody).digest('hex');
 } else if((trigger.authentication.type==='HEADER_TOKEN'||trigger.authentication.type==='SHARED_SECRET') && secret) {
  headers[trigger.authentication.headerName.toLowerCase()]=secret;
 }
 const result=await processGenericWebhook({db,env,eventBus,publicId,rawBody,headers});
 return {...result,internalTest:true,triggerSlug:trigger.slug};
}

/** Part 14 — Failed Webhook Inspector: safe metadata only (Part 14 explicitly excludes raw
 * payload by default). Phase 6H, Part 13-18 — also surfaces events currently in the automatic
 * retry cycle (RETRY_SCHEDULED) and ones that exhausted it (DEAD_LETTER), each carrying its real
 * `retryCount`/`nextRetryAt` so an operator sees the whole picture, not just the initial
 * failure — a retrying event is not "gone", it is still failed until it actually succeeds. */
export function listFailedWebhookEventsForConnection(db,connectionId,tenantId) {
 const connection=getConnection(db,connectionId,tenantId);
 const source=`connector:${connection.integrationDefinitionId}`;
 const rows=db.prepare("SELECT * FROM webhook_events WHERE tenant_id=? AND source=? AND status IN ('FAILED','RETRY_SCHEDULED','DEAD_LETTER') ORDER BY received_at DESC LIMIT 50").all(tenantId,source);
 return rows.map(row=>({
  id:row.id,receivedAt:row.received_at,triggerSlug:row.type,errorCode:row.error,status:row.status,
  externalEventId:row.external_event_id,correlationId:row.id,hasRawPayload:!!row.raw_payload,
  retryCount:row.retry_count||0,nextRetryAt:row.next_retry_at||null
 }));
}
/** Part 15 — raw payload detail, gated to the caller's own authorization check (the HTTP route
 * requires Platform Admin OR the tenant owner of this exact connection — see application.js).
 * A best-effort mask over common sensitive-looking keys; this is a courtesy, not a substitute
 * for "don't show this to just anyone" (which the route-level authorization already enforces). */
const SENSITIVE_KEY_RE=/token|secret|password|api[_-]?key|authorization|card|cvv|iban/i;
function maskSensitive(value) {
 if(Array.isArray(value))return value.map(maskSensitive);
 if(value && typeof value==='object') {
  const out={};
  for(const [k,v] of Object.entries(value))out[k]=SENSITIVE_KEY_RE.test(k)?'***MASKED***':maskSensitive(v);
  return out;
 }
 return value;
}
export function getFailedWebhookEventDetail(db,connectionId,tenantId,eventId) {
 const connection=getConnection(db,connectionId,tenantId);
 const row=getWebhookEventById(db,eventId,tenantId);
 if(!row||row.source!==`connector:${connection.integrationDefinitionId}`)fail(404,'EVENT_NOT_FOUND','لا يوجد حدث بهذا المعرّف لهذا الاتصال');
 return {
  id:row.id,receivedAt:row.received_at,processedAt:row.processed_at,status:row.status,errorCode:row.error,
  triggerSlug:row.type,externalEventId:row.external_event_id,
  rawPayload:row.raw_payload?maskSensitive(JSON.parse(row.raw_payload)):null
 };
}
/** Part 16 — Safe Reprocess: re-runs mapping+dispatch against the ORIGINAL stored payload of
 * this EXACT event (same identity — Part 16 requirement 1), guarded by an atomic
 * `status='FAILED'->'REPROCESSING'` CAS transition (requirement 3: two concurrent clicks can
 * never both proceed) and never re-inserts a new webhook_events row (requirement 2: no
 * duplicate SUCCESSFUL processing — the same row simply moves from FAILED to PROCESSED/FAILED
 * again). Requires the caller to have already obtained explicit confirmation (requirement 4 —
 * a UI-level concern; this function itself performs the action unconditionally once called). */
export function reprocessFailedWebhookEvent({db,eventBus,connectionId,tenantId,eventId}) {
 const connection=getConnection(db,connectionId,tenantId);
 const row=getWebhookEventById(db,eventId,tenantId);
 if(!row||row.source!==`connector:${connection.integrationDefinitionId}`)fail(404,'EVENT_NOT_FOUND','لا يوجد حدث بهذا المعرّف لهذا الاتصال');
 // Phase 6H, Part 18 — manual reprocess must still work once automatic retry has exhausted its
 // budget and dead-lettered the event (RETRY_SCHEDULED itself is deliberately excluded — that
 // state is already being handled by the automatic retry sweep, see retry.js).
 if(row.status!=='FAILED' && row.status!=='DEAD_LETTER')fail(409,'NOT_REPROCESSABLE','هذا الحدث ليس في حالة فشل قابلة لإعادة المعالجة');
 if(!row.raw_payload)fail(409,'NOT_REPROCESSABLE','لم يتم حفظ المحتوى الأصلي لهذا الحدث (أحداث أقدم من هذه الميزة)');
 const claimed=transitionWebhookEventStatus(db,eventId,tenantId,{fromStatus:row.status,toStatus:'REPROCESSING'});
 if(!claimed)fail(409,'CONCURRENT_REPROCESS','تمت معالجة هذا الحدث بالفعل من جلسة أخرى');
 const entry=resolveConnectorDynamic(db,connection.integrationDefinitionId,{connectorVersion:connection.connectorVersion??null});
 const trigger=(entry?.manifest?.triggers||[]).find(t=>t.slug===row.type);
 if(!trigger) {
  transitionWebhookEventStatus(db,eventId,tenantId,{fromStatus:'REPROCESSING',toStatus:'FAILED',error:'TRIGGER_NO_LONGER_EXISTS'});
  fail(409,'TRIGGER_NO_LONGER_EXISTS','هذا الـTrigger لم يعد معرَّفًا على هذا الموصل');
 }
 let normalizedData;
 try {
  const parsedBody=JSON.parse(row.raw_payload);
  normalizedData=applyMapping(trigger.mappingDefinition,{payload:parsedBody,headers:{},connection:{externalAccountId:connection.externalAccountId}});
 } catch(error) {
  const code=error instanceof MappingError?error.code:'WEBHOOK_MAPPING_FAILED';
  transitionWebhookEventStatus(db,eventId,tenantId,{fromStatus:'REPROCESSING',toStatus:'FAILED',error:code});
  fail(422,'WEBHOOK_MAPPING_FAILED',`فشلت إعادة المعالجة مرة أخرى: ${code}`);
 }
 eventBus.emit(trigger.normalizedEventType,{...normalizedData,tenantId,connectionId:connection.id,connectorId:connection.integrationDefinitionId,correlationId:row.id,reprocessed:true});
 transitionWebhookEventStatus(db,eventId,tenantId,{fromStatus:'REPROCESSING',toStatus:'PROCESSED'});
 return {status:'PROCESSED',eventId:row.id};
}
