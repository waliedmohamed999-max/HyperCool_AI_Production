import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {resolveActiveTenantId} from '../tenancy.js';

// AgentEscalationService — the Human Handoff surface. Doubles as the "task/notification"
// mechanism the spec asks for rather than standing up a separate Tasks model: this
// project has no tasks table today, and an escalation IS the task ("someone must act").
export const PRIORITIES=['P0','P1','P2','P3','P4','P5'];

// Multi-Tenant Phase 2: real `tenant_id`, same optional-trailing-param pattern as every
// other table this pass — a resolver from another tenant must never see or resolve this
// tenant's hot-lead/compliance/publish-failure escalations.
export function installEscalations(db) {
 const legacy=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_escalations'").get();
 if(legacy) {
  const columns=db.prepare('PRAGMA table_info(agent_escalations)').all().map(c=>c.name);
  if(!columns.includes('tenant_id'))db.exec('ALTER TABLE agent_escalations ADD COLUMN tenant_id TEXT');
 } else {
  db.exec('CREATE TABLE IF NOT EXISTS agent_escalations (id TEXT PRIMARY KEY, tenant_id TEXT, run_id TEXT, agent_id TEXT NOT NULL, priority TEXT NOT NULL, reason TEXT NOT NULL, context TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT, resolved_by_name TEXT);');
 }
 db.exec('CREATE INDEX IF NOT EXISTS idx_agent_escalations_status ON agent_escalations(status);');
 db.exec('CREATE INDEX IF NOT EXISTS idx_agent_escalations_tenant ON agent_escalations(tenant_id);');
 const unresolved=db.prepare('SELECT COUNT(*) n FROM agent_escalations WHERE tenant_id IS NULL').get().n;
 if(unresolved>0)db.prepare('UPDATE agent_escalations SET tenant_id=? WHERE tenant_id IS NULL').run(resolveActiveTenantId(db));
}
export function createEscalation(db,{runId,agentId,priority,reason,context,tenantId=null}) {
 if(!PRIORITIES.includes(priority))fail(400,'أولوية غير معروفة');
 const row={id:randomUUID(),tenantId:tenantId||resolveActiveTenantId(db),runId,agentId,priority,reason,context,status:'OPEN',createdAt:new Date().toISOString()};
 db.prepare('INSERT INTO agent_escalations (id,tenant_id,run_id,agent_id,priority,reason,context,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(row.id,row.tenantId,row.runId,row.agentId,row.priority,row.reason,JSON.stringify(row.context),row.status,row.createdAt);
 return row;
}
export function listEscalations(db,{status}={},tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const rows=status?db.prepare('SELECT * FROM agent_escalations WHERE status=? AND tenant_id=? ORDER BY priority,created_at').all(status,resolvedTenantId)
  :db.prepare("SELECT * FROM agent_escalations WHERE tenant_id=? ORDER BY (status='OPEN') DESC,priority,created_at DESC").all(resolvedTenantId);
 return rows.map(row=>({...row,context:JSON.parse(row.context)}));
}
export function resolveEscalation(db,id,user,tenantId=null) {
 const row=db.prepare('SELECT * FROM agent_escalations WHERE id=? AND tenant_id=?').get(id,tenantId||resolveActiveTenantId(db));
 if(!row)fail(404,'التصعيد غير موجود');
 if(row.status==='RESOLVED')fail(409,'تم حل هذا التصعيد بالفعل');
 db.prepare('UPDATE agent_escalations SET status=?,resolved_at=?,resolved_by=?,resolved_by_name=? WHERE id=?')
  .run('RESOLVED',new Date().toISOString(),user.id,user.name,id);
 return db.prepare('SELECT * FROM agent_escalations WHERE id=?').get(id);
}
