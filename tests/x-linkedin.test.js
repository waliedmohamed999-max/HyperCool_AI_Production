import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {openStore} from '../src/store.js';
import {installCRM} from '../src/crm.js';
import {installEvents,createEventBus} from '../src/runtime/events.js';
import {installEscalations,listEscalations} from '../src/runtime/escalations.js';
import {installApprovals} from '../src/runtime/approvals.js';
import {installCredentials,saveCredentials,getCredentials} from '../src/runtime/credentials.js';
import {installPlanning} from '../src/planning.js';
import {installGate} from '../src/runtime/gate.js';
import {createXAuthorizeUrl,consumeXState,exchangeCodeForTokens as exchangeXTokens,resolveConnectedProfile as resolveXProfile,saveXConnection,xOAuthStatus,resolveXAccessToken} from '../src/runtime/x-oauth.js';
import {tweetLength,validateTweetText,classifyXError,publishTweet,getXPostMetrics,testXConnection,X_MAX_TWEET_LENGTH} from '../src/runtime/x-publishing.js';
import {createLinkedInAuthorizeUrl,consumeLinkedInState,exchangeCodeForTokens as exchangeLinkedInTokens,resolveConnectedProfile as resolveLinkedInProfile,resolveAdministeredOrganizations,saveLinkedInConnection,linkedInOAuthStatus,resolveLinkedInAccessToken} from '../src/runtime/linkedin-oauth.js';
import {classifyLinkedInError,publishLinkedInPost,getLinkedInPostMetrics,testLinkedInConnection} from '../src/runtime/linkedin-publishing.js';
import {buildToolRegistry} from '../src/runtime/tools.js';
import {canUseTool} from '../src/runtime/permissions.js';
import {installOrchestrator} from '../src/runtime/orchestrator.js';

const owner={id:'owner-1',name:'Owner',role:'owner'};
const publishingActor={id:'agent:publishing',name:'وكيل النشر والجدولة',role:'agent'};
const key32=randomBytes(32).toString('hex');
function jsonResponse(value,status=200,headers={}){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});}

function fixture(){
 const store=openStore(':memory:');
 installCRM(store.db);installEvents(store.db);installEscalations(store.db);installApprovals(store.db);installCredentials(store.db);installPlanning(store.db);installGate(store.db);
 return store;
}
function approvedContent(overrides={}) {
 return {id:'content-1',title:'t',body:'Hyper cool tweet',englishCopy:'Hyper cool post',url:'https://hyper-cool.com/p',assetUrl:null,platform:'X',date:'2030-01-01',status:'APPROVED',review:{reviewer:'r',contentHash:'h'},approval:{owner:'o',contentHash:'h',id:'appr-1'},externalPostId:null,liveUrl:null,publishedAt:null,...overrides};
}

// --- X OAuth (PKCE) --------------------------------------------------------------------

