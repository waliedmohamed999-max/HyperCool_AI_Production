import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {riyadhDate} from '../src/planning.js';

const key32=randomBytes(32).toString('hex');
const anthropicText=value=>new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(value)}],usage:{input_tokens:3,output_tokens:3}}),{status:200,headers:{'content-type':'application/json'}});
const anthropicToolUse=(id,name,input)=>new Response(JSON.stringify({stop_reason:'tool_use',content:[{type:'tool_use',id,name,input}],usage:{input_tokens:3,output_tokens:3}}),{status:200,headers:{'content-type':'application/json'}});
const publishingDecision=(over={})=>({status:'OK',action:'PUBLISH',rationale:'Published the due, approved post',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{platform:'X',scheduled_at:null,published_at:new Date().toISOString(),post_id:'42',live_url:'https://x.com/i/web/status/42',idempotency_key:'k',retry_count:0,error_code:null,...over}});

async function harness(env,fetcher){
 const directory=await mkdtemp(join(tmpdir(),'hypercool-social-'));
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
async function promoteAgent(call,owner,agentId,fromVersion=0){
 await call(`/api/agents/${agentId}/autonomy`,{level:'L1',reason:'test promotion',expectedVersion:fromVersion},owner);
 await call(`/api/agents/${agentId}/autonomy`,{level:'L2',reason:'test promotion',expectedVersion:fromVersion+1},owner);
}
// Connects X the same way a real user would — through the actual OAuth endpoint — so the
// publish tool has a genuine (mocked) user-context token to resolve, exactly like production.
async function connectX(call,owner){
 const start=await call('/api/integrations/x/oauth/start',undefined,owner,{method:'GET'});
 const state=new URL(start.location).searchParams.get('state');
 await call(`/api/integrations/x/oauth/callback?code=code-1&state=${state}`,undefined,owner,{method:'GET'});
}
async function approvedXContent(call,owner,{title='Cryo launch',body='Hyper cool tweet'}={}){
 const today=riyadhDate();
 await call('/api/calendar',{startDate:today},owner);
 const draft=await call('/api/content',{title,body,platform:'X',date:today,url:'https://hyper-cool.com/p'},owner);
 await call(`/api/content/${draft.data.id}/review`,{reviewer:'QA',evidence:'checked',facts:true,claims:true,link:true},owner);
 await call(`/api/content/${draft.data.id}/approve`,{},owner);
 return draft.data.id;
}

// --- X OAuth over HTTP (PKCE) ------------------------------------------------------------

test('X OAuth connect/disconnect over HTTP — PKCE round-trip, token never leaked, real identity stored',async()=>{
 const env={INTEGRATION_ENCRYPTION_KEY:key32,X_CLIENT_ID:'client-1',X_CLIENT_SECRET:'secret-1',X_REDIRECT_URI:'https://hyper-cool.com/cb'};
 const fetcher=async(url)=>{
  if(url.includes('/2/oauth2/token'))return new Response(JSON.stringify({access_token:'x-token',refresh_token:'x-refresh',expires_in:7200,scope:'tweet.read tweet.write users.read offline_access'}),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/2/users/me'))return new Response(JSON.stringify({data:{id:'acct-1',username:'hypercool',name:'HyperCool'}}),{status:200,headers:{'content-type':'application/json'}});
  throw new Error('unexpected '+url);
 };
 const {call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  const start=await call('/api/integrations/x/oauth/start',undefined,owner,{method:'GET'});
  assert.equal(start.status,302);
  const startUrl=new URL(start.location);
  assert.equal(startUrl.searchParams.get('code_challenge_method'),'S256');
  const state=startUrl.searchParams.get('state');
  const callback=await call(`/api/integrations/x/oauth/callback?code=code-1&state=${state}`,undefined,owner,{method:'GET'});
  assert.equal(callback.status,302);
  const status=await call('/api/integrations/x/oauth/status',undefined,owner,{method:'GET'});
  assert.equal(status.data.connected,true);
  assert.equal(status.data.username,'hypercool');
  assert.equal(JSON.stringify(status.data).includes('x-token'),false);
  assert.equal((await call('/api/integrations/x/disconnect',{},owner)).status,200);
  assert.equal((await call('/api/integrations/x/oauth/status',undefined,owner,{method:'GET'})).data.connected,false);
 }finally{await cleanup();}
});

// --- LinkedIn OAuth over HTTP --------------------------------------------------------------

test('LinkedIn OAuth connect/disconnect over HTTP — resolves the Company Page, never a personal-profile-only connection',async()=>{
 const env={INTEGRATION_ENCRYPTION_KEY:key32,LINKEDIN_CLIENT_ID:'client-1',LINKEDIN_CLIENT_SECRET:'secret-1',LINKEDIN_REDIRECT_URI:'https://hyper-cool.com/cb'};
 const fetcher=async(url)=>{
  if(url.includes('/oauth/v2/accessToken'))return new Response(JSON.stringify({access_token:'li-token',expires_in:5184000,scope:'openid,profile,email,w_organization_social,rw_organization_admin'}),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/v2/userinfo'))return new Response(JSON.stringify({sub:'user-1',name:'Owner',email:'owner@hyper-cool.com'}),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/v2/organizationAcls'))return new Response(JSON.stringify({elements:[{'organizationalTarget~':{id:555,localizedName:'HyperCool'}}]}),{status:200,headers:{'content-type':'application/json'}});
  throw new Error('unexpected '+url);
 };
 const {call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  const start=await call('/api/integrations/linkedin/oauth/start',undefined,owner,{method:'GET'});
  assert.equal(start.status,302);
  const state=new URL(start.location).searchParams.get('state');
  const callback=await call(`/api/integrations/linkedin/oauth/callback?code=code-1&state=${state}`,undefined,owner,{method:'GET'});
  assert.equal(callback.status,302);
  const status=await call('/api/integrations/linkedin/oauth/status',undefined,owner,{method:'GET'});
  assert.equal(status.data.connected,true);
  assert.equal(status.data.organization.id,'555');
  assert.equal(status.data.publishingCapable,true);
  assert.equal(JSON.stringify(status.data).includes('li-token'),false);
  assert.equal((await call('/api/integrations/linkedin/disconnect',{},owner)).status,200);
  assert.equal((await call('/api/integrations/linkedin/oauth/status',undefined,owner,{method:'GET'})).data.connected,false);
 }finally{await cleanup();}
});

// --- Full pipeline: Calendar -> Approval -> Scheduler -> Publishing agent -> real X post ---

test('E2E: an approved, due X post flows scheduler -> CONTENT_PUBLISH_REQUESTED -> Publishing agent -> real tweet, and becomes PUBLISHED end to end',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,X_CLIENT_ID:'client-1',X_CLIENT_SECRET:'secret-1',X_REDIRECT_URI:'https://hyper-cool.com/cb',ENABLE_L2_AUTONOMY:'true'};
 let tweetCalls=0;
 const fetcher=async(url,opts)=>{
  if(url.includes('/2/oauth2/token'))return new Response(JSON.stringify({access_token:'x-token',refresh_token:'x-refresh',expires_in:7200,scope:'tweet.read tweet.write users.read offline_access'}),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/2/users/me'))return new Response(JSON.stringify({data:{id:'acct-1',username:'hypercool',name:'HyperCool'}}),{status:200,headers:{'content-type':'application/json'}});
  if(url==='https://api.anthropic.com/v1/messages') {
   const body=JSON.parse(opts.body);
   const alreadyCalledTool=body.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result'));
   if(!alreadyCalledTool)return anthropicToolUse('call-1','x_publish',{contentId:body.messages[0].content?JSON.parse(body.messages[0].content).contentId:undefined});
   return anthropicText(publishingDecision());
  }
  if(url==='https://api.twitter.com/2/tweets'){tweetCalls++;return new Response(JSON.stringify({data:{id:'42',text:'hi'}}),{status:200,headers:{'content-type':'application/json'}});}
  throw new Error('unexpected '+url);
 };
 const {call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  await connectX(call,owner);
  const contentId=await approvedXContent(call,owner);
  await promoteAgent(call,owner,'publishing');
  const scheduledAt=new Date(Date.now()+1500).toISOString();
  const scheduled=await call('/api/schedule',{contentId,scheduledAt},owner);
  assert.equal(scheduled.status,201);
  await new Promise(resolve=>setTimeout(resolve,1700));
  const prepared=await call('/api/schedule/prepare',{},owner);
  assert.equal(prepared.data.ready,1);
  await new Promise(resolve=>setTimeout(resolve,200));
  const dashboard=await call('/api/content/dashboard',undefined,owner,{method:'GET'});
  const published=dashboard.data.pipeline.find(stage=>stage.stage==='PUBLISHED');
  assert.equal(published.cards.some(c=>c.id===contentId),true);
  assert.equal(tweetCalls,1);
  const jobs=await call('/api/planning',undefined,owner,{method:'GET'});
  const job=jobs.data.jobs.find(j=>j.contentId===contentId);
  assert.equal(job.status,'PUBLISHED');
  assert.equal(job.externalPostId,'42');
 }finally{await cleanup();}
});

