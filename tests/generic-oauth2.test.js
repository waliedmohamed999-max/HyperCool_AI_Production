import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createTenant} from '../src/tenancy.js';
import {createAuth} from '../src/auth.js';
import {
 genericOAuth2Configured,createGenericAuthorizeUrl,exchangeGenericCodeForTokens,
 refreshGenericTokens,resolveGenericIdentity,resolveGenericOAuth2Credential
} from '../src/runtime/generic-oauth2.js';
import {createDraftConnector,publishConnector} from '../src/connectors/dynamic/builder.js';

// Phase 6G, Part 18-24 — the Generic Approved OAuth2 Framework: function-level proof
// (mirroring the depth of the existing zid-oauth.test.js/x-linkedin-api.test.js suites) plus
// one real HTTP round-trip proving a brand-new OAuth2 connector needs ZERO code in
// application.js beyond what already exists.
const key32=randomBytes(32).toString('hex');
const AUTH={
 type:'OAUTH2',authorizeUrl:'https://oauth-provider.test/authorize',tokenUrl:'https://oauth-provider.test/token',
 scopes:['read_orders'],pkce:false,clientAuthMethod:'body',
 clientIdEnvKey:'ACME2_CLIENT_ID',clientSecretEnvKey:'ACME2_CLIENT_SECRET',
 identityEndpoint:'https://oauth-provider.test/me'
};
const ENV={ACME2_CLIENT_ID:'real-client-id',ACME2_CLIENT_SECRET:'real-client-secret'};

test('genericOAuth2Configured is false without real env credentials, true with them',()=>{
 assert.equal(genericOAuth2Configured({},AUTH),false);
 assert.equal(genericOAuth2Configured(ENV,AUTH),true);
});

test('createGenericAuthorizeUrl builds the exact declared authorizeUrl with client_id/redirect_uri/scope/state, PKCE only if declared',()=>{
 const url=new URL(createGenericAuthorizeUrl(AUTH,ENV,'state-123',{redirectUri:'https://app.test/api/integrations/oauth/acme2/callback'}));
 assert.equal(url.origin+url.pathname,'https://oauth-provider.test/authorize');
 assert.equal(url.searchParams.get('client_id'),'real-client-id');
 assert.equal(url.searchParams.get('redirect_uri'),'https://app.test/api/integrations/oauth/acme2/callback');
 assert.equal(url.searchParams.get('scope'),'read_orders');
 assert.equal(url.searchParams.get('state'),'state-123');
 assert.equal(url.searchParams.has('code_challenge'),false,'PKCE fields must never appear unless auth.pkce is true');

 const pkceUrl=new URL(createGenericAuthorizeUrl({...AUTH,pkce:true},ENV,'state-456',{redirectUri:'https://app.test/cb',codeVerifier:'a-real-verifier'}));
 assert.equal(pkceUrl.searchParams.get('code_challenge_method'),'S256');
 assert.ok(pkceUrl.searchParams.get('code_challenge').length>20);
});

test('exchangeGenericCodeForTokens: body client auth puts client_id/secret in the POST body, basic auth uses an Authorization header instead',async()=>{
 let capturedBody=null,capturedHeaders=null;
 const fetcher=async(url,options)=>{capturedBody=options.body;capturedHeaders=options.headers;return {ok:true,json:async()=>({access_token:'at-1',refresh_token:'rt-1',expires_in:3600,scope:'read_orders'})};};
 const tokens=await exchangeGenericCodeForTokens(AUTH,ENV,fetcher,{code:'the-code',redirectUri:'https://app.test/cb'});
 assert.equal(tokens.accessToken,'at-1');assert.equal(tokens.refreshToken,'rt-1');
 assert.ok(new URLSearchParams(capturedBody).get('client_secret'),'body auth mode must include client_secret in the form body');
 assert.equal(capturedHeaders.authorization,undefined);

 const basicFetcher=async(url,options)=>{capturedHeaders=options.headers;capturedBody=options.body;return {ok:true,json:async()=>({access_token:'at-2',expires_in:60})};};
 await exchangeGenericCodeForTokens({...AUTH,clientAuthMethod:'basic'},ENV,basicFetcher,{code:'c2',redirectUri:'https://app.test/cb'});
 assert.ok(capturedHeaders.authorization.startsWith('Basic '));
 assert.equal(new URLSearchParams(capturedBody).get('client_secret'),null,'basic auth mode must never also put the secret in the body');
});

test('exchangeGenericCodeForTokens: a real 401 classifies as CREDENTIALS_REJECTED, never a silent success',async()=>{
 const fetcher=async()=>({ok:false,status:401,json:async()=>({error:'invalid_grant'})});
 await assert.rejects(exchangeGenericCodeForTokens(AUTH,ENV,fetcher,{code:'bad',redirectUri:'https://app.test/cb'}),/CREDENTIALS_REJECTED/);
});

