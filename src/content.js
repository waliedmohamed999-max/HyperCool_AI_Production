import {createHash} from 'node:crypto';
import {fail} from './auth.js';
import {resolveActiveTenantId} from './tenancy.js';

// Content Unification: the one shared discriminator between the two content shapes that now
// live in the same content_items table — a legacy standalone post never has a `hook` property
// at all (undefined), while every campaign-originated row always has one (possibly null, but
// present). Any code built around the legacy review{}/approval{} shape (e.g. the flat "Content"
// review page, /api/state, content-ops.js's dashboard) must filter with this before assuming
// that shape, since a campaign-originated row would otherwise crash or produce noisy output.
export function isCampaignShaped(item) { return item!=null && item.hook!==undefined; }

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
 migrateContentItemsColumns(db);
}
// Content Unification — makes content_items the ONE canonical table for both simple
// standalone posts (the shape this table already had) and richer campaign content (formerly
// src/marketing.js's separate campaign_content_items table). Additive ALTER TABLE ADD COLUMN,
// same house style already used by marketing.js (orchestration_workflow_id, compliance_*
// columns) rather than a full rebuild — this table's own top comment already documents "few
// real columns + json blob" as a deliberate design, so this stays consistent with that, only
// adding the columns real SQL filtering (campaign/platform/format/status/date-range) needs.
// Split into two steps on purpose: this column-only step is safe to run unconditionally inside
// installContent() (many test fixtures call installContent() alone, without the rest of the
// app stack, and insertContent/writeContent always reference these 4 columns) — it has no
// dependency on schedule_jobs. The data-copy step below (migrateUnifyContentItems) DOES need
// schedule_jobs to already exist (owned by src/planning.js), so it must stay a separate,
// explicit call made only after installPlanning() has run — see src/application.js.
function migrateContentItemsColumns(db) {
 const columns=db.prepare('PRAGMA table_info(content_items)').all().map(c=>c.name);
 if(columns.includes('campaign_id'))return;
 // TECH DEBT / TODO (production-readiness gate item 10): connection_id is stored and
 // filterable (see listContentFiltered) but NOT wired into any publish credential resolution.
 // meta_publish/x_publish/linkedin_publish (src/marketing.js) resolve ONE tenant-wide,
 // platform-wide credential per platform — exactly as before this column existed — and never
 // read item.connectionId. Neither createCampaignContentItem nor updateCampaignContentItem
 // (src/marketing.js) accept a caller-supplied connectionId at all; it is always null on every
 // row created today. A real "Account Routing" layer (choosing WHICH connected account among
 // several for the same platform actually publishes a given item) is genuine future work, not
 // a migrated gap — do not build UI or API behavior that implies a specific account is already
 // selected until that layer exists.
 for(const [name,def] of [['campaign_id','TEXT'],['format','TEXT'],['scheduled_at','TEXT'],['connection_id','TEXT']]) {
  db.exec(`ALTER TABLE content_items ADD COLUMN ${name} ${def}`);
 }
 db.exec(`CREATE INDEX IF NOT EXISTS idx_content_items_tenant_campaign ON content_items(tenant_id,campaign_id);
  CREATE INDEX IF NOT EXISTS idx_content_items_tenant_scheduled ON content_items(tenant_id,scheduled_at);`);
}
// campaign_content_items itself is renamed (never dropped) to campaign_content_items_pre_unify
// — a permanent, inert historical backup, never read or written after this runs. Idempotent:
// guarded FIRST by checking the backup name doesn't already exist (once migrated, always
// no-ops, regardless of whether anything ever recreates an empty campaign_content_items again),
// then by checking the original table actually has rows to copy.
// Production-readiness gate item 7 (realistic legacy states): a corrupted OPTIONAL JSON blob
// (hashtags/creative brief/compliance) must never abort the migration or discard the record —
// it degrades to a safe empty default and is logged, while every core field (id/body/status/
// platform/campaign) is preserved untouched. A truly unparseable core field (e.g. an unknown
// status) still aborts loudly via fail() below, inside the transaction, so it never leaves a
// half-migrated database — see the BEGIN IMMEDIATE/COMMIT/ROLLBACK wrapper in the caller.
function safeJsonParse(raw,fallback,context) {
 if(!raw)return fallback;
 try {return JSON.parse(raw);} catch(error) {
  console.warn(`[migrateUnifyContentItems] تجاهل JSON تالف أثناء الترحيل (${context}): ${error.message}`);
  return fallback;
 }
}
export function migrateUnifyContentItems(db) {
 migrateContentItemsColumns(db);
 const alreadyMigrated=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_content_items_pre_unify'").get();
 if(alreadyMigrated)return {migrated:0,skipped:'ALREADY_MIGRATED'};
 const legacyTable=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_content_items'").get();
 if(!legacyTable)return {migrated:0,skipped:'NO_CAMPAIGN_TABLE'};
 const rows=db.prepare('SELECT * FROM campaign_content_items').all();
 // Status values must stay within CONTENT_STATUSES (src/marketing.js) — 'REVIEWED'/collapsing
 // SCHEDULED into APPROVED were a legacy-vocabulary leak from an earlier draft of this map that
 // does not match the live updateCampaignContentItem() adapter, which keeps status:'SCHEDULED'
 // literally (real scheduling state lives in the schedule_jobs row's own status/scheduled_at,
 // not a fictional content-status value) and prepareDue()'s own validity check, which requires
 // status==='SCHEDULED' for campaign-shaped jobs. A one-to-one identity map here (not a
 // collapse) is what keeps migrated rows consistent with rows created after migration.
 const statusMap={DRAFT:'DRAFT',IN_REVIEW:'IN_REVIEW',APPROVED:'APPROVED',SCHEDULED:'SCHEDULED',PUBLISHED:'PUBLISHED',FAILED:'FAILED'};
 const insert=db.prepare(`INSERT INTO content_items (id,tenant_id,status,platform,date,created_at,json,campaign_id,format,scheduled_at,connection_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
 const insertJob=db.prepare('INSERT INTO schedule_jobs (id,tenant_id,content_id,status,scheduled_at,json) VALUES (?,?,?,?,?,?)');
 let migrated=0,scheduled=0;
 // Item 7 (fail safely): the whole migration is one atomic transaction — any row that cannot be
 // migrated safely (e.g. an unrecognized status) rolls back EVERYTHING, leaving
 // campaign_content_items completely untouched and safe to retry after the data is fixed,
 // rather than leaving a half-migrated database with some rows copied and the source table not
 // yet renamed (which a retry could then fail to redo, or duplicate).
 db.exec('BEGIN IMMEDIATE');
 try {
 for(const row of rows) {
  const hashtags=safeJsonParse(row.hashtags_json,[],`hashtags_json, id=${row.id}`);
  const creativeBrief=safeJsonParse(row.creative_brief_json,null,`creative_brief_json, id=${row.id}`);
  const compliance=safeJsonParse(row.compliance_json,null,`compliance_json, id=${row.id}`);
  const anchorDate=(row.scheduled_at||row.published_at||row.created_at||'').slice(0,10)||row.created_at.slice(0,10);
  // Production-readiness gate item 11 (state-machine compatibility): an unrecognized legacy
  // status must fail the migration loudly, never silently coerce to a made-up default that
  // would hide real data corruption in the pre-unify table.
  if(!Object.prototype.hasOwnProperty.call(statusMap,row.status))fail(500,`حالة محتوى حملة غير معروفة أثناء الترحيل: ${row.status} (المعرف: ${row.id})`);
  const status=statusMap[row.status];
  const item={
   id:row.id,title:(row.hook||row.body||'').slice(0,80),body:row.body||'',englishCopy:null,url:null,assetUrl:null,
   platform:row.channel,date:anchorDate,status,campaignId:row.campaign_id||null,format:row.format||null,
   scheduledAt:row.scheduled_at||null,connectionId:null,objective:row.objective||null,audience:row.audience||null,
   hook:row.hook||null,cta:row.cta||null,hashtags,creativeBrief,
   complianceRunId:row.compliance_run_id||null,complianceClassification:row.compliance_classification||null,
   compliance,complianceCheckedAt:row.compliance_checked_at||null,complianceContentHash:row.compliance_content_hash||null,
   creativeRunId:row.creative_run_id||null,
   externalPostId:null,liveUrl:null,publishedAt:row.published_at||null,
   createdBy:row.created_by||null,createdByName:row.created_by_name||null,createdAt:row.created_at
  };
  insert.run(item.id,row.tenant_id,item.status,item.platform,item.date,item.createdAt,JSON.stringify(item),item.campaignId,item.format,item.scheduledAt,item.connectionId);
  migrated++;
  if(item.status==='SCHEDULED' && item.scheduledAt) {
   const jobId=row.id+'-migrated-job';
   // Same field set the canonical contentHash() (src/planning.js) hashes for campaign-shaped
   // content — computed inline here (not imported) to avoid content.js importing from
   // planning.js, which already imports FROM content.js (a real circular-import risk).
   const migratedHash=createHash('sha256').update(JSON.stringify({platform:item.platform,format:item.format,hook:item.hook||'',body:item.body||'',cta:item.cta||'',hashtags:item.hashtags||[]})).digest('hex');
   const jobJson={id:jobId,contentId:item.id,slotId:null,status:'SCHEDULED',scheduledAt:item.scheduledAt,contentHash:migratedHash,approvalId:null,scheduledBy:'MIGRATION',createdAt:item.createdAt};
   insertJob.run(jobId,row.tenant_id,item.id,'SCHEDULED',item.scheduledAt,JSON.stringify(jobJson));
   scheduled++;
  }
 }
 db.exec('ALTER TABLE campaign_content_items RENAME TO campaign_content_items_pre_unify');
 db.exec('COMMIT');
 } catch(error) { db.exec('ROLLBACK'); throw error; }
 return {migrated,scheduled,skipped:null};
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
 db.prepare('INSERT INTO content_items (id,tenant_id,status,platform,date,created_at,json,campaign_id,format,scheduled_at,connection_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  .run(item.id,resolvedTenantId,item.status,item.platform,item.date,createdAt,JSON.stringify(item),item.campaignId||null,item.format||null,item.scheduledAt||null,item.connectionId||null);
 return item;
}
// Persists an in-place edit to an existing row (status/date can legitimately change across
// the content lifecycle — review/approve/revise/publish — so both indexed columns are kept
// in sync with the json blob on every write, never left stale). campaign_id/format/
// scheduled_at/connection_id are Content Unification additions (formerly campaign_content_
// items' own real columns) — kept in sync the same way for real SQL filtering.
export function writeContent(db,item) {
 db.prepare('UPDATE content_items SET status=?,platform=?,date=?,json=?,campaign_id=?,format=?,scheduled_at=?,connection_id=? WHERE id=?')
  .run(item.status,item.platform,item.date,JSON.stringify(item),item.campaignId||null,item.format||null,item.scheduledAt||null,item.connectionId||null,item.id);
 return item;
}
// Content Unification — the one filtered read both the Global Calendar (public/planning.js)
// and the Marketing Social Calendar (via src/marketing.js's listCampaignContentItems adapter)
// call, so they are structurally guaranteed to see the same rows. `campaignId` accepts the
// literal string 'none' to mean "campaign_id IS NULL" (standalone content only) since a plain
// falsy value already means "no campaign filter at all".
export function listContentFiltered(db,tenantId=null,{campaignId,platform,format,status,dateFrom,dateTo}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 let sql='SELECT json FROM content_items WHERE tenant_id=?';
 const params=[resolvedTenantId];
 if(campaignId==='none'){sql+=' AND campaign_id IS NULL';}
 else if(campaignId){sql+=' AND campaign_id=?';params.push(campaignId);}
 if(platform){sql+=' AND platform=?';params.push(platform);}
 if(format){sql+=' AND format=?';params.push(format);}
 if(status){sql+=' AND status=?';params.push(status);}
 if(dateFrom){sql+=' AND date>=?';params.push(dateFrom);}
 if(dateTo){sql+=' AND date<=?';params.push(dateTo);}
 sql+=' ORDER BY COALESCE(scheduled_at,date) ASC';
 return db.prepare(sql).all(...params).map(row=>JSON.parse(row.json));
}
