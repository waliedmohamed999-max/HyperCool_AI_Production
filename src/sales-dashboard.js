import {listLeads,listFollowups,listAllMessages,stages} from './crm.js';
import {computeSalesFunnel,computePipeline} from './reporting.js';
import {providerStatus} from './runtime/llmProvider.js';
import {listAuditLog} from './audit.js';

// SalesDashboardService. Every function is pure (arrays in, plain objects out) so it
// stays testable without a database and never duplicates crm.js's own validation or
// write paths — this file only reads and reshapes what crm.js and reporting.js already
// compute. No new lead/opportunity/quote model: a "quote" here is a lead at QUOTE_SENT,
// exactly what the CRM already tracks — there is no separate Quote entity in this system.
const DAY_MS=86400000;
const round=(n,d=0)=>Number.isFinite(n)?Math.round(n*10**d)/10**d:null;
const countBy=(list,key)=>{const counts={};for(const item of list){const value=key(item);if(value===null||value===undefined||value==='')continue;counts[value]=(counts[value]||0)+1;}return counts;};
// Heuristic only — not a learned or historical win-rate. Documented here, surfaced to the UI as such.
export const STAGE_PROBABILITY={NEW:0.05,QUALIFIED:0.2,DEMO:0.4,QUOTE_SENT:0.6,POST_PURCHASE:0.8,PARKED:0.1,WON:1,LOST:0};

