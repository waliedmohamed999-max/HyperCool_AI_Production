import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createTenant} from '../src/tenancy.js';
import {createAuth} from '../src/auth.js';
import {updateConnection,getOrCreateWebhookPublicId} from '../src/integrations/connections.js';
import {storeCredential} from '../src/integrations/vault.js';
import {createEventBus,installEvents} from '../src/runtime/events.js';
import {processGenericWebhook,WebhookError} from '../src/connectors/generic-webhook/webhook.js';
import {acmeManifest} from '../src/connectors/acme/manifest.js';
import {genericRestAdapter} from '../src/connectors/generic-rest/adapter.js';
import {applyMapping,MappingError} from '../src/connectors/core/mapping.js';

// Phase 6C — Generic Webhook Framework. Acme is test-only (never in the real production
// registry). Every test resolves it via the `resolveConnector` injection point, exactly like
// tests/generic-rest-connector.test.js does for the ConnectorRuntime action pipeline.
const key32=randomBytes(32).toString('hex');
const WEBHOOK_SECRET='real-acme-webhook-secret';
const resolveAcme=slug=>slug==='acme'?{manifest:acmeManifest,adapter:genericRestAdapter}:null;

async function harness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-webhook-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32}});
 const auth=createAuth(app.store.db);
 const owner=auth.createUser({username:'wh_owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'Webhook Co '+Math.random().toString(36).slice(2),slug:'wh-'+Math.random().toString(36).slice(2)},owner.id);
 const eventBus=createEventBus(app.store.db);
 return {app,db:app.store.db,owner,tenantId,eventBus,cleanup:async()=>{app.store.close();await rm(directory,{recursive:true,force:true});}};
}
// 'acme' is a pure test-only connector, deliberately never seeded into integration_definitions
// (same rationale as tests/generic-rest-connector.test.js) — inserted directly to isolate these
// tests to the webhook pipeline itself.
function acmeConnectionWithWebhook(db,tenantId,{webhookSecret=WEBHOOK_SECRET,apiKey='real-acme-key'}={}) {
 const connectionId='acme-wh-conn-'+Math.random().toString(36).slice(2);
 const now=new Date().toISOString();
 db.prepare('INSERT INTO integration_connections (id,tenant_id,integration_definition_id,name,status,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(connectionId,tenantId,'acme','Acme Test','CONNECTED',1,now,now);
 storeCredential(db,{INTEGRATION_ENCRYPTION_KEY:key32},{connectionId,credentialType:'api_key',payload:{apiKey,webhookSecret}},tenantId);
 const publicId=getOrCreateWebhookPublicId(db,connectionId,tenantId);
 return {connectionId,publicId};
}
function orderCreatedPayload(eventId,orderId='ord_1',total=100) {
 return JSON.stringify({event:'order.created',id:eventId,created_at:new Date().toISOString(),data:{order:{id:orderId,total}}});
}
function sign(body,secret=WEBHOOK_SECRET) {
 return 'sha256='+createHmac('sha256',secret).update(body).digest('hex');
}
async function rejectsWithCode(promiseFn,expectedCode) {
 let thrown=null;
 try{await promiseFn();}catch(error){thrown=error;}
 assert.ok(thrown,`expected a rejection with code ${expectedCode}, but nothing was thrown`);
 assert.equal(thrown.code,expectedCode);
}

// --- Real HMAC + happy path -------------------------------------------------------------------

test('processGenericWebhook: a real, correctly-signed Acme order.created event dispatches exactly one ORDER_CREATED to the real Event Bus',async()=>{
 const {db,tenantId,eventBus,cleanup}=await harness();
 try{
  const {publicId,connectionId}=acmeConnectionWithWebhook(db,tenantId);
  const received=[];
  eventBus.on('ORDER_CREATED',payload=>{received.push(payload);});
  const body=orderCreatedPayload('evt_1');
  const result=await processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:body,headers:{'x-acme-signature':sign(body)},resolveConnector:resolveAcme});
  assert.equal(result.status,'PROCESSED');
  await new Promise(r=>setTimeout(r,10)); // emitter handlers run on next tick
  assert.equal(received.length,1);
  assert.equal(received[0].orderId,'ord_1');
  assert.equal(received[0].total,100);
  assert.equal(received[0].tenantId,tenantId);
  assert.equal(received[0].connectionId,connectionId);
  assert.equal(received[0].connectorId,'acme');
  assert.equal(JSON.stringify(received[0]).includes(WEBHOOK_SECRET),false);
 }finally{await cleanup();}
});

