// Universal Integration Platform (Phase 6D) — persistent storage for dynamic Connector
// Definitions' actions, triggers, and published-version snapshots. `integration_definitions`
// itself (extended in src/integrations/definitions.js) remains the ONE canonical definition
// row; these are its child tables — never a second, parallel definition model.
import {randomUUID} from 'node:crypto';

export function installDynamicConnectorTables(db) {
 db.exec(`
  CREATE TABLE IF NOT EXISTS connector_actions (
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
  CREATE INDEX IF NOT EXISTS idx_connector_actions_definition ON connector_actions(connector_definition_id);

  CREATE TABLE IF NOT EXISTS connector_triggers (
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
  CREATE INDEX IF NOT EXISTS idx_connector_triggers_definition ON connector_triggers(connector_definition_id);

  -- Phase 6D, Part 42/108/109 (version policy A — "connections pin published version"): a
  -- frozen, already-validated manifest snapshot per publish. A live connection keeps behaving
  -- exactly as it did when created, even after a later draft/publish changes the definition.
  CREATE TABLE IF NOT EXISTS connector_definition_versions (
   id TEXT PRIMARY KEY,
   connector_definition_id TEXT NOT NULL,
   version INTEGER NOT NULL,
   manifest_snapshot TEXT NOT NULL,
   published_at TEXT NOT NULL,
   published_by_user_id TEXT,
   UNIQUE(connector_definition_id,version)
  );
  CREATE INDEX IF NOT EXISTS idx_connector_versions_definition ON connector_definition_versions(connector_definition_id);
 `);
 // integration_connections needs to remember which connector version it was created/validated
 // against (Part 45) — additive, guarded, matching the codebase's own established pattern.
 const connectionColumns=db.prepare('PRAGMA table_info(integration_connections)').all().map(c=>c.name);
 if(!connectionColumns.includes('connector_version'))db.exec('ALTER TABLE integration_connections ADD COLUMN connector_version INTEGER');
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
export function listActionsForDefinition(db,connectorDefinitionId) {
 return db.prepare('SELECT * FROM connector_actions WHERE connector_definition_id=? ORDER BY created_at').all(connectorDefinitionId).map(hydrateAction);
}
export function upsertAction(db,connectorDefinitionId,action) {
 const now=new Date().toISOString();
 const existing=db.prepare('SELECT id FROM connector_actions WHERE connector_definition_id=? AND slug=?').get(connectorDefinitionId,action.slug);
 const id=existing?.id||randomUUID();
 db.prepare(`INSERT INTO connector_actions (id,connector_definition_id,slug,name_ar,name_en,description,http_method,path_template,required_capability,action_type,risk_level,input_schema,output_schema,query_mapping,header_mapping,body_mapping,response_mapping,timeout_ms,max_response_bytes,idempotency_policy,requires_approval_default,is_enabled,created_at,updated_at)
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
 return db.prepare('SELECT * FROM connector_actions WHERE id=?').get(id) ? hydrateAction(db.prepare('SELECT * FROM connector_actions WHERE id=?').get(id)) : null;
}
export function deleteAction(db,connectorDefinitionId,actionId) {
 db.prepare('DELETE FROM connector_actions WHERE id=? AND connector_definition_id=?').run(actionId,connectorDefinitionId);
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
export function listTriggersForDefinition(db,connectorDefinitionId) {
 return db.prepare('SELECT * FROM connector_triggers WHERE connector_definition_id=? ORDER BY created_at').all(connectorDefinitionId).map(hydrateTrigger);
}
export function upsertTrigger(db,connectorDefinitionId,trigger) {
 const now=new Date().toISOString();
 const existing=db.prepare('SELECT id FROM connector_triggers WHERE connector_definition_id=? AND slug=?').get(connectorDefinitionId,trigger.slug);
 const id=existing?.id||randomUUID();
 db.prepare(`INSERT INTO connector_triggers (id,connector_definition_id,slug,name,event_type,selection_type,discriminator_path,discriminator_value,auth_type,signature_header,signature_prefix,header_name,timestamp_header,timestamp_path,max_skew_seconds,external_event_id_path,external_event_id_policy,payload_schema,mapping,normalized_event_type,is_enabled,created_at,updated_at)
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
 return hydrateTrigger(db.prepare('SELECT * FROM connector_triggers WHERE id=?').get(id));
}
export function deleteTrigger(db,connectorDefinitionId,triggerId) {
 db.prepare('DELETE FROM connector_triggers WHERE id=? AND connector_definition_id=?').run(triggerId,connectorDefinitionId);
}

export function saveVersionSnapshot(db,connectorDefinitionId,version,manifest,publishedByUserId) {
 const now=new Date().toISOString();
 db.prepare('INSERT OR REPLACE INTO connector_definition_versions (id,connector_definition_id,version,manifest_snapshot,published_at,published_by_user_id) VALUES (?,?,?,?,?,?)')
  .run(randomUUID(),connectorDefinitionId,version,JSON.stringify(manifest),now,publishedByUserId||null);
}
export function getVersionSnapshot(db,connectorDefinitionId,version) {
 const row=db.prepare('SELECT manifest_snapshot FROM connector_definition_versions WHERE connector_definition_id=? AND version=?').get(connectorDefinitionId,version);
 return row?JSON.parse(row.manifest_snapshot):null;
}
