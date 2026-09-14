import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installKnowledge} from '../src/knowledge.js';
import {installCRM,createLead} from '../src/crm.js';
import {installPlanning} from '../src/planning.js';
import {installCompliance} from '../src/compliance.js';
import {installAutonomy,setAutonomy} from '../src/autonomy.js';
import {installReporting} from '../src/reporting.js';
import {installRegistry,seedRegistry,setEnabled} from '../src/runtime/registry.js';
import {installRuntimeTables,createAgentRuntime} from '../src/runtime/runtime.js';
import {installEvents,createEventBus} from '../src/runtime/events.js';
import {installApprovals,listApprovals,decideApproval} from '../src/runtime/approvals.js';
import {installEscalations,listEscalations} from '../src/runtime/escalations.js';
import {installGate} from '../src/runtime/gate.js';
import {installCredentials} from '../src/runtime/credentials.js';
import {installContent} from '../src/content.js';
import {installAuditLog} from '../src/audit.js';
import {installContextItems} from '../src/runtime/context-items.js';
import {installTenantAgentConfigs} from '../src/runtime/agent-config.js';
import {installAgentToolAssignments} from '../src/runtime/tool-assignments.js';
import {installIntegrationConnections} from '../src/integrations/connections.js';
import {installTenancy,createTenant} from '../src/tenancy.js';
import {
 installWorkflowEngine,createWorkflowDraft,updateWorkflowDraft,activateWorkflow,getWorkflowWithVersion,
 validateWorkflowSteps,startWorkflowRun,advanceWorkflowRun,requestCancelWorkflowRun,resumeWorkflowApproval,
 tickWorkflowsForTenant,installWorkflowEventTriggers,getRunWithSteps,listWorkflows,pauseWorkflow
} from '../src/runtime/workflow-engine.js';
import {buildToolRegistry} from '../src/runtime/tools.js';

const user={id:'owner-id',name:'Owner',role:'owner'};
const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model'};

function fixture() {
 const store=openStore(':memory:');
 installKnowledge(store.db);installCRM(store.db);installPlanning(store.db);installCompliance(store.db);
 installAutonomy(store.db);installReporting(store.db);installRegistry(store.db);installRuntimeTables(store.db);
 installEvents(store.db);installApprovals(store.db);installEscalations(store.db);installGate(store.db);
 installCredentials(store.db);installContent(store.db);installAuditLog(store.db);
 installContextItems(store.db);installTenantAgentConfigs(store.db);installAgentToolAssignments(store.db);
 installIntegrationConnections(store.db);installWorkflowEngine(store.db);
 seedRegistry(store.db);
 return store;
}
const textTurn=(obj,stop='end_turn')=>({stop_reason:stop,content:[{type:'text',text:JSON.stringify(obj)}],usage:{input_tokens:5,output_tokens:5}});
function sequencedFetcher(turns) {
 let i=0;
 return async()=>{const body=turns[Math.min(i,turns.length-1)];i++;return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});};
}
const performanceDecision=(over={})=>({status:'OK',action:'ANALYZE',rationale:'تحليل جيد',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{data_quality:'GOOD',KPI_summary:[],top_wins:[],top_issues:[],funnel_bottleneck:null,possible_drivers:[],stop_doing:[],double_down:[],experiments_next_week:[],data_gaps:[],...over}});
const intelligenceDecision=(over={})=>({status:'OK',action:'ANALYZE',rationale:'رصد جيد',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],payload:{signals:[],...over}});

function makeDeps(store,fetcher) {
 const eventBus=createEventBus(store.db);
 const agentRuntime=createAgentRuntime({store,env,eventBus,fetcher});
 return {store,env,fetcher,agentRuntime,toolRegistry:agentRuntime.toolRegistry,eventBus};
}
function makeTenant(store,name='Tenant') {
 installTenancy(store.db);
 return createTenant(store.db,{name,slug:name.toLowerCase().replace(/\s+/g,'-')+'-'+Math.random().toString(36).slice(2,7)});
}

