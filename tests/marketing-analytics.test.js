import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

// Phase MKT-2, Part F — real, normalized, tenant-scoped marketing analytics built on the
// EXISTING publish tools (meta_publish/x_publish/linkedin_publish) and the per-post metrics
// fetchers already present in the codebase (getLinkedInPostMetrics/getXPostMetrics) plus the
// new Meta insights fetchers added alongside this file. Every test here goes through the REAL
// OAuth connect -> approve -> schedule -> publish path (mirroring tests/x-linkedin-api.test.js
// and tests/meta-whatsapp-api.test.js) so a genuine externalPostId exists before analytics
// sync is ever exercised — no shortcut DB inserts standing in for a real publish.
const key32=randomBytes(32).toString('hex');
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const anthropicText=value=>json({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(value)}],usage:{input_tokens:3,output_tokens:3}});
const anthropicToolUse=(id,name,input)=>json({stop_reason:'tool_use',content:[{type:'tool_use',id,name,input}],usage:{input_tokens:3,output_tokens:3}});
const publishingDecision=(over={})=>({status:'OK',action:'PUBLISH',rationale:'Published the due, approved post',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{platform:'X',scheduled_at:null,published_at:new Date().toISOString(),post_id:'42',live_url:'https://x.com/i/web/status/42',idempotency_key:'k',retry_count:0,error_code:null,...over}});

async function harness(env,fetcher) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-mkt-analytics-'));
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
async function promoteAgent(call,owner,agentId,fromVersion=0) {
 await call(`/api/agents/${agentId}/autonomy`,{level:'L1',reason:'test promotion',expectedVersion:fromVersion},owner);
 await call(`/api/agents/${agentId}/autonomy`,{level:'L2',reason:'test promotion',expectedVersion:fromVersion+1},owner);
}
async function approvedContent(call,owner,{platform,body,englishCopy,assetUrl}) {
 const today=new Date().toISOString().slice(0,10);
 await call('/api/calendar',{startDate:today},owner);
 const draft=await call('/api/content',{title:'Analytics test post',body,englishCopy,assetUrl,platform,date:today,url:'https://hyper-cool.com/p'},owner);
 assert.equal(draft.status,201,JSON.stringify(draft.data));
 await call(`/api/content/${draft.data.id}/review`,{reviewer:'QA',evidence:'checked',facts:true,claims:true,link:true,...(assetUrl?{asset:true}:{})},owner);
 const approved=await call(`/api/content/${draft.data.id}/approve`,{},owner);
 assert.equal(approved.status,200,JSON.stringify(approved.data));
 return draft.data.id;
}
async function connectX(call,owner) {
 const start=await call('/api/integrations/x/oauth/start',undefined,owner,{method:'GET'});
 const state=new URL(start.location).searchParams.get('state');
 const callback=await call(`/api/integrations/x/oauth/callback?code=code-1&state=${state}`,undefined,owner,{method:'GET'});
 assert.equal(callback.status,302);
}
async function connectLinkedIn(call,owner) {
 const start=await call('/api/integrations/linkedin/oauth/start',undefined,owner,{method:'GET'});
 const state=new URL(start.location).searchParams.get('state');
 const callback=await call(`/api/integrations/linkedin/oauth/callback?code=code-1&state=${state}`,undefined,owner,{method:'GET'});
 assert.equal(callback.status,302);
}
async function connectMeta(call,owner) {
 const start=await call('/api/integrations/meta/oauth/start',undefined,owner,{method:'GET'});
 const state=new URL(start.location).searchParams.get('state');
 const callback=await call(`/api/integrations/meta/oauth/callback?code=code-1&state=${state}`,undefined,owner,{method:'GET'});
 assert.equal(callback.status,302);
}
async function publishDueContent(call,contentId,owner) {
 const scheduledAt=new Date(Date.now()+1200).toISOString();
 const scheduled=await call('/api/schedule',{contentId,scheduledAt},owner);
 assert.equal(scheduled.status,201,JSON.stringify(scheduled.data));
 await new Promise(resolve=>setTimeout(resolve,1400));
 await call('/api/schedule/prepare',{},owner);
 await new Promise(resolve=>setTimeout(resolve,250));
}
function anthropicToolThenDecision(toolName,decision) {
 return async(url,opts)=>{
  const body=JSON.parse(opts.body);
  const alreadyCalledTool=body.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result'));
  if(!alreadyCalledTool)return anthropicToolUse('call-1',toolName,{contentId:body.messages[0].content?JSON.parse(body.messages[0].content).contentId:undefined});
  return anthropicText(decision);
 };
}

