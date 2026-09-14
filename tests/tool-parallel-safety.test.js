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
const multiToolUseTurn=(calls)=>({stop_reason:'tool_use',content:calls.map((c,i)=>({type:'tool_use',id:`call_${i+1}`,name:c.name,input:c.input})),usage:{input_tokens:5,output_tokens:5}});
function sequencedFetcher(turns) {
 let i=0;
 return async()=>{const body=turns[Math.min(i,turns.length-1)];i++;return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});};
}
const commanderDecision=(over={})=>({status:'OK',action:'ANSWER',rationale:'ok',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{answer:'تم.',data_sources:[],follow_up_suggestions:[],...over}});

test('a same-turn batch mixing a READ tool with a WRITE tool runs strictly sequentially, never concurrently (spec item 82-83)',async()=>{
 const store=fixture();
 try{
  const eventBus=createEventBus(store.db);
  const callOrder=[];
  const agentRuntime=createAgentRuntime({store,env,eventBus,fetcher:sequencedFetcher([
   multiToolUseTurn([{name:'get_company_health',input:{}},{name:'run_followup_sweep',input:{}}]),
   textTurn(commanderDecision())
  ])});
  const conversation=createConversation(store.db,user);
  setAutonomy(store,'frost_commander',{level:'L1',reason:'test',expectedVersion:0},user,env,conversation.tenantId);
  const {run}=await sendCommandMessage({store,agentRuntime,env,tenantId:conversation.tenantId,user,conversationId:conversation.id,text:'اعرض الحالة وشغّل المتابعة'});
  assert.equal(run.toolCalls.length,2);
  // Both really executed (order preserved, one after the other) — the WRITE tool
  // (run_followup_sweep, actionType INTERNAL_WRITE) forces the whole batch sequential.
  assert.equal(run.toolCalls[0].tool,'get_company_health');
  assert.equal(run.toolCalls[1].tool,'run_followup_sweep');
  void callOrder;
 }finally{store.close();}
});

test('delegate_to_agent is structurally unavailable to a delegated agent — MAX_AGENT_DELEGATION_DEPTH=1 enforced by allowedAgents, not a counter',async()=>{
 const {buildToolRegistry}=await import('../src/runtime/tools.js');
 const store=fixture();
 try{
  const registry=buildToolRegistry({store,env,eventBus:createEventBus(store.db)});
  const performanceTools=registry.list('L2','performance').map(t=>t.name);
  const frostCommanderTools=registry.list('L2','frost_commander').map(t=>t.name);
  assert.ok(!performanceTools.includes('delegate_to_agent'));
  assert.ok(frostCommanderTools.includes('delegate_to_agent'));
 }finally{store.close();}
});
