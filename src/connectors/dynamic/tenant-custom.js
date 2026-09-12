// Universal Integration Platform (Phase 6G, Part 28-38) — Tenant Custom Connector Governance.
// Phase 6F left `ENABLE_TENANT_CUSTOM_CONNECTORS` gating NOTHING real (see
// docs/TENANT_CUSTOM_CONNECTORS.md's own honest admission). This module is the real workflow:
// Tenant Draft -> Validate -> Submit for Review -> Platform Review -> Approved -> Published
// (for that ONE tenant only, never the global marketplace) — built entirely on the EXISTING
// `integration_definitions` table (the additive `owner_tenant_id`/`review_status` columns from
// src/integrations/definitions.js), the EXISTING SSRF/capability-registry/manifest validators,
// and the EXISTING `connector_actions`/`connector_triggers` child tables — never a second,
// parallel connector model.
import {randomUUID} from 'node:crypto';
import {getIntegrationDefinition,listIntegrationDefinitions} from '../../integrations/definitions.js';
import {upsertAction as storeUpsertAction,deleteAction as storeDeleteAction,listActionsForDefinition,upsertTrigger as storeUpsertTrigger,deleteTrigger as storeDeleteTrigger,listTriggersForDefinition,saveVersionSnapshot} from './store.js';
import {hydrateAndValidate} from './hydrate.js';
import {isKnownCapability} from '../core/capability-registry.js';
import {validateOutboundUrl} from '../core/ssrf.js';