test('Rejecting an already-scheduled item cancels its job immediately — prepareDue finds nothing due, never reaches the publishing agent or the network',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',ENABLE_L2_AUTONOMY:'true'};
 const fetcher=async(url)=>{throw new Error('must not call any external API for a cancelled job: '+url);};
 const {call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  const contentId=await approvedXContent(call,owner);
  await promoteAgent(call,owner,'publishing');
  const scheduledAt=new Date(Date.now()+1200).toISOString();
  await call('/api/schedule',{contentId,scheduledAt},owner);
  // Reject the already-approved-and-scheduled item before it becomes due (owner-only path) —
  // this cancels the schedule job immediately (see planning.js's change route calling
  // cancelJobs), so there is no lingering SCHEDULED/READY_FOR_CONNECTOR row for prepareDue
  // to ever act on: rejection removes the item from the publish pipeline outright rather
  // than leaving it to be discovered as BLOCKED later.
  await call(`/api/content/${contentId}/reject`,{reason:'Needs a pricing correction'},owner);
  const beforePrepare=await call('/api/planning',undefined,owner,{method:'GET'});
  assert.equal(beforePrepare.data.jobs.find(j=>j.contentId===contentId).status,'CANCELLED');
  await new Promise(resolve=>setTimeout(resolve,1400));
  const prepared=await call('/api/schedule/prepare',{},owner);
  assert.equal(prepared.data.ready,0);assert.equal(prepared.data.blocked,0);
  await new Promise(resolve=>setTimeout(resolve,150));
  const dashboard=await call('/api/content/dashboard',undefined,owner,{method:'GET'});
  assert.equal(dashboard.data.pipeline.find(s=>s.stage==='PUBLISHED').cards.length,0);
 }finally{await cleanup();}
});

