import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installKnowledge,saveMemory,replaceProducts} from '../src/knowledge.js';
import {installCRM} from '../src/crm.js';
import {installPlanning} from '../src/planning.js';
import {installCompliance} from '../src/compliance.js';
import {installAutonomy} from '../src/autonomy.js';
import {installReporting} from '../src/reporting.js';
import {installRegistry,seedRegistry,getAgent,setModelConfig} from '../src/runtime/registry.js';
import {installRuntimeTables,createAgentRuntime,promptVersion} from '../src/runtime/runtime.js';
import {installEvents} from '../src/runtime/events.js';
import {installApprovals} from '../src/runtime/approvals.js';
import {installEscalations} from '../src/runtime/escalations.js';
import {installGate} from '../src/runtime/gate.js';
import {createLLMProvider,providerStatus,estimateCost} from '../src/runtime/llmProvider.js';
import {normalizeSallaProduct} from '../src/connectors.js';

const user={id:'owner-id',name:'Owner',role:'owner'};
const anthropicEnv={ANTHROPIC_API_KEY:'a-secret',ANTHROPIC_MODEL:'claude-test'};
const openaiEnv={OPENAI_API_KEY:'o-secret',OPENAI_DEFAULT_MODEL:'gpt-test'};

function fixture(){
 const store=openStore(':memory:');
 installKnowledge(store.db);installCRM(store.db);installPlanning(store.db);installCompliance(store.db);
 installAutonomy(store.db);installReporting(store.db);installRegistry(store.db);installRuntimeTables(store.db);
 installEvents(store.db);installApprovals(store.db);installEscalations(store.db);installGate(store.db);
 seedRegistry(store.db);
 replaceProducts(store.db,[normalizeSallaProduct({id:1,name:'Cryo chamber',urls:{customer:'https://hyper-cool.com/p/1'},taxed_price:{amount:100,currency:'SAR'},quantity:5,is_available:true,status:'sale'},new Date().toISOString())]);
 saveMemory(store.db,{key:'voice',kind:'brand_voice',value:'Clear',source:'Guide',changeReason:'init',status:'APPROVED',expectedVersion:0},user);
 return store;
}
const salesDecision=(over={})=>({status:'OK',action:'REPLY',rationale:'Answered with verified product data',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{intent:'price',customer_type:'B2C',qualification:{city:null,product_need:'cryotherapy',quantity:null,timeline:null,budget_band:null},recommended_product_id:'1',reply_ar:'السعر 100 ريال',reply_en:'Price is 100 SAR',next_best_action:'send_link',lead_temperature:'WARM',crm_updates:{},missing_fields:[],handoff_reason:null,...over}});
function openaiTextResponse(obj,{promptTokens=10,completionTokens=20}={}) {
 return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(obj)}}],usage:{prompt_tokens:promptTokens,completion_tokens:completionTokens}}),{status:200,headers:{'content-type':'application/json'}});
}
function openaiToolCallResponse(name,input,callId='call_1') {
 return new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name,arguments:JSON.stringify(input)}}]}}],usage:{prompt_tokens:5,completion_tokens:5}}),{status:200,headers:{'content-type':'application/json'}});
}
function anthropicTextResponse(obj) {
 return new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(obj)}],usage:{input_tokens:5,output_tokens:5}}),{status:200,headers:{'content-type':'application/json'}});
}

test('OpenAI provider runs a real tool-use loop and produces a validated decision, same contract as Anthropic',async()=>{
 const store=fixture();try{
 let calls=0;
 const fetcher=async(url)=>{
  calls++;
  assert.equal(url,'https://api.openai.com/v1/chat/completions');
  if(calls===1)return openaiToolCallResponse('get_current_price',{productId:'1'});
  return openaiTextResponse(salesDecision());
 };
 setModelConfig(store.db,'sales',{provider:'openai'});
 const runtime=createAgentRuntime({store,env:openaiEnv,fetcher});
 const run=await runtime.run('sales',{triggerType:'MANUAL',input:{message:'كم سعر الجهاز؟'},user});
 assert.equal(run.status,'COMPLETED');
 assert.equal(run.provider,'openai');
 assert.equal(run.model,'gpt-test');
 assert.equal(calls,2);
 assert.equal(run.toolCalls.some(t=>t.tool==='get_current_price'),true);
 }finally{store.close();}
});

test('OpenAI without credentials fails closed with OPENAI_NOT_CONFIGURED, never crashes',async()=>{
 const store=fixture();try{
 setModelConfig(store.db,'sales',{provider:'openai'});
 const runtime=createAgentRuntime({store,env:{},fetcher:()=>{throw new Error('must not call network');}});
 const run=await runtime.run('sales',{triggerType:'MANUAL',input:{message:'hi'},user});
 assert.equal(run.status,'FAILED');
 assert.equal(run.error,'OPENAI_NOT_CONFIGURED');
 }finally{store.close();}
});

test('per-agent provider override picks the pinned provider even when the account default is a different provider',async()=>{
 const store=fixture();try{
 let anthropicCalled=false,openaiCalled=false;
 const fetcher=async(url)=>{
  if(url.includes('anthropic')){anthropicCalled=true;return anthropicTextResponse(salesDecision());}
  openaiCalled=true;return openaiTextResponse(salesDecision());
 };
 setModelConfig(store.db,'sales',{provider:'openai',model:'gpt-pinned'});
 const env={...anthropicEnv,...openaiEnv,AI_PROVIDER:'anthropic'}; // account default is anthropic
 const runtime=createAgentRuntime({store,env,fetcher});
 const run=await runtime.run('sales',{triggerType:'MANUAL',input:{message:'hi'},user});
 assert.equal(run.status,'COMPLETED');
 assert.equal(run.provider,'openai');
 assert.equal(run.model,'gpt-pinned');
 assert.equal(openaiCalled,true);assert.equal(anthropicCalled,false);
 }finally{store.close();}
});

