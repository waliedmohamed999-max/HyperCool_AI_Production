// Universal Integration Platform (Phase 6D) — the Integration Builder's backend: Platform
// Admin-only lifecycle for a dynamic (GENERIC_REST) Connector Definition. Every mutation here
// is declarative data only (Part 21) — no code, no eval, no module path ever stored or loaded.
import {randomUUID} from 'node:crypto';
import {getIntegrationDefinition,listIntegrationDefinitions} from '../../integrations/definitions.js';
import {listActionsForDefinition,upsertAction as storeUpsertAction,deleteAction as storeDeleteAction,listTriggersForDefinition,upsertTrigger as storeUpsertTrigger,deleteTrigger as storeDeleteTrigger,saveVersionSnapshot,listVersionSnapshotsForDefinition,getVersionSnapshot} from './store.js';
import {
 getDraftMeta,hasDraftOverlay,createDraftMeta,updateDraftMeta,deleteDraftOverlay,
 listDraftActionsForDefinition,upsertDraftAction,deleteDraftAction,
 listDraftTriggersForDefinition,upsertDraftTrigger,deleteDraftTrigger
} from './draft-store.js';
import {hydrateAndValidate,buildRawManifest} from './hydrate.js';
import {validateRestManifest} from '../generic-rest/manifest.js';
import {validateWebhookManifest} from '../generic-webhook/manifest.js';
import {isKnownCapability} from '../core/capability-registry.js';
import {validateOutboundUrl} from '../core/ssrf.js';

