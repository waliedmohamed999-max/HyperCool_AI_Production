import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

// Phase MKT-2, Part I/J — real Facebook Messenger + Instagram DM/comment inbound handling,
// built on the SAME Meta App webhook mechanism, signature verification, tenant resolution,
// dedup, and CRM model as the already-shipped WhatsApp inbound path (tests/meta-whatsapp-api.
// test.js is the reference pattern this file follows). No Meta app review has actually been
// verified in this environment (no live credentials) -- this proves the CODE PATH is real and
// correct against Meta's documented webhook/Send API shapes with a mocked provider, exactly
// like the WhatsApp tests already do; see docs/MKT_2_REPORT.md for the honest LIVE vs
// APPROVAL_REQUIRED distinction.
const key32=randomBytes(32).toString('hex');
const decision=(over={})=>({status:'OK',action:'REPLY',rationale:'Answered from verified data',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{intent:'price',customer_type:'B2C',qualification:{city:null,product_need:'cryotherapy',quantity:null,timeline:null,budget_band:null},recommended_product_id:null,reply_ar:'السعر متاح',reply_en:'Price available',next_best_action:'send_link',lead_temperature:'COLD',crm_updates:{},missing_fields:[],handoff_reason:null,...over}});
const anthropicResponse=value=>new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(value)}],usage:{input_tokens:3,output_tokens:3}}),{status:200,headers:{'content-type':'application/json'}});

async function harness(env,fetcher) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-meta-social-'));
 const app=await createApp({dataDir:directory,env,...(fetcher?{fetcher}:{})});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}) {
  const hasBody=input!==undefined && input!==null && method!=='GET';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),redirect:'manual',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf,location:res.headers.get('location')};
 }
 return {app,base,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function sign(secret,body){return 'sha256='+createHmac('sha256',secret).update(body).digest('hex');}
function latestMailTo(app,toEmail,kind) {
 const row=app.store.db.prepare('SELECT * FROM platform_mail_outbox WHERE to_email=? AND kind=? ORDER BY created_at DESC LIMIT 1').get(toEmail,kind);
 return row?JSON.parse(row.captured_body):null;
}
function extractToken(body,marker) {
 const match=(body.html+body.text).match(new RegExp(marker+'/([a-f0-9]+)'));
 return match?match[1]:null;
}
async function signupAndCreateWorkspace(call,app,{username,email,companyName}) {
 const signup=await call('/api/signup',{name:'مستخدم اختبار',username,email,password:'a-long-test-password'});
 const session={cookie:signup.cookie,csrf:signup.csrf};
 const mail=latestMailTo(app,email,'VERIFY_EMAIL');
 const token=extractToken(mail,'verify-email');
 await call('/api/account/email/verify',{token},null);
 await call('/api/workspaces',{companyName},session);
 return session;
}
function metaOAuthFetcher(withInstagram=false) {
 return async(url)=>{
  if(url.includes('fb_exchange_token'))return new Response(JSON.stringify({access_token:'long-token',expires_in:5184000}),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/oauth/access_token'))return new Response(JSON.stringify({access_token:'short-token',expires_in:3600}),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/me/accounts'))return new Response(JSON.stringify({data:[{id:'page-1',name:'HyperCool',access_token:'page-secret',...(withInstagram?{instagram_business_account:{id:'ig-1',username:'hypercool'}}:{})}]}),{status:200,headers:{'content-type':'application/json'}});
  throw new Error('unexpected meta url '+url);
 };
}
async function connectMeta(call,owner,withInstagram=false) {
 const start=await call('/api/integrations/meta/oauth/start',undefined,owner,{method:'GET'});
 const state=new URL(start.location).searchParams.get('state');
 const callback=await call(`/api/integrations/meta/oauth/callback?code=code-1&state=${state}`,undefined,owner,{method:'GET'});
 assert.equal(callback.status,302);
}

