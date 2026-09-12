// Universal Integration Platform (Phase 6C) — the generic inbound webhook processing pipeline:
// External Platform -> public id -> Connection -> Tenant -> auth -> idempotency -> trigger
// selection -> mapping -> normalized event -> the EXISTING Event Bus. Reuses
// `runtime/webhook-events.js`'s real idempotency ledger (Part 20 — "Do NOT create a second
// deduplication system") and `runtime/events.js`'s real, unchanged Event Bus (Part 47).
import {randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import {getConnectionByPublicId} from '../../integrations/connections.js';
import {getTenant,tenantOperationalBlockReason} from '../../tenancy.js';
import {getCredentialForRuntime} from '../../integrations/vault.js';
import {storeWebhookEvent,markWebhookEventProcessed} from '../../runtime/webhook-events.js';
import {recordAudit} from '../../audit.js';
import {applyMapping,safeLookup,MappingError} from '../core/mapping.js';
import {getConnector} from '../registry.js';

export class WebhookError extends Error {
 constructor(status,code,message){super(message||code);this.status=status;this.code=code;}
}

// Part 100 — timing-safe comparison for every secret check, never `===`.
function timingSafeCompare(a,b) {
 const bufA=Buffer.from(String(a||''),'utf8'),bufB=Buffer.from(String(b||''),'utf8');
 if(bufA.length!==bufB.length)return false;
 return timingSafeEqual(bufA,bufB);
}
function headerValue(headers,name) {
 return headers?.[name.toLowerCase()]||'';
}

/** Part 10-16 — verified against RAW BYTES for HMAC (Part 11), never a re-serialized JSON
 * string; the webhook's own secret comes from the Vault, never the manifest/metadata (Part 13). */
function verifyWebhookAuth({trigger,rawBody,headers,credential}) {
 const auth=trigger.authentication;
 if(auth.type==='NONE')return; // already required allowNone:true at manifest-validation time
 const secret=credential?.payload?.webhookSecret;
 if(!secret)throw new WebhookError(401,'CONNECTOR_WEBHOOK_AUTH_FAILED','no webhook secret configured for this connection');
 if(auth.type==='HMAC') {
  const provided=headerValue(headers,auth.signatureHeader);
  const prefix=auth.signaturePrefix||'';
  const actual=provided.startsWith(prefix)?provided.slice(prefix.length):provided;
  const expected=createHmac('sha256',secret).update(rawBody).digest('hex');
  if(!timingSafeCompare(actual,expected))throw new WebhookError(401,'CONNECTOR_WEBHOOK_AUTH_FAILED','invalid signature');
  return;
 }
 if(auth.type==='HEADER_TOKEN') {
  if(!timingSafeCompare(headerValue(headers,auth.headerName),secret))throw new WebhookError(401,'CONNECTOR_WEBHOOK_AUTH_FAILED','invalid token');
  return;
 }
 if(auth.type==='SHARED_SECRET') {
  if(!timingSafeCompare(headerValue(headers,auth.headerName),secret))throw new WebhookError(401,'CONNECTOR_WEBHOOK_AUTH_FAILED','invalid shared secret');
  return;
 }
 throw new WebhookError(400,'CONNECTOR_WEBHOOK_AUTH_MISCONFIGURED','unrecognized authentication type');
}

/** Part 25/26 — an optional freshness check; NEVER invented for a provider that has no real
 * timestamp field (only runs when the trigger explicitly declares one). */
function verifyReplayWindow(trigger,parsedBody,headers) {
 if(!trigger.maxSkewSeconds)return;
 const raw=trigger.timestampHeader?headerValue(headers,trigger.timestampHeader):safeLookup(parsedBody,trigger.timestampPath);
 if(!raw)throw new WebhookError(400,'WEBHOOK_INVALID_PAYLOAD','missing required timestamp for replay-window check');
 const eventTime=/^\d+$/.test(String(raw))?Number(raw)*1000:new Date(raw).getTime();
 if(Number.isNaN(eventTime))throw new WebhookError(400,'WEBHOOK_INVALID_PAYLOAD','unparseable event timestamp');
 if(Math.abs(Date.now()-eventTime)>trigger.maxSkewSeconds*1000)throw new WebhookError(401,'CONNECTOR_WEBHOOK_AUTH_FAILED','event timestamp outside allowed replay window');
}

// Part 9 — deterministic trigger selection: a single fixed trigger, or an event-type
// discriminator field the manifest itself declares — never an arbitrary event name taken from
// the request body and trusted directly as a system event.
function selectTrigger(manifest,parsedBody) {
 const triggers=manifest.triggers||[];
 if(triggers.length===1 && !triggers[0].eventTypeField)return triggers[0];
 return triggers.find(t=>t.eventTypeField && safeLookup(parsedBody,t.eventTypeField)===t.eventTypeValue)||null;
}

const MAX_BODY_BYTES=1024*1024; // Part 17 — 1MB ceiling, matching the platform's other body limits

/**
 * The one real entry point. `eventBus` is the app's existing, live Event Bus (Part 47) — this
 * function never builds a second one. `resolveConnector` defaults to the real registry; tests
 * inject a test-only connector (Acme) the same way `executeConnectorAction` already does.
 */
export async function processGenericWebhook({db,env,eventBus,publicId,rawBody,headers={},resolveConnector=getConnector}) {
 // `rawBody` matches this codebase's existing webhook convention (rawBody(req) in
 // application.js returns a UTF-8 string) — normalized to a Buffer here ONCE, so HMAC
 // verification (Part 11) always runs against the exact real bytes, not a re-decoded copy.
 const bodyBuffer=Buffer.isBuffer(rawBody)?rawBody:Buffer.from(rawBody||'','utf8');
 if(bodyBuffer.length>MAX_BODY_BYTES)throw new WebhookError(413,'CONNECTOR_WEBHOOK_PAYLOAD_TOO_LARGE','webhook body too large');
 // Part 103/112 — an unknown public id is rejected cheaply, before any DB write, and with a
 // response that reveals nothing about whether any real tenant/connection exists.
 const connection=getConnectionByPublicId(db,publicId);
 if(!connection)throw new WebhookError(404,'CONNECTOR_WEBHOOK_NOT_FOUND','not found');
 if(connection.status==='DISCONNECTED')throw new WebhookError(410,'CONNECTOR_WEBHOOK_NOT_FOUND','not found');

 const tenant=getTenant(db,connection.tenantId);
 const blockReason=tenantOperationalBlockReason(tenant);
 if(blockReason)throw new WebhookError(409,'CONNECTOR_WEBHOOK_TENANT_NOT_OPERATIONAL','tenant not operational');

 const entry=resolveConnector(connection.integrationDefinitionId);
 if(!entry)throw new WebhookError(404,'CONNECTOR_WEBHOOK_NOT_FOUND','not found');
 const {manifest}=entry;

 let parsedBody;
 try{parsedBody=JSON.parse(bodyBuffer.toString('utf8')||'{}');}
 catch{throw new WebhookError(400,'WEBHOOK_INVALID_PAYLOAD','invalid JSON');}

 const trigger=selectTrigger(manifest,parsedBody);
 if(!trigger) {
  recordAudit(db,{id:randomUUID(),action:'CONNECTOR_WEBHOOK_REJECTED',itemId:connection.id,connectorSlug:manifest.slug,errorCode:'CONNECTOR_WEBHOOK_UNKNOWN_EVENT',at:new Date().toISOString()},connection.tenantId);
  throw new WebhookError(400,'CONNECTOR_WEBHOOK_UNKNOWN_EVENT','no matching trigger for this event');
 }

 let credential=null;
 try{credential=getCredentialForRuntime(db,env,connection.id,connection.tenantId);}catch{credential=null;}

 // Part 104 — auth verified BEFORE any mapping/dispatch work.
 try {
  verifyWebhookAuth({trigger,rawBody:bodyBuffer,headers,credential});
  verifyReplayWindow(trigger,parsedBody,headers);
 } catch(error) {
  recordAudit(db,{id:randomUUID(),action:'CONNECTOR_WEBHOOK_REJECTED',itemId:connection.id,connectorSlug:manifest.slug,triggerSlug:trigger.slug,errorCode:error.code,at:new Date().toISOString()},connection.tenantId);
  // Part 111 — a bad signature never itself degrades the connection's own health; only a
  // real, authenticated failure the connector's own health check performs can do that.
  throw error;
 }

 recordAudit(db,{id:randomUUID(),action:'CONNECTOR_WEBHOOK_RECEIVED',itemId:connection.id,connectorSlug:manifest.slug,triggerSlug:trigger.slug,at:new Date().toISOString()},connection.tenantId);

 // Part 21/22 — external event id extraction + Part 20/23/24 — idempotency via the EXISTING
 // webhook_events ledger (UNIQUE(source,external_event_id), INSERT OR IGNORE — a real DB
 // constraint, not an in-memory Set, so two truly concurrent identical deliveries still only
 // ever produce one stored row, Part 24).
 const externalEventId=trigger.eventIdPath?safeLookup(parsedBody,trigger.eventIdPath):null;
 if(trigger.eventIdPolicy==='REQUIRED' && !externalEventId)
  throw new WebhookError(400,'WEBHOOK_INVALID_PAYLOAD','this event type requires a real, stable external event id');
 // NONE policy: every delivery gets a fresh key — Part 22's honest "cannot dedupe" case,
 // documented in docs/GENERIC_WEBHOOK_FRAMEWORK.md, never silently pretended to be safe.
 const dedupeKey=externalEventId||(trigger.eventIdPolicy==='NONE'?randomUUID():null);
 if(!dedupeKey)throw new WebhookError(400,'WEBHOOK_INVALID_PAYLOAD','missing external event id and eventIdPolicy is not NONE');

 const stored=storeWebhookEvent(db,{
  source:`connector:${manifest.slug}`,externalEventId:dedupeKey,type:trigger.slug,
  // Part 76/77 — the raw payload is deliberately NOT persisted here (unlike some existing
  // provider webhooks); only the safe, already-mapped normalized data would be worth keeping,
  // and even that is not persisted beyond the Event Bus's own agent_events row.
  payload:{trigger:trigger.slug},tenantId:connection.tenantId
 });
 if(!stored.stored) {
  recordAudit(db,{id:randomUUID(),action:'CONNECTOR_WEBHOOK_DUPLICATE',itemId:connection.id,connectorSlug:manifest.slug,triggerSlug:trigger.slug,externalEventId:dedupeKey,at:new Date().toISOString()},connection.tenantId);
  return {status:'DUPLICATE',eventId:stored.id};
 }

 let normalizedData;
 try {
  normalizedData=applyMapping(trigger.mappingDefinition,{payload:parsedBody,headers,connection:{externalAccountId:connection.externalAccountId}});
 } catch(error) {
  markWebhookEventProcessed(db,stored.id,'FAILED',error instanceof MappingError?error.code:'WEBHOOK_MAPPING_FAILED');
  recordAudit(db,{id:randomUUID(),action:'CONNECTOR_WEBHOOK_FAILED',itemId:connection.id,connectorSlug:manifest.slug,triggerSlug:trigger.slug,errorCode:'WEBHOOK_MAPPING_FAILED',at:new Date().toISOString()},connection.tenantId);
  throw new WebhookError(422,'WEBHOOK_MAPPING_FAILED','mapping failed for this event');
 }

 // Part 47/48 — dispatch into the EXISTING Event Bus only after idempotency+mapping succeed;
 // never before the webhook_events row is committed (Part 48/105).
 eventBus.emit(trigger.normalizedEventType,{...normalizedData,tenantId:connection.tenantId,connectionId:connection.id,connectorId:manifest.slug,correlationId:stored.id});
 markWebhookEventProcessed(db,stored.id,'PROCESSED');
 recordAudit(db,{id:randomUUID(),action:'CONNECTOR_WEBHOOK_PROCESSED',itemId:connection.id,connectorSlug:manifest.slug,triggerSlug:trigger.slug,externalEventId:dedupeKey,at:new Date().toISOString()},connection.tenantId);
 return {status:'PROCESSED',eventId:stored.id};
}
