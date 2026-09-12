import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createTenant} from '../src/tenancy.js';
import {createConnection} from '../src/integrations/connections.js';
import {storeCredential} from '../src/integrations/vault.js';
import {upsertAssignment} from '../src/runtime/tool-assignments.js';
import {installToolDefinitions} from '../src/runtime/tool-definitions.js';
import {
 createDraftConnector,upsertActionForConnector,deleteActionForConnector,listActions,publishConnector,updateDraftConnector,
 listConnectorVersions,getVersionDiff,createDraftVersion,discardDraftVersion,getConnectorDependencies,getConnectorForBuilder
} from '../src/connectors/dynamic/builder.js';
import {getConnectionVersionInfo,previewVersionMigration,migrateConnectionVersion,rollbackConnectionVersion} from '../src/connectors/dynamic/connection-versions.js';
import {getIntegrationDefinition} from '../src/integrations/definitions.js';
import {getTenantCatalog} from '../src/connectors/dynamic/builder.js';

// Phase 6G, Part 2-8 — Full Versioning UI backend: version list/diff, "create new draft
// version while the published one stays live", safe connection migration/rollback.
const key32=randomBytes(32).toString('hex');
const PLATFORM_ADMIN_USERNAMES='platform_admin';

async function harness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-versioning-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES}});
 const auth=(await import('../src/auth.js')).createAuth(app.store.db);
 const admin=auth.createUser({username:'platform_admin',name:'Platform Admin',password:'a-long-test-password'},'owner');
 const owner=auth.createUser({username:'owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'Co '+Math.random().toString(36).slice(2),slug:'co-'+Math.random().toString(36).slice(2)},owner.id);
 const env={INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES};
 return {app,db:app.store.db,env,admin,owner,tenantId,cleanup:async()=>{app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function mockTransport({expectedApiKey='v1-key',invoicePath='/invoices'}={}) {
 const calls=[];
 const transport=async({path,method,headers})=>{
  calls.push({path,method,headers});
  if(headers['x-acme-key']!==expectedApiKey)return {statusCode:401,headers:{},stream:Buffer.from('{}')};
  if(path==='/health')return {statusCode:200,headers:{},stream:Buffer.from('{"ok":true}')};
  if(path===invoicePath)return {statusCode:200,headers:{},stream:Buffer.from(JSON.stringify({invoices:[{id:'inv1',total:250}]}))};
  return {statusCode:404,headers:{},stream:Buffer.from('{}')};
 };
 return {transport,calls,resolver:async()=>['203.0.113.90']};
}
function throwsWithCode(fn,expectedCode) {
 let thrown=null;
 try{fn();}catch(error){thrown=error;}
 assert.ok(thrown,`expected a throw with code ${expectedCode}`);
 assert.equal(thrown.code,expectedCode);
}
async function rejectsWithCode(promise,expectedCode) {
 let thrown=null;
 try{await promise;}catch(error){thrown=error;}
 assert.ok(thrown,`expected a rejection with code ${expectedCode}`);
 assert.equal(thrown.code,expectedCode);
}
function draftInput() {
 return {
  slug:'acme_v',nameAr:'أكمي',nameEn:'Acme',category:'accounting',
  descriptionAr:'x',descriptionEn:'x',adapterType:'GENERIC_REST',connectionMode:'SINGLE',
  auth:{type:'API_KEY',headerName:'X-Acme-Key'},capabilities:['accounting.invoices.read'],
  rest:{baseUrl:'https://acme-v.test',health:{method:'GET',path:'/health',expectedStatus:200}}
 };
}

test('Version list: v1 LIVE, v2 drafted+published — v1 becomes PREVIOUS, v2 becomes LIVE, real connectionsPinned counts',async()=>{
 const {db,env,admin,owner,tenantId,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,draftInput());
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_invoices',nameAr:'ف',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/invoices',requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW'});
  const v1=publishConnector(db,env,admin,def.id);
  assert.equal(v1.version,1);
  const conn=createConnection(db,{integrationDefinitionId:'acme_v',name:'c1'},tenantId);
  storeCredential(db,env,{connectionId:conn.id,credentialType:'api_key',payload:{apiKey:'v1-key'}},tenantId);
  // Simulates the real pin-at-connect behavior application.js's generic-credential route performs.
  const {updateConnection}=await import('../src/integrations/connections.js');
  updateConnection(db,conn.id,{status:'CONNECTED',connectorVersion:1},tenantId);

  const drafted=createDraftVersion(db,env,admin,def.id);
  // Phase 6H, Part 1 — status stays PUBLISHED the whole time: the draft must never hide/disable
  // the currently-published connector.
  assert.equal(drafted.status,'PUBLISHED');
  assert.equal(drafted.hasDraft,true);
  assert.equal(drafted.liveVersion,1,'still v1 until the NEXT publish — never silently bumped just by drafting');
  updateDraftConnector(db,env,admin,def.id,{descriptionAr:'v2 desc'});
  // The action to edit now lives in the DRAFT overlay (a fresh copy, its own id) — never the
  // still-live one — so it must be looked up via the overlay-aware `listActions`, not the raw
  // live-table `listActionsForDefinition`.
  const draftAction=listActions(db,env,admin,def.id)[0];
  deleteActionForConnector(db,env,admin,def.id,draftAction.id);
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_invoices',nameAr:'ف',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/v2/invoices',requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW'});
  const v2=publishConnector(db,env,admin,def.id);
  assert.equal(v2.version,2);

  const versions=listConnectorVersions(db,env,admin,def.id);
  assert.equal(versions.length,2);
  assert.equal(versions[0].version,1);assert.equal(versions[0].status,'PREVIOUS');assert.equal(versions[0].connectionsPinned,1);
  assert.equal(versions[1].version,2);assert.equal(versions[1].status,'LIVE');assert.equal(versions[1].connectionsPinned,0);
  assert.match(versions[1].changeType,/الإجراءات/);
 } finally { await cleanup(); }
});

test('Safe Published Version Lifecycle (Phase 6H): v2 stays LIVE and fully connectable for NEW connections while v3 drafts; drafting never mutates the live tables',async()=>{
 const {db,env,admin,owner,tenantId,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,draftInput());
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_invoices',nameAr:'ف',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/invoices',requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW'});
  publishConnector(db,env,admin,def.id); // v1 == LIVE

  const before=listActionsForDefinitionRaw(db,def.id);
  createDraftVersion(db,env,admin,def.id);
  // Edit the DRAFT heavily — new name, new capability-declared action — while v1 stays live.
  updateDraftConnector(db,env,admin,def.id,{nameAr:'اسم v2 مسودة'});
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_invoices',nameAr:'ف',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/BROKEN/should-never-appear-live',requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW'});

  // The LIVE tables (what getTenantCatalog / a brand-new connection / resolveConnectorDynamic
  // actually read) must be BYTE-FOR-BYTE unaffected while the draft is in progress.
  const afterDraftEdits=listActionsForDefinitionRaw(db,def.id);
  assert.deepEqual(before,afterDraftEdits,'editing the draft overlay must never mutate the live connector_actions rows');
  const liveDefinition=getIntegrationDefinition(db,'acme_v');
  assert.equal(liveDefinition.status,'PUBLISHED');
  assert.equal(liveDefinition.nameAr,'أكمي','the live definition row\'s own name must be untouched by the draft edit');
  assert.equal(getTenantCatalog(db,tenantId).find(c=>c.slug==='acme_v')?.nameAr,'أكمي','the tenant marketplace must keep showing the LIVE name, not the draft one');

  // A tenant can still create a BRAND NEW connection against the LIVE (v1) connector while v3 drafts.
  const conn=createConnection(db,{integrationDefinitionId:'acme_v',name:'new-during-draft'},tenantId);
  assert.ok(conn.id,'new connections must remain possible while a draft is in progress — Part 1');
  } finally { await cleanup(); }
});
function listActionsForDefinitionRaw(db,definitionId) {
 return db.prepare('SELECT slug,path_template,name_ar FROM connector_actions WHERE connector_definition_id=? ORDER BY slug').all(definitionId);
}

test('Version diff: shows the real path change between v1 and v2, no secrets',async()=>{
 const {db,env,admin,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,draftInput());
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_invoices',nameAr:'ف',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/invoices',requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW'});
  publishConnector(db,env,admin,def.id);
  createDraftVersion(db,env,admin,def.id);
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_invoices',nameAr:'ف',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/v2/invoices',requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW'});
  publishConnector(db,env,admin,def.id);
  const {diff}=getVersionDiff(db,env,admin,def.id,1,2);
  assert.equal(diff.actions.changed.length,1);
  assert.equal(diff.actions.changed[0].slug,'get_invoices');
  assert.equal(diff.capabilities.added.length,0);
  assert.equal(JSON.stringify(diff).includes('X-Acme-Key'.toLowerCase())||JSON.stringify(diff).toLowerCase().includes('apikey'),false);
 } finally { await cleanup(); }
});

test('createDraftVersion rejects a DRAFT (never-published) connector and a system connector',async()=>{
 const {db,env,admin,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,draftInput());
  throwsWithCode(()=>createDraftVersion(db,env,admin,def.id),'NOT_PUBLISHED');
  throwsWithCode(()=>createDraftVersion(db,env,admin,'salla-does-not-exist-by-id'),'CONNECTOR_NOT_FOUND');
 } finally { await cleanup(); }
});

