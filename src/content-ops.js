// ContentOperationsService — a thin, read-only aggregation layer for the Content
// Operations & Approval Workspace. It creates no new content model and no new
// approval logic: every function only reshapes what domain.js (content status
// machine), planning.js (schedule_jobs) and compliance.js (compliance_runs)
// already persist and validate. Kept pure (arrays/maps in, plain objects out)
// so it never needs to import server.js or the runtime layer.
import {listContent,isCampaignShaped} from './content.js';
import {listJobs} from './planning.js';
import {listAuditLog} from './audit.js';
const DAY_MS=86400000;
const ACTIVE_JOB_STATUSES=['SCHEDULED','READY_FOR_CONNECTOR'];

// The compliance decision schema (schemas/decision.json + payload-schemas.js) has no
// fixed issue-type enum — `field` is free text written by the model. This keyword map
// only groups real issues for the UI; it never invents an issue that wasn't returned.
const CATEGORY_KEYWORDS=[
 ['PRICE',/price|سعر|تسعير/i],['STOCK',/stock|availab|مخزون|توفر/i],['DISCOUNT',/discount|offer|خصم|عرض/i],
 ['WARRANTY',/warrant|ضمان/i],['URL',/url|link|رابط/i],['ASSET',/asset|image|video|صورة|فيديو|أصل/i],
 ['CLAIM',/claim|medical|therapeutic|ادعاء|طبي/i]
];
const categoryOf=(field,problem)=>{const text=`${field||''} ${problem||''}`;for(const [category,pattern] of CATEGORY_KEYWORDS)if(pattern.test(text))return category;return 'OTHER';};

