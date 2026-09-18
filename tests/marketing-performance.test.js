import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

// Phase MKT-2, Part G/H — the EXISTING performance agent (#11, agents/performance.md), run for
// real over real analytics data (see tests/marketing-analytics.test.js for how that data is
// produced honestly), with its recommendation stored (never auto-applied) and a controlled,
// human-triggered path from a recommendation to a brand-new DRAFT content item.
const key32=randomBytes(32).toString('hex');
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const anthropicText=value=>json({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(value)}],usage:{input_tokens:3,output_tokens:3}});
const anthropicToolUse=(id,name,input)=>json({stop_reason:'tool_use',content:[{type:'tool_use',id,name,input}],usage:{input_tokens:3,output_tokens:3}});
const publishingDecision=(over={})=>({status:'OK',action:'PUBLISH',rationale:'Published the due, approved post',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{platform:'X',scheduled_at:null,published_at:new Date().toISOString(),post_id:'42',live_url:'https://x.com/i/web/status/42',idempotency_key:'k',retry_count:0,error_code:null,...over}});
const performanceDecision=(over={})=>({status:'OK',action:'ANALYZE',rationale:'تحليل حقيقي للأداء',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{data_quality:'كافية لتحليل أولي',KPI_summary:[{platform:'X',impressions:1000,engagement_rate:0.065}],top_wins:['تفاعل جيد على X'],top_issues:['لا توجد بيانات Meta/LinkedIn بعد'],
  funnel_bottleneck:null,possible_drivers:['وقت النشر'],stop_doing:[],double_down:['المحتوى النصي القصير على X'],
  experiments_next_week:[{hypothesis:'تغيير وقت النشر يرفع الوصول',change:'انشر الساعة 8 مساءً بدلاً من الظهر',primary_metric:'impressions',guardrail_metric:'engagement_rate',duration_or_sample:'أسبوعين',success_threshold:'+15% impressions'}],
  data_gaps:['لا يوجد ربط Meta/LinkedIn بعد'],...over}});

async function harness(env,fetcher) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-mkt-perf-'));
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
async function connectX(call,owner) {
 const start=await call('/api/integrations/x/oauth/start',undefined,owner,{method:'GET'});
 const state=new URL(start.location).searchParams.get('state');
 const callback=await call(`/api/integrations/x/oauth/callback?code=code-1&state=${state}`,undefined,owner,{method:'GET'});
 assert.equal(callback.status,302);
}
async function publishRealTweetAndSync(call,owner) {
 const today=new Date().toISOString().slice(0,10);
 await call('/api/calendar',{startDate:today},owner);
 const draft=await call('/api/content',{title:'Perf test post',body:'Hyper cool tweet',platform:'X',date:today,url:'https://hyper-cool.com/p'},owner);
 await call(`/api/content/${draft.data.id}/review`,{reviewer:'QA',evidence:'checked',facts:true,claims:true,link:true},owner);
 await call(`/api/content/${draft.data.id}/approve`,{},owner);
 await promoteAgent(call,owner,'publishing');
 const scheduledAt=new Date(Date.now()+1200).toISOString();
 await call('/api/schedule',{contentId:draft.data.id,scheduledAt},owner);
 await new Promise(resolve=>setTimeout(resolve,1400));
 await call('/api/schedule/prepare',{},owner);
 await new Promise(resolve=>setTimeout(resolve,250));
 const sync=await call('/api/marketing/analytics/sync',{},owner);
 assert.equal(sync.data.syncedPosts,1);
}
function fullFetcher() {
 return async(url,opts)=>{
  if(url.includes('/2/oauth2/token'))return json({access_token:'x-token',refresh_token:'x-refresh',expires_in:7200,scope:'tweet.read tweet.write users.read offline_access'});
  if(url==='https://api.twitter.com/2/users/me')return json({data:{id:'acct-1',username:'hypercool',name:'HyperCool'}});
  if(url==='https://api.anthropic.com/v1/messages') {
   const bodyText=typeof opts?.body==='string'?opts.body:'';
   if(bodyText.includes('Performance & Growth Agent'))return anthropicText(performanceDecision());
   const reqBody=JSON.parse(opts.body);
   const alreadyCalledTool=reqBody.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result'));
   if(!alreadyCalledTool)return anthropicToolUse('call-1','x_publish',{contentId:reqBody.messages[0].content?JSON.parse(reqBody.messages[0].content).contentId:undefined});
   return anthropicText(publishingDecision());
  }
  if(url==='https://api.twitter.com/2/tweets')return json({data:{id:'42',text:'hi'}});
  if(url.includes('/2/tweets/42?tweet.fields=public_metrics'))return json({data:{id:'42',public_metrics:{impression_count:1000,like_count:65,reply_count:0,retweet_count:0}}});
  if(url.includes('/2/users/me?user.fields=public_metrics'))return json({data:{id:'acct-1',public_metrics:{followers_count:500}}});
  throw new Error('unexpected url '+url);
 };
}