test('DAG validation: rejects cycles, multiple roots, unknown next targets, and step-count/fan-out limits',()=>{
 const cyclic=[{id:'a',type:'AGENT',agentId:'performance',objective:'x',next:['b']},{id:'b',type:'AGENT',agentId:'performance',objective:'x',next:['a']}];
 assert.ok(validateWorkflowSteps(cyclic,env).some(e=>e.includes('دائري')));
 const multiRoot=[{id:'a',type:'AGENT',agentId:'performance',objective:'x',next:[]},{id:'b',type:'AGENT',agentId:'performance',objective:'x',next:[]}];
 assert.ok(validateWorkflowSteps(multiRoot,env).some(e=>e.includes('نقطة بداية')));
 const unknownNext=[{id:'a',type:'AGENT',agentId:'performance',objective:'x',next:['ghost']}];
 assert.ok(validateWorkflowSteps(unknownNext,env).some(e=>e.includes('غير موجودة')));
 const tooMany=Array.from({length:31},(_,i)=>({id:'s'+i,type:'CREATE_TASK',reason:'x',next:i<30?['s'+(i+1)]:[]}));
 assert.ok(validateWorkflowSteps(tooMany,env).some(e=>e.includes('الحد الأقصى')));
});

test('a linear manual workflow (AGENT -> CREATE_TASK) runs to completion end to end',async()=>{
 const store=fixture();
 try{
  const tenantId=makeTenant(store);
  const deps=makeDeps(store,sequencedFetcher([textTurn(performanceDecision())]));
  const draft=createWorkflowDraft(store.db,env,tenantId,{
   nameAr:'مراجعة أداء ثم مهمة',trigger:{type:'MANUAL'},
   steps:[
    {id:'analyze',type:'AGENT',agentId:'performance',objective:'حلل الأداء',next:['task']},
    {id:'task',type:'CREATE_TASK',reason:'تابع النتائج',priority:'P2',next:[]}
   ]
  },user);
  assert.equal(draft.status,'DRAFT');
  const activated=activateWorkflow(store.db,env,draft.id,user,tenantId);
  assert.equal(activated.status,'ACTIVE');
  const run=await startWorkflowRun(deps,draft.id,{triggerType:'MANUAL',tenantId});
  assert.equal(run.status,'COMPLETED');
  assert.equal(run.steps.length,2);
  assert.ok(run.steps.every(s=>s.status==='COMPLETED'));
  assert.equal(listEscalations(store.db,{status:'OPEN'},tenantId).length,1);
 }finally{store.close();}
});

test('activation is refused with an exact reason when a dependency (disabled agent) is missing',()=>{
 const store=fixture();
 try{
  const tenantId=makeTenant(store);
  setEnabled(store.db,'performance',false);
  const draft=createWorkflowDraft(store.db,env,tenantId,{nameAr:'x',trigger:{type:'MANUAL'},
   steps:[{id:'a',type:'AGENT',agentId:'performance',objective:'x',next:[]}]},user);
  assert.throws(()=>activateWorkflow(store.db,env,draft.id,user,tenantId),/معطّل/);
 }finally{store.close();}
});

test('a CONDITION step branches correctly: the false path is SKIPPED, the true path runs',async()=>{
 const store=fixture();
 try{
  const tenantId=makeTenant(store);
  const deps=makeDeps(store,sequencedFetcher([]));
  const draft=createWorkflowDraft(store.db,env,tenantId,{nameAr:'شرط',trigger:{type:'MANUAL'},
   steps:[
    {id:'check',type:'CONDITION',condition:{field:'trigger.value',op:'greater_than',value:100},next:['high'],elseNext:['low']},
    {id:'high',type:'CREATE_TASK',reason:'قيمة عالية',priority:'P1',next:[]},
    {id:'low',type:'CREATE_TASK',reason:'قيمة منخفضة',priority:'P3',next:[]}
   ]},user);
  activateWorkflow(store.db,env,draft.id,user,tenantId);
  const run=await startWorkflowRun(deps,draft.id,{triggerType:'MANUAL',triggerContext:{value:500},tenantId});
  assert.equal(run.status,'COMPLETED');
  const highStep=run.steps.find(s=>s.stepId==='high'),lowStep=run.steps.find(s=>s.stepId==='low');
  assert.equal(highStep.status,'COMPLETED');
  assert.equal(lowStep.status,'SKIPPED');
  assert.equal(listEscalations(store.db,{status:'OPEN'},tenantId).length,1);
 }finally{store.close();}
});

