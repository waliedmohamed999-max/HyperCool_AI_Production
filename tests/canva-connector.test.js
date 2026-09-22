import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.js';
import {installCredentials} from '../src/runtime/credentials.js';
import {createApp} from '../src/application.js';
import {createCanvaAuthorizeUrl,consumeCanvaState,exchangeCodeForTokens as exchangeCanvaTokens,resolveConnectedProfile as resolveCanvaProfile,saveCanvaConnection,canvaOAuthStatus,resolveCanvaAccessToken,canvaOAuthConfigured} from '../src/runtime/canva-oauth.js';
import {canvaAdapter} from '../src/connectors/canva/adapter.js';

const key32=randomBytes(32).toString('hex');
const env={INTEGRATION_ENCRYPTION_KEY:key32,CANVA_CLIENT_ID:'client-1',CANVA_CLIENT_SECRET:'secret-1',CANVA_REDIRECT_URI:'https://hyper-cool.com/callback/canva'};
const user={id:'owner-1',name:'Owner'};

function fixture(){
 const store=openStore(':memory:');
 installCredentials(store.db);
 return store;
}

// --- Low-level OAuth mechanics -------------------------------------------------------------

test('createCanvaAuthorizeUrl always includes PKCE S256 code_challenge (Canva mandates it, same as X)',()=>{
 const url=new URL(createCanvaAuthorizeUrl(env,user.id));
 assert.equal(url.origin+url.pathname,'https://www.canva.com/api/oauth/authorize');
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 assert.ok(url.searchParams.get('code_challenge'));
 assert.equal(url.searchParams.get('client_id'),'client-1');
 assert.equal(url.searchParams.get('scope'),'profile:read');
});

test('createCanvaAuthorizeUrl throws CANVA_OAUTH_NOT_CONFIGURED with no client credentials',()=>{
 assert.equal(canvaOAuthConfigured({}),false);
 assert.throws(()=>createCanvaAuthorizeUrl({},user.id),/CANVA_OAUTH_NOT_CONFIGURED/);
});

test('Canva OAuth state is one-time, tied to the user, and yields the same code_verifier used at authorize time',()=>{
 const url=new URL(createCanvaAuthorizeUrl(env,user.id));
 const state=url.searchParams.get('state');
 const verifier=consumeCanvaState(state,user.id);
 assert.ok(verifier);
 assert.throws(()=>consumeCanvaState(state,user.id),/انتهت صلاحية/); // one-time
 const url2=new URL(createCanvaAuthorizeUrl(env,user.id));
 const state2=url2.searchParams.get('state');
 assert.throws(()=>consumeCanvaState(state2,'someone-else'),/مستخدم مختلف/);
});

test('exchangeCodeForTokens sends the code_verifier and HTTP Basic client auth, never client_secret in the body',async()=>{
 let seen=null;
 const fetcher=async(url,options)=>{
  seen={url,body:options.body,authorization:options.headers.authorization};
  return new Response(JSON.stringify({access_token:'canva-access-1',refresh_token:'canva-refresh-1',expires_in:3600,scope:'profile:read'}),{status:200,headers:{'content-type':'application/json'}});
 };
 const tokens=await exchangeCanvaTokens({env,fetcher,code:'auth-code-1',codeVerifier:'verifier-1'});
 assert.equal(seen.url,'https://api.canva.com/rest/v1/oauth/token');
 assert.equal(seen.authorization,'Basic '+Buffer.from('client-1:secret-1').toString('base64'));
 assert.ok(!seen.body.includes('secret-1')); // client_secret only ever in the Basic auth header, never the body
 assert.ok(seen.body.includes('code_verifier=verifier-1'));
 assert.equal(tokens.accessToken,'canva-access-1');
 assert.equal(tokens.refreshToken,'canva-refresh-1');
});

test('saveCanvaConnection stores the identity, secret encrypted; canvaOAuthStatus never leaks the token',async()=>{
 const store=fixture();try{
  saveCanvaConnection(store.db,env,{accessToken:'canva-secret-token',refreshToken:'r1',expiresAt:'2030-01-01T00:00:00.000Z',scopes:['profile:read']},{id:'team-user-1',teamId:'team-1'},user);
  const status=canvaOAuthStatus(store.db);
  assert.equal(status.connected,true);
  assert.equal(JSON.stringify(status).includes('canva-secret-token'),false);
  assert.deepEqual(status.scopes,['profile:read']);
  const raw=store.db.prepare('SELECT access_token_enc FROM integration_credentials WHERE provider=?').get('canva');
  assert.ok(!raw.access_token_enc.includes('canva-secret-token'));
 }finally{store.close();}
});

test('resolveCanvaAccessToken refreshes an expiring OAuth token and persists the new one',async()=>{
 const store=fixture();try{
  saveCanvaConnection(store.db,env,{accessToken:'old-token',refreshToken:'refresh-1',expiresAt:new Date(Date.now()+60000).toISOString(),scopes:['profile:read']},{id:'team-user-1'},user);
  const fetcher=async()=>new Response(JSON.stringify({access_token:'new-token',refresh_token:'refresh-2',expires_in:3600,scope:'profile:read'}),{status:200,headers:{'content-type':'application/json'}});
  const resolved=await resolveCanvaAccessToken({store,env,fetcher});
  assert.equal(resolved.token,'new-token');
  assert.equal(resolved.source,'oauth');
 }finally{store.close();}
});

