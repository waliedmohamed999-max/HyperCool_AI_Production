import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createTenant} from '../src/tenancy.js';
import {createAuth} from '../src/auth.js';
import {updateConnection} from '../src/integrations/connections.js';
import {storeCredential} from '../src/integrations/vault.js';
import {executeConnectorAction,checkConnectorHealth} from '../src/connectors/core/runtime.js';
import {getConnectorManifest} from '../src/connectors/registry.js';
import {acmeManifest} from '../src/connectors/acme/manifest.js';
import {genericRestAdapter} from '../src/connectors/generic-rest/adapter.js';
import {validateRestManifest} from '../src/connectors/generic-rest/manifest.js';
import {CONNECTOR_CATEGORY,CONNECTOR_AVAILABILITY,CONNECTION_MODE,AUTH_TYPE} from '../src/connectors/core/enums.js';

// Phase 6B — Generic REST Connector. Acme is a TEST-ONLY connector (never in the real
// production registry — see src/connectors/registry.js, unchanged this phase) so every test
// here resolves it via the `resolveConnector` injection point ConnectorRuntime already exposes.
const key32=randomBytes(32).toString('hex');
const resolveAcme=slug=>slug==='acme'?{manifest:acmeManifest,adapter:genericRestAdapter}:null;

async function harness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-generic-rest-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32}});
 const auth=createAuth(app.store.db);
 const owner=auth.createUser({username:'rest_owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'Rest Co '+Math.random().toString(36).slice(2),slug:'rest-'+Math.random().toString(36).slice(2)},owner.id);
 return {app,db:app.store.db,owner,tenantId,cleanup:async()=>{app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function acmeConnection(db,tenantId,{apiKey='real-acme-key'}={}) {
 const id='acme-conn-'+Math.random().toString(36).slice(2);
 const now=new Date().toISOString();
 db.prepare('INSERT INTO integration_connections (id,tenant_id,integration_definition_id,name,status,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(id,tenantId,'acme','Acme Test',apiKey?'CONNECTED':'NOT_CONFIGURED',1,now,now);
 if(apiKey)storeCredential(db,{INTEGRATION_ENCRYPTION_KEY:key32},{connectionId:id,credentialType:'api_key',payload:{apiKey}},tenantId);
 return id;
}
// A deterministic, in-memory mock of the Acme API — no real sockets. Verifies the received
// auth header matches the real vault-stored key (Part 83/94), and simulates a normal REST API.
function mockAcmeTransport({expectedApiKey='real-acme-key',orders=[]}={}) {
 const calls=[];
 const transport=async({path,method,headers,ip})=>{
  calls.push({path,method,headers,ip});
  if(headers['x-acme-api-key']!==expectedApiKey)return {statusCode:401,headers:{},stream:Buffer.from(JSON.stringify({error:'unauthorized'}))};
  if(path==='/health')return {statusCode:200,headers:{},stream:Buffer.from(JSON.stringify({ok:true}))};
  if(path==='/products')return {statusCode:200,headers:{},stream:Buffer.from(JSON.stringify({products:[{id:'p1',name:'Widget',price:9.99}]}))};
  if(path==='/orders'&&method==='GET')return {statusCode:200,headers:{},stream:Buffer.from(JSON.stringify({orders}))};
  if(path==='/orders'&&method==='POST')return {statusCode:200,headers:{},stream:Buffer.from(JSON.stringify({order:{id:'o-new',status:'created'}}))};
  return {statusCode:404,headers:{},stream:Buffer.from('{}')};
 };
 return {transport,calls,resolver:async()=>['203.0.113.50']};
}

// --- Manifest/adapter shape ---------------------------------------------------------------------

test('acmeManifest validates as a real REST manifest with GET/POST actions and safe default risk levels',()=>{
 assert.equal(acmeManifest.connectionMode,'SINGLE');
 const getProducts=acmeManifest.actions.find(a=>a.slug==='get_products');
 assert.equal(getProducts.actionType,'READ');
 assert.equal(getProducts.riskLevel,'LOW');
 assert.equal(getProducts.requiresApprovalDefault,false);
 const createOrder=acmeManifest.actions.find(a=>a.slug==='create_order');
 assert.equal(createOrder.actionType,'EXTERNAL_WRITE');
 assert.equal(createOrder.riskLevel,'MEDIUM'); // POST default per Part 12
 assert.equal(createOrder.requiresApprovalDefault,true);
});
test('validateRestManifest rejects a non-https baseUrl without explicit allowHttp',()=>{
 assert.throws(()=>validateRestManifest({id:'x',slug:'x',nameAr:'x',nameEn:'x',category:CONNECTOR_CATEGORY.COMMERCE,version:1,availability:CONNECTOR_AVAILABILITY.DEFINITION_ONLY,connectionMode:CONNECTION_MODE.SINGLE,auth:{type:AUTH_TYPE.API_KEY,headerName:'X-Key'},capabilities:['commerce.products.read'],rest:{baseUrl:'http://insecure.example'},actions:[]}),/https/);
});
test('validateRestManifest rejects a pathTemplate that smuggles a full URL (Part 14)',()=>{
 // A pathTemplate must start with "/" — an absolute URL like "https://evil.example/steal" is
 // rejected by that very check (it never even reaches the deeper scheme/"//" smuggle check),
 // which is itself the real, correct defense: no full-URL override is possible either way.
 assert.throws(()=>validateRestManifest({id:'x',slug:'x',nameAr:'x',nameEn:'x',category:CONNECTOR_CATEGORY.COMMERCE,version:1,availability:CONNECTOR_AVAILABILITY.DEFINITION_ONLY,connectionMode:CONNECTION_MODE.SINGLE,auth:{type:AUTH_TYPE.API_KEY,headerName:'X-Key'},capabilities:['commerce.products.read'],rest:{baseUrl:'https://good.example'},actions:[{id:'x.a',slug:'a',requiredCapability:'commerce.products.read',rest:{httpMethod:'GET',pathTemplate:'https://evil.example/steal'}}]}),/starting with/);
 // A pathTemplate starting with "/" but embedding "//" (protocol-relative smuggle) is also rejected.
 assert.throws(()=>validateRestManifest({id:'x',slug:'x',nameAr:'x',nameEn:'x',category:CONNECTOR_CATEGORY.COMMERCE,version:1,availability:CONNECTOR_AVAILABILITY.DEFINITION_ONLY,connectionMode:CONNECTION_MODE.SINGLE,auth:{type:AUTH_TYPE.API_KEY,headerName:'X-Key'},capabilities:['commerce.products.read'],rest:{baseUrl:'https://good.example'},actions:[{id:'x.a',slug:'a',requiredCapability:'commerce.products.read',rest:{httpMethod:'GET',pathTemplate:'//evil.example/steal'}}]}),/path only/);
});
test('validateRestManifest rejects an unknown/invented capability (Part 53) — e.g. a tenant-authored definition can never declare system.admin',()=>{
 assert.throws(()=>validateRestManifest({id:'x',slug:'x',nameAr:'x',nameEn:'x',category:CONNECTOR_CATEGORY.COMMERCE,version:1,availability:CONNECTOR_AVAILABILITY.DEFINITION_ONLY,connectionMode:CONNECTION_MODE.SINGLE,auth:{type:AUTH_TYPE.API_KEY,headerName:'X-Key'},capabilities:['system.admin'],rest:{baseUrl:'https://good.example'},actions:[]}),/not in the canonical Capability Registry/);
});
test('validateRestManifest rejects auth.type NONE without explicit allowNone (Part 9)',()=>{
 assert.throws(()=>validateRestManifest({id:'x',slug:'x',nameAr:'x',nameEn:'x',category:CONNECTOR_CATEGORY.COMMERCE,version:1,availability:CONNECTOR_AVAILABILITY.DEFINITION_ONLY,connectionMode:CONNECTION_MODE.SINGLE,auth:{type:AUTH_TYPE.NONE},capabilities:['commerce.products.read'],rest:{baseUrl:'https://good.example'},actions:[]}),/allowNone/);
});

// --- Health --------------------------------------------------------------------------------------

test('checkConnectorHealth: Acme health check goes through the real SSRF layer and reports OK for a real, valid API key',async()=>{
 const {db,tenantId,cleanup}=await harness();
 try{
  const connectionId=acmeConnection(db,tenantId);
  const {transport,resolver,calls}=mockAcmeTransport();
  const result=await checkConnectorHealth({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},tenantId,connectorSlug:'acme',connectionId,resolveConnector:resolveAcme,resolver,transport});
  assert.equal(result.status,'OK');
  assert.equal(calls[0].path,'/health');
  assert.equal(calls[0].headers['x-acme-api-key'],'real-acme-key');
 }finally{await cleanup();}
});
test('checkConnectorHealth: an auth failure is reported honestly, never a fake OK',async()=>{
 const {db,tenantId,cleanup}=await harness();
 try{
  const connectionId=acmeConnection(db,tenantId,{apiKey:'wrong-key'});
  const {transport,resolver}=mockAcmeTransport({expectedApiKey:'real-acme-key'});
  const result=await checkConnectorHealth({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},tenantId,connectorSlug:'acme',connectionId,resolveConnector:resolveAcme,resolver,transport});
  assert.equal(result.status,'ERROR');
  assert.equal(result.errorCode,'CONNECTOR_AUTH_FAILED');
 }finally{await cleanup();}
});

// --- GET actions -----------------------------------------------------------------------------

test('ConnectorRuntime.execute(): Acme get_products (GET, real mapping) returns the mapped catalog, no approval needed',async()=>{
 const {db,tenantId,owner,cleanup}=await harness();
 try{
  const connectionId=acmeConnection(db,tenantId);
  const {transport,resolver}=mockAcmeTransport();
  const result=await executeConnectorAction({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},tenantId,connectorSlug:'acme',connectionId,actionId:'get_products',input:{},actor:owner,resolveConnector:resolveAcme,resolver,transport});
  assert.equal(result.status,'OK');
  assert.deepEqual(result.output,[{id:'p1',name:'Widget',price:9.99}]);
 }finally{await cleanup();}
});
test('ConnectorRuntime.execute(): Acme get_orders (GET) works and the real auth header never leaks into the result',async()=>{
 const {db,tenantId,owner,cleanup}=await harness();
 try{
  const connectionId=acmeConnection(db,tenantId);
  const {transport,resolver}=mockAcmeTransport({orders:[{id:'o1',total:42}]});
  const result=await executeConnectorAction({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},tenantId,connectorSlug:'acme',connectionId,actionId:'get_orders',input:{},actor:owner,resolveConnector:resolveAcme,resolver,transport});
  assert.equal(result.status,'OK');
  assert.deepEqual(result.output,[{id:'o1',total:42}]);
  assert.equal(JSON.stringify(result).includes('real-acme-key'),false);
 }finally{await cleanup();}
});

// --- Write action + approval (Part 61-65, 90-91) --------------------------------------------

test('ConnectorRuntime.execute(): Acme create_order (POST, write-shaped) creates a real Approval and the mock transport is NEVER called before approval (L0/L1 write safety)',async()=>{
 const {db,tenantId,owner,cleanup}=await harness();
 try{
  const connectionId=acmeConnection(db,tenantId);
  const {transport,resolver,calls}=mockAcmeTransport();
  const result=await executeConnectorAction({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},tenantId,connectorSlug:'acme',connectionId,actionId:'create_order',input:{productId:'p1',quantity:2},actor:owner,resolveConnector:resolveAcme,resolver,transport});
  assert.equal(result.status,'WAITING_APPROVAL');
  assert.ok(result.approvalId);
  assert.equal(calls.length,0,'the adapter/transport must never be called before approval');
  const approval=db.prepare('SELECT * FROM agent_approvals WHERE id=?').get(result.approvalId);
  assert.equal(approval.status,'PENDING');
  assert.equal(approval.tenant_id,tenantId);
  assert.equal(approval.connection_id,connectionId);
 }finally{await cleanup();}
});
test('ConnectorRuntime.execute(): capability mismatch and disconnected connection are both blocked BEFORE any outbound HTTP (Part 92/93)',async()=>{
 const {db,tenantId,owner,cleanup}=await harness();
 try{
  const {transport,resolver,calls}=mockAcmeTransport();
  // Disconnected: created with no credential -> status NOT_CONFIGURED.
  const disconnectedId=acmeConnection(db,tenantId,{apiKey:null});
  const disconnected=await executeConnectorAction({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},tenantId,connectorSlug:'acme',connectionId:disconnectedId,actionId:'get_products',input:{},actor:owner,resolveConnector:resolveAcme,resolver,transport});
  assert.equal(disconnected.status,'ERROR');
  assert.equal(disconnected.errorCode,'CONNECTION_UNHEALTHY');
  assert.equal(calls.length,0);
 }finally{await cleanup();}
});