test('setModelConfig validates provider/temperature/max_tokens and only updates fields explicitly passed',()=>{
 const store=fixture();try{
 assert.throws(()=>setModelConfig(store.db,'sales',{provider:'made-up'}),/Unsupported provider/);
 assert.throws(()=>setModelConfig(store.db,'sales',{temperature:5}),/temperature/);
 assert.throws(()=>setModelConfig(store.db,'sales',{maxTokens:-1}),/max_tokens/);
 assert.equal(setModelConfig(store.db,'unknown-agent',{provider:'openai'}),null);
 const updated=setModelConfig(store.db,'compliance',{provider:'openai',model:'gpt-strict',temperature:0});
 assert.equal(updated.provider,'openai');assert.equal(updated.model,'gpt-strict');assert.equal(updated.temperature,0);
 // Calling again without model/temperature must not clear the previously-set values.
 const untouched=setModelConfig(store.db,'compliance',{provider:'openai'});
 assert.equal(untouched.model,'gpt-strict');assert.equal(untouched.temperature,0);
 }finally{store.close();}
});

test('prompt_version is a real content-derived fingerprint, not a hand-typed number, and is recorded on every run',async()=>{
 const store=fixture();try{
 const expected=promptVersion('sales');
 assert.match(expected,/^[0-9a-f]{12}$/);
 const runtime=createAgentRuntime({store,env:anthropicEnv,fetcher:async()=>anthropicTextResponse(salesDecision())});
 const run=await runtime.run('sales',{triggerType:'MANUAL',input:{message:'hi'},user});
 assert.equal(run.prompt_version,expected);
 // A different agent has a different prompt, so a different fingerprint.
 assert.notEqual(promptVersion('compliance'),expected);
 }finally{store.close();}
});

test('AI_PROVIDER_FALLBACK_ENABLED=true retries on the secondary provider only after the primary genuinely fails, and never when disabled',async()=>{
 const store=fixture();try{
 const brokenFetcher=async(url)=>{
  if(url.includes('anthropic'))throw new Error('simulated network failure');
  return openaiTextResponse(salesDecision());
 };
 const envDisabled={...anthropicEnv,...openaiEnv};
 const runtimeDisabled=createAgentRuntime({store,env:envDisabled,fetcher:brokenFetcher});
 const failedRun=await runtimeDisabled.run('sales',{triggerType:'MANUAL',input:{message:'hi'},user});
 assert.equal(failedRun.status,'FAILED');
 assert.equal(failedRun.error,'NETWORK_OR_TIMEOUT');
 assert.equal(failedRun.used_fallback,0);

 const envEnabled={...anthropicEnv,...openaiEnv,AI_PROVIDER_FALLBACK_ENABLED:'true'};
 const runtimeEnabled=createAgentRuntime({store,env:envEnabled,fetcher:brokenFetcher});
 const fallbackRun=await runtimeEnabled.run('sales',{triggerType:'MANUAL',input:{message:'hi'},user});
 assert.equal(fallbackRun.status,'COMPLETED');
 assert.equal(fallbackRun.provider,'openai');
 assert.equal(fallbackRun.used_fallback,1);
 }finally{store.close();}
});

test('fallback never triggers when the secondary provider is not configured, even with the flag on — no silent provider swap to nothing',async()=>{
 const store=fixture();try{
 const runtime=createAgentRuntime({store,env:{...anthropicEnv,AI_PROVIDER_FALLBACK_ENABLED:'true'},fetcher:async()=>{throw new Error('down');}});
 const run=await runtime.run('sales',{triggerType:'MANUAL',input:{message:'hi'},user});
 assert.equal(run.status,'FAILED');
 assert.equal(run.error,'NETWORK_OR_TIMEOUT');
 }finally{store.close();}
});

test('estimateCost is provider-aware and stays honestly null with no pricing table configured, never a guessed number',()=>{
 assert.equal(estimateCost('anthropic','claude-test',1000,1000),null);
 assert.equal(estimateCost('openai','gpt-test',1000,1000),null);
 assert.equal(estimateCost('openai',null,1000,1000),null);
});

test('providerStatus respects a per-agent override independently of the account-default env vars',()=>{
 const env={...anthropicEnv,...openaiEnv,AI_PROVIDER:'anthropic'};
 assert.equal(providerStatus(env).provider,'anthropic');
 assert.equal(providerStatus(env).configured,true);
 assert.equal(providerStatus(env,{provider:'openai'}).provider,'openai');
 assert.equal(providerStatus(env,{provider:'openai'}).configured,true);
 assert.equal(providerStatus({ANTHROPIC_API_KEY:'x'},{provider:'openai'}).configured,false);
});

test('createLLMProvider rejects an unsupported provider name rather than silently falling back to Anthropic',()=>{
 assert.throws(()=>createLLMProvider({AI_PROVIDER:'made-up-provider'},async()=>{}),/UNSUPPORTED_PROVIDER/);
});
