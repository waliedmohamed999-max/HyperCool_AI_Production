import {randomUUID} from 'node:crypto';
import {fail} from './auth.js';
import {validDate,listJobs,listSlots} from './planning.js';
import {listComplianceChecksSince} from './compliance.js';
import {listAutonomyChanges} from './autonomy.js';
import {listLeads,listFollowups} from './crm.js';
import {currentMemory} from './knowledge.js';

function dayOfWeek(date) {return new Date(date+'T12:00:00Z').getUTCDay();}
function riyadhMidnightUtc(date) {return new Date(Date.parse(date)-10800000).toISOString();}
function countBy(list,key) {
 const counts={};
 for(const item of list) {const value=key(item);counts[value]=(counts[value]||0)+1;}
 return counts;
}
export function currentWeekStart(now=Date.now()) {
 const today=new Date(now+10800000).toISOString().slice(0,10);
 return new Date(Date.parse(today)-dayOfWeek(today)*86400000).toISOString().slice(0,10);
}
export function installReporting(db) {
 db.exec('CREATE TABLE IF NOT EXISTS weekly_reports (week_start TEXT PRIMARY KEY, json TEXT NOT NULL);');
}
export function listWeeklyReports(db) {
 return db.prepare('SELECT json FROM weekly_reports ORDER BY week_start DESC LIMIT 12').all().map(row=>JSON.parse(row.json));
}
// Aggregates only what this system actually recorded — no store analytics, ad spend or social engagement are connected, so those stay null rather than guessed.
export function buildWeeklyReport(store,weekStart) {
 validDate(weekStart);
 if(dayOfWeek(weekStart)!==0)fail(400,'بداية الأسبوع يجب أن تكون يوم الأحد');
 const weekEnd=new Date(Date.parse(weekStart)+7*86400000).toISOString().slice(0,10);
 const startInstant=riyadhMidnightUtc(weekStart),endInstant=riyadhMidnightUtc(weekEnd);
 const inWeek=iso=>typeof iso==='string' && iso>=startInstant && iso<endInstant;
 const state=store.read();
 const contentInWeek=state.content.filter(item=>item.date>=weekStart && item.date<weekEnd);
 const auditInWeek=state.audit.filter(entry=>inWeek(entry.at));
 const compliance=listComplianceChecksSince(store.db,startInstant).filter(run=>inWeek(run.finishedAt||run.createdAt));
 const complianceCompleted=compliance.filter(run=>run.status==='COMPLETED');
 const autonomyChanges=listAutonomyChanges(store.db,startInstant).filter(entry=>inWeek(entry.at));
 const jobs=listJobs(store.db).filter(job=>inWeek(job.createdAt));
 const slots=listSlots(store.db).filter(slot=>slot.date>=weekStart && slot.date<weekEnd);
 const leadsInWeek=listLeads(store.db).filter(lead=>inWeek(lead.createdAt));
 const followupsInWeek=listFollowups(store.db).filter(followup=>inWeek(followup.createdAt));
 return {
  weekStart,weekEnd,timezone:'Asia/Riyadh',generatedAt:new Date().toISOString(),
  content:{total:contentInWeek.length,byPlatform:countBy(contentInWeek,item=>item.platform),byStatus:countBy(contentInWeek,item=>item.status)},
  calendar:{plannedSlots:slots.length,gaps:slots.filter(slot=>!slot.contentId).length,calendarMissing:slots.length===0},
  scheduling:{jobsCreated:jobs.length,blocked:jobs.filter(job=>job.status==='BLOCKED').length,cancelled:jobs.filter(job=>job.status==='CANCELLED').length,waitingForConnector:jobs.filter(job=>job.status==='READY_FOR_CONNECTOR').length},
  compliance:{checksRun:compliance.length,completed:complianceCompleted.length,failed:compliance.length-complianceCompleted.length,byClassification:countBy(complianceCompleted,run=>run.decision?.payload?.classification||'UNKNOWN')},
  crm:{leadsCreated:leadsInWeek.length,bySource:countBy(leadsInWeek,lead=>lead.sourceType),byType:countBy(leadsInWeek,lead=>lead.customerType),optOuts:leadsInWeek.filter(lead=>lead.optOut).length,followupsDrafted:followupsInWeek.length,followupsByStatus:countBy(followupsInWeek,followup=>followup.status)},
  autonomy:{changes:autonomyChanges.length,promotions:autonomyChanges.filter(entry=>entry.direction==='PROMOTED').length,demotions:autonomyChanges.filter(entry=>entry.direction==='DEMOTED').length,log:autonomyChanges},
  auditByAction:countBy(auditInWeek,entry=>entry.action),
  metrics:{publishedPosts:null,storeSessionsFromSocial:null,conversationsHandled:null,newFollowers:null,reason:'لا اتصال بمنصات النشر أو تحليلات المتجر أو المحادثات بعد؛ الأعداد أعلاه عمليات داخلية مسجلة فقط وليست نتائج تسويقية'},
  deliveryStatus:'LOCAL_ONLY'
 };
}
// ---------------------------------------------------------------------------
// Executive dashboard extensions. buildWeeklyReport above is never modified —
// these are pure functions over data the caller already fetched, so reporting.js
// never has to import src/runtime/* (which itself imports this file for
// get_metrics — importing back would be a real circular dependency).
// ---------------------------------------------------------------------------
const round=(n,d=0)=>Number.isFinite(n)?Math.round(n*10**d)/10**d:null;
const pct=(part,whole)=>whole>0?round(part/whole*100,1):null;