test('Part F — X: syncing analytics after a real published tweet records real per-post metrics and a real follower snapshot',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,X_CLIENT_ID:'client-1',X_CLIENT_SECRET:'secret-1',X_REDIRECT_URI:'https://hyper-cool.com/cb',ENABLE_L2_AUTONOMY:'true',PLATFORM_MAIL_TRANSPORT:'capture'};
 let tweetCalls=0;
 const fetcher=async(url,opts)=>{
  if(url.includes('/2/oauth2/token'))return json({access_token:'x-token',refresh_token:'x-refresh',expires_in:7200,scope:'tweet.read tweet.write users.read offline_access'});
  if(url==='https://api.twitter.com/2/users/me')return json({data:{id:'acct-1',username:'hypercool',name:'HyperCool'}});
  if(url==='https://api.anthropic.com/v1/messages')return anthropicToolThenDecision('x_publish',publishingDecision({post_id:'42',live_url:'https://x.com/i/web/status/42'}))(url,opts);
  if(url==='https://api.twitter.com/2/tweets'){tweetCalls++;return json({data:{id:'42',text:'hi'}});}
  if(url.includes('/2/tweets/42?tweet.fields=public_metrics'))return json({data:{id:'42',public_metrics:{impression_count:1000,like_count:50,reply_count:5,retweet_count:10}}});
  if(url.includes('/2/users/me?user.fields=public_metrics'))return json({data:{id:'acct-1',public_metrics:{followers_count:777}}});
  throw new Error('unexpected x url '+url);
 };
 const {call,app,cleanup}=await harness(env,fetcher);
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'anx1',email:'anx1@example.com',companyName:'Analytics X'});
  await connectX(call,owner);
  const contentId=await approvedContent(call,owner,{platform:'X',body:'Hyper cool tweet'});
  await promoteAgent(call,owner,'publishing');
  await publishDueContent(call,contentId,owner);
  assert.equal(tweetCalls,1);
  const sync=await call('/api/marketing/analytics/sync',{},owner);
  assert.equal(sync.status,200,JSON.stringify(sync.data));
  assert.equal(sync.data.syncedPosts,1);
  assert.equal(sync.data.followers.x,777);
  const summary=await call('/api/marketing/analytics/summary',undefined,owner,{method:'GET'});
  const x=summary.data.providers.find(p=>p.provider==='x');
  assert.equal(x.connected,true);
  assert.equal(x.metrics.impressions,1000);
  assert.equal(x.metrics.followers,777);
  assert.equal(x.metrics.likes,50);
  assert.ok(x.metrics.engagement_rate>0 && x.metrics.engagement_rate<1);
  const meta=summary.data.providers.find(p=>p.provider==='meta');
  assert.equal(meta.connected,false);
  assert.equal(meta.metrics,null);
 } finally { await cleanup(); }
});

