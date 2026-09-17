import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {createTenant} from '../src/tenancy.js';
import {createConnection,updateConnection} from '../src/integrations/connections.js';
import {upsertAssignment} from '../src/runtime/tool-assignments.js';
import {updateTenantAgentConfig} from '../src/runtime/agent-config.js';

// Phase 4C-2 — SaaS Control Center. GET /api/control-center/summary is the one real,
// tenant-scoped aggregation every Control Center tab reads from
// (src/runtime/control-center.js) — these tests prove it never fabricates a status (Part C:
// "never enabled=true => READY") and never leaks another tenant's data.
async function harness(env={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-cc-'));
 const app=await createApp({dataDir:directory,env});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}) {
  const hasBody=input!==undefined && input!==null && method!=='GET';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),redirect:'manual',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 return {app,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}
async function twoTenants(env={}) {
 const {app,call,cleanup}=await harness(env);
 const ownerA=await call('/api/setup',{username:'ownera',name:'Owner A',password:'a-long-test-password'});
 await call('/api/auth',null,ownerA,{method:'GET'});
 const userA=app.store.db.prepare("SELECT id FROM users WHERE username='ownera'").get();
 const tenantA=app.store.db.prepare('SELECT tenant_id AS id FROM tenant_memberships WHERE user_id=?').get(userA.id).id;
 const auth=createAuth(app.store.db);
 const userB=auth.createUser({username:'ownerb',name:'Owner B',password:'a-long-test-password'},'owner');
 const tenantB=createTenant(app.store.db,{name:'Tenant B',slug:'tenant-b'},userB.id);
 const loginB=auth.login({username:'ownerb',password:'a-long-test-password'},'127.0.0.1');
 const ownerB={cookie:'hc_session='+loginB.token,csrf:loginB.csrf};
 return {app,call,cleanup,ownerA,ownerB,tenantA,tenantB};
}

test('Control Center summary: real readiness, never enabled=true => READY (no AI provider configured -> every agent BLOCKED)',async()=>{
 const {call,cleanup,ownerA}=await twoTenants();
 try{
  const summary=await call('/api/control-center/summary',null,ownerA,{method:'GET'});
  assert.equal(summary.status,200);
  assert.equal(summary.data.agents.total,13);
  assert.equal(summary.data.agents.enabled,13); // enabled by legacy default...
  assert.equal(summary.data.agents.ready,0); // ...but NOT ready, since no AI provider is configured
  assert.equal(summary.data.agents.blocked,13);
  for(const agent of summary.data.agents.items)assert.equal(agent.status,'BLOCKED');
 }finally{await cleanup();}
});

test('Control Center summary: tool/integration/AI-provider counts reflect the real catalog and real (empty) tenant state',async()=>{
 const {call,cleanup,ownerA}=await twoTenants();
 try{
  const summary=(await call('/api/control-center/summary',null,ownerA,{method:'GET'})).data;
  assert.equal(summary.tools.total,50); // ...; Phase 7B added 5 more; Phase 7C added 6 Workflow Engine chat tools; Phase MKT-2 Part I/J added meta_message_send
  assert.equal(summary.tools.unavailable,2); // canva_generateAsset, salla_syncOrders — honestly NOT_IMPLEMENTED
  assert.equal(summary.integrations.providers.length,10);
  assert.equal(summary.integrations.configuredProviders,0); // no connection created yet
  assert.equal(summary.aiProviders.length,0);
  assert.equal(summary.workspace.role,'owner');
 }finally{await cleanup();}
});

test('Control Center summary: real connections and AI-connection-to-agent usage appear correctly once configured',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const salla=createConnection(app.store.db,{integrationDefinitionId:'salla',name:'Main Store'},tenantA);
  updateConnection(app.store.db,salla.id,{status:'CONNECTED'},tenantA);
  const ai=createConnection(app.store.db,{integrationDefinitionId:'anthropic',name:'Anthropic Main'},tenantA);
  updateConnection(app.store.db,ai.id,{status:'CONNECTED'},tenantA);
  updateTenantAgentConfig(app.store.db,tenantA,'sales',{aiConnectionId:ai.id});
  const summary=(await call('/api/control-center/summary',null,ownerA,{method:'GET'})).data;
  assert.equal(summary.integrations.configuredProviders,2);
  assert.equal(summary.integrations.healthyConnections,2);
  const sallaProvider=summary.integrations.providers.find(p=>p.slug==='salla');
  assert.equal(sallaProvider.connections.length,1);assert.equal(sallaProvider.connections[0].id,salla.id);
  assert.equal(summary.aiProviders.length,1);
  assert.deepEqual(summary.aiProviders[0].agentsUsing,['sales']);
 }finally{await cleanup();}
});

test('Control Center summary: CONNECTION_CAPABILITY_MISSING is tallied honestly in the tools status breakdown',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const salla=createConnection(app.store.db,{integrationDefinitionId:'salla',name:'Main Store'},tenantA);
  updateConnection(app.store.db,salla.id,{status:'CONNECTED',scopes:['orders.read']},tenantA); // missing products.read
  upsertAssignment(app.store.db,tenantA,'sales','get_current_price',{connectionId:salla.id});
  const summary=(await call('/api/control-center/summary',null,ownerA,{method:'GET'})).data;
  assert.ok(summary.tools.statusCounts.CONNECTION_CAPABILITY_MISSING>=1);
 }finally{await cleanup();}
});