test('Part I — a real inbound Facebook Messenger message creates a lead, records it, and triggers the sales agent automatically',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret',ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,META_APP_ID:'app-1',META_APP_SECRET:'secret-1',META_REDIRECT_URI:'https://hyper-cool.com/cb',PLATFORM_MAIL_TRANSPORT:'capture'};
 const fetcher=async(url,opts)=>{
  if(url==='https://api.anthropic.com/v1/messages')return anthropicResponse(decision());
  return metaOAuthFetcher()(url,opts);
 };
 const {call,app,cleanup}=await harness(env,fetcher);
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'msginb1',email:'msginb1@example.com',companyName:'Messenger Inbound 1'});
  await connectMeta(call,owner);
  const raw=JSON.stringify({object:'page',entry:[{id:'page-1',messaging:[{sender:{id:'psid-1'},recipient:{id:'page-1'},timestamp:Date.now(),message:{mid:'mid.1',text:'كم سعر جهاز الكرايو؟'}}]}]});
  const res=await call('/api/webhooks/meta/social',raw,null,{headers:{'x-hub-signature-256':sign('wh-secret',raw)}});
  assert.equal(res.status,200);
  assert.equal(res.data.received,1);
  await new Promise(resolve=>setTimeout(resolve,150));
  const leads=await call('/api/crm',null,owner,{method:'GET'});
  assert.equal(leads.data.leads.length,1);
  assert.equal(leads.data.leads[0].channelOrigin,'Facebook');
  const detail=await call(`/api/crm/leads/${leads.data.leads[0].id}`,null,owner,{method:'GET'});
  assert.equal(detail.data.messages[0].channel,'Facebook');
  assert.equal(detail.data.messages[0].direction,'INBOUND');
  const runs=await call('/api/agents/sales/runs',null,owner,{method:'GET'});
  assert.equal(runs.data.length,1);
  // Redelivery must not create a second lead/message/run.
  await call('/api/webhooks/meta/social',raw,null,{headers:{'x-hub-signature-256':sign('wh-secret',raw)}});
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal((await call('/api/crm',null,owner,{method:'GET'})).data.leads.length,1);
  assert.equal((await call('/api/agents/sales/runs',null,owner,{method:'GET'})).data.length,1);
 } finally { await cleanup(); }
});

test('Part I — a real inbound Instagram DM resolves via the linked Instagram Business Account id and is recorded under channel Instagram',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret',INTEGRATION_ENCRYPTION_KEY:key32,META_APP_ID:'app-1',META_APP_SECRET:'secret-1',META_REDIRECT_URI:'https://hyper-cool.com/cb',PLATFORM_MAIL_TRANSPORT:'capture'};
 const {call,app,cleanup}=await harness(env,metaOAuthFetcher(true));
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'iginb1',email:'iginb1@example.com',companyName:'IG Inbound 1'});
  await connectMeta(call,owner,true);
  const raw=JSON.stringify({object:'instagram',entry:[{id:'ig-1',messaging:[{sender:{id:'igsid-1'},recipient:{id:'ig-1'},timestamp:Date.now(),message:{mid:'mid.ig.1',text:'هل يوجد توصيل؟'}}]}]});
  const res=await call('/api/webhooks/meta/social',raw,null,{headers:{'x-hub-signature-256':sign('wh-secret',raw)}});
  assert.equal(res.status,200);
  assert.equal(res.data.received,1);
  const leads=await call('/api/crm',null,owner,{method:'GET'});
  assert.equal(leads.data.leads.length,1);
  assert.equal(leads.data.leads[0].channelOrigin,'Instagram');
  const detail=await call(`/api/crm/leads/${leads.data.leads[0].id}`,null,owner,{method:'GET'});
  assert.equal(detail.data.messages[0].channel,'Instagram');
 } finally { await cleanup(); }
});

