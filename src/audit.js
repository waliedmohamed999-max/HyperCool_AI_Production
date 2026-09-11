import {randomUUID} from 'node:crypto';
import {resolveActiveTenantId} from './tenancy.js';

// Multi-Tenant Phase 3 — Operations Log (Audit) normalization. Before this, every audit
// entry (an approval, a connection, a publish outcome, a promotion, ...) lived inside ONE
// array (`state.audit`) serialized into the same single JSON blob `state.content` used to
// live in (`src/store.js`'s `state` table), read and rewritten IN FULL by every
// `store.mutate()`/`store.read()` call — the second of the two hard problems named for this
// phase (see docs/MULTI_TENANT_ARCHITECTURE.md).
//
// Same "indexed columns + json blob" pattern as `content_items`/`crm_leads`/
// `agent_approvals`: a few queryable columns, the full (variably-shaped — different call
// sites already attach different extra fields: `detail`, `errorCode`, `count`,
// `organizationId`, `itemName`, ...) entry preserved in `json` exactly as every existing
// call site already builds it. No call site's entry SHAPE changes, only where it is stored
// — so every pure reader (`computeRecentActivity`, `computeContentPipeline`,
// `computeContentLibrary`, `xActivity`/`linkedinActivity`/`sallaActivity`/`metaActivity`/
// `microsoftActivity`) needed zero changes, only their caller's data source did.
export function installAuditLog(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  item_id TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL,
  json TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON audit_logs(tenant_id);
 CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs(tenant_id,created_at);
 CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_action ON audit_logs(tenant_id,action);`);
 migrateLegacyStateAudit(db);
}
/**
 * One-time, idempotent backfill (same shape as content.js's migrateLegacyStateContent):
 * copies every entry out of the legacy `state.audit` array into `audit_logs`, assigning
 * every row to the one tenant that owned all pre-migration data. Guarded by "the table is
 * still empty" so a server restart never re-copies or duplicates. `state.audit` itself is
 * left completely untouched — frozen, unused historical backup from this point on; nothing
 * in the codebase reads or writes it after this module is used instead.
 *
 * The legacy array is newest-first (every call site used `.unshift()`), so this inserts in
 * REVERSE (oldest first) — that way rowid order matches real chronological order, and
 * `listAuditLog`'s `ORDER BY created_at DESC, rowid DESC` breaks same-millisecond ties
 * (common: several audit entries from one request often share an identical timestamp)
 * exactly the way the original array's order would have.
 */
function migrateLegacyStateAudit(db) {
 const alreadyMigrated=db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n>0;
 if(alreadyMigrated)return {migrated:0,skipped:'ALREADY_MIGRATED'};
 let legacy=[];
 try{const row=db.prepare('SELECT json FROM state WHERE id=1').get();legacy=row?JSON.parse(row.json).audit||[]:[];}catch{legacy=[];}
 if(!legacy.length)return {migrated:0,skipped:'NOTHING_TO_MIGRATE'};
 const tenantId=resolveActiveTenantId(db);
 const insert=db.prepare('INSERT INTO audit_logs (id,tenant_id,action,item_id,actor_id,created_at,json) VALUES (?,?,?,?,?,?,?)');
 let migrated=0;
 for(let i=legacy.length-1;i>=0;i--) {
  const entry=legacy[i];
  insert.run(entry.id||randomUUID(),tenantId,entry.action||'UNKNOWN',entry.itemId||null,entry.actorId||null,entry.at||new Date().toISOString(),JSON.stringify(entry));
  migrated++;
 }
 return {migrated,skipped:null};
}
// Writer — replaces every `state.audit.unshift(entry)` call site. Takes the exact same
// entry object every call site already built for the legacy array; only the destination
// changed. `entry.id`/`entry.action`/`entry.at` are required (every existing call site
// already sets them); `entry.itemId`/`entry.actorId` are optional (a few entries, like
// EMAIL_INGEST_FAILED, have no real actor).
export function recordAudit(db,entry,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 db.prepare('INSERT INTO audit_logs (id,tenant_id,action,item_id,actor_id,created_at,json) VALUES (?,?,?,?,?,?,?)')
  .run(entry.id,resolvedTenantId,entry.action,entry.itemId||null,entry.actorId||null,entry.at,JSON.stringify(entry));
 return entry;
}
// Reader — replaces every `state.audit`/`auditState.audit` read (`.filter()`, `.find()`,
// `[0]`, or passed whole into a pure `compute*` helper). Returns entries newest-first,
// matching the legacy array's `.unshift()`-based ordering.
export function listAuditLog(db,{tenantId=null,limit=null,sinceIso=null,action=null}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 let sql='SELECT json FROM audit_logs WHERE tenant_id=?';
 const params=[resolvedTenantId];
 if(sinceIso){sql+=' AND created_at>=?';params.push(sinceIso);}
 if(action){sql+=' AND action=?';params.push(action);}
 sql+=' ORDER BY created_at DESC, rowid DESC';
 if(limit){sql+=' LIMIT ?';params.push(limit);}
 return db.prepare(sql).all(...params).map(row=>JSON.parse(row.json));
}
