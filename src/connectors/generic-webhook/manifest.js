// Universal Integration Platform (Phase 6C, Part 7/92) — the minimal extension point over
// Phase 6A's base trigger validation (`core/manifest.js`'s `validateTrigger`, which already
// validates `{id,slug,eventType,payloadSchema,eventIdPath,timestampPath,mappingDefinition}`).
// Same "re-attach by index" technique Phase 6B used for REST actions — no change was needed to
// `core/manifest.js` itself.
import {validateManifest} from '../core/manifest.js';
import {validateRestManifest} from '../generic-rest/manifest.js';
import {WEBHOOK_AUTH_TYPE} from '../core/enums.js';
import {EVENT_TYPES} from '../../runtime/events.js';

function fail(message){const e=new Error(message);e.status=400;throw e;}

const WEBHOOK_AUTH_TYPES=new Set(Object.values(WEBHOOK_AUTH_TYPE));
const ID_POLICIES=new Set(['REQUIRED','OPTIONAL','NONE']);

function validateAuthentication(auth,connectorSlug,triggerSlug) {
 if(!auth||!WEBHOOK_AUTH_TYPES.has(auth.type))fail(`Connector ${connectorSlug}: trigger ${triggerSlug} has an unknown authentication.type`);
 // Part 16 — NONE only ever fires with an explicit, deliberate opt-in.
 if(auth.type==='NONE' && auth.allowNone!==true)fail(`Connector ${connectorSlug}: trigger ${triggerSlug} authentication.type NONE requires explicit allowNone:true`);
 if(auth.type==='HMAC'){
  if(typeof auth.signatureHeader!=='string'||!auth.signatureHeader)fail(`Connector ${connectorSlug}: trigger ${triggerSlug} HMAC authentication needs a real signatureHeader`);
 }
 if(auth.type==='HEADER_TOKEN'){
  if(typeof auth.headerName!=='string'||!auth.headerName)fail(`Connector ${connectorSlug}: trigger ${triggerSlug} HEADER_TOKEN authentication needs a real headerName`);
 }
 if(auth.type==='SHARED_SECRET'){
  if(typeof auth.headerName!=='string'||!auth.headerName)fail(`Connector ${connectorSlug}: trigger ${triggerSlug} SHARED_SECRET authentication needs a real headerName (Part 15 — header preferred over query)`);
 }
 return auth;
}

/**
 * `raw` is the SAME raw manifest object passed to `validateManifest`/`validateRestManifest` —
 * this function re-validates from scratch (delegating the non-webhook parts unchanged) and
 * additionally validates+normalizes every trigger's webhook-specific fields. Duplicate trigger
 * slugs are rejected (Part 92); an unrecognized `normalizedEventType` is rejected outright —
 * Phase 6C reuses the REAL, already-existing Event Bus vocabulary (`runtime/events.js`'s
 * `EVENT_TYPES`) as its canonical event taxonomy rather than inventing a parallel one (Part
 * 43/44 — "adapt to existing Event Bus shape... do not invent parallel event infrastructure").
 */
export function validateWebhookManifest(raw) {
 const manifest=raw.rest?validateRestManifest(raw):validateManifest(raw);
 const rawTriggers=raw.triggers||[];
 const seenSlugs=new Set();
 const triggers=manifest.triggers.map((trigger,i)=>{
  if(seenSlugs.has(trigger.slug))fail(`Connector ${raw.slug}: duplicate trigger slug: ${trigger.slug}`);
  seenSlugs.add(trigger.slug);
  const src=rawTriggers[i]||{};
  const authentication=validateAuthentication(src.authentication,raw.slug,trigger.slug);
  if(!trigger.mappingDefinition)fail(`Connector ${raw.slug}: trigger ${trigger.slug} needs a real mappingDefinition`);
  if(!src.normalizedEventType||!EVENT_TYPES.includes(src.normalizedEventType))
   fail(`Connector ${raw.slug}: trigger ${trigger.slug}.normalizedEventType must be one of the real, existing Event Bus types (got ${src.normalizedEventType})`);
  const eventIdPolicy=src.eventIdPolicy||'OPTIONAL';
  if(!ID_POLICIES.has(eventIdPolicy))fail(`Connector ${raw.slug}: trigger ${trigger.slug} has an unknown eventIdPolicy`);
  if(src.eventTypeField && src.eventTypeValue===undefined)fail(`Connector ${raw.slug}: trigger ${trigger.slug} declares eventTypeField without an eventTypeValue to match`);
  if(src.maxSkewSeconds!==undefined && !src.timestampPath && !src.timestampHeader)
   fail(`Connector ${raw.slug}: trigger ${trigger.slug} declares maxSkewSeconds but no timestampPath/timestampHeader to read a real timestamp from`);
  return {
   ...trigger,authentication,normalizedEventType:src.normalizedEventType,eventIdPolicy,
   eventTypeField:src.eventTypeField||null,eventTypeValue:src.eventTypeValue??null,
   timestampHeader:src.timestampHeader||null,maxSkewSeconds:src.maxSkewSeconds||null
  };
 });
 return {...manifest,triggers};
}