function auditLookup(audit) {
 const createdBy=new Map();
 for(const entry of audit)if((entry.action==='DRAFT_CREATED'||entry.action==='AI_DRAFT_CREATED')&&!createdBy.has(entry.itemId))createdBy.set(entry.itemId,entry.actorName||null);
 return createdBy;
}
function activeJobByContent(jobs) {
 const map=new Map();
 for(const job of jobs)if(ACTIVE_JOB_STATUSES.includes(job.status))map.set(job.contentId,job);
 return map;
}
export function computeContentKPIs(content,jobs,flaggedIds=new Set()) {
 const scheduled=activeJobByContent(jobs);
 return {
  drafts:{value:content.filter(c=>c.status==='DRAFT').length,hint:'بانتظار مراجعة الامتثال البشرية'},
  complianceFlagged:{value:content.filter(c=>['DRAFT','REVIEWED'].includes(c.status)&&flaggedIds.has(c.id)).length,hint:'فحص آلي مساعد أشار لملاحظة لم تُحل بعد'},
  awaitingApproval:{value:content.filter(c=>c.status==='REVIEWED').length,hint:'بانتظار اعتماد المالك'},
  approved:{value:content.filter(c=>c.status==='APPROVED'&&!scheduled.has(c.id)).length,hint:'معتمد ولم يُجدول بعد'},
  scheduled:{value:scheduled.size,hint:'موعد محفوظ؛ لا يعني نشرًا فعليًا'},
  published:{value:content.filter(c=>c.status==='PUBLISHED').length,hint:'نُشر فعليًا عبر تكامل متصل، بمعرّف منشور خارجي حقيقي'},
  blocked:{value:content.filter(c=>c.status==='REJECTED').length,hint:'مرفوض من مراجع أو مالك'}
 };
}
// Real pipeline columns only — the DB has no COPY_READY/CREATIVE_READY/APPROVAL_PENDING/
// PUBLISHED states, so the board is not padded with stages that don't exist.
export function computeContentPipeline(content,jobs,audit,complianceByContent) {
 const scheduled=activeJobByContent(jobs),createdBy=auditLookup(audit);
 const card=item=>{
  const run=complianceByContent.get(item.id);
  const risk=run?.status==='COMPLETED'?(run.decision.risk_level||null):null;
  return {id:item.id,title:item.title,platform:item.platform,date:item.date,owner:createdBy.get(item.id)||(item.origin==='AI'?'وكيل الكتابة':null),risk,status:item.status,assetMissing:!item.assetUrl};
 };
 return [
  {stage:'DRAFT',label:'مسودة',cards:content.filter(c=>c.status==='DRAFT').map(card)},
  {stage:'REVIEWED',label:'بانتظار الاعتماد',cards:content.filter(c=>c.status==='REVIEWED').map(card)},
  {stage:'APPROVED',label:'معتمد',cards:content.filter(c=>c.status==='APPROVED'&&!scheduled.has(c.id)).map(card)},
  {stage:'SCHEDULED',label:'مجدول',cards:content.filter(c=>c.status==='APPROVED'&&scheduled.has(c.id)).map(item=>({...card(item),scheduledAt:scheduled.get(item.id).scheduledAt}))},
  {stage:'PUBLISHED',label:'منشور',cards:content.filter(c=>c.status==='PUBLISHED').map(item=>({...card(item),externalPostId:item.externalPostId||null,liveUrl:item.liveUrl||null,publishedAt:item.publishedAt||null}))},
  {stage:'REJECTED',label:'محجوب',cards:content.filter(c=>c.status==='REJECTED').map(card)}
 ];
}
export function computeComplianceIssues(complianceByContent,content) {
 const byId=Object.fromEntries(content.map(c=>[c.id,c]));
 const rows=[];
 for(const [contentId,run] of complianceByContent) {
  if(run.status!=='COMPLETED')continue;
  const item=byId[contentId];if(!item)continue;
  for(const issue of run.decision.payload?.issues||[])
   rows.push({contentId,title:item.title,platform:item.platform,status:item.status,severity:issue.severity,field:issue.field,problem:issue.problem,correction:issue.correction||null,evidenceRequired:issue.evidence_required||null,category:categoryOf(issue.field,issue.problem),checkedAt:run.finishedAt});
 }
 rows.sort((a,b)=>({HIGH:0,MEDIUM:1,LOW:2}[a.severity]-{HIGH:0,MEDIUM:1,LOW:2}[b.severity]));
 return {rows,bySeverity:{HIGH:rows.filter(r=>r.severity==='HIGH').length,MEDIUM:rows.filter(r=>r.severity==='MEDIUM').length,LOW:rows.filter(r=>r.severity==='LOW').length},hasData:rows.length>0};
}
export function computeContentLibrary(content,jobs,audit) {
 const scheduled=activeJobByContent(jobs),createdBy=auditLookup(audit);
 return content.map(item=>({
  id:item.id,title:item.title,platform:item.platform,campaign:null,product:item.sourceContext?.product?.name||null,
  status:item.status,date:item.date,createdBy:createdBy.get(item.id)||(item.origin==='AI'?'وكيل الكتابة':null),
  approvedBy:item.approval?.owner||null,scheduledAt:scheduled.get(item.id)?.scheduledAt||null,publishedAt:item.publishedAt||null,
  externalPostId:item.externalPostId||null,liveUrl:item.liveUrl||null,
  origin:item.origin||'MANUAL',revision:item.revision||1
 }));
}
// Rule-based only (no LLM call on page load) — mirrors reporting.js's computeQuickSummary.
export function computeFrostContentInsights(content,jobs,issues,now=Date.now()) {
 const bullets=[];
 const dueToday=content.filter(c=>c.status==='REVIEWED'&&c.date<=new Date(now).toISOString().slice(0,10));
 if(dueToday.length)bullets.push({text:`${dueToday.length} عنصر بانتظار اعتماد المالك لموعد نشر مستحق`,severity:'MEDIUM'});
 const byPlatform={};
 for(const job of jobs)if(ACTIVE_JOB_STATUSES.includes(job.status)&&Date.parse(job.scheduledAt)>=now&&Date.parse(job.scheduledAt)<now+7*DAY_MS)byPlatform[job.snapshot.platform]=(byPlatform[job.snapshot.platform]||0)+1;
 const platforms=['Instagram','X','Facebook','LinkedIn'];
 const coverage=platforms.map(p=>[p,byPlatform[p]||0]);
 const min=Math.min(...coverage.map(([,n])=>n));
 if(coverage.some(([,n])=>n>0)&&min<Math.max(...coverage.map(([,n])=>n)))bullets.push({text:`${coverage.find(([,n])=>n===min)[0]} أقل المنصات تغطية بالجدولة هذا الأسبوع`,severity:'LOW'});
 const blockedHigh=issues.rows.filter(r=>r.severity==='HIGH'&&['DRAFT','REVIEWED'].includes(r.status));
 if(blockedHigh.length)bullets.push({text:`${blockedHigh.length} ملاحظة امتثال عالية الخطورة لم تُحل بعد`,severity:'HIGH'});
 const missingCreative=content.filter(c=>['APPROVED','REVIEWED'].includes(c.status)&&!c.assetUrl);
 if(missingCreative.length)bullets.push({text:`${missingCreative.length} عنصر معتمد أو بانتظار الاعتماد بدون أصل بصري`,severity:'LOW'});
 return {generatedAt:new Date(now).toISOString(),bullets,hasData:content.length>0};
}
export function buildContentWorkspace(store,{complianceByContent,tenantId=null}) {
 // Content Unification: this workspace is built entirely around the legacy standalone-post
 // shape (assetUrl/title/review-pipeline fields) — a campaign-originated row (richer, no
 // assetUrl concept, its own dedicated UI in Marketing) would otherwise show up here as a
 // permanently "missing creative asset" false signal, not a meaningful insight.
 const content=listContent(store.db,tenantId).filter(item=>!isCampaignShaped(item));
 const jobs=listJobs(store.db,tenantId);
 const audit=listAuditLog(store.db,{tenantId});
 const flaggedIds=new Set([...complianceByContent].filter(([,run])=>run.status==='COMPLETED'&&['BLOCK','PASS_WITH_EDITS'].includes(run.decision.payload?.classification)).map(([id])=>id));
 const issues=computeComplianceIssues(complianceByContent,content);
 return {
  kpis:computeContentKPIs(content,jobs,flaggedIds),
  pipeline:computeContentPipeline(content,jobs,audit,complianceByContent),
  complianceIssues:issues,
  library:computeContentLibrary(content,jobs,audit),
  frostInsights:computeFrostContentInsights(content,jobs,issues)
 };
}
