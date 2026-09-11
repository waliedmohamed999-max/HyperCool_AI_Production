import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {agents} from '../domain.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {getAgent as getAgentDefinition} from './registry.js';
import {getConnectionOrNull} from '../integrations/connections.js';

// TenantAgentConfig — Multi-Tenant Phase 4B (Part 2). `agent_registry` (registry.js) stays
// the GLOBAL AgentDefinition (identity, prompt, description — see agents.js/agents/*.md);
// this table is the per-tenant configuration layer that used to be smeared across
// `agent_registry.enabled/provider/model/temperature/max_tokens` as if those were somehow
// already tenant-scoped, when in fact `agent_registry` has never had a tenant_id column at
// all — every tenant sharing one enabled flag and one model override was a real,
// pre-existing cross-tenant leak (see docs/AGENT_TOOL_MAPPING.md's audit section), just
// unreachable until a second tenant exists. This table is the fix.
//
// Deliberately does NOT store its own `permission_level` column: the audited, append-only
// L0-L3 ledger already exists and is now itself tenant-scoped (src/autonomy.js, this same
// phase) — duplicating "current level" here would create two sources of truth that could
// drift. The effective level a run actually uses is still `effectiveLevel(currentAutonomy
// level, env, tenant.max_agent_level)` (permissions.js) — this table only adds the AI
// connection/model/sampling override and the enabled flag, which genuinely had no tenant-
// scoped home before this phase.
const agentIds=agents.map(agent=>agent.id);
const SUPPORTED_AI_PROVIDERS=['anthropic','openai'];