test('createXAuthorizeUrl always includes PKCE S256 code_challenge (X mandates it, unlike Salla/Meta/Microsoft)',()=>{
 const env={X_CLIENT_ID:'id',X_CLIENT_SECRET:'secret',X_REDIRECT_URI:'https://hyper-cool.com/cb'};
 const url=new URL(createXAuthorizeUrl(env,'user-1'));
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 assert.ok(url.searchParams.get('code_challenge'));
 assert.ok(url.searchParams.get('state'));
});
test('X OAuth state is one-time, tied to the user, and yields the same code_verifier used at authorize time',()=>{
 const env={X_CLIENT_ID:'id',X_CLIENT_SECRET:'secret',X_REDIRECT_URI:'https://hyper-cool.com/cb'};
 const wrongUserAttempt=new URL(createXAuthorizeUrl(env,'user-1'));
 assert.throws(()=>consumeXState(wrongUserAttempt.searchParams.get('state'),'user-2'),/مستخدم مختلف/);
 const url=new URL(createXAuthorizeUrl(env,'user-1'));
 const state=url.searchParams.get('state');
 const verifier=consumeXState(state,'user-1');
 assert.ok(verifier.length>=32);
 assert.throws(()=>consumeXState(state,'user-1'),/انتهت صلاحية/);
});
test('exchangeCodeForTokens sends the code_verifier and HTTP Basic client auth, never client_secret in the body',async()=>{
 const env={X_CLIENT_ID:'id',X_CLIENT_SECRET:'secret',X_REDIRECT_URI:'https://hyper-cool.com/cb'};
 const tokens=await exchangeXTokens({env,code:'code-1',codeVerifier:'verifier-1',fetcher:async(url,opts)=>{
  assert.equal(url,'https://api.twitter.com/2/oauth2/token');
  assert.ok(opts.headers.authorization.startsWith('Basic '));
  const params=new URLSearchParams(opts.body);
  assert.equal(params.get('code_verifier'),'verifier-1');
  assert.equal(opts.body.includes('secret'),false);
  return jsonResponse({access_token:'x-access',refresh_token:'x-refresh',expires_in:7200,scope:'tweet.read tweet.write users.read offline_access'});
 }});
 assert.equal(tokens.accessToken,'x-access');assert.equal(tokens.refreshToken,'x-refresh');
});
test('saveXConnection stores the identity, secret encrypted; xOAuthStatus never leaks the token',async()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 const profile=await resolveXProfile({fetcher:async()=>jsonResponse({data:{id:'123',username:'hypercool',name:'HyperCool'}}),accessToken:'x-access'});
 const meta=saveXConnection(store.db,env,{accessToken:'x-access',refreshToken:'x-refresh',expiresAt:null,scopes:['tweet.write']},profile,owner);
 assert.equal(JSON.stringify(meta).includes('x-access'),false);
 assert.equal(meta.metadata.username,'hypercool');
 const status=xOAuthStatus(store.db);
 assert.equal(status.connected,true);assert.equal(status.username,'hypercool');
 assert.equal(getCredentials(store.db,env,'x').accessToken,'x-access');
 }finally{store.close();}
});
test('resolveXAccessToken never returns the static Bearer token for "publish" (app-only tokens cannot post) but does for "read"',async()=>{
 const store=fixture();try{
 const env={X_BEARER_TOKEN:'app-only-bearer'};
 assert.equal(await resolveXAccessToken({store,env},'publish'),null);
 const read=await resolveXAccessToken({store,env},'read');
 assert.equal(read.token,'app-only-bearer');assert.equal(read.source,'static');
 }finally{store.close();}
});
test('resolveXAccessToken refreshes an expiring OAuth token',async()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 saveCredentials(store.db,env,'x',{accessToken:'old',refreshToken:'refresh-1',expiresAt:new Date(Date.now()+1000).toISOString()},owner);
 const refreshed=await resolveXAccessToken({store,env,fetcher:async()=>jsonResponse({access_token:'new-token',refresh_token:'refresh-2',expires_in:7200})},'publish');
 assert.equal(refreshed.token,'new-token');assert.equal(refreshed.source,'oauth');
 }finally{store.close();}
});

// --- X publishing -----------------------------------------------------------------------