test('a DELAY step pauses the run without sleeping the process; the scheduler tick resumes it once due, not before',async()=>{
 const store=fixture();
 try{
  const tenantId=makeTenant(store);
  const deps=makeDeps(store,sequencedFetcher([]));
  const draft=createWorkflowDraft(store.db,env,tenantId,{nameAr:'تأخير',trigger:{type:'MANUAL'},
   steps:[{id:'wait',type:'DELAY',durationMinutes:60,next:['task']},{id:'task',type:'CREATE_TASK',reason:'بعد الانتظار',priority:'P3',next:[]}]},user);
  activateWorkflow(store.db,env,draft.id,user,tenantId);
  const run=await startWorkflowRun(deps,draft.id,{triggerType:'MANUAL',tenantId});
  assert.equal(run.status,'WAITING');
  assert.ok(run.nextResumeAt);
  const tooEarly=await tickWorkflowsForTenant(deps,tenantId,Date.now());
  assert.equal(tooEarly.resumed,0);
  const stillWaiting=getRunWithSteps(store.db,run.id,tenantId);
  assert.equal(stillWaiting.status,'WAITING');
  const later=await tickWorkflowsForTenant(deps,tenantId,Date.now()+61*60000);
  assert.equal(later.resumed,1);
  const finished=getRunWithSteps(store.db,run.id,tenantId);
  assert.equal(finished.status,'COMPLETED');
 }finally{store.close();}
});

test('an APPROVAL step pauses WAITING_APPROVAL and resumes through the real, existing Approval Engine — REJECTED stops the run honestly',async()=>{
 const store=fixture();
 try{
  const tenantId=makeTenant(store);
  const deps=makeDeps(store,sequencedFetcher([]));
  const draft=createWorkflowDraft(store.db,env,tenantId,{nameAr:'موافقة',trigger:{type:'MANUAL'},
   steps:[{id:'approve',type:'APPROVAL',reason:'يحتاج موافقة',next:['task']},{id:'task',type:'CREATE_TASK',reason:'بعد الموافقة',priority:'P2',next:[]}]},user);
  activateWorkflow(store.db,env,draft.id,user,tenantId);
  const run=await startWorkflowRun(deps,draft.id,{triggerType:'MANUAL',tenantId});
  assert.equal(run.status,'WAITING_APPROVAL');
  const pending=listApprovals(store.db,{status:'PENDING'},tenantId);
  assert.equal(pending.length,1);
  assert.equal(pending[0].action_type,'workflow_step_approval');
  const decided=decideApproval(store.db,pending[0].id,'APPROVED',user,tenantId);
  const resumed=await resumeWorkflowApproval(deps,decided);
  assert.equal(resumed.status,'COMPLETED');

  // Second run: REJECTED stops the run as FAILED, never silently guessing a branch.
  const run2=await startWorkflowRun(deps,draft.id,{triggerType:'MANUAL',tenantId});
  const pending2=listApprovals(store.db,{status:'PENDING'},tenantId);
  const decided2=decideApproval(store.db,pending2[0].id,'REJECTED',user,tenantId);
  const resumed2=await resumeWorkflowApproval(deps,decided2);
  assert.equal(resumed2.status,'FAILED');
  void run2;
 }finally{store.close();}
});

test('two parallel AGENT steps both complete before the join step runs (real AND-join)',async()=>{
 const store=fixture();
 try{
  const tenantId=makeTenant(store);
  const deps=makeDeps(store,sequencedFetcher([textTurn(performanceDecision()),textTurn(intelligenceDecision())]));
  const draft=createWorkflowDraft(store.db,env,tenantId,{nameAr:'تفرع ثم دمج',trigger:{type:'MANUAL'},
   steps:[
    {id:'start',type:'CREATE_TASK',reason:'بداية',priority:'P4',next:['perf','intel']},
    {id:'perf',type:'AGENT',agentId:'performance',objective:'حلل الأداء',next:['join']},
    {id:'intel',type:'AGENT',agentId:'intelligence',objective:'حلل السوق',next:['join']},
    {id:'join',type:'CREATE_TASK',reason:'دمج النتائج',priority:'P2',next:[]}
   ]},user);
  activateWorkflow(store.db,env,draft.id,user,tenantId);
  const run=await startWorkflowRun(deps,draft.id,{triggerType:'MANUAL',tenantId});
  assert.equal(run.status,'COMPLETED');
  assert.ok(run.steps.every(s=>s.status==='COMPLETED'));
  assert.equal(listEscalations(store.db,{status:'OPEN'},tenantId).length,2);
 }finally{store.close();}
});

