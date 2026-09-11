import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installKnowledge,saveMemory} from '../src/knowledge.js';
import {installCRM,createLead,updateLead} from '../src/crm.js';
import {installPlanning} from '../src/planning.js';
import {installCompliance} from '../src/compliance.js';
import {installAutonomy} from '../src/autonomy.js';
import {installReporting,saveWeeklyReport,listWeeklyReports,
 computeComparison,computeSalesFunnel,computePipeline,computeAgentMetrics,
 computeApprovalsAndRisks,computeMarketSignals,computeQuickSummary,buildExecutiveReport} from '../src/reporting.js';
import {installContent} from '../src/content.js';
import {installAuditLog} from '../src/audit.js';

const user={id:'owner-id',name:'Owner',role:'owner'};
function fixture(){
 const store=openStore(':memory:');
 installKnowledge(store.db);installCRM(store.db);installPlanning(store.db);installCompliance(store.db);installAutonomy(store.db);installReporting(store.db);installContent(store.db);installAuditLog(store.db);
 return store;
}
const sunday='2026-09-06';

test('computeComparison reports trend and handles a zero baseline honestly',()=>{
 assert.deepEqual(computeComparison(10,5),{value:10,previous:5,change:5,changePercent:100,trend:'up'});
 assert.deepEqual(computeComparison(0,0),{value:0,previous:0,change:0,changePercent:null,trend:'flat'});
 assert.equal(computeComparison(3,0).changePercent,100);
 assert.equal(computeComparison(2,5).trend,'down');
});

test('computeSalesFunnel is honestly empty with no leads and buckets correctly with real ones',()=>{
 assert.deepEqual(computeSalesFunnel([]).stages.map(s=>s.count),[0,0,0,0,0]);
 assert.equal(computeSalesFunnel([]).hasData,false);
 const leads=[
  {stage:'NEW',temperature:'COLD'},
  {stage:'QUALIFIED',temperature:'WARM'},
  {stage:'QUOTE_SENT',temperature:'HOT'},
  {stage:'WON',temperature:'WARM'},
  {stage:'LOST',temperature:'COLD'}
 ];
 const funnel=computeSalesFunnel(leads);
 assert.equal(funnel.hasData,true);
 const byKey=Object.fromEntries(funnel.stages.map(s=>[s.key,s.count]));
 assert.equal(byKey.new,1);
 assert.equal(byKey.qualified,3); // QUALIFIED, QUOTE_SENT, WON all count as "past new"
 assert.equal(byKey.hot,1);
 assert.equal(byKey.quote,2); // QUOTE_SENT + WON
 assert.equal(byKey.won,1);
});

test('computePipeline excludes closed deals from pipeline value and only counts wins updated this week',()=>{
 const leads=[
  {stage:'QUOTE_SENT',valueSAR:10000,updatedAt:'2026-09-08T00:00:00.000Z'},
  {stage:'WON',valueSAR:5000,updatedAt:'2026-09-08T00:00:00.000Z'}, // inside week
  {stage:'WON',valueSAR:99999,updatedAt:'2026-08-01T00:00:00.000Z'}, // won, but not this week
  {stage:'LOST',valueSAR:20000,updatedAt:'2026-09-08T00:00:00.000Z'}
 ];
 const pipeline=computePipeline(leads,'2026-09-06','2026-09-13');
 assert.equal(pipeline.pipelineValue,10000); // only the open QUOTE_SENT deal
 assert.equal(pipeline.wonRevenue,5000);
 assert.equal(pipeline.wonDealsThisWeek,1);
 assert.equal(pipeline.avgDealSize,5000);
 assert.equal(pipeline.quotesValue,10000);
});

test('computePipeline never fabricates an average deal size when nothing was won',()=>{
 const pipeline=computePipeline([{stage:'QUOTE_SENT',valueSAR:1000,updatedAt:'2026-09-08T00:00:00.000Z'}],'2026-09-06','2026-09-13');
 assert.equal(pipeline.avgDealSize,null);
 assert.equal(pipeline.wonRevenue,0);
});

