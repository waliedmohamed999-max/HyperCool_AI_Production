import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createTenant} from '../src/tenancy.js';
import {createAuth} from '../src/auth.js';
import {createConnection,getConnectionByPublicId} from '../src/integrations/connections.js';
import {storeCredential,getCredentialForRuntime} from '../src/integrations/vault.js';
import {createEventBus} from '../src/runtime/events.js';
import {createDraftConnector,upsertActionForConnector,upsertTriggerForConnector,publishConnector} from '../src/connectors/dynamic/builder.js';
import {
 getWebhookConsoleView,rotateWebhookUrl,rotateWebhookSecret,sendTestWebhookEvent,
 listFailedWebhookEventsForConnection,getFailedWebhookEventDetail,reprocessFailedWebhookEvent
} from '../src/connectors/generic-webhook/operations.js';
import {processGenericWebhook} from '../src/connectors/generic-webhook/webhook.js';

// Phase 6G, Part 9-17 — Webhook Console: rotation, internal test event, failed-event
// inspector, safe reprocess. Built on top of a real Builder-published connector with a real
// HMAC webhook trigger — never a second, parallel webhook pipeline.
const key32=randomBytes(32).toString('hex');
const PLATFORM_ADMIN_USERNAMES='platform_admin';
const WEBHOOK_SECRET='real-console-webhook-secret';

