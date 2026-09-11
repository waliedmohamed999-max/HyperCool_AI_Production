import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

const key32=randomBytes(32).toString('hex');
const decision=(over={})=>({status:'OK',action:'REPLY',rationale:'Answered from verified data',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{intent:'price',customer_type:'B2C',qualification:{city:null,product_need:'cryotherapy',quantity:null,timeline:null,budget_band:null},recommended_product_id:null,reply_ar:'السعر متاح',reply_en:'Price available',next_best_action:'send_link',lead_temperature:'COLD',crm_updates:{},missing_fields:[],handoff_reason:null,...over}});
const anthropicResponse=value=>new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(value)}],usage:{input_tokens:3,output_tokens:3}}),{status:200,headers:{'content-type':'application/json'}});

async function harness(env,fetcher){
 const directory=await mkdtemp(join(tmpdir(),'hypercool-meta-'));
 const app=await createApp({dataDir:directory,env,...(fetcher?{fetcher}:{})});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}){
  const hasBody=input!==undefined && input!==null && method!=='GET';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),redirect:'manual',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf,location:res.headers.get('location')};
 }
 return {app,base,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function sign(secret,body){return 'sha256='+createHmac('sha256',secret).update(body).digest('hex');}
// Multi-Tenant Phase 3.5 (Part B10): a WhatsApp webhook can only ever be attributed to a
// tenant whose real Meta OAuth connection recorded this exact phone_number_id at connect
// time (see webhook-tenant-resolver.js) — there is no fallback to "the one tenant" anymore.
// Every test that sends a webhook and expects it to actually create a lead/message must
// first establish that connection, exactly like a real deployment would.
const WHATSAPP_PHONE_NUMBER_ID='phone-1';
function metaOAuthFetcher(){
 return async(url)=>{
  if(url.includes('fb_exchange_token'))return new Response(JSON.stringify({access_token:'long-token',expires_in:5184000}),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/oauth/access_token'))return new Response(JSON.stringify({access_token:'short-token',expires_in:3600}),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/me/accounts'))return new Response(JSON.stringify({data:[{id:'page-1',name:'HyperCool',access_token:'page-secret'}]}),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/me/businesses'))return new Response(JSON.stringify({data:[{owned_whatsapp_business_accounts:{data:[{id:'waba-1',phone_numbers:{data:[{id:WHATSAPP_PHONE_NUMBER_ID,display_phone_number:'+966500000000'}]}}]}}]}),{status:200,headers:{'content-type':'application/json'}});
  throw new Error('unexpected meta url '+url);
 };
}
async function connectMeta(call,owner){
 const start=await call('/api/integrations/meta/oauth/start',undefined,owner,{method:'GET'});
 const state=new URL(start.location).searchParams.get('state');
 const callback=await call(`/api/integrations/meta/oauth/callback?code=code-1&state=${state}`,undefined,owner,{method:'GET'});
 assert.equal(callback.status,302);
}
function withPhoneNumberId(raw){
 const body=JSON.parse(raw);
 for(const entry of body.entry)for(const change of entry.changes)change.value.metadata={phone_number_id:WHATSAPP_PHONE_NUMBER_ID,display_phone_number:'+966500000000'};
 return JSON.stringify(body);
}

test('AJ — real inbound WhatsApp price question creates a lead, records the message, and triggers the sales agent automatically',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret',ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,META_APP_ID:'app-1',META_APP_SECRET:'secret-1',META_REDIRECT_URI:'https://hyper-cool.com/callback'};
 const fetcher=async(url,opts)=>{
  if(url==='https://api.anthropic.com/v1/messages')return anthropicResponse(decision());
  return metaOAuthFetcher()(url,opts);
 };
 const {call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  await connectMeta(call,owner);
  const raw=withPhoneNumberId(JSON.stringify({entry:[{changes:[{value:{contacts:[{profile:{name:'Khalid'}}],messages:[{id:'wamid.e2e.1',from:'966555000001',type:'text',text:{body:'السلام عليكم عندكم جهاز كرايو وكم سعره؟'}}]}}]}]}));
  const webhookResult=await call('/api/webhooks/meta/whatsapp',raw,null,{headers:{'x-hub-signature-256':sign('wh-secret',raw)}});
  assert.equal(webhookResult.status,200);
  assert.equal(webhookResult.data.received,1);
  await new Promise(resolve=>setTimeout(resolve,120));
  const leads=await call('/api/crm',null,owner,{method:'GET'});
  assert.equal(leads.data.leads.length,1);
  assert.equal(leads.data.leads[0].phone,'+966555000001');
  assert.equal(leads.data.leads[0].name,'Khalid');
  const detail=await call(`/api/crm/leads/${leads.data.leads[0].id}`,null,owner,{method:'GET'});
  assert.equal(detail.data.messages.length,1);
  assert.equal(detail.data.messages[0].channel,'WhatsApp');
  assert.equal(detail.data.messages[0].direction,'INBOUND');
  const runs=await call('/api/agents/sales/runs',null,owner,{method:'GET'});
  assert.equal(runs.data.length,1);
  assert.equal(runs.data[0].status,'COMPLETED');
  // Redelivering the exact same webhook must not create a second lead/message/run.
  await call('/api/webhooks/meta/whatsapp',raw,null,{headers:{'x-hub-signature-256':sign('wh-secret',raw)}});
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal((await call('/api/crm',null,owner,{method:'GET'})).data.leads.length,1);
  assert.equal((await call('/api/agents/sales/runs',null,owner,{method:'GET'})).data.length,1);
 }finally{await cleanup();}
});