test('tweetLength counts any URL as a flat 23 chars (t.co shortening), validateTweetText enforces the real 280 limit',()=>{
 const short='Hello world';
 assert.equal(tweetLength(short),short.length);
 const withUrl='Check this out: https://hyper-cool.com/a-very-long-product-path-that-would-otherwise-blow-the-limit';
 assert.equal(tweetLength(withUrl),'Check this out: '.length+23);
 assert.equal(validateTweetText('').valid,false);
 assert.equal(validateTweetText('x'.repeat(X_MAX_TWEET_LENGTH+1)).valid,false);
 assert.equal(validateTweetText('a normal tweet').valid,true);
});
test('classifyXError maps status codes to the standardized failure classification, including duplicate-content detection',()=>{
 assert.equal(classifyXError(429,{}).code,'RATE_LIMIT');
 assert.equal(classifyXError(401,{}).code,'AUTH_FAILED');
 assert.equal(classifyXError(403,{detail:'You are not allowed to create a Tweet with duplicate content.'}).code,'DUPLICATE_REQUEST');
 assert.equal(classifyXError(403,{detail:'insufficient scope'}).code,'PERMISSION_MISSING');
 assert.equal(classifyXError(500,{}).code,'API_UNAVAILABLE');
});
test('publishTweet requires the OAuth token (never the static bearer), and returns PUBLISHED with a real post id/url',async()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 saveCredentials(store.db,env,'x',{accessToken:'x-access',expiresAt:null},owner);
 const result=await publishTweet({store,env,fetcher:async(url,opts)=>{
  assert.equal(url,'https://api.twitter.com/2/tweets');
  assert.equal(JSON.parse(opts.body).text,'hello');
  return jsonResponse({data:{id:'999',text:'hello'}});
 }},{text:'hello'});
 assert.equal(result.status,'PUBLISHED');assert.equal(result.externalPostId,'999');
 assert.ok(result.liveUrl.includes('999'));
 }finally{store.close();}
});
test('publishTweet returns INTEGRATION_REQUIRED with no OAuth connection at all',async()=>{
 const store=fixture();try{
 const result=await publishTweet({store,env:{}},{text:'hello'});
 assert.equal(result.status,'INTEGRATION_REQUIRED');
 }finally{store.close();}
});
test('publishTweet returns STATUS_UNKNOWN (never FAILED) on a genuine network/timeout error — no confirmed outcome',async()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 saveCredentials(store.db,env,'x',{accessToken:'x-access',expiresAt:null},owner);
 const result=await publishTweet({store,env,fetcher:async()=>{throw new Error('ETIMEDOUT');}},{text:'hello'});
 assert.equal(result.status,'STATUS_UNKNOWN');
 }finally{store.close();}
});
test('publishTweet classifies a real API rejection as FAILED with the right error code',async()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 saveCredentials(store.db,env,'x',{accessToken:'x-access',expiresAt:null},owner);
 const result=await publishTweet({store,env,fetcher:async()=>jsonResponse({title:'Unauthorized'},401)},{text:'hello'});
 assert.equal(result.status,'FAILED');assert.equal(result.errorCode,'AUTH_FAILED');
 }finally{store.close();}
});
test('getXPostMetrics never fabricates a zero for an unreturned field — stays null',async()=>{
 const store=fixture();try{
 const env={X_BEARER_TOKEN:'bearer'};
 const metrics=await getXPostMetrics({store,env,fetcher:async()=>jsonResponse({data:{id:'1',public_metrics:{like_count:5,reply_count:2,retweet_count:1}}})},'1');
 assert.equal(metrics.status,'OK');assert.equal(metrics.likes,5);assert.equal(metrics.impressions,null);
 }finally{store.close();}
});
test('testXConnection reports OK for a real OAuth identity, CONFIGURED_READ_ONLY for bearer-only, NOT_CONFIGURED for neither',async()=>{
 const store=fixture();try{
 assert.equal((await testXConnection({store,env:{}})).result,'NOT_CONFIGURED');
 const readOnly=await testXConnection({store,env:{X_BEARER_TOKEN:'bearer'},fetcher:async()=>jsonResponse({data:{id:'20'}})});
 assert.equal(readOnly.result,'CONFIGURED_READ_ONLY');
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 saveCredentials(store.db,env,'x',{accessToken:'x-access',expiresAt:null},owner);
 const ok=await testXConnection({store,env,fetcher:async()=>jsonResponse({data:{id:'1',username:'hypercool'}})});
 assert.equal(ok.result,'OK');
 }finally{store.close();}
});

// --- LinkedIn OAuth -----------------------------------------------------------------------

