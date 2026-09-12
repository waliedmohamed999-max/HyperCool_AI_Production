import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createTenant} from '../src/tenancy.js';
import {createAuth} from '../src/auth.js';
import {createConnection,getConnection} from '../src/integrations/connections.js';
import {storeCredential} from '../src/integrations/vault.js';
import {createEventBus} from '../src/runtime/events.js';
import {createDraftConnector,upsertActionForConnector,upsertTriggerForConnector,publishConnector} from '../src/connectors/dynamic/builder.js';
import {getWebhookConsoleView,listFailedWebhookEventsForConnection} from '../src/connectors/generic-webhook/operations.js';
import {processGenericWebhook} from '../src/connectors/generic-webhook/webhook.js';
import {previewBulkWebhookReprocess,bulkReprocessWebhookEvents,getBulkOperation} from '../src/connectors/dynamic/bulk-operations.js';

// Phase 6H, Part 10-12 — Bulk Webhook Reprocess.
const key32=randomBytes(32).toString('hex');
const PLATFORM_ADMIN_USERNAMES='platform_admin';
const WEBHOOK_SECRET='real-bulk-reprocess-secret';

async function harness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-bulkreprocess-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES}});
 const auth=createAuth(app.store.db);
 const admin=auth.createUser({username:'platform_admin',name:'Platform Admin',password:'a-long-test-password'},'owner');
 const owner=auth.createUser({username:'owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'Co '+Math.random().toString(36).slice(2),slug:'co-'+Math.random().toString(36).slice(2)},owner.id);
 const env={INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES};
 const eventBus=createEventBus(app.store.db);
 return {app,db:app.store.db,env,admin,owner,tenantId,eventBus,cleanup:async()=>{app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function buildWebhookConnector(db,env,admin,slug='bwh_co') {
 const def=createDraftConnector(db,env,admin,{
  slug,nameAr:'وِب',nameEn:'Webco',category:'commerce',descriptionAr:'x',descriptionEn:'x',
  adapterType:'GENERIC_REST',connectionMode:'SINGLE',auth:{type:'API_KEY',headerName:'X-Key'},
  capabilities:['commerce.orders.read'],rest:{baseUrl:'https://bwh-co.test'}
 });
 upsertActionForConnector(db,env,admin,def.id,{slug:'get_orders',nameAr:'ط',nameEn:'Orders',httpMethod:'GET',pathTemplate:'/orders',requiredCapability:'commerce.orders.read',actionType:'READ',riskLevel:'LOW'});
 upsertTriggerForConnector(db,env,admin,def.id,{
  slug:'order_created',name:'Order Created',eventType:'order.created',
  authentication:{type:'HMAC',signatureHeader:'X-Signature',signaturePrefix:'sha256='},
  eventIdPath:'id',eventIdPolicy:'REQUIRED',
  mappingDefinition:{object:{orderId:{path:'payload.data.order.id'},total:{number:{path:'payload.data.order.total'}}}},
  normalizedEventType:'ORDER_CREATED'
 });
 publishConnector(db,env,admin,def.id);
 return def;
}
function connectWithWebhook(db,env,tenantId,slug='bwh_co') {
 const conn=createConnection(db,{integrationDefinitionId:slug,name:'c1'},tenantId);
 storeCredential(db,env,{connectionId:conn.id,credentialType:'api_key',payload:{apiKey:'k',webhookSecret:WEBHOOK_SECRET}},tenantId);
 return conn;
}
function sign(body,secret=WEBHOOK_SECRET) { return 'sha256='+createHmac('sha256',secret).update(body).digest('hex'); }
async function rejectsWithCode(promise,expectedCode) {
 let thrown=null;
 try{await promise;}catch(error){thrown=error;}
 assert.ok(thrown,`expected a rejection with code ${expectedCode}`);
 assert.equal(thrown.code,expectedCode);
}
function throwsWithCode(fn,expectedCode) {
 let thrown=null;
 try{fn();}catch(error){thrown=error;}
 assert.ok(thrown,`expected a throw with code ${expectedCode}`);
 assert.equal(thrown.code,expectedCode);
}
async function failOneEvent(db,env,eventBus,publicId,externalEventId) {
 const badBody=JSON.stringify({event:'order.created',id:externalEventId,data:{order:{id:'ord_1',total:'not-a-number'}}});
 await rejectsWithCode(processGenericWebhook({db,env,eventBus,publicId,rawBody:badBody,headers:{'x-signature':sign(badBody)}}),'WEBHOOK_MAPPING_FAILED');
}
function repairStoredPayload(db,eventId,externalEventId) {
 db.prepare('UPDATE webhook_events SET raw_payload=? WHERE id=?').run(JSON.stringify({event:'order.created',id:externalEventId,data:{order:{id:'ord_9',total:9}}}),eventId);
}

test('Bulk webhook reprocess preview: exact total count, bounded sample, no state change, no reprocessing side effect',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  await failOneEvent(db,env,eventBus,publicId,'evt-p-1');
  await failOneEvent(db,env,eventBus,publicId,'evt-p-2');

  const preview=previewBulkWebhookReprocess(db,env,admin,{connectorSlug:'bwh_co'});
  assert.equal(preview.totalMatched,2);
  assert.equal(preview.willAttempt,2);
  assert.equal(preview.tenants,1);
  assert.equal(preview.byErrorCode.WEBHOOK_MAPPING_FAILED,2);
  assert.equal(listFailedWebhookEventsForConnection(db,conn.id,tenantId).length,2,'preview must never mutate any event');
 } finally { await cleanup(); }
});

test('Bulk webhook reprocess: reprocesses only FAILED events, distinguishes PROCESSED from STILL_FAILED, persists an auditable operation',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  await failOneEvent(db,env,eventBus,publicId,'evt-x-1'); // will be repaired -> reprocess succeeds
  await failOneEvent(db,env,eventBus,publicId,'evt-x-2'); // left broken -> reprocess still fails

  const failed=listFailedWebhookEventsForConnection(db,conn.id,tenantId);
  const fixable=failed.find(e=>e.externalEventId==='evt-x-1');
  repairStoredPayload(db,fixable.id,'evt-x-1');

  const result=await bulkReprocessWebhookEvents({db,env,eventBus,actorUser:admin,connectorSlug:'bwh_co'});
  assert.equal(result.summary.processed,1);
  assert.equal(result.summary.stillFailed,1);
  assert.equal(result.summary.skipped,0);
  assert.equal(result.summary.duplicate,0);
  assert.equal(result.summary.failed,0);

  const stored=getBulkOperation(db,env,admin,result.operationId);
  assert.equal(stored.type,'WEBHOOK_REPROCESS');
  assert.equal(stored.results.length,2);

  // A REAL webhook_events row check: the fixed one really moved to PROCESSED, the broken one is
  // still FAILED (not silently marked anything else) and can be selected again later.
  const remaining=listFailedWebhookEventsForConnection(db,conn.id,tenantId);
  assert.equal(remaining.length,1);
  assert.equal(remaining[0].externalEventId,'evt-x-2');
 } finally { await cleanup(); }
});

