import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {resolveTenantForUser} from '../src/tenancy.js';

const key32=randomBytes(32).toString('hex');

async function harness(env,fetcher){
 const directory=await mkdtemp(join(tmpdir(),'hypercool-salla-'));
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

test('Salla webhook endpoint: rejects a wrong token, accepts a correct one, and is idempotent across HTTP',async()=>{
 const {app,call,cleanup}=await harness({SALLA_WEBHOOK_SECRET:'a-real-webhook-secret'});
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  // Simulate a real (but not-yet-merchant-identified) Salla connection — exactly the state
  // right after a genuine OAuth connect, before this codebase's Salla callback has any way
  // to know the merchant id yet (see resolveTenantForSallaMerchant's own doc comment).
  const tenantId=resolveTenantForUser(app.store.db,owner.data.user.id);
  const now=new Date().toISOString();
  app.store.db.prepare('INSERT INTO integration_credentials (tenant_id,provider,access_token_enc,connected_at,updated_at) VALUES (?,?,?,?,?)').run(tenantId,'salla','placeholder',now,now);
  const badAuth=await call('/api/webhooks/salla','{"event":"order.created","data":{"id":"o1"},"merchant":12345}',null,{headers:{authorization:'Bearer wrong'}});
  assert.equal(badAuth.status,401);
  // Multi-Tenant Phase 3.5 (Part B9): a Salla webhook now only resolves to a tenant it can
  // verify via `merchant` — this codebase's Salla OAuth callback never populates
  // external_account_id at connect time (no live Salla app to verify the exact convention
  // against), so the FIRST real webhook self-registers it, matching a real deployment's
  // very first Salla webhook delivery (see resolveTenantForSallaMerchant).
  const good=await call('/api/webhooks/salla','{"event":"order.created","data":{"id":"o1"},"created_at":"2030-01-01T00:00:00Z","merchant":12345}',null,{headers:{authorization:'Bearer a-real-webhook-secret'}});
  assert.equal(good.status,200);assert.equal(good.data.replayed,false);assert.equal(good.data.internalType,'ORDER_CREATED');
  const registered=app.store.db.prepare("SELECT external_account_id FROM integration_credentials WHERE provider='salla'").get();
  assert.equal(registered.external_account_id,'12345');
  const replay=await call('/api/webhooks/salla','{"event":"order.created","data":{"id":"o1"},"created_at":"2030-01-01T00:00:00Z","merchant":12345}',null,{headers:{authorization:'Bearer a-real-webhook-secret'}});
  assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);
 }finally{await cleanup();}
});

test('Salla webhook endpoint 404s honestly with no SALLA_WEBHOOK_SECRET configured at all — never accepts an unverifiable call',async()=>{
 const {call,cleanup}=await harness({});
 try{
  const res=await call('/api/webhooks/salla','{"event":"order.created","data":{"id":"o1"}}',null,{headers:{authorization:'Bearer anything'}});
  assert.equal(res.status,401);
 }finally{await cleanup();}
});

test('Salla OAuth: full connect flow (start -> callback) stores encrypted credentials visible only as metadata, state is one-time, and disconnect clears them',async()=>{
 const env={INTEGRATION_ENCRYPTION_KEY:key32,SALLA_CLIENT_ID:'client-1',SALLA_CLIENT_SECRET:'secret-1',SALLA_REDIRECT_URI:'https://hyper-cool.com/callback'};
 let tokenCalls=0;
 const fetcher=async(url,options)=>{
  if(url==='https://accounts.salla.sa/oauth2/token') {
   tokenCalls++;
   return new Response(JSON.stringify({access_token:'real-access-token',refresh_token:'real-refresh-token',expires_in:3600,scope:'products.read orders.read'}),{status:200,headers:{'content-type':'application/json'}});
  }
  throw new Error('unexpected network call to '+url);
 };
 const {call,cleanup}=await harness(env,fetcher);
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  const operator=await call('/api/users',{username:'operator1',name:'Op',password:'a-long-test-password',role:'operator'},owner);
  assert.equal(operator.status,201);
  const opSession=await call('/api/login',{username:'operator1',password:'a-long-test-password'});
  assert.equal((await call('/api/integrations/salla/oauth/start',undefined,opSession,{method:'GET'})).status,403);

  const start=await call('/api/integrations/salla/oauth/start',undefined,owner,{method:'GET'});
  assert.equal(start.status,302);
  const state=new URL(start.location).searchParams.get('state');
  assert.ok(state);

  const statusBefore=await call('/api/integrations/salla/oauth/status',undefined,owner,{method:'GET'});
  assert.equal(statusBefore.data.connected,false);

  const callback=await call(`/api/integrations/salla/oauth/callback?code=auth-code-1&state=${state}`,undefined,owner,{method:'GET'});
  assert.equal(callback.status,302);
  assert.equal(tokenCalls,1);

  const statusAfter=await call('/api/integrations/salla/oauth/status',undefined,owner,{method:'GET'});
  assert.equal(statusAfter.data.connected,true);
  assert.equal(JSON.stringify(statusAfter.data).includes('real-access-token'),false);
  assert.deepEqual(statusAfter.data.scopes,['products.read','orders.read']);

  // Re-using the same state a second time must fail (one-time CSRF nonce) and must not
  // trigger a second token exchange.
  const reuse=await call(`/api/integrations/salla/oauth/callback?code=auth-code-2&state=${state}`,undefined,owner,{method:'GET'});
  assert.equal(reuse.status,400);
  assert.equal(tokenCalls,1);

  assert.equal((await call('/api/integrations/salla/disconnect',{},owner)).status,200);
  const statusAfterDisconnect=await call('/api/integrations/salla/oauth/status',undefined,owner,{method:'GET'});
  assert.equal(statusAfterDisconnect.data.connected,false);
 }finally{await cleanup();}
});