function fail(status,code,message){const e=new Error(message||code);e.status=status;e.code=code;throw e;}
function getDefinitionById(db,id){return listIntegrationDefinitions(db).find(d=>d.id===id)||null;}
// Part 35 — the SAME allowlist mechanism builder.js's own `requirePlatformAdmin` uses (never a
// second, parallel admin concept) — duplicated as a tiny local helper rather than importing a
// private, unexported function from another module.
function requirePlatformAdmin(env,user) {
 const allowlist=(env.PLATFORM_ADMIN_USERNAMES||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
 if(!user?.username||!allowlist.includes(user.username.toLowerCase()))fail(403,'PLATFORM_ADMIN_REQUIRED','هذا الإجراء متاح فقط لمسؤول المنصة');
}

// Part 28 — the flag's real, single meaning now: it gates every function in this module.
export function tenantCustomConnectorsEnabled(env) { return env.ENABLE_TENANT_CUSTOM_CONNECTORS==='true'; }
function requireEnabled(env) { if(!tenantCustomConnectorsEnabled(env))fail(403,'TENANT_CUSTOM_CONNECTORS_DISABLED','ميزة موصلات المستأجر المخصصة غير مُفعّلة على هذه المنصة'); }

// Part 31 — a configurable, conservative-by-default ceiling.
function maxPerTenant(env) { const n=Number(env.MAX_CUSTOM_CONNECTORS_PER_TENANT); return Number.isFinite(n)&&n>0?n:3; }

// Part 33 — a tenant-submitted connector can NEVER declare a security/admin/platform-level
// capability, even a hypothetical future one the canonical registry doesn't have yet.
const FORBIDDEN_CAPABILITY_PREFIX=/^(platform|security|admin|permissions)\./i;
// Part 34 — tenant custom connectors are read/API_KEY-class only for V1: OAuth2 needs a real
// platform-configured client id/secret ENV pair only a Platform Admin can provision (Part 21),
// so a tenant could never make one actually work anyway — excluding it up front is honest, not
// a workaround.
const TENANT_ALLOWED_AUTH_TYPES=new Set(['NONE','API_KEY','BEARER_TOKEN','BASIC']);

function requireOwnedDraft(db,tenantId,definitionId) {
 const definition=getDefinitionById(db,definitionId);
 // Part 30 — a wrong-tenant id is indistinguishable from one that never existed (same IDOR-safe
 // convention as every other tenant-scoped getter in this codebase).
 if(!definition||definition.ownerTenantId!==tenantId)fail(404,'CONNECTOR_NOT_FOUND','لا يوجد موصل مخصص بهذا المعرّف لهذه المنشأة');
 return definition;
}

/** Part 28/29 — creates a tenant-OWNED, tenant-PRIVATE draft. Never visible to any other
 * tenant (getTenantCatalog/getConnectorForBuilder both check `ownerTenantId`), never
 * auto-published, and held to the EXACT SAME base-URL/capability safety bar a Platform-Admin
 * draft is — plus the additional tenant-specific restrictions Part 31-33 require. */
export function createTenantConnectorDraft(db,env,tenantUser,tenantId,input) {
 requireEnabled(env);
 const existingCount=db.prepare("SELECT COUNT(*) c FROM integration_definitions WHERE owner_tenant_id=?").get(tenantId).c;
 if(existingCount>=maxPerTenant(env))fail(409,'CUSTOM_CONNECTOR_LIMIT_REACHED',`الحد الأقصى لموصلات هذه المنشأة المخصصة هو ${maxPerTenant(env)}`);
 const slug=String(input.slug||'').toLowerCase();
 if(!/^[a-z][a-z0-9_-]*$/.test(slug))fail(400,'INVALID_SLUG','slug يجب أن يكون أحرفًا لاتينية صغيرة/أرقام/شرطات فقط');
 if(getIntegrationDefinition(db,slug))fail(409,'SLUG_TAKEN','يوجد Connector بنفس الـslug بالفعل');
 if(!['MULTI','SINGLE'].includes(input.connectionMode))fail(400,'INVALID_CONNECTION_MODE','connectionMode يجب أن يكون MULTI أو SINGLE');
 const authType=input.auth?.type;
 // Part 32 — HTTPS-only, SSRF-validated, fixed host; no arbitrary OAuth URL (auth type itself
 // is restricted below, so there is no OAuth URL field to even accept from a tenant).
 if(!TENANT_ALLOWED_AUTH_TYPES.has(authType))fail(400,'INVALID_AUTH_TYPE','موصلات المستأجر المخصصة تدعم فقط NONE/API_KEY/BEARER_TOKEN/BASIC حاليًا');
 if(authType==='NONE' && input.auth?.allowNone!==true)fail(400,'INVALID_AUTH_TYPE','auth.type=NONE يتطلب allowNone:true صراحة');
 if(authType==='API_KEY' && !input.auth?.headerName)fail(400,'INVALID_AUTH_TYPE','API_KEY يتطلب headerName حقيقيًا');
 if(!input.rest?.baseUrl)fail(400,'INVALID_BASE_URL','rest.baseUrl مطلوب');
 try{validateOutboundUrl(input.rest.baseUrl,{allowHttp:false});} // Part 32 — no http:// exception for a tenant-authored connector
 catch(error){fail(400,'UNSAFE_BASE_URL',`rest.baseUrl غير آمن: ${error.message}`);}
 if(input.rest.tenantConfigurableHost)fail(400,'INVALID_BASE_URL','لا يمكن لموصل مستأجر مخصص أن يجعل المضيف قابلاً للتهيئة من طرف آخر');
 const capabilities=input.capabilities||[];
 for(const capability of capabilities) {
  if(FORBIDDEN_CAPABILITY_PREFIX.test(capability))fail(400,'FORBIDDEN_CAPABILITY',`القدرة ${capability} محجوزة لموصلات المنصة ولا يمكن لموصل مستأجر مخصص الإعلان عنها`);
  if(!isKnownCapability(capability))fail(400,'UNKNOWN_CAPABILITY',`القدرة غير معروفة في السجل المركزي: ${capability}`);
 }
 const now=new Date().toISOString();
 const id=randomUUID();
 db.prepare(`INSERT INTO integration_definitions (id,slug,name_ar,name_en,category,description_ar,description_en,auth_type,icon_key,capabilities,is_available,status,version,adapter_type,adapter_key,connection_mode_override,is_system,created_by_user_id,rest_config,auth_config,owner_tenant_id,review_status,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  id,slug,input.nameAr||slug,input.nameEn||slug,(input.category||'custom').toLowerCase(),input.descriptionAr||'',input.descriptionEn||'',
  authType==='API_KEY'?'API_KEY':'CUSTOM',input.iconKey||'custom',JSON.stringify(capabilities),0,
  'DRAFT',1,'GENERIC_REST',slug,input.connectionMode,0,tenantUser.id,
  JSON.stringify(input.rest),JSON.stringify(input.auth),tenantId,null,now,now
 );
 return getDefinitionById(db,id);
}
export function updateTenantConnectorDraft(db,env,tenantId,definitionId,patch) {
 requireEnabled(env);
 const definition=requireOwnedDraft(db,tenantId,definitionId);
 if(!['DRAFT'].includes(definition.status))fail(400,'NOT_EDITABLE','لا يمكن تعديل موصل بعد نشره أو تعطيله');
 if(patch.capabilities)
  for(const capability of patch.capabilities) {
   if(FORBIDDEN_CAPABILITY_PREFIX.test(capability))fail(400,'FORBIDDEN_CAPABILITY',`القدرة ${capability} محجوزة لموصلات المنصة`);
   if(!isKnownCapability(capability))fail(400,'UNKNOWN_CAPABILITY',`القدرة غير معروفة: ${capability}`);
  }
 if(patch.rest?.baseUrl) {
  try{validateOutboundUrl(patch.rest.baseUrl,{allowHttp:false});}
  catch(error){fail(400,'UNSAFE_BASE_URL',`rest.baseUrl غير آمن: ${error.message}`);}
 }
 const now=new Date().toISOString();
 db.prepare(`UPDATE integration_definitions SET name_ar=COALESCE(?,name_ar),name_en=COALESCE(?,name_en),description_ar=COALESCE(?,description_ar),description_en=COALESCE(?,description_en),capabilities=COALESCE(?,capabilities),rest_config=COALESCE(?,rest_config),
  review_status=NULL,review_notes=NULL,reviewed_by_user_id=NULL,reviewed_at=NULL,updated_at=? WHERE id=? AND owner_tenant_id=?`)
  .run(patch.nameAr||null,patch.nameEn||null,patch.descriptionAr||null,patch.descriptionEn||null,
   patch.capabilities?JSON.stringify(patch.capabilities):null,patch.rest?JSON.stringify({...definition.restConfig,...patch.rest}):null,now,definitionId,tenantId);
 return getDefinitionById(db,definitionId);
}
/** Part 34 — a tenant's own action declaration, held to the exact same capability-declared-
 * first bar as the Builder's admin-only path, plus a hard write-safety floor (Part 34: any
 * write action defaults to requiring approval and can never be un-required by a tenant). */
export function upsertTenantConnectorAction(db,env,tenantId,definitionId,action) {
 requireEnabled(env);
 const definition=requireOwnedDraft(db,tenantId,definitionId);
 if(definition.status!=='DRAFT')fail(400,'NOT_EDITABLE','لا يمكن تعديل موصل بعد نشره');
 if(!action.slug||!action.pathTemplate||!action.requiredCapability)fail(400,'INVALID_ACTION','slug/pathTemplate/requiredCapability مطلوبة');
 if(!isKnownCapability(action.requiredCapability))fail(400,'UNKNOWN_CAPABILITY',`القدرة غير معروفة: ${action.requiredCapability}`);
 if(!(definition.capabilities||[]).includes(action.requiredCapability))fail(400,'CAPABILITY_NOT_DECLARED',`القدرة ${action.requiredCapability} لم تُعلَن بعد لهذا الـConnector`);
 const writeShaped=['POST','PUT','PATCH','DELETE'].includes((action.httpMethod||'GET').toUpperCase());
 // Part 34 — never allowed to opt OUT of approval for a write; a tenant MAY tighten (leave
 // requiresApprovalDefault at its safe default or explicitly true) but never loosen it.
 const requiresApprovalDefault=writeShaped?true:(action.requiresApprovalDefault??undefined);
 return storeUpsertAction(db,definitionId,{...action,requiresApprovalDefault});
}
export function deleteTenantConnectorAction(db,env,tenantId,definitionId,actionId) {
 requireEnabled(env);
 const definition=requireOwnedDraft(db,tenantId,definitionId);
 if(definition.status!=='DRAFT')fail(400,'NOT_EDITABLE','لا يمكن تعديل موصل بعد نشره');
 storeDeleteAction(db,definitionId,actionId);
}
export function listTenantConnectorActions(db,tenantId,definitionId) {
 requireOwnedDraft(db,tenantId,definitionId);
 return listActionsForDefinition(db,definitionId);
}

/** Part 29 — Submit for Review: re-validated through the EXACT SAME validator a Platform-Admin
 * publish uses (never a weaker tenant-only bar) before it can even enter the review queue. */
export function submitTenantConnectorForReview(db,env,tenantId,definitionId) {
 requireEnabled(env);
 const definition=requireOwnedDraft(db,tenantId,definitionId);
 if(definition.status!=='DRAFT')fail(400,'NOT_DRAFT','هذا الموصل ليس في حالة مسودة');
 hydrateAndValidate(db,definition.slug); // throws loudly on anything that would fail to publish
 db.prepare("UPDATE integration_definitions SET review_status='PENDING',review_notes=NULL,reviewed_by_user_id=NULL,reviewed_at=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),definitionId);
 return getDefinitionById(db,definitionId);
}
export function listOwnTenantConnectors(db,tenantId) {
 return listIntegrationDefinitions(db).filter(d=>d.ownerTenantId===tenantId);
}
/** Part 35 — Platform Admin's review queue: every tenant-submitted PENDING draft, platform-wide. */
export function listPendingTenantConnectors(db,env,actorUser) {
 requirePlatformAdmin(env,actorUser);
 return listIntegrationDefinitions(db).filter(d=>d.reviewStatus==='PENDING');
}
/** Part 35/36 — Approve/Reject/Request Changes, every decision audited by the caller (the HTTP
 * route already calls `recordPlatformAudit` for every other Platform Admin decision — this
 * function itself stays audit-agnostic, consistent with builder.js's own convention). Approval
 * publishes for THIS TENANT ONLY (Part 30 — `getTenantCatalog` already scopes on
 * `ownerTenantId`, so this never becomes globally visible) and snapshots a real version 1,
 * exactly like a Platform-Admin connector, so it participates in the SAME versioning system. */
export function reviewTenantConnector(db,env,actorUser,definitionId,{decision,notes}) {
 requirePlatformAdmin(env,actorUser);
 const definition=getDefinitionById(db,definitionId);
 if(!definition||!definition.ownerTenantId)fail(404,'CONNECTOR_NOT_FOUND','لا يوجد موصل مستأجر مخصص بهذا المعرّف');
 if(definition.reviewStatus!=='PENDING')fail(400,'NOT_PENDING_REVIEW','هذا الموصل ليس بانتظار المراجعة حاليًا');
 if(!['APPROVE','REJECT','REQUEST_CHANGES'].includes(decision))fail(400,'INVALID_DECISION','قرار غير صالح');
 const now=new Date().toISOString();
 if(decision==='APPROVE') {
  const {manifest}=hydrateAndValidate(db,definition.slug);
  db.prepare("UPDATE integration_definitions SET status='PUBLISHED',is_available=1,published_at=?,review_status='APPROVED',review_notes=?,reviewed_by_user_id=?,reviewed_at=?,updated_at=? WHERE id=?")
   .run(now,notes||null,actorUser.id,now,now,definitionId);
  saveVersionSnapshot(db,definitionId,1,{...manifest,version:1},actorUser.id);
 } else {
  const status=decision==='REJECT'?'REJECTED':'CHANGES_REQUESTED';
  db.prepare("UPDATE integration_definitions SET review_status=?,review_notes=?,reviewed_by_user_id=?,reviewed_at=?,updated_at=? WHERE id=?")
   .run(status,notes||null,actorUser.id,now,now,definitionId);
 }
 return getDefinitionById(db,definitionId);
}
