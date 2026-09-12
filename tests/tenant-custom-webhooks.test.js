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
import {
 createTenantConnectorDraft,upsertTenantConnectorTrigger,deleteTenantConnectorTrigger,listTenantConnectorTriggers,
 submitTenantConnectorForReview,reviewTenantConnector
} from '../src/connectors/dynamic/tenant-custom.js';
import {getWebhookConsoleView,sendTestWebhookEvent} from '../src/connectors/generic-webhook/operations.js';
import {processGenericWebhook} from '../src/connectors/generic-webhook/webhook.js';
import {createEventBus} from '../src/runtime/events.js';

// Phase 6H, Part 26-32 — Tenant Custom Connector Webhook Triggers.
const key32=randomBytes(32).toString('hex');
const PLATFORM_ADMIN_USERNAMES='platform_admin';

async function harness({maxTriggers}={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-tenantwebhook-'));
 const env={INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES,ENABLE_TENANT_CUSTOM_CONNECTORS:'true'};
 if(maxTriggers)env.MAX_CUSTOM_CONNECTOR_TRIGGERS=String(maxTriggers);
 const app=await createApp({dataDir:directory,env});
 const auth=createAuth(app.store.db);
 const admin=auth.createUser({username:'platform_admin',name:'Platform Admin',password:'a-long-test-password'},'owner');
 const owner=auth.createUser({username:'owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'Co '+Math.random().toString(36).slice(2),slug:'co-'+Math.random().toString(36).slice(2)},owner.id);
 const eventBus=createEventBus(app.store.db);
 return {app,db:app.store.db,env,admin,owner,tenantId,eventBus,cleanup:async()=>{app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function throwsWithCode(fn,expectedCode) {
 let thrown=null;
 try{fn();}catch(error){thrown=error;}
 assert.ok(thrown,`expected a throw with code ${expectedCode}`);
 assert.equal(thrown.code,expectedCode);
}
function draftInput(slug='tc_wh') {
 return {
  slug,nameAr:'متجري',nameEn:'My Shop',category:'commerce',descriptionAr:'x',descriptionEn:'x',
  connectionMode:'SINGLE',auth:{type:'NONE',allowNone:true},
  capabilities:['commerce.orders.read'],rest:{baseUrl:'https://tc-wh.test'}
 };
}
function hmacTrigger(slug='order_created') {
 return {
  slug,name:'Order Created',normalizedEventType:'ORDER_CREATED',
  authentication:{type:'HMAC',signatureHeader:'X-Signature',signaturePrefix:'sha256='},
  eventIdPath:'id',eventIdPolicy:'REQUIRED',
  mappingDefinition:{object:{orderId:{path:'payload.data.order.id'},total:{number:{path:'payload.data.order.total'}}}}
 };
}

test('Tenant trigger: HMAC/HEADER_TOKEN allowed, NONE and SHARED_SECRET refused',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  const draft=createTenantConnectorDraft(db,env,owner,tenantId,draftInput());
  const created=upsertTenantConnectorTrigger(db,env,tenantId,draft.id,hmacTrigger());
  assert.equal(created.slug,'order_created');
  throwsWithCode(()=>upsertTenantConnectorTrigger(db,env,tenantId,draft.id,{...hmacTrigger('t2'),authentication:{type:'NONE',allowNone:true}}),'INVALID_AUTH_TYPE');
  throwsWithCode(()=>upsertTenantConnectorTrigger(db,env,tenantId,draft.id,{...hmacTrigger('t3'),authentication:{type:'SHARED_SECRET',headerName:'X-Secret'}}),'INVALID_AUTH_TYPE');
  const headerTokenTrigger=upsertTenantConnectorTrigger(db,env,tenantId,draft.id,{...hmacTrigger('t4'),authentication:{type:'HEADER_TOKEN',headerName:'X-Token'}});
  assert.equal(headerTokenTrigger.authentication.type,'HEADER_TOKEN');
 } finally { await cleanup(); }
});

test('Tenant trigger: only the safe event-type allowlist is accepted — a privileged/internal event type is refused',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  const draft=createTenantConnectorDraft(db,env,owner,tenantId,draftInput());
  throwsWithCode(()=>upsertTenantConnectorTrigger(db,env,tenantId,draft.id,{...hmacTrigger(),normalizedEventType:'CONTENT_PUBLISH_REQUESTED'}),'EVENT_TYPE_NOT_ALLOWED');
  throwsWithCode(()=>upsertTenantConnectorTrigger(db,env,tenantId,draft.id,{...hmacTrigger(),normalizedEventType:'AGENT_RUN_FAILED'}),'EVENT_TYPE_NOT_ALLOWED');
  const ok=upsertTenantConnectorTrigger(db,env,tenantId,draft.id,{...hmacTrigger(),normalizedEventType:'INVOICE_CREATED'});
  assert.equal(ok.normalizedEventType,'INVOICE_CREATED');
 } finally { await cleanup(); }
});

test('Tenant trigger limit (MAX_CUSTOM_CONNECTOR_TRIGGERS) is enforced',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness({maxTriggers:2});
 try{
  const draft=createTenantConnectorDraft(db,env,owner,tenantId,draftInput());
  upsertTenantConnectorTrigger(db,env,tenantId,draft.id,hmacTrigger('t1'));
  upsertTenantConnectorTrigger(db,env,tenantId,draft.id,hmacTrigger('t2'));
  throwsWithCode(()=>upsertTenantConnectorTrigger(db,env,tenantId,draft.id,hmacTrigger('t3')),'TRIGGER_LIMIT_REACHED');
  // Re-upserting an EXISTING slug (an edit, not a new trigger) must never count against the limit.
  const edited=upsertTenantConnectorTrigger(db,env,tenantId,draft.id,{...hmacTrigger('t1'),name:'Renamed'});
  assert.equal(edited.name,'Renamed');
 } finally { await cleanup(); }
});

test('Delete + list tenant triggers, cross-tenant isolation on all three',async()=>{
 const {db,env,owner,tenantId:tenantA,cleanup}=await harness();
 try{
  const draft=createTenantConnectorDraft(db,env,owner,tenantA,draftInput());
  const t=upsertTenantConnectorTrigger(db,env,tenantA,draft.id,hmacTrigger());
  assert.equal(listTenantConnectorTriggers(db,tenantA,draft.id).length,1);

  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'ownerb_'+Math.random().toString(36).slice(2),name:'B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'B',slug:'b-'+Math.random().toString(36).slice(2)},ownerB.id);
  throwsWithCode(()=>listTenantConnectorTriggers(db,tenantB,draft.id),'CONNECTOR_NOT_FOUND');
  throwsWithCode(()=>upsertTenantConnectorTrigger(db,env,tenantB,draft.id,hmacTrigger('hack')),'CONNECTOR_NOT_FOUND');
  throwsWithCode(()=>deleteTenantConnectorTrigger(db,env,tenantB,draft.id,t.id),'CONNECTOR_NOT_FOUND');

  deleteTenantConnectorTrigger(db,env,tenantA,draft.id,t.id);
  assert.equal(listTenantConnectorTriggers(db,tenantA,draft.id).length,0);
 } finally { await cleanup(); }
});

test('End-to-end: tenant drafts a connector WITH a webhook trigger, submits (review includes the trigger), gets approved, connects, and a signed test event flows through the real generic webhook pipeline — cross-tenant isolated',async()=>{
 const {db,env,admin,owner,tenantId,eventBus,cleanup}=await harness();
 try{
  const draft=createTenantConnectorDraft(db,env,owner,tenantId,draftInput());
  upsertTenantConnectorTrigger(db,env,tenantId,draft.id,hmacTrigger());
  const submitted=submitTenantConnectorForReview(db,env,tenantId,draft.id);
  assert.equal(submitted.reviewStatus,'PENDING');

  // Part 30 — Platform Review sees the real trigger definitions via the same Builder detail
  // view an admin's "View full details" button opens.
  const {getConnectorForBuilder}=await import('../src/connectors/dynamic/builder.js');
  const adminView=getConnectorForBuilder(db,env,admin,draft.id);
  assert.equal(adminView.triggers.length,1);
  assert.equal(adminView.triggers[0].authentication.type,'HMAC');

  const approved=reviewTenantConnector(db,env,admin,draft.id,{decision:'APPROVE'});
  assert.equal(approved.status,'PUBLISHED');

  const conn=createConnection(db,{integrationDefinitionId:draft.slug,name:'c1'},tenantId);
  storeCredential(db,env,{connectionId:conn.id,credentialType:'webhook_secret',payload:{webhookSecret:'tenant-real-secret'}},tenantId);
  const view=getWebhookConsoleView(db,conn.id,tenantId,{baseUrl:'https://app.test'});
  assert.equal(view.triggers[0].authType,'HMAC');

  const result=await sendTestWebhookEvent({db,env,eventBus,connectionId:conn.id,tenantId,triggerSlug:'order_created',samplePayload:{id:'evt-1',data:{order:{id:'ord_1',total:9}}}});
  assert.equal(result.status,'PROCESSED');

  // Cross-tenant: a real, independent second tenant can never reach or use this connector.
  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'ownerb2_'+Math.random().toString(36).slice(2),name:'B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'B',slug:'b2-'+Math.random().toString(36).slice(2)},ownerB.id);
  const {getTenantCatalog}=await import('../src/connectors/dynamic/builder.js');
  assert.equal(getTenantCatalog(db,tenantB).some(c=>c.slug===draft.slug),false);
 } finally { await cleanup(); }
});
