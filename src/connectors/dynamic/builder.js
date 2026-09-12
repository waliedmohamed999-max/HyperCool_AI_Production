// Universal Integration Platform (Phase 6D) — the Integration Builder's backend: Platform
// Admin-only lifecycle for a dynamic (GENERIC_REST) Connector Definition. Every mutation here
// is declarative data only (Part 21) — no code, no eval, no module path ever stored or loaded.
import {randomUUID} from 'node:crypto';
import {getIntegrationDefinition,listIntegrationDefinitions} from '../../integrations/definitions.js';
import {listActionsForDefinition,upsertAction as storeUpsertAction,deleteAction as storeDeleteAction,listTriggersForDefinition,upsertTrigger as storeUpsertTrigger,deleteTrigger as storeDeleteTrigger,saveVersionSnapshot} from './store.js';
import {hydrateAndValidate} from './hydrate.js';
import {isKnownCapability} from '../core/capability-registry.js';
import {validateOutboundUrl} from '../core/ssrf.js';

function fail(status,code,message){const e=new Error(message||code);e.status=status;e.code=code;throw e;}

// getIntegrationDefinition (definitions.js) looks up by SLUG only — every Builder function
// here is addressed by the definition's real row id (its stable, permanent identifier; a
// definition's slug is set once at creation and never changes, but callers pass the id).
function getDefinitionById(db,id) {
 return listIntegrationDefinitions(db).find(d=>d.id===id)||null;
}

