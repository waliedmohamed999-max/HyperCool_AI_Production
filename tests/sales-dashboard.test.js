import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installKnowledge} from '../src/knowledge.js';
import {installCRM,createLead,updateLead,recordMessage,searchLeads} from '../src/crm.js';
import {installPlanning} from '../src/planning.js';
import {installCompliance} from '../src/compliance.js';
import {installAutonomy} from '../src/autonomy.js';
import {installReporting} from '../src/reporting.js';
import {computeKPIs,computePipelineBoard,computeHotLeads,computeFollowupCenter,
 computeConversationsSummary,computeB2BOpportunities,computeQuotes,computeRevenueForecast,
 computeAIInsights,computeFrostSalesRecommendation,computeRecentActivity,buildSalesDashboard,STAGE_PROBABILITY} from '../src/sales-dashboard.js';

const user={id:'owner-id',name:'Owner',role:'owner'};
function fixture(){
 const store=openStore(':memory:');
 installKnowledge(store.db);installCRM(store.db);installPlanning(store.db);installCompliance(store.db);installAutonomy(store.db);installReporting(store.db);
 return store;
}

test('computeKPIs never fabricates a nonzero number from an empty CRM',()=>{
 const kpis=computeKPIs([],[]);
 assert.equal(kpis.newLeads.value,0);
 assert.equal(kpis.pipelineValue.value,0);
 assert.equal(kpis.hotLeads.value,0);
});
test('computeKPIs excludes closed deals from pipeline value and hot-lead counts',()=>{
 const leads=[
  {stage:'QUOTE_SENT',valueSAR:10000,temperature:'HOT',createdAt:'2020-01-01T00:00:00.000Z'},
  {stage:'WON',valueSAR:99999,temperature:'HOT',createdAt:'2020-01-01T00:00:00.000Z'},
  {stage:'NEW',valueSAR:0,temperature:'COLD',createdAt:'2020-01-01T00:00:00.000Z'}
 ];
 const kpis=computeKPIs(leads,[]);
 assert.equal(kpis.pipelineValue.value,10000);
 assert.equal(kpis.hotLeads.value,1); // the WON one is closed, excluded even though HOT
 assert.equal(kpis.wonDeals.value,1);
});

test('computePipelineBoard returns every real stage as a column, even empty ones',()=>{
 const board=computePipelineBoard([{stage:'NEW',company:'A'}]);
 assert.equal(board.length,8); // the 8 real stages in src/crm.js, not an invented set
 assert.equal(board.find(col=>col.stage==='NEW').count,1);
 assert.equal(board.find(col=>col.stage==='WON').count,0);
 assert.ok(!board.some(col=>col.stage==='NEGOTIATION')); // never invent a stage that doesn't exist
});

test('computeHotLeads only includes open HOT leads and attaches their latest real message',()=>{
 const leads=[{id:'l1',temperature:'HOT',stage:'QUOTE_SENT',valueSAR:5000},{id:'l2',temperature:'HOT',stage:'WON',valueSAR:99999}];
 const messages=[{leadId:'l1',recordedAt:'2026-01-01T00:00:00.000Z',text:'old'},{leadId:'l1',recordedAt:'2026-01-02T00:00:00.000Z',text:'new'}];
 const hot=computeHotLeads(leads,messages);
 assert.equal(hot.length,1); // WON is closed, excluded
 assert.equal(hot[0].lastMessageText,'new');
});

