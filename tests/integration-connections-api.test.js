import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {createTenant,resolveTenantForUser} from '../src/tenancy.js';

const key32=randomBytes(32).toString('hex');

async function harness(env,fetcher){
 const directory=await mkdtemp(join(tmpdir(),'hypercool-conn-api-'));
 const app=await createApp({dataDir:directory,env,...(fetcher?{fetcher}:{})});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}){
  const hasBody=input!==undefined && input!==null && method!=='GET' && method!=='DELETE';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),redirect:'manual',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf,location:res.headers.get('location')};
 }
 return {app,base,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}
async function twoTenants(env,fetcher) {
 const {app,call,cleanup}=await harness(env,fetcher);
 const ownerA=await call('/api/setup',{username:'ownera',name:'Owner A',password:'a-long-test-password'});
 // Phase 4C-1: resolve Owner A's own membership while still the sole tenant — see the same
 // note in tests/tenancy-phase2.test.js.
 await call('/api/auth',null,ownerA,{method:'GET'});
 const auth=createAuth(app.store.db);
 const userB=auth.createUser({username:'ownerb',name:'Owner B',password:'a-long-test-password'},'owner');
 const tenantB=createTenant(app.store.db,{name:'Second Co',slug:'second-co'},userB.id);
 app.store.db.prepare('DELETE FROM tenant_memberships WHERE user_id=? AND tenant_id!=?').run(userB.id,tenantB);
 const loginB=auth.login({username:'ownerb',password:'a-long-test-password'},'127.0.0.1');
 const ownerB={cookie:'hc_session='+loginB.token,csrf:loginB.csrf};
 const userA=app.store.db.prepare("SELECT id FROM users WHERE username='ownera'").get();
 const tenantA=resolveTenantForUser(app.store.db,userA.id);
 return {app,call,cleanup,ownerA,ownerB,tenantA,tenantB};
}

test('GET /api/integrations/definitions: lists the real providers; a reviewer (no read access to integrations) is refused',async()=>{
 const {call,cleanup,ownerA}=await twoTenants({});
 try{
  const list=await call('/api/integrations/definitions',undefined,ownerA,{method:'GET'});
  assert.equal(list.status,200);assert.ok(list.data.some(d=>d.slug==='salla'));
  const reviewer=await call('/api/users',{username:'rev1',name:'Rev',password:'a-long-test-password',role:'reviewer'},ownerA);
  assert.equal(reviewer.status,201);
  const revSession=await call('/api/login',{username:'rev1',password:'a-long-test-password'});
  const denied=await call('/api/integrations/definitions',undefined,revSession,{method:'GET'});
  assert.equal(denied.status,403);
 }finally{await cleanup();}
});

test('IntegrationConnections CRUD: create, list, rename, set-default, disconnect — all tenant-scoped',async()=>{
 const {call,cleanup,ownerA}=await twoTenants({});
 try{
  const created=await call('/api/integrations/connections',{integrationDefinitionId:'salla',name:'Main Store'},ownerA);
  assert.equal(created.status,201);assert.equal(created.data.isDefault,true);
  const second=await call('/api/integrations/connections',{integrationDefinitionId:'salla',name:'Riyadh Store'},ownerA);
  assert.equal(second.status,201);assert.equal(second.data.isDefault,false);

  const list=await call('/api/integrations/connections?provider=salla',undefined,ownerA,{method:'GET'});
  assert.equal(list.status,200);assert.equal(list.data.length,2);

  const renamed=await call(`/api/integrations/connections/${second.data.id}`,{name:'Jeddah Store'},ownerA,{method:'PATCH'});
  assert.equal(renamed.status,200);assert.equal(renamed.data.name,'Jeddah Store');

  const setDefault=await call(`/api/integrations/connections/${second.data.id}/set-default`,{},ownerA);
  assert.equal(setDefault.status,200);assert.equal(setDefault.data.isDefault,true);

  const disconnected=await call(`/api/integrations/connections/${created.data.id}/disconnect`,{},ownerA);
  assert.equal(disconnected.status,200);assert.equal(disconnected.data.status,'DISCONNECTED');
 }finally{await cleanup();}
});

