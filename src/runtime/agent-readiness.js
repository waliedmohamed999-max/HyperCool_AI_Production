import {getTenantAgentConfig} from './agent-config.js';
import {getTenant} from '../tenancy.js';
import {getConnectionOrNull} from '../integrations/connections.js';
import {hasCredential} from '../integrations/vault.js';
import {getToolDefinition,listToolDefinitions} from './tool-definitions.js';
import {resolveToolConnection} from './tool-assignments.js';
import {integrationStatus} from './tools.js';
import {providerStatus} from './llmProvider.js';
import {getAgent as getAgentDefinition} from './registry.js';

// AgentReadinessService + ToolReadinessService — Multi-Tenant Phase 4B (Part 28-34).
// Readiness is a DIFFERENT question from Connection Health (Phase 4A): a connection can be
// perfectly CONNECTED while an agent is still BLOCKED because it has the wrong (or no)
// assignment, is disabled, or its AI provider isn't configured — see
// docs/AGENT_READINESS.md's "Health vs Readiness" section (Part 80). This module never
// reports READY just because `enabled=true` (Part 31) — every status is derived from a real
// check against tenant_agent_configs, agent_tool_assignments, integration_connections, and
// the vault, never a stored badge.
//
// REQUIRED_TOOLS/OPTIONAL_TOOLS (Part 6, 53-56) is a first-pass, deliberately conservative
// policy for readiness REPORTING only — it does not gate tool execution (that stays exactly
// where it already was: minLevel/allowedAgents/assignment checks in runtime.js). An agent
// is never treated as needing more than what it genuinely cannot function without; every
// external-integration tool is optional (Part 52: external sends stay off by default), since
// no tenant is ever forced to connect a specific provider just to enable an agent.
const REQUIRED_TOOLS={
 frost:[],strategy:['search_brand_memory'],copy:['search_brand_memory'],creative:['search_brand_memory'],
 compliance:['search_brand_memory'],publishing:[],leads:['create_lead','search_crm'],
 sales:['get_lead','create_lead','update_lead','search_crm'],followup:['get_recent_replies','create_followup'],
 intelligence:['get_competitor_data'],performance:['get_metrics'],memory:['search_brand_memory','propose_memory_update'],
 frost_commander:[]
};
const OPTIONAL_TOOLS={
 frost:[],strategy:['get_competitor_data'],copy:[],creative:['canva_generateAsset'],compliance:[],
 publishing:['meta_publish','x_publish','linkedin_publish'],leads:['get_current_price','get_stock'],
 sales:['get_product','get_current_price','get_stock','whatsapp_send','microsoft_sendEmail','create_calendar_event','get_calendar_availability'],
 followup:['whatsapp_send','microsoft_sendEmail'],intelligence:[],performance:[],memory:[],frost_commander:[]
};
export function requiredToolsFor(agentId) { return REQUIRED_TOOLS[agentId]||[]; }
export function optionalToolsFor(agentId) { return OPTIONAL_TOOLS[agentId]||[]; }

const CONNECTION_REQUIRED_REASONS=new Set(['CONNECTION_NOT_FOUND','CONNECTION_PROVIDER_MISMATCH','CONNECTION_SELECTION_REQUIRED']);
/**
 * Phase 33 — per-tool readiness. `legacyConfigured` (optional, precomputed by
 * evaluateAgentReadiness to avoid recomputing per tool) tells this whether the tool's
 * provider is reachable via the pre-Phase-4A static-env-token path even when no formal
 * connection/assignment exists — see tools.js's own doc comment on why requiresConnection is
 * false for most provider-backed tools.
 */