test('Bulk webhook reprocess is bounded — a batch larger than the configured maximum is refused outright',async()=>{
 const {db,env,admin,cleanup}=await harness();
 try{
  const fakeIds=Array.from({length:101},(_,i)=>'fake-'+i);
  let thrown=null;
  try{await bulkReprocessWebhookEvents({db,env,eventBus:createEventBus(db),actorUser:admin,connectorSlug:'bwh_co',eventIds:fakeIds});}
  catch(error){thrown=error;}
  assert.equal(thrown?.code,'BATCH_TOO_LARGE');
 } finally { await cleanup(); }
});

test('Bulk webhook reprocess: an explicit eventIds selection reprocesses only those exact events, leaving other failed events of the same connector untouched',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  await failOneEvent(db,env,eventBus,publicId,'evt-sel-1');
  await failOneEvent(db,env,eventBus,publicId,'evt-sel-2');
  const failed=listFailedWebhookEventsForConnection(db,conn.id,tenantId);
  const target=failed.find(e=>e.externalEventId==='evt-sel-1');
  repairStoredPayload(db,target.id,'evt-sel-1');

  const result=await bulkReprocessWebhookEvents({db,env,eventBus,actorUser:admin,connectorSlug:'bwh_co',eventIds:[target.id]});
  assert.equal(result.summary.processed,1);
  assert.equal(result.results.length,1);

  const remaining=listFailedWebhookEventsForConnection(db,conn.id,tenantId);
  assert.equal(remaining.length,1);
  assert.equal(remaining[0].externalEventId,'evt-sel-2','the event NOT in eventIds must be left untouched');
 } finally { await cleanup(); }
});

test('Bulk webhook reprocess refuses when nothing matches, and is Platform Admin only',async()=>{
 const {db,env,admin,owner,cleanup}=await harness();
 try{
  const eventBus=createEventBus(db);
  await rejectsWithCode(bulkReprocessWebhookEvents({db,env,eventBus,actorUser:admin,connectorSlug:'no_such_connector'}),'NO_EVENTS_SELECTED');
  throwsWithCode(()=>previewBulkWebhookReprocess(db,env,owner,{connectorSlug:'bwh_co'}),'PLATFORM_ADMIN_REQUIRED');
  await rejectsWithCode(bulkReprocessWebhookEvents({db,env,eventBus,actorUser:owner,connectorSlug:'bwh_co'}),'PLATFORM_ADMIN_REQUIRED');
 } finally { await cleanup(); }
});
