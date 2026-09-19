import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installKnowledge} from '../src/knowledge.js';
import {installCRM} from '../src/crm.js';
import {installPlanning} from '../src/planning.js';
import {installCompliance} from '../src/compliance.js';
import {installAutonomy,setAutonomy} from '../src/autonomy.js';
import {installReporting} from '../src/reporting.js';
import {installRegistry,seedRegistry,setEnabled} from '../src/runtime/registry.js';
import {installRuntimeTables,createAgentRuntime,listChildRuns} from '../src/runtime/runtime.js';
import {installEvents,createEventBus} from '../src/runtime/events.js';
import {installApprovals} from '../src/runtime/approvals.js';
import {installEscalations} from '../src/runtime/escalations.js';
import {installGate} from '../src/runtime/gate.js';
import {installCredentials} from '../src/runtime/credentials.js';
import {installContent} from '../src/content.js';
import {installAuditLog} from '../src/audit.js';
import {installContextItems} from '../src/runtime/context-items.js';
import {installSuggestions} from '../src/runtime/suggestions.js';
import {installCommandChat,createConversation,sendCommandMessage} from '../src/runtime/command-chat.js';
import {installTenantAgentConfigs} from '../src/runtime/agent-config.js';
import {installAgentToolAssignments} from '../src/runtime/tool-assignments.js';
import {installIntegrationConnections} from '../src/integrations/connections.js';

const user={id:'owner-id',name:'Owner',role:'owner'};
const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model'};

function fixture() {
 const store=openStore(':memory:');
 installKnowledge(store.db);installCRM(store.db);installPlanning(store.db);installCompliance(store.db);
 installAutonomy(store.db);installReporting(store.db);installRegistry(store.db);installRuntimeTables(store.db);
 installEvents(store.db);installApprovals(store.db);installEscalations(store.db);installGate(store.db);
 installCredentials(store.db);installContent(store.db);installAuditLog(store.db);
 installContextItems(store.db);installSuggestions(store.db);installCommandChat(store.db);
 installTenantAgentConfigs(store.db);installAgentToolAssignments(store.db);installIntegrationConnections(store.db);
 seedRegistry(store.db);
 return store;
}
const textTurn=(obj,stop='end_turn')=>({stop_reason:stop,content:[{type:'text',text:JSON.stringify(obj)}],usage:{input_tokens:5,output_tokens:5}});
const toolUseTurn=(name,input,id='call_1')=>({stop_reason:'tool_use',content:[{type:'tool_use',id,name,input}],usage:{input_tokens:5,output_tokens:5}});
const multiToolUseTurn=(calls)=>({stop_reason:'tool_use',content:calls.map((c,i)=>({type:'tool_use',id:`call_${i+1}`,name:c.name,input:c.input})),usage:{input_tokens:5,output_tokens:5}});
function sequencedFetcher(turns) {
 let i=0;
 return async()=>{const body=turns[Math.min(i,turns.length-1)];i++;return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});};
}
const commanderDecision=(over={})=>({status:'OK',action:'ANSWER',rationale:'Answered from real delegated results',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{answer:'الخطة جاهزة.',data_sources:['delegate_to_agent'],follow_up_suggestions:[],...over}});
const performanceDecision=(over={})=>({status:'OK',action:'ANALYZE',rationale:'أهم نقاط الأداء هذا الأسبوع',verification:[{field:'KPI_summary',source:'weekly_report',status:'VERIFIED'}],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{data_quality:'GOOD',KPI_summary:[],top_wins:[],top_issues:[],funnel_bottleneck:null,possible_drivers:[],stop_doing:[],double_down:[],experiments_next_week:[],data_gaps:[],...over}});
const intelligenceDecision=(over={})=>({status:'OK',action:'ANALYZE',rationale:'رصدنا تحركًا من منافس رئيسي',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{signals:[],...over}});

