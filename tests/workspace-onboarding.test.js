import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {createTenant} from '../src/tenancy.js';
import {createConnection,updateConnection} from '../src/integrations/connections.js';
import {getTenantAgentConfig,updateTenantAgentConfig} from '../src/runtime/agent-config.js';

// Phase 4C-4 — Guided Workspace Onboarding. Real HTTP end-to-end tests, same harness shape as
// tests/control-center.test.js / tests/workspace-invitations.test.js.
async function harness(env={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-onboarding-'));
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

test('NOT_STARTED for a fresh tenant that never opened the wizard; GET never silently creates a row',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const first=await call('/api/onboarding',null,ownerA,{method:'GET'});
  assert.equal(first.status,200);assert.equal(first.data.status,'NOT_STARTED');
  const row=app.store.db.prepare('SELECT * FROM workspace_onboarding WHERE tenant_id=?').get(tenantA);
  assert.equal(row,undefined,'a mere GET must never create a persisted onboarding row');
 }finally{await cleanup();}
});

test('Derived status, never a stored checkbox: the AI step reflects the REAL connection, not a client-asserted flag',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const before=await call('/api/onboarding',null,ownerA,{method:'GET'});
  assert.equal(before.data.steps.find(s=>s.id==='ai').state,'NOT_STARTED');

  const ai=createConnection(app.store.db,{integrationDefinitionId:'anthropic',name:'Anthropic Main'},tenantA);
  updateConnection(app.store.db,ai.id,{status:'CONNECTED'},tenantA);
  const after=await call('/api/onboarding',null,ownerA,{method:'GET'});
  assert.equal(after.data.steps.find(s=>s.id==='ai').state,'READY');
 }finally{await cleanup();}
});

test('Required AI blocker: completion is rejected server-side while AI is not configured, even if the client asserts complete:true',async()=>{
 const {call,cleanup,ownerA}=await twoTenants();
 try{
  const attempt=await call('/api/onboarding',{complete:true},ownerA,{method:'PATCH'});
  assert.equal(attempt.status,409);
  const state=await call('/api/onboarding',null,ownerA,{method:'GET'});
  assert.equal(state.data.status,'IN_PROGRESS');assert.equal(state.data.completedAt,null);
 }finally{await cleanup();}
});

test('Optional skip: commerce/messaging/productivity can be explicitly skipped and never block completion once AI is ready',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const ai=createConnection(app.store.db,{integrationDefinitionId:'anthropic',name:'Anthropic Main'},tenantA);
  updateConnection(app.store.db,ai.id,{status:'CONNECTED'},tenantA);
  for(const step of ['commerce','messaging','productivity']){
   const skip=await call('/api/onboarding',{skipStep:step},ownerA,{method:'PATCH'});
   assert.equal(skip.status,200);
   assert.equal(skip.data.steps.find(s=>s.id===step).state,'SKIPPED');
  }
  const complete=await call('/api/onboarding',{complete:true},ownerA,{method:'PATCH'});
  assert.equal(complete.status,200);
  assert.equal(complete.data.status,'COMPLETED');
  assert.ok(complete.data.completedAt);
 }finally{await cleanup();}
});

test('A skipped optional step becomes READY again automatically once a real connection appears — never stuck on SKIPPED',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  await call('/api/onboarding',{skipStep:'commerce'},ownerA,{method:'PATCH'});
  const salla=createConnection(app.store.db,{integrationDefinitionId:'salla',name:'Main Store'},tenantA);
  updateConnection(app.store.db,salla.id,{status:'CONNECTED'},tenantA);
  const state=await call('/api/onboarding',null,ownerA,{method:'GET'});
  assert.equal(state.data.steps.find(s=>s.id==='commerce').state,'READY');
 }finally{await cleanup();}
});