// --- HMAC security ------------------------------------------------------------------------------

test('processGenericWebhook: an invalid signature is rejected BEFORE mapping/dispatch, and no event is stored as processed',async()=>{
 const {db,tenantId,eventBus,cleanup}=await harness();
 try{
  const {publicId}=acmeConnectionWithWebhook(db,tenantId);
  const received=[];eventBus.on('ORDER_CREATED',p=>received.push(p));
  const body=orderCreatedPayload('evt_bad_sig');
  await assert.rejects(()=>processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:body,headers:{'x-acme-signature':'sha256=wrong'},resolveConnector:resolveAcme}),WebhookError);
  assert.equal(received.length,0);
  const row=db.prepare("SELECT * FROM webhook_events WHERE external_event_id='evt_bad_sig'").get();
  assert.equal(row,undefined,'a rejected signature must never create a webhook_events row at all');
 }finally{await cleanup();}
});
test('processGenericWebhook: HMAC verification uses the RAW bytes — a semantically-identical but differently-serialized body fails (Part 11)',async()=>{
 const {db,tenantId,eventBus,cleanup}=await harness();
 try{
  const {publicId}=acmeConnectionWithWebhook(db,tenantId);
  const body=orderCreatedPayload('evt_raw');
  const signature=sign(body);
  const reserialized=JSON.stringify(JSON.parse(body),null,2); // same data, different bytes
  await assert.rejects(()=>processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:reserialized,headers:{'x-acme-signature':signature},resolveConnector:resolveAcme}),WebhookError);
 }finally{await cleanup();}
});
test('processGenericWebhook: a repeated bad-signature attempt never degrades the connection\'s own health/status (Part 111)',async()=>{
 const {db,tenantId,eventBus,cleanup}=await harness();
 try{
  const {publicId,connectionId}=acmeConnectionWithWebhook(db,tenantId);
  const body=orderCreatedPayload('evt_x');
  for(let i=0;i<5;i++)await assert.rejects(()=>processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:body,headers:{'x-acme-signature':'sha256=bad'},resolveConnector:resolveAcme}));
  const status=db.prepare('SELECT status FROM integration_connections WHERE id=?').get(connectionId).status;
  assert.equal(status,'CONNECTED');
 }finally{await cleanup();}
});

// --- Idempotency / replay ------------------------------------------------------------------------

