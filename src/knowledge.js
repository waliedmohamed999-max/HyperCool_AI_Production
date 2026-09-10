import {randomUUID} from 'node:crypto';
import {fail} from './auth.js';
import {createApproval} from './runtime/approvals.js';

// Kept in sync with payload-schemas.js's memory agent proposal enum (plus brand_voice/
// policy/competitor_insight, which are human-authored only, never agent-proposed).
export const MEMORY_KINDS=['brand_voice','product_fact','price_reference','approved_claim','faq','objection','policy','winning_hook','losing_hook','lost_deal_reason','process_rule','customer_pattern','competitor_insight'];

export function installKnowledge(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, UNIQUE(key,version));
 CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ai_runs (id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, actor_id TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);`);
}
export function listMemory(db) {return db.prepare('SELECT json FROM memory ORDER BY rowid DESC').all().map(row=>JSON.parse(row.json));}
export function currentMemory(db) {
 const seen=new Set();return listMemory(db).filter(entry=>{if(seen.has(entry.key))return false;seen.add(entry.key);return entry.status==='APPROVED'&&(!entry.expiresAt||Date.parse(entry.expiresAt)>Date.now());});
}
export function saveMemory(db,input,user) {
 if(!MEMORY_KINDS.includes(input.kind))fail(400,'نوع معلومة غير صالح');
 for(const field of ['key','value','source','changeReason'])if(typeof input[field]!=='string'||!input[field].trim())fail(400,`الحقل مطلوب: ${field}`);
 if(input.key.length>100||input.value.length>4000||input.source.length>1000||input.changeReason.length>1000)fail(400,'المعلومة أطول من الحد المسموح');
 if(!['APPROVED','REVOKED'].includes(input.status))fail(400,'حالة غير صالحة');
 if(input.kind==='product_fact' && (typeof input.productId!=='string'||!input.productId.trim()))fail(400,'اربط مواصفة المنتج بمعرف المنتج');
 if(input.expiresAt && (!Number.isFinite(Date.parse(input.expiresAt))||Date.parse(input.expiresAt)<=Date.now()))fail(400,'تاريخ انتهاء المعلومة يجب أن يكون في المستقبل');
 const previous=db.prepare('SELECT json,version FROM memory WHERE key=? ORDER BY version DESC LIMIT 1').get(input.key.trim());
 const expected=previous?.version||0;
 if(input.expectedVersion!==expected)fail(409,'تم تحديث هذه المعلومة؛ حدّث الصفحة قبل الحفظ');
 const entry={id:randomUUID(),kind:input.kind,key:input.key.trim(),value:input.value.trim(),source:input.source.trim(),productId:input.productId?.trim()||null,status:input.status,version:expected+1,previousId:previous?JSON.parse(previous.json).id:null,changeReason:input.changeReason.trim(),expiresAt:input.expiresAt||null,verifiedAt:new Date().toISOString(),approvedBy:user.id,approvedByName:user.name};
 db.prepare('INSERT INTO memory VALUES (?,?,?,?,?)').run(entry.id,entry.kind,entry.key,entry.version,JSON.stringify(entry));
 return entry;
}
// A human-submitted counterpart to the agent tool `propose_memory_update` — operators
// cannot write memory directly (only owners can), so this reuses the exact same
// agent_approvals pending-review gate instead of inventing a separate "draft" status on
// the memory table itself. The owner reviews and decides through the existing Approval
// Center, exactly as for agent-authored proposals.
export function proposeMemoryUpdate(db,input,user) {
 if(!MEMORY_KINDS.includes(input.kind))fail(400,'نوع معلومة غير صالح');
 for(const field of ['key','value','source','changeReason'])if(typeof input[field]!=='string'||!input[field].trim())fail(400,`الحقل مطلوب: ${field}`);
 if(input.key.length>100||input.value.length>4000||input.source.length>1000||input.changeReason.length>1000)fail(400,'المعلومة أطول من الحد المسموح');
 if(input.kind==='product_fact' && (typeof input.productId!=='string'||!input.productId.trim()))fail(400,'اربط مواصفة المنتج بمعرف المنتج');
 return createApproval(db,{runId:null,agentId:'human',actionType:'memory_policy_change',
  proposedOutput:{type:input.kind,key:input.key.trim(),newValue:input.value.trim(),productId:input.productId?.trim()||null,evidence:input.source.trim(),confidence:null},
  riskLevel:'MEDIUM',reason:`مُقترح بواسطة ${user.name} — ${input.changeReason.trim()}`});
}
export function listProducts(db){return db.prepare('SELECT json FROM products ORDER BY id').all().map(row=>JSON.parse(row.json));}
export function replaceProducts(db,products,ownsTransaction=true) {
 if(ownsTransaction)db.exec('BEGIN IMMEDIATE');try{db.exec('DELETE FROM products');const insert=db.prepare('INSERT INTO products VALUES (?,?)');for(const product of products)insert.run(product.id,JSON.stringify(product));if(ownsTransaction)db.exec('COMMIT');}catch(error){if(ownsTransaction)db.exec('ROLLBACK');throw error;}
}
export function generationContext(db,input,now=Date.now()) {
 const row=db.prepare('SELECT json FROM products WHERE id=?').get(input.productId);
 if(!row)fail(409,'استورد المنتج من سلة أولًا');
 const product=JSON.parse(row.json);
 if(product.status!=='sale')fail(409,'المنتج ليس معروضًا للبيع');
 if(product.available.value===false||product.stock.value===0)fail(409,'المنتج غير متاح حسب آخر تحديث؛ حدّث المخزون قبل الترويج');
 if(!Number.isFinite(Date.parse(product.syncedAt))||now-Date.parse(product.syncedAt)>86400000||Date.parse(product.syncedAt)>now+60000)fail(409,'بيانات المنتج قديمة؛ حدّث الكتالوج');
 const memory=currentMemory(db);
 const voice=memory.filter(item=>item.kind==='brand_voice');
 if(!voice.length)fail(409,'أضف واعتمد نبرة العلامة في الذاكرة أولًا');
 const facts=memory.filter(item=>item.kind==='product_fact'&&item.productId===product.id);
 if(!facts.length)fail(409,'أضف مواصفة معتمدة لهذا المنتج أولًا');
 const context={current_datetime:new Date(now).toISOString(),timezone:'Asia/Riyadh',approval_level:'L0',task:{title:input.title,platform:input.platform,date:input.date,...(input.brief&&Object.keys(input.brief).length?{brief:input.brief}:{})},product:{id:product.id,name:product.name.value,url:product.url.value,source:product.url.source,verifiedAt:product.syncedAt},brand_memory:voice.map(item=>({key:item.key,value:item.value,source:item.source,version:item.version})),product_facts:facts.map(item=>({key:item.key,value:item.value,source:item.source,version:item.version})),approved_claims:[],restrictions:['No price or availability statements','No medical or therapeutic claims','Draft only; human compliance review required']};
 if(Buffer.byteLength(JSON.stringify(context))>32000)fail(409,'سياق المنتج أكبر من الحد المسموح؛ اختصر المعلومات المعتمدة');
 return context;
}