test('L0 (default) autonomy: the Publishing agent runs on the due event but its tool call is FORBIDDEN — no real post, content stays APPROVED',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model'};
 const fetcher=async(url,opts)=>{
  if(url==='https://api.anthropic.com/v1/messages') {
   const body=JSON.parse(opts.body);
   const alreadyCalledTool=body.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result'));
   if(!alreadyCalledTool)return anthropicToolUse('call-1','x_publish',{contentId:JSON.parse(body.messages[0].content).contentId});
   return anthropicText(publishingDecision({error_code:'FORBIDDEN'}));
  }
  throw new Error('must never reach the real X API at L0: '+url);
 };
 const {call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  const contentId=await approvedXContent(call,owner);
  // Deliberately NOT promoting the publishing agent — stays at its default L0.
  const scheduledAt=new Date(Date.now()+1200).toISOString();
  await call('/api/schedule',{contentId,scheduledAt},owner);
  await new Promise(resolve=>setTimeout(resolve,1400));
  await call('/api/schedule/prepare',{},owner);
  await new Promise(resolve=>setTimeout(resolve,200));
  const runs=await call('/api/agents/publishing/runs',undefined,owner,{method:'GET'});
  assert.equal(runs.data.length,1);
  const detail=await call(`/api/agents/runs/${runs.data[0].id}`,undefined,owner,{method:'GET'});
  const publishCall=detail.data.toolCalls.find(t=>t.tool==='x_publish');
  assert.ok(publishCall);assert.equal(publishCall.status,'FORBIDDEN');assert.equal(publishCall.output.reason,'PERMISSION_LEVEL');
  const dashboard=await call('/api/content/dashboard',undefined,owner,{method:'GET'});
  assert.equal(dashboard.data.pipeline.find(s=>s.stage==='PUBLISHED').cards.length,0);
 }finally{await cleanup();}
});

test('A real API rejection (expired/invalid token) classifies as FAILED without crashing the run — content stays safely APPROVED',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,X_CLIENT_ID:'client-1',X_CLIENT_SECRET:'secret-1',X_REDIRECT_URI:'https://hyper-cool.com/cb',ENABLE_L2_AUTONOMY:'true'};
 const fetcher=async(url,opts)=>{
  if(url.includes('/2/oauth2/token'))return new Response(JSON.stringify({access_token:'x-token',refresh_token:'x-refresh',expires_in:7200,scope:'tweet.read tweet.write users.read offline_access'}),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/2/users/me'))return new Response(JSON.stringify({data:{id:'acct-1',username:'hypercool',name:'HyperCool'}}),{status:200,headers:{'content-type':'application/json'}});
  if(url==='https://api.anthropic.com/v1/messages') {
   const body=JSON.parse(opts.body);
   const alreadyCalledTool=body.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result'));
   if(!alreadyCalledTool)return anthropicToolUse('call-1','x_publish',{contentId:JSON.parse(body.messages[0].content).contentId});
   return anthropicText(publishingDecision({status:'BLOCKED',post_id:null,live_url:null,error_code:'AUTH_FAILED'}));
  }
  if(url==='https://api.twitter.com/2/tweets')return new Response(JSON.stringify({title:'Unauthorized',status:401}),{status:401,headers:{'content-type':'application/json'}});
  throw new Error('unexpected '+url);
 };
 const {call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  await connectX(call,owner);
  const contentId=await approvedXContent(call,owner);
  await promoteAgent(call,owner,'publishing');
  const scheduledAt=new Date(Date.now()+1200).toISOString();
  await call('/api/schedule',{contentId,scheduledAt},owner);
  await new Promise(resolve=>setTimeout(resolve,1400));
  await call('/api/schedule/prepare',{},owner);
  await new Promise(resolve=>setTimeout(resolve,200));
  const dashboard=await call('/api/content/dashboard',undefined,owner,{method:'GET'});
  assert.equal(dashboard.data.pipeline.find(s=>s.stage==='PUBLISHED').cards.length,0);
  const jobs=await call('/api/planning',undefined,owner,{method:'GET'});
  const job=jobs.data.jobs.find(j=>j.contentId===contentId);
  assert.equal(job.status,'FAILED');
 }finally{await cleanup();}
});
