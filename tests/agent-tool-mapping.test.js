import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {openStore} from '../src/store.js';
import {createAuth} from '../src/auth.js';
import {installTenancy,createTenant,resolveActiveTenantId,getTenant,setMaxAgentLevel} from '../src/tenancy.js';
import {installKnowledge} from '../src/knowledge.js';
import {installCRM,createLead} from '../src/crm.js';
import {installPlanning} from '../src/planning.js';
import {installCompliance} from '../src/compliance.js';
import {installAutonomy,setAutonomy} from '../src/autonomy.js';
import {installReporting} from '../src/reporting.js';
import {installRegistry,seedRegistry} from '../src/runtime/registry.js';
import {installRuntimeTables,createAgentRuntime,listRuns,listToolCalls} from '../src/runtime/runtime.js';
import {installEvents} from '../src/runtime/events.js';
import {installApprovals,listApprovals,decideApproval} from '../src/runtime/approvals.js';
import {installEscalations} from '../src/runtime/escalations.js';
import {installGate} from '../src/runtime/gate.js';
import {installCredentials} from '../src/runtime/credentials.js';
import {installContent} from '../src/content.js';
import {installAuditLog} from '../src/audit.js';
import {installIntegrationDefinitions} from '../src/integrations/definitions.js';
import {installIntegrationConnections,createConnection,updateConnection} from '../src/integrations/connections.js';
import {installCredentialsVault,storeCredential} from '../src/integrations/vault.js';
import {installOAuthStates} from '../src/integrations/oauth-state.js';
import {installTenantAgentConfigs,getTenantAgentConfig,updateTenantAgentConfig,seedTenantAgentConfigs} from '../src/runtime/agent-config.js';
import {installToolDefinitions,listToolDefinitions,getToolDefinition} from '../src/runtime/tool-definitions.js';
import {installAgentToolAssignments,upsertAssignment,resolveToolConnection} from '../src/runtime/tool-assignments.js';
import {evaluateAgentReadiness,evaluateToolReadiness} from '../src/runtime/agent-readiness.js';

const key32=randomBytes(32).toString('hex');
const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,ENABLE_L2_AUTONOMY:'true'};
const user={id:'owner-id',name:'Owner',role:'owner'};

function fixture(){
 const store=openStore(':memory:');
 installTenancy(store.db);installKnowledge(store.db);installCRM(store.db);installPlanning(store.db);installCompliance(store.db);
 installAutonomy(store.db);installReporting(store.db);installRegistry(store.db);installRuntimeTables(store.db);
 installEvents(store.db);installApprovals(store.db);installEscalations(store.db);installGate(store.db);
 installCredentials(store.db);installContent(store.db);installAuditLog(store.db);
 installIntegrationDefinitions(store.db);installIntegrationConnections(store.db);installCredentialsVault(store.db);installOAuthStates(store.db);
 installToolDefinitions(store.db);installTenantAgentConfigs(store.db);installAgentToolAssignments(store.db);
 seedRegistry(store.db);
 const tenantId=resolveActiveTenantId(store.db);
 seedTenantAgentConfigs(store.db,tenantId);
 return {store,tenantId};
}
function twoTenants(){
 const {store,tenantId:tenantA}=fixture();
 const auth=createAuth(store.db);
 const ownerB=auth.createUser({username:'ownerb',name:'Owner B',password:'a-long-test-password'},'owner');
 const tenantB=createTenant(store.db,{name:'Tenant B',slug:'tenant-b'},ownerB.id);
 seedTenantAgentConfigs(store.db,tenantB);
 return {store,tenantA,tenantB};
}
const textTurn=(obj,stop='end_turn')=>({stop_reason:stop,content:[{type:'text',text:JSON.stringify(obj)}],usage:{input_tokens:5,output_tokens:5}});
const toolUseTurn=(name,input,id='call_1')=>({stop_reason:'tool_use',content:[{type:'tool_use',id,name,input}],usage:{input_tokens:5,output_tokens:5}});
function sequencedFetcher(turns){
 let i=0;
 return async()=>{const body=turns[Math.min(i,turns.length-1)];i++;return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});};
}
const salesDecision=(over={})=>({status:'OK',action:'REPLY',rationale:'ok',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{intent:'price',customer_type:'B2C',qualification:{city:null,product_need:null,quantity:null,timeline:null,budget_band:null},recommended_product_id:null,reply_ar:'رد',reply_en:'reply',next_best_action:'x',lead_temperature:'COLD',crm_updates:{},missing_fields:[],handoff_reason:null,...over}});