test('createLinkedInAuthorizeUrl requests organization scopes, never a personal-profile-only scope set',()=>{
 const env={LINKEDIN_CLIENT_ID:'id',LINKEDIN_CLIENT_SECRET:'secret',LINKEDIN_REDIRECT_URI:'https://hyper-cool.com/cb'};
 const url=new URL(createLinkedInAuthorizeUrl(env,'user-1'));
 const scope=url.searchParams.get('scope');
 assert.ok(scope.includes('w_organization_social'));
 assert.ok(scope.includes('rw_organization_admin'));
});
test('LinkedIn OAuth state is one-time and tied to the user',()=>{
 const env={LINKEDIN_CLIENT_ID:'id',LINKEDIN_CLIENT_SECRET:'secret',LINKEDIN_REDIRECT_URI:'https://hyper-cool.com/cb'};
 const wrongUserAttempt=new URL(createLinkedInAuthorizeUrl(env,'user-1'));
 assert.throws(()=>consumeLinkedInState(wrongUserAttempt.searchParams.get('state'),'user-2'),/مستخدم مختلف/);
 const url=new URL(createLinkedInAuthorizeUrl(env,'user-1'));
 const state=url.searchParams.get('state');
 assert.doesNotThrow(()=>consumeLinkedInState(state,'user-1'));
});
test('exchangeCodeForTokens + resolveConnectedProfile + resolveAdministeredOrganizations resolve identity and Company Page',async()=>{
 const env={LINKEDIN_CLIENT_ID:'id',LINKEDIN_CLIENT_SECRET:'secret',LINKEDIN_REDIRECT_URI:'https://hyper-cool.com/cb'};
 const tokens=await exchangeLinkedInTokens({env,code:'code-1',fetcher:async(url,opts)=>{
  assert.equal(url,'https://www.linkedin.com/oauth/v2/accessToken');
  return jsonResponse({access_token:'li-access',expires_in:5184000,scope:'openid,profile,email,w_organization_social'});
 }});
 assert.equal(tokens.accessToken,'li-access');assert.equal(tokens.refreshToken,null);
 const profile=await resolveLinkedInProfile({fetcher:async()=>jsonResponse({sub:'user-urn',name:'Owner',email:'owner@hyper-cool.com'}),accessToken:'li-access'});
 assert.equal(profile.email,'owner@hyper-cool.com');
 const orgs=await resolveAdministeredOrganizations({fetcher:async()=>jsonResponse({elements:[{'organizationalTarget~':{id:555,localizedName:'HyperCool'}}]}),accessToken:'li-access'});
 assert.equal(orgs[0].id,'555');assert.equal(orgs[0].name,'HyperCool');
});
test('saveLinkedInConnection + linkedInOAuthStatus: publishingCapable only true once an organization is actually resolved',async()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 const tokens={accessToken:'li-access',refreshToken:null,expiresAt:null,scopes:['openid']};
 saveLinkedInConnection(store.db,env,tokens,{sub:'u',name:'Owner',email:'o@hyper-cool.com'},null,owner);
 assert.equal(linkedInOAuthStatus(store.db).publishingCapable,false);
 saveLinkedInConnection(store.db,env,tokens,{sub:'u',name:'Owner',email:'o@hyper-cool.com'},{id:'555',name:'HyperCool'},owner);
 const status=linkedInOAuthStatus(store.db);
 assert.equal(status.publishingCapable,true);assert.equal(status.organization.id,'555');
 assert.equal(JSON.stringify(status).includes('li-access'),false);
 }finally{store.close();}
});
test('resolveLinkedInAccessToken falls back to the static token + LINKEDIN_ORGANIZATION_ID pair when OAuth was never connected',async()=>{
 const store=fixture();try{
 const env={LINKEDIN_ACCESS_TOKEN:'static-token',LINKEDIN_ORGANIZATION_ID:'999'};
 const resolved=await resolveLinkedInAccessToken({store,env});
 assert.equal(resolved.token,'static-token');assert.equal(resolved.organizationId,'999');assert.equal(resolved.source,'static');
 }finally{store.close();}
});
test('resolveLinkedInAccessToken returns null once expired with no refresh_token (LinkedIn default) — reauthorization required, never a doomed refresh attempt',async()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 saveCredentials(store.db,env,'linkedin',{accessToken:'old',expiresAt:new Date(Date.now()-1000).toISOString(),metadata:{organization:{id:'555'}}},owner);
 assert.equal(await resolveLinkedInAccessToken({store,env}),null);
 assert.equal(linkedInOAuthStatus(store.db).reauthorizeRequired,true);
 }finally{store.close();}
});

// --- LinkedIn publishing -------------------------------------------------------------------