// Phase 6G, Part 18/19/20 — the Generic OAuth2 Framework's own config validator, shared by
// create/update so a Platform Admin can define a brand-new OAuth2 connector (authorizationUrl/
// tokenUrl/scopes/PKCE/identity endpoint/token field mappings/client credential ENV KEY
// references) entirely through the Builder — never a tenant-editable URL (Part 20), never a
// plaintext client secret on the definition (Part 21 — only an env var NAME is stored; the real
// secret value lives in process env, resolved at call time by src/runtime/generic-oauth2.js).
const ENV_KEY_RE=/^[A-Z][A-Z0-9_]*$/;
function validateOAuth2Config(auth,fail) {
 // Field name matches src/connectors/core/manifest.js's own OAUTH2 validation exactly
 // (`raw.auth.authorizeUrl`) — one shared vocabulary, not a second one at the Builder layer.
 if(!auth?.authorizeUrl)fail(400,'INVALID_AUTH_TYPE','OAUTH2 يتطلب authorizeUrl');
 if(!auth?.tokenUrl)fail(400,'INVALID_AUTH_TYPE','OAUTH2 يتطلب tokenUrl');
 try{validateOutboundUrl(auth.authorizeUrl,{allowHttp:false});}
 catch(error){fail(400,'UNSAFE_AUTHORIZATION_URL',`authorizeUrl غير آمن: ${error.message}`);}
 try{validateOutboundUrl(auth.tokenUrl,{allowHttp:false});}
 catch(error){fail(400,'UNSAFE_TOKEN_URL',`tokenUrl غير آمن: ${error.message}`);}
 if(auth.identityEndpoint) {
  try{validateOutboundUrl(auth.identityEndpoint,{allowHttp:false});}
  catch(error){fail(400,'UNSAFE_IDENTITY_ENDPOINT',`identityEndpoint غير آمن: ${error.message}`);}
 }
 if(auth.scopes!==undefined && !Array.isArray(auth.scopes))fail(400,'INVALID_AUTH_TYPE','scopes يجب أن تكون مصفوفة نصوص');
 if(!['body','basic'].includes(auth.clientAuthMethod||'body'))fail(400,'INVALID_AUTH_TYPE','clientAuthMethod يجب أن يكون body أو basic');
 if(!auth.clientIdEnvKey||!ENV_KEY_RE.test(auth.clientIdEnvKey))fail(400,'INVALID_AUTH_TYPE','clientIdEnvKey يجب أن يكون اسم متغيّر بيئة صالح (أحرف كبيرة/أرقام/شرطة سفلية)');
 if(!auth.clientSecretEnvKey||!ENV_KEY_RE.test(auth.clientSecretEnvKey))fail(400,'INVALID_AUTH_TYPE','clientSecretEnvKey يجب أن يكون اسم متغيّر بيئة صالح — لا يُخزَّن أي سر فعلي هنا');
}

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
 if(!['NONE','API_KEY','BEARER_TOKEN','BASIC','OAUTH2'].includes(authType))fail(400,'INVALID_AUTH_TYPE','نوع مصادقة غير مدعوم');
 if(authType==='NONE' && input.auth?.allowNone!==true)fail(400,'INVALID_AUTH_TYPE','auth.type=NONE يتطلب allowNone:true صراحة');
 if(authType==='API_KEY' && !input.auth?.headerName)fail(400,'INVALID_AUTH_TYPE','API_KEY يتطلب headerName حقيقيًا');
 // Phase 6G, Part 18-21 — the Generic OAuth2 Framework: a Platform-Admin-defined connector can
 // now declare a real OAuth2 flow entirely through the Builder (see validateOAuth2Config above)
 // instead of OAuth2 being permanently reserved for hand-written BUILT_IN adapters (Salla/Zid).
 if(authType==='OAUTH2')validateOAuth2Config(input.auth,fail);
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
  if(!['NONE','API_KEY','BEARER_TOKEN','BASIC','OAUTH2'].includes(authType))fail(400,'INVALID_AUTH_TYPE','نوع مصادقة غير مدعوم');
  if(authType==='NONE' && patch.auth.allowNone!==true)fail(400,'INVALID_AUTH_TYPE','auth.type=NONE يتطلب allowNone:true صراحة');
  if(authType==='API_KEY' && !patch.auth.headerName)fail(400,'INVALID_AUTH_TYPE','API_KEY يتطلب headerName حقيقيًا');
  if(authType==='OAUTH2')validateOAuth2Config(patch.auth,fail);
 }
 // Phase 6H, Part 1-2 — Safe Published Version Lifecycle: while a parallel draft workspace
 // exists for this (still fully PUBLISHED, still fully live) connector, an edit here targets
 // the DRAFT overlay, never the live row — the live row (serving every brand-new connection
 // today) is completely untouched until the draft is actually published (see publishConnector).
 if(hasDraftOverlay(db,id)) { updateDraftMeta(db,id,patch); return getDefinitionById(db,id); }
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
 // Phase 6H — while drafting, capabilities are validated against the DRAFT's OWN declared
 // capabilities (which may already differ from the live ones being edited toward), never the
 // live definition's currently-published capability list.
 const overlay=getDraftMeta(db,definitionId);
 const declaredCapabilities=(overlay?overlay.capabilities:definition.capabilities)||[];
 if(!declaredCapabilities.includes(action.requiredCapability))
  fail(400,'CAPABILITY_NOT_DECLARED',`القدرة ${action.requiredCapability} لم تُعلَن بعد في خطوة Capabilities لهذا الـConnector`);
 return overlay?upsertDraftAction(db,definitionId,action):storeUpsertAction(db,definitionId,action);
}
export function deleteActionForConnector(db,env,actorUser,definitionId,actionId) {
 requirePlatformAdmin(env,actorUser);
 requireEditableDefinition(db,definitionId);
 if(hasDraftOverlay(db,definitionId))deleteDraftAction(db,definitionId,actionId);
 else storeDeleteAction(db,definitionId,actionId);
}
export function listActions(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 requireOwnDefinition(db,definitionId);
 return hasDraftOverlay(db,definitionId)?listDraftActionsForDefinition(db,definitionId):listActionsForDefinition(db,definitionId);
}

export function upsertTriggerForConnector(db,env,actorUser,definitionId,trigger) {
 requirePlatformAdmin(env,actorUser);
 requireEditableDefinition(db,definitionId);
 if(!trigger.slug||!trigger.normalizedEventType||!trigger.mappingDefinition)fail(400,'INVALID_TRIGGER','slug/normalizedEventType/mappingDefinition مطلوبة');
 return hasDraftOverlay(db,definitionId)?upsertDraftTrigger(db,definitionId,trigger):storeUpsertTrigger(db,definitionId,trigger);
}
export function deleteTriggerForConnector(db,env,actorUser,definitionId,triggerId) {
 requirePlatformAdmin(env,actorUser);
 requireEditableDefinition(db,definitionId);
 if(hasDraftOverlay(db,definitionId))deleteDraftTrigger(db,definitionId,triggerId);
 else storeDeleteTrigger(db,definitionId,triggerId);
}
export function listTriggers(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 requireOwnDefinition(db,definitionId);
 return hasDraftOverlay(db,definitionId)?listDraftTriggersForDefinition(db,definitionId):listTriggersForDefinition(db,definitionId);
}

