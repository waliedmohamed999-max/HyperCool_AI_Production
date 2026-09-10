import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';

// AgentApprovalService — the generic approval center for agent-proposed actions that
// don't already have a dedicated human gate. Content already has review/approve
// (src/domain.js) and CRM follow-ups already have approveFollowup (src/crm.js); this
// table is deliberately NOT a replacement for either — it only covers the actions the
// spec lists that had no home yet: discount, large_quote, memory_policy_change,
// medical_claim, agent_permission_change, send_marketing_message.
export const ACTION_TYPES=['publish_content','send_marketing_message','discount','large_quote','memory_policy_change','medical_claim','agent_permission_change'];

export function installApprovals(db) {
 db.exec('CREATE TABLE IF NOT EXISTS agent_approvals (id TEXT PRIMARY KEY, run_id TEXT, agent_id TEXT NOT NULL, action_type TEXT NOT NULL, proposed_output TEXT NOT NULL, risk_level TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, decided_by TEXT, decided_by_name TEXT, decided_at TEXT, created_at TEXT NOT NULL);');
}
export function createApproval(db,{runId,agentId,actionType,proposedOutput,riskLevel,reason}) {
 if(!ACTION_TYPES.includes(actionType))fail(400,'نوع إجراء غير معروف للموافقة');
 const row={id:randomUUID(),runId,agentId,actionType,proposedOutput,riskLevel,reason,status:'PENDING',createdAt:new Date().toISOString()};
 db.prepare('INSERT INTO agent_approvals (id,run_id,agent_id,action_type,proposed_output,risk_level,reason,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(row.id,row.runId,row.agentId,row.actionType,JSON.stringify(row.proposedOutput),row.riskLevel,row.reason,row.status,row.createdAt);
 return row;
}
export function listApprovals(db,{status}={}) {
 const rows=status?db.prepare('SELECT * FROM agent_approvals WHERE status=? ORDER BY created_at DESC').all(status)
  :db.prepare('SELECT * FROM agent_approvals ORDER BY created_at DESC').all();
 return rows.map(row=>({...row,proposed_output:JSON.parse(row.proposed_output)}));
}
export function decideApproval(db,id,decision,user) {
 if(!['APPROVED','EDITED','REJECTED'].includes(decision))fail(400,'قرار غير صالح');
 const row=db.prepare('SELECT * FROM agent_approvals WHERE id=?').get(id);
 if(!row)fail(404,'طلب الموافقة غير موجود');
 if(row.status!=='PENDING')fail(409,'تم اتخاذ قرار على هذا الطلب بالفعل');
 db.prepare('UPDATE agent_approvals SET status=?,decided_by=?,decided_by_name=?,decided_at=? WHERE id=?')
  .run(decision,user.id,user.name,new Date().toISOString(),id);
 return db.prepare('SELECT * FROM agent_approvals WHERE id=?').get(id);
}
