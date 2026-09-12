import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createTenant} from '../src/tenancy.js';
import {createAuth} from '../src/auth.js';
import {createConnection} from '../src/integrations/connections.js';
import {storeCredential} from '../src/integrations/vault.js';
import {createEventBus} from '../src/runtime/events.js';
import {createDraftConnector,upsertActionForConnector,upsertTriggerForConnector,publishConnector} from '../src/connectors/dynamic/builder.js';
import {getWebhookConsoleView,listFailedWebhookEventsForConnection,reprocessFailedWebhookEvent} from '../src/connectors/generic-webhook/operations.js';
import {processGenericWebhook} from '../src/connectors/generic-webhook/webhook.js';
import {scheduleNewlyFailedRetries,attemptDueRetries,processWebhookRetries,listDeadLetterEvents,listPendingRetries} from '../src/connectors/generic-webhook/retry.js';

// Phase 6H, Part 13-18 — Automatic Webhook Retry.
const key32=randomBytes(32).toString('hex');
const PLATFORM_ADMIN_USERNAMES='platform_admin';
const WEBHOOK_SECRET='real-retry-secret';

async function harness({maxRetries}={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-webhookretry-'));
 const env={INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES};
 if(maxRetries!==undefined)env.WEBHOOK_MAX_RETRIES=String(maxRetries);
 const app=await createApp({dataDir:directory,env});
 const auth=createAuth(app.store.db);
 const admin=auth.createUser({username:'platform_admin',name:'Platform Admin',password:'a-long-test-password'},'owner');
 const owner=auth.createUser({username:'owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'Co '+Math.random().toString(36).slice(2),slug:'co-'+Math.random().toString(36).slice(2)},owner.id);
 const eventBus=createEventBus(app.store.db);
 return {app,db:app.store.db,env,admin,owner,tenantId,eventBus,cleanup:async()=>{app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function buildWebhookConnector(db,env,admin,slug='ret_co') {
 const def=createDraftConnector(db,env,admin,{
  slug,nameAr:'وِب',nameEn:'Webco',category:'commerce',descriptionAr:'x',descriptionEn:'x',
  adapterType:'GENERIC_REST',connectionMode:'SINGLE',auth:{type:'API_KEY',headerName:'X-Key'},
  capabilities:['commerce.orders.read'],rest:{baseUrl:'https://ret-co.test'}
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
function connectWithWebhook(db,env,tenantId,slug='ret_co') {
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
function rawStatus(db,eventId) { return db.prepare('SELECT status,retry_count,next_retry_at FROM webhook_events WHERE id=?').get(eventId); }

test('A newly FAILED event (with a stored raw payload) is scheduled for its first bounded-backoff retry, not left FAILED forever',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  await failOneEvent(db,env,eventBus,publicId,'evt-a-1');
  const [failed]=listFailedWebhookEventsForConnection(db,conn.id,tenantId);

  const now=Date.now();
  const phaseA=scheduleNewlyFailedRetries(db,env,{now});
  assert.equal(phaseA.scheduled,1);
  const row=rawStatus(db,failed.id);
  assert.equal(row.status,'RETRY_SCHEDULED');
  assert.equal(row.retry_count,0);
  assert.ok(new Date(row.next_retry_at).getTime()>=now+59000 && new Date(row.next_retry_at).getTime()<=now+61000,'first backoff should be ~1 minute');
 } finally { await cleanup(); }
});

test('A due retry against a genuinely repaired payload succeeds: PROCESSED, dispatched through the real Event Bus exactly once, marked as an automatic retry',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  await failOneEvent(db,env,eventBus,publicId,'evt-b-1');
  const [failed]=listFailedWebhookEventsForConnection(db,conn.id,tenantId);
  repairStoredPayload(db,failed.id,'evt-b-1');

  const now=Date.now();
  scheduleNewlyFailedRetries(db,env,{now});
  let emitted=null;
  eventBus.on('ORDER_CREATED',p=>{if(p.correlationId===failed.id)emitted=p;});
  const dueNow=now+61000; // past the 1-minute backoff
  const phaseB=await attemptDueRetries({db,env,eventBus,now:dueNow});
  assert.equal(phaseB.processed,1);
  assert.equal(rawStatus(db,failed.id).status,'PROCESSED');
  assert.ok(emitted,'a successful retry must dispatch through the real Event Bus');
  assert.equal(emitted.automaticRetry,true);
  assert.equal(emitted.reprocessed,true);
 } finally { await cleanup(); }
});

test('A retry that fails again reschedules with the next backoff step and increments retry_count — the payload is still genuinely broken, never falsely marked PROCESSED',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  await failOneEvent(db,env,eventBus,publicId,'evt-c-1');
  const [failed]=listFailedWebhookEventsForConnection(db,conn.id,tenantId);

  const now=Date.now();
  scheduleNewlyFailedRetries(db,env,{now});
  const dueNow=now+61000;
  const phaseB=await attemptDueRetries({db,env,eventBus,now:dueNow});
  assert.equal(phaseB.rescheduled,1);
  const row=rawStatus(db,failed.id);
  assert.equal(row.status,'RETRY_SCHEDULED');
  assert.equal(row.retry_count,1);
  assert.ok(new Date(row.next_retry_at).getTime()>=dueNow+299000,'second backoff should be ~5 minutes');
 } finally { await cleanup(); }
});

test('After exhausting the configured retry budget, the event moves to DEAD_LETTER — never retried forever',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness({maxRetries:2});
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  await failOneEvent(db,env,eventBus,publicId,'evt-d-1');
  const [failed]=listFailedWebhookEventsForConnection(db,conn.id,tenantId);

  let now=Date.now();
  scheduleNewlyFailedRetries(db,env,{now}); // retry_count 0 -> RETRY_SCHEDULED
  now+=61000;
  await attemptDueRetries({db,env,eventBus,now}); // fails -> retry_count 1, still <= max(2) -> RETRY_SCHEDULED
  assert.equal(rawStatus(db,failed.id).status,'RETRY_SCHEDULED');
  now+=310000;
  await attemptDueRetries({db,env,eventBus,now}); // fails -> retry_count 2, still <= max(2) -> RETRY_SCHEDULED
  assert.equal(rawStatus(db,failed.id).status,'RETRY_SCHEDULED');
  now+=910000;
  const final=await attemptDueRetries({db,env,eventBus,now}); // fails -> retry_count 3 > max(2) -> DEAD_LETTER
  assert.equal(final.deadLettered,1);
  assert.equal(rawStatus(db,failed.id).status,'DEAD_LETTER');
 } finally { await cleanup(); }
});

test('WEBHOOK_MAX_RETRIES=0 sends a newly failed event straight to DEAD_LETTER, never scheduling a retry',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness({maxRetries:0});
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  await failOneEvent(db,env,eventBus,publicId,'evt-e-1');
  const [failed]=listFailedWebhookEventsForConnection(db,conn.id,tenantId);
  const result=scheduleNewlyFailedRetries(db,env,{now:Date.now()});
  assert.equal(result.scheduled,0);
  assert.equal(result.deadLettered,1);
  assert.equal(rawStatus(db,failed.id).status,'DEAD_LETTER');
 } finally { await cleanup(); }
});