test('Part I — an echo of our own outbound send is never treated as a new inbound message',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret',INTEGRATION_ENCRYPTION_KEY:key32,META_APP_ID:'app-1',META_APP_SECRET:'secret-1',META_REDIRECT_URI:'https://hyper-cool.com/cb',PLATFORM_MAIL_TRANSPORT:'capture'};
 const {call,app,cleanup}=await harness(env,metaOAuthFetcher());
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'echoinb1',email:'echoinb1@example.com',companyName:'Echo Inbound 1'});
  await connectMeta(call,owner);
  const raw=JSON.stringify({object:'page',entry:[{id:'page-1',messaging:[{sender:{id:'page-1'},recipient:{id:'psid-1'},timestamp:Date.now(),message:{mid:'mid.echo.1',text:'reply',is_echo:true}}]}]});
  const res=await call('/api/webhooks/meta/social',raw,null,{headers:{'x-hub-signature-256':sign('wh-secret',raw)}});
  assert.equal(res.status,200);
  assert.equal(res.data.received,0);
  assert.equal(res.data.skipped,1);
  assert.equal((await call('/api/crm',null,owner,{method:'GET'})).data.leads.length,0);
 } finally { await cleanup(); }
});

test('Part I — a real inbound comment is intaked into the CRM without ever triggering an agent run',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret',INTEGRATION_ENCRYPTION_KEY:key32,META_APP_ID:'app-1',META_APP_SECRET:'secret-1',META_REDIRECT_URI:'https://hyper-cool.com/cb',PLATFORM_MAIL_TRANSPORT:'capture'};
 const {call,app,cleanup}=await harness(env,metaOAuthFetcher());
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'cmtinb1',email:'cmtinb1@example.com',companyName:'Comment Inbound 1'});
  await connectMeta(call,owner);
  const raw=JSON.stringify({object:'page',entry:[{id:'page-1',changes:[{field:'comments',value:{comment_id:'cmt-1',post_id:'post-1',from:{id:'psid-2',name:'Sara'},text:'هل هذا متوفر؟'}}]}]});
  const res=await call('/api/webhooks/meta/social',raw,null,{headers:{'x-hub-signature-256':sign('wh-secret',raw)}});
  assert.equal(res.status,200);
  assert.equal(res.data.comments,1);
  const leads=await call('/api/crm',null,owner,{method:'GET'});
  assert.equal(leads.data.leads.length,1);
  const detail=await call(`/api/crm/leads/${leads.data.leads[0].id}`,null,owner,{method:'GET'});
  assert.equal(detail.data.messages[0].messageType,'comment');
  assert.equal((await call('/api/agents/sales/runs',null,owner,{method:'GET'})).data.length,0);
 } finally { await cleanup(); }
});

test('Part I — invalid webhook signature is rejected before any lead/message is ever created',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret',PLATFORM_MAIL_TRANSPORT:'capture'};
 const {call,app,cleanup}=await harness(env);
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'badsig1',email:'badsig1@example.com',companyName:'Bad Sig 1'});
  const raw=JSON.stringify({object:'page',entry:[{id:'page-1',messaging:[{sender:{id:'psid-9'},recipient:{id:'page-1'},message:{mid:'mid.bad.1',text:'hi'}}]}]});
  const res=await call('/api/webhooks/meta/social',raw,null,{headers:{'x-hub-signature-256':'sha256=wrong'}});
  assert.equal(res.status,401);
  assert.equal((await call('/api/crm',null,owner,{method:'GET'})).data.leads.length,0);
 } finally { await cleanup(); }
});

test('Part I — tenant isolation: a webhook for Tenant A\'s connected Page never resolves to or leaks into Tenant B',async()=>{
 const env={META_WEBHOOK_SECRET:'wh-secret',INTEGRATION_ENCRYPTION_KEY:key32,META_APP_ID:'app-1',META_APP_SECRET:'secret-1',META_REDIRECT_URI:'https://hyper-cool.com/cb',PLATFORM_MAIL_TRANSPORT:'capture'};
 const {call,app,cleanup}=await harness(env,metaOAuthFetcher());
 try {
  const ownerA=await signupAndCreateWorkspace(call,app,{username:'metaisoa',email:'metaisoa@example.com',companyName:'Meta Iso A'});
  const ownerB=await signupAndCreateWorkspace(call,app,{username:'metaisob',email:'metaisob@example.com',companyName:'Meta Iso B'});
  await connectMeta(call,ownerA); // only Tenant A connects Meta; Page id 'page-1' belongs to A
  const raw=JSON.stringify({object:'page',entry:[{id:'page-1',messaging:[{sender:{id:'psid-iso-1'},recipient:{id:'page-1'},message:{mid:'mid.iso.1',text:'hi'}}]}]});
  await call('/api/webhooks/meta/social',raw,null,{headers:{'x-hub-signature-256':sign('wh-secret',raw)}});
  assert.equal((await call('/api/crm',null,ownerA,{method:'GET'})).data.leads.length,1);
  assert.equal((await call('/api/crm',null,ownerB,{method:'GET'})).data.leads.length,0);
 } finally { await cleanup(); }
});