test('Part F — LinkedIn: a real published organization post syncs real share statistics and follower count',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,LINKEDIN_CLIENT_ID:'client-1',LINKEDIN_CLIENT_SECRET:'secret-1',LINKEDIN_REDIRECT_URI:'https://hyper-cool.com/cb',ENABLE_L2_AUTONOMY:'true',PLATFORM_MAIL_TRANSPORT:'capture'};
 let ugcCalls=0;
 const fetcher=async(url,opts)=>{
  if(url.includes('/oauth/v2/accessToken'))return json({access_token:'li-token',expires_in:5184000,scope:'openid,profile,email,w_organization_social,rw_organization_admin'});
  if(url.includes('/v2/userinfo'))return json({sub:'user-1',name:'Owner',email:'owner@hyper-cool.com'});
  if(url.includes('/v2/organizationAcls'))return json({elements:[{'organizationalTarget~':{id:555,localizedName:'HyperCool'}}]});
  if(url==='https://api.anthropic.com/v1/messages')return anthropicToolThenDecision('linkedin_publish',publishingDecision({platform:'LinkedIn',post_id:'urn:li:share:999',live_url:'https://www.linkedin.com/feed/update/urn:li:share:999/'}))(url,opts);
  if(url==='https://api.linkedin.com/v2/ugcPosts'){ugcCalls++;return new Response(null,{status:201,headers:{'x-restli-id':'urn:li:share:999'}});}
  if(url.includes('organizationalEntityShareStatistics'))return json({elements:[{totalShareStatistics:{impressionCount:800,uniqueImpressionsCount:600,engagement:40,likeCount:30,commentCount:4,shareCount:2,clickCount:9}}]});
  if(url.includes('organizationalEntityFollowerStatistics'))return json({elements:[{followerCounts:{organicFollowerCount:390,paidFollowerCount:10}}]});
  throw new Error('unexpected linkedin url '+url);
 };
 const {call,app,cleanup}=await harness(env,fetcher);
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'anli1',email:'anli1@example.com',companyName:'Analytics LinkedIn'});
  await connectLinkedIn(call,owner);
  const contentId=await approvedContent(call,owner,{platform:'LinkedIn',body:'LinkedIn body copy',englishCopy:'Real English copy for LinkedIn'});
  await promoteAgent(call,owner,'publishing');
  await publishDueContent(call,contentId,owner);
  assert.equal(ugcCalls,1);
  const sync=await call('/api/marketing/analytics/sync',{},owner);
  assert.equal(sync.status,200,JSON.stringify(sync.data));
  assert.equal(sync.data.syncedPosts,1);
  assert.equal(sync.data.followers.linkedin,400);
  const summary=await call('/api/marketing/analytics/summary',undefined,owner,{method:'GET'});
  const linkedin=summary.data.providers.find(p=>p.provider==='linkedin');
  assert.equal(linkedin.connected,true);
  assert.equal(linkedin.metrics.impressions,800);
  assert.equal(linkedin.metrics.reach,600);
  assert.equal(linkedin.metrics.followers,400);
 } finally { await cleanup(); }
});

test('Part F — Meta: a real published Instagram post syncs real media insights plus both Facebook and Instagram follower counts',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,META_APP_ID:'app-1',META_APP_SECRET:'secret-1',META_REDIRECT_URI:'https://hyper-cool.com/cb',ENABLE_L2_AUTONOMY:'true',PLATFORM_MAIL_TRANSPORT:'capture'};
 let publishCalls=0;
 const fetcher=async(url,opts)=>{
  if(url.includes('fb_exchange_token'))return json({access_token:'long-token',expires_in:5184000});
  if(url.includes('/oauth/access_token'))return json({access_token:'short-token',expires_in:3600});
  if(url.includes('/me/accounts'))return json({data:[{id:'page-1',name:'HyperCool',access_token:'page-secret',instagram_business_account:{id:'ig-1',username:'hypercool'}}]});
  if(url==='https://api.anthropic.com/v1/messages')return anthropicToolThenDecision('meta_publish',publishingDecision({platform:'Instagram',post_id:'ig-post-1',live_url:'https://www.instagram.com/p/ig-post-1/'}))(url,opts);
  if(url.includes('/ig-1/media_publish')){publishCalls++;return json({id:'ig-post-1'});}
  if(url.includes('/ig-1/media'))return json({id:'container-1'});
  if(url.includes('/ig-post-1/insights')) {
   const metric=new URL(url).searchParams.get('metric');
   const values={impressions:900,reach:700,engagement:60,saved:8};
   return json({data:[{name:metric,values:[{value:values[metric]}]}]});
  }
  if(url.includes('/page-1?fields=fan_count'))return json({fan_count:321});
  if(url.includes('/ig-1?fields=followers_count'))return json({followers_count:456});
  throw new Error('unexpected meta url '+url);
 };
 const {call,app,cleanup}=await harness(env,fetcher);
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'anme1',email:'anme1@example.com',companyName:'Analytics Meta'});
  await connectMeta(call,owner);
  const contentId=await approvedContent(call,owner,{platform:'Instagram',body:'Instagram caption',assetUrl:'https://hyper-cool.com/img.jpg'});
  await promoteAgent(call,owner,'publishing');
  await publishDueContent(call,contentId,owner);
  assert.equal(publishCalls,1);
  const sync=await call('/api/marketing/analytics/sync',{},owner);
  assert.equal(sync.status,200,JSON.stringify(sync.data));
  assert.equal(sync.data.syncedPosts,1);
  assert.equal(sync.data.followers.meta,321+456);
  const summary=await call('/api/marketing/analytics/summary',undefined,owner,{method:'GET'});
  const meta=summary.data.providers.find(p=>p.provider==='meta');
  assert.equal(meta.connected,true);
  assert.equal(meta.metrics.impressions,900);
  assert.equal(meta.metrics.reach,700);
 } finally { await cleanup(); }
});