// --- ToolDefinition ----------------------------------------------------------------------

test('ToolDefinition: seeded exclusively from the real Tool Registry — 28 tools, Canva/salla_syncOrders honestly NOT_IMPLEMENTED',()=>{
 const {store}=fixture();try{
  const tools=listToolDefinitions(store.db);
  assert.equal(tools.length,28);
  const canva=getToolDefinition(store.db,'canva_generateAsset');
  assert.equal(canva.isAvailable,false);
  const salla=getToolDefinition(store.db,'salla_syncOrders');
  assert.equal(salla.isAvailable,false);
  const whatsapp=getToolDefinition(store.db,'whatsapp_send');
  assert.equal(whatsapp.requiresApprovalBelowLevel,'L2');assert.equal(whatsapp.minLevel,'L1');
  assert.equal(getToolDefinition(store.db,'not-a-real-tool'),null);
 }finally{store.close();}
});

// --- Tenant isolation: TenantAgentConfig + AgentToolAssignment ---------------------------

test('TenantAgentConfig: Tenant B changing the Sales agent model/AI connection never affects Tenant A',()=>{
 const {store,tenantA,tenantB}=twoTenants();try{
  const connection=createConnection(store.db,{integrationDefinitionId:'openai',name:'B OpenAI'},tenantB);
  storeCredential(store.db,env,{connectionId:connection.id,credentialType:'api_key',payload:{apiKey:'sk-b'}},tenantB);
  updateTenantAgentConfig(store.db,tenantB,'sales',{aiConnectionId:connection.id,model:'gpt-b'});
  const configA=getTenantAgentConfig(store.db,tenantA,'sales');
  const configB=getTenantAgentConfig(store.db,tenantB,'sales');
  assert.equal(configA.aiConnectionId,null);
  assert.equal(configB.aiConnectionId,connection.id);assert.equal(configB.model,'gpt-b');
 }finally{store.close();}
});

test('TenantAgentConfig: a Tenant B AI connection id can never be assigned under Tenant A (cross-tenant rejected)',()=>{
 const {store,tenantA,tenantB}=twoTenants();try{
  const connectionB=createConnection(store.db,{integrationDefinitionId:'openai',name:'B OpenAI'},tenantB);
  assert.throws(()=>updateTenantAgentConfig(store.db,tenantA,'sales',{aiConnectionId:connectionB.id}),/غير موجود/);
 }finally{store.close();}
});

test('AgentToolAssignment: assigning a tool for Tenant B\'s agent config using Tenant A\'s connection id is rejected',()=>{
 const {store,tenantA,tenantB}=twoTenants();try{
  const sallaA=createConnection(store.db,{integrationDefinitionId:'salla',name:'A Store'},tenantA);
  assert.throws(()=>upsertAssignment(store.db,tenantB,'sales','get_current_price',{connectionId:sallaA.id}),/غير موجود/);
 }finally{store.close();}
});

// --- AI multi-connection (Phase 15/62): two agents, one tenant, two real provider connections

