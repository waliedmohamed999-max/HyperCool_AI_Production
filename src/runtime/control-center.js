// Multi-Tenant Phase 4C-2 — Control Center summary aggregation. ONE real, tenant-scoped
// computation, server-side, reused by every Control Center tab — never N+1 fetches from the
// frontend (Phase 4B's own "avoid N+1" principle). Every number here is derived live from the
// same real services Phase 4B/4B.1 already built (AgentReadinessService, ToolReadinessService,
// IntegrationConnection, capability-map.js) — never a stored snapshot, never invented.
import {agents as agentIdentities} from '../domain.js';
import {getTenant,isTrialActive,getTrialDaysRemaining} from '../tenancy.js';
import {getTenantAgentConfig} from './agent-config.js';
import {evaluateAgentReadiness,evaluateAllToolsReadiness} from './agent-readiness.js';
import {listToolDefinitions} from './tool-definitions.js';
import {listIntegrationDefinitions} from '../integrations/definitions.js';
import {listConnections} from '../integrations/connections.js';

const AI_PROVIDERS=['anthropic','openai'];
const HEALTHY_STATUSES=new Set(['CONNECTED','DEGRADED']);

/**
 * Agents summary: real per-agent status from `evaluateAgentReadiness` (never
 * `enabled=true => READY` — Part C). `enabled` is read the exact same way `runtime.js`'s own
 * `run()` already does (tenant config overrides the legacy global registry flag).
 */
function buildAgentsSummary(db,env,tenantId) {
 const items=agentIdentities.map(agent=>{
  const config=getTenantAgentConfig(db,tenantId,agent.id);
  const readiness=evaluateAgentReadiness(db,env,{tenantId,agentId:agent.id});
  return {id:agent.id,name:agent.name,enabled:config?config.enabled:true,status:readiness.status,blockers:readiness.blockers,warnings:readiness.warnings,optionalMissing:readiness.optional_missing};
 });
 const counts={total:items.length,enabled:items.filter(i=>i.enabled).length,ready:items.filter(i=>i.status==='READY').length,partial:items.filter(i=>i.status==='PARTIAL').length,blocked:items.filter(i=>i.status==='BLOCKED').length,disabled:items.filter(i=>i.status==='DISABLED').length};
 return {...counts,items};
}
/**
 * Tools summary: the real catalog (`ToolDefinition`) plus a live tally of per-(agent,tool)
 * readiness status across all 12 agents (`ToolReadinessService`) — this is what actually
 * answers "how many tool assignments have a capability/connection issue right now", since
 * readiness is inherently per-agent, not a tool-global fact.
 */
function buildToolsSummary(db,env,tenantId) {
 const definitions=listToolDefinitions(db);
 const statusCounts={READY:0,CONNECTION_REQUIRED:0,CONNECTION_UNHEALTHY:0,CONNECTION_CAPABILITY_MISSING:0,DISABLED:0};
 for(const agent of agentIdentities) {
  for(const r of evaluateAllToolsReadiness(db,env,{tenantId,agentId:agent.id})) {
   if(r.status in statusCounts)statusCounts[r.status]++;
  }
 }
 return {total:definitions.length,available:definitions.filter(t=>t.isAvailable!==false).length,unavailable:definitions.filter(t=>t.isAvailable===false).length,statusCounts};
}
/** Integrations summary: real `IntegrationDefinition` catalog + real, tenant-scoped connections
 * per provider, honest `connectionMode` (Phase 4B.1) — never inventing multi-connection support
 * a provider doesn't actually have. Universal Integration Platform (Phase 6D, Part 39/40): a
 * DRAFT connector (never yet published by a Platform Admin) is excluded outright — it must
 * never be visible to any tenant, catalog-only or otherwise. A DISABLED one still appears (an
 * existing connection must remain manageable/visible in Health) but carries its real `status`
 * so the frontend can honestly grey out "add a new connection" without a second isAvailable
 * concept drifting from it. */
function buildIntegrationsSummary(db,tenantId) {
 const definitions=listIntegrationDefinitions(db).filter(d=>d.status!=='DRAFT');
 const providers=definitions.map(def=>{
  const connections=listConnections(db,{integrationDefinitionId:def.slug},tenantId);
  return {slug:def.slug,nameAr:def.nameAr,nameEn:def.nameEn,category:def.category,isAvailable:def.isAvailable,connectionMode:def.connectionMode,
   status:def.status,capabilities:def.capabilities,isSystem:def.isSystem,
   connections:connections.map(c=>({id:c.id,name:c.name,status:c.status,isDefault:c.isDefault,externalAccountName:c.externalAccountName,lastHealthCheck:c.lastHealthCheck,lastSuccessAt:c.lastSuccessAt,lastErrorAt:c.lastErrorAt,lastErrorCode:c.lastErrorCode,lastErrorMessageSafe:c.lastErrorMessageSafe,scopes:c.scopes}))};
 });
 const allConnections=providers.flatMap(p=>p.connections);
 return {configuredProviders:providers.filter(p=>p.connections.length>0).length,healthyConnections:allConnections.filter(c=>HEALTHY_STATUSES.has(c.status)).length,unhealthyConnections:allConnections.filter(c=>!HEALTHY_STATUSES.has(c.status)).length,providers};
}
/** AI Providers: tenant-scoped Anthropic/OpenAI connections, enriched with which real agents currently point at each (via TenantAgentConfig.ai_connection_id) — never a fabricated "usage" count. */
function buildAiProvidersSummary(db,tenantId) {
 const connections=AI_PROVIDERS.flatMap(provider=>listConnections(db,{integrationDefinitionId:provider},tenantId));
 return connections.map(connection=>{
  const agentsUsing=agentIdentities.filter(agent=>getTenantAgentConfig(db,tenantId,agent.id)?.aiConnectionId===connection.id).map(agent=>agent.id);
  return {id:connection.id,provider:connection.integrationDefinitionId,name:connection.name,status:connection.status,isDefault:connection.isDefault,agentsUsing};
 });
}
/**
 * The one real entry point every Control Center tab reads from. `env` is required (readiness
 * evaluation needs it for the AI-provider-configured check, exactly like every other readiness
 * call site in this codebase).
 */
export function buildControlCenterSummary(db,env,tenantId,role) {
 const tenant=getTenant(db,tenantId);
 return {
  workspace:{id:tenant.id,name:tenant.name,slug:tenant.slug,role,locale:tenant.defaultLocale,timezone:tenant.timezone,status:tenant.status,defaultAiConnectionId:tenant.defaultAiConnectionId,defaultAiModel:tenant.defaultAiModel,maxAgentLevel:tenant.maxAgentLevel,
   // Multi-Tenant Phase 4C-6 — real, derived trial state (Part 60); null for any tenant with
   // no trial timestamps at all (the legacy HyperCool tenant, or any non-self-service tenant).
   trial:tenant.trialExpiresAt?{active:isTrialActive(tenant),daysRemaining:getTrialDaysRemaining(tenant),expiresAt:tenant.trialExpiresAt}:null},
  agents:buildAgentsSummary(db,env,tenantId),
  tools:buildToolsSummary(db,env,tenantId),
  integrations:buildIntegrationsSummary(db,tenantId),
  aiProviders:buildAiProvidersSummary(db,tenantId)
 };
}