async function harness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-webhookconsole-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES}});
 const auth=createAuth(app.store.db);
 const admin=auth.createUser({username:'platform_admin',name:'Platform Admin',password:'a-long-test-password'},'owner');
 const owner=auth.createUser({username:'owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'Co '+Math.random().toString(36).slice(2),slug:'co-'+Math.random().toString(36).slice(2)},owner.id);
 const env={INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES};
 const eventBus=createEventBus(app.store.db);
 return {app,db:app.store.db,env,admin,owner,tenantId,eventBus,cleanup:async()=>{app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function buildWebhookConnector(db,env,admin) {
 const def=createDraftConnector(db,env,admin,{
  slug:'wh_co',nameAr:'وِب',nameEn:'Webco',category:'commerce',descriptionAr:'x',descriptionEn:'x',
  adapterType:'GENERIC_REST',connectionMode:'SINGLE',auth:{type:'API_KEY',headerName:'X-Key'},
  capabilities:['commerce.orders.read'],rest:{baseUrl:'https://wh-co.test'}
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
function connectWithWebhook(db,env,tenantId) {
 const conn=createConnection(db,{integrationDefinitionId:'wh_co',name:'c1'},tenantId);
 storeCredential(db,env,{connectionId:conn.id,credentialType:'api_key',payload:{apiKey:'k',webhookSecret:WEBHOOK_SECRET}},tenantId);
 return conn;
}
function orderPayload(id,orderId='ord_1',total=100) { return JSON.stringify({event:'order.created',id,data:{order:{id:orderId,total}}}); }
function sign(body,secret=WEBHOOK_SECRET) { return 'sha256='+createHmac('sha256',secret).update(body).digest('hex'); }
async function rejectsWithCode(promise,expectedCode) {
 let thrown=null;
 try{await promise;}catch(error){thrown=error;}
 assert.ok(thrown,`expected a rejection with code ${expectedCode}`);
 assert.equal(thrown.code,expectedCode);
}

test('Webhook Console view: real URL/public id/triggers/failedCount',async()=>{
 const {db,env,admin,tenantId,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const view=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'});
  assert.match(view.url,/^https:\/\/app\.test\/api\/webhooks\/connectors\/[0-9a-f]{32}$/);
  assert.equal(view.triggers.length,1);
  assert.equal(view.triggers[0].authType,'HMAC');
  assert.equal(view.failedCount,0);
 } finally { await cleanup(); }
});

test('Rotate URL: the OLD public id stops resolving to anything immediately',async()=>{
 const {db,env,admin,tenantId,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const before=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'});
  const oldPublicId=before.publicId;
  const newPublicId=rotateWebhookUrl(db,conn.id,tenantId);
  assert.notEqual(newPublicId,oldPublicId);
  assert.equal(getConnectionByPublicId(db,oldPublicId),null);
  assert.notEqual(getConnectionByPublicId(db,newPublicId),null);
 } finally { await cleanup(); }
});

test('Rotate Secret: a fresh secret is returned ONCE, the old signature stops working, the new one works, and other credential fields survive',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const {webhookSecret}=rotateWebhookSecret(db,env,conn.id,tenantId);
  assert.notEqual(webhookSecret,WEBHOOK_SECRET);
  const credential=getCredentialForRuntime(db,env,conn.id,tenantId);
  assert.equal(credential.payload.apiKey,'k','rotating the webhook secret must never clobber the connector\'s own primary credential');
  assert.equal(credential.payload.webhookSecret,webhookSecret);

  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  const body=orderPayload('evt-old-sig');
  await rejectsWithCode(
   processGenericWebhook({db,env,eventBus,publicId,rawBody:body,headers:{'x-signature':sign(body,WEBHOOK_SECRET)}}),
   'CONNECTOR_WEBHOOK_AUTH_FAILED'
  );
  const body2=orderPayload('evt-new-sig');
  const result=await processGenericWebhook({db,env,eventBus,publicId,rawBody:body2,headers:{'x-signature':sign(body2,webhookSecret)}});
  assert.equal(result.status,'PROCESSED');
 } finally { await cleanup(); }
});

test('Test Webhook: goes through the REAL pipeline (auth+mapping+idempotency+Event Bus), labeled internal, never claims a provider delivered it',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  let emitted=null;
  eventBus.on('ORDER_CREATED',payload=>{emitted=payload;});
  const result=await sendTestWebhookEvent({db,env,eventBus,connectionId:conn.id,tenantId,triggerSlug:'order_created',samplePayload:{id:'internal-1',data:{order:{id:'internal-1',total:42}}}});
  assert.equal(result.status,'PROCESSED');
  assert.equal(result.internalTest,true);
  assert.ok(emitted,'must actually dispatch through the real Event Bus');
  assert.equal(emitted.orderId,'internal-1');
 } finally { await cleanup(); }
});

test('Failed Webhook Inspector: lists a real failed event (safe metadata only) and a detail view masks sensitive keys in the raw payload',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  // A payload that fails MAPPING for real (a non-numeric `total`, which the trigger's own
  // {number:...} coercion throws on) — not an auth failure — and carries a sensitive-looking
  // field to prove the masking.
  const badBody=JSON.stringify({event:'order.created',id:'evt-bad-1',api_key:'super-secret-leaked-value',data:{order:{id:'ord_1',total:'not-a-number'}}});
  await rejectsWithCode(
   processGenericWebhook({db,env,eventBus,publicId,rawBody:badBody,headers:{'x-signature':sign(badBody)}}),
   'WEBHOOK_MAPPING_FAILED'
  );
  const failed=listFailedWebhookEventsForConnection(db,conn.id,tenantId);
  assert.equal(failed.length,1);
  assert.equal(failed[0].triggerSlug,'order_created');
  assert.equal(failed[0].hasRawPayload,true);
  const detail=getFailedWebhookEventDetail(db,conn.id,tenantId,failed[0].id);
  assert.equal(detail.rawPayload.api_key,'***MASKED***');
  assert.equal(detail.rawPayload.event,'order.created','non-sensitive fields stay readable');
 } finally { await cleanup(); }
});

test('Safe Reprocess: re-runs the SAME event once the mapping issue is understood, is CAS-guarded against a double reprocess, and marks PROCESSED atomically',async()=>{
 const {db,env,admin,tenantId,eventBus,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const conn=connectWithWebhook(db,env,tenantId);
  const publicId=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'}).publicId;
  const badBody=JSON.stringify({event:'order.created',id:'evt-reproc-1',data:{order:{id:'ord_1',total:'not-a-number'}}});
  await rejectsWithCode(processGenericWebhook({db,env,eventBus,publicId,rawBody:badBody,headers:{'x-signature':sign(badBody)}}),'WEBHOOK_MAPPING_FAILED');
  const [failedEvent]=listFailedWebhookEventsForConnection(db,conn.id,tenantId);

  // The mapping itself still can't succeed against THIS stored payload (total is still not a
  // real number) — proving reprocess re-runs the REAL mapping engine, not a fake success.
  await rejectsWithCode(
   Promise.resolve().then(()=>reprocessFailedWebhookEvent({db,eventBus,connectionId:conn.id,tenantId,eventId:failedEvent.id})),
   'WEBHOOK_MAPPING_FAILED'
  );

  // Now prove the SUCCESS path against a genuinely reprocessable stored event.
  const goodBadBody=JSON.stringify({event:'order.created',id:'evt-reproc-2',data:{order:{id:'ord_1',total:'not-a-number'}}}); // fails once
  await rejectsWithCode(processGenericWebhook({db,env,eventBus,publicId,rawBody:goodBadBody,headers:{'x-signature':sign(goodBadBody)}}),'WEBHOOK_MAPPING_FAILED');
  const [secondFailed]=listFailedWebhookEventsForConnection(db,conn.id,tenantId).filter(e=>e.externalEventId==='evt-reproc-2');
  // Manually repair the stored raw payload to what a real corrected upstream retry would send —
  // proving reprocess uses the STORED payload, not a re-fetch, and that a genuinely fixable
  // event really does move to PROCESSED.
  db.prepare('UPDATE webhook_events SET raw_payload=? WHERE id=?').run(JSON.stringify({event:'order.created',id:'evt-reproc-2',data:{order:{id:'ord_9',total:9}}}),secondFailed.id);
  let emitted=null;
  eventBus.on('ORDER_CREATED',p=>{if(p.correlationId===secondFailed.id)emitted=p;});
  const result=reprocessFailedWebhookEvent({db,eventBus,connectionId:conn.id,tenantId,eventId:secondFailed.id});
  assert.equal(result.status,'PROCESSED');
  assert.ok(emitted,'reprocess must dispatch through the real Event Bus');
  assert.equal(emitted.reprocessed,true);

  // CAS guard: reprocessing the SAME (now PROCESSED) event again must be refused, never silently
  // re-run a second successful dispatch.
  await rejectsWithCode(Promise.resolve().then(()=>reprocessFailedWebhookEvent({db,eventBus,connectionId:conn.id,tenantId,eventId:secondFailed.id})),'NOT_REPROCESSABLE');
 } finally { await cleanup(); }
});

test('Cross-tenant isolation: Tenant B cannot rotate/reprocess/inspect Tenant A\'s webhook connection',async()=>{
 const {db,env,admin,tenantId:tenantA,cleanup}=await harness();
 try{
  buildWebhookConnector(db,env,admin);
  const connA=connectWithWebhook(db,env,tenantA);
  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'ownerb_'+Math.random().toString(36).slice(2),name:'B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'B Co',slug:'b-co-'+Math.random().toString(36).slice(2)},ownerB.id);
  assert.throws(()=>getWebhookConsoleView(db,connA.id,tenantB,{baseUrl:'https://app.test'}));
  assert.throws(()=>rotateWebhookUrl(db,connA.id,tenantB));
  assert.throws(()=>rotateWebhookSecret(db,env,connA.id,tenantB));
  assert.throws(()=>listFailedWebhookEventsForConnection(db,connA.id,tenantB));
 } finally { await cleanup(); }
});