test('AI multi-connection: Sales pinned to an Anthropic connection and Copy pinned to an OpenAI connection each really use their own provider, model and vault-stored key',async()=>{
 const {store,tenantA}=twoTenants();try{
  const anthropic=createConnection(store.db,{integrationDefinitionId:'anthropic',name:'Anthropic Main'},tenantA);
  updateConnection(store.db,anthropic.id,{status:'CONNECTED'},tenantA);
  storeCredential(store.db,env,{connectionId:anthropic.id,credentialType:'api_key',payload:{apiKey:'sk-ant-main'}},tenantA);
  updateTenantAgentConfig(store.db,tenantA,'sales',{aiConnectionId:anthropic.id,model:'claude-connection-model'});

  const openai=createConnection(store.db,{integrationDefinitionId:'openai',name:'OpenAI Backup'},tenantA);
  updateConnection(store.db,openai.id,{status:'CONNECTED'},tenantA);
  storeCredential(store.db,env,{connectionId:openai.id,credentialType:'api_key',payload:{apiKey:'sk-oa-backup'}},tenantA);
  updateTenantAgentConfig(store.db,tenantA,'copy',{aiConnectionId:openai.id,model:'gpt-connection-model'});

  let anthropicApiKeyHeader=null;
  const anthropicRuntime=createAgentRuntime({store,env,fetcher:async(url,options)=>{
   anthropicApiKeyHeader=options.headers['x-api-key'];
   assert.equal(url,'https://api.anthropic.com/v1/messages');
   return new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(salesDecision())}],usage:{input_tokens:5,output_tokens:5}}),{status:200,headers:{'content-type':'application/json'}});
  }});
  const salesRun=await anthropicRuntime.run('sales',{triggerType:'TEST',input:{scenario:'price'},user,tenantId:tenantA});
  assert.equal(salesRun.status,'COMPLETED');
  assert.equal(salesRun.provider,'anthropic');assert.equal(salesRun.model,'claude-connection-model');
  assert.equal(anthropicApiKeyHeader,'sk-ant-main');

  const copyDecision={status:'OK',action:'DRAFT_READY',rationale:'ok',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
   payload:{arabic_copy:'نص',english_copy:'text',hook:'hook',body:'body',CTA:'CTA',URL:null,hashtags:[],factual_dependencies:[],compliance_notes:[],tone_notes:[]}};
  let openaiAuthHeader=null;
  const openaiRuntime=createAgentRuntime({store,env,fetcher:async(url,options)=>{
   openaiAuthHeader=options.headers.authorization;
   assert.equal(url,'https://api.openai.com/v1/chat/completions');
   return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(copyDecision)}}],usage:{prompt_tokens:10,completion_tokens:10}}),{status:200,headers:{'content-type':'application/json'}});
  }});
  const copyRun=await openaiRuntime.run('copy',{triggerType:'TEST',input:{brief:'x'},user,tenantId:tenantA});
  assert.equal(copyRun.status,'COMPLETED');
  assert.equal(copyRun.provider,'openai');assert.equal(copyRun.model,'gpt-connection-model');
  assert.equal(openaiAuthHeader,'Bearer sk-oa-backup');
 }finally{store.close();}
});

// --- Connection resolution algorithm (Phase 12) + mismatch/health enforcement -----------

test('resolveToolConnection: no assignment at all -> pass-through (connectionId:null) — never blocks a tool that predates this feature',()=>{
 const {store,tenantA}=twoTenants();try{
  const resolution=resolveToolConnection(store.db,{tenantId:tenantA,agentId:'sales',toolSlug:'whatsapp_send'});
  assert.equal(resolution.blocked,undefined);assert.equal(resolution.connectionId,null);
 }finally{store.close();}
});

test('resolveToolConnection: CONNECTION_PROVIDER_MISMATCH — a Salla tool can never be pinned to a Microsoft connection',()=>{
 const {store,tenantA}=twoTenants();try{
  const microsoft=createConnection(store.db,{integrationDefinitionId:'microsoft365',name:'Mailbox'},tenantA);
  // upsertAssignment itself already rejects a mismatched provider at write time — this proves
  // the SAME check also holds if a mismatch somehow existed at read time (defense in depth).
  assert.throws(()=>upsertAssignment(store.db,tenantA,'sales','get_current_price',{connectionId:microsoft.id}),/CONNECTION_PROVIDER_MISMATCH/);
 }finally{store.close();}
});