test('refreshGenericTokens posts grant_type=refresh_token with the real stored refresh token',async()=>{
 let captured=null;
 const fetcher=async(url,options)=>{captured=options.body;return {ok:true,json:async()=>({access_token:'at-new',refresh_token:'rt-new',expires_in:3600})};};
 const tokens=await refreshGenericTokens(AUTH,ENV,fetcher,'the-real-refresh-token');
 assert.equal(new URLSearchParams(captured).get('grant_type'),'refresh_token');
 assert.equal(new URLSearchParams(captured).get('refresh_token'),'the-real-refresh-token');
 assert.equal(tokens.accessToken,'at-new');
});

test('resolveGenericIdentity calls the declared identityEndpoint with a Bearer token and normalizes id/name; returns {} on failure, never throws',async()=>{
 const fetcher=async(url,options)=>{
  assert.equal(url,AUTH.identityEndpoint);
  assert.equal(options.headers.authorization,'Bearer at-1');
  return {ok:true,json:async()=>({id:42,name:'Real Store'})};
 };
 const identity=await resolveGenericIdentity(AUTH,ENV,fetcher,'at-1');
 assert.equal(identity.externalAccountId,'42');
 assert.equal(identity.externalAccountName,'Real Store');
 const failFetcher=async()=>{throw new Error('network down');};
 assert.deepEqual(await resolveGenericIdentity(AUTH,ENV,failFetcher,'at-1'),{});
});