test('Reopen after completion never resets connections/config, and completedAt clears',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const ai=createConnection(app.store.db,{integrationDefinitionId:'anthropic',name:'Anthropic Main'},tenantA);
  updateConnection(app.store.db,ai.id,{status:'CONNECTED'},tenantA);
  await call('/api/onboarding',{complete:true},ownerA,{method:'PATCH'});
  const reopened=await call('/api/onboarding',{reopen:true},ownerA,{method:'PATCH'});
  assert.equal(reopened.data.status,'IN_PROGRESS');assert.equal(reopened.data.completedAt,null);
  // the real AI connection is completely untouched
  const stillConnected=app.store.db.prepare('SELECT status FROM integration_connections WHERE id=?').get(ai.id).status;
  assert.equal(stillConnected,'CONNECTED');
  assert.equal(reopened.data.steps.find(s=>s.id==='ai').state,'READY');
 }finally{await cleanup();}
});

test('Cross-tenant isolation: Tenant B never sees or affects Tenant A\'s onboarding state',async()=>{
 const {app,call,cleanup,ownerA,ownerB,tenantA,tenantB}=await twoTenants();
 try{
  const ai=createConnection(app.store.db,{integrationDefinitionId:'anthropic',name:'A Anthropic'},tenantA);
  updateConnection(app.store.db,ai.id,{status:'CONNECTED'},tenantA);
  await call('/api/onboarding',{currentStep:'commerce'},ownerA,{method:'PATCH'});

  const stateB=await call('/api/onboarding',null,ownerB,{method:'GET'});
  assert.equal(stateB.data.status,'NOT_STARTED');
  assert.equal(stateB.data.steps.find(s=>s.id==='ai').state,'NOT_STARTED');
  assert.equal(stateB.data.currentStep,'company');

  // B completing its own onboarding (with its own real AI connection) never marks A as anything.
  const aiB=createConnection(app.store.db,{integrationDefinitionId:'openai',name:'B OpenAI'},tenantB);
  updateConnection(app.store.db,aiB.id,{status:'CONNECTED'},tenantB);
  await call('/api/onboarding',{complete:true},ownerB,{method:'PATCH'});

  const finalA=await call('/api/onboarding',null,ownerA,{method:'GET'});
  assert.equal(finalA.data.status,'IN_PROGRESS');
  assert.equal(finalA.data.currentStep,'commerce');
 }finally{await cleanup();}
});

test('RBAC: a reviewer is denied entirely; an operator can view but cannot mutate',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const auth=createAuth(app.store.db);
  const reviewerUser=auth.createUser({username:'reviewer1',name:'Reviewer',password:'a-long-test-password'},'reviewer');
  const operatorUser=auth.createUser({username:'operator1',name:'Operator',password:'a-long-test-password'},'operator');
  const now=new Date().toISOString();
  app.store.db.prepare('INSERT INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)').run(crypto.randomUUID(),tenantA,reviewerUser.id,'reviewer','active',0,now);
  app.store.db.prepare('INSERT INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)').run(crypto.randomUUID(),tenantA,operatorUser.id,'operator','active',0,now);
  const reviewerLogin=auth.login({username:'reviewer1',password:'a-long-test-password'},'127.0.0.1');
  const reviewer={cookie:'hc_session='+reviewerLogin.token,csrf:reviewerLogin.csrf};
  const operatorLogin=auth.login({username:'operator1',password:'a-long-test-password'},'127.0.0.1');
  const operator={cookie:'hc_session='+operatorLogin.token,csrf:operatorLogin.csrf};

  assert.equal((await call('/api/onboarding',null,reviewer,{method:'GET'})).status,403);
  assert.equal((await call('/api/onboarding',null,operator,{method:'GET'})).status,200);
  assert.equal((await call('/api/onboarding',{currentStep:'ai'},operator,{method:'PATCH'})).status,403);
 }finally{await cleanup();}
});