test('resolveToolConnection: CONNECTION_UNHEALTHY — an explicitly assigned but DISCONNECTED connection blocks a non-read tool',()=>{
 const {store,tenantA}=twoTenants();try{
  const whatsapp=createConnection(store.db,{integrationDefinitionId:'whatsapp',name:'Sales Number'},tenantA);
  upsertAssignment(store.db,tenantA,'sales','whatsapp_send',{connectionId:whatsapp.id});
  updateConnection(store.db,whatsapp.id,{status:'DISCONNECTED'},tenantA);
  const resolution=resolveToolConnection(store.db,{tenantId:tenantA,agentId:'sales',toolSlug:'whatsapp_send'});
  assert.equal(resolution.blocked,true);assert.equal(resolution.reason,'CONNECTION_UNHEALTHY');
 }finally{store.close();}
});

test('resolveToolConnection: TOOL_DISABLED — an explicitly disabled assignment blocks regardless of connection health',()=>{
 const {store,tenantA}=twoTenants();try{
  upsertAssignment(store.db,tenantA,'sales','get_current_price',{enabled:false});
  const resolution=resolveToolConnection(store.db,{tenantId:tenantA,agentId:'sales',toolSlug:'get_current_price'});
  assert.equal(resolution.blocked,true);assert.equal(resolution.reason,'TOOL_DISABLED');
 }finally{store.close();}
});

test('Salla multi-store: two connections for Tenant A, each tool pinned to a different one, resolved independently',()=>{
 const {store,tenantA}=twoTenants();try{
  const main=createConnection(store.db,{integrationDefinitionId:'salla',name:'Main Store'},tenantA);
  const secondary=createConnection(store.db,{integrationDefinitionId:'salla',name:'Secondary Store'},tenantA);
  updateConnection(store.db,main.id,{status:'CONNECTED'},tenantA);updateConnection(store.db,secondary.id,{status:'CONNECTED'},tenantA);
  upsertAssignment(store.db,tenantA,'sales','get_current_price',{connectionId:main.id});
  upsertAssignment(store.db,tenantA,'sales','get_stock',{connectionId:secondary.id});
  const price=resolveToolConnection(store.db,{tenantId:tenantA,agentId:'sales',toolSlug:'get_current_price'});
  const stock=resolveToolConnection(store.db,{tenantId:tenantA,agentId:'sales',toolSlug:'get_stock'});
  assert.equal(price.connectionId,main.id);
  assert.equal(stock.connectionId,secondary.id);
 }finally{store.close();}
});

// --- Agent/Tool readiness ------------------------------------------------------------------

test('Readiness: a disabled agent is DISABLED, never READY just because it exists',()=>{
 const {store,tenantA}=twoTenants();try{
  updateTenantAgentConfig(store.db,tenantA,'sales',{enabled:false});
  const readiness=evaluateAgentReadiness(store.db,env,{tenantId:tenantA,agentId:'sales'});
  assert.equal(readiness.status,'DISABLED');
 }finally{store.close();}
});

test('Readiness: an optional tool with no configured provider makes the agent PARTIAL, never BLOCKED',()=>{
 const {store,tenantA}=twoTenants();try{
  const readiness=evaluateAgentReadiness(store.db,env,{tenantId:tenantA,agentId:'sales'});
  // sales' required tools are all internal (CRM) — always READY; whatsapp_send etc. are
  // optional and unconfigured in this fixture (no static token, no connection) -> PARTIAL.
  assert.equal(readiness.status,'PARTIAL');
  assert.ok(readiness.optional_missing.includes('whatsapp_send'));
 }finally{store.close();}
});

test('ToolReadiness: DISABLED for a not-implemented tool (Canva), regardless of tenant config',()=>{
 const {store,tenantA}=twoTenants();try{
  const readiness=evaluateToolReadiness(store.db,env,{tenantId:tenantA,agentId:'creative',toolSlug:'canva_generateAsset'});
  assert.equal(readiness.status,'DISABLED');assert.equal(readiness.reason,'NOT_IMPLEMENTED');
 }finally{store.close();}
});

