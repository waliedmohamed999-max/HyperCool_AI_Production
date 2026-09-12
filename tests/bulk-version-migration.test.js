import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createTenant} from '../src/tenancy.js';
import {createAuth} from '../src/auth.js';
import {createConnection,updateConnection,getConnection} from '../src/integrations/connections.js';
import {storeCredential} from '../src/integrations/vault.js';
import {upsertAssignment} from '../src/runtime/tool-assignments.js';
import {installToolDefinitions} from '../src/runtime/tool-definitions.js';
import {createDraftConnector,upsertActionForConnector,publishConnector,createDraftVersion,deleteActionForConnector,listActions} from '../src/connectors/dynamic/builder.js';
import {previewBulkVersionMigration,bulkMigrateConnections,bulkRollbackOperation,getBulkOperation} from '../src/connectors/dynamic/bulk-operations.js';

// Phase 6H, Part 6-9 — Bulk Connection Version Migration.
const key32=randomBytes(32).toString('hex');
const PLATFORM_ADMIN_USERNAMES='platform_admin';

async function harness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-bulkmigrate-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES}});
 const auth=createAuth(app.store.db);
 const admin=auth.createUser({username:'platform_admin',name:'Platform Admin',password:'a-long-test-password'},'owner');
 const owner=auth.createUser({username:'owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'Co '+Math.random().toString(36).slice(2),slug:'co-'+Math.random().toString(36).slice(2)},owner.id);
 const env={INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES};
 return {app,db:app.store.db,env,admin,owner,tenantId,cleanup:async()=>{app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function mockTransport({expectedApiKey='v1-key',invoicePath='/invoices'}={}) {
 const transport=async({path,headers})=>{
  if(headers['x-acme-key']!==expectedApiKey)return {statusCode:401,headers:{},stream:Buffer.from('{}')};
  if(path==='/health')return {statusCode:200,headers:{},stream:Buffer.from('{"ok":true}')};
  if(path===invoicePath)return {statusCode:200,headers:{},stream:Buffer.from(JSON.stringify({invoices:[]}))};
  return {statusCode:404,headers:{},stream:Buffer.from('{}')};
 };
 return {transport,resolver:async()=>['203.0.113.90']};
}
function draftInput() {
 return {
  slug:'bulk_co',nameAr:'x',nameEn:'x',category:'accounting',descriptionAr:'x',descriptionEn:'x',
  adapterType:'GENERIC_REST',connectionMode:'MULTI',auth:{type:'API_KEY',headerName:'X-Acme-Key'},
  capabilities:['accounting.invoices.read'],rest:{baseUrl:'https://bulk-co.test',health:{method:'GET',path:'/health',expectedStatus:200}}
 };
}
async function setupTwoVersionsWithConnections(db,env,admin,tenantIds) {
 const def=createDraftConnector(db,env,admin,draftInput());
 upsertActionForConnector(db,env,admin,def.id,{slug:'get_invoices',nameAr:'ف',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/invoices',requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW'});
 publishConnector(db,env,admin,def.id); // v1
 createDraftVersion(db,env,admin,def.id);
 deleteActionForConnector(db,env,admin,def.id,listActions(db,env,admin,def.id)[0].id);
 upsertActionForConnector(db,env,admin,def.id,{slug:'get_invoices',nameAr:'ف',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/v2/invoices',requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW'});
 publishConnector(db,env,admin,def.id); // v2
 const connections=[];
 for(const tenantId of tenantIds) {
  const conn=createConnection(db,{integrationDefinitionId:'bulk_co',name:'c-'+tenantId},tenantId);
  storeCredential(db,env,{connectionId:conn.id,credentialType:'api_key',payload:{apiKey:'v1-key'}},tenantId);
  updateConnection(db,conn.id,{status:'CONNECTED',connectorVersion:1},tenantId);
  connections.push({...conn,tenantId});
 }
 return {def,connections};
}

test('Bulk migration preview: real counts, no network call, no state change',async()=>{
 const {db,env,admin,tenantId,cleanup}=await harness();
 try{
  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'ownerb_'+Math.random().toString(36).slice(2),name:'B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'B',slug:'b-'+Math.random().toString(36).slice(2)},ownerB.id);
  const {connections}=await setupTwoVersionsWithConnections(db,env,admin,[tenantId,tenantB]);
  const preview=previewBulkVersionMigration(db,env,admin,{connectorSlug:'bulk_co',fromVersion:1,toVersion:2});
  assert.equal(preview.totalAffected,2);
  assert.equal(preview.tenants,2);
  assert.equal(preview.capabilityRegressionCount,0);
  for(const c of connections)assert.equal(getConnection(db,c.id,c.tenantId).connectorVersion,1,'preview must never change state');
 } finally { await cleanup(); }
});

test('Bulk migration: executes the safe per-connection gate for every connection, classifies READY/SKIPPED/FAILED, persists an auditable operation',async()=>{
 const {db,env,admin,tenantId,cleanup}=await harness();
 try{
  installToolDefinitions(db);
  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'ownerb2_'+Math.random().toString(36).slice(2),name:'B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'B',slug:'b2-'+Math.random().toString(36).slice(2)},ownerB.id);
  const {connections}=await setupTwoVersionsWithConnections(db,env,admin,[tenantId,tenantB]);
  // Tenant B's connection has the wrong key — its health check against v2 will fail -> SKIPPED.
  storeCredential(db,env,{connectionId:connections[1].id,credentialType:'api_key',payload:{apiKey:'WRONG'}},tenantB);

  const {transport,resolver}=mockTransport({invoicePath:'/v2/invoices'});
  const result=await bulkMigrateConnections({db,env,fetcher:undefined,resolver,transport,actorUser:admin,connectorSlug:'bulk_co',fromVersion:1,toVersion:2,connectionIds:connections.map(c=>c.id)});
  assert.equal(result.summary.ready,1);
  assert.equal(result.summary.skipped,1);
  assert.equal(result.summary.failed,0);
  assert.equal(getConnection(db,connections[0].id,tenantId).connectorVersion,2,'the healthy connection was actually migrated');
  assert.equal(getConnection(db,connections[1].id,tenantB).connectorVersion,1,'the unhealthy one is untouched — only READY connections are migrated');

  const stored=getBulkOperation(db,env,admin,result.operationId);
  assert.equal(stored.type,'VERSION_MIGRATION');
  assert.equal(stored.results.length,2);
 } finally { await cleanup(); }
});

test('Bulk migration is bounded — a batch larger than the configured maximum is refused outright',async()=>{
 const {db,env,admin,tenantId,cleanup}=await harness();
 try{
  const {connections}=await setupTwoVersionsWithConnections(db,env,admin,[tenantId]);
  const fakeIds=Array.from({length:201},(_,i)=>connections[0].id+'-fake-'+i);
  let thrown=null;
  try{await bulkMigrateConnections({db,env,actorUser:admin,connectorSlug:'bulk_co',fromVersion:1,toVersion:2,connectionIds:fakeIds});}
  catch(error){thrown=error;}
  assert.equal(thrown?.code,'BATCH_TOO_LARGE');
 } finally { await cleanup(); }
});

test('Bulk rollback: rolls back ONLY the connections a specific prior operation actually migrated, to their exact prior version',async()=>{
 const {db,env,admin,tenantId,cleanup}=await harness();
 try{
  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'ownerb3_'+Math.random().toString(36).slice(2),name:'B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'B',slug:'b3-'+Math.random().toString(36).slice(2)},ownerB.id);
  const {connections}=await setupTwoVersionsWithConnections(db,env,admin,[tenantId,tenantB]);

  const {transport,resolver}=mockTransport({invoicePath:'/v2/invoices'});
  const forward=await bulkMigrateConnections({db,env,resolver,transport,actorUser:admin,connectorSlug:'bulk_co',fromVersion:1,toVersion:2,connectionIds:connections.map(c=>c.id)});
  assert.equal(forward.summary.ready,2);

  const {transport:t1,resolver:r1}=mockTransport({invoicePath:'/invoices'}); // v1's real path, for the rollback's own health check
  const rollback=await bulkRollbackOperation({db,env,resolver:r1,transport:t1,actorUser:admin,operationId:forward.operationId});
  assert.equal(rollback.summary.ready,2);
  for(const c of connections)assert.equal(getConnection(db,c.id,c.tenantId).connectorVersion,1);
 } finally { await cleanup(); }
});

test('Bulk operations are Platform Admin only',async()=>{
 const {db,env,owner,tenantId,cleanup}=await harness();
 try{
  let thrown=null;
  try{previewBulkVersionMigration(db,env,owner,{connectorSlug:'bulk_co',fromVersion:1,toVersion:2});}catch(error){thrown=error;}
  assert.equal(thrown?.code,'PLATFORM_ADMIN_REQUIRED');
 } finally { await cleanup(); }
});