test('Connection version migration: safe path — validates target, runs a real health check against the CANDIDATE version, only then updates the pin',async()=>{
 const {db,env,admin,tenantId,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,draftInput());
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_invoices',nameAr:'ف',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/invoices',requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW'});
  publishConnector(db,env,admin,def.id);
  const conn=createConnection(db,{integrationDefinitionId:'acme_v',name:'c1'},tenantId);
  storeCredential(db,env,{connectionId:conn.id,credentialType:'api_key',payload:{apiKey:'v1-key'}},tenantId);
  const {updateConnection}=await import('../src/integrations/connections.js');
  updateConnection(db,conn.id,{status:'CONNECTED',connectorVersion:1},tenantId);

  createDraftVersion(db,env,admin,def.id);
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_invoices',nameAr:'ف',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/v2/invoices',requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW'});
  publishConnector(db,env,admin,def.id);

  const info=getConnectionVersionInfo(db,conn.id,tenantId);
  assert.equal(info.currentVersion,1);assert.equal(info.availableVersion,2);assert.equal(info.migrationAvailable,true);

  const preview=previewVersionMigration(db,tenantId,conn.id,2);
  assert.equal(preview.diff.actions.changed.length,1);
  assert.equal(preview.toolAssignmentsAffected,0);

  const {transport,resolver}=mockTransport({invoicePath:'/v2/invoices'});
  const result=await migrateConnectionVersion({db,env,tenantId,connectionId:conn.id,targetVersion:2,resolver,transport});
  assert.equal(result.toVersion,2);
  assert.equal(result.connection.connectorVersion,2);
  assert.equal(result.connection.status,'CONNECTED');
 } finally { await cleanup(); }
});