test('processGenericWebhook: the exact same external event id delivered twice dispatches exactly once (Part 20/23)',async()=>{
 const {db,tenantId,eventBus,cleanup}=await harness();
 try{
  const {publicId}=acmeConnectionWithWebhook(db,tenantId);
  const received=[];eventBus.on('ORDER_CREATED',p=>received.push(p));
  const body=orderCreatedPayload('evt_dup');
  const first=await processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:body,headers:{'x-acme-signature':sign(body)},resolveConnector:resolveAcme});
  const second=await processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:body,headers:{'x-acme-signature':sign(body)},resolveConnector:resolveAcme});
  assert.equal(first.status,'PROCESSED');
  assert.equal(second.status,'DUPLICATE');
  await new Promise(r=>setTimeout(r,10));
  assert.equal(received.length,1,'exactly one Event Bus dispatch despite two real, correctly-signed deliveries');
 }finally{await cleanup();}
});
test('processGenericWebhook: two truly CONCURRENT identical deliveries still dispatch exactly once (Part 24 — real DB constraint, not an in-memory Set)',async()=>{
 const {db,tenantId,eventBus,cleanup}=await harness();
 try{
  const {publicId}=acmeConnectionWithWebhook(db,tenantId);
  const received=[];eventBus.on('ORDER_CREATED',p=>received.push(p));
  const body=orderCreatedPayload('evt_concurrent');
  const headers={'x-acme-signature':sign(body)};
  const [a,b]=await Promise.all([
   processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:body,headers,resolveConnector:resolveAcme}),
   processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:body,headers,resolveConnector:resolveAcme})
  ]);
  const statuses=[a.status,b.status].sort();
  assert.deepEqual(statuses,['DUPLICATE','PROCESSED']);
  await new Promise(r=>setTimeout(r,10));
  assert.equal(received.length,1);
 }finally{await cleanup();}
});
test('processGenericWebhook: an eventIdPolicy REQUIRED trigger rejects a payload missing the id, before any storage',async()=>{
 const {db,tenantId,eventBus,cleanup}=await harness();
 try{
  const {publicId}=acmeConnectionWithWebhook(db,tenantId);
  const body=JSON.stringify({event:'order.created',created_at:new Date().toISOString(),data:{order:{id:'x',total:1}}}); // no top-level "id"
  await rejectsWithCode(()=>processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:body,headers:{'x-acme-signature':sign(body)},resolveConnector:resolveAcme}),'WEBHOOK_INVALID_PAYLOAD');
 }finally{await cleanup();}
});

// --- Cross-tenant isolation + unknown/spoofed identifiers --------------------------------------

test('processGenericWebhook: Tenant A\'s event only ever reaches Tenant A — a spoofed tenant_id field in the payload has zero effect (Part 65)',async()=>{
 const {db,tenantId:tenantA,owner,eventBus,cleanup}=await harness();
 try{
  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'wh_owner_b_'+Math.random().toString(36).slice(2),name:'Owner B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'Webhook Co B',slug:'wh-b-'+Math.random().toString(36).slice(2)},ownerB.id);
  const connA=acmeConnectionWithWebhook(db,tenantA,{webhookSecret:'secret-a'});
  acmeConnectionWithWebhook(db,tenantB,{webhookSecret:'secret-b'});
  const received=[];eventBus.on('ORDER_CREATED',p=>received.push(p));
  const body=JSON.stringify({event:'order.created',id:'evt_spoof',tenant_id:tenantB,created_at:new Date().toISOString(),data:{order:{id:'ord_spoof',total:5}}});
  const result=await processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId:connA.publicId,rawBody:body,headers:{'x-acme-signature':sign(body,'secret-a')},resolveConnector:resolveAcme});
  assert.equal(result.status,'PROCESSED');
  await new Promise(r=>setTimeout(r,10));
  assert.equal(received.length,1);
  assert.equal(received[0].tenantId,tenantA,'tenant resolved ONLY from the publicId->connection mapping, never the payload');
 }finally{await cleanup();}
});
test('processGenericWebhook: an unknown public id is rejected cheaply, with a generic not-found error, no DB row created',async()=>{
 const {db,eventBus,cleanup}=await harness();
 try{
  const body=orderCreatedPayload('evt_unknown');
  await rejectsWithCode(()=>processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId:'totally-made-up-id',rawBody:body,headers:{'x-acme-signature':sign(body)},resolveConnector:resolveAcme}),'CONNECTOR_WEBHOOK_NOT_FOUND');
  const count=db.prepare('SELECT COUNT(*) c FROM webhook_events').get().c;
  assert.equal(count,0);
 }finally{await cleanup();}
});
test('processGenericWebhook: a DISCONNECTED connection is rejected the same as unknown (never revives a dead connection)',async()=>{
 const {db,tenantId,eventBus,cleanup}=await harness();
 try{
  const {publicId,connectionId}=acmeConnectionWithWebhook(db,tenantId);
  updateConnection(db,connectionId,{status:'DISCONNECTED'},tenantId);
  const body=orderCreatedPayload('evt_disc');
  await rejectsWithCode(()=>processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:body,headers:{'x-acme-signature':sign(body)},resolveConnector:resolveAcme}),'CONNECTOR_WEBHOOK_NOT_FOUND');
 }finally{await cleanup();}
});
test('processGenericWebhook: a SUSPENDED tenant\'s webhook is rejected — never silently processed for an inoperative tenant',async()=>{
 const {db,tenantId,eventBus,cleanup}=await harness();
 try{
  const {publicId}=acmeConnectionWithWebhook(db,tenantId);
  db.prepare("UPDATE tenants SET status='SUSPENDED' WHERE id=?").run(tenantId);
  const body=orderCreatedPayload('evt_susp');
  await rejectsWithCode(()=>processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:body,headers:{'x-acme-signature':sign(body)},resolveConnector:resolveAcme}),'CONNECTOR_WEBHOOK_TENANT_NOT_OPERATIONAL');
 }finally{await cleanup();}
});