test('Control Center summary: Tenant B never sees Tenant A\'s connections, AI providers, or agent config',async()=>{
 const {app,call,cleanup,ownerA,ownerB,tenantA}=await twoTenants();
 try{
  const salla=createConnection(app.store.db,{integrationDefinitionId:'salla',name:'A Store'},tenantA);
  updateConnection(app.store.db,salla.id,{status:'CONNECTED'},tenantA);
  const ai=createConnection(app.store.db,{integrationDefinitionId:'anthropic',name:'A Anthropic'},tenantA);
  updateConnection(app.store.db,ai.id,{status:'CONNECTED'},tenantA);
  updateTenantAgentConfig(app.store.db,tenantA,'sales',{aiConnectionId:ai.id,model:'a-secret-model-name'});

  const summaryA=(await call('/api/control-center/summary',null,ownerA,{method:'GET'})).data;
  assert.equal(summaryA.integrations.configuredProviders,2);

  const summaryB=(await call('/api/control-center/summary',null,ownerB,{method:'GET'})).data;
  assert.equal(summaryB.integrations.configuredProviders,0);
  assert.equal(summaryB.aiProviders.length,0);
  assert.equal(JSON.stringify(summaryB).includes('a-secret-model-name'),false);
  assert.equal(JSON.stringify(summaryB).includes(salla.id),false);
 }finally{await cleanup();}
});

test('Control Center summary: a reviewer is denied (owner/operator only, matching every other agent-config/readiness read)',async()=>{
 const {app,call,cleanup}=await twoTenants();
 try{
  const auth=createAuth(app.store.db);
  auth.createUser({username:'reviewer1',name:'Reviewer',password:'a-long-test-password'},'reviewer');
  const login=auth.login({username:'reviewer1',password:'a-long-test-password'},'127.0.0.1');
  const reviewer={cookie:'hc_session='+login.token,csrf:login.csrf};
  const result=await call('/api/control-center/summary',null,reviewer,{method:'GET'});
  assert.equal(result.status,403);
 }finally{await cleanup();}
});

test('Control Center summary: never exposes a credential, access token, or vault payload',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const ai=createConnection(app.store.db,{integrationDefinitionId:'anthropic',name:'Anthropic Main'},tenantA);
  updateConnection(app.store.db,ai.id,{status:'CONNECTED'},tenantA);
  const raw=JSON.stringify((await call('/api/control-center/summary',null,ownerA,{method:'GET'})).data);
  // Phase 6G added a real, honest `authType` field to each provider (e.g. `"API_KEY"` for
  // Anthropic) — its classification VALUE legitimately contains the substring "api_key" once
  // lowercased, which is not a leak. Checked as a real JSON key-holding-a-value shape instead
  // of a blanket substring, exactly like `secret`/`password` (which have no such collision here).
  for(const forbidden of ['accessToken":','access_token":','refreshToken":','refresh_token":'])
   assert.equal(raw.includes(forbidden),false,`must never include a real ${forbidden} field`);
  for(const forbidden of ['"apiKey":','"api_key":'])
   assert.equal(raw.includes(forbidden),false,`must never include a real ${forbidden} field`);
  for(const forbidden of ['secret','password'])
   assert.equal(raw.toLowerCase().includes(forbidden),false,`must never include ${forbidden}`);
 }finally{await cleanup();}
});

test('Control Center summary: reflects the workspace switch immediately (Phase 4C-1 regression) — no stale data across a real switch',async()=>{
 const {app,call,cleanup,ownerA,tenantA,tenantB}=await twoTenants();
 try{
  // Give Owner A a second membership (tenantB) so they can actually switch.
  const userAId=app.store.db.prepare("SELECT id FROM users WHERE username='ownera'").get().id;
  app.store.db.prepare('INSERT INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)').run(crypto.randomUUID(),tenantB,userAId,'owner','active',0,new Date().toISOString());
  const sallaA=createConnection(app.store.db,{integrationDefinitionId:'salla',name:'A Store'},tenantA);
  updateConnection(app.store.db,sallaA.id,{status:'CONNECTED'},tenantA);

  const activateA=await call('/api/workspaces/active',{workspaceId:tenantA},ownerA,{method:'PUT'});
  assert.equal(activateA.status,200);
  const beforeSwitch=(await call('/api/control-center/summary',null,ownerA,{method:'GET'})).data;
  assert.equal(beforeSwitch.integrations.configuredProviders,1);

  const activateB=await call('/api/workspaces/active',{workspaceId:tenantB},ownerA,{method:'PUT'});
  assert.equal(activateB.status,200);
  const afterSwitch=(await call('/api/control-center/summary',null,ownerA,{method:'GET'})).data;
  assert.equal(afterSwitch.integrations.configuredProviders,0);
  assert.equal(afterSwitch.workspace.id,tenantB);
 }finally{await cleanup();}
});