test('resolveGenericOAuth2Credential: refreshes-then-persists ONLY when actually near expiry, never on every call',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hypercool-oauth2-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32}});
 try{
  const auth=createAuth(app.store.db);
  const owner=auth.createUser({username:'o_'+Math.random().toString(36).slice(2),name:'O',password:'a-long-test-password'},'owner');
  const tenantId=createTenant(app.store.db,{name:'Co',slug:'co-'+Math.random().toString(36).slice(2)},owner.id);
  const {createConnection}=await import('../src/integrations/connections.js');
  const {storeCredential,getCredentialForRuntime}=await import('../src/integrations/vault.js');
  // A real connection row is not required to be a real connector for this unit — only its id/tenantId matter.
  db_insertFakeConnection(app.store.db,tenantId);
  const connection={id:'fake-conn-1',tenantId};
  const env={INTEGRATION_ENCRYPTION_KEY:key32,...ENV};
  storeCredential(app.store.db,env,{connectionId:connection.id,credentialType:'oauth_tokens',payload:{accessToken:'still-fresh',refreshToken:'rt-1',expiresAt:new Date(Date.now()+3600000).toISOString()}},tenantId);
  let refreshCalled=false;
  const fetcher=async()=>{refreshCalled=true;return {ok:true,json:async()=>({access_token:'at-refreshed',refresh_token:'rt-2',expires_in:3600})};};
  const fresh=await resolveGenericOAuth2Credential({auth:AUTH,env,db:app.store.db,connection,credential:getCredentialForRuntime(app.store.db,env,connection.id,tenantId),fetcher});
  assert.equal(fresh.payload.accessToken,'still-fresh');
  assert.equal(refreshCalled,false,'must not refresh a token that is not actually near expiry');

  storeCredential(app.store.db,env,{connectionId:connection.id,credentialType:'oauth_tokens',payload:{accessToken:'about-to-expire',refreshToken:'rt-1',expiresAt:new Date(Date.now()+1000).toISOString()}},tenantId);
  const refreshed=await resolveGenericOAuth2Credential({auth:AUTH,env,db:app.store.db,connection,credential:getCredentialForRuntime(app.store.db,env,connection.id,tenantId),fetcher});
  assert.equal(refreshCalled,true);
  assert.equal(refreshed.payload.accessToken,'at-refreshed');
  const persisted=getCredentialForRuntime(app.store.db,env,connection.id,tenantId);
  assert.equal(persisted.payload.accessToken,'at-refreshed','the refreshed token must actually be persisted to the Vault, not just returned');
 } finally { app.store.close(); await rm(directory,{recursive:true,force:true}); }
});
function db_insertFakeConnection(db,tenantId) {
 const now=new Date().toISOString();
 db.prepare('INSERT INTO integration_connections (id,tenant_id,integration_definition_id,name,status,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run('fake-conn-1',tenantId,'acme2_oauth','fake','CONNECTED',1,now,now);
}

// --- Real HTTP round trip: a brand-new Builder-authored OAuth2 connector, zero application.js edits ----

async function httpHarness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-oauth2-http-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES:'platform_admin',...ENV},fetcher:async(url,options)=>{
  if(String(url).includes('/token'))return {ok:true,json:async()=>({access_token:'at-http-1',refresh_token:'rt-http-1',expires_in:3600,scope:'read_orders'})};
  if(String(url).includes('/me'))return {ok:true,json:async()=>({id:7,name:'HTTP Store'})};
  throw new Error('unexpected outbound call: '+url);
 }});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}) {
  const hasBody=input!==undefined && input!==null && method!=='GET';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),redirect:'manual',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,location:res.headers.get('location'),cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 const adminSetup=await call('/api/setup',{username:'platform_admin',name:'Platform Admin',password:'a-long-test-password'});
 await call('/api/auth',null,adminSetup,{method:'GET'});
 const admin={cookie:adminSetup.cookie,csrf:adminSetup.csrf};
 const auth=createAuth(app.store.db);
 const ownerUser=auth.createUser({username:'oauth2_owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'OAuth2 Co',slug:'oauth2-'+Math.random().toString(36).slice(2)},ownerUser.id);
 const loginOwner=auth.login({username:ownerUser.username,password:'a-long-test-password'},'127.0.0.1');
 const owner={cookie:'hc_session='+loginOwner.token,csrf:loginOwner.csrf};
 return {app,call,admin,owner,tenantId,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}

test('HTTP: a Platform-Admin-authored GENERIC_REST OAUTH2 connector works through the EXISTING generic OAuth routes with zero code change',async()=>{
 const {call,admin,owner,cleanup}=await httpHarness();
 try{
  const created=await call('/api/platform/connectors',{
   slug:'acme2_oauth',nameAr:'أكمي 2',nameEn:'Acme 2',category:'commerce',connectionMode:'MULTI',
   adapterType:'GENERIC_REST',auth:AUTH,capabilities:['commerce.orders.read'],
   rest:{baseUrl:'https://acme2-oauth.test'}
  },admin);
  assert.equal(created.status,201);
  await call(`/api/platform/connectors/${created.data.id}/actions`,{slug:'get_orders',nameAr:'ط',nameEn:'Orders',httpMethod:'GET',pathTemplate:'/orders',requiredCapability:'commerce.orders.read',actionType:'READ',riskLevel:'LOW'},admin);
  const published=await call(`/api/platform/connectors/${created.data.id}/publish`,{},admin);
  assert.equal(published.status,200);

  const start=await call('/api/integrations/oauth/acme2_oauth/start',null,owner,{method:'GET'});
  assert.equal(start.status,302);
  const authorizeUrl=new URL(start.location);
  assert.equal(authorizeUrl.origin+authorizeUrl.pathname,'https://oauth-provider.test/authorize');
  const state=authorizeUrl.searchParams.get('state');
  assert.ok(state);

  const callback=await call(`/api/integrations/oauth/acme2_oauth/callback?code=fake-code&state=${state}`,null,owner,{method:'GET'});
  assert.equal(callback.status,302);
  assert.equal(callback.location,'/#integrations');

  const connections=await call('/api/integrations/connections',null,owner,{method:'GET'});
  const conn=connections.data.find(c=>c.integrationDefinitionId==='acme2_oauth');
  assert.equal(conn.status,'CONNECTED');
  assert.equal(conn.externalAccountId,'7');
  assert.equal(conn.externalAccountName,'HTTP Store');
  assert.equal(conn.connectorVersion,1,'a GENERIC_REST connection is pinned to the live published version at connect time');
 } finally { await cleanup(); }
});

test('HTTP: reconnect is no longer hardcoded to Salla — a Generic OAuth2 connector\'s reconnect route now works too',async()=>{
 const {call,admin,owner,cleanup}=await httpHarness();
 try{
  const created=await call('/api/platform/connectors',{
   slug:'acme2_oauth',nameAr:'أكمي 2',nameEn:'Acme 2',category:'commerce',connectionMode:'MULTI',
   adapterType:'GENERIC_REST',auth:AUTH,capabilities:['commerce.orders.read'],rest:{baseUrl:'https://acme2-oauth.test'}
  },admin);
  await call(`/api/platform/connectors/${created.data.id}/publish`,{},admin);
  const start=await call('/api/integrations/oauth/acme2_oauth/start',null,owner,{method:'GET'});
  const state=new URL(start.location).searchParams.get('state');
  await call(`/api/integrations/oauth/acme2_oauth/callback?code=c1&state=${state}`,null,owner,{method:'GET'});
  const connections=await call('/api/integrations/connections',null,owner,{method:'GET'});
  const conn=connections.data.find(c=>c.integrationDefinitionId==='acme2_oauth');

  const reconnect=await call(`/api/integrations/connections/${conn.id}/reconnect`,{},owner);
  assert.equal(reconnect.status,200);
  assert.match(reconnect.data.reauthorizeUrl,/\/api\/integrations\/oauth\/acme2_oauth\/start\?connectionId=/);
 } finally { await cleanup(); }
});