// --- Test / Preview (Part 73/74/83) -----------------------------------------------------------

/** Runs the exact same manifest validator (`validateRestManifest`/`validateWebhookManifest`)
 * publish itself uses, sourced from a DRAFT OVERLAY's own data (Phase 6H) rather than the live
 * DB rows — never touches the live tables, so this can safely be called at any point while
 * drafting without risking the currently-published version. */
function validateOverlayManifest(db,definition,overlay) {
 const draftActions=listDraftActionsForDefinition(db,definition.id);
 const draftTriggers=listDraftTriggersForDefinition(db,definition.id);
 const draftDefinitionShape={...definition,nameAr:overlay.nameAr,nameEn:overlay.nameEn,category:overlay.category,
  descriptionAr:overlay.descriptionAr,descriptionEn:overlay.descriptionEn,capabilities:overlay.capabilities,
  restConfig:overlay.restConfig,authConfig:overlay.authConfig};
 const raw=buildRawManifest(db,draftDefinitionShape,{overrideActions:draftActions,overrideTriggers:draftTriggers});
 if(draftTriggers.length)return validateWebhookManifest(raw);
 return validateRestManifest(raw);
}
/** Validates the CURRENT draft state without publishing — the same real validator publish uses.
 * Phase 6H — when a parallel draft workspace exists, this validates THAT workspace's content;
 * the live, currently-published manifest is completely unaffected either way. */
export function validateConnectorDraft(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireOwnDefinition(db,definitionId);
 const overlay=getDraftMeta(db,definitionId);
 if(overlay)return {ok:true,manifest:validateOverlayManifest(db,definition,overlay)};
 const {manifest}=hydrateAndValidate(db,definition.slug);
 return {ok:true,manifest};
}

// --- Publish / Disable (Part 37/38/40/41) ------------------------------------------------------

/** Phase 6H, Part 3 — publishing a draft workspace: the overlay's manifest is validated FIRST,
 * against a raw manifest built purely from overlay data (Part 2/5 — never touches the live
 * tables while validating, so a validation failure leaves the still-live, still-serving-new-
 * connections version completely untouched). Only once valid do the live
 * `integration_definitions` fields and `connector_actions`/`connector_triggers` rows get
 * replaced with the draft's content — the draft simply BECOMES the new live version, and the
 * overlay is discarded. New connections created after this point resolve the new version
 * immediately (Part 3: "new connections default to v3"); every connection already pinned to the
 * OLD version keeps resolving its own untouched immutable snapshot (unaffected, exactly as
 * every other publish already guarantees — Policy B). */