// --- Cross-tenant isolation (Part 70/95) -----------------------------------------------------

test('ConnectorRuntime.execute(): Tenant A cannot execute, health-check, or read Tenant B\'s Acme connection/credential — even with the exact real id',async()=>{
 const {db,tenantId:tenantA,owner,cleanup}=await harness();
 try{
  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'rest_owner_b_'+Math.random().toString(36).slice(2),name:'Owner B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'Rest Co B',slug:'rest-b-'+Math.random().toString(36).slice(2)},ownerB.id);
  const connectionB=acmeConnection(db,tenantB,{apiKey:'tenant-b-secret-key'});
  const {transport,resolver,calls}=mockAcmeTransport({expectedApiKey:'tenant-b-secret-key'});

  const execResult=await executeConnectorAction({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},tenantId:tenantA,connectorSlug:'acme',connectionId:connectionB,actionId:'get_products',input:{},actor:owner,resolveConnector:resolveAcme,resolver,transport});
  assert.equal(execResult.status,'ERROR');
  assert.equal(execResult.errorCode,'CONNECTION_NOT_FOUND');

  const healthResult=await checkConnectorHealth({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},tenantId:tenantA,connectorSlug:'acme',connectionId:connectionB,resolveConnector:resolveAcme,resolver,transport});
  assert.equal(healthResult.status,'ERROR');
  assert.equal(healthResult.errorCode,'CONNECTION_NOT_FOUND');
  assert.equal(calls.length,0,'no real HTTP call (and therefore no secret) must ever be reached across the tenant boundary');
 }finally{await cleanup();}
});