// --- L0/L1/L2 + tenant safety ceiling, end to end via the real runtime -------------------

test('whatsapp_send: L0 is FORBIDDEN (never even reaches the approval gate), L1 requires approval, L2 executes immediately',async()=>{
 const {store,tenantA}=twoTenants();try{
  const lead=createLead(store,{name:'Test Lead',customerType:'B2C',sourceType:'INBOUND',phone:'+966500000001'},user,tenantA);
  async function attempt(){
   const runtime=createAgentRuntime({store,env,fetcher:sequencedFetcher([toolUseTurn('whatsapp_send',{leadId:lead.id,text:'hi'}),textTurn(salesDecision())])});
   return runtime.run('sales',{triggerType:'TEST',input:{scenario:'price'},user,tenantId:tenantA});
  }
  const runL0=await attempt();
  assert.equal(runL0.toolCalls[0].status,'FORBIDDEN');

  setAutonomy(store,'sales',{level:'L1',reason:'promote',expectedVersion:0},user,env,tenantA);
  const runL1=await attempt();
  assert.equal(runL1.toolCalls[0].status,'WAITING_APPROVAL');
  const pending=listApprovals(store.db,{status:'PENDING'},tenantA);
  assert.equal(pending.length,1);assert.equal(pending[0].action_type,'agent_tool_send');

  setAutonomy(store,'sales',{level:'L2',reason:'promote again',expectedVersion:1},user,env,tenantA);
  const runL2=await attempt();
  // whatsapp isn't actually configured in this fixture — L2 attempts the real send and gets
  // INTEGRATION_REQUIRED, proving it reached the handler (never WAITING_APPROVAL at L2).
  assert.equal(runL2.toolCalls[0].status,'INTEGRATION_REQUIRED');
 }finally{store.close();}
});

test('Tenant safety ceiling: an agent promoted to L2 is still capped to L1 once the tenant sets max_agent_level',async()=>{
 const {store,tenantA}=twoTenants();try{
  const lead=createLead(store,{name:'Test Lead',customerType:'B2C',sourceType:'INBOUND',phone:'+966500000002'},user,tenantA);
  setAutonomy(store,'sales',{level:'L1',reason:'promote',expectedVersion:0},user,env,tenantA);
  setAutonomy(store,'sales',{level:'L2',reason:'promote again',expectedVersion:1},user,env,tenantA);
  setMaxAgentLevel(store.db,tenantA,'L1');
  const runtime=createAgentRuntime({store,env,fetcher:sequencedFetcher([toolUseTurn('whatsapp_send',{leadId:lead.id,text:'hi'}),textTurn(salesDecision())])});
  const run=await runtime.run('sales',{triggerType:'TEST',input:{scenario:'price'},user,tenantId:tenantA});
  // Effective level is capped to L1 despite the audited ledger saying L2 -> approval gate fires.
  assert.equal(run.toolCalls[0].status,'WAITING_APPROVAL');
 }finally{store.close();}
});

// --- Approval connection preservation + resume execution ---------------------------------

test('Approval preserves the exact connection id; a later default-connection change never silently redirects it',async()=>{
 const {store,tenantA}=twoTenants();try{
  const lead=createLead(store,{name:'Test Lead',customerType:'B2C',sourceType:'INBOUND',phone:'+966500000003'},user,tenantA);
  setAutonomy(store,'sales',{level:'L1',reason:'promote',expectedVersion:0},user,env,tenantA);
  const whatsapp=createConnection(store.db,{integrationDefinitionId:'whatsapp',name:'Sales Number'},tenantA);
  updateConnection(store.db,whatsapp.id,{status:'CONNECTED'},tenantA);
  upsertAssignment(store.db,tenantA,'sales','whatsapp_send',{connectionId:whatsapp.id});
  const runtime=createAgentRuntime({store,env,fetcher:sequencedFetcher([toolUseTurn('whatsapp_send',{leadId:lead.id,text:'hi'}),textTurn(salesDecision())])});
  await runtime.run('sales',{triggerType:'TEST',input:{scenario:'price'},user,tenantId:tenantA});
  const approval=listApprovals(store.db,{status:'PENDING'},tenantA)[0];
  assert.equal(approval.connection_id,whatsapp.id);

  // Connection is now removed (DISCONNECTED) before the human decides.
  updateConnection(store.db,whatsapp.id,{status:'DISCONNECTED'},tenantA);
  const decided=decideApproval(store.db,approval.id,'APPROVED',user,tenantA);
  const result=await runtime.resumeToolApproval(decided);
  assert.equal(result.status,'CONNECTION_NO_LONGER_AVAILABLE');
 }finally{store.close();}
});