test('Part J — the sales agent can reply to a real Messenger conversation via meta_message_send once promoted to L2, and the outbound message is recorded under the same channel',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,META_APP_ID:'app-1',META_APP_SECRET:'secret-1',META_REDIRECT_URI:'https://hyper-cool.com/cb',META_WEBHOOK_SECRET:'wh-secret',ENABLE_L2_AUTONOMY:'true',PLATFORM_MAIL_TRANSPORT:'capture'};
 let sendCalls=0;
 const fetcher=async(url,opts)=>{
  if(url.includes('/page-1/messages')&&opts?.method==='POST'){sendCalls++;return new Response(JSON.stringify({recipient_id:'psid-1',message_id:'mid.reply.1'}),{status:200,headers:{'content-type':'application/json'}});}
  if(url==='https://api.anthropic.com/v1/messages') {
   const body=JSON.parse(opts.body);
   const alreadyCalledTool=body.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result'));
   if(!alreadyCalledTool) {
    // Reads the REAL leadId the runtime itself put in the first user turn (from the
    // CUSTOMER_MESSAGE_RECEIVED event's real payload) -- never a value this test guesses or
    // injects, so there is no race with when the webhook handler created the lead.
    const firstTurnContent=body.messages[0].content;
    const parsedInput=typeof firstTurnContent==='string'?JSON.parse(firstTurnContent):null;
    return new Response(JSON.stringify({stop_reason:'tool_use',content:[{type:'tool_use',id:'call-1',name:'meta_message_send',input:{leadId:parsedInput?.leadId,text:'أهلاً، الجهاز متوفر حالياً'}}],usage:{input_tokens:3,output_tokens:3}}),{status:200,headers:{'content-type':'application/json'}});
   }
   return anthropicResponse(decision());
  }
  return metaOAuthFetcher()(url,opts);
 };
 const {call,app,cleanup}=await harness(env,fetcher);
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'msgsend1',email:'msgsend1@example.com',companyName:'Meta Send 1'});
  await connectMeta(call,owner);
  await call('/api/agents/sales/autonomy',{level:'L1',reason:'test',expectedVersion:0},owner);
  await call('/api/agents/sales/autonomy',{level:'L2',reason:'test',expectedVersion:1},owner);
  const raw=JSON.stringify({object:'page',entry:[{id:'page-1',messaging:[{sender:{id:'psid-1'},recipient:{id:'page-1'},message:{mid:'mid.send.1',text:'مرحبا، هل يوجد جهاز كرايو؟'}}]}]});
  await call('/api/webhooks/meta/social',raw,null,{headers:{'x-hub-signature-256':sign('wh-secret',raw)}});
  const leadsAfter=await call('/api/crm',null,owner,{method:'GET'});
  const leadId=leadsAfter.data.leads[0].id;
  await new Promise(resolve=>setTimeout(resolve,150));
  const detail=await call(`/api/crm/leads/${leadId}`,null,owner,{method:'GET'});
  const outbound=detail.data.messages.find(m=>m.direction==='OUTBOUND');
  assert.ok(outbound,'expected a real outbound Messenger reply to have been recorded');
  assert.equal(outbound.channel,'Facebook');
  assert.equal(outbound.externalMessageId,'mid.reply.1');
  assert.equal(sendCalls,1);
 } finally { await cleanup(); }
});