test('Part G — a performance review is refused without any real analytics data yet',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',PLATFORM_MAIL_TRANSPORT:'capture'};
 const {call,app,cleanup}=await harness(env);
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'perf1',email:'perf1@example.com',companyName:'Perf Test 1'});
  const review=await call('/api/marketing/performance/review',{},owner);
  assert.equal(review.status,409);
 } finally { await cleanup(); }
});

test('Part G — a real performance review runs the existing performance agent over real synced analytics and stores evidence + recommendation',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,X_CLIENT_ID:'client-1',X_CLIENT_SECRET:'secret-1',X_REDIRECT_URI:'https://hyper-cool.com/cb',ENABLE_L2_AUTONOMY:'true',PLATFORM_MAIL_TRANSPORT:'capture'};
 const {call,app,cleanup}=await harness(env,fullFetcher());
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'perf2',email:'perf2@example.com',companyName:'Perf Test 2'});
  await connectX(call,owner);
  await publishRealTweetAndSync(call,owner);
  const campaign=await call('/api/marketing/campaigns',{name:'X Awareness'},owner);
  const review=await call('/api/marketing/performance/review',{campaignId:campaign.data.id},owner);
  assert.equal(review.status,201,JSON.stringify(review.data));
  assert.equal(review.data.review.status,'NEW');
  assert.equal(review.data.review.campaignId,campaign.data.id);
  assert.equal(review.data.review.evidence.providers.find(p=>p.provider==='x').connected,true);
  assert.equal(review.data.review.result.double_down.length>0,true);
  assert.equal(review.data.review.result.experiments_next_week[0].hypothesis.length>0,true);
  const list=await call('/api/marketing/performance/reviews',undefined,owner,{method:'GET'});
  assert.equal(list.data.length,1);
  assert.equal(list.data[0].id,review.data.review.id);
  const status=await call(`/api/marketing/performance/reviews/${review.data.review.id}/status`,{status:'ACKNOWLEDGED'},owner);
  assert.equal(status.data.status,'ACKNOWLEDGED');
 } finally { await cleanup(); }
});

test('Part H — acting on a recommendation creates a brand-new DRAFT content item, never an auto-published or auto-modified one',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,X_CLIENT_ID:'client-1',X_CLIENT_SECRET:'secret-1',X_REDIRECT_URI:'https://hyper-cool.com/cb',ENABLE_L2_AUTONOMY:'true',PLATFORM_MAIL_TRANSPORT:'capture'};
 const {call,app,cleanup}=await harness(env,fullFetcher());
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'perf3',email:'perf3@example.com',companyName:'Perf Test 3'});
  await connectX(call,owner);
  await publishRealTweetAndSync(call,owner);
  const review=await call('/api/marketing/performance/review',{},owner);
  const created=await call(`/api/marketing/performance/reviews/${review.data.review.id}/create-content`,{channel:'X',format:'post',hook:'وقت نشر جديد',body:'انشر مساءً لزيادة الوصول',cta:'جرّب الآن'},owner);
  assert.equal(created.status,201,JSON.stringify(created.data));
  assert.equal(created.data.status,'DRAFT');
  assert.equal(created.data.publishedAt,null);
  const audit=app.store.db.prepare("SELECT * FROM audit_logs WHERE action='MARKETING_CONTENT_CREATED_FROM_RECOMMENDATION' AND item_id=?").get(created.data.id);
  assert.ok(audit);
  const detail=JSON.parse(audit.json).detail;
  assert.equal(detail.reviewId,review.data.review.id);
 } finally { await cleanup(); }
});

