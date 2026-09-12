// Universal Integration Platform (Phase 6A, Part 4) — the one Connector Manifest schema every
// provider (existing or future) is described by. A manifest is pure, static, JSON-serializable
// data — it never holds a decrypted credential (Part 16) and never itself performs I/O.
import {CONNECTOR_CATEGORY,CONNECTOR_AVAILABILITY,CONNECTION_MODE,AUTH_TYPE,ACTION_TYPE,RISK_LEVEL,IDEMPOTENCY_POLICY} from './enums.js';
import {canonicalizeCapability} from './capability-registry.js';

function fail(message){const e=new Error(message);e.status=400;throw e;}

/**
 * Validates and normalizes a raw manifest object (Part 4's conceptual schema). Throws a
 * descriptive error on any structural problem — never silently drops or invents a field.
 * Returns a NEW object (capabilities/actions canonicalized), the input is never mutated.
 */
export function validateManifest(raw) {
 if(!raw||typeof raw!=='object')fail('Connector manifest must be an object');
 for(const field of ['id','slug','nameAr','nameEn','category','version','availability','connectionMode','auth'])
  if(raw[field]===undefined||raw[field]===null)fail(`Connector manifest missing required field: ${field}`);
 if(!/^[a-z][a-z0-9_-]*$/.test(raw.slug))fail(`Connector slug must be lowercase alphanumeric/dash/underscore: ${raw.slug}`);
 if(!Object.values(CONNECTOR_CATEGORY).includes(raw.category))fail(`Unknown connector category: ${raw.category}`);
 if(!Object.values(CONNECTOR_AVAILABILITY).includes(raw.availability))fail(`Unknown connector availability: ${raw.availability}`);
 if(!Object.values(CONNECTION_MODE).includes(raw.connectionMode))fail(`Unknown connectionMode: ${raw.connectionMode}`);
 if(!raw.auth||!Object.values(AUTH_TYPE).includes(raw.auth.type))fail(`Unknown auth.type: ${raw.auth?.type}`);
 if(raw.auth.type==='OAUTH2') {
  if(typeof raw.auth.authorizeUrl!=='string'||!raw.auth.authorizeUrl.startsWith('https://'))fail('OAuth2 auth.authorizeUrl must be a real https:// URL');
  if(typeof raw.auth.tokenUrl!=='string'||!raw.auth.tokenUrl.startsWith('https://'))fail('OAuth2 auth.tokenUrl must be a real https:// URL');
 }
 // DEFINITION_ONLY/NOT_IMPLEMENTED connectors are explicitly allowed to have zero actions —
 // that IS the honest state (Part 5/85/88) rather than a validation failure.
 const actions=(raw.actions||[]).map(action=>validateAction(action,raw.slug));
 const triggers=(raw.triggers||[]).map(trigger=>validateTrigger(trigger,raw.slug));
 const capabilities=[...new Set((raw.capabilities||[]).map(canonicalizeCapability))];
 for(const action of actions)
  if(!capabilities.includes(action.requiredCapability))fail(`Connector ${raw.slug}: action ${action.slug} requires capability ${action.requiredCapability} not declared in manifest.capabilities`);
 return {
  id:raw.id,slug:raw.slug,nameAr:raw.nameAr,nameEn:raw.nameEn,
  descriptionAr:raw.descriptionAr||'',descriptionEn:raw.descriptionEn||'',
  category:raw.category,version:raw.version,availability:raw.availability,connectionMode:raw.connectionMode,
  auth:raw.auth,capabilities,actions,triggers,
  webhooks:raw.webhooks||null,health:raw.health||null,identity:raw.identity||null,
  metadataSchema:raw.metadataSchema||null
 };
}

function validateAction(action,connectorSlug) {
 for(const field of ['id','slug','method','requiredCapability','riskLevel','actionType'])
  if(!action||action[field]===undefined||action[field]===null)fail(`Connector ${connectorSlug}: action missing required field: ${field}`);
 if(!Object.values(RISK_LEVEL).includes(action.riskLevel))fail(`Connector ${connectorSlug}: action ${action.slug} has unknown riskLevel ${action.riskLevel}`);
 if(!Object.values(ACTION_TYPE).includes(action.actionType))fail(`Connector ${connectorSlug}: action ${action.slug} has unknown actionType ${action.actionType}`);
 // Part 94 — a write-shaped action can never silently default to LOW risk.
 const writeShaped=['EXTERNAL_WRITE','EXTERNAL_SEND','EXTERNAL_PUBLISH','DESTRUCTIVE'].includes(action.actionType);
 if(writeShaped && action.riskLevel==='LOW')fail(`Connector ${connectorSlug}: action ${action.slug} is ${action.actionType} and cannot declare riskLevel LOW`);
 const idempotencyPolicy=action.idempotencyPolicy||IDEMPOTENCY_POLICY.NONE;
 if(!Object.values(IDEMPOTENCY_POLICY).includes(idempotencyPolicy))fail(`Connector ${connectorSlug}: action ${action.slug} has unknown idempotencyPolicy`);
 return {
  id:action.id,slug:action.slug,nameAr:action.nameAr||action.slug,nameEn:action.nameEn||action.slug,
  description:action.description||'',method:action.method,
  requiredCapability:canonicalizeCapability(action.requiredCapability),
  riskLevel:action.riskLevel,actionType:action.actionType,
  inputSchema:action.inputSchema||null,outputSchema:action.outputSchema||null,
  timeoutMs:action.timeoutMs||15000,idempotencyPolicy,
  // Part 95 — an EXTERNAL_*/DESTRUCTIVE action defaults to requiring approval unless a
  // connector explicitly, deliberately opts out (never the other way around).
  requiresApprovalDefault:action.requiresApprovalDefault??writeShaped
 };
}

function validateTrigger(trigger,connectorSlug) {
 for(const field of ['id','slug','eventType'])
  if(!trigger||trigger[field]===undefined||trigger[field]===null)fail(`Connector ${connectorSlug}: trigger missing required field: ${field}`);
 return {
  id:trigger.id,slug:trigger.slug,name:trigger.name||trigger.slug,eventType:trigger.eventType,
  payloadSchema:trigger.payloadSchema||null,eventIdPath:trigger.eventIdPath||null,
  timestampPath:trigger.timestampPath||null,mappingDefinition:trigger.mappingDefinition||null
 };
}