test('AP — invalid webhook signature is rejected before any lead/message is ever created',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret'};
 const {call,cleanup}=await harness(env);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  const raw=JSON.stringify({entry:[{changes:[{value:{messages:[{id:'wamid.bad.1',from:'966555000002',type:'text',text:{body:'hi'}}]}}]}]});
  const res=await call('/api/webhooks/meta/whatsapp',raw,null,{headers:{'x-hub-signature-256':'sha256=wrong'}});
  assert.equal(res.status,401);
  assert.equal((await call('/api/crm',null,owner,{method:'GET'})).data.leads.length,0);
 }finally{await cleanup();}
});

test('AL — customer sends an opt-out message: opt_out is set and no further outbound is allowed',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret',INTEGRATION_ENCRYPTION_KEY:key32,META_APP_ID:'app-1',META_APP_SECRET:'secret-1',META_REDIRECT_URI:'https://hyper-cool.com/callback'};
 const {call,cleanup}=await harness(env,metaOAuthFetcher());
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  await connectMeta(call,owner);
  const raw=withPhoneNumberId(JSON.stringify({entry:[{changes:[{value:{messages:[{id:'wamid.optout.1',from:'966555000003',type:'text',text:{body:'stop'}}]}}]}]}));
  const res=await call('/api/webhooks/meta/whatsapp',raw,null,{headers:{'x-hub-signature-256':sign('wh-secret',raw)}});
  assert.equal(res.status,200);
  const leads=(await call('/api/crm',null,owner,{method:'GET'})).data.leads;
  assert.equal(leads.length,1);assert.equal(leads[0].optOut,true);
  const sendAttempt=await call(`/api/crm/leads/${leads[0].id}/whatsapp-send`,{text:'still trying'},owner);
  assert.equal(sendAttempt.status,409);
 }finally{await cleanup();}
});

