// Universal Integration Platform (Phase 6H, Part 1-5) — Safe Published Version Lifecycle.
// A PUBLISHED connector's live `integration_definitions` row + `connector_actions`/
// `connector_triggers` (store.js) are the ONE thing every new connection and every unpinned
// resolution reads — Phase 6G's "Create New Draft Version" flipped that row's `status` back to
// DRAFT while editing, which correctly protected already-pinned connections but ALSO stopped
// serving brand-new ones (an honest, but real, limitation — see docs/CONNECTOR_VERSION_MANAGEMENT.md's
// prior revision).
//
// This module adds a genuinely PARALLEL draft workspace — one row of draft metadata plus two
// mirror tables (identical schema to `connector_actions`/`connector_triggers`, just a different
// table name) — so a Platform Admin can edit "v3" here while the LIVE tables (serving v2 to every
// new connection, exactly as before) are never touched until the draft is actually published.
// This is purely additive: nothing about `integration_definitions`/`connector_actions`/
// `connector_triggers`'s own shape or behavior changes; a connector with no draft in progress
// behaves EXACTLY as it always has.
import {randomUUID} from 'node:crypto';

export function installDraftOverlayTables(db) {
 db.exec(`
  CREATE TABLE IF NOT EXISTS connector_draft_meta (
   connector_definition_id TEXT PRIMARY KEY,
   name_ar TEXT NOT NULL, name_en TEXT NOT NULL, category TEXT NOT NULL,
   description_ar TEXT, description_en TEXT,
   capabilities TEXT NOT NULL, rest_config TEXT, auth_config TEXT,
   created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS connector_draft_actions (
   id TEXT PRIMARY KEY,
   connector_definition_id TEXT NOT NULL,
   slug TEXT NOT NULL,
   name_ar TEXT NOT NULL, name_en TEXT NOT NULL,
   description TEXT,
   http_method TEXT NOT NULL,
   path_template TEXT NOT NULL,
   required_capability TEXT NOT NULL,
   action_type TEXT NOT NULL,
   risk_level TEXT NOT NULL,
   input_schema TEXT,
   output_schema TEXT,
   query_mapping TEXT,
   header_mapping TEXT,
   body_mapping TEXT,
   response_mapping TEXT,
   timeout_ms INTEGER NOT NULL DEFAULT 15000,
   max_response_bytes INTEGER NOT NULL DEFAULT 2097152,
   idempotency_policy TEXT NOT NULL DEFAULT 'NONE',
   requires_approval_default INTEGER,
   is_enabled INTEGER NOT NULL DEFAULT 1,
   created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
   UNIQUE(connector_definition_id,slug)
  );
  CREATE TABLE IF NOT EXISTS connector_draft_triggers (
   id TEXT PRIMARY KEY,
   connector_definition_id TEXT NOT NULL,
   slug TEXT NOT NULL,
   name TEXT NOT NULL,
   event_type TEXT NOT NULL,
   selection_type TEXT NOT NULL DEFAULT 'FIXED',
   discriminator_path TEXT,
   discriminator_value TEXT,
   auth_type TEXT NOT NULL,
   signature_header TEXT,
   signature_prefix TEXT,
   header_name TEXT,
   timestamp_header TEXT,
   timestamp_path TEXT,
   max_skew_seconds INTEGER,
   external_event_id_path TEXT,
   external_event_id_policy TEXT NOT NULL DEFAULT 'OPTIONAL',
   payload_schema TEXT,
   mapping TEXT NOT NULL,
   normalized_event_type TEXT NOT NULL,
   is_enabled INTEGER NOT NULL DEFAULT 1,
   created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
   UNIQUE(connector_definition_id,slug)
  );
 `);
}

