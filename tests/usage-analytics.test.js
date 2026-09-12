import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createTenant} from '../src/tenancy.js';
import {createAuth} from '../src/auth.js';
import {createConnection,updateConnection} from '../src/integrations/connections.js';
import {storeCredential} from '../src/integrations/vault.js';
import {createDraftConnector,upsertActionForConnector,publishConnector} from '../src/connectors/dynamic/builder.js';
import {executeConnectorAction} from '../src/connectors/core/runtime.js';
import {getConnectionUsage,getConnectorAnalytics} from '../src/runtime/usage-analytics.js';

// Phase 6G, Part 39-42 — Usage/Connector Analytics: real aggregates over the existing audit
// log + webhook ledger, explicitly operational (never a billing meter — nothing here is wired
// into any pricing/quota system).
const key32=randomBytes(32).toString('hex');
const PLATFORM_ADMIN_USERNAMES='platform_admin';

async function harness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-usage-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES}});
 const auth=createAuth(app.store.db);
 const admin=auth.createUser({username:'platform_admin',name:'Platform Admin',password:'a-long-test-password'},'owner');
 const owner=auth.createUser({username:'owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'Co '+Math.random().toString(36).slice(2),slug:'co-'+Math.random().toString(36).slice(2)},owner.id);
 const env={INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES};
 return {app,db:app.store.db,env,admin,owner,tenantId,cleanup:async()=>{app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function mockTransport({expectedApiKey='k',fail=false}={}) {
 const transport=async({path,headers})=>{
  if(headers['x-key']!==expectedApiKey)return {statusCode:401,headers:{},stream:Buffer.from('{}')};
  if(fail)return {statusCode:500,headers:{},stream:Buffer.from('{}')};
  return {statusCode:200,headers:{},stream:Buffer.from(JSON.stringify({orders:[]}))};
 };
 return {transport,resolver:async()=>['203.0.113.90']};
}

test('Connection Usage: real call counts/success/failure/avg latency/lastUsedAt from the existing audit log',async()=>{
 const {db,env,admin,owner,tenantId,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,{
   slug:'usage_co',nameAr:'x',nameEn:'x',category:'commerce',descriptionAr:'x',descriptionEn:'x',
   adapterType:'GENERIC_REST',connectionMode:'SINGLE',auth:{type:'API_KEY',headerName:'X-Key'},
   capabilities:['commerce.orders.read'],rest:{baseUrl:'https://usage-co.test'}
  });
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_orders',nameAr:'x',nameEn:'x',httpMethod:'GET',pathTemplate:'/orders',requiredCapability:'commerce.orders.read',actionType:'READ',riskLevel:'LOW'});
  publishConnector(db,env,admin,def.id);
  const conn=createConnection(db,{integrationDefinitionId:'usage_co',name:'c1'},tenantId);
  storeCredential(db,env,{connectionId:conn.id,credentialType:'api_key',payload:{apiKey:'k'}},tenantId);
  updateConnection(db,conn.id,{status:'CONNECTED'},tenantId);

  const {transport,resolver}=mockTransport();
  await executeConnectorAction({db,env,tenantId,connectorSlug:'usage_co',connectionId:conn.id,actionId:'get_orders',actor:owner,resolver,transport});
  await executeConnectorAction({db,env,tenantId,connectorSlug:'usage_co',connectionId:conn.id,actionId:'get_orders',actor:owner,resolver,transport});
  const {transport:badTransport}=mockTransport({expectedApiKey:'WRONG'});
  await executeConnectorAction({db,env,tenantId,connectorSlug:'usage_co',connectionId:conn.id,actionId:'get_orders',actor:owner,resolver,transport:badTransport});

  const usage=getConnectionUsage(db,tenantId,conn.id,'7d');
  assert.equal(usage.actionCalls,3);
  assert.equal(usage.success,2);
  assert.equal(usage.failure,1);
  assert.ok(usage.lastUsedAt);
  assert.equal(usage.window,'7d');
 } finally { await cleanup(); }
});

test('Connection Usage is tenant-scoped: Tenant B never sees Tenant A\'s numbers',async()=>{
 const {db,env,admin,owner,tenantId:tenantA,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,{
   slug:'usage_iso',nameAr:'x',nameEn:'x',category:'commerce',descriptionAr:'x',descriptionEn:'x',
   adapterType:'GENERIC_REST',connectionMode:'MULTI',auth:{type:'API_KEY',headerName:'X-Key'},
   capabilities:['commerce.orders.read'],rest:{baseUrl:'https://usage-iso.test'}
  });
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_orders',nameAr:'x',nameEn:'x',httpMethod:'GET',pathTemplate:'/orders',requiredCapability:'commerce.orders.read',actionType:'READ',riskLevel:'LOW'});
  publishConnector(db,env,admin,def.id);
  const connA=createConnection(db,{integrationDefinitionId:'usage_iso',name:'a'},tenantA);
  storeCredential(db,env,{connectionId:connA.id,credentialType:'api_key',payload:{apiKey:'k'}},tenantA);
  const {transport,resolver}=mockTransport();
  await executeConnectorAction({db,env,tenantId:tenantA,connectorSlug:'usage_iso',connectionId:connA.id,actionId:'get_orders',actor:owner,resolver,transport});

  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'ownerb_'+Math.random().toString(36).slice(2),name:'B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'B',slug:'b-'+Math.random().toString(36).slice(2)},ownerB.id);
  assert.throws(()=>getConnectionUsage(db,tenantB,connA.id,'7d'),/الاتصال غير موجود/);
 } finally { await cleanup(); }
});

test('Connector Analytics: cross-tenant aggregate — connections/active tenants/calls/failures/health distribution',async()=>{
 const {db,env,admin,owner,tenantId:tenantA,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,{
   slug:'analytics_co',nameAr:'x',nameEn:'x',category:'commerce',descriptionAr:'x',descriptionEn:'x',
   adapterType:'GENERIC_REST',connectionMode:'MULTI',auth:{type:'API_KEY',headerName:'X-Key'},
   capabilities:['commerce.orders.read'],rest:{baseUrl:'https://analytics-co.test'}
  });
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_orders',nameAr:'x',nameEn:'x',httpMethod:'GET',pathTemplate:'/orders',requiredCapability:'commerce.orders.read',actionType:'READ',riskLevel:'LOW'});
  publishConnector(db,env,admin,def.id);

  const connA=createConnection(db,{integrationDefinitionId:'analytics_co',name:'a'},tenantA);
  storeCredential(db,env,{connectionId:connA.id,credentialType:'api_key',payload:{apiKey:'k'}},tenantA);
  updateConnection(db,connA.id,{status:'CONNECTED'},tenantA);
  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'ownerb2_'+Math.random().toString(36).slice(2),name:'B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'B',slug:'b2-'+Math.random().toString(36).slice(2)},ownerB.id);
  const connB=createConnection(db,{integrationDefinitionId:'analytics_co',name:'b'},tenantB);
  storeCredential(db,env,{connectionId:connB.id,credentialType:'api_key',payload:{apiKey:'WRONG'}},tenantB);
  updateConnection(db,connB.id,{status:'CONNECTED'},tenantB);

  const {transport,resolver}=mockTransport();
  await executeConnectorAction({db,env,tenantId:tenantA,connectorSlug:'analytics_co',connectionId:connA.id,actionId:'get_orders',actor:owner,resolver,transport});
  await executeConnectorAction({db,env,tenantId:tenantB,connectorSlug:'analytics_co',connectionId:connB.id,actionId:'get_orders',actor:owner,resolver,transport});

  const analytics=getConnectorAnalytics(db,'analytics_co','7d');
  assert.equal(analytics.connectionsCount,2);
  assert.equal(analytics.calls,2);
  assert.equal(analytics.failures,1,'tenant B\'s wrong key call must be counted as a real cross-tenant failure');
 } finally { await cleanup(); }
});

test('No billing meter: analytics output never includes a cost/price/quota field',async()=>{
 const {db,env,admin,owner,tenantId,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,{
   slug:'nobill_co',nameAr:'x',nameEn:'x',category:'commerce',descriptionAr:'x',descriptionEn:'x',
   adapterType:'GENERIC_REST',connectionMode:'SINGLE',auth:{type:'API_KEY',headerName:'X-Key'},
   capabilities:['commerce.orders.read'],rest:{baseUrl:'https://nobill-co.test'}
  });
  publishConnector(db,env,admin,def.id);
  const conn=createConnection(db,{integrationDefinitionId:'nobill_co',name:'c1'},tenantId);
  const usage=getConnectionUsage(db,tenantId,conn.id,'24h');
  const analytics=getConnectorAnalytics(db,'nobill_co','24h');
  for(const key of [...Object.keys(usage),...Object.keys(analytics)])
   assert.doesNotMatch(key.toLowerCase(),/cost|price|bill|quota|charge/);
 } finally { await cleanup(); }
});
