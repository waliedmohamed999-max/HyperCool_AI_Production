// Universal Integration Platform (Phase 6A, Part 14/15) — ConnectorRuntime.execute(): the one
// central pipeline every future connector action (built-in adapter today, Generic REST in
// Phase 6B, a Builder-published connector in Phase 6D) runs through. This is ADDITIVE
// infrastructure — it does not replace src/runtime/runtime.js's existing agent-tool-call path
// (that remains completely untouched this phase; rewiring it is explicitly Phase 6B/6D's job,
// once the Generic Tool Binding — Part 20/21 — actually needs it).
import {randomUUID} from 'node:crypto';
import {getTenant,tenantOperationalBlockReason} from '../../tenancy.js';
import {getConnectionOrNull} from '../../integrations/connections.js';
import {getCredentialForRuntime} from '../../integrations/vault.js';
import {createApproval} from '../../runtime/approvals.js';
import {recordAudit} from '../../audit.js';
import {getConnector} from '../registry.js';

class ConnectorRuntimeError extends Error {
 constructor(code,message){super(message||code);this.code=code;}
}

/**
 * Part 15's exact pipeline: tenant validation -> manifest -> action definition -> connection
 * validation -> capability validation -> connection health(implicit, via connection.status) ->
 * permission -> approval if required -> vault credential retrieval -> connector adapter ->
 * response validation -> audit/log -> result.
 *
 * `actor` is required (Part 15 "permission" step) — this pipeline never runs anonymously; the
 * caller (an HTTP route, a future scheduler job) is responsible for real session/role checks
 * BEFORE calling this, exactly like every existing route in application.js already does via
 * `authorize(session,[...])`. This function re-checks only what it alone can know: that the
 * connection genuinely belongs to the claimed tenant and the action genuinely exists.
 */
export async function executeConnectorAction({db,env,fetcher=fetch,tenantId,connectorSlug,connectionId,actionId,input={},actor,correlationId=randomUUID(),resolveConnector=getConnector}) {
 if(!actor?.id)throw new ConnectorRuntimeError('ACTOR_REQUIRED','A real actor is required to execute a connector action');
 // 1. Tenant validation — reuses the exact same central check the agent runtime uses (Part 17/18
 // of Phase 4C-7), so a suspended/trial-expired tenant can never execute a connector action either.
 const tenant=getTenant(db,tenantId);
 const blockReason=tenantOperationalBlockReason(tenant);
 if(blockReason)return {status:'BLOCKED',errorCode:blockReason,correlationId};

 // 2. Connector manifest. `resolveConnector` defaults to the real, shared registry — tests
 // inject a test-only connector here rather than mutating the real one.
 const entry=resolveConnector(connectorSlug);
 if(!entry)return {status:'ERROR',errorCode:'CONNECTOR_NOT_FOUND',correlationId};
 const {manifest,adapter}=entry;

 // 3. Action definition.
 const action=manifest.actions.find(a=>a.slug===actionId||a.id===actionId);
 if(!action)return {status:'ERROR',errorCode:'ACTION_NOT_FOUND',correlationId};

 // 4. Connection validation — IDOR-safe: getConnectionOrNull is already tenant-scoped (never
 // returns another tenant's row even by the right id), and must belong to THIS connector.
 const connection=getConnectionOrNull(db,connectionId,tenantId);
 if(!connection||connection.integrationDefinitionId!==manifest.slug)
  return {status:'ERROR',errorCode:'CONNECTION_NOT_FOUND',correlationId};

 // 5. Capability validation — the connection's own connector must actually declare the
 // capability this action requires (a manifest mismatch here means a real config error, not a
 // permission problem, so it fails loudly rather than looking like a health issue).
 if(!manifest.capabilities.includes(action.requiredCapability))
  return {status:'ERROR',errorCode:'CAPABILITY_MISSING',correlationId};

 // 6. Connection health (status-based; a real live health re-check is the caller's own
 // decision — this pipeline never forces an extra network round trip on every action).
 if(!['CONNECTED','DEGRADED'].includes(connection.status))
  return {status:'ERROR',errorCode:'CONNECTION_UNHEALTHY',correlationId};

 // 7. Permission — deferred to the caller (see docstring); nothing further to check here today.

 // 8. Approval if required (Part 95) — reuses the EXISTING Approval Engine, never a second one.
 // `agentId:'connector-runtime'` is a documented synthetic identifier for actions triggered
 // outside any agent run (Part 40/41's platform-managed connectors); a real agent-triggered
 // connector action passes its own real agentId/runId once Phase 6B/6D wires this in.
 if(action.requiresApprovalDefault) {
  // 'connector_action' is the Approval Engine's own business-action-type label (approvals.js's
  // ACTION_TYPES) — a different, more specific vocabulary from the manifest's own
  // READ/EXTERNAL_WRITE/etc. actionType, which is recorded in proposedOutput instead so a
  // reviewer still sees exactly what kind of action this really is.
  const approval=createApproval(db,{runId:null,agentId:'connector-runtime',actionType:'connector_action',proposedOutput:{connectorSlug,actionId:action.slug,connectorActionType:action.actionType,input},riskLevel:action.riskLevel,reason:`Connector action ${manifest.slug}.${action.slug} requires approval before execution`,tenantId,toolSlug:null,assignmentId:null,connectionId});
  recordAudit(db,{id:randomUUID(),action:'CONNECTOR_ACTION_PENDING_APPROVAL',itemId:approval.id,connectorSlug,actionSlug:action.slug,actorId:actor.id,actorName:actor.name,at:new Date().toISOString()},tenantId);
  return {status:'WAITING_APPROVAL',approvalId:approval.id,correlationId};
 }

 // 9. Vault credential retrieval — never exposed beyond this boundary (Part 16).
 let credential=null;
 try{credential=getCredentialForRuntime(db,env,connectionId,tenantId);}catch{credential=null;}

 // 10. Connector adapter execution.
 const startedAt=Date.now();
 let result;
 try {
  result=await adapter.executeAction({action,input,env,fetcher,credential,connection});
 } catch(error) {
  result={status:'ERROR',errorCode:'REMOTE_SERVER_ERROR'};
 }
 const latencyMs=Date.now()-startedAt;

 // 11. Response validation — minimal, structural only (a real JSON-Schema outputSchema check
 // belongs to Phase 6B's mapping/validation engine; this just guards against a malformed adapter).
 if(!result||typeof result.status!=='string')result={status:'ERROR',errorCode:'REMOTE_VALIDATION_ERROR'};

 // 12. Audit — never the raw output (which could contain real customer/business data at
 // volume, e.g. Salla's full product catalog) or any credential; only the safe outcome shape.
 recordAudit(db,{
  id:randomUUID(),
  action:result.status==='OK'?'CONNECTOR_ACTION_EXECUTED':'CONNECTOR_ACTION_FAILED',
  itemId:connectionId,connectorSlug,actionSlug:action.slug,status:result.status,errorCode:result.errorCode||null,
  latencyMs,correlationId,actorId:actor.id,actorName:actor.name,at:new Date().toISOString()
 },tenantId);

 // 13. Result.
 return {...result,correlationId,latencyMs};
}