test('cancellation: a WAITING delay cancels immediately; no later step ever runs',async()=>{
 const store=fixture();
 try{
  const tenantId=makeTenant(store);
  const deps=makeDeps(store,sequencedFetcher([]));
  const draft=createWorkflowDraft(store.db,env,tenantId,{nameAr:'إلغاء أثناء الانتظار',trigger:{type:'MANUAL'},
   steps:[{id:'wait',type:'DELAY',durationMinutes:120,next:['task']},{id:'task',type:'CREATE_TASK',reason:'لا يجب أن يعمل',priority:'P3',next:[]}]},user);
  activateWorkflow(store.db,env,draft.id,user,tenantId);
  const run=await startWorkflowRun(deps,draft.id,{triggerType:'MANUAL',tenantId});
  assert.equal(run.status,'WAITING');
  const cancelled=requestCancelWorkflowRun(store.db,run.id,user,tenantId);
  assert.equal(cancelled.status,'CANCELLED');
  await tickWorkflowsForTenant(deps,tenantId,Date.now()+200*60000);
  const finalState=getRunWithSteps(store.db,run.id,tenantId);
  assert.equal(finalState.status,'CANCELLED');
  assert.equal(finalState.steps.find(s=>s.stepId==='task').status,'CANCELLED');
  assert.equal(listEscalations(store.db,{status:'OPEN'},tenantId).length,0);
 }finally{store.close();}
});

test('versioning: editing an ACTIVE workflow creates a new draft version; an in-flight run stays pinned to the version it started with',async()=>{
 const store=fixture();
 try{
  const tenantId=makeTenant(store);
  const deps=makeDeps(store,sequencedFetcher([]));
  const draft=createWorkflowDraft(store.db,env,tenantId,{nameAr:'إصدار 1',trigger:{type:'MANUAL'},
   steps:[{id:'wait',type:'DELAY',durationMinutes:30,next:[]}]},user);
  activateWorkflow(store.db,env,draft.id,user,tenantId);
  const runV1=await startWorkflowRun(deps,draft.id,{triggerType:'MANUAL',tenantId});
  const pinnedVersionId=store.db.prepare('SELECT workflow_version_id FROM workflow_runs WHERE id=?').get(runV1.id).workflow_version_id;

  const edited=updateWorkflowDraft(store.db,env,draft.id,{nameAr:'إصدار 2',trigger:{type:'MANUAL'},
   steps:[{id:'wait',type:'DELAY',durationMinutes:999,next:[]}]},user,tenantId);
  assert.equal(edited.status,'ACTIVE'); // still active — editing doesn't touch the live version
  assert.equal(edited.version.status,'DRAFT');
  assert.equal(edited.version.version,2);
  assert.notEqual(edited.version.id,pinnedVersionId);

  const stillPinned=store.db.prepare('SELECT workflow_version_id FROM workflow_runs WHERE id=?').get(runV1.id).workflow_version_id;
  assert.equal(stillPinned,pinnedVersionId); // no version drift
 }finally{store.close();}
});

test('workflows and runs are tenant-isolated — a cross-tenant activate/run/read is refused',async()=>{
 const store=fixture();
 try{
  const tenantA=makeTenant(store,'A'),tenantB=makeTenant(store,'B');
  const draft=createWorkflowDraft(store.db,env,tenantA,{nameAr:'x',trigger:{type:'MANUAL'},steps:[{id:'a',type:'CREATE_TASK',reason:'x',next:[]}]},user);
  assert.throws(()=>activateWorkflow(store.db,env,draft.id,user,tenantB),/غير موجود/);
  assert.equal(listWorkflows(store.db,tenantB).length,0);
 }finally{store.close();}
});