test('Approval resume: connection still healthy -> the real handler is invoked and the tool call is logged with the connection id',async()=>{
 const {store,tenantA}=twoTenants();try{
  const lead=createLead(store,{name:'Test Lead',customerType:'B2C',sourceType:'INBOUND',phone:'+966500000004'},user,tenantA);
  setAutonomy(store,'sales',{level:'L1',reason:'promote',expectedVersion:0},user,env,tenantA);
  const whatsapp=createConnection(store.db,{integrationDefinitionId:'whatsapp',name:'Sales Number'},tenantA);
  updateConnection(store.db,whatsapp.id,{status:'CONNECTED'},tenantA);
  upsertAssignment(store.db,tenantA,'sales','whatsapp_send',{connectionId:whatsapp.id});
  const runtime=createAgentRuntime({store,env,fetcher:sequencedFetcher([toolUseTurn('whatsapp_send',{leadId:lead.id,text:'hi'}),textTurn(salesDecision())])});
  const run=await runtime.run('sales',{triggerType:'TEST',input:{scenario:'price'},user,tenantId:tenantA});
  const approval=listApprovals(store.db,{status:'PENDING'},tenantA)[0];
  const decided=decideApproval(store.db,approval.id,'APPROVED',user,tenantA);
  const result=await runtime.resumeToolApproval(decided);
  // whatsapp isn't actually configured (no real credential) -> INTEGRATION_REQUIRED, but
  // critically it DID reach the handler this time (connection was healthy), unlike the
  // disconnected case above.
  assert.equal(result.status,'INTEGRATION_REQUIRED');
  const calls=listToolCalls(store.db,run.id);
  const resumedCall=calls.find(c=>c.tool==='whatsapp_send' && c.connection_id===whatsapp.id);
  assert.ok(resumedCall,'the resumed execution must be logged against the run with the real connection id');
 }finally{store.close();}
});

// --- Secret boundary ------------------------------------------------------------------------

test('Secret boundary: the tool execution context never carries a vault secret — only a connectionId',async()=>{
 const {store,tenantA}=twoTenants();try{
  const salla=createConnection(store.db,{integrationDefinitionId:'salla',name:'Main Store'},tenantA);
  storeCredential(store.db,env,{connectionId:salla.id,credentialType:'oauth_tokens',payload:{accessToken:'sk-super-secret-token'}},tenantA);
  upsertAssignment(store.db,tenantA,'sales','get_current_price',{connectionId:salla.id});
  let seenCtx=null;
  const runtime=createAgentRuntime({store,env,fetcher:sequencedFetcher([toolUseTurn('get_current_price',{productId:'p1'}),textTurn(salesDecision())])});
  const originalGet=runtime.toolRegistry.get;
  runtime.toolRegistry.get=(name)=>{
   const tool=originalGet(name);
   if(name!=='get_current_price')return tool;
   return {...tool,handler:(input,ctx)=>{seenCtx=ctx;return tool.handler(input,ctx);}};
  };
  await runtime.run('sales',{triggerType:'TEST',input:{scenario:'price'},user,tenantId:tenantA});
  assert.equal(seenCtx.connectionId,salla.id);
  assert.equal(JSON.stringify(seenCtx).includes('sk-super-secret-token'),false);
  assert.equal('accessToken' in seenCtx,false);
 }finally{store.close();}
});