test('Delivery-status webhook updates the existing outbound message in place, not a new record',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret',INTEGRATION_ENCRYPTION_KEY:key32,META_APP_ID:'app-1',META_APP_SECRET:'secret-1',META_REDIRECT_URI:'https://hyper-cool.com/callback'};
 const fetcher=async(url,opts)=>{
  if(url.includes('/messages') && url.includes('graph.facebook.com'))return new Response(JSON.stringify({messages:[{id:'wamid.sent.reply'}]}),{status:200,headers:{'content-type':'application/json'}});
  return metaOAuthFetcher()(url,opts);
 };
 const {call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  await connectMeta(call,owner);
  const lead=await call('/api/crm/leads',{name:'Test',customerType:'B2C',sourceType:'INBOUND',phone:'+966555000004'},owner);
  // Simulate an inbound message so the 24h customer-service window is open, then a manual send.
  const inboundRaw=withPhoneNumberId(JSON.stringify({entry:[{changes:[{value:{messages:[{id:'wamid.win.1',from:'966555000004',type:'text',text:{body:'hi'}}]}}]}]}));
  await call('/api/webhooks/meta/whatsapp',inboundRaw,null,{headers:{'x-hub-signature-256':sign('wh-secret',inboundRaw)}});
  const sendResult=await call(`/api/crm/leads/${lead.data.id}/whatsapp-send`,{text:'hello back'},owner);
  assert.equal(sendResult.data.status,'SENT'); // a real Meta connection now exists (needed for webhook tenant resolution), so this is a real send, not INTEGRATION_REQUIRED
  const statusRaw=withPhoneNumberId(JSON.stringify({entry:[{changes:[{value:{statuses:[{id:'wamid.win.1',status:'read'}]}}]}]}));
  const statusRes=await call('/api/webhooks/meta/whatsapp',statusRaw,null,{headers:{'x-hub-signature-256':sign('wh-secret',statusRaw)}});
  assert.equal(statusRes.status,200);assert.equal(statusRes.data.statuses,1);
  const detail=await call(`/api/crm/leads/${lead.data.id}`,null,owner,{method:'GET'});
  assert.equal(detail.data.messages.length,2); // the inbound message plus the real outbound reply — no third row for the status update
  assert.equal(detail.data.messages.find(m=>m.externalMessageId==='wamid.win.1').status,'READ');
 }finally{await cleanup();}
});

test('AK-style — updating a lead to HOT over HTTP creates a real P1 escalation visible to the owner',async()=>{
 const {call,cleanup}=await harness({});
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  const lead=await call('/api/crm/leads',{name:'Riyadh Gym',customerType:'B2B',company:'Riyadh Gym',sourceType:'INBOUND',phone:'+966555000005'},owner);
  const before=(await call(`/api/crm/leads/${lead.data.id}`,null,owner,{method:'GET'})).data.lead;
  const update=await call(`/api/crm/leads/${lead.data.id}/update`,{stage:'QUALIFIED',temperature:'HOT',reason:'Wants formal quote for 4 units',city:'Riyadh',productNeed:'Cryo chamber',quantity:4,timeline:'',budgetBand:'',expectedVersion:before.version},owner);
  assert.equal(update.status,200);
  const escalations=await call('/api/escalations',null,owner,{method:'GET'});
  assert.equal(escalations.data.length,1);
  assert.equal(escalations.data[0].priority,'P1');
  assert.equal(escalations.data[0].context.leadId,lead.data.id);
 }finally{await cleanup();}
});

test('Meta OAuth full connect flow over HTTP mirrors the Salla pattern: encrypted storage, one-time state, safe metadata exposure, disconnect',async()=>{
 const env={INTEGRATION_ENCRYPTION_KEY:key32,META_APP_ID:'app-1',META_APP_SECRET:'secret-1',META_REDIRECT_URI:'https://hyper-cool.com/callback'};
 const fetcher=async(url)=>{
  if(url.includes('fb_exchange_token'))return new Response(JSON.stringify({access_token:'long-token',expires_in:5184000}),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/oauth/access_token'))return new Response(JSON.stringify({access_token:'short-token',expires_in:3600}),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/me/accounts'))return new Response(JSON.stringify({data:[{id:'page-1',name:'HyperCool',access_token:'page-secret'}]}),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/me/businesses'))return new Response(JSON.stringify({data:[]}),{status:200,headers:{'content-type':'application/json'}});
  throw new Error('unexpected '+url);
 };
 const {call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  const start=await call('/api/integrations/meta/oauth/start',undefined,owner,{method:'GET'});
  assert.equal(start.status,302);
  const state=new URL(start.location).searchParams.get('state');
  const callback=await call(`/api/integrations/meta/oauth/callback?code=code-1&state=${state}`,undefined,owner,{method:'GET'});
  assert.equal(callback.status,302);
  const status=await call('/api/integrations/meta/oauth/status',undefined,owner,{method:'GET'});
  assert.equal(status.data.connected,true);
  assert.equal(status.data.page.name,'HyperCool');
  assert.equal(JSON.stringify(status.data).includes('page-secret'),false);
  assert.equal((await call('/api/integrations/meta/disconnect',{},owner)).status,200);
  assert.equal((await call('/api/integrations/meta/oauth/status',undefined,owner,{method:'GET'})).data.connected,false);
 }finally{await cleanup();}
});