function hydrateMeta(row) {
 if(!row)return null;
 return {
  nameAr:row.name_ar,nameEn:row.name_en,category:row.category,descriptionAr:row.description_ar||'',descriptionEn:row.description_en||'',
  capabilities:JSON.parse(row.capabilities),restConfig:row.rest_config?JSON.parse(row.rest_config):null,authConfig:row.auth_config?JSON.parse(row.auth_config):null,
  createdAt:row.created_at,updatedAt:row.updated_at
 };
}
export function getDraftMeta(db,connectorDefinitionId) {
 return hydrateMeta(db.prepare('SELECT * FROM connector_draft_meta WHERE connector_definition_id=?').get(connectorDefinitionId));
}
export function hasDraftOverlay(db,connectorDefinitionId) {
 return !!db.prepare('SELECT 1 FROM connector_draft_meta WHERE connector_definition_id=?').get(connectorDefinitionId);
}
export function createDraftMeta(db,connectorDefinitionId,seed) {
 const now=new Date().toISOString();
 db.prepare(`INSERT INTO connector_draft_meta (connector_definition_id,name_ar,name_en,category,description_ar,description_en,capabilities,rest_config,auth_config,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
  connectorDefinitionId,seed.nameAr,seed.nameEn,seed.category,seed.descriptionAr||'',seed.descriptionEn||'',
  JSON.stringify(seed.capabilities||[]),seed.restConfig?JSON.stringify(seed.restConfig):null,seed.authConfig?JSON.stringify(seed.authConfig):null,now,now
 );
 return getDraftMeta(db,connectorDefinitionId);
}
export function updateDraftMeta(db,connectorDefinitionId,patch) {
 const current=getDraftMeta(db,connectorDefinitionId);
 if(!current)return null;
 const now=new Date().toISOString();
 db.prepare(`UPDATE connector_draft_meta SET name_ar=COALESCE(?,name_ar),name_en=COALESCE(?,name_en),category=COALESCE(?,category),description_ar=COALESCE(?,description_ar),description_en=COALESCE(?,description_en),capabilities=COALESCE(?,capabilities),rest_config=COALESCE(?,rest_config),auth_config=COALESCE(?,auth_config),updated_at=? WHERE connector_definition_id=?`)
  .run(patch.nameAr||null,patch.nameEn||null,patch.category?.toLowerCase()||null,patch.descriptionAr||null,patch.descriptionEn||null,
   patch.capabilities?JSON.stringify(patch.capabilities):null,patch.rest?JSON.stringify({...current.restConfig,...patch.rest}):null,
   patch.auth?JSON.stringify(patch.auth):null,now,connectorDefinitionId);
 return getDraftMeta(db,connectorDefinitionId);
}
export function deleteDraftOverlay(db,connectorDefinitionId) {
 db.prepare('DELETE FROM connector_draft_meta WHERE connector_definition_id=?').run(connectorDefinitionId);
 db.prepare('DELETE FROM connector_draft_actions WHERE connector_definition_id=?').run(connectorDefinitionId);
 db.prepare('DELETE FROM connector_draft_triggers WHERE connector_definition_id=?').run(connectorDefinitionId);
}

function hydrateAction(row) {
 return {
  id:row.id,slug:row.slug,nameAr:row.name_ar,nameEn:row.name_en,description:row.description||'',
  httpMethod:row.http_method,pathTemplate:row.path_template,requiredCapability:row.required_capability,
  actionType:row.action_type,riskLevel:row.risk_level,
  inputSchema:row.input_schema?JSON.parse(row.input_schema):null,outputSchema:row.output_schema?JSON.parse(row.output_schema):null,
  queryMapping:row.query_mapping?JSON.parse(row.query_mapping):{},headerMapping:row.header_mapping?JSON.parse(row.header_mapping):{},
  bodyMapping:row.body_mapping?JSON.parse(row.body_mapping):null,responseMapping:row.response_mapping?JSON.parse(row.response_mapping):null,
  timeoutMs:row.timeout_ms,maxResponseBytes:row.max_response_bytes,idempotencyPolicy:row.idempotency_policy,
  requiresApprovalDefault:row.requires_approval_default===null?null:!!row.requires_approval_default,
  isEnabled:!!row.is_enabled,createdAt:row.created_at,updatedAt:row.updated_at
 };
}
export function listDraftActionsForDefinition(db,connectorDefinitionId) {
 return db.prepare('SELECT * FROM connector_draft_actions WHERE connector_definition_id=? ORDER BY created_at').all(connectorDefinitionId).map(hydrateAction);
}
export function upsertDraftAction(db,connectorDefinitionId,action) {
 const now=new Date().toISOString();
 const existing=db.prepare('SELECT id FROM connector_draft_actions WHERE connector_definition_id=? AND slug=?').get(connectorDefinitionId,action.slug);
 const id=existing?.id||randomUUID();
 db.prepare(`INSERT INTO connector_draft_actions (id,connector_definition_id,slug,name_ar,name_en,description,http_method,path_template,required_capability,action_type,risk_level,input_schema,output_schema,query_mapping,header_mapping,body_mapping,response_mapping,timeout_ms,max_response_bytes,idempotency_policy,requires_approval_default,is_enabled,created_at,updated_at)
  VALUES (@id,@connectorDefinitionId,@slug,@nameAr,@nameEn,@description,@httpMethod,@pathTemplate,@requiredCapability,@actionType,@riskLevel,@inputSchema,@outputSchema,@queryMapping,@headerMapping,@bodyMapping,@responseMapping,@timeoutMs,@maxResponseBytes,@idempotencyPolicy,@requiresApprovalDefault,@isEnabled,@createdAt,@updatedAt)
  ON CONFLICT(connector_definition_id,slug) DO UPDATE SET name_ar=excluded.name_ar,name_en=excluded.name_en,description=excluded.description,http_method=excluded.http_method,path_template=excluded.path_template,required_capability=excluded.required_capability,action_type=excluded.action_type,risk_level=excluded.risk_level,input_schema=excluded.input_schema,output_schema=excluded.output_schema,query_mapping=excluded.query_mapping,header_mapping=excluded.header_mapping,body_mapping=excluded.body_mapping,response_mapping=excluded.response_mapping,timeout_ms=excluded.timeout_ms,max_response_bytes=excluded.max_response_bytes,idempotency_policy=excluded.idempotency_policy,requires_approval_default=excluded.requires_approval_default,is_enabled=excluded.is_enabled,updated_at=excluded.updated_at`).run({
   id,connectorDefinitionId,slug:action.slug,nameAr:action.nameAr||action.slug,nameEn:action.nameEn||action.slug,description:action.description||null,
   httpMethod:(action.httpMethod||'GET').toUpperCase(),pathTemplate:action.pathTemplate,requiredCapability:action.requiredCapability,
   actionType:action.actionType||null,riskLevel:action.riskLevel||null,
   inputSchema:action.inputSchema?JSON.stringify(action.inputSchema):null,outputSchema:action.outputSchema?JSON.stringify(action.outputSchema):null,
   queryMapping:action.queryMapping?JSON.stringify(action.queryMapping):null,headerMapping:action.headerMapping?JSON.stringify(action.headerMapping):null,
   bodyMapping:action.bodyMapping?JSON.stringify(action.bodyMapping):null,responseMapping:action.responseMapping?JSON.stringify(action.responseMapping):null,
   timeoutMs:action.timeoutMs||15000,maxResponseBytes:action.maxResponseBytes||2*1024*1024,idempotencyPolicy:action.idempotencyPolicy||'NONE',
   requiresApprovalDefault:action.requiresApprovalDefault===undefined||action.requiresApprovalDefault===null?null:(action.requiresApprovalDefault?1:0),
   isEnabled:action.isEnabled===false?0:1,createdAt:now,updatedAt:now
  });
 return hydrateAction(db.prepare('SELECT * FROM connector_draft_actions WHERE id=?').get(id));
}
export function deleteDraftAction(db,connectorDefinitionId,actionId) {
 db.prepare('DELETE FROM connector_draft_actions WHERE id=? AND connector_definition_id=?').run(actionId,connectorDefinitionId);
}

function hydrateTrigger(row) {
 return {
  id:row.id,slug:row.slug,name:row.name,eventType:row.event_type,
  selectionType:row.selection_type,discriminatorPath:row.discriminator_path,discriminatorValue:row.discriminator_value,
  authentication:{type:row.auth_type,signatureHeader:row.signature_header||undefined,signaturePrefix:row.signature_prefix||undefined,headerName:row.header_name||undefined,allowNone:row.auth_type==='NONE'?true:undefined},
  timestampHeader:row.timestamp_header,timestampPath:row.timestamp_path,maxSkewSeconds:row.max_skew_seconds,
  eventIdPath:row.external_event_id_path,eventIdPolicy:row.external_event_id_policy,
  payloadSchema:row.payload_schema?JSON.parse(row.payload_schema):null,
  mappingDefinition:JSON.parse(row.mapping),normalizedEventType:row.normalized_event_type,
  isEnabled:!!row.is_enabled,createdAt:row.created_at,updatedAt:row.updated_at
 };
}
export function listDraftTriggersForDefinition(db,connectorDefinitionId) {
 return db.prepare('SELECT * FROM connector_draft_triggers WHERE connector_definition_id=? ORDER BY created_at').all(connectorDefinitionId).map(hydrateTrigger);
}
export function upsertDraftTrigger(db,connectorDefinitionId,trigger) {
 const now=new Date().toISOString();
 const existing=db.prepare('SELECT id FROM connector_draft_triggers WHERE connector_definition_id=? AND slug=?').get(connectorDefinitionId,trigger.slug);
 const id=existing?.id||randomUUID();
 db.prepare(`INSERT INTO connector_draft_triggers (id,connector_definition_id,slug,name,event_type,selection_type,discriminator_path,discriminator_value,auth_type,signature_header,signature_prefix,header_name,timestamp_header,timestamp_path,max_skew_seconds,external_event_id_path,external_event_id_policy,payload_schema,mapping,normalized_event_type,is_enabled,created_at,updated_at)
  VALUES (@id,@connectorDefinitionId,@slug,@name,@eventType,@selectionType,@discriminatorPath,@discriminatorValue,@authType,@signatureHeader,@signaturePrefix,@headerName,@timestampHeader,@timestampPath,@maxSkewSeconds,@eventIdPath,@eventIdPolicy,@payloadSchema,@mapping,@normalizedEventType,@isEnabled,@createdAt,@updatedAt)
  ON CONFLICT(connector_definition_id,slug) DO UPDATE SET name=excluded.name,event_type=excluded.event_type,selection_type=excluded.selection_type,discriminator_path=excluded.discriminator_path,discriminator_value=excluded.discriminator_value,auth_type=excluded.auth_type,signature_header=excluded.signature_header,signature_prefix=excluded.signature_prefix,header_name=excluded.header_name,timestamp_header=excluded.timestamp_header,timestamp_path=excluded.timestamp_path,max_skew_seconds=excluded.max_skew_seconds,external_event_id_path=excluded.external_event_id_path,external_event_id_policy=excluded.external_event_id_policy,payload_schema=excluded.payload_schema,mapping=excluded.mapping,normalized_event_type=excluded.normalized_event_type,is_enabled=excluded.is_enabled,updated_at=excluded.updated_at`).run({
   id,connectorDefinitionId,slug:trigger.slug,name:trigger.name||trigger.slug,eventType:trigger.eventType||trigger.slug,
   selectionType:trigger.eventTypeField?'DISCRIMINATOR':'FIXED',discriminatorPath:trigger.eventTypeField||null,discriminatorValue:trigger.eventTypeValue!==undefined?String(trigger.eventTypeValue):null,
   authType:trigger.authentication?.type||'NONE',signatureHeader:trigger.authentication?.signatureHeader||null,signaturePrefix:trigger.authentication?.signaturePrefix||null,headerName:trigger.authentication?.headerName||null,
   timestampHeader:trigger.timestampHeader||null,timestampPath:trigger.timestampPath||null,maxSkewSeconds:trigger.maxSkewSeconds||null,
   eventIdPath:trigger.eventIdPath||null,eventIdPolicy:trigger.eventIdPolicy||'OPTIONAL',
   payloadSchema:trigger.payloadSchema?JSON.stringify(trigger.payloadSchema):null,
   mapping:JSON.stringify(trigger.mappingDefinition||{}),normalizedEventType:trigger.normalizedEventType,
   isEnabled:trigger.isEnabled===false?0:1,createdAt:now,updatedAt:now
  });
 return hydrateTrigger(db.prepare('SELECT * FROM connector_draft_triggers WHERE id=?').get(id));
}
export function deleteDraftTrigger(db,connectorDefinitionId,triggerId) {
 db.prepare('DELETE FROM connector_draft_triggers WHERE id=? AND connector_definition_id=?').run(triggerId,connectorDefinitionId);
}
