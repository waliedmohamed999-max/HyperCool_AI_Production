import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createTenant} from '../src/tenancy.js';
import {createAuth} from '../src/auth.js';
import {getOrCreateWebhookPublicId} from '../src/integrations/connections.js';
import {storeCredential} from '../src/integrations/vault.js';
import {createEventBus} from '../src/runtime/events.js';
import {processGenericWebhook} from '../src/connectors/generic-webhook/webhook.js';
import {acmeManifest} from '../src/connectors/acme/manifest.js';
import {genericRestAdapter} from '../src/connectors/generic-rest/adapter.js';

// Phase 6C (Part 108) — generic webhook burst test, mirroring the real methodology already
// used for the Phase 5 pilot's 120-event WhatsApp burst (tests/production-pilot-hardening
// used the real /api/webhooks/meta/whatsapp route directly; this one exercises
// processGenericWebhook() the same way tests/generic-webhook.test.js does).
const key32=randomBytes(32).toString('hex');
const resolveAcme=slug=>slug==='acme'?{manifest:acmeManifest,adapter:genericRestAdapter}:null;

test('Webhook burst: 100 unique + 20 duplicate Acme events across two tenants — correct unique dispatch count, zero cross-tenant leakage, reasonable time',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hypercool-webhook-burst-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32}});
 const db=app.store.db;
 try{
  const auth=createAuth(db);
  const ownerA=auth.createUser({username:'burst_owner_a',name:'A',password:'a-long-test-password'},'owner');
  const tenantA=createTenant(db,{name:'Burst Co A',slug:'burst-a'},ownerA.id);
  const ownerB=auth.createUser({username:'burst_owner_b',name:'B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'Burst Co B',slug:'burst-b'},ownerB.id);

  function connect(tenantId,secret) {
   const connectionId='burst-conn-'+tenantId;
   const now=new Date().toISOString();
   db.prepare('INSERT INTO integration_connections (id,tenant_id,integration_definition_id,name,status,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(connectionId,tenantId,'acme','Acme Burst','CONNECTED',1,now,now);
   storeCredential(db,{INTEGRATION_ENCRYPTION_KEY:key32},{connectionId,credentialType:'api_key',payload:{apiKey:'k',webhookSecret:secret}},tenantId);
   return getOrCreateWebhookPublicId(db,connectionId,tenantId);
  }
  const publicIdA=connect(tenantA,'secret-a');
  const publicIdB=connect(tenantB,'secret-b');
  const eventBus=createEventBus(db);
  const received=[];
  eventBus.on('ORDER_CREATED',p=>received.push(p));

  function payloadFor(label,total=1) {
   return JSON.stringify({event:'order.created',id:'burst-evt-'+label,created_at:new Date().toISOString(),data:{order:{id:'ord-'+label,total}}});
  }
  function sign(body,secret){return 'sha256='+createHmac('sha256',secret).update(body).digest('hex');}

  const perTenant=50;
  const requests=[];
  for(let i=0;i<perTenant;i++){
   const body=payloadFor('a-'+i);
   requests.push(processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId:publicIdA,rawBody:body,headers:{'x-acme-signature':sign(body,'secret-a')},resolveConnector:resolveAcme}));
  }
  for(let i=0;i<perTenant;i++){
   const body=payloadFor('b-'+i);
   requests.push(processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId:publicIdB,rawBody:body,headers:{'x-acme-signature':sign(body,'secret-b')},resolveConnector:resolveAcme}));
  }
  // 20 genuine duplicate redeliveries of tenant A's first 20 events.
  for(let i=0;i<20;i++){
   const body=payloadFor('a-'+i);
   requests.push(processGenericWebhook({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},eventBus,publicId:publicIdA,rawBody:body,headers:{'x-acme-signature':sign(body,'secret-a')},resolveConnector:resolveAcme}));
  }

  const startedAt=Date.now();
  const results=await Promise.all(requests);
  const elapsedMs=Date.now()-startedAt;

  const processed=results.filter(r=>r.status==='PROCESSED').length;
  const duplicate=results.filter(r=>r.status==='DUPLICATE').length;
  assert.equal(processed,perTenant*2,'exactly one PROCESSED result per unique event, across both tenants');
  assert.equal(duplicate,20,'every redelivery must report DUPLICATE, never a second PROCESSED');
  assert.ok(elapsedMs<15000,`120-event webhook burst took ${elapsedMs}ms — unreasonably slow for pilot scale`);

  await new Promise(r=>setTimeout(r,20));
  assert.equal(received.length,perTenant*2,'the Event Bus must receive exactly one dispatch per unique event, never per redelivery');
  const tenantIdsSeen=new Set(received.map(e=>e.tenantId));
  assert.deepEqual([...tenantIdsSeen].sort(),[tenantA,tenantB].sort());
  const perTenantCount=id=>received.filter(e=>e.tenantId===id).length;
  assert.equal(perTenantCount(tenantA),perTenant);
  assert.equal(perTenantCount(tenantB),perTenant,'tenant B must be completely unaffected by tenant A\'s burst+duplicates');
 }finally{
  app.store.close();
  await rm(directory,{recursive:true,force:true});
 }
});