// --- Malformed input / mapping failure ---------------------------------------------------------

test('processGenericWebhook: invalid JSON is rejected with a safe 4xx-shaped error, never a stack trace',async()=>{
 const {db,tenantId,eventBus,cleanup}=await harness();
 try{
  const {publicId}=acmeConnectionWithWebhook(db,tenantId);
  const body='{not valid json';
  await rejectsWithCode(()=>processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:body,headers:{'x-acme-signature':sign(body)},resolveConnector:resolveAcme}),'WEBHOOK_INVALID_PAYLOAD');
 }finally{await cleanup();}
});
test('processGenericWebhook: valid signature but a mapping failure (missing required mapped field) blocks dispatch and marks the event FAILED, not PROCESSED',async()=>{
 const {db,tenantId,eventBus,cleanup}=await harness();
 try{
  const {publicId}=acmeConnectionWithWebhook(db,tenantId);
  // total is a non-numeric string -> the trigger's {number:...} coercion throws MappingError.
  const body=JSON.stringify({event:'order.created',id:'evt_bad_map',created_at:new Date().toISOString(),data:{order:{id:'ord_x',total:'not-a-number'}}});
  await rejectsWithCode(()=>processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:body,headers:{'x-acme-signature':sign(body)},resolveConnector:resolveAcme}),'WEBHOOK_MAPPING_FAILED');
  const row=db.prepare("SELECT status FROM webhook_events WHERE external_event_id='evt_bad_map'").get();
  assert.equal(row.status,'FAILED');
 }finally{await cleanup();}
});

// --- Mapping engine security (prototype pollution / limits) — Part 97-99 -----------------------

test('applyMapping refuses __proto__/constructor/prototype path segments and output keys — no prototype mutation',()=>{
 assert.throws(()=>applyMapping({path:'__proto__.polluted'},{}),MappingError);
 // A JS object LITERAL with a "__proto__" key doesn't create an own enumerable property at
 // all (it sets the prototype instead) — the real attack vector is JSON.parse, which has no
 // such special-casing and DOES produce a genuine own "__proto__" key. Constructing the
 // malicious mapping via JSON.parse here matches how an attacker-controlled mapping (or, more
 // realistically, attacker-controlled DATA the mapping reads) would actually arrive.
 const maliciousMapping=JSON.parse('{"object":{"__proto__":{"const":"x"}}}');
 assert.throws(()=>applyMapping(maliciousMapping,{}),MappingError);
 const attackPayload=JSON.parse('{"__proto__":{"polluted":"yes"}}');
 assert.equal(applyMapping({path:'a.b'},attackPayload),undefined);
 assert.equal(({}).polluted,undefined,'the global Object prototype must never be mutated by processing a malicious payload');
});
test('applyMapping rejects mappings/data exceeding the max nesting depth',()=>{
 let deep={const:1};
 for(let i=0;i<20;i++)deep={string:deep};
 assert.throws(()=>applyMapping(deep,{}),/max nesting depth/);
});
test('applyMapping rejects an array mapping beyond the max item count (DoS protection)',()=>{
 const hugeArray=Array.from({length:1000},(_,i)=>({id:i}));
 assert.throws(()=>applyMapping({array:{from:'items',item:{id:'id'}}},{items:hugeArray}),/max item count/);
});