test('computeFollowupCenter buckets by real due dates and status, never both overdue and done',()=>{
 const now=Date.parse('2026-09-09T12:00:00Z');
 const followups=[
  {status:'APPROVED',dueAt:'2026-09-01T00:00:00.000Z'}, // overdue
  {status:'APPROVED',dueAt:'2026-09-09T08:00:00.000Z'}, // due today
  {status:'READY_FOR_CHANNEL',dueAt:'2026-09-12T00:00:00.000Z'}, // this week
  {status:'HOLD',dueAt:'2026-09-01T00:00:00.000Z'},
  {status:'READY_FOR_CHANNEL',dueAt:'2026-01-01T00:00:00.000Z'} // sent long ago -> not "done" per status list here
 ];
 const buckets=computeFollowupCenter(followups,now);
 assert.equal(buckets.overdue.length,2); // both stale ones
 assert.equal(buckets.dueToday.length,1);
 assert.equal(buckets.thisWeek.length,1);
 assert.equal(buckets.onHold.length,1);
});

test('computeConversationsSummary uses replyHold as the real "awaiting response" signal, not a fabricated unread count',()=>{
 const leads=[{id:'l1',name:'A',replyHold:true},{id:'l2',name:'B',replyHold:false}];
 const messages=[{leadId:'l1',recordedAt:'t1',text:'hi',channel:'WhatsApp',intent:'general'},{leadId:'l2',recordedAt:'t2',text:'hey',channel:'Email',intent:'quote'}];
 const summary=computeConversationsSummary(messages,leads);
 assert.equal(summary.rows.length,2);
 assert.equal(summary.awaitingResponse,1);
 assert.equal(summary.hasData,true);
 assert.equal(computeConversationsSummary([],[]).hasData,false);
});

test('computeB2BOpportunities excludes closed deals and B2C leads',()=>{
 const leads=[{customerType:'B2B',stage:'QUOTE_SENT',company:'X'},{customerType:'B2C',stage:'QUOTE_SENT'},{customerType:'B2B',stage:'WON'}];
 assert.equal(computeB2BOpportunities(leads).length,1);
});

test('computeQuotes is honestly derived from lead stage, not a separate quote entity',()=>{
 const leads=[{stage:'QUOTE_SENT',valueSAR:1000,name:'A'},{stage:'WON',valueSAR:2000,name:'B'},{stage:'NEW',valueSAR:0,name:'C'}];
 const quotes=computeQuotes(leads);
 assert.equal(quotes.length,2);
 assert.equal(quotes.find(q=>q.amount===2000).status,'ACCEPTED');
 assert.equal(quotes.find(q=>q.amount===1000).status,'SENT');
});

test('computeRevenueForecast weights only open pipeline and documents the probability model used',()=>{
 const leads=[{stage:'QUOTE_SENT',valueSAR:10000},{stage:'WON',valueSAR:5000}];
 const forecast=computeRevenueForecast(leads);
 assert.equal(forecast.wonRevenue,5000);
 assert.equal(forecast.weightedPipeline,10000*STAGE_PROBABILITY.QUOTE_SENT);
 assert.equal(forecast.avgDealSize,5000);
 assert.ok(forecast.probabilityModel);
});
test('computeRevenueForecast never fabricates an average deal size with no wins',()=>{
 assert.equal(computeRevenueForecast([{stage:'QUOTE_SENT',valueSAR:1000}]).avgDealSize,null);
});

test('computeAIInsights refuses to guess with too little data and says so explicitly',()=>{
 const insights=computeAIInsights([{stage:'NEW'}],[]);
 assert.equal(insights.hasEnoughData,false);
 assert.equal(insights.reason,'INSUFFICIENT_DATA');
});
test('computeAIInsights surfaces only real, derivable signals once there is enough data',()=>{
 const leads=Array.from({length:6},(_,i)=>({id:'l'+i,stage:i===0?'LOST':'QUALIFIED',productNeed:'Cryo',sourceType:'INBOUND',lastChangeReason:i===0?'Too expensive':null,humanHold:i===1,handoffReason:i===1?'medical':null}));
 const insights=computeAIInsights(leads,[{intent:'quote'},{intent:'quote'},{intent:'general'}]);
 assert.equal(insights.hasEnoughData,true);
 assert.equal(insights.topProducts[0][0],'Cryo');
 assert.equal(insights.lostReasons[0],'Too expensive');
 assert.equal(insights.needsIntervention.length,1);
 assert.ok(insights.commonInquiryTypes.length);
});