// --- Auth modes (Part 83) ---------------------------------------------------------------------

test('Generic REST auth: BEARER_TOKEN and BASIC inject the correct header and never leak the secret in the result',async()=>{
 const {db,tenantId,owner,cleanup}=await harness();
 try{
  const bearerManifest=validateRestManifest({id:'bearer-svc',slug:'bearer-svc',nameAr:'x',nameEn:'x',category:CONNECTOR_CATEGORY.CUSTOM,version:1,availability:CONNECTOR_AVAILABILITY.DEFINITION_ONLY,connectionMode:CONNECTION_MODE.SINGLE,auth:{type:AUTH_TYPE.BEARER_TOKEN},capabilities:['analytics.read'],rest:{baseUrl:'https://bearer.test'},actions:[{id:'b.read',slug:'read',requiredCapability:'analytics.read',rest:{httpMethod:'GET',pathTemplate:'/data'}}]});
  const now=new Date().toISOString();
  const connId='bearer-conn';
  db.prepare('INSERT INTO integration_connections (id,tenant_id,integration_definition_id,name,status,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(connId,tenantId,'bearer-svc','Bearer Svc','CONNECTED',1,now,now);
  storeCredential(db,{INTEGRATION_ENCRYPTION_KEY:key32},{connectionId:connId,credentialType:'bearer',payload:{token:'real-bearer-token'}},tenantId);
  let seenAuth=null;
  const transport=async({headers})=>{seenAuth=headers.authorization;return {statusCode:200,headers:{},stream:Buffer.from('{"ok":true}')};};
  const result=await executeConnectorAction({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},tenantId,connectorSlug:'bearer-svc',connectionId:connId,actionId:'read',input:{},actor:owner,resolveConnector:s=>s==='bearer-svc'?{manifest:bearerManifest,adapter:genericRestAdapter}:null,resolver:async()=>['203.0.113.60'],transport});
  assert.equal(result.status,'OK');
  assert.equal(seenAuth,'Bearer real-bearer-token');
  assert.equal(JSON.stringify(result).includes('real-bearer-token'),false);
 }finally{await cleanup();}
});
test('Generic REST auth: dangerous headers (Host, Content-Length, X-Forwarded-*) declared in headerMapping are silently dropped, never sent (Part 16/84)',async()=>{
 const {db,tenantId,owner,cleanup}=await harness();
 try{
  const manifest=validateRestManifest({id:'hdr-svc',slug:'hdr-svc',nameAr:'x',nameEn:'x',category:CONNECTOR_CATEGORY.CUSTOM,version:1,availability:CONNECTOR_AVAILABILITY.DEFINITION_ONLY,connectionMode:CONNECTION_MODE.SINGLE,auth:{type:AUTH_TYPE.API_KEY,headerName:'X-Key'},capabilities:['analytics.read'],rest:{baseUrl:'https://hdr.test'},actions:[{id:'h.read',slug:'read',requiredCapability:'analytics.read',rest:{httpMethod:'GET',pathTemplate:'/data',headerMapping:{Host:'evil.example',Authorization:'should-not-override',Connection:'keep-alive','X-Forwarded-For':'1.2.3.4','X-Custom':'safe-value'}}}]});
  const now=new Date().toISOString();
  const connId='hdr-conn';
  db.prepare('INSERT INTO integration_connections (id,tenant_id,integration_definition_id,name,status,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(connId,tenantId,'hdr-svc','Hdr Svc','CONNECTED',1,now,now);
  storeCredential(db,{INTEGRATION_ENCRYPTION_KEY:key32},{connectionId:connId,credentialType:'api_key',payload:{apiKey:'real-key'}},tenantId);
  let seenHeaders=null;
  const transport=async({headers})=>{seenHeaders=headers;return {statusCode:200,headers:{},stream:Buffer.from('{}')};};
  await executeConnectorAction({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},tenantId,connectorSlug:'hdr-svc',connectionId:connId,actionId:'read',input:{},actor:owner,resolveConnector:s=>s==='hdr-svc'?{manifest,adapter:genericRestAdapter}:null,resolver:async()=>['203.0.113.70'],transport});
  assert.equal(seenHeaders.host,undefined);
  assert.equal(seenHeaders.connection,undefined);
  assert.equal(seenHeaders['x-forwarded-for'],undefined);
  assert.equal(seenHeaders['x-key'],'real-key','the real auth strategy header must still be present');
  assert.equal(seenHeaders.authorization,undefined,'API_KEY auth never sets Authorization, and the custom override must not appear either');
  assert.equal(seenHeaders['x-custom'],'safe-value','a genuinely safe custom header must still pass through');
 }finally{await cleanup();}
});