export function installTenantAgentConfigs(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS tenant_agent_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  ai_connection_id TEXT,
  model TEXT,
  temperature REAL,
  max_tokens INTEGER,
  timeout_ms INTEGER,
  approval_policy TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id,agent_id)
 );
 CREATE INDEX IF NOT EXISTS idx_tenant_agent_configs_tenant ON tenant_agent_configs(tenant_id);`);
}
function hydrate(row) {
 if(!row)return null;
 return {
  id:row.id,tenantId:row.tenant_id,agentId:row.agent_id,enabled:!!row.enabled,
  aiConnectionId:row.ai_connection_id,model:row.model,temperature:row.temperature,maxTokens:row.max_tokens,timeoutMs:row.timeout_ms,
  approvalPolicy:row.approval_policy?JSON.parse(row.approval_policy):null,createdAt:row.created_at,updatedAt:row.updated_at
 };
}
// A fixture/store that never called installTenantAgentConfigs() (every test fixture that
// predates this phase) has no such table — treated as "no override exists yet" (null),
// exactly like a real tenant that hasn't been seeded yet (Part 49/50's own default). This is
// the ONE piece of tenant-scoped agent config with no in-memory fallback (unlike
// tool-definitions.js's metadata fallback) since it's inherently persisted, per-tenant state
// — callers (runtime.js) already treat a null config as "use the pre-Phase-4B legacy global
// default", which is the correct, zero-risk behavior here too.
export function getTenantAgentConfig(db,tenantId,agentId) {
 try{return hydrate(db.prepare('SELECT * FROM tenant_agent_configs WHERE tenant_id=? AND agent_id=?').get(tenantId,agentId));}
 catch{return null;}
}
export function listTenantAgentConfigs(db,tenantId) {
 try{return db.prepare('SELECT * FROM tenant_agent_configs WHERE tenant_id=?').all(tenantId).map(hydrate);}
 catch{return [];}
}
/**
 * Phase 49/50 default seed. For each of the 12 real AgentDefinitions, creates a
 * TenantAgentConfig row IF ONE DOES NOT ALREADY EXIST for this tenant — never overwrites an
 * existing row (idempotent, like seedRegistry). `enabled` inherits from the legacy GLOBAL
 * `agent_registry.enabled` flag at seed time ONLY (a one-time migration convenience so an
 * already-configured HyperCool tenant doesn't silently lose its current enabled/disabled
 * agents on upgrade — Part 91: "no data loss") — every OTHER field starts genuinely empty
 * (no AI connection override, no model override), and no external tool is auto-assigned
 * (Part 52: external sends stay off by default for any newly-seeded config, including a
 * brand-new tenant's).
 */
export function seedTenantAgentConfigs(db,tenantId) {
 const now=new Date().toISOString();
 const insert=db.prepare('INSERT OR IGNORE INTO tenant_agent_configs (id,tenant_id,agent_id,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?)');
 let created=0;
 for(const agentId of agentIds) {
  const legacy=getAgentDefinition(db,agentId);
  const result=insert.run(randomUUID(),tenantId,agentId,legacy?(legacy.enabled?1:0):1,now,now);
  created+=Number(result.changes);
 }
 return {seeded:agentIds.length,created};
}
function validateAiConnection(db,tenantId,connectionId) {
 if(connectionId===null||connectionId===undefined)return null;
 const connection=getConnectionOrNull(db,connectionId,tenantId);
 if(!connection)fail(400,'اتصال الذكاء الاصطناعي غير موجود لهذه المنشأة');
 if(!SUPPORTED_AI_PROVIDERS.includes(connection.integrationDefinitionId))fail(400,'الاتصال المحدد ليس اتصال مزوّد ذكاء اصطناعي (Anthropic/OpenAI)');
 return connectionId;
}
/**
 * Backend validates everything (Part 26/76): the AI connection, if provided, must belong to
 * THIS tenant and actually be an anthropic/openai connection — never trusted from the client.
 * `enabled`/`model`/`temperature`/`maxTokens`/`timeoutMs`/`approvalPolicy` left `undefined`
 * keep their current stored value; pass `null` explicitly to clear an override back to the
 * workspace/system default, matching the established convention (registry.js's
 * setModelConfig, credentials.js's updateCredentialsMetadata).
 */
export function updateTenantAgentConfig(db,tenantId,agentId,patch={}) {
 if(!agentIds.includes(agentId))fail(404,'وكيل غير موجود');
 if(patch.temperature!==undefined && patch.temperature!==null && (typeof patch.temperature!=='number'||patch.temperature<0||patch.temperature>2))fail(400,'درجة الحرارة يجب أن تكون بين 0 و2');
 if(patch.maxTokens!==undefined && patch.maxTokens!==null && (!Number.isInteger(patch.maxTokens)||patch.maxTokens<1||patch.maxTokens>32000))fail(400,'الحد الأقصى للرموز يجب أن يكون عددًا صحيحًا موجبًا');
 if(patch.timeoutMs!==undefined && patch.timeoutMs!==null && (!Number.isInteger(patch.timeoutMs)||patch.timeoutMs<1000||patch.timeoutMs>300000))fail(400,'المهلة يجب أن تكون بين 1000 و300000 مللي ثانية');
 if(patch.aiConnectionId!==undefined)validateAiConnection(db,tenantId,patch.aiConnectionId);
 const now=new Date().toISOString();
 const existing=db.prepare('SELECT * FROM tenant_agent_configs WHERE tenant_id=? AND agent_id=?').get(tenantId,agentId);
 if(!existing) {
  const row={id:randomUUID(),tenantId,agentId,enabled:patch.enabled!==undefined?!!patch.enabled:true,
   aiConnectionId:patch.aiConnectionId??null,model:patch.model??null,temperature:patch.temperature??null,maxTokens:patch.maxTokens??null,timeoutMs:patch.timeoutMs??null,
   approvalPolicy:patch.approvalPolicy??null};
  db.prepare('INSERT INTO tenant_agent_configs (id,tenant_id,agent_id,enabled,ai_connection_id,model,temperature,max_tokens,timeout_ms,approval_policy,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(row.id,tenantId,agentId,row.enabled?1:0,row.aiConnectionId,row.model,row.temperature,row.maxTokens,row.timeoutMs,row.approvalPolicy?JSON.stringify(row.approvalPolicy):null,now,now);
  return getTenantAgentConfig(db,tenantId,agentId);
 }
 db.prepare(`UPDATE tenant_agent_configs SET enabled=?,ai_connection_id=?,model=?,temperature=?,max_tokens=?,timeout_ms=?,approval_policy=?,updated_at=? WHERE tenant_id=? AND agent_id=?`).run(
  patch.enabled!==undefined?(patch.enabled?1:0):existing.enabled,
  patch.aiConnectionId!==undefined?patch.aiConnectionId:existing.ai_connection_id,
  patch.model!==undefined?patch.model:existing.model,
  patch.temperature!==undefined?patch.temperature:existing.temperature,
  patch.maxTokens!==undefined?patch.maxTokens:existing.max_tokens,
  patch.timeoutMs!==undefined?patch.timeoutMs:existing.timeout_ms,
  patch.approvalPolicy!==undefined?(patch.approvalPolicy?JSON.stringify(patch.approvalPolicy):null):existing.approval_policy,
  now,tenantId,agentId
 );
 return getTenantAgentConfig(db,tenantId,agentId);
}