function publishFromOverlay(db,actorUser,definition,overlay) {
 const manifest=validateOverlayManifest(db,definition,overlay);
 const now=new Date().toISOString();
 db.prepare(`UPDATE integration_definitions SET name_ar=?,name_en=?,category=?,description_ar=?,description_en=?,capabilities=?,rest_config=?,auth_config=?,updated_at=? WHERE id=?`)
  .run(overlay.nameAr,overlay.nameEn,overlay.category,overlay.descriptionAr,overlay.descriptionEn,JSON.stringify(overlay.capabilities),overlay.restConfig?JSON.stringify(overlay.restConfig):null,overlay.authConfig?JSON.stringify(overlay.authConfig):null,now,definition.id);
 for(const existing of listActionsForDefinition(db,definition.id))storeDeleteAction(db,definition.id,existing.id);
 for(const action of listDraftActionsForDefinition(db,definition.id))storeUpsertAction(db,definition.id,action);
 for(const existing of listTriggersForDefinition(db,definition.id))storeDeleteTrigger(db,definition.id,existing.id);
 for(const trigger of listDraftTriggersForDefinition(db,definition.id))storeUpsertTrigger(db,definition.id,triggerToUpsertInput(trigger));
 deleteDraftOverlay(db,definition.id);
 return manifest;
}
export function publishConnector(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireOwnDefinition(db,definitionId);
 if(definition.isSystem)fail(400,'SYSTEM_CONNECTOR_READONLY','موصلات النظام منشورة بالفعل ولا تُنشر من هنا');
 if(definition.status==='DISABLED')fail(400,'CONNECTOR_DISABLED','أعد تفعيل الموصل قبل نشر تعديلات جديدة عليه');
 const overlay=getDraftMeta(db,definitionId);
 // Part 37/38 — the exact same real validator (validateManifest/validateRestManifest/
 // validateWebhookManifest) that runtime resolution itself uses. A publish blocker here is
 // IDENTICAL to a runtime failure — never a separate, weaker Builder-only check.
 const manifest=overlay?publishFromOverlay(db,actorUser,definition,overlay):hydrateAndValidate(db,definition.slug).manifest;
 // Re-read: publishFromOverlay may have just replaced the live row's fields above.
 const fresh=getDefinitionById(db,definitionId);
 // Part 109 (policy B): the FIRST publish uses the version already set at draft creation (1);
 // every SUBSEQUENT publish (editing an already-published definition, OR publishing a Phase 6H
 // draft workspace) bumps it — a real, new, immutable snapshot every time, never silently
 // mutating the previous one.
 const newVersion=fresh.publishedAt?fresh.version+1:fresh.version;
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
 * shape the wizard's Review step and the connector detail screen both read from.
 *
 * Phase 6H, Part 1/4 — when a parallel draft workspace exists, the Basics/Auth/Capabilities/
 * Actions/Webhooks tabs show and edit the DRAFT content (what a Platform Admin actively drafting
 * "v3" wants to see) while `liveVersion`/`status` still honestly report that the definition is
 * `PUBLISHED` and serving every brand-new connection with its OWN, completely untouched, live
 * content — `hasDraft`/`draftMeta` tell the UI to render the "you are editing a draft; v{live}
 * keeps serving new connections" banner. */
export function getConnectorForBuilder(db,env,actorUser,id) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireOwnDefinition(db,id);
 const deps=db.prepare('SELECT COUNT(*) c FROM integration_connections WHERE integration_definition_id=?').get(definition.slug).c;
 const tenants=db.prepare('SELECT COUNT(DISTINCT tenant_id) c FROM integration_connections WHERE integration_definition_id=?').get(definition.slug).c;
 const overlay=definition.isSystem?null:getDraftMeta(db,id);
 return {
  ...definition,
  ...(overlay?{nameAr:overlay.nameAr,nameEn:overlay.nameEn,category:overlay.category,descriptionAr:overlay.descriptionAr,descriptionEn:overlay.descriptionEn,capabilities:overlay.capabilities,restConfig:overlay.restConfig,authConfig:overlay.authConfig}:{}),
  connectionsCount:deps,tenantsCount:tenants,
  actions:definition.isSystem?[]:(overlay?listDraftActionsForDefinition(db,id):listActionsForDefinition(db,id)),
  triggers:definition.isSystem?[]:(overlay?listDraftTriggersForDefinition(db,id):listTriggersForDefinition(db,id)),
  hasDraft:!!overlay,
  liveVersion:definition.version,
  liveStatus:definition.status
 };
}

// --- Versioning UI backend (Phase 6G, Part 2-8) --------------------------------------------------
// The version MODEL (`connector_definition_versions`, immutable snapshots, a connection's own
// `connector_version` pin) is real since Phase 6D — see docs/CONNECTOR_VERSIONING.md. What was
// missing was a Platform Admin actually being able to BROWSE past versions, see what changed,
// and start a new draft version without instantly changing what a live-pinned connection sees.

function diffArraysBySlug(oldArr=[],newArr=[],fields) {
 const oldMap=new Map(oldArr.map(x=>[x.slug,x]));
 const newMap=new Map(newArr.map(x=>[x.slug,x]));
 const added=[...newMap.keys()].filter(s=>!oldMap.has(s));
 const removed=[...oldMap.keys()].filter(s=>!newMap.has(s));
 const changed=[];
 for(const slug of newMap.keys()) {
  if(!oldMap.has(slug))continue;
  const a=oldMap.get(slug),b=newMap.get(slug);
  const changedFields=fields.filter(f=>JSON.stringify(a[f])!==JSON.stringify(b[f]));
  if(changedFields.length)changed.push({slug,changedFields});
 }
 return {added,removed,changed};
}
/** A structural diff between two immutable manifest snapshots — never a secret (a manifest's
 * `auth` block is, by construction, non-secret config only: type + header names/URLs/env-var-
 * name REFERENCES, never a token/password/client-secret value — see CONNECTOR_IMPORT_EXPORT.md's
 * identical guarantee for Export). Used by both the Versions tab's diff view and the Connection
 * page's pre-migration preview so there is exactly one diff algorithm, never two that could
 * silently disagree. */