test('Part F — honesty: a provider metrics failure records zero fabricated metrics and shows NOT AVAILABLE, not a fake zero',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,X_CLIENT_ID:'client-1',X_CLIENT_SECRET:'secret-1',X_REDIRECT_URI:'https://hyper-cool.com/cb',ENABLE_L2_AUTONOMY:'true',PLATFORM_MAIL_TRANSPORT:'capture'};
 const fetcher=async(url,opts)=>{
  if(url.includes('/2/oauth2/token'))return json({access_token:'x-token',refresh_token:'x-refresh',expires_in:7200,scope:'tweet.read tweet.write users.read offline_access'});
  if(url==='https://api.twitter.com/2/users/me')return json({data:{id:'acct-1',username:'hypercool',name:'HyperCool'}});
  if(url==='https://api.anthropic.com/v1/messages')return anthropicToolThenDecision('x_publish',publishingDecision())(url,opts);
  if(url==='https://api.twitter.com/2/tweets')return json({data:{id:'42',text:'hi'}});
  // Real, common outcome: the app's tier does not include tweet metrics (client-not-enrolled) —
  // a genuine 403, never converted into an estimated value.
  if(url.includes('/2/tweets/42?tweet.fields=public_metrics'))return json({title:'Forbidden',detail:'client-not-enrolled'},403);
  if(url.includes('/2/users/me?user.fields=public_metrics'))return json({title:'Forbidden'},403);
  throw new Error('unexpected x url '+url);
 };
 const {call,app,cleanup}=await harness(env,fetcher);
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'anx2',email:'anx2@example.com',companyName:'Analytics X Honesty'});
  await connectX(call,owner);
  const contentId=await approvedContent(call,owner,{platform:'X',body:'Another tweet'});
  await promoteAgent(call,owner,'publishing');
  await publishDueContent(call,contentId,owner);
  const sync=await call('/api/marketing/analytics/sync',{},owner);
  assert.equal(sync.status,200);
  assert.equal(sync.data.syncedPosts,0);
  assert.equal(sync.data.unavailablePosts,1);
  assert.equal(sync.data.followers.x,null);
  const summary=await call('/api/marketing/analytics/summary',undefined,owner,{method:'GET'});
  const x=summary.data.providers.find(p=>p.provider==='x');
  assert.equal(x.connected,false);
  assert.equal(x.metrics,null);
  const audit=app.store.db.prepare("SELECT * FROM audit_logs WHERE action='MARKETING_ANALYTICS_SYNC_UNAVAILABLE' ORDER BY created_at DESC LIMIT 1").get();
  assert.ok(audit);
 } finally { await cleanup(); }
});