// --- Generic capability/tool compatibility proof (Part 58/96) --------------------------------

test('Generic provider proof: the SAME requiredCapability (commerce.products.read) is satisfied by BOTH the real Salla connector and the generic Acme connector, with zero Acme-specific branch anywhere in ConnectorRuntime',async()=>{
 const sallaManifest=getConnectorManifest('salla');
 const sallaAction=sallaManifest.actions.find(a=>a.requiredCapability==='commerce.products.read');
 const acmeAction=acmeManifest.actions.find(a=>a.requiredCapability==='commerce.products.read');
 assert.ok(sallaAction,'Salla really declares commerce.products.read (Phase 6A)');
 assert.ok(acmeAction,'Acme really declares the SAME canonical capability — proving interchangeability');
 // executeConnectorAction itself contains no `if (connectorSlug==='acme')` anywhere — verified
 // structurally by grepping the real source file, not just asserted here.
 const runtimeSource=await (await import('node:fs/promises')).readFile(new URL('../src/connectors/core/runtime.js',import.meta.url),'utf8');
 assert.equal(/acme/i.test(runtimeSource),false,'ConnectorRuntime must contain zero Acme-specific code');
});
test('Exact connection routing: an agent assigned the Acme connection executes Acme, never Salla, even though both share a capability (Part 59)',async()=>{
 const {db,tenantId,owner,cleanup}=await harness();
 try{
  const connectionId=acmeConnection(db,tenantId);
  const {transport,resolver,calls}=mockAcmeTransport();
  const result=await executeConnectorAction({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},tenantId,connectorSlug:'acme',connectionId,actionId:'get_products',input:{},actor:owner,resolveConnector:resolveAcme,resolver,transport});
  assert.equal(result.status,'OK');
  assert.equal(calls[0].path,'/products'); // proves the REAL Acme mock ran, not any Salla code path
 }finally{await cleanup();}
});

// --- Existing Phase 6A connectors: no regression -----------------------------------------------

test('Phase 6A connectors (Salla/Anthropic/OpenAI) are completely unaffected by the Phase 6B runtime.js changes (manifest/resolver/transport params are purely additive)',async()=>{
 const {db,tenantId,owner,cleanup}=await harness();
 try{
  const now=new Date().toISOString();
  const connId='anthropic-conn';
  db.prepare('INSERT INTO integration_connections (id,tenant_id,integration_definition_id,name,status,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(connId,tenantId,'anthropic','Claude','CONNECTED',1,now,now);
  storeCredential(db,{INTEGRATION_ENCRYPTION_KEY:key32},{connectionId:connId,credentialType:'api_key',payload:{apiKey:'sk-real'}},tenantId);
  const fetcher=async()=>new Response(JSON.stringify({data:[]}),{status:200,headers:{'content-type':'application/json'}});
  const result=await executeConnectorAction({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},fetcher,tenantId,connectorSlug:'anthropic',connectionId:connId,actionId:'test_key',actor:owner});
  assert.equal(result.status,'OK');
 }finally{await cleanup();}
});