export function computeManifestDiff(oldManifest,newManifest) {
 return {
  connectionMode:{from:oldManifest.connectionMode,to:newManifest.connectionMode,changed:oldManifest.connectionMode!==newManifest.connectionMode},
  auth:{from:oldManifest.auth?.type,to:newManifest.auth?.type,changed:JSON.stringify(oldManifest.auth)!==JSON.stringify(newManifest.auth)},
  capabilities:{
   added:(newManifest.capabilities||[]).filter(c=>!(oldManifest.capabilities||[]).includes(c)),
   removed:(oldManifest.capabilities||[]).filter(c=>!(newManifest.capabilities||[]).includes(c))
  },
  actions:diffArraysBySlug(oldManifest.actions,newManifest.actions,['requiredCapability','riskLevel','rest']),
  triggers:diffArraysBySlug(oldManifest.triggers,newManifest.triggers,['normalizedEventType','mappingDefinition','authentication']),
  health:{from:oldManifest.rest?.health||null,to:newManifest.rest?.health||null,changed:JSON.stringify(oldManifest.rest?.health)!==JSON.stringify(newManifest.rest?.health)}
 };
}
function describeVersionChange(version,snapshots) {
 if(version===1)return 'الإصدار الأول';
 const prev=snapshots.find(s=>s.version===version-1);
 const curr=snapshots.find(s=>s.version===version);
 if(!prev||!curr)return 'غير معروف';
 const diff=computeManifestDiff(prev.manifest,curr.manifest);
 const parts=[];
 if(diff.capabilities.added.length||diff.capabilities.removed.length)parts.push('القدرات');
 if(diff.actions.added.length||diff.actions.removed.length||diff.actions.changed.length)parts.push('الإجراءات');
 if(diff.triggers.added.length||diff.triggers.removed.length||diff.triggers.changed.length)parts.push('الويبهوك');
 if(diff.auth.changed)parts.push('المصادقة');
 if(diff.health.changed)parts.push('فحص الصحة');
 if(diff.connectionMode.changed)parts.push('وضع الاتصال');
 return parts.length?`تغييرات في: ${parts.join('، ')}`:'تعديلات طفيفة';
}
/** Part 2/4 — the Versions tab's list: every real, permanent snapshot plus (Part 1) a synthetic
 * DRAFT row while a parallel draft workspace exists. `connectionsPinned` is a live COUNT, never
 * an estimate. Status labels, exactly as Part 4 requires:
 *  - `LIVE` — the one version currently serving every brand-new connection (the definition's
 *    real, current `version`, while `status==='PUBLISHED'`).
 *  - `PREVIOUS` — an older, still-immutable, still-resolvable-by-pin snapshot.
 *  - `DRAFT` — the in-progress draft workspace (Phase 6H), if one exists; never counted as a
 *    real version until actually published. */
export function listConnectorVersions(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireOwnDefinition(db,definitionId);
 if(definition.isSystem)return [];
 const snapshots=listVersionSnapshotsForDefinition(db,definitionId);
 const rows=snapshots.map(s=>({
  version:s.version,
  status:(s.version===definition.version && definition.status==='PUBLISHED')?'LIVE':'PREVIOUS',
  publishedAt:s.publishedAt,publishedByUserId:s.publishedByUserId,
  connectionsPinned:db.prepare('SELECT COUNT(*) c FROM integration_connections WHERE integration_definition_id=? AND connector_version=?').get(definition.slug,s.version).c,
  changeType:describeVersionChange(s.version,snapshots)
 }));
 if(hasDraftOverlay(db,definitionId))
  rows.push({version:definition.version+1,status:'DRAFT',publishedAt:null,publishedByUserId:null,connectionsPinned:0,changeType:'نسخة عمل قيد الإعداد — لا تؤثر على النسخة المنشورة الحالية'});
 return rows;
}
/** Part 3 — a real diff between two already-published snapshots. */
export function getVersionDiff(db,env,actorUser,definitionId,fromVersion,toVersion) {
 requirePlatformAdmin(env,actorUser);
 requireOwnDefinition(db,definitionId);
 const from=getVersionSnapshot(db,definitionId,Number(fromVersion));
 const to=getVersionSnapshot(db,definitionId,Number(toVersion));
 if(!from||!to)fail(404,'VERSION_NOT_FOUND','أحد الإصدارين غير موجود');
 return {fromVersion:Number(fromVersion),toVersion:Number(toVersion),diff:computeManifestDiff(from,to)};
}
/** Part 1-4 (Phase 6H, Safe Published Version Lifecycle) — "Create New Draft Version": creates a
 * genuinely PARALLEL draft workspace (`connector_draft_meta`/`connector_draft_actions`/
 * `connector_draft_triggers` — see draft-store.js), seeded from the current live content, so a
 * Platform Admin can edit "v3" while the LIVE `integration_definitions` row + `connector_actions`/
 * `connector_triggers` — serving v2 to every brand-new connection exactly as before — are NEVER
 * touched until the draft is actually published (`publishFromOverlay`). Unlike the Phase 6G
 * version of this function, `status` stays `PUBLISHED` throughout — Part 1's explicit
 * requirement that "draft v3 must not hide/disable currently published connector". */
