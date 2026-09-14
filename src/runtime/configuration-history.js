import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {recordAudit} from '../audit.js';
import {getAssignment,upsertAssignment} from './tool-assignments.js';

// Command Center Phase 7B (spec Part 20-23) — reversible configuration history for changes
// INITIATED FROM THE COMMAND CENTER specifically (not a general audit of every config screen
// in the app — Control Center's own agent-tool editor already has its own audit trail via
// AGENT_TOOL_CONNECTION_CHANGED). Deliberately a new, small, additive table rather than trying
// to parse it back out of audit_logs's free-form `detail` JSON — the spec's own item 55
// explicitly allows this. v1 records exactly the one real, reversible configuration capability
// Command Center chat can make (`update_agent_tool_connection`, tools.js) — the only
// configuration write capability that exists there; nothing here fabricates reversibility for
// a change type that doesn't actually have a safe, canonical "undo" path yet.
export function installConfigurationHistory(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS configuration_change_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT,
  actor_id TEXT,
  actor_name TEXT,
  command_run_id TEXT,
  reversible INTEGER NOT NULL DEFAULT 0,
  reverted_at TEXT,
  reverted_by_change_id TEXT,
  created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_config_history_tenant ON configuration_change_history(tenant_id,created_at);`);
}
function hydrate(row) {
 if(!row)return null;
 return {id:row.id,tenantId:row.tenant_id,entityType:row.entity_type,entityId:row.entity_id,field:row.field,
  previousValue:row.previous_value?JSON.parse(row.previous_value):null,newValue:row.new_value?JSON.parse(row.new_value):null,
  actorId:row.actor_id,actorName:row.actor_name,commandRunId:row.command_run_id,
  reversible:!!row.reversible,revertedAt:row.reverted_at,revertedByChangeId:row.reverted_by_change_id,createdAt:row.created_at};
}
export function recordConfigurationChange(db,{tenantId,entityType,entityId,field,previousValue,newValue,actor,commandRunId=null,reversible=false}) {
 const id=randomUUID(),now=new Date().toISOString();
 db.prepare(`INSERT INTO configuration_change_history (id,tenant_id,entity_type,entity_id,field,previous_value,new_value,actor_id,actor_name,command_run_id,reversible,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(id,tenantId,entityType,entityId,field,JSON.stringify(previousValue??null),JSON.stringify(newValue??null),actor?.id||null,actor?.name||null,commandRunId,reversible?1:0,now);
 return id;
}
export function listConfigurationHistory(db,tenantId=null,{limit=50}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 return db.prepare('SELECT * FROM configuration_change_history WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?').all(resolvedTenantId,limit).map(hydrate);
}
function getChange(db,id,tenantId) {
 const row=db.prepare('SELECT * FROM configuration_change_history WHERE id=? AND tenant_id=?').get(id,tenantId);
 if(!row)fail(404,'سجل التغيير غير موجود');
 return hydrate(row);
}
/**
 * Undo (spec item 22-23): validates the change is real, reversible, and not already reverted,
 * re-applies the PREVIOUS value through the exact same canonical service the original change
 * used (`upsertAssignment` — never a raw SQL write), and audits the rollback as its own new
 * history row (so the history itself stays an honest, append-only log of what really happened,
 * never a rewritten past). Irreversible entity types (there are none yet in v1 — the one
 * capability that exists is reversible by construction) would fail here with a clear reason
 * rather than silently pretending to undo an external side effect (item 23).
 */
export function undoConfigurationChange(db,id,actor,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const change=getChange(db,id,resolvedTenantId);
 if(!change.reversible)fail(409,'لا يمكن التراجع عن هذا الإجراء — قد يكون له أثر خارجي غير قابل للعكس (CANNOT_UNDO_EXTERNAL_ACTION)');
 if(change.revertedAt)fail(409,'تم التراجع عن هذا التغيير من قبل');
 if(change.entityType!=='agent_tool_connection')fail(400,'نوع الإعداد هذا لا يدعم التراجع التلقائي بعد');
 const [targetAgentId,toolSlug]=change.entityId.split('::');
 // Stale-state guard (item 22 "validate current state"): if the connection has moved on to a
 // THIRD value since this change (not the value this change itself set), undoing blindly would
 // silently discard that newer, intentional change — refuse instead of guessing.
 const current=getAssignment(db,resolvedTenantId,targetAgentId,toolSlug);
 if((current?.connectionId||null)!==(change.newValue?.connectionId??null))
  fail(409,'تم تغيير هذا الإعداد مرة أخرى منذ هذا السجل — لا يمكن التراجع تلقائيًا لتفادي فقد تغيير أحدث');
 const restored=upsertAssignment(db,resolvedTenantId,targetAgentId,toolSlug,{connectionId:change.previousValue?.connectionId??null});
 const now=new Date().toISOString();
 const revertId=recordConfigurationChange(db,{tenantId:resolvedTenantId,entityType:'agent_tool_connection',entityId:change.entityId,field:'connectionId',
  previousValue:change.newValue,newValue:change.previousValue,actor,commandRunId:null,reversible:false});
 db.prepare('UPDATE configuration_change_history SET reverted_at=?,reverted_by_change_id=? WHERE id=?').run(now,revertId,id);
 recordAudit(db,{id:randomUUID(),action:'COMMAND_CONFIGURATION_UNDONE',itemId:id,actorId:actor?.id||null,actorName:actor?.name||null,actorRole:actor?.role||null,at:now,detail:{targetAgentId,toolSlug,restoredConnectionId:restored.connectionId}},resolvedTenantId);
 return {undone:true,assignment:restored,historyId:id,revertId};
}
