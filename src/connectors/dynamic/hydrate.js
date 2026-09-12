// Universal Integration Platform (Phase 6D, Part 115/116) — combines a DB-backed connector
// definition + its actions/triggers into an SDK-compatible manifest, then runs it through the
// EXACT SAME validators 6A/6B/6C already use. "Never trust the DB merely because a Platform
// Admin wrote it" — hydration always re-validates from scratch; a definition that somehow
// became invalid (e.g. a capability later removed from the registry) fails loudly here rather
// than silently executing.
import {getIntegrationDefinition} from '../../integrations/definitions.js';
import {listActionsForDefinition,listTriggersForDefinition} from './store.js';
import {validateManifest} from '../core/manifest.js';
import {validateRestManifest} from '../generic-rest/manifest.js';
import {validateWebhookManifest} from '../generic-webhook/manifest.js';

function fail(status,code,message){const e=new Error(message||code);e.status=status;e.code=code;throw e;}

/** Builds the raw manifest object hydrate() functions elsewhere expect, from real DB rows. */
export function buildRawManifest(db,definition) {
 const actions=listActionsForDefinition(db,definition.id).filter(a=>a.isEnabled).map(a=>({
  id:`${definition.slug}.${a.slug}`,slug:a.slug,nameAr:a.nameAr,nameEn:a.nameEn,description:a.description,
  requiredCapability:a.requiredCapability,riskLevel:a.riskLevel,actionType:a.actionType,
  inputSchema:a.inputSchema,outputSchema:a.outputSchema,idempotencyPolicy:a.idempotencyPolicy,
  requiresApprovalDefault:a.requiresApprovalDefault===null?undefined:a.requiresApprovalDefault,
  rest:{httpMethod:a.httpMethod,pathTemplate:a.pathTemplate,queryMapping:a.queryMapping,headerMapping:a.headerMapping,bodyMapping:a.bodyMapping,responseMapping:a.responseMapping,maxResponseBytes:a.maxResponseBytes}
 }));
 const triggers=listTriggersForDefinition(db,definition.id).filter(t=>t.isEnabled).map(t=>({
  id:`${definition.slug}.${t.slug}`,slug:t.slug,name:t.name,eventType:t.eventType,
  payloadSchema:t.payloadSchema,eventIdPath:t.eventIdPath,timestampPath:t.timestampPath,mappingDefinition:t.mappingDefinition,
  authentication:t.authentication,normalizedEventType:t.normalizedEventType,eventIdPolicy:t.eventIdPolicy,
  eventTypeField:t.discriminatorPath||undefined,eventTypeValue:t.discriminatorValue||undefined,
  timestampHeader:t.timestampHeader||undefined,maxSkewSeconds:t.maxSkewSeconds||undefined
 }));
 // The definition's OWN declared capabilities (Builder wizard step 3, Part 67) are canonical —
 // never re-derived from actions alone, so an admin's upfront capability declaration is the
 // real source of truth 6A's validateManifest checks every action's requiredCapability against.
 const capabilities=definition.capabilities?.length?definition.capabilities:[...new Set(actions.map(a=>a.requiredCapability))];
 return {
  id:definition.slug,slug:definition.slug,nameAr:definition.nameAr,nameEn:definition.nameEn,
  descriptionAr:definition.descriptionAr,descriptionEn:definition.descriptionEn,
  category:(definition.category||'CUSTOM').toUpperCase(),version:definition.version,
  availability:definition.isAvailable?'AVAILABLE':'DEFINITION_ONLY',
  connectionMode:definition.connectionMode,
  auth:definition.authConfig||{type:definition.authType},
  capabilities,actions,triggers,
  rest:definition.adapterType==='GENERIC_REST'?definition.restConfig:undefined
 };
}

/** Hydrates + validates a dynamic definition's manifest from LIVE DB rows (used by the Builder
 * to validate before publish, and by anything that must reflect the latest draft state). */
export function hydrateAndValidate(db,slug) {
 const definition=getIntegrationDefinition(db,slug);
 if(!definition)fail(404,'CONNECTOR_NOT_FOUND','no such connector definition');
 const raw=buildRawManifest(db,definition);
 if(definition.triggers?.length || raw.triggers.length)
  return {definition,manifest:definition.adapterType==='GENERIC_REST'?validateWebhookManifest(raw):validateManifest(raw)};
 if(definition.adapterType==='GENERIC_REST')return {definition,manifest:validateRestManifest(raw)};
 return {definition,manifest:validateManifest(raw)};
}
