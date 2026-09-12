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
import {validateManifest} from '../src/connectors/core/manifest.js';
import {validateAdapter} from '../src/connectors/core/adapter.js';
import {canonicalizeCapability,isKnownCapability,CANONICAL_CAPABILITIES} from '../src/connectors/core/capability-registry.js';
import {listConnectorManifests,getConnector,getConnectorManifest} from '../src/connectors/registry.js';
import {executeConnectorAction} from '../src/connectors/core/runtime.js';
import {CONNECTOR_CATEGORY,CONNECTOR_AVAILABILITY,CONNECTION_MODE,AUTH_TYPE,ACTION_TYPE,RISK_LEVEL} from '../src/connectors/core/enums.js';

// Phase 6A — Universal Connector Framework. Real DB/harness, same shape as every prior phase's
// own test file.
const key32=randomBytes(32).toString('hex');
async function harness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-connector-sdk-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32}});
 const auth=createAuth(app.store.db);
 const owner=auth.createUser({username:'conn_owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'Acme Co '+Math.random().toString(36).slice(2),slug:'acme-'+Math.random().toString(36).slice(2)},owner.id);
 return {app,db:app.store.db,owner,tenantId,cleanup:async()=>{app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function connectedConnection(db,tenantId,integrationDefinitionId,payload) {
 const connection=createConnection(db,{integrationDefinitionId,name:'Test'},tenantId);
 storeCredential(db,{INTEGRATION_ENCRYPTION_KEY:key32},{connectionId:connection.id,credentialType:integrationDefinitionId==='salla'?'oauth_tokens':'api_key',payload},tenantId);
 return updateConnection(db,connection.id,{status:'CONNECTED'},tenantId);
}
function jsonResponse(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});}

// --- Capability Registry -------------------------------------------------------------------

test('canonicalizeCapability resolves every real legacy alias found by the Phase 6 audit, and leaves an already-canonical or unknown string unchanged',()=>{
 assert.equal(canonicalizeCapability('publishing'),'social.publish');
 assert.equal(canonicalizeCapability('publish'),'social.publish');
 assert.equal(canonicalizeCapability('organization.publish'),'social.publish');
 assert.equal(canonicalizeCapability('orders.read'),'commerce.orders.read');
 assert.equal(canonicalizeCapability('commerce.stock.read'),'commerce.inventory.read');
 assert.equal(canonicalizeCapability('commerce.price.read'),'commerce.pricing.read');
 assert.equal(canonicalizeCapability('commerce.products.read'),'commerce.products.read');
 assert.equal(canonicalizeCapability('totally-unknown-capability'),'totally-unknown-capability');
});
test('isKnownCapability is true for every canonical id and false for a genuinely unknown one',()=>{
 for(const c of CANONICAL_CAPABILITIES)assert.equal(isKnownCapability(c.id),true);
 assert.equal(isKnownCapability('made.up.capability'),false);
});

// --- Manifest validation ---------------------------------------------------------------------

const baseManifest={
 id:'acme',slug:'acme',nameAr:'أكمي',nameEn:'Acme',category:CONNECTOR_CATEGORY.COMMERCE,version:1,
 availability:CONNECTOR_AVAILABILITY.DEFINITION_ONLY,connectionMode:CONNECTION_MODE.SINGLE,
 auth:{type:AUTH_TYPE.API_KEY},capabilities:['commerce.orders.read']
};
test('validateManifest accepts a real, complete manifest and canonicalizes its capabilities',()=>{
 const manifest=validateManifest({...baseManifest,capabilities:['orders.read']});
 assert.deepEqual(manifest.capabilities,['commerce.orders.read']);
});
test('validateManifest rejects a manifest missing a required field',()=>{
 const {slug,...noSlug}=baseManifest;
 assert.throws(()=>validateManifest(noSlug),/missing required field: slug/);
});
test('validateManifest rejects an unknown category/availability/connectionMode/auth.type',()=>{
 assert.throws(()=>validateManifest({...baseManifest,category:'NOT_A_CATEGORY'}),/Unknown connector category/);
 assert.throws(()=>validateManifest({...baseManifest,availability:'FAKE'}),/Unknown connector availability/);
 assert.throws(()=>validateManifest({...baseManifest,connectionMode:'FAKE'}),/Unknown connectionMode/);
 assert.throws(()=>validateManifest({...baseManifest,auth:{type:'FAKE'}}),/Unknown auth.type/);
});
test('validateManifest requires a real https:// authorizeUrl/tokenUrl for OAUTH2',()=>{
 assert.throws(()=>validateManifest({...baseManifest,auth:{type:AUTH_TYPE.OAUTH2}}),/authorizeUrl must be a real https/);
 assert.throws(()=>validateManifest({...baseManifest,auth:{type:AUTH_TYPE.OAUTH2,authorizeUrl:'https://x.com/a',tokenUrl:'http://x.com/t'}}),/tokenUrl must be a real https/);
});
test('validateManifest refuses a write-shaped action that declares riskLevel LOW (Part 94 — no silent low-risk default for a real write)',()=>{
 const withAction={...baseManifest,actions:[{id:'a.w',slug:'w',method:'POST',requiredCapability:'commerce.orders.read',riskLevel:RISK_LEVEL.LOW,actionType:ACTION_TYPE.EXTERNAL_WRITE}]};
 assert.throws(()=>validateManifest(withAction),/cannot declare riskLevel LOW/);
});
test('validateManifest defaults requiresApprovalDefault to true for every write-shaped action type, false for READ',()=>{
 const write=validateManifest({...baseManifest,actions:[{id:'a.w',slug:'w',method:'POST',requiredCapability:'commerce.orders.read',riskLevel:RISK_LEVEL.MEDIUM,actionType:ACTION_TYPE.EXTERNAL_WRITE}]});
 assert.equal(write.actions[0].requiresApprovalDefault,true);
 const read=validateManifest({...baseManifest,actions:[{id:'a.r',slug:'r',method:'GET',requiredCapability:'commerce.orders.read',riskLevel:RISK_LEVEL.LOW,actionType:ACTION_TYPE.READ}]});
 assert.equal(read.actions[0].requiresApprovalDefault,false);
});
test('validateManifest rejects an action whose requiredCapability the manifest never declared',()=>{
 const manifest={...baseManifest,capabilities:['commerce.orders.read'],actions:[{id:'a.p',slug:'p',method:'GET',requiredCapability:'commerce.products.read',riskLevel:RISK_LEVEL.LOW,actionType:ACTION_TYPE.READ}]};
 assert.throws(()=>validateManifest(manifest),/not declared in manifest.capabilities/);
});

// --- Adapter contract --------------------------------------------------------------------------

test('validateAdapter requires healthCheck, requires executeAction when actions exist, and rejects an unknown method',()=>{
 const manifestWithAction=validateManifest({...baseManifest,actions:[{id:'a.r',slug:'r',method:'GET',requiredCapability:'commerce.orders.read',riskLevel:RISK_LEVEL.LOW,actionType:ACTION_TYPE.READ}]});
 assert.throws(()=>validateAdapter({},manifestWithAction),/must implement healthCheck/);
 assert.throws(()=>validateAdapter({healthCheck:async()=>({status:'OK'})},manifestWithAction),/no executeAction/);
 assert.throws(()=>validateAdapter({healthCheck:async()=>({status:'OK'}),executeAction:async()=>({}),madeUpMethod:()=>{}},manifestWithAction),/unknown method/);
 assert.equal(validateAdapter({healthCheck:async()=>({status:'OK'}),executeAction:async()=>({})},manifestWithAction),true);
});

// --- Registry: the 3 real, wrapped providers load without throwing ---------------------------

test('The connector registry loads Salla/Anthropic/OpenAI/Zid as real Connectors with validated manifests+adapters',()=>{
 const manifests=listConnectorManifests();
 assert.equal(manifests.length,4);
 assert.ok(getConnectorManifest('salla'));
 assert.ok(getConnectorManifest('anthropic'));
 assert.ok(getConnectorManifest('openai'));
 assert.ok(getConnectorManifest('zid'));
 assert.equal(getConnector('salla').manifest.connectionMode,'MULTI');
 assert.equal(getConnector('zid').manifest.connectionMode,'MULTI');
 assert.equal(getConnector('does-not-exist'),null);
});

// --- ConnectorRuntime.execute() pipeline, against the REAL Anthropic/Salla adapters -----------

test('ConnectorRuntime.execute(): a real Anthropic test_key action succeeds end-to-end through a real tenant+connection+vault credential',async()=>{
 const {db,tenantId,owner,cleanup}=await harness();
 try{
  const connection=connectedConnection(db,tenantId,'anthropic',{apiKey:'sk-real'});
  const fetcher=async()=>jsonResponse({data:[]});
  const result=await executeConnectorAction({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},fetcher,tenantId,connectorSlug:'anthropic',connectionId:connection.id,actionId:'test_key',actor:owner});
  assert.equal(result.status,'OK');
  assert.equal(result.output.ok,true);
  assert.ok(result.correlationId);
  const audit=db.prepare("SELECT * FROM audit_logs WHERE action='CONNECTOR_ACTION_EXECUTED' AND tenant_id=?").get(tenantId);
  assert.ok(audit,'a real audit row must be recorded');
 }finally{await cleanup();}
});
test('ConnectorRuntime.execute(): a real Salla sync_products action paginates through the real, existing importSalla() and returns the full catalog',async()=>{
 const {db,tenantId,owner,cleanup}=await harness();
 try{
  const connection=connectedConnection(db,tenantId,'salla',{accessToken:'tok-real',refreshToken:'r',expiresAt:new Date(Date.now()+3600000).toISOString()});
  const fetcher=async()=>jsonResponse({success:true,data:[{id:123,name:'منتج اختبار',urls:{customer:'https://hyper-cool.com/product/p123'},taxed_price:{amount:100,currency:'SAR'},quantity:'4',is_available:true,status:'sale'}],pagination:{totalPages:1}});
  const result=await executeConnectorAction({db,env:{INTEGRATION_ENCRYPTION_KEY:key32},fetcher,tenantId,connectorSlug:'salla',connectionId:connection.id,actionId:'sync_products',actor:owner});
  assert.equal(result.status,'OK');
  assert.equal(result.output.count,1);
 }finally{await cleanup();}
});
test('ConnectorRuntime.execute(): a SUSPENDED tenant is blocked before any connector code runs, even with a healthy connection',async()=>{
 const {db,tenantId,owner,cleanup}=await harness();
 try{
  const connection=connectedConnection(db,tenantId,'anthropic',{apiKey:'sk-real'});
  db.prepare("UPDATE tenants SET status='SUSPENDED' WHERE id=?").run(tenantId);
  const result=await executeConnectorAction({db,env:{},fetcher:async()=>{throw new Error('must never be called');},tenantId,connectorSlug:'anthropic',connectionId:connection.id,actionId:'test_key',actor:owner});
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.errorCode,'TENANT_SUSPENDED');
 }finally{await cleanup();}
});
test('ConnectorRuntime.execute(): IDOR — a connection belonging to Tenant A can never be used under Tenant B\'s tenantId',async()=>{
 const {db,tenantId:tenantA,owner,cleanup}=await harness();
 try{
  const auth=createAuth(db);
  const ownerB=auth.createUser({username:'conn_owner_b_'+Math.random().toString(36).slice(2),name:'Owner B',password:'a-long-test-password'},'owner');
  const tenantB=createTenant(db,{name:'Second Co',slug:'second-co-'+Math.random().toString(36).slice(2)},ownerB.id);
  const connectionA=connectedConnection(db,tenantA,'anthropic',{apiKey:'sk-real'});
  const result=await executeConnectorAction({db,env:{},fetcher:async()=>{throw new Error('must never be called');},tenantId:tenantB,connectorSlug:'anthropic',connectionId:connectionA.id,actionId:'test_key',actor:owner});
  assert.equal(result.status,'ERROR');
  assert.equal(result.errorCode,'CONNECTION_NOT_FOUND');
 }finally{await cleanup();}
});
test('ConnectorRuntime.execute(): unknown connector / unknown action / connection not connected all fail safely, never throw',async()=>{
 const {db,tenantId,owner,cleanup}=await harness();
 try{
  const notFoundConnector=await executeConnectorAction({db,env:{},fetcher:async()=>{throw new Error('unused');},tenantId,connectorSlug:'does-not-exist',connectionId:'x',actionId:'y',actor:owner});
  assert.equal(notFoundConnector.status,'ERROR');
  assert.equal(notFoundConnector.errorCode,'CONNECTOR_NOT_FOUND');

  const connection=createConnection(db,{integrationDefinitionId:'anthropic',name:'Not connected'},tenantId);
  const notConnected=await executeConnectorAction({db,env:{},fetcher:async()=>{throw new Error('unused');},tenantId,connectorSlug:'anthropic',connectionId:connection.id,actionId:'test_key',actor:owner});
  assert.equal(notConnected.status,'ERROR');
  assert.equal(notConnected.errorCode,'CONNECTION_UNHEALTHY');

  const connected=connectedConnection(db,tenantId,'anthropic',{apiKey:'sk-real'});
  const unknownAction=await executeConnectorAction({db,env:{},fetcher:async()=>{throw new Error('unused');},tenantId,connectorSlug:'anthropic',connectionId:connected.id,actionId:'no-such-action',actor:owner});
  assert.equal(unknownAction.status,'ERROR');
  assert.equal(unknownAction.errorCode,'ACTION_NOT_FOUND');
 }finally{await cleanup();}
});
test('ConnectorRuntime.execute(): a write-shaped action with requiresApprovalDefault creates a real Approval and never executes the adapter',async()=>{
 const {db,tenantId,owner,cleanup}=await harness();
 try{
  const testManifest=validateManifest({
   id:'acme',slug:'acme',nameAr:'أكمي',nameEn:'Acme',category:CONNECTOR_CATEGORY.COMMERCE,version:1,
   availability:CONNECTOR_AVAILABILITY.DEFINITION_ONLY,connectionMode:CONNECTION_MODE.SINGLE,auth:{type:AUTH_TYPE.API_KEY},
   capabilities:['commerce.orders.write'],
   actions:[{id:'acme.create_order',slug:'create_order',method:'POST',requiredCapability:'commerce.orders.write',riskLevel:RISK_LEVEL.HIGH,actionType:ACTION_TYPE.EXTERNAL_WRITE}]
  });
  let adapterCalled=false;
  const testAdapter={healthCheck:async()=>({status:'OK'}),executeAction:async()=>{adapterCalled=true;return {status:'OK'};}};
  validateAdapter(testAdapter,testManifest);
  const resolveConnector=slug=>slug==='acme'?{manifest:testManifest,adapter:testAdapter}:null;
  // 'acme' is a pure test-only connector, deliberately never seeded into integration_definitions
  // (Part 82/139 — a real Builder-published connector would seed one; that is Phase 6D's job)
  // — inserted directly to isolate this test to the ConnectorRuntime pipeline itself.
  const connectionId='conn-'+Math.random().toString(36).slice(2);
  const now=new Date().toISOString();
  db.prepare('INSERT INTO integration_connections (id,tenant_id,integration_definition_id,name,status,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
   .run(connectionId,tenantId,'acme','Acme Test','CONNECTED',1,now,now);
  const result=await executeConnectorAction({db,env:{},fetcher:async()=>{throw new Error('must never be called before approval');},tenantId,connectorSlug:'acme',connectionId,actionId:'create_order',actor:owner,resolveConnector});
  assert.equal(result.status,'WAITING_APPROVAL');
  assert.ok(result.approvalId);
  assert.equal(adapterCalled,false);
  const approval=db.prepare('SELECT * FROM agent_approvals WHERE id=?').get(result.approvalId);
  assert.equal(approval.action_type,'connector_action');
  assert.equal(approval.tenant_id,tenantId);
 }finally{await cleanup();}
});
