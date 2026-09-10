import {randomUUID} from 'node:crypto';
import {fail} from './auth.js';
import {contentHash} from './planning.js';
import {currentMemory} from './knowledge.js';
import {checkCompliance} from './connectors.js';

export function installCompliance(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS compliance_runs (id TEXT PRIMARY KEY, content_id TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL, actor_id TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);`);
}
export function listComplianceChecks(db,contentId) {
 return db.prepare('SELECT json FROM compliance_runs WHERE content_id=? ORDER BY rowid DESC').all(contentId).map(row=>JSON.parse(row.json));
}
export function listComplianceChecksSince(db,sinceIso) {
 return db.prepare('SELECT json FROM compliance_runs ORDER BY rowid DESC').all().map(row=>JSON.parse(row.json)).filter(run=>(run.finishedAt||run.createdAt)>=sinceIso);
}
// Most recent run per content item, any status — used by the Content Workspace to flag
// items an automated check already looked at, without re-querying per item.
export function latestComplianceByContent(db) {
 const map=new Map();
 for(const row of db.prepare('SELECT json FROM compliance_runs ORDER BY rowid DESC').all()) {
  const run=JSON.parse(row.json);
  if(!map.has(run.contentId))map.set(run.contentId,run);
 }
 return map;
}
export function createComplianceChecker(store,env,fetcher) {
 const db=store.db;
 db.prepare("UPDATE compliance_runs SET status='INTERRUPTED' WHERE status='RUNNING'").run();
 return async function check(contentId,input,user) {
  if(typeof input.requestKey!=='string'||!/^[a-zA-Z0-9-]{16,100}$/.test(input.requestKey))fail(400,'مفتاح الطلب غير صالح');
  const item=store.read().content.find(entry=>entry.id===contentId);
  if(!item)fail(404,'المحتوى غير موجود');
  if(item.status!=='DRAFT')fail(409,'فحص الامتثال الآلي متاح للمسودات قبل تسجيل المراجعة فقط');
  const hash=contentHash(item);
  const previous=db.prepare('SELECT * FROM compliance_runs WHERE request_key=?').get(input.requestKey);
  if(previous) {
   if(previous.actor_id!==user.id||previous.content_hash!==hash)fail(409,'مفتاح الطلب مستخدم لفحص آخر');
   return {...JSON.parse(previous.json),status:previous.status,replayed:true};
  }
  if(!env.ANTHROPIC_API_KEY||!env.ANTHROPIC_MODEL)fail(409,'أضف مفتاح Anthropic واسم الموديل في إعدادات الخادم');
  const memory=currentMemory(db);
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
  db.prepare('INSERT INTO compliance_runs VALUES (?,?,?,?,?,?,?)').run(run.id,contentId,input.requestKey,hash,user.id,run.status,JSON.stringify(run));
  try {
   const result=await checkCompliance({env,context,fetcher});
   const latest=store.read().content.find(entry=>entry.id===contentId);
   if(!latest||contentHash(latest)!==hash)throw Object.assign(new Error('CONTENT_CHANGED'),{code:'CONTENT_CHANGED'});
   Object.assign(run,{status:'COMPLETED',decision:result.decision,usage:result.usage});
  } catch(error) {
   Object.assign(run,{status:'ERROR',errorCode:error.code||'CHECK_FAILED'});
  } finally {
   run.finishedAt=new Date().toISOString();
   db.prepare('UPDATE compliance_runs SET status=?,json=? WHERE id=?').run(run.status,JSON.stringify(run),run.id);
  }
  if(run.status==='COMPLETED')store.mutate(state=>{state.audit.unshift({id:randomUUID(),action:'AI_COMPLIANCE_CHECKED',itemId:contentId,actorId:user.id,actorName:user.name,actorRole:user.role,at:run.finishedAt});});
  return run;
 };
}