test('Safe migration REFUSES when the target version would break an active tool assignment (capability regression), and leaves the connection on the old version',async()=>{
 const {db,env,admin,owner,tenantId,cleanup}=await harness();
 try{
  installToolDefinitions(db);
  const def=createDraftConnector(db,env,admin,draftInput());
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_invoices',nameAr:'ف',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/invoices',requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW'});
  publishConnector(db,env,admin,def.id);
  const conn=createConnection(db,{integrationDefinitionId:'acme_v',name:'c1'},tenantId);
  storeCredential(db,env,{connectionId:conn.id,credentialType:'api_key',payload:{apiKey:'v1-key'}},tenantId);
  const {updateConnection}=await import('../src/integrations/connections.js');
  updateConnection(db,conn.id,{status:'CONNECTED',connectorVersion:1},tenantId);

  // A real, active tool assignment relying on v1's capability — created WHILE v1 is still the
  // live definition, exactly like a real tenant's own prior setup would be.
  db.prepare("INSERT OR IGNORE INTO tool_definitions (id,slug,description,category,risk_level,action_type,integration_slug,requires_connection,is_read_only,is_external_action,capability,requires_approval_below_level,min_level,allowed_agents,input_schema,is_available,created_at,updated_at) VALUES ('get_invoices_custom','get_invoices_custom','x','accounting','LOW','READ',NULL,1,1,0,'accounting.invoices.read',NULL,'L0',NULL,'{}',1,datetime('now'),datetime('now'))").run();
  upsertAssignment(db,tenantId,'frost','get_invoices_custom',{enabled:true,connectionId:conn.id});

  // v2 drops the declared capability entirely — a real capability regression.
  createDraftVersion(db,env,admin,def.id);
  // publishConnector's own hydrateAndValidate would fail with zero capabilities+an action
  // requiring one — so re-declare a DIFFERENT capability rather than none, to prove regression
  // detection (not just "manifest happens to be invalid").
  updateDraftConnector(db,env,admin,def.id,{capabilities:['commerce.orders.read']});
  // The one action must still declare a capability the definition has — swap it too. Its id now
  // lives in the DRAFT overlay (looked up via the overlay-aware `listActions`), never the
  // still-live one.
  deleteActionForConnector(db,env,admin,def.id,listActions(db,env,admin,def.id)[0].id);
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_orders',nameAr:'ط',nameEn:'Orders',httpMethod:'GET',pathTemplate:'/orders',requiredCapability:'commerce.orders.read',actionType:'READ',riskLevel:'LOW'});
  publishConnector(db,env,admin,def.id);

  const {transport,resolver}=mockTransport();
  await rejectsWithCode(
   migrateConnectionVersion({db,env,tenantId,connectionId:conn.id,targetVersion:2,resolver,transport}),
   'CAPABILITY_REGRESSION'
  );
  const {getConnection}=await import('../src/integrations/connections.js');
  const stillOnV1=getConnection(db,conn.id,tenantId);
  assert.equal(stillOnV1.connectorVersion,1,'must remain on the old version after a refused migration');
 } finally { await cleanup(); }
});