test('Manual reprocess still works on a DEAD_LETTER event — automatic retry exhaustion never blocks a human fix',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness({maxRetries:0});
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  await failOneEvent(db,env,eventBus,publicId,'evt-f-1');
  const [failed]=listFailedWebhookEventsForConnection(db,conn.id,tenantId);
  scheduleNewlyFailedRetries(db,env,{now:Date.now()});
  assert.equal(rawStatus(db,failed.id).status,'DEAD_LETTER');

  repairStoredPayload(db,failed.id,'evt-f-1');
  const result=reprocessFailedWebhookEvent({db,eventBus,connectionId:conn.id,tenantId,eventId:failed.id});
  assert.equal(result.status,'PROCESSED');
 } finally { await cleanup(); }
});

test('An event with no stored raw payload (pre-Phase-6G failure) is never auto-scheduled — an honest, permanent FAILED, matching manual reprocess\'s own precondition',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  await failOneEvent(db,env,eventBus,publicId,'evt-g-1');
  const [failed]=listFailedWebhookEventsForConnection(db,conn.id,tenantId);
  db.prepare('UPDATE webhook_events SET raw_payload=NULL WHERE id=?').run(failed.id);

  const result=scheduleNewlyFailedRetries(db,env,{now:Date.now()});
  assert.equal(result.scheduled,0);
  assert.equal(rawStatus(db,failed.id).status,'FAILED');
 } finally { await cleanup(); }
});

test('processWebhookRetries (the scheduler\'s single entry point) never touches an already-PROCESSED event',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  const goodBody=JSON.stringify({event:'order.created',id:'evt-h-1',data:{order:{id:'ord_1',total:5}}});
  const result=await processGenericWebhook({db,env,eventBus,publicId,rawBody:goodBody,headers:{'x-signature':sign(goodBody)}});
  assert.equal(result.status,'PROCESSED');

  const sweep=await processWebhookRetries({db,env,eventBus,now:Date.now()+99999999});
  assert.equal(sweep.scheduled,0);
  assert.equal(sweep.processed,0);
  assert.equal(rawStatus(db,result.eventId).status,'PROCESSED');
 } finally { await cleanup(); }
});

test('Platform Operations visibility: listDeadLetterEvents/listPendingRetries return real rows and are Platform Admin only',async()=>{
 const {db,env,admin,owner,tenantId,eventBus,cleanup}=await harness({maxRetries:0});
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  await failOneEvent(db,env,eventBus,publicId,'evt-i-1');
  scheduleNewlyFailedRetries(db,env,{now:Date.now()});

  const deadLetters=listDeadLetterEvents(db,env,admin);
  assert.equal(deadLetters.length,1);
  assert.equal(deadLetters[0].connectorSlug,'ret_co');
  assert.equal(listPendingRetries(db,env,admin).length,0);

  throwsWithCode(()=>listDeadLetterEvents(db,env,owner),'PLATFORM_ADMIN_REQUIRED');
  throwsWithCode(()=>listPendingRetries(db,env,owner),'PLATFORM_ADMIN_REQUIRED');
 } finally { await cleanup(); }
});