function requirePlatformAdmin(env,user) {
 // Reuses the EXACT same allowlist mechanism Platform Operations (Phase 4C-7) already uses —
 // never a second, parallel admin concept.
 const allowlist=(env.PLATFORM_ADMIN_USERNAMES||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
 if(!user?.username||!allowlist.includes(user.username.toLowerCase()))fail(403,'PLATFORM_ADMIN_REQUIRED','هذا الإجراء متاح فقط لمسؤول المنصة');
}

// --- Draft lifecycle (Part 39/43) ------------------------------------------------------------

export function createDraftConnector(db,env,actorUser,input) {
 requirePlatformAdmin(env,actorUser);
 const slug=String(input.slug||'').toLowerCase();
 if(!/^[a-z][a-z0-9_-]*$/.test(slug))fail(400,'INVALID_SLUG','slug يجب أن يكون أحرفًا لاتينية صغيرة/أرقام/شرطات فقط');
 if(getIntegrationDefinition(db,slug))fail(409,'SLUG_TAKEN','يوجد Connector بنفس الـslug بالفعل');
 if(!['GENERIC_REST'].includes(input.adapterType))fail(400,'INVALID_ADAPTER_TYPE','النوع المدعوم ديناميكيًا حاليًا هو GENERIC_REST فقط — BUILT_IN/AI_PROVIDER محجوزان لموصلات الكود الحقيقية');
 if(!['MULTI','SINGLE'].includes(input.connectionMode))fail(400,'INVALID_CONNECTION_MODE','connectionMode يجب أن يكون MULTI أو SINGLE');
 const authType=input.auth?.type;
 if(!['NONE','API_KEY','BEARER_TOKEN','BASIC'].includes(authType))fail(400,'INVALID_AUTH_TYPE','نوع مصادقة غير مدعوم — OAuth2 العام مؤجَّل عمدًا (راجع التوثيق)');
 if(authType==='NONE' && input.auth?.allowNone!==true)fail(400,'INVALID_AUTH_TYPE','auth.type=NONE يتطلب allowNone:true صراحة');
 if(authType==='API_KEY' && !input.auth?.headerName)fail(400,'INVALID_AUTH_TYPE','API_KEY يتطلب headerName حقيقيًا');
 // Part 85 — the base URL is validated through the SAME SSRF module 6B built; an unsafe host
 // (localhost/private IP/metadata endpoint) can never even be SAVED, not just blocked at runtime.
 if(!input.rest?.baseUrl)fail(400,'INVALID_BASE_URL','rest.baseUrl مطلوب');
 try{validateOutboundUrl(input.rest.baseUrl,{allowHttp:input.rest.allowHttp===true});}
 catch(error){fail(400,'UNSAFE_BASE_URL',`rest.baseUrl غير آمن: ${error.message}`);}
 const capabilities=input.capabilities||[];
 for(const capability of capabilities)
  if(!isKnownCapability(capability))fail(400,'UNKNOWN_CAPABILITY',`القدرة غير معروفة في السجل المركزي: ${capability}`);

 const now=new Date().toISOString();
 const id=randomUUID();
 db.prepare(`INSERT INTO integration_definitions (id,slug,name_ar,name_en,category,description_ar,description_en,auth_type,icon_key,capabilities,is_available,status,version,adapter_type,adapter_key,connection_mode_override,is_system,created_by_user_id,rest_config,auth_config,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  id,slug,input.nameAr||slug,input.nameEn||slug,(input.category||'custom').toLowerCase(),input.descriptionAr||'',input.descriptionEn||'',
  ['API_KEY','OAUTH2'].includes(authType)?authType:'CUSTOM',input.iconKey||'custom',JSON.stringify(capabilities),0,
  'DRAFT',1,input.adapterType,slug,input.connectionMode,0,actorUser.id,
  JSON.stringify(input.rest),JSON.stringify(input.auth),now,now
 );
 return getDefinitionById(db,id);
}

export function updateDraftConnector(db,env,actorUser,id,patch) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireEditableDefinition(db,id);
 if(patch.capabilities)
  for(const capability of patch.capabilities)
   if(!isKnownCapability(capability))fail(400,'UNKNOWN_CAPABILITY',`القدرة غير معروفة في السجل المركزي: ${capability}`);
 if(patch.rest?.baseUrl) {
  try{validateOutboundUrl(patch.rest.baseUrl,{allowHttp:patch.rest.allowHttp===true});}
  catch(error){fail(400,'UNSAFE_BASE_URL',`rest.baseUrl غير آمن: ${error.message}`);}
 }
 // The SAME real checks createDraftConnector already runs at creation time — an edit to an
 // already-published definition's auth config must be held to the exact same bar, never a
 // weaker one just because this is an update rather than a create (Part 11's publish-time
 // validation is a second, independent layer — this is the first).
 if(patch.auth) {
  const authType=patch.auth.type;
  if(!['NONE','API_KEY','BEARER_TOKEN','BASIC'].includes(authType))fail(400,'INVALID_AUTH_TYPE','نوع مصادقة غير مدعوم — OAuth2 العام مؤجَّل عمدًا (راجع التوثيق)');
  if(authType==='NONE' && patch.auth.allowNone!==true)fail(400,'INVALID_AUTH_TYPE','auth.type=NONE يتطلب allowNone:true صراحة');
  if(authType==='API_KEY' && !patch.auth.headerName)fail(400,'INVALID_AUTH_TYPE','API_KEY يتطلب headerName حقيقيًا');
 }
 const now=new Date().toISOString();
 db.prepare(`UPDATE integration_definitions SET name_ar=COALESCE(?,name_ar),name_en=COALESCE(?,name_en),description_ar=COALESCE(?,description_ar),description_en=COALESCE(?,description_en),category=COALESCE(?,category),capabilities=COALESCE(?,capabilities),rest_config=COALESCE(?,rest_config),auth_config=COALESCE(?,auth_config),updated_at=? WHERE id=?`)
  .run(patch.nameAr||null,patch.nameEn||null,patch.descriptionAr||null,patch.descriptionEn||null,patch.category?.toLowerCase()||null,
   patch.capabilities?JSON.stringify(patch.capabilities):null,patch.rest?JSON.stringify({...definition.restConfig,...patch.rest}):null,
   patch.auth?JSON.stringify(patch.auth):null,now,id);
 return getDefinitionById(db,id);
}

// Phase 6D, Part 109 (version policy B — "published definition immutable snapshot; the live
// row is a working copy; a new publish creates a new active version; existing connections stay
// pinned to whichever version they were created against via connector_definition_versions").
// A definition may be edited while DRAFT (never yet published) or PUBLISHED (edits accumulate
// on the live row and only take effect for the NEXT publish + any connection created after it —
// see resolveConnectorDynamic's connectorVersion pinning). DISABLED and system connectors are
// never editable here.
function requireEditableDefinition(db,id) {
 const definition=getDefinitionById(db,id);
 if(!definition)fail(404,'CONNECTOR_NOT_FOUND','لا يوجد Connector بهذا المعرّف');
 if(definition.isSystem)fail(400,'SYSTEM_CONNECTOR_READONLY','لا يمكن تعديل موصل نظامي مبني بالكود');
 if(definition.status==='DISABLED')fail(400,'CONNECTOR_DISABLED','لا يمكن تعديل موصل معطَّل — أعد تفعيله أولًا');
 return definition;
}
function requireOwnDefinition(db,id) {
 const definition=getDefinitionById(db,id);
 if(!definition)fail(404,'CONNECTOR_NOT_FOUND','لا يوجد Connector بهذا المعرّف');
 return definition;
}

// --- Actions / Triggers (draft only) ----------------------------------------------------------

export function upsertActionForConnector(db,env,actorUser,definitionId,action) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireEditableDefinition(db,definitionId);
 if(!action.slug||!action.pathTemplate||!action.requiredCapability)fail(400,'INVALID_ACTION','slug/pathTemplate/requiredCapability مطلوبة');
 if(!isKnownCapability(action.requiredCapability))fail(400,'UNKNOWN_CAPABILITY',`القدرة غير معروفة: ${action.requiredCapability}`);
 const declaredCapabilities=definition.capabilities||[];
 if(!declaredCapabilities.includes(action.requiredCapability))
  fail(400,'CAPABILITY_NOT_DECLARED',`القدرة ${action.requiredCapability} لم تُعلَن بعد في خطوة Capabilities لهذا الـConnector`);
 return storeUpsertAction(db,definitionId,action);
}
export function deleteActionForConnector(db,env,actorUser,definitionId,actionId) {
 requirePlatformAdmin(env,actorUser);
 requireEditableDefinition(db,definitionId);
 storeDeleteAction(db,definitionId,actionId);
}
export function listActions(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 requireOwnDefinition(db,definitionId);
 return listActionsForDefinition(db,definitionId);
}

export function upsertTriggerForConnector(db,env,actorUser,definitionId,trigger) {
 requirePlatformAdmin(env,actorUser);
 requireEditableDefinition(db,definitionId);
 if(!trigger.slug||!trigger.normalizedEventType||!trigger.mappingDefinition)fail(400,'INVALID_TRIGGER','slug/normalizedEventType/mappingDefinition مطلوبة');
 return storeUpsertTrigger(db,definitionId,trigger);
}
export function deleteTriggerForConnector(db,env,actorUser,definitionId,triggerId) {
 requirePlatformAdmin(env,actorUser);
 requireEditableDefinition(db,definitionId);
 storeDeleteTrigger(db,definitionId,triggerId);
}
export function listTriggers(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 requireOwnDefinition(db,definitionId);
 return listTriggersForDefinition(db,definitionId);
}

// --- Test / Preview (Part 73/74/83) -----------------------------------------------------------

/** Validates the CURRENT draft state without publishing — the same real validator publish uses. */
export function validateConnectorDraft(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireOwnDefinition(db,definitionId);
 const {manifest}=hydrateAndValidate(db,definition.slug);
 return {ok:true,manifest};
}

// --- Publish / Disable (Part 37/38/40/41) ------------------------------------------------------

export function publishConnector(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireOwnDefinition(db,definitionId);
 if(definition.isSystem)fail(400,'SYSTEM_CONNECTOR_READONLY','موصلات النظام منشورة بالفعل ولا تُنشر من هنا');
 if(definition.status==='DISABLED')fail(400,'CONNECTOR_DISABLED','أعد تفعيل الموصل قبل نشر تعديلات جديدة عليه');
 // Part 37/38 — the exact same real validator (validateManifest/validateRestManifest/
 // validateWebhookManifest) that runtime resolution itself uses. A publish blocker here is
 // IDENTICAL to a runtime failure — never a separate, weaker Builder-only check.
 const {manifest}=hydrateAndValidate(db,definition.slug);
 // Part 109 (policy B): the FIRST publish uses the version already set at draft creation (1);
 // every SUBSEQUENT publish (editing an already-published definition) bumps it — a real, new,
 // immutable snapshot every time, never silently mutating the previous one.
 const newVersion=definition.publishedAt?definition.version+1:definition.version;
 const now=new Date().toISOString();
 db.prepare('UPDATE integration_definitions SET status=?,version=?,is_available=1,published_at=?,updated_at=? WHERE id=?')
  .run('PUBLISHED',newVersion,now,now,definitionId);
 saveVersionSnapshot(db,definitionId,newVersion,{...manifest,version:newVersion},actorUser.id);
 return getDefinitionById(db,definitionId);
}
export function disableConnector(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireOwnDefinition(db,definitionId);
 if(definition.isSystem)fail(400,'SYSTEM_CONNECTOR_READONLY','لا يمكن تعطيل موصل نظامي مبني بالكود من هنا');
 db.prepare("UPDATE integration_definitions SET status='DISABLED',updated_at=? WHERE id=?").run(new Date().toISOString(),definitionId);
 return getDefinitionById(db,definitionId);
}
export function reactivateConnector(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireOwnDefinition(db,definitionId);
 if(definition.status!=='DISABLED')fail(400,'NOT_DISABLED','هذا الموصل ليس معطَّلًا');
 db.prepare("UPDATE integration_definitions SET status='PUBLISHED',updated_at=? WHERE id=?").run(new Date().toISOString(),definitionId);
 return getDefinitionById(db,definitionId);
}

// --- Dependency check (Part 92, extended Phase 6F Part 50/51) -----------------------------------

export function getConnectorDependencies(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireOwnDefinition(db,definitionId);
 const connections=db.prepare('SELECT COUNT(*) c FROM integration_connections WHERE integration_definition_id=?').get(definition.slug).c;
 const tenants=db.prepare('SELECT COUNT(DISTINCT tenant_id) c FROM integration_connections WHERE integration_definition_id=?').get(definition.slug).c;
 // Phase 6F, Part 50/51 — the real "who is affected if I disable/change this" picture: every
 // real agent_tool_assignments row pointing at one of this connector's connections, and every
 // real trigger this definition itself declares. Never a guess — both are live COUNT queries.
 const agentAssignments=db.prepare(`SELECT COUNT(*) c FROM agent_tool_assignments a JOIN integration_connections c2 ON c2.id=a.connection_id WHERE c2.integration_definition_id=? AND a.enabled=1`).get(definition.slug).c;
 const webhookTriggers=definition.isSystem?0:db.prepare('SELECT COUNT(*) c FROM connector_triggers WHERE connector_definition_id=?').get(definition.id).c;
 return {connections,tenants,agentAssignments,webhookTriggers};
}

// --- Clone (Part 7/23/24) ------------------------------------------------------------------------

/** Clones a real, existing GENERIC_REST connector's declarative shape (auth config, capabilities,
 * base URL, actions, triggers) into a brand-new DRAFT definition — NEVER credentials (there are
 * none on a definition to begin with; only integration_connections+Vault hold those, and this
 * function never touches either table). A system (BUILT_IN/AI_PROVIDER) connector cannot be
 * cloned this way — its real behavior lives in code, not in connector_actions/connector_triggers,
 * so "cloning" it here would silently produce an empty, non-functional draft. */
export function cloneConnectorDefinition(db,env,actorUser,definitionId,newSlug) {
 requirePlatformAdmin(env,actorUser);
 const source=requireOwnDefinition(db,definitionId);
 if(source.isSystem)fail(400,'SYSTEM_CONNECTOR_READONLY','لا يمكن استنساخ موصل نظامي مبني بالكود — لا توجد بيانات Builder حقيقية لاستنساخها');
 const created=createDraftConnector(db,env,actorUser,{
  slug:newSlug,nameAr:`${source.nameAr} (نسخة)`,nameEn:`${source.nameEn} (Copy)`,category:source.category,
  descriptionAr:source.descriptionAr,descriptionEn:source.descriptionEn,adapterType:source.adapterType,
  connectionMode:source.connectionMode,auth:source.authConfig,capabilities:source.capabilities,rest:source.restConfig
 });
 for(const action of listActionsForDefinition(db,source.id))upsertActionForConnector(db,env,actorUser,created.id,action);
 for(const trigger of listTriggersForDefinition(db,source.id))upsertTriggerForConnector(db,env,actorUser,created.id,triggerToUpsertInput(trigger));
 return getDefinitionById(db,created.id);
}
/** `listTriggersForDefinition`'s hydrated shape (`discriminatorPath`/`discriminatorValue`) is
 * NOT the same shape `upsertTriggerForConnector`/store.js's `upsertTrigger` expects as INPUT
 * (`eventTypeField`/`eventTypeValue`) — a real, easy-to-miss asymmetry between this module's own
 * read and write contracts. Centralized here once so Clone/Export/Import never re-diverge on it. */
function triggerToUpsertInput(trigger) {
 return {...trigger,eventTypeField:trigger.discriminatorPath||undefined,eventTypeValue:trigger.discriminatorValue||undefined};
}

// --- Export / Import (Part 8/9/22) ----------------------------------------------------------------

/** Safe, portable JSON — declarative shape only. Never includes a credential/token/secret
 * (definitions never hold one; only integration_connections+Vault do, and neither is read here). */
export function exportConnectorDefinition(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireOwnDefinition(db,definitionId);
 if(definition.isSystem)fail(400,'SYSTEM_CONNECTOR_READONLY','لا يمكن تصدير موصل نظامي مبني بالكود');
 return {
  formatVersion:1,slug:definition.slug,nameAr:definition.nameAr,nameEn:definition.nameEn,category:definition.category,
  descriptionAr:definition.descriptionAr,descriptionEn:definition.descriptionEn,adapterType:definition.adapterType,
  connectionMode:definition.connectionMode,auth:definition.authConfig,rest:definition.restConfig,capabilities:definition.capabilities,
  actions:listActionsForDefinition(db,definition.id),triggers:listTriggersForDefinition(db,definition.id)
 };
}
/** Imported data is NEVER trusted directly — every field re-enters through the EXACT SAME
 * validated entry points (createDraftConnector/upsertActionForConnector/upsertTriggerForConnector)
 * a Platform Admin typing the same values into the wizard would go through: slug format, SSRF,
 * known-capability, capability-declared-before-action, known-event-type. A malformed or
 * malicious export can fail loudly here but can never bypass a single one of those checks. */
export function importConnectorDefinition(db,env,actorUser,exported,{slug}={}) {
 requirePlatformAdmin(env,actorUser);
 if(!exported||typeof exported!=='object')fail(400,'INVALID_IMPORT','ملف الاستيراد غير صالح');
 if(!Array.isArray(exported.actions))fail(400,'INVALID_IMPORT','actions يجب أن تكون مصفوفة');
 if(!Array.isArray(exported.triggers))fail(400,'INVALID_IMPORT','triggers يجب أن تكون مصفوفة');
 const created=createDraftConnector(db,env,actorUser,{
  slug:slug||exported.slug,nameAr:exported.nameAr,nameEn:exported.nameEn,category:exported.category,
  descriptionAr:exported.descriptionAr,descriptionEn:exported.descriptionEn,adapterType:exported.adapterType,
  connectionMode:exported.connectionMode,auth:exported.auth,capabilities:exported.capabilities,rest:exported.rest
 });
 for(const action of exported.actions)upsertActionForConnector(db,env,actorUser,created.id,action);
 for(const trigger of exported.triggers)upsertTriggerForConnector(db,env,actorUser,created.id,triggerToUpsertInput(trigger));
 return getDefinitionById(db,created.id);
}

// --- Platform Builder listing (Part 22/63) ------------------------------------------------------

export function listConnectorsForBuilder(db,env,actorUser) {
 requirePlatformAdmin(env,actorUser);
 return listIntegrationDefinitions(db).map(d=>{
  const deps=db.prepare('SELECT COUNT(*) c FROM integration_connections WHERE integration_definition_id=?').get(d.slug).c;
  // Real, cheap counts for the Builder landing table's Actions/Webhooks columns (Part 5) — a
  // system connector (Salla/Zid/...) has zero rows in these tables by design (its actions live
  // in code, not connector_actions/connector_triggers), so this honestly reports 0 for those.
  const actionsCount=db.prepare('SELECT COUNT(*) c FROM connector_actions WHERE connector_definition_id=?').get(d.id).c;
  const triggersCount=db.prepare('SELECT COUNT(*) c FROM connector_triggers WHERE connector_definition_id=?').get(d.id).c;
  return {...d,connectionsCount:deps,actionsCount,triggersCount};
 });
}

/** One connector's full Builder view: definition + its actions/triggers/dependency counts — the
 * shape the wizard's Review step and the connector detail screen both read from. */
export function getConnectorForBuilder(db,env,actorUser,id) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireOwnDefinition(db,id);
 const deps=db.prepare('SELECT COUNT(*) c FROM integration_connections WHERE integration_definition_id=?').get(definition.slug).c;
 const tenants=db.prepare('SELECT COUNT(DISTINCT tenant_id) c FROM integration_connections WHERE integration_definition_id=?').get(definition.slug).c;
 return {
  ...definition,connectionsCount:deps,tenantsCount:tenants,
  actions:definition.isSystem?[]:listActionsForDefinition(db,id),
  triggers:definition.isSystem?[]:listTriggersForDefinition(db,id)
 };
}

// --- Tenant-facing catalog (Part 26/27/39/40) ---------------------------------------------------

/** Published, available, non-disabled connectors only — safe metadata, no secrets, no draft. */
export function getTenantCatalog(db) {
 return listIntegrationDefinitions(db)
  .filter(d=>d.status==='PUBLISHED')
  .map(d=>({slug:d.slug,nameAr:d.nameAr,nameEn:d.nameEn,category:d.category,descriptionAr:d.descriptionAr,descriptionEn:d.descriptionEn,
   iconKey:d.iconKey,capabilities:d.capabilities,isAvailable:d.isAvailable,connectionMode:d.connectionMode,authType:d.authConfig?.type||d.authType}));
}