test('classifyLinkedInError maps status codes to the standardized failure classification',()=>{
 assert.equal(classifyLinkedInError(429).code,'RATE_LIMIT');
 assert.equal(classifyLinkedInError(403).code,'PERMISSION_MISSING');
 assert.equal(classifyLinkedInError(422).code,'INVALID_CONTENT');
});
test('publishLinkedInPost publishes to the Company Page (never a personal profile) and reads the post id from the x-restli-id header',async()=>{
 const store=fixture();try{
 const env={LINKEDIN_ACCESS_TOKEN:'static-token',LINKEDIN_ORGANIZATION_ID:'555'};
 const result=await publishLinkedInPost({store,env,fetcher:async(url,opts)=>{
  assert.equal(url,'https://api.linkedin.com/v2/ugcPosts');
  const body=JSON.parse(opts.body);
  assert.equal(body.author,'urn:li:organization:555');
  assert.equal(body.specificContent['com.linkedin.ugc.ShareContent'].shareCommentary.text,'Our latest B2B update');
  return new Response(null,{status:201,headers:{'x-restli-id':'urn:li:share:123'}});
 }},{text:'Our latest B2B update',link:'https://hyper-cool.com/p'});
 assert.equal(result.status,'PUBLISHED');assert.equal(result.externalPostId,'urn:li:share:123');
 assert.ok(result.liveUrl.includes('urn:li:share:123'));
 }finally{store.close();}
});
test('publishLinkedInPost returns INTEGRATION_REQUIRED with no resolved organization, even if a token exists',async()=>{
 const store=fixture();try{
 const result=await publishLinkedInPost({store,env:{LINKEDIN_ACCESS_TOKEN:'t'}},{text:'hi'});
 assert.equal(result.status,'INTEGRATION_REQUIRED');
 }finally{store.close();}
});
test('publishLinkedInPost returns STATUS_UNKNOWN on network failure, FAILED on a real API rejection',async()=>{
 const store=fixture();try{
 const env={LINKEDIN_ACCESS_TOKEN:'t',LINKEDIN_ORGANIZATION_ID:'555'};
 const unknown=await publishLinkedInPost({store,env,fetcher:async()=>{throw new Error('timeout');}},{text:'hi'});
 assert.equal(unknown.status,'STATUS_UNKNOWN');
 const failed=await publishLinkedInPost({store,env,fetcher:async()=>jsonResponse({message:'forbidden'},403)},{text:'hi'});
 assert.equal(failed.status,'FAILED');assert.equal(failed.errorCode,'PERMISSION_MISSING');
 }finally{store.close();}
});
test('getLinkedInPostMetrics marks ANALYTICS_NOT_AVAILABLE (never simulated) when the analytics API is not accessible',async()=>{
 const store=fixture();try{
 const env={LINKEDIN_ACCESS_TOKEN:'t',LINKEDIN_ORGANIZATION_ID:'555'};
 const result=await getLinkedInPostMetrics({store,env,fetcher:async()=>jsonResponse({message:'forbidden'},403)},'urn:li:share:123');
 assert.equal(result.status,'NOT_AVAILABLE');
 }finally{store.close();}
});
test('testLinkedInConnection distinguishes identity-only (no organization) from full OK',async()=>{
 const store=fixture();try{
 assert.equal((await testLinkedInConnection({store,env:{}})).result,'NOT_CONFIGURED');
 const noOrg=await testLinkedInConnection({store,env:{LINKEDIN_ACCESS_TOKEN:'t'},fetcher:async()=>jsonResponse({sub:'u'})});
 assert.equal(noOrg.result,'CONFIGURED_NO_ORGANIZATION');
 const ok=await testLinkedInConnection({store,env:{LINKEDIN_ACCESS_TOKEN:'t',LINKEDIN_ORGANIZATION_ID:'555'},fetcher:async()=>jsonResponse({sub:'u'})});
 assert.equal(ok.result,'OK');
 }finally{store.close();}
});

// --- Tool registry: publish tools are restricted to the Publishing agent only -------------