export function computeComparison(currentValue,previousValue) {
 const change=currentValue-previousValue;
 const changePercent=previousValue>0?round(change/previousValue*100,1):(currentValue>0?100:null);
 return {value:currentValue,previous:previousValue,change,changePercent,trend:change>0?'up':change<0?'down':'flat'};
}
export function computeSalesFunnel(leads) {
 const notLost=leads.filter(lead=>lead.stage!=='LOST');
 const stages=[
  {key:'new',label:'عملاء جدد',count:leads.filter(lead=>lead.stage==='NEW').length},
  {key:'qualified',label:'مؤهلون',count:notLost.filter(lead=>['QUALIFIED','DEMO','QUOTE_SENT','POST_PURCHASE','WON'].includes(lead.stage)).length},
  {key:'hot',label:'اهتمام مرتفع',count:notLost.filter(lead=>lead.temperature==='HOT').length},
  {key:'quote',label:'عروض سعر',count:notLost.filter(lead=>['QUOTE_SENT','POST_PURCHASE','WON'].includes(lead.stage)).length},
  {key:'won',label:'صفقات مكتسبة',count:leads.filter(lead=>lead.stage==='WON').length}
 ];
 stages.forEach((stage,index)=>{stage.dropOffPercent=index===0?null:pct(stages[index-1].count-stage.count,stages[index-1].count);});
 return {stages,hasData:leads.length>0};
}
export function computePipeline(leads,weekStart,weekEnd) {
 const active=leads.filter(lead=>!['WON','LOST'].includes(lead.stage));
 const wonThisWeek=leads.filter(lead=>lead.stage==='WON' && lead.updatedAt>=weekStart+'T00:00:00.000Z' && lead.updatedAt<weekEnd+'T00:00:00.000Z');
 const pipelineValue=active.reduce((sum,lead)=>sum+(lead.valueSAR||0),0);
 const wonRevenue=wonThisWeek.reduce((sum,lead)=>sum+(lead.valueSAR||0),0);
 const quotesValue=leads.filter(lead=>lead.stage==='QUOTE_SENT').reduce((sum,lead)=>sum+(lead.valueSAR||0),0);
 const topOpportunities=active.filter(lead=>lead.valueSAR>0).sort((a,b)=>b.valueSAR-a.valueSAR).slice(0,5)
  .map(lead=>({id:lead.id,name:lead.company||lead.name,valueSAR:lead.valueSAR,stage:lead.stage,city:lead.city||null,productNeed:lead.productNeed||null,assignedTo:lead.assignedTo}));
 return {pipelineValue,wonRevenue,wonDealsThisWeek:wonThisWeek.length,avgDealSize:wonThisWeek.length?round(wonRevenue/wonThisWeek.length):null,quotesValue,topOpportunities,hasData:leads.length>0};
}
export function computeAgentMetrics(agentRuns,escalations,agents) {
 const rows=agents.map(agent=>{
  const runs=agentRuns.filter(run=>run.agent_id===agent.id);
  const completed=runs.filter(run=>run.status==='COMPLETED').length;
  const failed=runs.filter(run=>run.status==='FAILED').length;
  const finished=runs.filter(run=>run.latency_ms!=null);
  const tokens=runs.reduce((sum,run)=>sum+(run.tokens_input||0)+(run.tokens_output||0),0);
  return {id:agent.id,nameAr:agent.name_ar,runs:runs.length,completed,failed,successRate:pct(completed,runs.length),
   escalations:escalations.filter(escalation=>escalation.agent_id===agent.id).length,
   avgLatencyMs:finished.length?round(finished.reduce((sum,run)=>sum+run.latency_ms,0)/finished.length):null,
   tokens,lastRunAt:runs[0]?.started_at||null};
 });
 return {agents:rows,hasData:agentRuns.length>0,totalRuns:agentRuns.length,totalErrors:agentRuns.filter(run=>run.status==='FAILED').length};
}
export function computeApprovalsAndRisks(contentItems,agentApprovals,escalations) {
 const pendingContentReview=contentItems.filter(item=>item.status==='REVIEWED').map(item=>({id:item.id,title:item.title,platform:item.platform}));
 const pendingAgentApprovals=agentApprovals.filter(approval=>approval.status==='PENDING').map(approval=>({id:approval.id,agentId:approval.agent_id,actionType:approval.action_type,riskLevel:approval.risk_level,reason:approval.reason,createdAt:approval.created_at}));
 const openEscalations=escalations.filter(escalation=>escalation.status==='OPEN').map(escalation=>({id:escalation.id,agentId:escalation.agent_id,priority:escalation.priority,reason:escalation.reason,createdAt:escalation.created_at}));
 return {pendingContentReview,pendingAgentApprovals,openEscalations,totalOpen:pendingContentReview.length+pendingAgentApprovals.length+openEscalations.length};
}
export function computeMarketSignals(memoryEntries) {
 const signals=memoryEntries.filter(entry=>entry.kind==='competitor_insight').map(entry=>({key:entry.key,value:entry.value,source:entry.source,approvedAt:entry.verifiedAt}));
 return {signals,hasData:signals.length>0};
}
export function computeNextWeekPlan(slots,weekEnd) {
 const nextEnd=new Date(Date.parse(weekEnd)+7*86400000).toISOString().slice(0,10);
 const days=[];
 for(let offset=0;offset<7;offset++) {
  const date=new Date(Date.parse(weekEnd)+offset*86400000).toISOString().slice(0,10);
  const daySlots=slots.filter(slot=>slot.date===date);
  days.push({date,gaps:daySlots.filter(slot=>!slot.contentId).map(slot=>({platform:slot.platform,pillar:slot.pillar})),planned:daySlots.filter(slot=>slot.contentId).length});
 }
 return {weekStart:weekEnd,weekEnd:nextEnd,days,calendarMissing:!slots.some(slot=>slot.date>=weekEnd && slot.date<nextEnd)};
}
export function computeQuickSummary({kpis,funnel,pipeline,agents,approvalsAndRisks}) {
 const wins=[],issues=[],opportunities=[];
 if(kpis.leadsCreated.value>0)wins.push(`دخل ${kpis.leadsCreated.value} عميلًا محتملًا هذا الأسبوع`+(kpis.leadsCreated.changePercent>0?` (بزيادة ${kpis.leadsCreated.changePercent}% عن الأسبوع الماضي)`:''));
 if(kpis.wonDeals.value>0)wins.push(`تم كسب ${kpis.wonDeals.value} صفقة بقيمة ${Math.round(kpis.wonRevenue.value).toLocaleString('en-US')} ريال`);
 if(agents.totalRuns>0 && agents.totalErrors===0)wins.push('كل تشغيلات الوكلاء هذا الأسبوع اكتملت بلا أخطاء');
 if(kpis.lostDeals.value>0)issues.push(`خُسرت ${kpis.lostDeals.value} صفقة هذا الأسبوع`);
 if(agents.totalErrors>0)issues.push(`${agents.totalErrors} تشغيلة وكيل فشلت وتحتاج مراجعة`);
 if(approvalsAndRisks.totalOpen>0)issues.push(`${approvalsAndRisks.totalOpen} عنصرًا ينتظر قرارًا بشريًا`);
 const hot=funnel.stages.find(stage=>stage.key==='hot')?.count||0;
 if(pipeline.quotesValue>0)opportunities.push(`عروض أسعار مفتوحة بقيمة ${Math.round(pipeline.quotesValue).toLocaleString('en-US')} ريال تحتاج متابعة`);
 if(hot>0)opportunities.push(`${hot} فرصة باهتمام مرتفع تستحق تواصلًا سريعًا`);
 const hasEnoughData=kpis.leadsCreated.value>0 || agents.totalRuns>0 || pipeline.hasData && pipeline.pipelineValue>0;
 return {wins:wins.slice(0,3),issues:issues.slice(0,3),opportunities:opportunities.slice(0,3),hasEnoughData};
}
/**
 * The full executive report. Wraps buildWeeklyReport (untouched) and adds every
 * section the dashboard needs. Agent/approval/escalation rows are passed in by
 * the caller (server.js) rather than imported here — see the note above.
 */