export function createDraftVersion(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireOwnDefinition(db,definitionId);
 if(definition.isSystem)fail(400,'SYSTEM_CONNECTOR_READONLY','لا يمكن إنشاء نسخة مسودة لموصل نظامي');
 if(definition.status!=='PUBLISHED')fail(400,'NOT_PUBLISHED','يمكن إنشاء نسخة مسودة جديدة فقط من موصل منشور حاليًا');
 if(hasDraftOverlay(db,definitionId))fail(409,'DRAFT_ALREADY_EXISTS','يوجد بالفعل نسخة مسودة قيد الإعداد لهذا الموصل');
 createDraftMeta(db,definitionId,{
  nameAr:definition.nameAr,nameEn:definition.nameEn,category:definition.category,
  descriptionAr:definition.descriptionAr,descriptionEn:definition.descriptionEn,
  capabilities:definition.capabilities,restConfig:definition.restConfig,authConfig:definition.authConfig
 });
 for(const action of listActionsForDefinition(db,definitionId))upsertDraftAction(db,definitionId,action);
 for(const trigger of listTriggersForDefinition(db,definitionId))upsertDraftTrigger(db,definitionId,triggerToUpsertInput(trigger));
 return getConnectorForBuilder(db,env,actorUser,definitionId);
}
/** Part 1 (implicit) — discards an in-progress draft workspace without publishing it, e.g. if a
 * Platform Admin decides not to go through with "v3" after all. The live, published version is
 * (as always in this design) completely unaffected either way. */
export function discardDraftVersion(db,env,actorUser,definitionId) {
 requirePlatformAdmin(env,actorUser);
 const definition=requireOwnDefinition(db,definitionId);
 if(!hasDraftOverlay(db,definitionId))fail(400,'NO_DRAFT','لا توجد نسخة مسودة قيد الإعداد لهذا الموصل');
 deleteDraftOverlay(db,definitionId);
 return getDefinitionById(db,definitionId);
}

// --- Tenant-facing catalog (Part 26/27/39/40) ---------------------------------------------------

/** Published, available, non-disabled connectors only — safe metadata, no secrets, no draft.
 * Phase 6G, Part 30 — a tenant-owned custom connector (`ownerTenantId` set, see
 * docs/TENANT_CUSTOM_CONNECTORS.md) is NEVER globally visible even once PUBLISHED/APPROVED:
 * it only ever appears in the catalog of the exact tenant that created it. `tenantId` is
 * REQUIRED precisely so this function itself enforces that isolation — there is no "global"
 * call shape that could accidentally leak one to every tenant. */
export function getTenantCatalog(db,tenantId) {
 return listIntegrationDefinitions(db)
  .filter(d=>d.status==='PUBLISHED' && (!d.ownerTenantId || d.ownerTenantId===tenantId))
  .map(d=>({slug:d.slug,nameAr:d.nameAr,nameEn:d.nameEn,category:d.category,descriptionAr:d.descriptionAr,descriptionEn:d.descriptionEn,
   iconKey:d.iconKey,capabilities:d.capabilities,isAvailable:d.isAvailable,connectionMode:d.connectionMode,authType:d.authConfig?.type||d.authType,
   isTenantCustom:!!d.ownerTenantId}));
}
