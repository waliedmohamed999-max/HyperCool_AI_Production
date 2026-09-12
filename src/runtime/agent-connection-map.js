// Universal Integration Platform (Phase 6G, Part 43-47) — Agent Connection Map: one real,
// live view of Agent -> Tool -> Capability -> Connector -> Connection -> Version -> Health,
// built entirely from EXISTING data (`evaluateAllToolsReadiness`, `resolveToolConnection`,
// `integration_connections`) — never a second, parallel readiness computation that could
// silently disagree with what the Agent config drawer itself already shows.
import {agentDefinitions} from '../agents.js';
import {evaluateAllToolsReadiness} from './agent-readiness.js';
import {resolveToolConnection} from './tool-assignments.js';
import {getToolDefinition,listToolDefinitions} from './tool-definitions.js';
import {getConnectionOrNull} from '../integrations/connections.js';
import {listCompatibleConnections} from '../connectors/dynamic/compatibility.js';

/** Part 43 — one row per (agent, tool) pair. Part 46 — `readinessReason` reuses the EXACT
 * vocabulary `evaluateToolReadiness` already returns (DISABLED/CONNECTION_REQUIRED/
 * CONNECTION_UNHEALTHY/CONNECTION_CAPABILITY_MISSING/READY), enriched with REAUTH_REQUIRED
 * when the underlying connection's raw status is specifically TOKEN_EXPIRED — a real, already-
 * true fact this map is the first screen to surface explicitly rather than folding it into the
 * more generic CONNECTION_UNHEALTHY bucket. */
export function buildAgentConnectionMap(db,env,tenantId,{agentId=null,connectorSlug=null,status=null,capability=null}={}) {
 const agents=agentDefinitions.filter(a=>!agentId||a.id===agentId);
 const rows=[];
 for(const agent of agents) {
  for(const readiness of evaluateAllToolsReadiness(db,env,{tenantId,agentId:agent.id})) {
   const tool=getToolDefinition(db,readiness.toolSlug);
   if(!tool)continue;
   let connectionId=null,connectionName=null,connectorVersion=null,rawStatus=null,slug=tool.integrationSlug||null;
   const resolution=resolveToolConnection(db,{tenantId,agentId:agent.id,toolSlug:readiness.toolSlug});
   // Several BLOCKED reasons (CONNECTION_CAPABILITY_MISSING, CONNECTION_PROVIDER_MISMATCH,
   // CONNECTION_UNHEALTHY) still carry a real `connectionId` — look it up regardless of
   // `blocked` so the REAUTH_REQUIRED enrichment below actually fires for the common real
   // case (a pinned connection whose token expired, which resolveToolConnection reports as a
   // BLOCKED capability/health problem, not as an unblocked resolution).
   if(resolution.connectionId) {
    const connection=getConnectionOrNull(db,resolution.connectionId,tenantId);
    if(connection) {
     connectionId=connection.id;connectionName=connection.name;connectorVersion=connection.connectorVersion??null;
     rawStatus=connection.status;slug=connection.integrationDefinitionId;
    }
   }
   const row={
    agentId:agent.id,agentName:agent.name,toolSlug:readiness.toolSlug,capability:tool.capability||null,
    connectorSlug:slug,connectionId,connectionName,connectorVersion,healthStatus:rawStatus,
    readinessStatus:readiness.status,
    readinessReason:rawStatus==='TOKEN_EXPIRED'?'REAUTH_REQUIRED':(readiness.reason||null)
   };
   if(connectorSlug && row.connectorSlug!==connectorSlug)continue;
   if(status && row.readinessStatus!==status)continue;
   if(capability && row.capability!==capability)continue;
   rows.push(row);
  }
 }
 return rows;
}
/** Part 47 — Tool Compatibility View: per real, distinct tool (not per agent-tool pair), the
 * connections that could satisfy it and which one is actually assigned to each agent that may
 * use it — reuses `listCompatibleConnections` (the same generic-capability resolver the Agent
 * config drawer's own dropdown already uses) so there is exactly one definition of
 * "compatible", never two. */
export function buildToolCompatibilityView(db,env,tenantId) {
 return listToolDefinitions(db).map(tool=>{
  const compatible=tool.capability?listCompatibleConnections(db,tenantId,tool.capability):[];
  const assignments=agentDefinitions.map(agent=>{
   const resolution=resolveToolConnection(db,{tenantId,agentId:agent.id,toolSlug:tool.slug});
   return {agentId:agent.id,connectionId:resolution.blocked?null:resolution.connectionId||null,missingReason:resolution.blocked?resolution.reason:null};
  }).filter(a=>a.connectionId||a.missingReason);
  return {toolSlug:tool.slug,capability:tool.capability||null,compatibleConnections:compatible.map(c=>({id:c.id,name:c.name,status:c.status})),assignments};
 });
}
