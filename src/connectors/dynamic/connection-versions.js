// Universal Integration Platform (Phase 6G, Part 5-7) — Connection Version Migration/Rollback.
// A tenant-owned connection's own `connector_version` pin (Part 42/108/109 of Phase 6D) can now
// actually be CHANGED through a real, safe, validated workflow — until this phase nothing in the
// UI ever wrote it (see the `updateConnection` fix in src/integrations/connections.js).
import {getConnection,updateConnection} from '../../integrations/connections.js';
import {getIntegrationDefinition} from '../../integrations/definitions.js';
import {getVersionSnapshot} from './store.js';
import {computeManifestDiff} from './builder.js';
import {genericRestAdapter} from '../generic-rest/adapter.js';
import {findAssignmentsUsingConnection} from '../../runtime/tool-assignments.js';
import {getToolDefinition} from '../../runtime/tool-definitions.js';
import {getCredentialForRuntime} from '../../integrations/vault.js';

function fail(status,code,message){const e=new Error(message||code);e.status=status;e.code=code;throw e;}

function requireVersionedConnection(db,tenantId,connectionId) {
 const connection=getConnection(db,connectionId,tenantId);
 const definition=getIntegrationDefinition(db,connection.integrationDefinitionId);
 if(!definition||definition.adapterType!=='GENERIC_REST')fail(400,'NOT_VERSIONED','هذا التكامل لا يدعم نظام إصدارات Builder (موصل نظامي مبني بالكود)');
 return {connection,definition};
}
/** Part 5 — "Current Version / Available Version" on the Connection page. */
export function getConnectionVersionInfo(db,connectionId,tenantId) {
 const connection=getConnection(db,connectionId,tenantId);
 const definition=getIntegrationDefinition(db,connection.integrationDefinitionId);
 if(!definition||definition.adapterType!=='GENERIC_REST')
  return {supportsVersioning:false,currentVersion:null,availableVersion:null,migrationAvailable:false};
 const availableVersion=definition.status==='PUBLISHED'?definition.version:null;
 return {
  supportsVersioning:true,currentVersion:connection.connectorVersion??null,availableVersion,
  migrationAvailable:!!availableVersion && availableVersion!==(connection.connectorVersion??null),
  rollbackAvailable:connection.connectorVersion!=null && connection.connectorVersion>1
 };
}
/** Every active agent_tool_assignment on this connection whose tool's required capability would
 * be MISSING from the target version — a real, hard compatibility gate (Part 6), never a guess. */
function capabilityImpact(db,tenantId,connection,targetManifest) {
 const impacted=[];
 for(const assignment of findAssignmentsUsingConnection(db,tenantId,connection.id)) {
  const tool=getToolDefinition(db,assignment.toolSlug);
  if(tool?.capability && !targetManifest.capabilities.includes(tool.capability))
   impacted.push({agentId:assignment.agentId,toolSlug:assignment.toolSlug,capability:tool.capability});
 }
 return impacted;
}
/** Part 5 — shown to the operator BEFORE they confirm a migration: the real diff, and exactly
 * which tool assignments would break. Read-only; changes nothing. */
export function previewVersionMigration(db,tenantId,connectionId,targetVersion) {
 const {connection,definition}=requireVersionedConnection(db,tenantId,connectionId);
 const target=Number(targetVersion);
 const targetManifest=getVersionSnapshot(db,definition.id,target);
 if(!targetManifest)fail(404,'VERSION_NOT_FOUND','الإصدار المطلوب غير موجود');
 const currentManifest=connection.connectorVersion!=null?getVersionSnapshot(db,definition.id,connection.connectorVersion):null;
 const capabilityImpacted=capabilityImpact(db,tenantId,connection,targetManifest);
 return {
  fromVersion:connection.connectorVersion??null,toVersion:target,
  diff:currentManifest?computeManifestDiff(currentManifest,targetManifest):null,
  capabilityImpacted,toolAssignmentsAffected:capabilityImpacted.length
 };
}
async function runTargetHealthCheck({db,env,fetcher,connection,targetManifest}) {
 let credential=null;
 try{credential=getCredentialForRuntime(db,env,connection.id,connection.tenantId);}catch{credential=null;}
 try{return await genericRestAdapter.healthCheck({env,db,fetcher,credential,manifest:targetManifest,connection});}
 catch(error){return {status:'ERROR',errorCode:error?.code||'REMOTE_SERVER_ERROR'};}
}
/** Part 6 — Safe Migration: validate target version exists -> validate capability compatibility
 * (hard gate) -> run a REAL health check against the CANDIDATE version -> only then update the
 * pin. Any failure throws BEFORE any write happens, so "remain on old version" (Part 6) is
 * automatic — there is no partial-write state to roll back from. */
export async function migrateConnectionVersion({db,env,fetcher=fetch,tenantId,connectionId,targetVersion}) {
 const {connection,definition}=requireVersionedConnection(db,tenantId,connectionId);
 if(definition.status==='DISABLED')fail(400,'CONNECTOR_DISABLED','هذا الموصل معطَّل من قِبل مسؤول المنصة');
 const target=Number(targetVersion);
 const targetManifest=getVersionSnapshot(db,definition.id,target);
 if(!targetManifest)fail(404,'VERSION_NOT_FOUND','الإصدار المطلوب غير موجود أو لم يعد متاحًا');
 const capabilityImpacted=capabilityImpact(db,tenantId,connection,targetManifest);
 if(capabilityImpacted.length)
  fail(409,'CAPABILITY_REGRESSION',`الإصدار ${target} يفقد قدرة يعتمد عليها ${capabilityImpacted.length} ربط أداة/وكيل فعّال — الترقية مرفوضة لحماية الأتمتة القائمة`);
 const health=await runTargetHealthCheck({db,env,fetcher,connection,targetManifest});
 if(health.status!=='OK')
  fail(422,'TARGET_VERSION_UNHEALTHY',`فحص الصحة على الإصدار ${target} فشل (${health.errorCode||health.status}) — سيبقى الاتصال على إصداره الحالي دون أي تغيير`);
 const now=new Date().toISOString();
 const updated=updateConnection(db,connectionId,{connectorVersion:target,status:'CONNECTED',lastHealthCheck:now,lastSuccessAt:now,lastErrorAt:null,lastErrorCode:null,lastErrorMessageSafe:null},tenantId);
 return {connection:updated,fromVersion:connection.connectorVersion??null,toVersion:target};
}
/** Part 7 — Rollback: the nearest LOWER version that still has a real, retained snapshot (never
 * assumes N-1 exists), through the exact same safe-migration gate above — "only if still
 * compatible", never a destructive blind revert. */
export async function rollbackConnectionVersion({db,env,fetcher=fetch,tenantId,connectionId}) {
 const {connection,definition}=requireVersionedConnection(db,tenantId,connectionId);
 if(connection.connectorVersion==null||connection.connectorVersion<=1)fail(400,'NO_PREVIOUS_VERSION','لا يوجد إصدار سابق للتراجع إليه');
 let target=connection.connectorVersion-1;
 while(target>=1 && !getVersionSnapshot(db,definition.id,target))target--;
 if(target<1)fail(400,'NO_PREVIOUS_VERSION','لا يوجد إصدار سابق صالح للتراجع إليه');
 return migrateConnectionVersion({db,env,fetcher,tenantId,connectionId,targetVersion:target});
}
