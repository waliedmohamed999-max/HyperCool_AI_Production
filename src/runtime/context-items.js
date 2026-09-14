import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {recordAudit} from '../audit.js';

// ContextItem — Frost Command Center (Phase 7A) "Data & Context" / manual context intake /
// Company Brain. One governed, tenant-isolated store for structured+free-text company
// knowledge a human explicitly recorded — never a second Memory engine (src/knowledge.js
// stays the versioned, approval-gated fact store used inside agent prompts; this table is the
// human-facing intake/notes layer the Command Center's "+ Add Context" form and "Company
// Brain" page write to). Company Brain is simply the `brain_*` types below, rendered as their
// own section — not a separate table.
export const CONTEXT_TYPES=[
 'company_goal','business_rule','client_note','campaign_note','operational_issue','decision',
 'policy','product_information','brand_information','sales_context',
 'brain_identity','brain_goals','brain_customers','brain_products','brain_brand','brain_rules'
];
const PRIORITIES=['LOW','MEDIUM','HIGH'];

export function installContextItems(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS context_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  structured_json TEXT,
  category TEXT,
  related_client_id TEXT,
  related_project TEXT,
  priority TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  tags_json TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','ARCHIVED')),
  pinned INTEGER NOT NULL DEFAULT 0,
  confidence REAL,
  created_by TEXT,
  created_by_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
 );
 CREATE INDEX IF NOT EXISTS idx_context_items_tenant_status ON context_items(tenant_id,status);
 CREATE INDEX IF NOT EXISTS idx_context_items_tenant_type ON context_items(tenant_id,type);`);
}
function hydrate(row) {
 if(!row)return null;
 return {
  id:row.id,tenantId:row.tenant_id,type:row.type,title:row.title,description:row.description,
  structured:row.structured_json?JSON.parse(row.structured_json):null,category:row.category,
  relatedClientId:row.related_client_id,relatedProject:row.related_project,priority:row.priority,
  source:row.source,tags:row.tags_json?JSON.parse(row.tags_json):[],status:row.status,pinned:!!row.pinned,
  confidence:row.confidence,createdBy:row.created_by,createdByName:row.created_by_name,
  createdAt:row.created_at,updatedAt:row.updated_at,expiresAt:row.expires_at
 };
}
function validateFields({type,title,description,priority,confidence,tags}) {
 if(!CONTEXT_TYPES.includes(type))fail(400,'نوع السياق غير معروف');
 const cleanTitle=typeof title==='string'?title.trim():'';
 if(!cleanTitle||cleanTitle.length>200)fail(400,'العنوان مطلوب (حتى 200 حرف)');
 const cleanDescription=typeof description==='string'?description.trim():'';
 if(cleanDescription.length>5000)fail(400,'الوصف طويل جدًا (حتى 5000 حرف)');
 if(priority!==undefined && priority!==null && !PRIORITIES.includes(priority))fail(400,'الأولوية يجب أن تكون LOW أو MEDIUM أو HIGH');
 if(confidence!==undefined && confidence!==null && (typeof confidence!=='number'||confidence<0||confidence>1))fail(400,'مستوى الثقة يجب أن يكون بين 0 و1');
 if(tags!==undefined && tags!==null && !Array.isArray(tags))fail(400,'الوسوم يجب أن تكون قائمة نصوص');
 return {title:cleanTitle,description:cleanDescription};
}
export function createContextItem(db,input,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const {title,description}=validateFields(input);
 const now=new Date().toISOString();
 const row={
  id:randomUUID(),tenantId:resolvedTenantId,type:input.type,title,description,
  structured:input.structured||null,category:input.category?.trim()||null,
  relatedClientId:input.relatedClientId||null,relatedProject:input.relatedProject?.trim()||null,
  priority:input.priority||null,source:(input.source?.trim())||'manual',
  tags:Array.isArray(input.tags)?input.tags.slice(0,20).map(t=>String(t).trim()).filter(Boolean):[],
  pinned:!!input.pinned,confidence:input.confidence??null,
  createdBy:user?.id||null,createdByName:user?.name||null,expiresAt:input.expiresAt||null
 };
 db.prepare(`INSERT INTO context_items (id,tenant_id,type,title,description,structured_json,category,related_client_id,related_project,priority,source,tags_json,status,pinned,confidence,created_by,created_by_name,created_at,updated_at,expires_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?,?,?,?)`)
  .run(row.id,row.tenantId,row.type,row.title,row.description,row.structured?JSON.stringify(row.structured):null,
   row.category,row.relatedClientId,row.relatedProject,row.priority,row.source,JSON.stringify(row.tags),
   row.pinned?1:0,row.confidence,row.createdBy,row.createdByName,now,now,row.expiresAt);
 recordAudit(db,{id:randomUUID(),action:'CONTEXT_ITEM_CREATED',itemId:row.id,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getContextItem(db,row.id,resolvedTenantId);
}
export function getContextItem(db,id,tenantId=null) {
 const row=db.prepare('SELECT * FROM context_items WHERE id=? AND tenant_id=?').get(id,tenantId||resolveActiveTenantId(db));
 if(!row)fail(404,'عنصر السياق غير موجود');
 return hydrate(row);
}
export function listContextItems(db,tenantId=null,{type,status='ACTIVE'}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const rows=type
  ?db.prepare('SELECT * FROM context_items WHERE tenant_id=? AND type=? AND status=? ORDER BY pinned DESC,created_at DESC').all(resolvedTenantId,type,status)
  :db.prepare('SELECT * FROM context_items WHERE tenant_id=? AND status=? ORDER BY pinned DESC,created_at DESC').all(resolvedTenantId,status);
 return rows.map(hydrate);
}
// Spec item 43 — freshness is DERIVED, never a third stored status: a row keeps its real
// stored status (ACTIVE/ARCHIVED) forever; STALE is just "ACTIVE but past its own expires_at",
// computed at read time so it can never drift from the truth the way a cached flag could.
export function withFreshness(item) {
 const stale=item.status==='ACTIVE' && item.expiresAt && Date.parse(item.expiresAt)<Date.now();
 return {...item,freshness:item.status==='ARCHIVED'?'ARCHIVED':stale?'STALE':'ACTIVE'};
}
// Spec item 42 — Company Brain sections that represent ONE real-world fact (a company has one
// identity, one brand) must never have two ACTIVE records silently resolved by picking one —
// surfaced explicitly as a conflict so a human archives the outdated record instead.
const SINGLETON_BRAIN_TYPES=['brain_identity','brain_brand'];
export function detectContextConflicts(db,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 return SINGLETON_BRAIN_TYPES
  .map(type=>({type,items:listContextItems(db,resolvedTenantId,{type,status:'ACTIVE'})}))
  .filter(group=>group.items.length>1);
}
export function searchContextItems(db,tenantId,{query,type}={}) {
 const items=listContextItems(db,tenantId,{type,status:'ACTIVE'});
 if(!query)return items;
 const q=String(query).toLowerCase();
 return items.filter(item=>item.title.toLowerCase().includes(q)||item.description.toLowerCase().includes(q)||(item.category||'').toLowerCase().includes(q));
}
/**
 * Only a human edit through the authorized UI/API ever reaches this (spec item 20) —
 * frost_commander has no write tool for context, only search_context (read-only) — so
 * externally- or manually-sourced context is never silently overwritten by a chat command.
 */
export function updateContextItem(db,id,patch,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const existing=getContextItem(db,id,resolvedTenantId);
 const merged={type:patch.type??existing.type,title:patch.title??existing.title,description:patch.description??existing.description,
  priority:patch.priority!==undefined?patch.priority:existing.priority,confidence:patch.confidence!==undefined?patch.confidence:existing.confidence,
  tags:patch.tags!==undefined?patch.tags:existing.tags};
 const {title,description}=validateFields(merged);
 const now=new Date().toISOString();
 const next={
  type:merged.type,title,description,
  structured:patch.structured!==undefined?patch.structured:existing.structured,
  category:patch.category!==undefined?patch.category:existing.category,
  relatedClientId:patch.relatedClientId!==undefined?patch.relatedClientId:existing.relatedClientId,
  relatedProject:patch.relatedProject!==undefined?patch.relatedProject:existing.relatedProject,
  priority:merged.priority,
  tags:Array.isArray(merged.tags)?merged.tags.slice(0,20).map(t=>String(t).trim()).filter(Boolean):[],
  pinned:patch.pinned!==undefined?!!patch.pinned:existing.pinned,
  confidence:merged.confidence,
  expiresAt:patch.expiresAt!==undefined?patch.expiresAt:existing.expiresAt
 };
 db.prepare(`UPDATE context_items SET type=?,title=?,description=?,structured_json=?,category=?,related_client_id=?,related_project=?,priority=?,tags_json=?,pinned=?,confidence=?,expires_at=?,updated_at=? WHERE id=? AND tenant_id=?`)
  .run(next.type,next.title,next.description,next.structured?JSON.stringify(next.structured):null,next.category,next.relatedClientId,
   next.relatedProject,next.priority,JSON.stringify(next.tags),next.pinned?1:0,next.confidence,next.expiresAt,now,id,resolvedTenantId);
 recordAudit(db,{id:randomUUID(),action:'CONTEXT_ITEM_UPDATED',itemId:id,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getContextItem(db,id,resolvedTenantId);
}
export function archiveContextItem(db,id,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 getContextItem(db,id,resolvedTenantId); // 404s if missing or belongs to another tenant
 const now=new Date().toISOString();
 db.prepare('UPDATE context_items SET status=?,updated_at=? WHERE id=? AND tenant_id=?').run('ARCHIVED',now,id,resolvedTenantId);
 recordAudit(db,{id:randomUUID(),action:'CONTEXT_ITEM_ARCHIVED',itemId:id,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getContextItem(db,id,resolvedTenantId);
}
// A short, size-capped summary for the command planner's LLM context (spec items 66/67 — never
// a full dump). Only ACTIVE, non-expired, high-signal types (Company Brain + decisions/policies).
const PLANNER_CONTEXT_TYPES=['brain_identity','brain_goals','brain_customers','brain_products','brain_brand','brain_rules','decision','policy'];
export function contextSummaryForPlanner(db,tenantId,limit=12) {
 const nowIso=new Date().toISOString();
 const rows=db.prepare(`SELECT type,title,description FROM context_items WHERE tenant_id=? AND status='ACTIVE' AND type IN (${PLANNER_CONTEXT_TYPES.map(()=>'?').join(',')}) AND (expires_at IS NULL OR expires_at>?) ORDER BY pinned DESC,updated_at DESC LIMIT ?`)
  .all(tenantId,...PLANNER_CONTEXT_TYPES,nowIso,limit);
 return rows.map(r=>`[${r.type}] ${r.title}: ${r.description}`.slice(0,300));
}