test('an EVENT-triggered workflow fires from the real, existing Event Bus — LEAD_CREATED — with no new event system',async()=>{
 const store=fixture();
 try{
  const tenantId=makeTenant(store);
  const deps=makeDeps(store,sequencedFetcher([]));
  installWorkflowEventTriggers(deps.eventBus,deps);
  const draft=createWorkflowDraft(store.db,env,tenantId,{nameAr:'عند عميل جديد',trigger:{type:'EVENT',eventType:'LEAD_CREATED'},
   steps:[{id:'task',type:'CREATE_TASK',reason:'عميل جديد وصل',priority:'P3',next:[]}]},user);
  activateWorkflow(store.db,env,draft.id,user,tenantId);
  deps.eventBus.emit('LEAD_CREATED',{leadId:'lead-1',tenantId});
  await new Promise(resolve=>setTimeout(resolve,50)); // eventBus handlers are async (see events.js's on())
  const runs=store.db.prepare('SELECT * FROM workflow_runs WHERE workflow_id=?').all(draft.id);
  assert.equal(runs.length,1);
  assert.equal(runs[0].trigger_type,'EVENT');
  assert.equal(listEscalations(store.db,{status:'OPEN'},tenantId).length,1);
 }finally{store.close();}
});

test('loop protection: a causation depth beyond MAX_AUTOMATION_DEPTH is refused and audited, never silently dropped',async()=>{
 const store=fixture();
 try{
  const tenantId=makeTenant(store);
  const deps=makeDeps(store,sequencedFetcher([]));
  const draft=createWorkflowDraft(store.db,env,tenantId,{nameAr:'x',trigger:{type:'MANUAL'},steps:[{id:'a',type:'CREATE_TASK',reason:'x',next:[]}]},user);
  activateWorkflow(store.db,env,draft.id,user,tenantId);
  await assert.rejects(()=>startWorkflowRun(deps,draft.id,{triggerType:'EVENT',causationDepth:99,tenantId}),/عمق الأتمتة/);
  const auditRow=store.db.prepare("SELECT * FROM audit_logs WHERE action='WORKFLOW_LOOP_PROTECTION_TRIGGERED'").get();
  assert.ok(auditRow);
 }finally{store.close();}
});

test('a scheduled DAILY workflow fires once per day, not once per scheduler tick',async()=>{
 const store=fixture();
 try{
  const tenantId=makeTenant(store);
  const deps=makeDeps(store,sequencedFetcher([]));
  const draft=createWorkflowDraft(store.db,env,tenantId,{nameAr:'يومي',trigger:{type:'SCHEDULE',schedule:{frequency:'DAILY',hour:10}},
   steps:[{id:'a',type:'CREATE_TASK',reason:'مهمة يومية',priority:'P4',next:[]}]},user);
  activateWorkflow(store.db,env,draft.id,user,tenantId);
  const tenAmUtc=Date.UTC(2026,0,5,7,0,0); // 10:00 Riyadh = 07:00 UTC
  const first=await tickWorkflowsForTenant(deps,tenantId,tenAmUtc);
  assert.equal(first.started,1);
  const second=await tickWorkflowsForTenant(deps,tenantId,tenAmUtc+5*60000); // 5 min later, same day/hour
  assert.equal(second.started,0);
 }finally{store.close();}
});

test('pausing a workflow stops it from being started manually or by schedule',async()=>{
 const store=fixture();
 try{
  const tenantId=makeTenant(store);
  const deps=makeDeps(store,sequencedFetcher([]));
  const draft=createWorkflowDraft(store.db,env,tenantId,{nameAr:'x',trigger:{type:'MANUAL'},steps:[{id:'a',type:'CREATE_TASK',reason:'x',next:[]}]},user);
  activateWorkflow(store.db,env,draft.id,user,tenantId);
  pauseWorkflow(store.db,draft.id,user,tenantId);
  await assert.rejects(()=>startWorkflowRun(deps,draft.id,{triggerType:'MANUAL',tenantId}),/ليس نشطًا/);
 }finally{store.close();}
});
