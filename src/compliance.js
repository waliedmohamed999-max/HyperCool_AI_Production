import {randomUUID} from 'node:crypto';
import {fail} from './auth.js';
import {contentHash} from './planning.js';
import {currentMemory} from './knowledge.js';
import {checkCompliance} from './connectors.js';
import {getContentOrNull} from './content.js';
import {recordAudit} from './audit.js';
import {resolveActiveTenantId} from './tenancy.js';

// Multi-Tenant Phase 3 (Part I): `request_key`'s uniqueness must become per-tenant, same
// reasoning as ai_runs in knowledge.js — table recreation since it was an inline UNIQUE.
export function installCompliance(db) {
 const legacy=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='compliance_runs'").get();
 if(legacy) {
  const columns=db.prepare('PRAGMA table_info(compliance_runs)').all().map(c=>c.name);
  if(!columns.includes('tenant_id')) {
   const tenantId=resolveActiveTenantId(db);
   db.exec('ALTER TABLE compliance_runs RENAME TO compliance_runs_pre_tenant;');
   db.exec('CREATE TABLE compliance_runs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, content_id TEXT NOT NULL, request_key TEXT NOT NULL, content_hash TEXT NOT NULL, actor_id TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(tenant_id,request_key));');
   db.prepare('INSERT INTO compliance_runs (id,tenant_id,content_id,request_key,content_hash,actor_id,status,json) SELECT id,?,content_id,request_key,content_hash,actor_id,status,json FROM compliance_runs_pre_tenant').run(tenantId);
   db.exec('DROP TABLE compliance_runs_pre_tenant;');
  }
  return;
 }
 db.exec('CREATE TABLE IF NOT EXISTS compliance_runs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, content_id TEXT NOT NULL, request_key TEXT NOT NULL, content_hash TEXT NOT NULL, actor_id TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(tenant_id,request_key));');
}
export function listComplianceChecks(db,contentId,tenantId=null) {
 return db.prepare('SELECT json FROM compliance_runs WHERE tenant_id=? AND content_id=? ORDER BY rowid DESC').all(tenantId||resolveActiveTenantId(db),contentId).map(row=>JSON.parse(row.json));
}
export function listComplianceChecksSince(db,sinceIso,tenantId=null) {
 return db.prepare('SELECT json FROM compliance_runs WHERE tenant_id=? ORDER BY rowid DESC').all(tenantId||resolveActiveTenantId(db)).map(row=>JSON.parse(row.json)).filter(run=>(run.finishedAt||run.createdAt)>=sinceIso);
}
// Most recent run per content item, any status — used by the Content Workspace to flag
// items an automated check already looked at, without re-querying per item.
export function latestComplianceByContent(db,tenantId=null) {
 const map=new Map();
 for(const row of db.prepare('SELECT json FROM compliance_runs WHERE tenant_id=? ORDER BY rowid DESC').all(tenantId||resolveActiveTenantId(db))) {
  const run=JSON.parse(row.json);
  if(!map.has(run.contentId))map.set(run.contentId,run);
 }
 return map;
}
export function createComplianceChecker(store,env,fetcher) {
 const db=store.db;
 db.prepare("UPDATE compliance_runs SET status='INTERRUPTED' WHERE status='RUNNING'").run();
 return async function check(contentId,input,user,tenantId=null) {
  if(typeof input.requestKey!=='string'||!/^[a-zA-Z0-9-]{16,100}$/.test(input.requestKey))fail(400,'مفتاح الطلب غير صالح');
  const resolvedTenantId=tenantId||resolveActiveTenantId(db);
  const item=getContentOrNull(db,contentId,resolvedTenantId);
  if(!item)fail(404,'المحتوى غير موجود');
  if(item.status!=='DRAFT')fail(409,'فحص الامتثال الآلي متاح للمسودات قبل تسجيل المراجعة فقط');
  const hash=contentHash(item);
  const previous=db.prepare('SELECT * FROM compliance_runs WHERE tenant_id=? AND request_key=?').get(resolvedTenantId,input.requestKey);
  if(previous) {
   if(previous.actor_id!==user.id||previous.content_hash!==hash)fail(409,'مفتاح الطلب مستخدم لفحص آخر');
   return {...JSON.parse(previous.json),status:previous.status,replayed:true};
  }
  if(!env.ANTHROPIC_API_KEY||!env.ANTHROPIC_MODEL)fail(409,'أضف مفتاح Anthropic واسم الموديل في إعدادات الخادم');
  const memory=currentMemory(db,resolvedTenantId);
  // Advisory only: the model sees only what is already approved, never the reviewer's own judgement.
  const context={
   current_datetime:new Date().toISOString(),timezone:'Asia/Riyadh',approval_level:'L0',
   content:{title:item.title,arabic_copy:item.body,english_copy:item.englishCopy||'',url:item.url,asset_url:item.assetUrl||null,platform:item.platform,date:item.date},
   approved_claims:memory.filter(entry=>entry.kind==='approved_claim').map(entry=>({key:entry.key,value:entry.value,source:entry.source})),
   product_facts:memory.filter(entry=>entry.kind==='product_fact').map(entry=>({key:entry.key,value:entry.value,source:entry.source,productId:entry.productId})),
   policies:memory.filter(entry=>entry.kind==='policy').map(entry=>({key:entry.key,value:entry.value,source:entry.source})),
   restrictions:['No medical or therapeutic claims; HBOT and cryotherapy are the highest-risk categories','Only the listed approved_claims and product_facts count as verified','Advisory pre-check only; human compliance review remains mandatory before approval']
  };
  if(Buffer.byteLength(JSON.stringify(context))>32000)fail(409,'سياق الفحص أكبر من الحد المسموح؛ اختصر المعلومات المعتمدة');
  const run={id:randomUUID(),contentId,status:'RUNNING',createdAt:new Date().toISOString(),actorId:user.id,model:env.ANTHROPIC_MODEL};
  db.prepare('INSERT INTO compliance_runs (id,tenant_id,content_id,request_key,content_hash,actor_id,status,json) VALUES (?,?,?,?,?,?,?,?)').run(run.id,resolvedTenantId,contentId,input.requestKey,hash,user.id,run.status,JSON.stringify(run));
  try {
   const result=await checkCompliance({env,context,fetcher});
   const latest=getContentOrNull(db,contentId,resolvedTenantId);
   if(!latest||contentHash(latest)!==hash)throw Object.assign(new Error('CONTENT_CHANGED'),{code:'CONTENT_CHANGED'});
   Object.assign(run,{status:'COMPLETED',decision:result.decision,usage:result.usage});
  } catch(error) {
   Object.assign(run,{status:'ERROR',errorCode:error.code||'CHECK_FAILED'});
  } finally {
   run.finishedAt=new Date().toISOString();
   db.prepare('UPDATE compliance_runs SET status=?,json=? WHERE id=?').run(run.status,JSON.stringify(run),run.id);
  }
  if(run.status==='COMPLETED')recordAudit(db,{id:randomUUID(),action:'AI_COMPLIANCE_CHECKED',itemId:contentId,actorId:user.id,actorName:user.name,actorRole:user.role,at:run.finishedAt},resolvedTenantId);
  return run;
 };
}
