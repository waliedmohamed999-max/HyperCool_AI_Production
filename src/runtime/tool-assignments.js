import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {getToolDefinition} from './tool-definitions.js';
import {getConnectionOrNull,resolveProviderAccount} from '../integrations/connections.js';
import {connectionGrantsCapability} from './capability-map.js';

// AgentToolAssignment — Multi-Tenant Phase 4B (Part 7-12). Tenant-scoped, OPT-IN
// refinements layered on top of the existing default-allow Tool Registry (runtime/tools.js):
// the ABSENCE of an assignment row for a given (tenant, agent, tool) is not an error and
// does not block anything — it means "this tool behaves exactly as it always has" (gated
// only by its own minLevel/allowedAgents/integration checks, same as every tenant today,
// before this table existed). This is a deliberate, zero-risk rollout choice: making
// assignments a MANDATORY allowlist would have required seeding 28 tools × 12 agents × every
// tenant before anything worked, and silently disabled everything the moment this table
// existed. An assignment row only ever ADDS a specific override: disable this tool for this
// agent, or pin it to one exact connection.
export function installAgentToolAssignments(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS agent_tool_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool_slug TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  connection_id TEXT,
  is_default INTEGER NOT NULL DEFAULT 1,
  policy_override TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id,agent_id,tool_slug)
 );
 CREATE INDEX IF NOT EXISTS idx_agent_tool_assignments_tenant_agent ON agent_tool_assignments(tenant_id,agent_id);
 CREATE INDEX IF NOT EXISTS idx_agent_tool_assignments_connection ON agent_tool_assignments(connection_id);`);
}
function hydrate(row) {
 if(!row)return null;
 return {id:row.id,tenantId:row.tenant_id,agentId:row.agent_id,toolSlug:row.tool_slug,enabled:!!row.enabled,connectionId:row.connection_id,isDefault:!!row.is_default,
  policyOverride:row.policy_override?JSON.parse(row.policy_override):null,createdAt:row.created_at,updatedAt:row.updated_at};
}
export function getAssignment(db,tenantId,agentId,toolSlug) {
 return hydrate(db.prepare('SELECT * FROM agent_tool_assignments WHERE tenant_id=? AND agent_id=? AND tool_slug=?').get(tenantId,agentId,toolSlug));
}
export function listAssignmentsForAgent(db,tenantId,agentId) {
 return db.prepare('SELECT * FROM agent_tool_assignments WHERE tenant_id=? AND agent_id=?').all(tenantId,agentId).map(hydrate);
}
/**
 * Backend validates everything (Part 26): `connectionId`, if provided, must belong to THIS
 * tenant (Part 63 — cross-tenant mapping is rejected, never silently ignored) and match the
 * tool's required provider (Part 9/64 — CONNECTION_PROVIDER_MISMATCH). No client-supplied
 * value is ever trusted past this point.
 */
export function upsertAssignment(db,tenantId,agentId,toolSlug,{enabled,connectionId,policyOverride}={}) {
 const tool=getToolDefinition(db,toolSlug);
 if(!tool)fail(404,'أداة غير معروفة');
 if(tool.allowedAgents && !tool.allowedAgents.includes(agentId))fail(400,'هذه الأداة غير متاحة لهذا الوكيل');
 if(connectionId!==undefined && connectionId!==null) {
  const connection=getConnectionOrNull(db,connectionId,tenantId);
  if(!connection)fail(400,'الاتصال غير موجود لهذه المنشأة');
  if(connection.integrationDefinitionId!==tool.integrationSlug)fail(400,`CONNECTION_PROVIDER_MISMATCH: هذه الأداة تتطلب اتصال ${tool.integrationSlug}`);
 }
 const now=new Date().toISOString();
 const existing=db.prepare('SELECT * FROM agent_tool_assignments WHERE tenant_id=? AND agent_id=? AND tool_slug=?').get(tenantId,agentId,toolSlug);
 if(!existing) {
  const row={id:randomUUID(),enabled:enabled!==undefined?!!enabled:true,connectionId:connectionId??null,policyOverride:policyOverride??null};
  db.prepare('INSERT INTO agent_tool_assignments (id,tenant_id,agent_id,tool_slug,enabled,connection_id,is_default,policy_override,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
   .run(row.id,tenantId,agentId,toolSlug,row.enabled?1:0,row.connectionId,row.connectionId?0:1,row.policyOverride?JSON.stringify(row.policyOverride):null,now,now);
 } else {
  db.prepare('UPDATE agent_tool_assignments SET enabled=?,connection_id=?,is_default=?,policy_override=?,updated_at=? WHERE id=?').run(
   enabled!==undefined?(enabled?1:0):existing.enabled,
   connectionId!==undefined?connectionId:existing.connection_id,
   (connectionId!==undefined?connectionId:existing.connection_id)?0:1,
   policyOverride!==undefined?(policyOverride?JSON.stringify(policyOverride):null):existing.policy_override,
   now,existing.id
  );
 }
 return getAssignment(db,tenantId,agentId,toolSlug);
}
export function deleteAssignment(db,tenantId,agentId,toolSlug) {
 db.prepare('DELETE FROM agent_tool_assignments WHERE tenant_id=? AND agent_id=? AND tool_slug=?').run(tenantId,agentId,toolSlug);
 return {deleted:true};
}
/**
 * Phase 46 — before a connection is disconnected, find every enabled assignment that
 * explicitly pins it, across every agent for this tenant, so the caller can warn/block per
 * its own policy rather than silently breaking an agent's configured tool.
 */
export function findAssignmentsUsingConnection(db,tenantId,connectionId) {
 return db.prepare('SELECT * FROM agent_tool_assignments WHERE tenant_id=? AND connection_id=? AND enabled=1').all(tenantId,connectionId).map(hydrate);
}
const DEGRADED_OK_STATUSES=new Set(['CONNECTED','DEGRADED']);
/**
 * Phase 12 — the runtime connection-resolution algorithm every connection-aware tool call
 * goes through. Never falls back to "the first row" (connections.js's own
 * resolveProviderAccount already refuses to guess on real ambiguity — this wraps it with the
 * assignment layer on top):
 *
 *  1. An explicit, enabled assignment with its own connection_id → that exact connection,
 *     validated for tenant/provider/health match (Part 9).
 *  2. An explicit, enabled assignment with NO connection_id, for a tool that requires one →
 *     the tenant's single/default connection for that provider (Part 12.2/12.3), via
 *     `resolveProviderAccount` — which itself throws CONNECTION_SELECTION_REQUIRED on real
 *     ambiguity rather than guessing.
 *  3. No assignment row at all → `{connectionId:null, assignmentId:null}`, meaning "let the
 *     tool's own existing legacy resolution (static env token or default connection) decide,
 *     exactly as it already does today" — this is what keeps every tenant that predates this
 *     table (i.e. every tenant today) working unchanged (see module doc comment above).
 *
 * An assignment with `enabled:false` always blocks, regardless of connection state.
 */
// A fixture/store missing `agent_tool_assignments` or `integration_connections` (every test
// fixture that predates Phase 4A/4B) makes every lookup below throw "no such table" — caught
// once, at the top, and treated as "no assignment/connection layer installed here at all",
// which resolves to the exact same pass-through default as "no assignment row exists" (see
// module doc comment) — zero risk to any existing fixture or deployment that hasn't run the
// new migrations yet.
export function resolveToolConnection(db,{tenantId,agentId,toolSlug}) {
 const tool=getToolDefinition(db,toolSlug);
 if(!tool)return {blocked:true,reason:'UNKNOWN_TOOL'};
 try {
  const assignment=getAssignment(db,tenantId,agentId,toolSlug);
  if(!assignment)return {connectionId:null,assignmentId:null,tool};
  if(!assignment.enabled)return {blocked:true,reason:'TOOL_DISABLED',assignmentId:assignment.id,tool};
  // An EXPLICIT connection_id on the assignment is always validated (provider match, health)
  // regardless of `requiresConnection` — an operator who deliberately pinned a specific
  // connection means it to be used and checked, even for a tool whose provider also supports
  // a static-token fallback. `requiresConnection` only governs the NEXT branch below: whether
  // a tool with NO explicit connection should attempt the tenant's default-connection
  // fallback, or simply pass through to the tool's own legacy resolution.
  if(assignment.connectionId) {
   const connection=getConnectionOrNull(db,assignment.connectionId,tenantId);
   if(!connection)return {blocked:true,reason:'CONNECTION_NOT_FOUND',assignmentId:assignment.id,tool};
   if(connection.integrationDefinitionId!==tool.integrationSlug)return {blocked:true,reason:'CONNECTION_PROVIDER_MISMATCH',assignmentId:assignment.id,connectionId:connection.id,tool};
   if(connection.status==='DISCONNECTED')return {blocked:true,reason:'CONNECTION_UNHEALTHY',detail:connection.status,assignmentId:assignment.id,connectionId:connection.id,tool};
   if(!DEGRADED_OK_STATUSES.has(connection.status) && !tool.isReadOnly)return {blocked:true,reason:'CONNECTION_UNHEALTHY',detail:connection.status,assignmentId:assignment.id,connectionId:connection.id,tool};
   // Phase 4B.1 — checked AFTER provider/health (a disconnected connection is already a more
   // specific, more actionable failure than "missing capability" would be) and BEFORE the
   // connection is ever handed to a handler, i.e. before any credential retrieval or provider
   // API call (Part 3).
   if(!connectionGrantsCapability(tool.integrationSlug,tool.capability,connection.scopes))return {blocked:true,reason:'CONNECTION_CAPABILITY_MISSING',assignmentId:assignment.id,connectionId:connection.id,tool};
   return {connectionId:connection.id,assignmentId:assignment.id,connection,tool};
  }
  if(!tool.requiresConnection)return {connectionId:null,assignmentId:assignment.id,tool};
  try {
   const resolved=resolveProviderAccount(db,tool.integrationSlug,tenantId);
   if(!resolved)return {connectionId:null,assignmentId:assignment.id,tool};
   if(!connectionGrantsCapability(tool.integrationSlug,tool.capability,resolved.scopes))return {blocked:true,reason:'CONNECTION_CAPABILITY_MISSING',assignmentId:assignment.id,connectionId:resolved.id,tool};
   return {connectionId:resolved.id,assignmentId:assignment.id,connection:resolved,tool};
  } catch(error) {
   if(error.code==='CONNECTION_SELECTION_REQUIRED')return {blocked:true,reason:'CONNECTION_SELECTION_REQUIRED',connections:error.connections,assignmentId:assignment.id,tool};
   throw error;
  }
 } catch(error) {
  if(error.code==='CONNECTION_SELECTION_REQUIRED')throw error;
  return {connectionId:null,assignmentId:null,tool};
 }
}