test('delegate_to_agent runs a real nested agent via the SAME runtime, sets parent_run_id, and returns a uniform structured result',async()=>{
 const store=fixture();
 try{
  const eventBus=createEventBus(store.db);
  const agentRuntime=createAgentRuntime({store,env,eventBus,fetcher:sequencedFetcher([
   toolUseTurn('delegate_to_agent',{agent:'performance',objective:'حلل أداء الأسبوع'}),
   textTurn(performanceDecision()),
   textTurn(commanderDecision())
  ])});
  const conversation=createConversation(store.db,user);
  const {run,assistantMessage}=await sendCommandMessage({store,agentRuntime,env,tenantId:conversation.tenantId,user,conversationId:conversation.id,text:'اعمل خطة نمو'});
  assert.equal(run.status,'COMPLETED',run.error);
  assert.equal(run.toolCalls.length,1);
  const delegateResult=run.toolCalls[0].output;
  assert.equal(delegateResult.agent,'performance');
  assert.equal(delegateResult.status,'COMPLETED');
  assert.equal(delegateResult.summary,'أهم نقاط الأداء هذا الأسبوع');
  assert.equal(delegateResult.evidence.length,1);
  assert.ok(delegateResult.artifacts.runId);
  assert.deepEqual(delegateResult.errors,[]);
  // Real parent/child trace (spec Part 47-48) — no fabricated tree, a genuine agent_runs row.
  const children=listChildRuns(store.db,run.id,conversation.tenantId);
  assert.equal(children.length,1);
  assert.equal(children[0].agent_id,'performance');
  assert.equal(children[0].status,'COMPLETED');
  assert.equal(children[0].trigger_type,'DELEGATED');
  assert.match(assistantMessage.meta.steps[0].label,/وكيل الأداء/);
  assert.equal(assistantMessage.meta.steps[0].delegatedAgent,'performance');
  // Contract the Command Center "who Frost is working with" diagram depends on
  // (public/pages/command-center.js's renderFrostActivity): the assistant message's own runId
  // must be the real top-level run, and its step's delegatedStatus must be a real terminal
  // status usable for the diagram's first paint with zero extra fetch.
  assert.equal(assistantMessage.runId,run.id);
  assert.equal(assistantMessage.meta.steps[0].delegatedStatus,'COMPLETED');
 }finally{store.close();}
});

test('two delegate_to_agent calls in the SAME model turn run in parallel and both produce real, independent child runs',async()=>{
 const store=fixture();
 try{
  const eventBus=createEventBus(store.db);
  const agentRuntime=createAgentRuntime({store,env,eventBus,fetcher:sequencedFetcher([
   multiToolUseTurn([
    {name:'delegate_to_agent',input:{agent:'performance',objective:'حلل الأداء'}},
    {name:'delegate_to_agent',input:{agent:'intelligence',objective:'حلل المنافسين'}}
   ]),
   textTurn(performanceDecision()),
   textTurn(intelligenceDecision()),
   textTurn(commanderDecision({data_sources:['delegate_to_agent:performance','delegate_to_agent:intelligence']}))
  ])});
  const conversation=createConversation(store.db,user);
  const {run}=await sendCommandMessage({store,agentRuntime,env,tenantId:conversation.tenantId,user,conversationId:conversation.id,text:'اعمل خطة نمو للشهر القادم'});
  assert.equal(run.status,'COMPLETED');
  assert.equal(run.toolCalls.length,2);
  const agents=run.toolCalls.map(tc=>tc.output.agent).sort();
  assert.deepEqual(agents,['intelligence','performance']);
  assert.ok(run.toolCalls.every(tc=>tc.output.status==='COMPLETED'),JSON.stringify(run.toolCalls.map(tc=>tc.output)));
  const children=listChildRuns(store.db,run.id,conversation.tenantId);
  assert.equal(children.length,2);
  assert.deepEqual(children.map(c=>c.agent_id).sort(),['intelligence','performance']);
  // Genuinely independent runs — different ids, both really persisted.
  assert.notEqual(children[0].id,children[1].id);
 }finally{store.close();}
});

