import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';

// AgentEscalationService — the Human Handoff surface. Doubles as the "task/notification"
// mechanism the spec asks for rather than standing up a separate Tasks model: this
// project has no tasks table today, and an escalation IS the task ("someone must act").
export const PRIORITIES=['P0','P1','P2','P3','P4','P5'];

export function installEscalations(db) {
 db.exec('CREATE TABLE IF NOT EXISTS agent_escalations (id TEXT PRIMARY KEY, run_id TEXT, agent_id TEXT NOT NULL, priority TEXT NOT NULL, reason TEXT NOT NULL, context TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT, resolved_by_name TEXT);');
 db.exec('CREATE INDEX IF NOT EXISTS idx_agent_escalations_status ON agent_escalations(status);');
}
export function createEscalation(db,{runId,agentId,priority,reason,context}) {
 if(!PRIORITIES.includes(priority))fail(400,'أولوية غير معروفة');
 const row={id:randomUUID(),runId,agentId,priority,reason,context,status:'OPEN',createdAt:new Date().toISOString()};
 db.prepare('INSERT INTO agent_escalations (id,run_id,agent_id,priority,reason,context,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(row.id,row.runId,row.agentId,row.priority,row.reason,JSON.stringify(row.context),row.status,row.createdAt);
 return row;
}
export function listEscalations(db,{status}={}) {
 const rows=status?db.prepare('SELECT * FROM agent_escalations WHERE status=? ORDER BY priority,created_at').all(status)
  :db.prepare("SELECT * FROM agent_escalations ORDER BY (status='OPEN') DESC,priority,created_at DESC").all();
 return rows.map(row=>({...row,context:JSON.parse(row.context)}));
}
export function resolveEscalation(db,id,user) {
 const row=db.prepare('SELECT * FROM agent_escalations WHERE id=?').get(id);
 if(!row)fail(404,'التصعيد غير موجود');
 if(row.status==='RESOLVED')fail(409,'تم حل هذا التصعيد بالفعل');
 db.prepare('UPDATE agent_escalations SET status=?,resolved_at=?,resolved_by=?,resolved_by_name=? WHERE id=?')
  .run('RESOLVED',new Date().toISOString(),user.id,user.name,id);
 return db.prepare('SELECT * FROM agent_escalations WHERE id=?').get(id);
}