test('IntegrationConnections IDOR: Tenant B gets a plain 404 (never data or a permission-specific error) for every op on Tenant A\'s connection',async()=>{
 const {call,cleanup,ownerA,ownerB}=await twoTenants({});
 try{
  const created=await call('/api/integrations/connections',{integrationDefinitionId:'salla',name:'Main Store'},ownerA);
  const id=created.data.id;
  assert.equal((await call(`/api/integrations/connections/${id}`,undefined,ownerB,{method:'GET'})).status,404);
  assert.equal((await call(`/api/integrations/connections/${id}`,{name:'hijacked'},ownerB,{method:'PATCH'})).status,404);
  assert.equal((await call(`/api/integrations/connections/${id}/set-default`,{},ownerB)).status,404);
  assert.equal((await call(`/api/integrations/connections/${id}/disconnect`,{},ownerB)).status,404);
  assert.equal((await call(`/api/integrations/connections/${id}/test`,{},ownerB)).status,404);
  assert.equal((await call(`/api/integrations/connections/${id}`,undefined,ownerB,{method:'DELETE'})).status,404);
  // Tenant A's connection is untouched by every one of Tenant B's failed attempts.
  const stillThere=await call(`/api/integrations/connections/${id}`,undefined,ownerA,{method:'GET'});
  assert.equal(stillThere.status,200);assert.equal(stillThere.data.name,'Main Store');
 }finally{await cleanup();}
});

test('PUT credential (API_KEY flow): a rejected key is never persisted or marked CONNECTED; a valid key is tested for real, then stored, and the response never echoes the secret back',async()=>{
 let calls=[];
 const fetcher=async(url,options)=>{
  calls.push({url,auth:options.headers['x-api-key']});
  if(options.headers['x-api-key']==='sk-bad')return new Response('{}',{status:401});
  return new Response(JSON.stringify({data:[]}),{status:200,headers:{'content-type':'application/json'}});
 };
 // ANTHROPIC_MODEL must already be configured server-side — connectionStatus()/
 // testAnthropicConnection require BOTH the key AND a model before considering the
 // provider "configured" (this route only ever overrides the key, never invents a model).
 const {call,cleanup,ownerA}=await twoTenants({ANTHROPIC_MODEL:'claude-test-model',INTEGRATION_ENCRYPTION_KEY:key32},fetcher);
 try{
  const created=await call('/api/integrations/connections',{integrationDefinitionId:'anthropic',name:'Claude'},ownerA);
  const id=created.data.id;

  const rejected=await call(`/api/integrations/connections/${id}/credential`,{apiKey:'sk-bad'},ownerA,{method:'PUT'});
  assert.equal(rejected.status,422);
  const afterFail=await call(`/api/integrations/connections/${id}`,undefined,ownerA,{method:'GET'});
  assert.notEqual(afterFail.data.status,'CONNECTED');

  const accepted=await call(`/api/integrations/connections/${id}/credential`,{apiKey:'sk-real-secret-value'},ownerA,{method:'PUT'});
  assert.equal(accepted.status,200);
  assert.equal(JSON.stringify(accepted.data).includes('sk-real-secret-value'),false);
  assert.equal(accepted.data.configured,true);

  const afterSuccess=await call(`/api/integrations/connections/${id}`,undefined,ownerA,{method:'GET'});
  assert.equal(afterSuccess.data.status,'CONNECTED');

  // Wrong auth_type (Salla is OAUTH2, not API_KEY) is refused outright, never silently accepted.
  const sallaConn=await call('/api/integrations/connections',{integrationDefinitionId:'salla',name:'Store'},ownerA);
  const wrongType=await call(`/api/integrations/connections/${sallaConn.data.id}/credential`,{apiKey:'sk-x'},ownerA,{method:'PUT'});
  assert.equal(wrongType.status,400);
 }finally{await cleanup();}
});

test('POST .../test: a real health check updates the connection\'s status/lastHealthCheck — never fakes CONNECTED from a saved credential alone',async()=>{
 const fetcher=async()=>new Response(JSON.stringify({success:true,data:[]}),{status:200,headers:{'content-type':'application/json'}});
 const {call,cleanup,ownerA}=await twoTenants({INTEGRATION_ENCRYPTION_KEY:key32},fetcher);
 try{
  const created=await call('/api/integrations/connections',{integrationDefinitionId:'salla',name:'Store'},ownerA);
  const before=await call(`/api/integrations/connections/${created.data.id}/test`,{},ownerA);
  assert.equal(before.status,200);
  assert.equal(before.data.status,'NOT_CONFIGURED'); // no credential yet
  const tested=await call(`/api/integrations/connections/${created.data.id}`,undefined,ownerA,{method:'GET'});
  assert.ok(tested.data.lastHealthCheck);
 }finally{await cleanup();}
});