test('resolveCanvaAccessToken returns null with no connection at all — never guesses',async()=>{
 const store=fixture();try{
  const resolved=await resolveCanvaAccessToken({store,env,fetcher:async()=>{throw new Error('must not be called');}});
  assert.equal(resolved,null);
 }finally{store.close();}
});

// --- Adapter healthCheck --------------------------------------------------------------------

test('canvaAdapter.healthCheck: OK for a real identity response, AUTH_FAILED on a real 401, NOT_CONFIGURED with no credential at all',async()=>{
 const ok=await canvaAdapter.healthCheck({fetcher:async()=>new Response(JSON.stringify({team_user:{user_id:'u1',team_id:'t1'}}),{status:200,headers:{'content-type':'application/json'}}),credential:{payload:{accessToken:'good-token'}}});
 assert.equal(ok.status,'OK');
 const authFailed=await canvaAdapter.healthCheck({fetcher:async()=>new Response(JSON.stringify({error:'unauthorized'}),{status:401,headers:{'content-type':'application/json'}}),credential:{payload:{accessToken:'bad-token'}}});
 assert.equal(authFailed.status,'AUTH_FAILED');
 const notConfigured=await canvaAdapter.healthCheck({fetcher:async()=>{throw new Error('must not be called');},credential:null});
 assert.equal(notConfigured.status,'NOT_CONFIGURED');
});

// --- Full HTTP OAuth round trip --------------------------------------------------------------

async function httpHarness(env,fetcher){
 const directory=await mkdtemp(join(tmpdir(),'hypercool-canva-'));
 const app=await createApp({dataDir:directory,env,...(fetcher?{fetcher}:{})});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}){
  const res=await fetch(base+path,{method:method||(input?'POST':'GET'),redirect:'manual',headers:{...(input!==undefined?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(input!==undefined?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf,location:res.headers.get('location')};
 }
 return {app,base,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}

test('Canva OAuth: full connect flow (start -> callback) stores encrypted credentials visible only as metadata, state is one-time, and disconnect clears them',async()=>{
 let tokenCalls=0;
 const fetcher=async(url)=>{
  if(url==='https://api.canva.com/rest/v1/oauth/token') {
   tokenCalls++;
   return new Response(JSON.stringify({access_token:'real-canva-access-token',refresh_token:'real-canva-refresh-token',expires_in:3600,scope:'profile:read'}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(url==='https://api.canva.com/rest/v1/users/me')
   return new Response(JSON.stringify({team_user:{user_id:'u-real-1',team_id:'t-real-1'}}),{status:200,headers:{'content-type':'application/json'}});
  throw new Error('unexpected network call to '+url);
 };
 const {call,cleanup}=await httpHarness({INTEGRATION_ENCRYPTION_KEY:key32,CANVA_CLIENT_ID:'client-1',CANVA_CLIENT_SECRET:'secret-1',CANVA_REDIRECT_URI:'https://hyper-cool.com/callback/canva'},fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  const operator=await call('/api/users',{username:'operator1',name:'Op',password:'a-long-test-password',role:'operator'},owner);
  assert.equal(operator.status,201);
  const opSession=await call('/api/login',{username:'operator1',password:'a-long-test-password'});
  assert.equal((await call('/api/integrations/canva/oauth/start',undefined,opSession,{method:'GET'})).status,403);

  const start=await call('/api/integrations/canva/oauth/start',undefined,owner,{method:'GET'});
  assert.equal(start.status,302);
  const state=new URL(start.location).searchParams.get('state');
  assert.ok(state);

  const statusBefore=await call('/api/integrations/canva/oauth/status',undefined,owner,{method:'GET'});
  assert.equal(statusBefore.data.connected,false);

  const callback=await call(`/api/integrations/canva/oauth/callback?code=auth-code-1&state=${state}`,undefined,owner,{method:'GET'});
  assert.equal(callback.status,302);
  assert.equal(tokenCalls,1);

  const statusAfter=await call('/api/integrations/canva/oauth/status',undefined,owner,{method:'GET'});
  assert.equal(statusAfter.data.connected,true);
  assert.equal(JSON.stringify(statusAfter.data).includes('real-canva-access-token'),false);
  assert.deepEqual(statusAfter.data.scopes,['profile:read']);

  const reuse=await call(`/api/integrations/canva/oauth/callback?code=auth-code-2&state=${state}`,undefined,owner,{method:'GET'});
  assert.equal(reuse.status,400);
  assert.equal(tokenCalls,1);

  assert.equal((await call('/api/integrations/canva/disconnect',{},owner)).status,200);
  const statusAfterDisconnect=await call('/api/integrations/canva/oauth/status',undefined,owner,{method:'GET'});
  assert.equal(statusAfterDisconnect.data.connected,false);
 }finally{await cleanup();}
});