test('Safe migration REFUSES when the target version fails a real health check, and leaves the connection on the old version',async()=>{
 const {db,env,admin,tenantId,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,draftInput());
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_invoices',nameAr:'ف',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/invoices',requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW'});
  publishConnector(db,env,admin,def.id);
  const conn=createConnection(db,{integrationDefinitionId:'acme_v',name:'c1'},tenantId);
  storeCredential(db,env,{connectionId:conn.id,credentialType:'api_key',payload:{apiKey:'v1-key'}},tenantId);
  const {updateConnection,getConnection}=await import('../src/integrations/connections.js');
  updateConnection(db,conn.id,{status:'CONNECTED',connectorVersion:1},tenantId);
  createDraftVersion(db,env,admin,def.id);
  publishConnector(db,env,admin,def.id); // v2, unchanged shape — but we'll use a key that fails auth

  const {transport,resolver}=mockTransport({expectedApiKey:'WRONG-KEY'});
  await rejectsWithCode(
   migrateConnectionVersion({db,env,tenantId,connectionId:conn.id,targetVersion:2,resolver,transport}),
   'TARGET_VERSION_UNHEALTHY'
  );
  assert.equal(getConnection(db,conn.id,tenantId).connectorVersion,1);
 } finally { await cleanup(); }
});

test('Rollback: moves back to the nearest valid previous version through the same safe-migration gate',async()=>{
 const {db,env,admin,tenantId,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,draftInput());
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_invoices',nameAr:'ف',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/invoices',requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW'});
  publishConnector(db,env,admin,def.id);
  createDraftVersion(db,env,admin,def.id);
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_invoices',nameAr:'ف',nameEn:'Invoices',httpMethod:'GET',pathTemplate:'/v2/invoices',requiredCapability:'accounting.invoices.read',actionType:'READ',riskLevel:'LOW'});
  publishConnector(db,env,admin,def.id);
  const conn=createConnection(db,{integrationDefinitionId:'acme_v',name:'c1'},tenantId);
  storeCredential(db,env,{connectionId:conn.id,credentialType:'api_key',payload:{apiKey:'v1-key'}},tenantId);
  const {updateConnection,getConnection}=await import('../src/integrations/connections.js');
  updateConnection(db,conn.id,{status:'CONNECTED',connectorVersion:2},tenantId);

  const {transport,resolver}=mockTransport({invoicePath:'/invoices'}); // v1's own path
  const result=await rollbackConnectionVersion({db,env,tenantId,connectionId:conn.id,resolver,transport});
  assert.equal(result.toVersion,1);
  assert.equal(getConnection(db,conn.id,tenantId).connectorVersion,1);

  await rejectsWithCode(rollbackConnectionVersion({db,env,tenantId,connectionId:conn.id,resolver,transport}),'NO_PREVIOUS_VERSION');
 } finally { await cleanup(); }
});

test('getConnectorDependencies still works after this phase\'s additions (regression guard)',async()=>{
 const {db,env,admin,tenantId,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,draftInput());
  publishConnector(db,env,admin,def.id);
  createConnection(db,{integrationDefinitionId:'acme_v',name:'c1'},tenantId);
  const deps=getConnectorDependencies(db,env,admin,def.id);
  assert.equal(deps.connections,1);
 } finally { await cleanup(); }
});