test('delegating to a disabled agent is reported honestly (never a fabricated success) and still links to the parent run',async()=>{
 const store=fixture();
 try{
  setEnabled(store.db,'performance',false);
  const eventBus=createEventBus(store.db);
  const agentRuntime=createAgentRuntime({store,env,eventBus,fetcher:sequencedFetcher([
   toolUseTurn('delegate_to_agent',{agent:'performance',objective:'حلل الأداء'}),
   textTurn(commanderDecision({answer:'تعذر تحليل الأداء لأن الوكيل معطّل، لكن هذا ملخص جزئي.'}))
  ])});
  const conversation=createConversation(store.db,user);
  const {run}=await sendCommandMessage({store,agentRuntime,env,tenantId:conversation.tenantId,user,conversationId:conversation.id,text:'اعمل خطة نمو'});
  const delegateResult=run.toolCalls[0].output;
  assert.equal(delegateResult.status,'CANCELLED');
  assert.deepEqual(delegateResult.errors,['AGENT_DISABLED']);
  // The disabled child run is still linked to its parent — real traceability even on failure.
  const children=listChildRuns(store.db,run.id,conversation.tenantId);
  assert.equal(children.length,1);
  assert.equal(children[0].status,'CANCELLED');
  assert.equal(children[0].error,'AGENT_DISABLED');
 }finally{store.close();}
});

test('delegate_to_agent refuses an unsupported/unknown target agent without ever calling the runtime',async()=>{
 const store=fixture();
 try{
  const eventBus=createEventBus(store.db);
  const agentRuntime=createAgentRuntime({store,env,eventBus,fetcher:sequencedFetcher([
   toolUseTurn('delegate_to_agent',{agent:'sales',objective:'أرسل عرض سعر'}), // 'sales' can have real side effects — deliberately not in the delegate allowlist
   textTurn(commanderDecision())
  ])});
  const conversation=createConversation(store.db,user);
  const {run}=await sendCommandMessage({store,agentRuntime,env,tenantId:conversation.tenantId,user,conversationId:conversation.id,text:'فوّض لوكيل المبيعات'});
  assert.equal(run.toolCalls[0].output.status,'ERROR');
  assert.equal(run.toolCalls[0].output.error,'UNSUPPORTED_DELEGATE_AGENT');
  assert.equal(listChildRuns(store.db,run.id,conversation.tenantId).length,0);
 }finally{store.close();}
});

test('delegation never elevates the target agent above its own real configured level — a delegated tool call still respects the target agent permission gate',async()=>{
 const store=fixture();
 try{
  const eventBus=createEventBus(store.db);
  // performance stays at its real default L0; if its own turn tried to use a tool requiring a
  // higher level, the SAME canUseTool gate every other run already enforces would refuse it —
  // delegate_to_agent has no special override path for this, so this just re-confirms no such
  // path was added.
  const agentRuntime=createAgentRuntime({store,env,eventBus,fetcher:sequencedFetcher([
   toolUseTurn('delegate_to_agent',{agent:'performance',objective:'حلل الأداء'}),
   toolUseTurn('whatsapp_send',{leadId:'x',text:'hi'},'inner_call_1'),
   textTurn(performanceDecision()),
   textTurn(commanderDecision())
  ])});
  const conversation=createConversation(store.db,user);
  const {run}=await sendCommandMessage({store,agentRuntime,env,tenantId:conversation.tenantId,user,conversationId:conversation.id,text:'اعمل خطة نمو'});
  const children=listChildRuns(store.db,run.id,conversation.tenantId);
  assert.equal(children.length,1);
  const {listToolCalls}=await import('../src/runtime/runtime.js');
  const childToolCalls=listToolCalls(store.db,children[0].id);
  assert.equal(childToolCalls.length,1);
  assert.equal(childToolCalls[0].status,'FORBIDDEN'); // performance agent has no elevated level just because Frost delegated to it
 }finally{store.close();}
});