// --- Event Bus proof (Part 68) -------------------------------------------------------------------

test('the normalized event genuinely reaches the REAL, existing Event Bus (agent_events table), not just the in-process emitter',async()=>{
 const {db,tenantId,eventBus,cleanup}=await harness();
 try{
  const {publicId}=acmeConnectionWithWebhook(db,tenantId);
  const body=orderCreatedPayload('evt_bus_proof');
  await processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:body,headers:{'x-acme-signature':sign(body)},resolveConnector:resolveAcme});
  const row=db.prepare("SELECT * FROM agent_events WHERE type='ORDER_CREATED' AND tenant_id=?").get(tenantId);
  assert.ok(row,'a real agent_events row must exist — proving this went through the actual Event Bus, not a mock');
  const payload=JSON.parse(row.payload);
  assert.equal(payload.orderId,'ord_1');
 }finally{await cleanup();}
});

// --- Secret leak search (Part 101) ----------------------------------------------------------------

test('the HMAC webhook secret never appears in the audit log, the webhook_events row, or the dispatched event payload',async()=>{
 const {db,tenantId,eventBus,cleanup}=await harness();
 try{
  const {publicId}=acmeConnectionWithWebhook(db,tenantId);
  const received=[];eventBus.on('ORDER_CREATED',p=>received.push(p));
  const body=orderCreatedPayload('evt_secret_check');
  await processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId,rawBody:body,headers:{'x-acme-signature':sign(body)},resolveConnector:resolveAcme});
  await new Promise(r=>setTimeout(r,10));
  const auditRows=db.prepare('SELECT json FROM audit_logs').all().map(r=>r.json).join('\n');
  const webhookRows=db.prepare('SELECT payload FROM webhook_events').all().map(r=>r.payload).join('\n');
  assert.equal(auditRows.includes(WEBHOOK_SECRET),false);
  assert.equal(webhookRows.includes(WEBHOOK_SECRET),false);
  assert.equal(JSON.stringify(received).includes(WEBHOOK_SECRET),false);
 }finally{await cleanup();}
});

// --- Failure isolation (Part 109) -----------------------------------------------------------------

test('a bad (wrongly-signed) event for Tenant A does not block or affect Tenant B\'s own real event processing',async()=>{
 const {db,tenantId:tenantA,eventBus,cleanup}=await harness();
 try{
  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'wh_owner_c_'+Math.random().toString(36).slice(2),name:'Owner C',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'Webhook Co C',slug:'wh-c-'+Math.random().toString(36).slice(2)},ownerB.id);
  const connA=acmeConnectionWithWebhook(db,tenantA,{webhookSecret:'secret-a2'});
  const connB=acmeConnectionWithWebhook(db,tenantB,{webhookSecret:'secret-b2'});
  const received=[];eventBus.on('ORDER_CREATED',p=>received.push(p));
  const badBody=orderCreatedPayload('evt_bad_a');
  await assert.rejects(()=>processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId:connA.publicId,rawBody:badBody,headers:{'x-acme-signature':'sha256=wrong'},resolveConnector:resolveAcme}));
  const goodBody=orderCreatedPayload('evt_good_b');
  const result=await processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId:connB.publicId,rawBody:goodBody,headers:{'x-acme-signature':sign(goodBody,'secret-b2')},resolveConnector:resolveAcme});
  assert.equal(result.status,'PROCESSED');
  await new Promise(r=>setTimeout(r,10));
  assert.equal(received.length,1);
  assert.equal(received[0].tenantId,tenantB);
 }finally{await cleanup();}
});
