import {fail} from './auth.js';
import {resolveActiveTenantId} from './tenancy.js';

// Multi-Tenant Phase 3 — Content normalization. Before this, every content item (a draft,
// a reviewed/approved post, a published record) lived inside ONE array (`state.content`)
// serialized into a single JSON blob (`src/store.js`'s `state` table), read and rewritten
// IN FULL by every `store.mutate()`/`store.read()` call across 11 files. That made real
// per-tenant isolation of content structurally impossible — every tenant shared the exact
// same array.
//
// This table follows the SAME "indexed columns + json blob" pattern already used
// successfully everywhere else in this codebase (`crm_leads`, `agent_approvals`, `memory`,
// `agent_escalations`) rather than modeling every nested field (`review`, `approval`,
// `sourceContext`, `aiDecision`, ...) as its own SQL column — those stay exactly as
// `src/domain.js`'s existing, unchanged, pure `createContent`/`reviewContent`/
// `approveContent` functions already shape them; only WHERE they are stored changed.
export function installContent(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS content_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  platform TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  json TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_content_items_tenant ON content_items(tenant_id);
 CREATE INDEX IF NOT EXISTS idx_content_items_tenant_status ON content_items(tenant_id,status);
 CREATE INDEX IF NOT EXISTS idx_content_items_tenant_date ON content_items(tenant_id,date);`);
 migrateLegacyStateContent(db);
}
/**
 * One-time, idempotent backfill (spec Part 14): copies every item out of the legacy
 * `state.content` array into the new table, preserving its real id, assigning it to the one
 * tenant that owns all pre-migration data (lossless — same principle as every earlier
 * Phase 1/2 migration). Runs at most once — guarded by "the table is still empty" so a
 * server restart never re-copies or duplicates. `state.content` itself is left completely
 * untouched (Part J: never deleted in the first migration) — it becomes a frozen, unused
 * historical backup the moment this runs; nothing in the codebase reads or writes it after
 * this module is used instead (see docs/CONTENT_MIGRATION.md for the exact call-site list).
 */
function migrateLegacyStateContent(db) {
 const alreadyMigrated=db.prepare('SELECT COUNT(*) n FROM content_items').get().n>0;
 if(alreadyMigrated)return {migrated:0,skipped:'ALREADY_MIGRATED'};
 let legacy=[];
 try{const row=db.prepare('SELECT json FROM state WHERE id=1').get();legacy=row?JSON.parse(row.json).content||[]:[];}catch{legacy=[];}
 if(!legacy.length)return {migrated:0,skipped:'NOTHING_TO_MIGRATE'};
 const tenantId=resolveActiveTenantId(db);
 const insert=db.prepare('INSERT INTO content_items (id,tenant_id,status,platform,date,created_at,json) VALUES (?,?,?,?,?,?,?)');
 let migrated=0;
 for(const item of legacy) {
  insert.run(item.id,tenantId,item.status,item.platform,item.date,item.createdAt||new Date().toISOString(),JSON.stringify(item));
  migrated++;
 }
 return {migrated,skipped:null};
}
export function listContent(db,tenantId=null) {
 return db.prepare('SELECT json FROM content_items WHERE tenant_id=? ORDER BY created_at DESC').all(tenantId||resolveActiveTenantId(db)).map(row=>JSON.parse(row.json));
}
// Throws (404), matching getLead's convention — used by routes/tools that must refuse a
// wrong-tenant or nonexistent id identically (never a distinguishable "exists but is not
// yours" response).
export function getContent(db,id,tenantId=null) {
 if(typeof id!=='string')fail(400,'معرف المحتوى مطلوب');
 const row=db.prepare('SELECT json FROM content_items WHERE id=? AND tenant_id=?').get(id,tenantId||resolveActiveTenantId(db));
 if(!row)fail(404,'المحتوى غير موجود');
 return JSON.parse(row.json);
}
// Non-throwing counterpart for the several call sites that already handle "not found"
// themselves (e.g. a tool handler returning {status:'NO_DATA'} rather than failing the run).
export function getContentOrNull(db,id,tenantId=null) {
 const row=db.prepare('SELECT json FROM content_items WHERE id=? AND tenant_id=?').get(id,tenantId||resolveActiveTenantId(db));
 return row?JSON.parse(row.json):null;
}
export function insertContent(db,item,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const createdAt=item.createdAt||new Date().toISOString();
 db.prepare('INSERT INTO content_items (id,tenant_id,status,platform,date,created_at,json) VALUES (?,?,?,?,?,?,?)')
  .run(item.id,resolvedTenantId,item.status,item.platform,item.date,createdAt,JSON.stringify(item));
 return item;
}
// Persists an in-place edit to an existing row (status/date can legitimately change across
// the content lifecycle — review/approve/revise/publish — so both indexed columns are kept
// in sync with the json blob on every write, never left stale).
export function writeContent(db,item) {
 db.prepare('UPDATE content_items SET status=?,platform=?,date=?,json=? WHERE id=?').run(item.status,item.platform,item.date,JSON.stringify(item),item.id);
 return item;
}
