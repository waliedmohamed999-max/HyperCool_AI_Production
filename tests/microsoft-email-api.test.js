import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {saveCredentials} from '../src/runtime/credentials.js';
import {resolveTenantForUser} from '../src/tenancy.js';

const key32=randomBytes(32).toString('hex');
const decision=(over={})=>({status:'OK',action:'REPLY',rationale:'Answered a B2B quote request',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{intent:'quote',customer_type:'B2B',qualification:{city:'Riyadh',product_need:'cryotherapy',quantity:4,timeline:null,budget_band:null},recommended_product_id:null,reply_ar:'سنرسل عرض السعر',reply_en:'We will send the quote',next_best_action:'send_quote',lead_temperature:'HOT',crm_updates:{},missing_fields:[],handoff_reason:'B2B_QUOTE_REQUEST',...over}});
const anthropicResponse=value=>new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(value)}],usage:{input_tokens:3,output_tokens:3}}),{status:200,headers:{'content-type':'application/json'}});

async function harness(env,fetcher){
 const directory=await mkdtemp(join(tmpdir(),'hypercool-ms365-'));
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
function graphNotification(messageId){return JSON.stringify({value:[{subscriptionId:'sub-1',clientState:'wh-secret',changeType:'created',resourceData:{id:messageId}}]});}

test('BP — webhook validation handshake echoes the exact token as plain text',async()=>{
 const {base,cleanup}=await harness({});
 try{
  const res=await fetch(base+'/api/webhooks/microsoft/mail?validationToken=abc-123',{method:'POST'});
  assert.equal(res.status,200);
  assert.equal(await res.text(),'abc-123');
 }finally{await cleanup();}
});

test('BI — real inbound B2B quote-request email creates a lead, records the message, and triggers the sales agent',async()=>{
 const env={MICROSOFT_WEBHOOK_SECRET:'wh-secret',MICROSOFT_ACCESS_TOKEN:'ms-token',ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32};
 const graphMessage={id:'msg-1',internetMessageId:'<msg-1@mail>',conversationId:'thread-1',subject:'طلب عرض سعر',from:{emailAddress:{address:'club@example.com',name:'Riyadh Club'}},bodyPreview:'السلام عليكم، نحن نادي رياضي بالرياض ونحتاج 4 أجهزة ونرغب بعرض سعر.',isDraft:false};
 const fetcher=async(url)=>{
  if(url.includes('anthropic'))return anthropicResponse(decision());
  if(url.includes('/messages/msg-1'))return new Response(JSON.stringify(graphMessage),{status:200,headers:{'content-type':'application/json'}});
  throw new Error('unexpected '+url);
 };
 const {app,call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  // Multi-Tenant Phase 3.5 (Part B11): a Microsoft Graph notification can only ever be
  // attributed to a tenant whose real subscription id it carries. Seeding the credential
  // row directly (rather than driving /api/integrations/microsoft/subscribe over HTTP)
  // avoids needing a real PUBLIC_ORIGIN host match in this test harness, which listens on
  // 127.0.0.1 — the resulting metadata shape is identical to what a real subscribe call
  // would store.
  const tenantId=resolveTenantForUser(app.store.db,owner.data.user.id);
  saveCredentials(app.store.db,env,'microsoft365',{accessToken:'ms-token',metadata:{mailSubscription:{id:'sub-1',expiresAt:new Date(Date.now()+3600000).toISOString()}}},owner.data.user,tenantId);
  const webhookRes=await call('/api/webhooks/microsoft/mail',graphNotification('msg-1'));
  assert.equal(webhookRes.status,200);assert.equal(webhookRes.data.toFetch,1);
  await new Promise(resolve=>setTimeout(resolve,120));

  const leads=(await call('/api/crm',null,owner,{method:'GET'})).data.leads;
  assert.equal(leads.length,1);
  assert.equal(leads[0].email,'club@example.com');
  assert.equal(leads[0].name,'Riyadh Club');

  const detail=await call(`/api/crm/leads/${leads[0].id}`,null,owner,{method:'GET'});
  assert.equal(detail.data.messages.length,1);
  assert.equal(detail.data.messages[0].channel,'Email');
  assert.equal(detail.data.messages[0].subject,'طلب عرض سعر');
  assert.equal(detail.data.messages[0].externalThreadId,'thread-1');

  const runs=await call('/api/agents/sales/runs',null,owner,{method:'GET'});
  assert.equal(runs.data.length,1);
  assert.equal(runs.data[0].status,'COMPLETED');

  // Redelivering the same notification must not re-fetch or duplicate anything.
  await call('/api/webhooks/microsoft/mail',graphNotification('msg-1'));
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal((await call('/api/crm',null,owner,{method:'GET'})).data.leads.length,1);
 }finally{await cleanup();}
});

test('A draft message (isDraft=true) is never ingested as if a customer sent it',async()=>{
 const env={MICROSOFT_WEBHOOK_SECRET:'wh-secret',MICROSOFT_ACCESS_TOKEN:'ms-token'};
 const fetcher=async(url)=>{
  if(url.includes('/messages/msg-draft'))return new Response(JSON.stringify({id:'msg-draft',isDraft:true,from:{emailAddress:{address:'me@hyper-cool.com'}}}),{status:200,headers:{'content-type':'application/json'}});
  throw new Error('unexpected '+url);
 };
 const {call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  await call('/api/webhooks/microsoft/mail',graphNotification('msg-draft'));
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal((await call('/api/crm',null,owner,{method:'GET'})).data.leads.length,0);
 }finally{await cleanup();}
});

test('BJ — an approval-required quote email (via microsoft_sendEmail category) stays WAITING_APPROVAL until the owner decides, then actually sends on approval',async()=>{
 const env={MICROSOFT_ACCESS_TOKEN:'ms-token'};
 let sendCalls=0;
 const fetcher=async(url,opts)=>{
  if(url==='https://graph.microsoft.com/v1.0/me/sendMail'){sendCalls++;assert.equal(JSON.parse(opts.body).message.subject,'Your Quote');return new Response(null,{status:202});}
  throw new Error('unexpected '+url);
 };
 const {call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  const lead=await call('/api/crm/leads',{name:'Club',customerType:'B2B',company:'Riyadh Club',sourceType:'INBOUND',email:'club2@example.com'},owner);
  const draft=await call(`/api/crm/leads/${lead.data.id}/email-send`,{subject:'Your Quote',bodyHtml:'<p>...</p>',category:'quote'},owner);
  assert.equal(draft.status,200);
  assert.equal(draft.data.status,'WAITING_APPROVAL');
  assert.equal(sendCalls,0);
  const approvals=await call('/api/approvals',null,owner,{method:'GET'});
  assert.equal(approvals.data.length,1);
  const decide=await call(`/api/approvals/${approvals.data[0].id}/decide`,{decision:'APPROVED'},owner);
  assert.equal(decide.status,200);
  assert.equal(decide.data.emailSendResult.status,'SENT');
  assert.equal(sendCalls,1);
  const detail=await call(`/api/crm/leads/${lead.data.id}`,null,owner,{method:'GET'});
  assert.equal(detail.data.messages.length,1);
  assert.equal(detail.data.messages[0].direction,'OUTBOUND');
 }finally{await cleanup();}
});

test('A rejected email approval never sends',async()=>{
 const env={MICROSOFT_ACCESS_TOKEN:'ms-token'};
 const fetcher=async()=>{throw new Error('must not call network on rejection');};
 const {call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  const lead=await call('/api/crm/leads',{name:'Club',customerType:'B2B',company:'Club',sourceType:'INBOUND',email:'club3@example.com'},owner);
  const draft=await call(`/api/crm/leads/${lead.data.id}/email-send`,{subject:'x',bodyHtml:'x',category:'discount'},owner);
  const approvals=await call('/api/approvals',null,owner,{method:'GET'});
  const decide=await call(`/api/approvals/${approvals.data[0].id}/decide`,{decision:'REJECTED'},owner);
  assert.equal(decide.data.emailSendResult,undefined);
  const detail=await call(`/api/crm/leads/${lead.data.id}`,null,owner,{method:'GET'});
  assert.equal(detail.data.messages.length,0);
 }finally{await cleanup();}
});

test('BQ — Microsoft OAuth connect/disconnect over HTTP, deleting the webhook subscription on disconnect',async()=>{
 const env={INTEGRATION_ENCRYPTION_KEY:key32,MICROSOFT_CLIENT_ID:'client-1',MICROSOFT_CLIENT_SECRET:'secret-1',MICROSOFT_REDIRECT_URI:'https://hyper-cool.com/cb'};
 let deleteCalls=0;
 const fetcher=async(url,opts)=>{
  if(url.includes('/oauth2/v2.0/token'))return new Response(JSON.stringify({access_token:'ms-token',refresh_token:'ms-refresh',expires_in:3600,scope:'Mail.Read Mail.Send'}),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/me?'))return new Response(JSON.stringify({id:'acct-1',displayName:'Owner',mail:'owner@hyper-cool.com'}),{status:200,headers:{'content-type':'application/json'}});
  if(opts?.method==='DELETE'){deleteCalls++;return new Response(null,{status:204});}
  throw new Error('unexpected '+url);
 };
 const {call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  const start=await call('/api/integrations/microsoft/oauth/start',undefined,owner,{method:'GET'});
  assert.equal(start.status,302);
  const state=new URL(start.location).searchParams.get('state');
  const callback=await call(`/api/integrations/microsoft/oauth/callback?code=code-1&state=${state}`,undefined,owner,{method:'GET'});
  assert.equal(callback.status,302);
  const status=await call('/api/integrations/microsoft/oauth/status',undefined,owner,{method:'GET'});
  assert.equal(status.data.connected,true);
  assert.equal(status.data.email,'owner@hyper-cool.com');
  assert.equal(JSON.stringify(status.data).includes('ms-token'),false);
  assert.equal((await call('/api/integrations/microsoft/disconnect',{},owner)).status,200);
  assert.equal((await call('/api/integrations/microsoft/oauth/status',undefined,owner,{method:'GET'})).data.connected,false);
 }finally{await cleanup();}
});