test('Part G/H — tenant isolation: Tenant B never sees Tenant A\'s performance reviews or recommendation-derived content',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,X_CLIENT_ID:'client-1',X_CLIENT_SECRET:'secret-1',X_REDIRECT_URI:'https://hyper-cool.com/cb',ENABLE_L2_AUTONOMY:'true',PLATFORM_MAIL_TRANSPORT:'capture'};
 const {call,app,cleanup}=await harness(env,fullFetcher());
 try {
  const ownerA=await signupAndCreateWorkspace(call,app,{username:'perfisoa',email:'perfisoa@example.com',companyName:'Perf Iso A'});
  const ownerB=await signupAndCreateWorkspace(call,app,{username:'perfisob',email:'perfisob@example.com',companyName:'Perf Iso B'});
  await connectX(call,ownerA);
  await publishRealTweetAndSync(call,ownerA);
  const reviewA=await call('/api/marketing/performance/review',{},ownerA);
  assert.equal(reviewA.status,201);
  const listB=await call('/api/marketing/performance/reviews',undefined,ownerB,{method:'GET'});
  assert.equal(listB.data.length,0);
  const getFromB=await call(`/api/marketing/performance/reviews/${reviewA.data.review.id}`,undefined,ownerB,{method:'GET'});
  assert.equal(getFromB.status,404);
  const reviewFromB=await call('/api/marketing/performance/review',{},ownerB);
  assert.equal(reviewFromB.status,409); // Tenant B has no synced analytics of its own
 } finally { await cleanup(); }
});

test('Part G/H — reviewer role can read reviews but cannot trigger a review or create content from one',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',PLATFORM_MAIL_TRANSPORT:'capture'};
 const {call,app,cleanup}=await harness(env);
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'perfrole1',email:'perfrole1@example.com',companyName:'Perf Roles'});
  const invite=await call('/api/workspaces/invitations',{email:'reviewer-perf1@example.com',role:'reviewer'},owner);
  const register=await call(`/api/invitations/${invite.data.token}/register`,{username:'reviewerPerf1',name:'مراجع',password:'a-long-test-password'},null);
  const reviewer={cookie:register.cookie,csrf:register.data.csrf};
  const deniedReview=await call('/api/marketing/performance/review',{},reviewer);
  assert.equal(deniedReview.status,403);
  const allowedList=await call('/api/marketing/performance/reviews',undefined,reviewer,{method:'GET'});
  assert.equal(allowedList.status,200);
  const deniedCreate=await call('/api/marketing/performance/reviews/nonexistent/create-content',{channel:'X',format:'post',body:'x'},reviewer);
  assert.equal(deniedCreate.status,403);
 } finally { await cleanup(); }
});

test('Part O — tenant isolation: Tenant B cannot change the status of, or create content from, Tenant A\'s performance review',async()=>{
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',INTEGRATION_ENCRYPTION_KEY:key32,X_CLIENT_ID:'client-1',X_CLIENT_SECRET:'secret-1',X_REDIRECT_URI:'https://hyper-cool.com/cb',ENABLE_L2_AUTONOMY:'true',PLATFORM_MAIL_TRANSPORT:'capture'};
 const {call,app,cleanup}=await harness(env,fullFetcher());
 try {
  const ownerA=await signupAndCreateWorkspace(call,app,{username:'perfsecoa',email:'perfsecoa@example.com',companyName:'Perf Sec A'});
  const ownerB=await signupAndCreateWorkspace(call,app,{username:'perfsecob',email:'perfsecob@example.com',companyName:'Perf Sec B'});
  await connectX(call,ownerA);
  await publishRealTweetAndSync(call,ownerA);
  const review=await call('/api/marketing/performance/review',{},ownerA);
  assert.equal(review.status,201);
  const crossStatus=await call(`/api/marketing/performance/reviews/${review.data.review.id}/status`,{status:'ACKNOWLEDGED'},ownerB);
  assert.equal(crossStatus.status,404);
  const crossCreate=await call(`/api/marketing/performance/reviews/${review.data.review.id}/create-content`,{channel:'X',format:'post',body:'x'},ownerB);
  assert.equal(crossCreate.status,404);
 } finally { await cleanup(); }
});
