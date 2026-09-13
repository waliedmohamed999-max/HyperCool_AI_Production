import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installKnowledge} from '../src/knowledge.js';
import {installCRM} from '../src/crm.js';
import {installPlanning} from '../src/planning.js';
import {installCompliance} from '../src/compliance.js';
import {installAutonomy,setAutonomy} from '../src/autonomy.js';
import {installReporting} from '../src/reporting.js';
import {installRegistry,seedRegistry} from '../src/runtime/registry.js';
import {installRuntimeTables,createAgentRuntime} from '../src/runtime/runtime.js';
import {installEvents,createEventBus} from '../src/runtime/events.js';
import {installApprovals,listApprovals,decideApproval} from '../src/runtime/approvals.js';
import {installEscalations} from '../src/runtime/escalations.js';
import {installGate} from '../src/runtime/gate.js';
import {installCredentials} from '../src/runtime/credentials.js';
import {installContent} from '../src/content.js';
import {installAuditLog} from '../src/audit.js';
import {installContextItems} from '../src/runtime/context-items.js';
import {installSuggestions} from '../src/runtime/suggestions.js';
import {installCommandChat,createConversation,listMessages,sendCommandMessage} from '../src/runtime/command-chat.js';
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
function sequencedFetcher(turns) {
 let i=0;
 return async()=>{const body=turns[Math.min(i,turns.length-1)];i++;return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});};
}
const commanderDecision=(over={})=>({status:'OK',action:'ANSWER',rationale:'Answered from real tool results',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{answer:'كل شيء تحت السيطرة.',data_sources:['get_company_health'],follow_up_suggestions:[],...over}});

test('a real chat message triggers exactly one frost_commander run, calls a real read tool, and stores a real assistant reply',async()=>{
 const store=fixture();
 try{
  const eventBus=createEventBus(store.db);
  const agentRuntime=createAgentRuntime({store,env,eventBus,fetcher:sequencedFetcher([toolUseTurn('get_company_health',{}),textTurn(commanderDecision())])});
  const conversation=createConversation(store.db,user);
  const {run,assistantMessage}=await sendCommandMessage({store,agentRuntime,env,tenantId:conversation.tenantId,user,conversationId:conversation.id,text:'اعرض حالة الشركة'});
  assert.equal(run.status,'COMPLETED');
  assert.equal(run.agent_id,'frost_commander');
  assert.equal(run.toolCalls.length,1);
  assert.equal(run.toolCalls[0].tool,'get_company_health');
  assert.equal(run.toolCalls[0].status,'OK');
  assert.equal(assistantMessage.content,'كل شيء تحت السيطرة.');
  assert.equal(assistantMessage.meta.steps.length,1);
  assert.equal(assistantMessage.meta.steps[0].label,'قراءة الحالة التشغيلية العامة');
  const messages=listMessages(store.db,conversation.id,conversation.tenantId);
  assert.equal(messages.length,2);
  assert.equal(messages[0].role,'user');
  assert.equal(messages[0].content,'اعرض حالة الشركة');
  assert.equal(messages[1].role,'assistant');
 }finally{store.close();}
});

test('with no AI provider configured, chat fails closed with an honest message — never a fabricated answer',async()=>{
 const store=fixture();
 try{
  const eventBus=createEventBus(store.db);
  const agentRuntime=createAgentRuntime({store,env:{},eventBus,fetcher:async()=>{throw new Error('must never call the network with no provider configured');}});
  const conversation=createConversation(store.db,user);
  const {run,assistantMessage}=await sendCommandMessage({store,agentRuntime,env:{},tenantId:conversation.tenantId,user,conversationId:conversation.id,text:'اعرض حالة الشركة'});
  assert.equal(run.status,'FAILED');
  assert.match(assistantMessage.content,/اتصال ذكاء اصطناعي/);
 }finally{store.close();}
});

test('a command requiring approval (run_followup_sweep) pauses for a real human decision — never auto-executes',async()=>{
 const store=fixture();
 try{
  const eventBus=createEventBus(store.db);
  const agentRuntime=createAgentRuntime({store,env,eventBus,fetcher:sequencedFetcher([toolUseTurn('run_followup_sweep',{}),textTurn(commanderDecision({answer:'أرسلت طلب المتابعة للموافقة.',data_sources:['run_followup_sweep']}))])});
  const conversation=createConversation(store.db,user);
  // frost_commander starts at L0 for every tenant like every other agent — must be explicitly
  // promoted to L1 (a real, audited, one-step owner action) before it can even attempt this
  // tool at all; requiresApprovalBelowLevel:'L2' then still pauses it for human approval.
  setAutonomy(store,'frost_commander',{level:'L1',reason:'test promotion',expectedVersion:0},user,env,conversation.tenantId);
  const {run,assistantMessage}=await sendCommandMessage({store,agentRuntime,env,tenantId:conversation.tenantId,user,conversationId:conversation.id,text:'شغّل متابعة العملاء المتأخرين'});
  assert.equal(run.toolCalls[0].status,'WAITING_APPROVAL');
  assert.match(assistantMessage.content,/بانتظار موافقتك/);
  assert.ok(assistantMessage.meta.pendingApprovalId);
  const pending=listApprovals(store.db,{status:'PENDING'},conversation.tenantId);
  assert.equal(pending.length,1);
  assert.equal(pending[0].action_type,'agent_tool_send');
  assert.equal(pending[0].agent_id,'frost_commander');
  // Approving it goes through the EXACT existing decide flow (never a second approval engine)
  // — resumeToolApproval re-invokes the real handler for real this time.
  const decided=decideApproval(store.db,pending[0].id,'APPROVED',user,conversation.tenantId);
  const toolResult=await agentRuntime.resumeToolApproval(decided);
  assert.notEqual(toolResult.status,'ERROR');
 }finally{store.close();}
});

test('conversations and messages are tenant-isolated: a wrong-tenant id 404s like every other tenant-scoped resource',async()=>{
 const store=fixture();
 try{
  const conversation=createConversation(store.db,user,'tenant-a');
  assert.throws(()=>listMessages(store.db,conversation.id,'tenant-b'),/غير موجودة/);
 }finally{store.close();}
});
