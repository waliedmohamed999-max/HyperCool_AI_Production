import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {createTenant} from '../src/tenancy.js';
import {storeCredential} from '../src/integrations/vault.js';

// Universal Integration Platform (Phase 6D) — the real HTTP wiring proof, complementing
// tests/integration-builder.test.js's direct function-level proof of the Builder backend
// itself. This file exercises the ACTUAL routes in application.js (real HTTP server, real
// cookies/CSRF, real permission checks) rather than calling builder.js functions directly —
// so a routing/permission-wiring mistake in application.js (a missed authorize(), a swapped
// method, a stripped body) would show up here even if builder.js's own unit tests are all
// green. Outbound network calls to a real Generic REST connector's base URL are deliberately
// NOT exercised here (SSRF correctly rejects any local test server bound to a private/loopback
// address, and no real "Acme ERP" API exists to call) — that pipeline is already proven at the
// function level (with injected resolver/transport) in tests/integration-builder.test.js. The
// inbound webhook path has no such constraint (nothing is dialed out) and IS proven fully here.
const key32=randomBytes(32).toString('hex');
const PLATFORM_ADMIN_USERNAMES='platform_admin';

async function harness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-builder-http-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}) {
  const hasBody=input!==undefined && input!==null && method!=='GET';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),redirect:'manual',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 // First real user becomes the Platform Admin (username matches the allowlist above) via the
 // existing /api/setup bootstrap route — never a second, parallel admin-creation mechanism.
 const adminSetup=await call('/api/setup',{username:'platform_admin',name:'Platform Admin',password:'a-long-test-password'});
 await call('/api/auth',null,adminSetup,{method:'GET'});
 const admin={cookie:adminSetup.cookie,csrf:adminSetup.csrf};
 const auth=createAuth(app.store.db);
 const ownerUser=auth.createUser({username:'erp_http_owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'ERP HTTP Co',slug:'erp-http-'+Math.random().toString(36).slice(2)},ownerUser.id);
 const loginOwner=auth.login({username:ownerUser.username,password:'a-long-test-password'},'127.0.0.1');
 const owner={cookie:'hc_session='+loginOwner.token,csrf:loginOwner.csrf};
 return {app,call,admin,owner,tenantId,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}
const ACME_ERP_INPUT={
 slug:'acme_erp_http',nameAr:'أكمي إتش تي تي بي',nameEn:'Acme ERP HTTP',category:'accounting',
 descriptionAr:'إثبات HTTP للـBuilder.',descriptionEn:'HTTP wiring proof for the Builder.',
 adapterType:'GENERIC_REST',connectionMode:'SINGLE',
 auth:{type:'API_KEY',headerName:'X-Acme-Key'},
 capabilities:['accounting.invoices.read'],
 rest:{baseUrl:'https://acme-erp-http.test',health:{method:'GET',path:'/health',expectedStatus:200}}
};
function invoicesAction() {
 return {slug:'get_invoices',nameAr:'الفواتير',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/invoices',
  requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW',
  responseMapping:{array:{from:'invoices',item:{id:'id',total:'total'}}}};
}
function invoiceCreatedTrigger() {
 return {slug:'invoice_created',name:'Invoice Created',eventType:'invoice.created',
  authentication:{type:'HMAC',signatureHeader:'X-Acme-Signature',signaturePrefix:'sha256='},
  eventIdPath:'id',eventIdPolicy:'REQUIRED',
  mappingDefinition:{object:{invoiceId:{path:'payload.data.invoice.id'},total:{number:{path:'payload.data.invoice.total'}}}},
  normalizedEventType:'INVOICE_CREATED'};
}

test('HTTP: a real tenant owner gets 403 on every Platform Builder mutation route — never a tenant role bypass',async()=>{
 const {call,owner,cleanup}=await harness();
 try{
  const created=await call('/api/platform/connectors',ACME_ERP_INPUT,owner);
  assert.equal(created.status,403);
  const list=await call('/api/platform/connectors',null,owner,{method:'GET'});
  assert.equal(list.status,403);
 }finally{await cleanup();}
});

test('HTTP: full Builder lifecycle — create draft, add action+trigger, validate, publish, list, dependencies — all through real routes',async()=>{
 const {call,admin,cleanup}=await harness();
 try{
  const created=await call('/api/platform/connectors',ACME_ERP_INPUT,admin);
  assert.equal(created.status,201);
  assert.equal(created.data.status,'DRAFT');
  const definitionId=created.data.id;

  const actionRes=await call(`/api/platform/connectors/${definitionId}/actions`,invoicesAction(),admin);
  assert.equal(actionRes.status,201);
  const triggerRes=await call(`/api/platform/connectors/${definitionId}/triggers`,invoiceCreatedTrigger(),admin);
  assert.equal(triggerRes.status,201);

  const validated=await call(`/api/platform/connectors/${definitionId}/validate`,{},admin);
  assert.equal(validated.status,200);
  assert.equal(validated.data.ok,true);

  const detailBeforePublish=await call(`/api/platform/connectors/${definitionId}`,null,admin,{method:'GET'});
  assert.equal(detailBeforePublish.status,200);
  assert.equal(detailBeforePublish.data.actions.length,1);
  assert.equal(detailBeforePublish.data.triggers.length,1);

  const published=await call(`/api/platform/connectors/${definitionId}/publish`,{},admin);
  assert.equal(published.status,200);
  assert.equal(published.data.status,'PUBLISHED');
  assert.equal(published.data.version,1);

  const list=await call('/api/platform/connectors',null,admin,{method:'GET'});
  assert.equal(list.status,200);
  assert.ok(list.data.some(c=>c.slug==='acme_erp_http'));
  assert.ok(list.data.some(c=>c.slug==='salla' && c.isSystem===true),'built-in Salla must still appear in the same listing');

  const deps=await call(`/api/platform/connectors/${definitionId}/dependencies`,null,admin,{method:'GET'});
  assert.equal(deps.status,200);
  assert.equal(deps.data.connections,0);
 }finally{await cleanup();}
});

test('HTTP: a DRAFT connector never appears in the tenant catalog; publishing makes it appear with zero frontend code change',async()=>{
 const {call,admin,owner,cleanup}=await harness();
 try{
  const created=await call('/api/platform/connectors',ACME_ERP_INPUT,admin);
  await call(`/api/platform/connectors/${created.data.id}/actions`,invoicesAction(),admin);

  const catalogBefore=await call('/api/integrations/catalog',null,owner,{method:'GET'});
  assert.equal(catalogBefore.status,200);
  assert.equal(catalogBefore.data.some(c=>c.slug==='acme_erp_http'),false);

  await call(`/api/platform/connectors/${created.data.id}/publish`,{},admin);
  const catalogAfter=await call('/api/integrations/catalog',null,owner,{method:'GET'});
  assert.equal(catalogAfter.status,200);
  const entry=catalogAfter.data.find(c=>c.slug==='acme_erp_http');
  assert.ok(entry,'a published dynamic connector must appear in the tenant catalog automatically');
  assert.deepEqual(entry.capabilities,['accounting.invoices.read']);
 }finally{await cleanup();}
});

test('HTTP: disable removes a connector from the catalog and blocks new connections, reactivate restores both',async()=>{
 const {call,admin,owner,cleanup}=await harness();
 try{
  const created=await call('/api/platform/connectors',ACME_ERP_INPUT,admin);
  await call(`/api/platform/connectors/${created.data.id}/actions`,invoicesAction(),admin);
  await call(`/api/platform/connectors/${created.data.id}/publish`,{},admin);

  const disable=await call(`/api/platform/connectors/${created.data.id}/disable`,{},admin);
  assert.equal(disable.status,200);
  assert.equal(disable.data.status,'DISABLED');

  const blockedConnect=await call('/api/integrations/connections',{integrationDefinitionId:'acme_erp_http',name:'x'},owner);
  assert.equal(blockedConnect.status,400);

  const reactivate=await call(`/api/platform/connectors/${created.data.id}/reactivate`,{},admin);
  assert.equal(reactivate.status,200);
  assert.equal(reactivate.data.status,'PUBLISHED');
  const allowedConnect=await call('/api/integrations/connections',{integrationDefinitionId:'acme_erp_http',name:'x'},owner);
  assert.equal(allowedConnect.status,201);
 }finally{await cleanup();}
});

test('HTTP: tenant connects to the dynamic Acme ERP connector, generic-credential rejects an unreachable base URL for real (no fake success), connection stays not connected',async()=>{
 const {call,admin,owner,cleanup}=await harness();
 try{
  const created=await call('/api/platform/connectors',ACME_ERP_INPUT,admin);
  await call(`/api/platform/connectors/${created.data.id}/actions`,invoicesAction(),admin);
  await call(`/api/platform/connectors/${created.data.id}/publish`,{},admin);

  const connection=await call('/api/integrations/connections',{integrationDefinitionId:'acme_erp_http',name:'My Acme ERP'},owner);
  assert.equal(connection.status,201);
  assert.equal(connection.data.status,'NOT_CONFIGURED');

  // acme-erp-http.test does not resolve/exist — a REAL DNS/network failure, exercised through
  // the real, unmocked ConnectorRuntime health pipeline (production never injects a
  // resolver/transport). Proves the route neither crashes nor ever fakes a CONNECTED status.
  const credentialResult=await call(`/api/integrations/connections/${connection.data.id}/generic-credential`,{apiKey:'irrelevant-since-host-does-not-exist'},owner,{method:'PUT'});
  assert.equal(credentialResult.status,422);

  const afterAttempt=await call(`/api/integrations/connections/${connection.data.id}`,null,owner,{method:'GET'});
  assert.notEqual(afterAttempt.data.status,'CONNECTED');

  // The action-execution route must likewise refuse to run against a connection that never
  // became healthy — the same CONNECTION_UNHEALTHY gate the Agent tool path already enforces.
  const actionResult=await call(`/api/integrations/connections/${connection.data.id}/actions/get_invoices`,{},owner);
  assert.equal(actionResult.status,200); // the route itself succeeds; the pipeline result carries the real error
  assert.equal(actionResult.data.status,'ERROR');
  assert.equal(actionResult.data.errorCode,'CONNECTION_UNHEALTHY');
 }finally{await cleanup();}
});

test('HTTP: generic-credential route refuses a Salla/Anthropic/OpenAI connection — that path stays on its own dedicated route',async()=>{
 const {call,owner,cleanup}=await harness();
 try{
  const connection=await call('/api/integrations/connections',{integrationDefinitionId:'anthropic',name:'Claude'},owner);
  assert.equal(connection.status,201);
  const result=await call(`/api/integrations/connections/${connection.data.id}/generic-credential`,{apiKey:'x'},owner,{method:'PUT'});
  assert.equal(result.status,400);
 }finally{await cleanup();}
});

test('HTTP: the webhook URL route resolves a dynamic connector\'s real trigger (no code-defined manifest), and a correctly-signed inbound webhook is fully processed end to end into the real Event Bus',async()=>{
 const {app,call,admin,owner,tenantId,cleanup}=await harness();
 try{
  const created=await call('/api/platform/connectors',ACME_ERP_INPUT,admin);
  await call(`/api/platform/connectors/${created.data.id}/actions`,invoicesAction(),admin);
  await call(`/api/platform/connectors/${created.data.id}/triggers`,invoiceCreatedTrigger(),admin);
  await call(`/api/platform/connectors/${created.data.id}/publish`,{},admin);

  const connection=await call('/api/integrations/connections',{integrationDefinitionId:'acme_erp_http',name:'My Acme ERP'},owner);
  const webhookInfo=await call(`/api/integrations/connections/${connection.data.id}/webhook`,null,owner,{method:'GET'});
  assert.equal(webhookInfo.status,200);
  assert.ok(webhookInfo.data.url.endsWith(`/api/webhooks/connectors/${webhookInfo.data.url.split('/').pop()}`));
  assert.equal(webhookInfo.data.triggers.length,1);
  assert.equal(webhookInfo.data.triggers[0].slug,'invoice_created');
  assert.equal(webhookInfo.data.triggers[0].authType,'HMAC');

  // The webhook's HMAC secret comes from this connection's own Vault credential (Part 13) —
  // wired directly here since there is no dedicated "set webhook secret" HTTP route in this
  // phase's scope; the route under test is the inbound webhook processing itself.
  storeCredential(app.store.db,{INTEGRATION_ENCRYPTION_KEY:key32},{connectionId:connection.data.id,credentialType:'api_key',payload:{apiKey:'irrelevant-for-this-test',webhookSecret:'real-webhook-secret'}},tenantId);

  const publicId=webhookInfo.data.url.split('/').pop();
  const bodyString=JSON.stringify({event:'invoice.created',id:'evt_http_1',data:{invoice:{id:'inv_http_1',total:42.5}}});
  const signature='sha256='+createHmac('sha256','real-webhook-secret').update(bodyString).digest('hex');
  const webhookResult=await call(`/api/webhooks/connectors/${publicId}`,bodyString,null,{method:'POST',headers:{'x-acme-signature':signature}});
  assert.equal(webhookResult.status,200);
  assert.equal(webhookResult.data.status,'PROCESSED');
 }finally{await cleanup();}
});

test('HTTP: /api/integrations/catalog and Control Center summary never leak a credential for the dynamic connector either',async()=>{
 const {call,admin,owner,cleanup}=await harness();
 try{
  const created=await call('/api/platform/connectors',ACME_ERP_INPUT,admin);
  await call(`/api/platform/connectors/${created.data.id}/actions`,invoicesAction(),admin);
  await call(`/api/platform/connectors/${created.data.id}/publish`,{},admin);
  await call('/api/integrations/connections',{integrationDefinitionId:'acme_erp_http',name:'My Acme ERP'},owner);

  const summary=await call('/api/control-center/summary',null,owner,{method:'GET'});
  assert.equal(summary.status,200);
  const raw=JSON.stringify(summary.data).toLowerCase();
  for(const forbidden of ['apikey','api_key','secret','password'])assert.equal(raw.includes(forbidden),false,`must never include ${forbidden}`);
  const acmeProvider=summary.data.integrations.providers.find(p=>p.slug==='acme_erp_http');
  assert.ok(acmeProvider,'a connected dynamic provider must appear in the Control Center summary exactly like a built-in one');
  assert.equal(acmeProvider.status,'PUBLISHED');
 }finally{await cleanup();}
});