export function evaluateToolReadiness(db,env,{tenantId,agentId,toolSlug},legacyConfigured=null) {
 const tool=getToolDefinition(db,toolSlug);
 if(!tool)return {status:'DISABLED',toolSlug,reason:'UNKNOWN_TOOL'};
 if(tool.isAvailable===false)return {status:'DISABLED',toolSlug,reason:'NOT_IMPLEMENTED'};
 const resolution=resolveToolConnection(db,{tenantId,agentId,toolSlug});
 if(resolution.blocked) {
  if(resolution.reason==='TOOL_DISABLED')return {status:'DISABLED',toolSlug,reason:resolution.reason};
  if(resolution.reason==='CONNECTION_UNHEALTHY')return {status:'CONNECTION_UNHEALTHY',toolSlug,reason:resolution.reason,detail:resolution.detail};
  // Phase 4B.1 — a real, distinct status: the connection is the right provider and healthy,
  // but its actual granted OAuth scopes don't cover what this tool needs (never conflated
  // with the generic CONNECTION_REQUIRED bucket — a UI needs to tell an operator "reconnect
  // with more permissions" apart from "connect something at all").
  if(resolution.reason==='CONNECTION_CAPABILITY_MISSING')return {status:'CONNECTION_CAPABILITY_MISSING',toolSlug,reason:resolution.reason};
  if(CONNECTION_REQUIRED_REASONS.has(resolution.reason))return {status:'CONNECTION_REQUIRED',toolSlug,reason:resolution.reason};
  return {status:'CONNECTION_REQUIRED',toolSlug,reason:resolution.reason};
 }
 if(tool.integrationSlug && !resolution.connectionId) {
  const configured=legacyConfigured?legacyConfigured[tool.integrationSlug]:null;
  if(configured===false)return {status:'CONNECTION_REQUIRED',toolSlug,reason:'NOT_CONFIGURED'};
 }
 return {status:'READY',toolSlug};
}
function computeLegacyConfigured(env,db) {
 const status=integrationStatus(env,db);
 let sallaConfigured=!!env.SALLA_ACCESS_TOKEN;
 try{sallaConfigured=sallaConfigured||!!db.prepare("SELECT 1 FROM integration_connections WHERE integration_definition_id='salla' AND status NOT IN ('DISCONNECTED')").get();}catch{/* table may not exist in a bare fixture */}
 return {whatsapp:status.whatsapp.configured,meta:status.meta.configured,x:status.x.configured,linkedin:status.linkedin.configured,microsoft365:status.microsoft365.configured,canva:status.canva.configured,salla:sallaConfigured};
}
function resolveAiReadiness(db,env,tenantId,agentId,tenantConfig) {
 const tenant=getTenant(db,tenantId);
 const connectionId=tenantConfig?.aiConnectionId||tenant?.defaultAiConnectionId||null;
 if(connectionId) {
  const connection=getConnectionOrNull(db,connectionId,tenantId);
  if(!connection)return {status:'BLOCKED',reason:'AI_CONNECTION_NOT_FOUND'};
  if(connection.status==='DISCONNECTED')return {status:'BLOCKED',reason:'AI_CONNECTION_DISCONNECTED'};
  if(!hasCredential(db,connection.id,tenantId))return {status:'BLOCKED',reason:'AI_CONNECTION_NO_CREDENTIAL'};
  if(['ERROR','TOKEN_EXPIRED'].includes(connection.status))return {status:'BLOCKED',reason:'AI_CONNECTION_UNHEALTHY'};
  return {status:'READY',connectionId:connection.id,provider:connection.integrationDefinitionId};
 }
 // No explicit connection assigned — falls back to the pre-Phase-4A env-var default exactly
 // as today (Anthropic/OpenAI have no OTHER credential source before this phase's Vault).
 const registryRow=getAgentDefinition(db,agentId);
 const status=providerStatus(env,{provider:registryRow?.provider,model:tenantConfig?.model||registryRow?.model});
 return status.configured?{status:'READY',provider:status.provider}:{status:'BLOCKED',reason:'AI_NOT_CONFIGURED'};
}
/**
 * Phase 28-31. Never returns READY just because `enabled=true` — every branch below is a
 * real check. `optional_missing` lists optional tools whose provider genuinely isn't usable
 * yet (informational, non-blocking); `blockers` are why the agent cannot run at all;
 * `warnings` mirror optional gaps in human-readable form for a future UI to surface.
 */
export function evaluateAgentReadiness(db,env,{tenantId,agentId}) {
 const config=getTenantAgentConfig(db,tenantId,agentId);
 if(config && !config.enabled)return {status:'DISABLED',required:{ai:'N/A',tools:'N/A'},optional_missing:[],blockers:['AGENT_DISABLED'],warnings:[]};
 const ai=resolveAiReadiness(db,env,tenantId,agentId,config);
 const legacyConfigured=computeLegacyConfigured(env,db);
 const required=requiredToolsFor(agentId).map(toolSlug=>evaluateToolReadiness(db,env,{tenantId,agentId,toolSlug},legacyConfigured));
 const optional=optionalToolsFor(agentId).map(toolSlug=>evaluateToolReadiness(db,env,{tenantId,agentId,toolSlug},legacyConfigured));
 const blockers=[];
 if(ai.status!=='READY')blockers.push(ai.reason);
 const requiredBlocked=required.filter(r=>r.status!=='READY');
 for(const r of requiredBlocked)blockers.push(`REQUIRED_TOOL_${r.status}:${r.toolSlug}`);
 const optionalMissing=optional.filter(r=>r.status!=='READY').map(r=>r.toolSlug);
 const status=blockers.length?'BLOCKED':optionalMissing.length?'PARTIAL':'READY';
 return {
  status,
  required:{ai:ai.status,tools:requiredBlocked.length?'BLOCKED':'READY'},
  optional_missing:optionalMissing,
  blockers,
  warnings:optionalMissing.map(slug=>`${slug} غير جاهز (اتصال غير مُعد) — الوكيل يعمل بدونها`)
 };
}
export function evaluateAllToolsReadiness(db,env,{tenantId,agentId}) {
 const legacyConfigured=computeLegacyConfigured(env,db);
 return listToolDefinitions(db).filter(t=>!t.allowedAgents||t.allowedAgents.includes(agentId)).map(t=>evaluateToolReadiness(db,env,{tenantId,agentId,toolSlug:t.slug},legacyConfigured));
}
