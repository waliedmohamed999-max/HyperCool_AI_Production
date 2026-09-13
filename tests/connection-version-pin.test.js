import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {createTenant} from '../src/tenancy.js';

// Phase 6H, Part 44 — a dedicated, explicit real-HTTP test for "active version resolution": a
// brand-new connection, connected through the REAL generic-credential route (never a direct
// `createConnection` call, which does not exercise the actual pin-at-connect-time logic in
// application.js), must be pinned to whatever the connector's CURRENT live version is at that
// exact moment — v1 before any republish, v2 immediately after one, with no code change needed
// on the connecting side. This closes a real coverage gap: every other versioning test sets
// `connectorVersion` manually via `updateConnection`, so the real pin logic
// (`connectorVersion:definition.status==='PUBLISHED'?definition.version:...` in
// application.js's generic-credential route) was previously only proven for v1 by
// tests/e2e/versioning-journey.e2e.mjs, never explicitly for "a version bump happened, then a
// brand-new connection was made."
const key32=randomBytes(32).toString('hex');
const PLATFORM_ADMIN_USERNAMES='platform_admin';

async function harness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-versionpin-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}) {
  const hasBody=input!==undefined && input!==null && method!=='GET';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),redirect:'manual',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 const adminSetup=await call('/api/setup',{username:'platform_admin',name:'Platform Admin',password:'a-long-test-password'});
 await call('/api/auth',null,adminSetup,{method:'GET'});
 const admin={cookie:adminSetup.cookie,csrf:adminSetup.csrf};
 const auth=createAuth(app.store.db);
 const ownerUser=auth.createUser({username:'vpin_owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'VPin Co',slug:'vpin-'+Math.random().toString(36).slice(2)},ownerUser.id);
 const loginOwner=auth.login({username:ownerUser.username,password:'a-long-test-password'},'127.0.0.1');
 const owner={cookie:'hc_session='+loginOwner.token,csrf:loginOwner.csrf};
 return {app,call,admin,owner,tenantId,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}
// Deliberately NO declared health check (matches every E2E journey's own pattern) so the
// generic-credential route's health check trivially succeeds without any real network call —
// this test is about the VERSION PIN, not the outbound REST pipeline.
const DRAFT_INPUT={
 slug:'vpin_co',nameAr:'x',nameEn:'x',category:'commerce',descriptionAr:'x',descriptionEn:'x',
 adapterType:'GENERIC_REST',connectionMode:'MULTI',auth:{type:'API_KEY',headerName:'X-Key'},
 capabilities:['commerce.orders.read'],rest:{baseUrl:'https://vpin-co.test'}
};
function orderAction(pathTemplate) {
 return {slug:'get_orders',nameAr:'ط',nameEn:'Orders',httpMethod:'GET',pathTemplate,requiredCapability:'commerce.orders.read',actionType:'READ',riskLevel:'LOW'};
}

test('A brand-new connection made via the real generic-credential route pins to v1 while v1 is live',async()=>{
 const {call,admin,owner,cleanup}=await harness();
 try{
  await call('/api/platform/connectors',DRAFT_INPUT,admin);
  const definition=(await call('/api/platform/connectors',null,admin,{method:'GET'})).data.find(d=>d.slug==='vpin_co');
  await call(`/api/platform/connectors/${definition.id}/actions`,orderAction('/orders'),admin);
  await call(`/api/platform/connectors/${definition.id}/publish`,{},admin);

  const conn=await call('/api/integrations/connections',{integrationDefinitionId:'vpin_co',name:'c1'},owner);
  const credential=await call(`/api/integrations/connections/${conn.data.id}/generic-credential`,{apiKey:'k'},owner,{method:'PUT'});
  assert.equal(credential.status,200,'credential save must succeed (no declared health check)');
  const connectionAfter=(await call('/api/integrations/connections',null,owner,{method:'GET'})).data.find(c=>c.id===conn.data.id);
  assert.equal(connectionAfter.status,'CONNECTED');
  assert.equal(connectionAfter.connectorVersion,1,'a brand-new connection made while v1 is live must pin to v1');
 } finally { await cleanup(); }
});

test('A brand-new connection made via the real generic-credential route pins to v2 immediately after a republish — no client-side change needed',async()=>{
 const {call,admin,owner,cleanup}=await harness();
 try{
  await call('/api/platform/connectors',DRAFT_INPUT,admin);
  const definition=(await call('/api/platform/connectors',null,admin,{method:'GET'})).data.find(d=>d.slug==='vpin_co');
  await call(`/api/platform/connectors/${definition.id}/actions`,orderAction('/orders'),admin);
  await call(`/api/platform/connectors/${definition.id}/publish`,{},admin);

  // Republish to v2 (Phase 6H's Safe Published Version Lifecycle: create a draft overlay, edit,
  // publish) — no existing connection to worry about here since none was made against v1.
  await call(`/api/platform/connectors/${definition.id}/versions/draft`,{},admin);
  const draftActions=(await call(`/api/platform/connectors/${definition.id}`,null,admin,{method:'GET'})).data.actions;
  await call(`/api/platform/connectors/${definition.id}/actions/${draftActions[0].id}`,{},admin,{method:'DELETE'});
  await call(`/api/platform/connectors/${definition.id}/actions`,orderAction('/v2/orders'),admin);
  const republish=await call(`/api/platform/connectors/${definition.id}/publish`,{},admin);
  assert.equal(republish.data.version,2,'the connector must genuinely be at v2 now');

  const conn=await call('/api/integrations/connections',{integrationDefinitionId:'vpin_co',name:'c-after-v2'},owner);
  const credential=await call(`/api/integrations/connections/${conn.data.id}/generic-credential`,{apiKey:'k'},owner,{method:'PUT'});
  assert.equal(credential.status,200,'credential save must succeed (no declared health check)');
  const connectionAfter=(await call('/api/integrations/connections',null,owner,{method:'GET'})).data.find(c=>c.id===conn.data.id);
  assert.equal(connectionAfter.status,'CONNECTED');
  assert.equal(connectionAfter.connectorVersion,2,'a brand-new connection made AFTER the republish must pin to the new live version (v2), never the old one');
 } finally { await cleanup(); }
});
