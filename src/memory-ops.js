// KnowledgeMemoryOpsService — a thin, read-only aggregation layer for the Brand
// Knowledge Base & AI Memory Center. Creates no new memory model and no new approval
// logic: every function reshapes what knowledge.js (memory/products) and
// runtime/approvals.js (agent_approvals) already persist and validate.
const DAY_MS=86400000;
// Kinds an agent may genuinely be time-sensitive about — used only to flag entries with
// no expiresAt for a human to consider a review cadence. Never asserts staleness by itself.
const TIME_SENSITIVE_KINDS=['product_fact','price_reference','approved_claim','competitor_insight'];

function latestByKey(entries) {
 const seen=new Set(),latest=[];
 for(const entry of entries){if(seen.has(entry.key))continue;seen.add(entry.key);latest.push(entry);}
 return latest;
}
export function computeCategoryCounts(entries) {
 const counts={};
 for(const entry of latestByKey(entries))counts[entry.kind]=(counts[entry.kind]||0)+1;
 return counts;
}
export function computeMemorySummary(entries,pendingApprovals,products) {
 const latest=latestByKey(entries),now=Date.now();
 const verified=latest.filter(e=>e.status==='APPROVED'&&(!e.expiresAt||Date.parse(e.expiresAt)>now));
 const expired=latest.filter(e=>e.status==='APPROVED'&&e.expiresAt&&Date.parse(e.expiresAt)<=now);
 const needsReview=verified.filter(e=>!e.expiresAt&&TIME_SENSITIVE_KINDS.includes(e.kind));
 return {
  totalRecords:{value:latest.length,hint:'كل مفتاح فريد، أحدث إصدار فقط'},
  verified:{value:verified.length,hint:'معتمد وسارٍ'},
  needsReview:{value:needsReview.length,hint:'حقيقة حسّاسة للوقت بدون تاريخ انتهاء محدد'},
  expired:{value:expired.length,hint:'اعتماد سابق تجاوز تاريخ انتهائه'},
  pendingApproval:{value:pendingApprovals.length,hint:'مقترحة من وكيل وتنتظر قرار المالك'},
  productsSynced:{value:products.length,hint:'آخر مزامنة من سلة'}
 };
}
// The ONLY conflict this module claims to detect: a product_fact/price_reference entry
// linked to a real productId whose text states a number that disagrees with the live
// Salla-synced price. Never auto-corrects either side — both values are shown as-is.
export function computePriceConflicts(entries,products) {
 const productsById=Object.fromEntries(products.map(p=>[p.id,p]));
 const conflicts=[];
 for(const entry of latestByKey(entries)) {
  if(!['product_fact','price_reference'].includes(entry.kind)||!entry.productId)continue;
  if(entry.status!=='APPROVED'||(entry.expiresAt&&Date.parse(entry.expiresAt)<=Date.now()))continue;
  const product=productsById[entry.productId];
  if(!product||product.price.value==null)continue;
  const match=entry.value.match(/(\d+(?:[.,]\d+)?)/);
  if(!match)continue;
  const memoryAmount=Number(match[1].replace(',','.'));
  const liveAmount=product.price.value.amount;
  if(Math.abs(memoryAmount-liveAmount)>0.5)
   conflicts.push({key:entry.key,productId:entry.productId,productName:product.name.value,memoryValue:entry.value,memoryAmount,liveAmount,liveCurrency:product.price.value.currency,liveSyncedAt:product.syncedAt});
 }
 return conflicts;
}
// Weak-source heuristic only: flags a value that looks like a bare word with no URL and
// no recognizable document/reference marker. Never claims a record has NO source — the
// field is required by saveMemory — only that it may be worth strengthening.
function looksWeakSource(source) {
 if(/^https?:\/\//i.test(source))return false;
 if(source.length>=40)return false;
 return true;
}
export function computeMemoryHealthIssues(entries,products) {
 const latest=latestByKey(entries).filter(e=>e.status==='APPROVED');
 return {
  weakSource:latest.filter(e=>looksWeakSource(e.source)).map(e=>({key:e.key,kind:e.kind,source:e.source})),
  priceConflicts:computePriceConflicts(entries,products),
  expiredClaims:latest.filter(e=>e.expiresAt&&Date.parse(e.expiresAt)<=Date.now()).map(e=>({key:e.key,kind:e.kind,expiresAt:e.expiresAt})),
  needsReview:latest.filter(e=>!e.expiresAt&&TIME_SENSITIVE_KINDS.includes(e.kind)).map(e=>({key:e.key,kind:e.kind}))
 };
}
// Real usage, not inference: scans logged agent_tool_calls for the two tools that read
// memory (search_brand_memory / get_competitor_data) and checks whether this key's entry
// was actually present in what the agent got back. No table this function owns — it only
// reads tables runtime/runtime.js already writes.
export function computeMemoryUsage(db,key,tenantId=null) {
 const rows=db.prepare(`SELECT t.tool,t.output,t.at,r.agent_id FROM agent_tool_calls t JOIN agent_runs r ON r.id=t.run_id WHERE t.tool IN ('search_brand_memory','get_competitor_data') AND t.status='OK' ${tenantId?'AND r.tenant_id=?':''} ORDER BY t.at DESC`).all(...(tenantId?[tenantId]:[]));
 const byAgent=new Map();
 for(const row of rows) {
  if(byAgent.has(row.agent_id))continue;
  let output;try{output=JSON.parse(row.output);}catch{continue;}
  if(Array.isArray(output)&&output.some(entry=>entry?.key===key))byAgent.set(row.agent_id,row.at);
 }
 return [...byAgent.entries()].map(([agentId,lastAccessedAt])=>({agentId,lastAccessedAt})).sort((a,b)=>b.lastAccessedAt.localeCompare(a.lastAccessedAt));
}
export function buildMemoryWorkspace(store,{pendingApprovals}) {
 const db=store.db;
 const entries=db.prepare('SELECT json FROM memory ORDER BY rowid DESC').all().map(row=>JSON.parse(row.json));
 const products=db.prepare('SELECT json FROM products ORDER BY id').all().map(row=>JSON.parse(row.json));
 return {
  summary:computeMemorySummary(entries,pendingApprovals,products),
  categoryCounts:computeCategoryCounts(entries),
  health:computeMemoryHealthIssues(entries,products)
 };
}