test('Unknown step id is rejected; unskippable step ("ai") cannot be skipped',async()=>{
 const {call,cleanup,ownerA}=await twoTenants();
 try{
  assert.equal((await call('/api/onboarding',{currentStep:'not-a-real-step'},ownerA,{method:'PATCH'})).status,400);
  assert.equal((await call('/api/onboarding',{skipStep:'ai'},ownerA,{method:'PATCH'})).status,400);
 }finally{await cleanup();}
});

test('Recommended preset: assigns the chosen healthy AI connection to agents with no existing override, and never touches an agent that already has one',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  const ai=createConnection(app.store.db,{integrationDefinitionId:'anthropic',name:'Anthropic Main'},tenantA);
  updateConnection(app.store.db,ai.id,{status:'CONNECTED'},tenantA);
  const otherAi=createConnection(app.store.db,{integrationDefinitionId:'openai',name:'Manual Override'},tenantA);
  updateConnection(app.store.db,otherAi.id,{status:'CONNECTED'},tenantA);
  updateTenantAgentConfig(app.store.db,tenantA,'sales',{aiConnectionId:otherAi.id}); // an explicit prior choice

  const result=await call('/api/onboarding/preset',{aiConnectionId:ai.id},ownerA);
  assert.equal(result.status,200);
  assert.ok(!result.data.applied.includes('sales'),'must never override an agent\'s existing explicit AI connection');
  assert.ok(result.data.applied.includes('frost'));

  const salesConfig=getTenantAgentConfig(app.store.db,tenantA,'sales');
  assert.equal(salesConfig.aiConnectionId,otherAi.id); // untouched
  const frostConfig=getTenantAgentConfig(app.store.db,tenantA,'frost');
  assert.equal(frostConfig.aiConnectionId,ai.id);

  // Never touches autonomy level or tool assignments (Part 28).
  const frostAutonomy=app.store.db.prepare("SELECT level FROM agent_autonomy WHERE tenant_id=? AND agent_id='frost' ORDER BY version DESC LIMIT 1").get(tenantA);
  assert.ok(!frostAutonomy||frostAutonomy.level==='L0');
 }finally{await cleanup();}
});

test('Preset rejects a connection from another tenant (cannot be used to leak/spoof cross-tenant AI access)',async()=>{
 const {app,call,cleanup,ownerA,tenantB}=await twoTenants();
 try{
  const foreignAi=createConnection(app.store.db,{integrationDefinitionId:'anthropic',name:'B Anthropic'},tenantB);
  updateConnection(app.store.db,foreignAi.id,{status:'CONNECTED'},tenantB);
  const result=await call('/api/onboarding/preset',{aiConnectionId:foreignAi.id},ownerA);
  assert.equal(result.status,400);
 }finally{await cleanup();}
});

test('Safety snapshot is real and read-only: reflects actual current autonomy levels and env feature flags',async()=>{
 const {call,cleanup,ownerA}=await twoTenants({ENABLE_EXTERNAL_MESSAGING:'false'});
 try{
  const snapshot=await call('/api/onboarding/safety',null,ownerA,{method:'GET'});
  assert.equal(snapshot.status,200);
  assert.equal(snapshot.data.agentLevels.length,13);
  assert.ok(snapshot.data.agentLevels.every(a=>a.level==='L0'));
  assert.equal(snapshot.data.flags.externalMessaging,false);
  assert.equal(snapshot.data.flags.l2Autonomy,false); // DEFAULT_OFF unless explicitly enabled
 }finally{await cleanup();}
});

test('Suspended tenant: onboarding is naturally unreachable — the same centralized tenant resolution that blocks everything else blocks this too',async()=>{
 const {app,call,cleanup,ownerA,tenantA}=await twoTenants();
 try{
  app.store.db.prepare("UPDATE tenants SET status='SUSPENDED' WHERE id=?").run(tenantA);
  const result=await call('/api/onboarding',null,ownerA,{method:'GET'});
  assert.equal(result.status,403); // NO_WORKSPACE_ACCESS via the existing Phase 4C-1 resolution
 }finally{await cleanup();}
});
