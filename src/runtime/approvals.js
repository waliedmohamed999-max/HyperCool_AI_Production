import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {resolveActiveTenantId} from '../tenancy.js';

// AgentApprovalService — the generic approval center for agent-proposed actions that
// don't already have a dedicated human gate. Content already has review/approve
// (src/domain.js) and CRM follow-ups already have approveFollowup (src/crm.js); this
// table is deliberately NOT a replacement for either — it only covers the actions the
// spec lists that had no home yet: discount, large_quote, memory_policy_change,
// medical_claim, agent_permission_change, send_marketing_message.
// Multi-Tenant Phase 4B (Part 40) adds exactly one new action type — `agent_tool_send` — the
// generic resume-execution path for a connection-aware tool gated by ToolDefinition.
// requiresApprovalBelowLevel (see runtime.js/tools.js). This is NOT a new approval engine:
// it reuses this exact table/decide flow, the same way `send_marketing_message` already did
// for email.
export const ACTION_TYPES=['publish_content','send_marketing_message','discount','large_quote','memory_policy_change','medical_claim','agent_permission_change','agent_tool_send'];

// Multi-Tenant Phase 2 (spec Part 14 — Approval isolation): a real `tenant_id`, same
// optional-trailing-param pattern as Phase 1. `createApproval`'s callers (agent tool
// handlers across tools.js/knowledge.js) pass an options object, so `tenantId` is just
// another optional key in it rather than a new positional argument — no call site needed
// to change.
export function installApprovals(db) {
 const legacy=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_approvals'").get();
 if(legacy) {
  const columns=db.prepare('PRAGMA table_info(agent_approvals)').all().map(c=>c.name);
  if(!columns.includes('tenant_id'))db.exec('ALTER TABLE agent_approvals ADD COLUMN tenant_id TEXT');
  // Multi-Tenant Phase 4B (Part 41) — additive columns so an approval can preserve exactly
  // which tool/assignment/connection it was raised for, and a resume-at-decide-time can
  // re-validate that SAME connection is still available (Part 42) rather than silently
  // switching to whatever the tenant's default happens to be at decide time.
  for(const name of ['tool_slug','assignment_id','connection_id'])
   if(!columns.includes(name))db.exec(`ALTER TABLE agent_approvals ADD COLUMN ${name} TEXT`);
 } else {
  db.exec('CREATE TABLE IF NOT EXISTS agent_approvals (id TEXT PRIMARY KEY, tenant_id TEXT, run_id TEXT, agent_id TEXT NOT NULL, action_type TEXT NOT NULL, proposed_output TEXT NOT NULL, risk_level TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, decided_by TEXT, decided_by_name TEXT, decided_at TEXT, created_at TEXT NOT NULL, tool_slug TEXT, assignment_id TEXT, connection_id TEXT);');
 }
 db.exec('CREATE INDEX IF NOT EXISTS idx_agent_approvals_status ON agent_approvals(status);');
 db.exec('CREATE INDEX IF NOT EXISTS idx_agent_approvals_tenant ON agent_approvals(tenant_id);');
 // Backfill: any row saved before this column existed belongs to the one tenant that
 // existed at the time (lossless, matches the Phase 1 pattern — never invented, never lost).
 const unresolved=db.prepare('SELECT COUNT(*) n FROM agent_approvals WHERE tenant_id IS NULL').get().n;
 if(unresolved>0)db.prepare('UPDATE agent_approvals SET tenant_id=? WHERE tenant_id IS NULL').run(resolveActiveTenantId(db));
}
export function createApproval(db,{runId,agentId,actionType,proposedOutput,riskLevel,reason,tenantId=null,toolSlug=null,assignmentId=null,connectionId=null}) {
 if(!ACTION_TYPES.includes(actionType))fail(400,'نوع إجراء غير معروف للموافقة');
 const row={id:randomUUID(),tenantId:tenantId||resolveActiveTenantId(db),runId,agentId,actionType,proposedOutput,riskLevel,reason,status:'PENDING',createdAt:new Date().toISOString(),toolSlug,assignmentId,connectionId};
 db.prepare('INSERT INTO agent_approvals (id,tenant_id,run_id,agent_id,action_type,proposed_output,risk_level,reason,status,created_at,tool_slug,assignment_id,connection_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(row.id,row.tenantId,row.runId,row.agentId,row.actionType,JSON.stringify(row.proposedOutput),row.riskLevel,row.reason,row.status,row.createdAt,row.toolSlug,row.assignmentId,row.connectionId);
 return row;
}
export function listApprovals(db,{status}={},tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const rows=status?db.prepare('SELECT * FROM agent_approvals WHERE status=? AND tenant_id=? ORDER BY created_at DESC').all(status,resolvedTenantId)
  :db.prepare('SELECT * FROM agent_approvals WHERE tenant_id=? ORDER BY created_at DESC').all(resolvedTenantId);
 return rows.map(row=>({...row,proposed_output:JSON.parse(row.proposed_output)}));
}
export function decideApproval(db,id,decision,user,tenantId=null) {
 if(!['APPROVED','EDITED','REJECTED'].includes(decision))fail(400,'قرار غير صالح');
 const row=db.prepare('SELECT * FROM agent_approvals WHERE id=? AND tenant_id=?').get(id,tenantId||resolveActiveTenantId(db));
 if(!row)fail(404,'طلب الموافقة غير موجود');
 if(row.status!=='PENDING')fail(409,'تم اتخاذ قرار على هذا الطلب بالفعل');
 db.prepare('UPDATE agent_approvals SET status=?,decided_by=?,decided_by_name=?,decided_at=? WHERE id=?')
  .run(decision,user.id,user.name,new Date().toISOString(),id);
 return db.prepare('SELECT * FROM agent_approvals WHERE id=?').get(id);
}