test('computeAgentMetrics aggregates per agent and leaves successRate null with zero runs',()=>{
 const agents=[{id:'sales',name_ar:'المبيعات'},{id:'copy',name_ar:'الكتابة'}];
 const runs=[
  {agent_id:'sales',status:'COMPLETED',latency_ms:200,tokens_input:10,tokens_output:20,started_at:'2026-09-08T00:00:00.000Z'},
  {agent_id:'sales',status:'FAILED',latency_ms:null,tokens_input:0,tokens_output:0,started_at:'2026-09-09T00:00:00.000Z'}
 ];
 const escalations=[{agent_id:'sales'}];
 const metrics=computeAgentMetrics(runs,escalations,agents);
 const sales=metrics.agents.find(a=>a.id==='sales'),copy=metrics.agents.find(a=>a.id==='copy');
 assert.equal(sales.runs,2);assert.equal(sales.successRate,50);assert.equal(sales.escalations,1);assert.equal(sales.avgLatencyMs,200);
 assert.equal(copy.runs,0);assert.equal(copy.successRate,null);
 assert.equal(metrics.totalErrors,1);
});

test('computeApprovalsAndRisks only surfaces items still awaiting a human decision',()=>{
 const content=[{id:'c1',status:'REVIEWED',title:'x',platform:'X'},{id:'c2',status:'APPROVED',title:'y',platform:'X'}];
 const approvals=[{id:'a1',status:'PENDING',agent_id:'sales',action_type:'discount',risk_level:'MEDIUM',reason:'r',created_at:'now'},{id:'a2',status:'APPROVED'}];
 const escalations=[{id:'e1',status:'OPEN',agent_id:'sales',priority:'P1',reason:'r',created_at:'now'},{id:'e2',status:'RESOLVED'}];
 const result=computeApprovalsAndRisks(content,approvals,escalations);
 assert.equal(result.pendingContentReview.length,1);
 assert.equal(result.pendingAgentApprovals.length,1);
 assert.equal(result.openEscalations.length,1);
 assert.equal(result.totalOpen,3);
});

test('computeMarketSignals ignores every memory kind except competitor_insight',()=>{
 const entries=[{kind:'competitor_insight',key:'k1',value:'v',source:'s',verifiedAt:'t'},{kind:'brand_voice',key:'k2',value:'v'}];
 const market=computeMarketSignals(entries);
 assert.equal(market.signals.length,1);
 assert.equal(market.hasData,true);
 assert.equal(computeMarketSignals([]).hasData,false);
});

test('computeQuickSummary never claims data exists when the week was silent',()=>{
 const empty=computeQuickSummary({
  kpis:{leadsCreated:{value:0,changePercent:null},wonDeals:{value:0},wonRevenue:{value:0},lostDeals:{value:0}},
  funnel:{stages:[{key:'hot',count:0}]},pipeline:{quotesValue:0,hasData:false,pipelineValue:0},
  agents:{totalRuns:0,totalErrors:0},approvalsAndRisks:{totalOpen:0}
 });
 assert.deepEqual(empty.wins,[]);
 assert.deepEqual(empty.issues,[]);
 assert.deepEqual(empty.opportunities,[]);
 assert.equal(empty.hasEnoughData,false);
});

test('buildExecutiveReport assembles a full real shape from actual CRM data and reflects data_status honestly',()=>{
 const store=fixture();
 try{
  createLead(store,{name:'Gym Riyadh',customerType:'B2B',sourceType:'INBOUND',company:'Gym Co',phone:'+966501112222',valueSAR:15000},user);
  const report=buildExecutiveReport(store,sunday,{agents:[],agentRuns:[],escalations:[],approvals:[],env:{}});
  assert.equal(report.period.start,sunday);
  assert.ok(report.kpis.leadsCreated);
  assert.ok(report.funnel.stages.length,5);
  assert.ok(report.pipeline);
  assert.ok(Array.isArray(report.agents.agents));
  assert.equal(report.dataStatus.crmConnected,true);
  assert.equal(report.dataStatus.socialConnected,false);
  assert.equal(report.dataStatus.storeConnected,false);
  assert.equal(report.dataStatus.aiConfigured,false);
  // the original fields must still be present unchanged — nothing was removed
  assert.ok(report.content);assert.ok(report.calendar);assert.ok(report.compliance);assert.ok(report.crm);assert.equal(report.deliveryStatus,'LOCAL_ONLY');
 }finally{store.close();}
});

test('saveWeeklyReport stays backward compatible: no extras saves the plain shape, extras saves the executive shape',()=>{
 const store=fixture();
 try{
  const plain=saveWeeklyReport(store,sunday,user);
  assert.equal(plain.kpis,undefined);
  const executiveWeek='2026-09-13';
  const rich=saveWeeklyReport(store,executiveWeek,user,{agents:[],agentRuns:[],escalations:[],approvals:[],env:{}});
  assert.ok(rich.kpis);
  assert.ok(rich.funnel);
  assert.equal(listWeeklyReports(store.db).length,2);
 }finally{store.close();}
});
