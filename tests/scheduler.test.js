import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installKnowledge,saveMemory} from '../src/knowledge.js';
import {installCRM,createLead,updateLead,contactControl} from '../src/crm.js';
import {installPlanning} from '../src/planning.js';
import {installCompliance} from '../src/compliance.js';
import {installAutonomy} from '../src/autonomy.js';
import {installReporting,listWeeklyReports} from '../src/reporting.js';
import {installRegistry,seedRegistry} from '../src/runtime/registry.js';
import {installRuntimeTables,createAgentRuntime,listRuns} from '../src/runtime/runtime.js';
import {installEvents,createEventBus} from '../src/runtime/events.js';
import {installApprovals} from '../src/runtime/approvals.js';
import {installEscalations} from '../src/runtime/escalations.js';
import {installGate,setPaused,isPaused} from '../src/runtime/gate.js';
import {createScheduler,sweepFollowupGaps} from '../src/runtime/scheduler.js';
import {installContent} from '../src/content.js';
import {installAuditLog} from '../src/audit.js';

const user={id:'owner-id',name:'Owner',role:'owner'};
const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model'};

function fixture(){
 const store=openStore(':memory:');
 installKnowledge(store.db);installCRM(store.db);installPlanning(store.db);installCompliance(store.db);
 installAutonomy(store.db);installReporting(store.db);installRegistry(store.db);installRuntimeTables(store.db);
 installEvents(store.db);installApprovals(store.db);installEscalations(store.db);installGate(store.db);installContent(store.db);installAuditLog(store.db);
 seedRegistry(store.db);
 return store;
}
const followupDecision={status:'OK',action:'HOLD',rationale:'No reply yet, respecting cooldown',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{sequence_name:'QUOTE',touch_number:1,channel:'WhatsApp',send_or_hold:'HOLD',message_ar:'رسالة',message_en:'message',reason:'cooldown',next_followup_date:null,stop_condition:null,crm_update:{}}};
const fetcherFor=obj=>async()=>new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(obj)}],usage:{input_tokens:2,output_tokens:2}}),{status:200,headers:{'content-type':'application/json'}});

// Riyadh = UTC+3. Pick a UTC instant that lands on 08:00 Riyadh on a Sunday.
const sundayAt8amRiyadh=Date.parse('2026-09-13T05:00:00Z'); // 2026-09-13 is a Sunday
const wednesdayNoonRiyadh=Date.parse('2026-09-09T09:00:00Z');

test('tick runs the daily brief only around 08:00 Riyadh and is idempotent for the same day',async()=>{
 const store=fixture();
 try{
  const runtime=createAgentRuntime({store,env,fetcher:fetcherFor(followupDecision)});
  const scheduler=createScheduler({store,agentRuntime:runtime,env});
  const midday=await scheduler.tick(wednesdayNoonRiyadh);
  assert.equal(midday.dailyBrief,undefined);
  const morning=await scheduler.tick(sundayAt8amRiyadh);
  assert.ok(morning.dailyBrief);
  const again=await scheduler.tick(sundayAt8amRiyadh+60000);
  assert.equal(again.dailyBrief.replayed,true);
 }finally{store.close();}
});

test('tick saves the weekly report only on Sunday and never fabricates a second one for the same week',async()=>{
 const store=fixture();
 try{
  const runtime=createAgentRuntime({store,env,fetcher:fetcherFor(followupDecision)});
  const scheduler=createScheduler({store,agentRuntime:runtime,env});
  const first=await scheduler.tick(sundayAt8amRiyadh);
  assert.ok(first.weeklyReport);
  assert.equal(first.weeklyReport.replayed,undefined);
  const wednesday=await scheduler.tick(wednesdayNoonRiyadh+7*86400000);
  assert.equal(wednesday.weeklyReport,undefined);
  assert.equal(listWeeklyReports(store.db).length,1);
 }finally{store.close();}
});

test('the pause gate stops every scheduled job, including the follow-up sweep',async()=>{
 const store=fixture();
 try{
  const runtime=createAgentRuntime({store,env,fetcher:fetcherFor(followupDecision)});
  const scheduler=createScheduler({store,agentRuntime:runtime,env});
  setPaused(store.db,true,user,'testing');
  assert.equal(isPaused(store.db),true);
  const result=await scheduler.tick(sundayAt8amRiyadh);
  assert.equal(result.skipped,'PAUSED');
  assert.equal(listRuns(store.db).length,0);
  setPaused(store.db,false,user);
  assert.equal(isPaused(store.db),false);
 }finally{store.close();}
});

test('sweepFollowupGaps triggers the followup agent exactly once per eligible lead lacking an active sequence',async()=>{
 const store=fixture();
 try{
  const runtime=createAgentRuntime({store,env,fetcher:fetcherFor(followupDecision)});
  const lead=createLead(store,{name:'Gym Riyadh',customerType:'B2B',sourceType:'INBOUND',company:'Gym Co',phone:'+966501112222'},user);
  updateLead(store,lead.id,{stage:'QUOTE_SENT',city:'Riyadh',productNeed:'cryo',reason:'quote sent to customer',expectedVersion:1,temperature:'WARM'},user);
  const first=await sweepFollowupGaps({store,agentRuntime:runtime});
  assert.equal(first.checked,1);
  assert.equal(first.triggered,1);
  assert.equal(listRuns(store.db,{agentId:'followup'}).length,1);
  // second sweep with still no active sequence created by the agent's own tool call: triggers again (no dedupe hides real gaps)
  const second=await sweepFollowupGaps({store,agentRuntime:runtime});
  assert.equal(second.triggered,1);

  // a lead that opted out must never be swept
  const optedOut=createLead(store,{name:'Opted Out',customerType:'B2C',sourceType:'INBOUND',phone:'+966501113333'},user);
  const staged=updateLead(store,optedOut.id,{stage:'QUOTE_SENT',reason:'quote sent',expectedVersion:1,temperature:'COLD'},user);
  contactControl(store,optedOut.id,{action:'OPT_OUT',expectedVersion:staged.version,evidence:'customer asked to stop'},user);
  const third=await sweepFollowupGaps({store,agentRuntime:runtime});
  assert.equal(third.checked,1); // only the still-eligible first lead, not the opted-out one
 }finally{store.close();}
});
