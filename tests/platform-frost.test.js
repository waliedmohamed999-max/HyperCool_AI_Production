import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installTenancy,createTenant} from '../src/tenancy.js';
import {installPlatformIdentity} from '../src/platform-identity.js';
import {installWebhookEvents} from '../src/runtime/webhook-events.js';
import {installIntegrationConnections} from '../src/integrations/connections.js';
import {installPlatformFrostChat,sendPlatformFrostMessage,listPlatformFrostMessages} from '../src/runtime/platform-frost.js';

const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model'};
const actor={id:'admin-1',name:'Platform Admin'};
function fixture() {
 const store=openStore(':memory:');
 installTenancy(store.db);installPlatformIdentity(store.db);installWebhookEvents(store.db);installIntegrationConnections(store.db);installPlatformFrostChat(store.db);
 return store;
}
const textTurn=(obj,stop='end_turn')=>({stop_reason:stop,content:[{type:'text',text:JSON.stringify(obj)}],usage:{input_tokens:5,output_tokens:5}});
const toolUseTurn=(name,input={},id='call_1')=>({stop_reason:'tool_use',content:[{type:'tool_use',id,name,input}],usage:{input_tokens:5,output_tokens:5}});
function sequencedFetcher(turns) {
 let i=0;
 return async()=>{const body=turns[Math.min(i,turns.length-1)];i++;return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});};
}
const decision=answer=>({status:'OK',action:'ANSWER',rationale:'from real platform tools',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],payload:{answer,data_sources:['get_platform_overview']}});

test('Platform Frost answers using the real platform-admin aggregate tools, never a tenant business fact',async()=>{
 const store=fixture();
 try{
  createTenant(store.db,{name:'شركة سرية جدًا',slug:'secret-co'});
  const fetcher=sequencedFetcher([toolUseTurn('get_platform_overview'),textTurn(decision('يوجد منشأة واحدة على المنصة حاليًا ولا مشاكل حرجة.'))]);
  const {assistantMessage,status}=await sendPlatformFrostMessage({db:store.db,env,fetcher,schedulerRunning:true,actor,text:'هل في مشاكل في المنصة؟'});
  assert.equal(status,'OK');
  assert.match(assistantMessage.content,/منشأة/);
  assert.doesNotMatch(assistantMessage.content,/شركة سرية جدًا/);
  const messages=listPlatformFrostMessages(store.db);
  assert.equal(messages.length,2);
  assert.equal(messages[0].role,'user');
  assert.equal(messages[1].role,'assistant');
 }finally{store.close();}
});

test('Platform Frost fails closed honestly with no AI configured — never fabricates an answer',async()=>{
 const store=fixture();
 try{
  const {status,assistantMessage}=await sendPlatformFrostMessage({db:store.db,env:{},fetcher:async()=>{throw new Error('must never call the network');},schedulerRunning:true,actor,text:'هل في مشاكل؟'});
  assert.equal(status,'FAILED');
  assert.match(assistantMessage.content,/اتصال ذكاء اصطناعي/);
 }finally{store.close();}
});

test('every Platform Frost command is audited in the real platform_audit_log',async()=>{
 const store=fixture();
 try{
  const fetcher=sequencedFetcher([textTurn(decision('لا يوجد Webhooks فاشلة.'))]);
  await sendPlatformFrostMessage({db:store.db,env,fetcher,schedulerRunning:false,actor,text:'هل في Webhooks ميتة؟'});
  const audited=store.db.prepare("SELECT * FROM platform_audit_log WHERE action='PLATFORM_FROST_COMMAND'").all();
  assert.equal(audited.length,1);
  assert.equal(audited[0].actor_id,actor.id);
 }finally{store.close();}
});
