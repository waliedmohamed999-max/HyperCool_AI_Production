import {randomUUID} from 'node:crypto';
import {fail} from './auth.js';
import {agents} from './domain.js';
import {isEnabled} from './runtime/feature-flags.js';
import {recordAudit} from './audit.js';
import {resolveActiveTenantId} from './tenancy.js';

export const levels=['L0','L1','L2','L3'];
const agentIds=agents.map(agent=>agent.id);

// Multi-Tenant Phase 4B (Part 83/84) — `agent_autonomy` was entirely GLOBAL before this
// phase: one promotion ledger per agent_id, shared by every tenant. That meant a second
// tenant's agent 'sales' would inherit whatever level (and 14-day clean-run history — see
// permissions.js's promotionEligibility) the FIRST tenant had earned, a genuine cross-tenant
// leak the moment a second tenant existed (not yet reachable today, same as every other
// pre-Phase-4B agent config gap — see docs/AGENT_TOOL_MAPPING.md's audit section). The old
// `UNIQUE(agent_id,version)` constraint is also actively wrong once two tenants each
// independently promote their own 'sales' agent to version 1 — both would collide on the same
// row. This rebuilds the table with `UNIQUE(tenant_id,agent_id,version)`, using the exact
// same rename→recreate→copy pattern already proven in knowledge.js's migrateProducts/
// migrateAiRuns — a lossless backfill of every existing row into the one tenant that existed
// when this phase shipped, never invented, never dropped.
export function installAutonomy(db) {
 const legacy=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_autonomy'").get();
 if(legacy) {
  const columns=db.prepare('PRAGMA table_info(agent_autonomy)').all().map(c=>c.name);
  if(!columns.includes('tenant_id')) {
   const tenantId=resolveActiveTenantId(db);
   db.exec('ALTER TABLE agent_autonomy RENAME TO agent_autonomy_pre_tenant;');
   db.exec('CREATE TABLE agent_autonomy (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, level TEXT NOT NULL, version INTEGER NOT NULL, direction TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(tenant_id,agent_id,version));');
   db.prepare('INSERT INTO agent_autonomy (id,tenant_id,agent_id,level,version,direction,reason,actor_id,actor_name,at) SELECT id,?,agent_id,level,version,direction,reason,actor_id,actor_name,at FROM agent_autonomy_pre_tenant').run(tenantId);
   db.exec('DROP TABLE agent_autonomy_pre_tenant;');
  }
 } else {
  db.exec('CREATE TABLE IF NOT EXISTS agent_autonomy (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, level TEXT NOT NULL, version INTEGER NOT NULL, direction TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(tenant_id,agent_id,version));');
 }
 db.exec('CREATE INDEX IF NOT EXISTS idx_agent_autonomy_tenant_agent ON agent_autonomy(tenant_id,agent_id);');
}
export function listAutonomyLog(db,agentId,tenantId=null) {
 if(!agentIds.includes(agentId))fail(404,'وكيل غير موجود');
 return db.prepare('SELECT id,level,version,direction,reason,actor_name AS actorName,at FROM agent_autonomy WHERE tenant_id=? AND agent_id=? ORDER BY version DESC').all(tenantId||resolveActiveTenantId(db),agentId);
}
export function listAutonomyChanges(db,sinceIso,tenantId=null) {
 return db.prepare('SELECT agent_id AS agentId,level,direction,reason,actor_name AS actorName,at FROM agent_autonomy WHERE tenant_id=? AND at>=? ORDER BY at DESC').all(tenantId||resolveActiveTenantId(db),sinceIso);
}
export function currentAutonomy(db,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const rows=db.prepare(`SELECT agent_id AS agentId,level,version,reason,actor_name AS actorName,at FROM agent_autonomy a WHERE tenant_id=? AND version=(SELECT MAX(version) FROM agent_autonomy b WHERE b.tenant_id=a.tenant_id AND b.agent_id=a.agent_id)`).all(resolvedTenantId);
 const map=new Map(rows.map(row=>[row.agentId,row]));
 return Object.fromEntries(agentIds.map(id=>[id,map.get(id)||{agentId:id,level:'L0',version:0,reason:null,actorName:null,at:null}]));
}
export function setAutonomy(store,agentId,input,user,env={},tenantId=null) {
 if(!agentIds.includes(agentId))fail(404,'وكيل غير موجود');
 if(!levels.includes(input.level))fail(400,'مستوى صلاحية غير صالح');
 const reason=typeof input.reason==='string'?input.reason.trim():'';
 if(!reason||reason.length>1000)fail(400,'سبب تغيير الصلاحية مطلوب (حتى 1000 حرف)');
 const resolvedTenantId=tenantId||resolveActiveTenantId(store.db);
 return store.mutate(()=>{
  const last=store.db.prepare('SELECT level,version FROM agent_autonomy WHERE tenant_id=? AND agent_id=? ORDER BY version DESC LIMIT 1').get(resolvedTenantId,agentId);
  const current=last?.level||'L0',currentVersion=last?.version||0;
  if(input.expectedVersion!==currentVersion)fail(409,'تغيّر مستوى صلاحية الوكيل؛ حدّث الصفحة قبل الحفظ');
  const currentIndex=levels.indexOf(current),nextIndex=levels.indexOf(input.level);
  if(nextIndex===currentIndex)fail(409,'الوكيل على هذا المستوى بالفعل');
  // Promotion is capped at one step, matching the scope's autonomy ladder. Demotion can drop further in one action — an immediate safety valve needs no ladder.
  if(nextIndex>currentIndex+1)fail(409,'الترقية خطوة واحدة في كل مرة؛ لا يمكن تخطي مستويات');
  // Launch safety gate (Final Production Safe Launch Phase, Part 93): even an owner's
  // otherwise-valid, one-step promotion to L2/L3 is refused unless the corresponding env
  // flag is turned on — "one human action" alone is not enough for the two highest-risk
  // levels; the operator must ALSO have deliberately unlocked that tier at the deployment
  // level first. Checked only once the request is otherwise legitimate, so this never
  // masks a genuine version-conflict or skip-level error with a less specific one.
  if(nextIndex>currentIndex && ((input.level==='L2'&&!isEnabled(env,'ENABLE_L2_AUTONOMY'))||(input.level==='L3'&&!isEnabled(env,'ENABLE_L3_AUTONOMY'))))
   fail(403,`الترقية إلى ${input.level} معطّلة على مستوى النظام — فعّل ENABLE_${input.level}_AUTONOMY في إعدادات الخادم أولًا`);
  const direction=nextIndex>currentIndex?'PROMOTED':'DEMOTED';
  const entry={id:randomUUID(),tenantId:resolvedTenantId,agentId,level:input.level,version:currentVersion+1,direction,reason,actorId:user.id,actorName:user.name,at:new Date().toISOString(),previousLevel:current};
  store.db.prepare('INSERT INTO agent_autonomy (id,tenant_id,agent_id,level,version,direction,reason,actor_id,actor_name,at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(entry.id,entry.tenantId,agentId,entry.level,entry.version,direction,reason,user.id,user.name,entry.at);
  recordAudit(store.db,{id:randomUUID(),action:direction==='PROMOTED'?'AGENT_PROMOTED':'AGENT_DEMOTED',itemId:agentId,actorId:user.id,actorName:user.name,actorRole:user.role,at:entry.at,detail:`${current} → ${input.level}`},resolvedTenantId);
  return entry;
 });
}