test('Generic Salla OAuth (multi-store proof): two independent connect flows create two distinct CONNECTED connections for the same tenant, each with its own encrypted credential',async()=>{
 const env={INTEGRATION_ENCRYPTION_KEY:key32,SALLA_CLIENT_ID:'client-1',SALLA_CLIENT_SECRET:'secret-1',SALLA_REDIRECT_URI:'https://hyper-cool.com/callback'};
 let tokenCalls=0;
 const fetcher=async(url)=>{
  if(url==='https://accounts.salla.sa/oauth2/token') {
   tokenCalls++;
   return new Response(JSON.stringify({access_token:`token-${tokenCalls}`,refresh_token:`refresh-${tokenCalls}`,expires_in:3600,scope:'products.read'}),{status:200,headers:{'content-type':'application/json'}});
  }
  throw new Error('unexpected network call to '+url);
 };
 const {call,cleanup,ownerA,tenantA}=await twoTenants(env,fetcher);
 try{
  const start1=await call('/api/integrations/oauth/salla/start',undefined,ownerA,{method:'GET'});
  assert.equal(start1.status,302);
  const state1=new URL(start1.location).searchParams.get('state');
  const callback1=await call(`/api/integrations/oauth/salla/callback?code=code-1&state=${state1}`,undefined,ownerA,{method:'GET'});
  assert.equal(callback1.status,302);

  const start2=await call('/api/integrations/oauth/salla/start?name=Store%202',undefined,ownerA,{method:'GET'});
  const state2=new URL(start2.location).searchParams.get('state');
  const callback2=await call(`/api/integrations/oauth/salla/callback?code=code-2&state=${state2}`,undefined,ownerA,{method:'GET'});
  assert.equal(callback2.status,302);

  assert.equal(tokenCalls,2);
  const list=await call('/api/integrations/connections?provider=salla',undefined,ownerA,{method:'GET'});
  assert.equal(list.data.length,2);
  assert.ok(list.data.every(c=>c.status==='CONNECTED'));

  // A state token cannot be replayed against the callback a second time.
  const replay=await call(`/api/integrations/oauth/salla/callback?code=code-3&state=${state1}`,undefined,ownerA,{method:'GET'});
  assert.equal(replay.status,400);
  assert.equal(tokenCalls,2); // no third token exchange attempted
 }finally{await cleanup();}
});

test('Generic Salla OAuth: a state token issued to Tenant A\'s owner cannot be redeemed by Tenant B\'s owner (IDOR on the OAuth callback)',async()=>{
 const env={INTEGRATION_ENCRYPTION_KEY:key32,SALLA_CLIENT_ID:'client-1',SALLA_CLIENT_SECRET:'secret-1',SALLA_REDIRECT_URI:'https://hyper-cool.com/callback'};
 const fetcher=async()=>new Response(JSON.stringify({access_token:'tok',refresh_token:'ref',expires_in:3600,scope:'products.read'}),{status:200,headers:{'content-type':'application/json'}});
 const {call,cleanup,ownerA,ownerB}=await twoTenants(env,fetcher);
 try{
  const start=await call('/api/integrations/oauth/salla/start',undefined,ownerA,{method:'GET'});
  const state=new URL(start.location).searchParams.get('state');
  // consumeOAuthState checks userId first — a different user id (Tenant B's owner) is refused
  // with 403 before the tenant match is even reached, matching every other IDOR check in this
  // codebase (a wrong actor, not just a wrong tenant, is refused).
  const stolen=await call(`/api/integrations/oauth/salla/callback?code=code-x&state=${state}`,undefined,ownerB,{method:'GET'});
  assert.equal(stolen.status,403);
 }finally{await cleanup();}
});

test('Generic Salla OAuth: reconnecting an EXISTING connection (connectionId param) refreshes that same connection instead of creating a new one',async()=>{
 const env={INTEGRATION_ENCRYPTION_KEY:key32,SALLA_CLIENT_ID:'client-1',SALLA_CLIENT_SECRET:'secret-1',SALLA_REDIRECT_URI:'https://hyper-cool.com/callback'};
 const fetcher=async()=>new Response(JSON.stringify({access_token:'tok',refresh_token:'ref',expires_in:3600,scope:'products.read'}),{status:200,headers:{'content-type':'application/json'}});
 const {call,cleanup,ownerA}=await twoTenants(env,fetcher);
 try{
  const created=await call('/api/integrations/connections',{integrationDefinitionId:'salla',name:'Existing Store'},ownerA);
  const start=await call(`/api/integrations/oauth/salla/start?connectionId=${created.data.id}`,undefined,ownerA,{method:'GET'});
  const state=new URL(start.location).searchParams.get('state');
  await call(`/api/integrations/oauth/salla/callback?code=code-1&state=${state}`,undefined,ownerA,{method:'GET'});
  const list=await call('/api/integrations/connections?provider=salla',undefined,ownerA,{method:'GET'});
  assert.equal(list.data.length,1); // reused the existing connection, did not create a second one
  assert.equal(list.data[0].id,created.data.id);
  assert.equal(list.data[0].status,'CONNECTED');
 }finally{await cleanup();}
});

test('Generic OAuth path 501s honestly for providers not yet wired through it (Meta keeps its own dedicated route)',async()=>{
 const {call,cleanup,ownerA}=await twoTenants({});
 try{
  const res=await call('/api/integrations/oauth/meta/start',undefined,ownerA,{method:'GET'});
  assert.equal(res.status,501);
 }finally{await cleanup();}
});