export function buildExecutiveReport(store,weekStart,{agents=[],agentRuns=[],escalations=[],approvals=[],env={}}={}) {
 const base=buildWeeklyReport(store,weekStart);
 const previousWeekStart=new Date(Date.parse(weekStart)-7*86400000).toISOString().slice(0,10);
 const previousBase=buildWeeklyReport(store,previousWeekStart);
 const allLeads=listLeads(store.db);
 const leadsThisWeek=allLeads.filter(lead=>lead.createdAt>=base.weekStart+'T00:00:00.000Z' && lead.createdAt<base.weekEnd+'T00:00:00.000Z');
 const leadsPrevWeek=allLeads.filter(lead=>lead.createdAt>=previousBase.weekStart+'T00:00:00.000Z' && lead.createdAt<previousBase.weekEnd+'T00:00:00.000Z');
 const wonThisWeek=allLeads.filter(lead=>lead.stage==='WON' && lead.updatedAt>=base.weekStart+'T00:00:00.000Z' && lead.updatedAt<base.weekEnd+'T00:00:00.000Z');
 const wonPrevWeek=allLeads.filter(lead=>lead.stage==='WON' && lead.updatedAt>=previousBase.weekStart+'T00:00:00.000Z' && lead.updatedAt<previousBase.weekEnd+'T00:00:00.000Z');
 const lostThisWeek=allLeads.filter(lead=>lead.stage==='LOST' && lead.updatedAt>=base.weekStart+'T00:00:00.000Z' && lead.updatedAt<base.weekEnd+'T00:00:00.000Z');
 const lostPrevWeek=allLeads.filter(lead=>lead.stage==='LOST' && lead.updatedAt>=previousBase.weekStart+'T00:00:00.000Z' && lead.updatedAt<previousBase.weekEnd+'T00:00:00.000Z');
 const qualified=list=>list.filter(lead=>lead.stage!=='NEW').length;
 const hot=list=>list.filter(lead=>lead.temperature==='HOT').length;
 const quoted=list=>list.filter(lead=>['QUOTE_SENT','POST_PURCHASE','WON'].includes(lead.stage)).length;
 const state=store.read();
 const contentPendingApproval=state.content.filter(item=>item.status==='REVIEWED').length;

 const kpis={
  leadsCreated:computeComparison(leadsThisWeek.length,leadsPrevWeek.length),
  qualifiedLeads:computeComparison(qualified(leadsThisWeek),qualified(leadsPrevWeek)),
  hotLeads:computeComparison(hot(leadsThisWeek),hot(leadsPrevWeek)),
  quotesSent:computeComparison(quoted(leadsThisWeek),quoted(leadsPrevWeek)),
  wonDeals:computeComparison(wonThisWeek.length,wonPrevWeek.length),
  lostDeals:computeComparison(lostThisWeek.length,lostPrevWeek.length),
  wonRevenue:computeComparison(wonThisWeek.reduce((sum,lead)=>sum+(lead.valueSAR||0),0),wonPrevWeek.reduce((sum,lead)=>sum+(lead.valueSAR||0),0)),
  followupsDrafted:computeComparison(base.crm.followupsDrafted,previousBase.crm.followupsDrafted),
  conversionRate:{value:pct(wonThisWeek.length,leadsThisWeek.length),previous:pct(wonPrevWeek.length,leadsPrevWeek.length),unit:'percent'},
  contentPlanned:computeComparison(base.content.total,previousBase.content.total),
  contentPendingApproval:{value:contentPendingApproval,note:'لقطة حالية وليست مقيدة بالأسبوع'},
  agentApprovalsPending:{value:approvals.filter(approval=>approval.status==='PENDING').length,note:'لقطة حالية وليست مقيدة بالأسبوع'}
 };
 const funnel=computeSalesFunnel(allLeads);
 const pipeline=computePipeline(allLeads,base.weekStart,base.weekEnd);
 const agentRunsThisWeek=agentRuns.filter(run=>run.started_at>=base.weekStart+'T00:00:00.000Z' && run.started_at<base.weekEnd+'T00:00:00.000Z');
 const agentMetrics=computeAgentMetrics(agentRunsThisWeek,escalations,agents);
 const approvalsAndRisks=computeApprovalsAndRisks(state.content,approvals,escalations);
 const market=computeMarketSignals(currentMemory(store.db));
 const nextWeekPlan=computeNextWeekPlan(listSlots(store.db),base.weekEnd);
 const quickSummary=computeQuickSummary({kpis,funnel,pipeline,agents:agentMetrics,approvalsAndRisks});

 return {
  ...base,
  period:{start:base.weekStart,end:base.weekEnd,previousStart:previousBase.weekStart,previousEnd:previousBase.weekEnd},
  dataStatus:{crmConnected:true,socialConnected:false,storeConnected:!!env.SALLA_ACCESS_TOKEN,aiConfigured:!!(env.ANTHROPIC_API_KEY&&env.ANTHROPIC_MODEL)},
  kpis,funnel,pipeline,agents:agentMetrics,approvalsAndRisks,market,nextWeekPlan,quickSummary
 };
}
export function saveWeeklyReport(store,weekStart,user,extras=null) {
 return store.mutate(state=>{
  validDate(weekStart);
  const prior=store.db.prepare('SELECT json FROM weekly_reports WHERE week_start=?').get(weekStart);
  if(prior)return {...JSON.parse(prior.json),replayed:true};
  const report=extras?buildExecutiveReport(store,weekStart,extras):buildWeeklyReport(store,weekStart);
  store.db.prepare('INSERT INTO weekly_reports VALUES (?,?)').run(weekStart,JSON.stringify(report));
  state.audit.unshift({id:randomUUID(),action:'WEEKLY_REPORT_CREATED',itemId:weekStart,actorId:user.id,actorName:user.name,actorRole:user.role,at:new Date().toISOString()});
  return report;
 });
}