test('Part F — tenant isolation: Tenant A\'s published post and synced analytics never appear for Tenant B',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,X_CLIENT_ID:'client-1',X_CLIENT_SECRET:'secret-1',X_REDIRECT_URI:'https://hyper-cool.com/cb',ENABLE_L2_AUTONOMY:'true',PLATFORM_MAIL_TRANSPORT:'capture'};
 const fetcher=async(url,opts)=>{
  if(url.includes('/2/oauth2/token'))return json({access_token:'x-token',refresh_token:'x-refresh',expires_in:7200,scope:'tweet.read tweet.write users.read offline_access'});
  if(url==='https://api.twitter.com/2/users/me')return json({data:{id:'acct-1',username:'hypercool',name:'HyperCool'}});
  if(url==='https://api.anthropic.com/v1/messages')return anthropicToolThenDecision('x_publish',publishingDecision())(url,opts);
  if(url==='https://api.twitter.com/2/tweets')return json({data:{id:'42',text:'hi'}});
  if(url.includes('/2/tweets/42?tweet.fields=public_metrics'))return json({data:{id:'42',public_metrics:{impression_count:1000,like_count:50,reply_count:5,retweet_count:10}}});
  if(url.includes('/2/users/me?user.fields=public_metrics'))return json({data:{id:'acct-1',public_metrics:{followers_count:777}}});
  throw new Error('unexpected x url '+url);
 };
 const {call,app,cleanup}=await harness(env,fetcher);
 try {
  const ownerA=await signupAndCreateWorkspace(call,app,{username:'anisoa',email:'anisoa@example.com',companyName:'Analytics Iso A'});
  const ownerB=await signupAndCreateWorkspace(call,app,{username:'anisob',email:'anisob@example.com',companyName:'Analytics Iso B'});
  await connectX(call,ownerA);
  const contentId=await approvedContent(call,ownerA,{platform:'X',body:'Tenant A tweet'});
  await promoteAgent(call,ownerA,'publishing');
  await publishDueContent(call,contentId,ownerA);
  const syncA=await call('/api/marketing/analytics/sync',{},ownerA);
  assert.equal(syncA.data.syncedPosts,1);
  const summaryA=await call('/api/marketing/analytics/summary',undefined,ownerA,{method:'GET'});
  assert.equal(summaryA.data.providers.find(p=>p.provider==='x').connected,true);
  // Tenant B never connected X and never published anything — its own sync/summary must show
  // zero leakage from Tenant A's real, already-synced data.
  const syncB=await call('/api/marketing/analytics/sync',{},ownerB);
  assert.equal(syncB.status,200);
  assert.equal(syncB.data.syncedPosts,0);
  const summaryB=await call('/api/marketing/analytics/summary',undefined,ownerB,{method:'GET'});
  assert.equal(summaryB.data.providers.find(p=>p.provider==='x').connected,false);
  assert.equal(summaryB.data.hasAnyData,false);
 } finally { await cleanup(); }
});

test('Part F — analytics sync is gated to owner/operator, but the read-only summary is open to any tenant member',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_MAIL_TRANSPORT:'capture'};
 const {call,app,cleanup}=await harness(env);
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'anrole1',email:'anrole1@example.com',companyName:'Analytics Roles'});
  const invite=await call('/api/workspaces/invitations',{email:'reviewer-an1@example.com',role:'reviewer'},owner);
  const register=await call(`/api/invitations/${invite.data.token}/register`,{username:'reviewerAn1',name:'مراجع',password:'a-long-test-password'},null);
  const reviewer={cookie:register.cookie,csrf:register.data.csrf};
  const deniedSync=await call('/api/marketing/analytics/sync',{},reviewer);
  assert.equal(deniedSync.status,403);
  const allowedSummary=await call('/api/marketing/analytics/summary',undefined,reviewer,{method:'GET'});
  assert.equal(allowedSummary.status,200);
 } finally { await cleanup(); }
});