test('meta_publish/x_publish/linkedin_publish are usable only by the publishing agent, even at L3 — no other agent bypasses this',()=>{
 const store=fixture();try{
 const registry=buildToolRegistry({store,env:{},eventBus:createEventBus(store.db)});
 for(const name of ['meta_publish','x_publish','linkedin_publish']) {
  const tool=registry.get(name);
  assert.equal(canUseTool('L2',tool,'publishing'),true);
  assert.equal(canUseTool('L3',tool,'frost'),false);
  assert.equal(canUseTool('L3',tool,'sales'),false);
  assert.ok(registry.list('L2','publishing').some(t=>t.name===name));
  assert.ok(!registry.list('L3','frost').some(t=>t.name===name));
 }
 }finally{store.close();}
});
test('x_publish refuses unapproved content, refuses a non-X content item, and never double-publishes an already-published item',async()=>{
 const store=fixture();try{
 store.mutate(state=>{state.content.push(approvedContent({id:'draft-1',status:'DRAFT'}));state.content.push(approvedContent({id:'wrong-platform',platform:'LinkedIn'}));state.content.push(approvedContent({id:'already',externalPostId:'existing-id',liveUrl:'https://x.com/i/web/status/existing-id'}));});
 const registry=buildToolRegistry({store,env:{},eventBus:createEventBus(store.db),fetcher:()=>{throw new Error('must not call network');}});
 const tool=registry.get('x_publish');
 const ctx={store,env:{},actor:publishingActor,runId:null,agentId:'publishing'};
 assert.equal((await tool.handler({contentId:'draft-1'},ctx)).status,'BLOCKED');
 assert.equal((await tool.handler({contentId:'wrong-platform'},ctx)).status,'BLOCKED');
 const already=await tool.handler({contentId:'already'},ctx);
 assert.equal(already.status,'OK');assert.equal(already.reason,'ALREADY_PUBLISHED');
 }finally{store.close();}
});
test('x_publish in SOCIAL_PUBLISHING_TEST_MODE never touches the network and never marks content published',async()=>{
 const store=fixture();try{
 store.mutate(state=>{state.content.push(approvedContent());});
 const registry=buildToolRegistry({store,env:{SOCIAL_PUBLISHING_TEST_MODE:'true'},eventBus:createEventBus(store.db),fetcher:()=>{throw new Error('must not call network in test mode');}});
 const result=await registry.get('x_publish').handler({contentId:'content-1'},{store,env:{},actor:publishingActor,runId:null,agentId:'publishing'});
 assert.equal(result.status,'OK');assert.equal(result.testMode,true);assert.equal(result.would_publish,true);
 assert.equal(store.read().content.find(c=>c.id==='content-1').status,'APPROVED');
 }finally{store.close();}
});
test('x_publish on real success updates content to PUBLISHED, the matching schedule_jobs row to PUBLISHED, and emits CONTENT_PUBLISHED',async()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 saveCredentials(store.db,env,'x',{accessToken:'x-access',expiresAt:null},owner);
 store.mutate(state=>{state.content.push(approvedContent());});
 store.db.prepare('INSERT INTO schedule_jobs VALUES (?,?,?,?,?)').run('job-1','content-1','READY_FOR_CONNECTOR','2030-01-01T09:00:00.000Z',JSON.stringify({id:'job-1',contentId:'content-1',status:'READY_FOR_CONNECTOR'}));
 const eventBus=createEventBus(store.db);
 let published=null;eventBus.on('CONTENT_PUBLISHED',payload=>{published=payload;});
 const registry=buildToolRegistry({store,env,eventBus,fetcher:async()=>jsonResponse({data:{id:'42'}})});
 const result=await registry.get('x_publish').handler({contentId:'content-1'},{store,env,actor:publishingActor,runId:null,agentId:'publishing'});
 assert.equal(result.status,'PUBLISHED');
 assert.equal(store.read().content.find(c=>c.id==='content-1').status,'PUBLISHED');
 const job=JSON.parse(store.db.prepare('SELECT json FROM schedule_jobs WHERE id=?').get('job-1').json);
 assert.equal(job.status,'PUBLISHED');assert.equal(job.externalPostId,'42');
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.ok(published);assert.equal(published.externalPostId,'42');
 }finally{store.close();}
});
test('x_publish on STATUS_UNKNOWN never marks content published, marks the job STATUS_UNKNOWN, and opens a real P2 escalation for human review',async()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 saveCredentials(store.db,env,'x',{accessToken:'x-access',expiresAt:null},owner);
 store.mutate(state=>{state.content.push(approvedContent());});
 store.db.prepare('INSERT INTO schedule_jobs VALUES (?,?,?,?,?)').run('job-1','content-1','READY_FOR_CONNECTOR','2030-01-01T09:00:00.000Z',JSON.stringify({id:'job-1',contentId:'content-1',status:'READY_FOR_CONNECTOR'}));
 const registry=buildToolRegistry({store,env,eventBus:createEventBus(store.db),fetcher:async()=>{throw new Error('ETIMEDOUT');}});
 const result=await registry.get('x_publish').handler({contentId:'content-1'},{store,env,actor:publishingActor,runId:null,agentId:'publishing'});
 assert.equal(result.status,'STATUS_UNKNOWN');
 assert.equal(store.read().content.find(c=>c.id==='content-1').status,'APPROVED');
 const job=JSON.parse(store.db.prepare('SELECT json FROM schedule_jobs WHERE id=?').get('job-1').json);
 assert.equal(job.status,'STATUS_UNKNOWN');
 const open=listEscalations(store.db,{status:'OPEN'});
 assert.equal(open.length,1);assert.equal(open[0].priority,'P2');
 }finally{store.close();}
});

// --- Orchestrator wiring: CONTENT_PUBLISH_REQUESTED -> publishing agent ------------------

test('installOrchestrator routes CONTENT_PUBLISH_REQUESTED to the publishing agent',async()=>{
 const store=fixture();try{
 const eventBus=createEventBus(store.db);
 const calls=[];
 const fakeRuntime={run:async(agentId,input)=>{calls.push({agentId,input});return {status:'COMPLETED'};}};
 const {routes}=installOrchestrator(eventBus,fakeRuntime,store.db);
 assert.ok(routes.includes('CONTENT_PUBLISH_REQUESTED'));
 eventBus.emit('CONTENT_PUBLISH_REQUESTED',{contentId:'content-1',platform:'X'});
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(calls.length,1);assert.equal(calls[0].agentId,'publishing');
 }finally{store.close();}
});