test('computeFrostSalesRecommendation stays silent when nothing is actually stale',()=>{
 assert.equal(computeFrostSalesRecommendation([{stage:'QUOTE_SENT',valueSAR:1000,updatedAt:new Date().toISOString()}]),null);
});
test('computeFrostSalesRecommendation flags real stale quotes with a real total value',()=>{
 const stale=new Date(Date.now()-100*3600000).toISOString();
 const rec=computeFrostSalesRecommendation([{id:'l1',stage:'QUOTE_SENT',valueSAR:20000,updatedAt:stale}]);
 assert.match(rec.text,/20,?000|20000/);
 assert.deepEqual(rec.leadIds,['l1']);
});

test('computeRecentActivity merges human CRM audit and completed agent runs, sorted by time, nothing else',()=>{
 const audit=[{action:'CRM_LEAD_CREATED',at:'2026-09-09T10:00:00.000Z',actorName:'Owner',itemId:'l1'},{action:'OWNER_APPROVED',at:'2026-09-09T09:00:00.000Z'}];
 const runs=[{agent_id:'sales',status:'COMPLETED',finished_at:'2026-09-09T11:00:00.000Z',id:'r1'},{agent_id:'compliance',status:'COMPLETED',finished_at:'2026-09-09T12:00:00.000Z',id:'r2'}];
 const activity=computeRecentActivity(audit,runs);
 assert.equal(activity.length,2); // OWNER_APPROVED is not CRM_*, compliance run is not a sales-pod agent
 assert.equal(activity[0].source,'AGENT');
 assert.equal(activity[1].source,'HUMAN');
});

test('buildSalesDashboard assembles the full dashboard from real CRM data end to end',()=>{
 const store=fixture();
 try{
  const lead=createLead(store,{name:'Gym Riyadh',customerType:'B2B',sourceType:'INBOUND',company:'Gym Co',phone:'+966501112222',valueSAR:30000},user);
  updateLead(store,lead.id,{stage:'QUOTE_SENT',temperature:'HOT',reason:'quote sent',expectedVersion:1},user);
  recordMessage(store,lead.id,{channel:'WhatsApp',text:'ما هو السعر؟',intent:'quote',eventKey:'evt1'},user);
  const dashboard=buildSalesDashboard(store,{agentRuns:[],env:{}});
  assert.equal(dashboard.dataStatus.crm,'LOCAL');
  assert.equal(dashboard.dataStatus.whatsapp,'NOT_CONNECTED');
  assert.equal(dashboard.dataStatus.aiSalesAgent,'OFFLINE');
  assert.equal(dashboard.kpis.hotLeads.value,1);
  assert.equal(dashboard.hotLeads.length,1);
  assert.equal(dashboard.b2b.length,1);
  assert.equal(dashboard.quotes.length,1);
  assert.equal(dashboard.conversations.rows.length,1);
  assert.equal(dashboard.hasAnyLeads,true);
  assert.ok(dashboard.pipeline.length===8);
 }finally{store.close();}
});

test('searchLeads matches name, company, phone, email or product need and nothing else',()=>{
 const store=fixture();
 try{
  createLead(store,{name:'Ahmed Ali',customerType:'B2C',sourceType:'INBOUND',phone:'+966501234567',productNeed:'Cryo chamber'},user);
  createLead(store,{name:'Sara',customerType:'B2C',sourceType:'INBOUND',phone:'+966509999999'},user);
  assert.equal(searchLeads(store.db,'ahmed').length,1);
  assert.equal(searchLeads(store.db,'966501234567').length,1);
  assert.equal(searchLeads(store.db,'cryo').length,1);
  assert.equal(searchLeads(store.db,'').length,0);
  assert.equal(searchLeads(store.db,'zzz-not-found').length,0);
 }finally{store.close();}
});