export function computeKPIs(leads,followups,now=Date.now()) {
 const active=leads.filter(lead=>!['WON','LOST'].includes(lead.stage));
 const weekAgo=new Date(now-7*DAY_MS).toISOString();
 return {
  newLeads:{value:leads.filter(lead=>lead.stage==='NEW').length,newThisWeek:leads.filter(lead=>lead.createdAt>=weekAgo).length},
  qualifiedLeads:{value:leads.filter(lead=>lead.stage!=='NEW').length},
  hotLeads:{value:active.filter(lead=>lead.temperature==='HOT').length},
  quotesSent:{value:leads.filter(lead=>lead.stage==='QUOTE_SENT').length},
  pipelineValue:{value:active.reduce((sum,lead)=>sum+(lead.valueSAR||0),0)},
  wonDeals:{value:leads.filter(lead=>lead.stage==='WON').length},
  lostDeals:{value:leads.filter(lead=>lead.stage==='LOST').length},
  followupsOverdue:{value:followups.filter(f=>['APPROVED','READY_FOR_CHANNEL'].includes(f.status)&&Date.parse(f.dueAt)<now).length}
 };
}
export function computePipelineBoard(leads) {
 return stages.map(stage=>({
  stage,count:leads.filter(lead=>lead.stage===stage).length,
  leads:leads.filter(lead=>lead.stage===stage).map(lead=>({id:lead.id,name:lead.company||lead.name,customerType:lead.customerType,valueSAR:lead.valueSAR,city:lead.city,productNeed:lead.productNeed,temperature:lead.temperature,assignedTo:lead.assignedTo,sourceType:lead.sourceType,version:lead.version,updatedAt:lead.updatedAt||lead.createdAt,humanHold:lead.humanHold,optOut:lead.optOut}))
 }));
}
export function computeHotLeads(leads,messages,limit=10) {
 const hot=leads.filter(lead=>lead.temperature==='HOT'&&!['WON','LOST'].includes(lead.stage));
 return hot.map(lead=>{
  const last=messages.filter(m=>m.leadId===lead.id).sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt))[0];
  return {id:lead.id,name:lead.company||lead.name,customerType:lead.customerType,productNeed:lead.productNeed,quantity:lead.quantity,city:lead.city,timeline:lead.timeline,valueSAR:lead.valueSAR,stage:lead.stage,lastMessageAt:last?.recordedAt||null,lastMessageText:last?.text||null,humanHold:lead.humanHold,handoffReason:lead.handoffReason,assignedTo:lead.assignedTo};
 }).sort((a,b)=>(b.valueSAR||0)-(a.valueSAR||0)||(b.lastMessageAt||'').localeCompare(a.lastMessageAt||'')).slice(0,limit);
}
export function computeFollowupCenter(followups,now=Date.now()) {
 const today=new Date(now).toISOString().slice(0,10);
 const buckets={dueToday:[],overdue:[],thisWeek:[],onHold:[],done:[]};
 for(const followup of followups) {
  if(followup.status==='HOLD'){buckets.onHold.push(followup);continue;}
  if(!['DRAFT','APPROVED','READY_FOR_CHANNEL'].includes(followup.status)){buckets.done.push(followup);continue;}
  const dueDay=followup.dueAt.slice(0,10);
  if(dueDay===today)buckets.dueToday.push(followup);
  else if(Date.parse(followup.dueAt)<now)buckets.overdue.push(followup);
  else if(Date.parse(followup.dueAt)<now+7*DAY_MS)buckets.thisWeek.push(followup);
 }
 return buckets;
}
export function computeConversationsSummary(messages,leads) {
 const leadById=Object.fromEntries(leads.map(lead=>[lead.id,lead]));
 const latestByLead=new Map();
 for(const message of messages) {
  const existing=latestByLead.get(message.leadId);
  if(!existing||existing.recordedAt<message.recordedAt)latestByLead.set(message.leadId,message);
 }
 const rows=[...latestByLead.values()].map(message=>{
  const lead=leadById[message.leadId];
  return {leadId:message.leadId,customer:lead?.company||lead?.name||'—',channel:message.channel,lastMessage:message.text,lastMessageAt:message.recordedAt,intent:message.intent,temperature:lead?.temperature||null,customerType:lead?.customerType||null,assignedTo:lead?.assignedTo||null,awaitingResponse:!!lead?.replyHold};
 }).sort((a,b)=>b.lastMessageAt.localeCompare(a.lastMessageAt));
 return {rows,byChannel:countBy(rows,row=>row.channel),awaitingResponse:rows.filter(row=>row.awaitingResponse).length,hasData:rows.length>0};
}
export function computeB2BOpportunities(leads) {
 return leads.filter(lead=>lead.customerType==='B2B'&&!['WON','LOST'].includes(lead.stage)).map(lead=>({
  id:lead.id,company:lead.company,need:lead.productNeed,valueSAR:lead.valueSAR,stage:lead.stage,
  probability:STAGE_PROBABILITY[lead.stage]??null,nextStep:lead.nextCheckAt?('مراجعة مؤجلة: '+lead.nextCheckAt.slice(0,10)):null,
  assignedTo:lead.assignedTo,city:lead.city,trigger:lead.research?.trigger||null,sourceUrl:lead.research?.sourceUrl||null,fitScore:lead.research?.fitScore||null
 }));
}
// A "quote" is a lead snapshot at QUOTE_SENT/POST_PURCHASE/WON — there is no separate
// Quote record with its own lifecycle (draft/viewed/expired) in this system yet.
export function computeQuotes(leads) {
 return leads.filter(lead=>['QUOTE_SENT','POST_PURCHASE','WON'].includes(lead.stage)).map(lead=>({
  id:lead.id,customer:lead.company||lead.name,amount:lead.valueSAR,createdAt:lead.createdAt,
  status:lead.stage==='WON'?'ACCEPTED':'SENT',productNeed:lead.productNeed,quantity:lead.quantity,assignedTo:lead.assignedTo
 }));
}
export function computeRevenueForecast(leads) {
 const active=leads.filter(lead=>!['WON','LOST'].includes(lead.stage));
 const won=leads.filter(lead=>lead.stage==='WON');
 const weightedPipeline=active.reduce((sum,lead)=>sum+(lead.valueSAR||0)*(STAGE_PROBABILITY[lead.stage]??0),0);
 const wonRevenue=won.reduce((sum,lead)=>sum+(lead.valueSAR||0),0);
 const byStage=stages.map(stage=>{
  const inStage=leads.filter(lead=>lead.stage===stage);
  return {stage,value:inStage.reduce((sum,lead)=>sum+(lead.valueSAR||0),0),count:inStage.length};
 });
 return {pipelineTotal:active.reduce((sum,lead)=>sum+(lead.valueSAR||0),0),weightedPipeline:round(weightedPipeline),wonRevenue,avgDealSize:won.length?round(wonRevenue/won.length):null,byStage,probabilityModel:STAGE_PROBABILITY,hasData:leads.length>0};
}
export function computeAIInsights(leads,messages) {
 const hasEnoughData=leads.length>=5;
 if(!hasEnoughData)return {hasEnoughData:false,reason:'INSUFFICIENT_DATA'};
 const stalled=leads.filter(lead=>!['WON','LOST'].includes(lead.stage)&&lead.updatedAt&&Date.now()-Date.parse(lead.updatedAt)>14*DAY_MS);
 const sourcePerformance={};
 for(const lead of leads) {
  if(!lead.sourceType)continue;
  sourcePerformance[lead.sourceType]=sourcePerformance[lead.sourceType]||{count:0,won:0};
  sourcePerformance[lead.sourceType].count++;
  if(lead.stage==='WON')sourcePerformance[lead.sourceType].won++;
 }
 return {
  hasEnoughData:true,
  topProducts:Object.entries(countBy(leads,lead=>lead.productNeed)).sort((a,b)=>b[1]-a[1]).slice(0,5),
  commonInquiryTypes:Object.entries(countBy(messages,m=>m.intent)).sort((a,b)=>b[1]-a[1]),
  bestSource:Object.entries(sourcePerformance).sort((a,b)=>b[1].won-a[1].won)[0]||null,
  lostReasons:leads.filter(lead=>lead.stage==='LOST'&&lead.lastChangeReason).map(lead=>lead.lastChangeReason).slice(0,5),
  stalledDeals:stalled.map(lead=>({id:lead.id,name:lead.company||lead.name,daysSince:round((Date.now()-Date.parse(lead.updatedAt))/DAY_MS),valueSAR:lead.valueSAR})),
  needsIntervention:leads.filter(lead=>lead.humanHold).map(lead=>({id:lead.id,name:lead.company||lead.name,reason:lead.handoffReason}))
 };
}
export function computeFrostSalesRecommendation(leads,now=Date.now()) {
 const staleQuotes=leads.filter(lead=>lead.stage==='QUOTE_SENT'&&lead.updatedAt&&now-Date.parse(lead.updatedAt)>72*3600000);
 if(!staleQuotes.length)return null;
 const value=staleQuotes.reduce((sum,lead)=>sum+(lead.valueSAR||0),0);
 return {text:`${staleQuotes.length} عرض سعر لم تتم متابعته خلال 72 ساعة، بقيمة إجمالية ${round(value)} ريال.`,leadIds:staleQuotes.map(lead=>lead.id)};
}
export function computeRecentActivity(auditEntries,agentRuns,limit=30) {
 const agentNames={sales:'وكيل المبيعات',leads:'وكيل العملاء المحتملين',followup:'وكيل المتابعة'};
 const humanActivity=auditEntries.filter(entry=>entry.action?.startsWith('CRM_')).map(entry=>({at:entry.at,actor:entry.actorName||'نظام',action:entry.action,itemId:entry.itemId,source:'HUMAN'}));
 const agentActivity=agentRuns.filter(run=>agentNames[run.agent_id]&&run.status==='COMPLETED').map(run=>({at:run.finished_at||run.started_at,actor:agentNames[run.agent_id],action:'AGENT_RUN_COMPLETED',itemId:run.id,source:'AGENT'}));
 return [...humanActivity,...agentActivity].filter(entry=>entry.at).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,limit);
}
export function buildSalesDashboard(store,{agentRuns=[],env={},tenantId=null}={}) {
 const leads=listLeads(store.db,tenantId);
 const followups=listFollowups(store.db,tenantId);
 const messages=listAllMessages(store.db,500,tenantId);
 const auditEntries=listAuditLog(store.db,{tenantId});
 const llm=providerStatus(env);
 return {
  dataStatus:{crm:'LOCAL',whatsapp:env.WHATSAPP_ACCESS_TOKEN?'CONNECTED':'NOT_CONNECTED',salla:env.SALLA_ACCESS_TOKEN?'CONNECTED':'NOT_CONNECTED',aiSalesAgent:llm.configured?'ONLINE':'OFFLINE'},
  kpis:computeKPIs(leads,followups),
  funnel:computeSalesFunnel(leads),
  pipeline:computePipelineBoard(leads),
  pipelineSummary:computePipeline(leads,new Date(Date.now()-30*DAY_MS).toISOString().slice(0,10),new Date().toISOString().slice(0,10)),
  hotLeads:computeHotLeads(leads,messages),
  followups:computeFollowupCenter(followups),
  conversations:computeConversationsSummary(messages,leads),
  b2b:computeB2BOpportunities(leads),
  quotes:computeQuotes(leads),
  forecast:computeRevenueForecast(leads),
  aiInsights:computeAIInsights(leads,messages),
  frostRecommendation:computeFrostSalesRecommendation(leads),
  recentActivity:computeRecentActivity(auditEntries,agentRuns),
  hasAnyLeads:leads.length>0
 };
}
