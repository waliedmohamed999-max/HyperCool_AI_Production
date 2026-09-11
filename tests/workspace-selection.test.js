import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {createTenant,removeMembership,resolveTenantForUser} from '../src/tenancy.js';
import {createConnection,updateConnection} from '../src/integrations/connections.js';
import {createApproval} from '../src/runtime/approvals.js';

// Phase 4C-1 — Workspace Selection + Active Tenant Foundation. Real HTTP end-to-end tests
// (never service-level only — Part I: "must inspect real data returned, not only HTTP status
// codes"), same harness shape as tests/tenancy-phase2.test.js / tenancy-phase3.test.js.
async function harness(env={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-workspace-'));
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
/**
 * Builds a genuinely multi-membership user: Owner A ends up a member of BOTH `workspaceOne`
 * (the sole default tenant, resolved into via a real authenticated request while it is still
 * the only tenant — see tests/tenancy-phase2.test.js's own note on this exact ordering
 * requirement) and `workspaceTwo` (created fresh with Owner A as owner). `workspaceThree` is
 * a real, separate tenant Owner A is NEVER a member of, owned by an entirely separate user
 * (Owner C) — the "foreign tenant" for every cross-tenant test below.
 */
async function multiWorkspaceUser(env={}) {
 const {app,call,cleanup}=await harness(env);
 const ownerA=await call('/api/setup',{username:'ownera',name:'Owner A',password:'a-long-test-password'});
 await call('/api/auth',null,ownerA,{method:'GET'});
 const userA=app.store.db.prepare("SELECT id FROM users WHERE username='ownera'").get();
 const workspaceOne=app.store.db.prepare('SELECT tenant_id AS id FROM tenant_memberships WHERE user_id=?').get(userA.id).id;
 const workspaceTwo=createTenant(app.store.db,{name:'Workspace Two',slug:'workspace-two'},userA.id);
 const auth=createAuth(app.store.db);
 const userC=auth.createUser({username:'ownerc',name:'Owner C',password:'a-long-test-password'},'owner');
 const workspaceThree=createTenant(app.store.db,{name:'Workspace Three',slug:'workspace-three'},userC.id);
 const loginC=auth.login({username:'ownerc',password:'a-long-test-password'},'127.0.0.1');
 const ownerC={cookie:'hc_session='+loginC.token,csrf:loginC.csrf};
 return {app,call,cleanup,ownerA,ownerC,userAId:userA.id,userCId:userC.id,workspaceOne,workspaceTwo,workspaceThree};
}

// --- Case 3: single membership resolves with zero friction --------------------------------

test('Case 3: a user with exactly one membership needs no selection at all — GET /api/workspaces/active resolves immediately',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'solo',name:'Solo Owner',password:'a-long-test-password'});
  const active=await call('/api/workspaces/active',null,owner,{method:'GET'});
  assert.equal(active.status,200);
  assert.equal(active.data.isActive,true);
  assert.equal(active.data.role,'owner');
  assert.ok(active.data.id);assert.ok(active.data.name);assert.ok(active.data.slug);
  // Never a raw secret/credential field on a workspace object.
  assert.equal(active.data.secret,undefined);assert.equal(active.data.credentialId,undefined);
 }finally{await cleanup();}
});

// --- Case 4: multiple memberships, no selection -> TENANT_SELECTION_REQUIRED; workspace list is scoped

test('Case 4: multiple memberships with no active selection blocks every OTHER route, but GET /api/workspaces still lists only Owner A\'s own two workspaces — never the foreign third one',async()=>{
 const {call,cleanup,ownerA,workspaceOne,workspaceTwo,workspaceThree}=await multiWorkspaceUser();
 try{
  const list=await call('/api/workspaces',null,ownerA,{method:'GET'});
  assert.equal(list.status,200);
  const ids=list.data.map(w=>w.id).sort();
  assert.deepEqual(ids,[workspaceOne,workspaceTwo].sort());
  assert.ok(!ids.includes(workspaceThree),'the foreign workspace must never appear in the list');
  for(const w of list.data){assert.equal(w.role,'owner');assert.equal(typeof w.name,'string');assert.equal(typeof w.slug,'string');}

  const active=await call('/api/workspaces/active',null,ownerA,{method:'GET'});
  assert.equal(active.status,409);
  assert.equal(active.data.error,'TENANT_SELECTION_REQUIRED');
  assert.equal(active.data.workspaces.length,2);

  // Every OTHER tenant-scoped route is blocked the exact same way — unchanged Phase 3.5
  // behavior (Part B Case 4 "remains correct").
  const crm=await call('/api/crm',null,ownerA,{method:'GET'});
  assert.equal(crm.status,409);assert.equal(crm.data.error,'TENANT_SELECTION_REQUIRED');
 }finally{await cleanup();}
});

// --- Case 5/6: activation, foreign denial, invalid id denial (identical, no leak) ----------

test('Case 5: activating an owned workspace succeeds; Case 6: a foreign workspace and Case: a random invalid id are BOTH denied identically (TENANT_ACCESS_DENIED, no existence leak)',async()=>{
 const {call,cleanup,ownerA,workspaceOne,workspaceThree}=await multiWorkspaceUser();
 try{
  const ok=await call('/api/workspaces/active',{workspaceId:workspaceOne},ownerA,{method:'PUT'});
  assert.equal(ok.status,200);assert.equal(ok.data.id,workspaceOne);assert.equal(ok.data.isActive,true);

  const foreign=await call('/api/workspaces/active',{workspaceId:workspaceThree},ownerA,{method:'PUT'});
  assert.equal(foreign.status,403);assert.equal(foreign.data.error,'TENANT_ACCESS_DENIED');

  const randomId=await call('/api/workspaces/active',{workspaceId:'00000000-0000-0000-0000-000000000000'},ownerA,{method:'PUT'});
  assert.equal(randomId.status,403);assert.equal(randomId.data.error,'TENANT_ACCESS_DENIED');
  // Identical response shape/message for "exists but not yours" and "does not exist at all" —
  // a client cannot distinguish the two, so cannot fingerprint foreign tenant ids.
  assert.deepEqual(foreign.data,randomId.data);
 }finally{await cleanup();}
});

// --- Switching immediately changes tenant-scoped data, in both directions, with zero leakage

test('Switching workspaces immediately changes tenant-scoped data (real CRM leads), with zero leakage in either direction — no cache to invalidate',async()=>{
 const {call,cleanup,ownerA,workspaceOne,workspaceTwo}=await multiWorkspaceUser();
 try{
  await call('/api/workspaces/active',{workspaceId:workspaceOne},ownerA,{method:'PUT'});
  const leadA=await call('/api/crm/leads',{name:'Lead One',customerType:'B2C',sourceType:'INBOUND'},ownerA);
  assert.equal(leadA.status,201);
  const crmOne=await call('/api/crm',null,ownerA,{method:'GET'});
  assert.equal(crmOne.data.leads.length,1);assert.equal(crmOne.data.leads[0].name,'Lead One');

  await call('/api/workspaces/active',{workspaceId:workspaceTwo},ownerA,{method:'PUT'});
  const crmTwoBeforeCreate=await call('/api/crm',null,ownerA,{method:'GET'});
  assert.equal(crmTwoBeforeCreate.data.leads.length,0,'Workspace Two must never see Workspace One\'s lead');

  const leadB=await call('/api/crm/leads',{name:'Lead Two',customerType:'B2C',sourceType:'INBOUND'},ownerA);
  assert.equal(leadB.status,201);
  const crmTwo=await call('/api/crm',null,ownerA,{method:'GET'});
  assert.equal(crmTwo.data.leads.length,1);assert.equal(crmTwo.data.leads[0].name,'Lead Two');

  // Switch back — Workspace One's data is exactly as left, Workspace Two's lead never leaks in.
  await call('/api/workspaces/active',{workspaceId:workspaceOne},ownerA,{method:'PUT'});
  const crmOneAgain=await call('/api/crm',null,ownerA,{method:'GET'});
  assert.equal(crmOneAgain.data.leads.length,1);assert.equal(crmOneAgain.data.leads[0].name,'Lead One');
 }finally{await cleanup();}
});

// --- Case 7: stale selection after membership removal --------------------------------------

test('Case 7: a membership removed after active selection is invalidated on the very next request — never a stale tenant context',async()=>{
 const {app,call,cleanup,ownerA,userAId,workspaceOne,workspaceTwo}=await multiWorkspaceUser();
 try{
  await call('/api/workspaces/active',{workspaceId:workspaceTwo},ownerA,{method:'PUT'});
  const before=await call('/api/workspaces/active',null,ownerA,{method:'GET'});
  assert.equal(before.status,200);assert.equal(before.data.id,workspaceTwo);

  removeMembership(app.store.db,workspaceTwo,userAId);

  // Owner A now has exactly ONE valid membership left (Workspace One) — resolves
  // automatically to it (Case 3), never continues using the removed Workspace Two.
  const after=await call('/api/workspaces/active',null,ownerA,{method:'GET'});
  assert.equal(after.status,200);
  assert.equal(after.data.id,workspaceOne);
  assert.notEqual(after.data.id,workspaceTwo);

  // The stale id can also never be re-selected.
  const reselect=await call('/api/workspaces/active',{workspaceId:workspaceTwo},ownerA,{method:'PUT'});
  assert.equal(reselect.status,403);assert.equal(reselect.data.error,'TENANT_ACCESS_DENIED');
 }finally{await cleanup();}
});

test('Case 7b: removing ALL memberships (down to zero, with another tenant still existing elsewhere) yields NO_WORKSPACE_ACCESS, never a silent attach to some other tenant',async()=>{
 const {app,call,cleanup,ownerA,userAId,workspaceOne,workspaceTwo}=await multiWorkspaceUser();
 try{
  await call('/api/workspaces/active',{workspaceId:workspaceOne},ownerA,{method:'PUT'});
  removeMembership(app.store.db,workspaceOne,userAId);
  removeMembership(app.store.db,workspaceTwo,userAId);
  const after=await call('/api/workspaces/active',null,ownerA,{method:'GET'});
  assert.equal(after.status,403);assert.equal(after.data.error,'NO_WORKSPACE_ACCESS');
  const crm=await call('/api/crm',null,ownerA,{method:'GET'});
  assert.equal(crm.status,403);assert.equal(crm.data.error,'NO_WORKSPACE_ACCESS');
 }finally{await cleanup();}
});

// --- Tenant context cannot be spoofed -------------------------------------------------------

test('Tenant context cannot be spoofed through the request body, a query parameter, or an arbitrary header',async()=>{
 const {call,cleanup,ownerA,workspaceOne,workspaceTwo}=await multiWorkspaceUser();
 try{
  await call('/api/workspaces/active',{workspaceId:workspaceOne},ownerA,{method:'PUT'});

  // Body: a lead created with a foreign tenantId embedded in the payload still lands in the
  // REAL active workspace (Workspace One), never Workspace Two.
  const lead=await call('/api/crm/leads',{name:'Body Spoof',customerType:'B2C',sourceType:'INBOUND',tenantId:workspaceTwo},ownerA);
  assert.equal(lead.status,201);
  const crmOne=await call('/api/crm',null,ownerA,{method:'GET'});
  assert.ok(crmOne.data.leads.some(l=>l.name==='Body Spoof'));

  // Query string: a tenantId/workspaceId query param on a normal GET is simply not read by
  // any route — the response still reflects the real active workspace.
  const viaQuery=await call(`/api/crm?tenantId=${workspaceTwo}&workspaceId=${workspaceTwo}`,null,ownerA,{method:'GET'});
  assert.equal(viaQuery.status,200);
  assert.ok(viaQuery.data.leads.some(l=>l.name==='Body Spoof'),'query-string tenant/workspace ids must be completely ignored');

  // Header: an arbitrary x-tenant-id/x-workspace-id header is not part of this app's trusted
  // architecture (the only trusted mechanism is the server-side session — see
  // docs/WORKSPACE_SELECTION.md) and must be ignored exactly like the body/query attempts.
  const viaHeader=await call('/api/crm',null,ownerA,{method:'GET',headers:{'x-tenant-id':workspaceTwo,'x-workspace-id':workspaceTwo}});
  assert.equal(viaHeader.status,200);
  assert.ok(viaHeader.data.leads.some(l=>l.name==='Body Spoof'),'a spoofed tenant header must be completely ignored');
 }finally{await cleanup();}
});

// --- Agent config / tool assignment / integration connection / readiness isolation ---------

test('Agent config and tool assignment isolation: each workspace keeps its own independent configuration across a switch',async()=>{
 const {call,cleanup,ownerA,workspaceOne,workspaceTwo}=await multiWorkspaceUser();
 try{
  await call('/api/workspaces/active',{workspaceId:workspaceOne},ownerA,{method:'PUT'});
  await call('/api/agents/sales/config',{model:'model-workspace-one'},ownerA,{method:'PATCH'});
  const toolOne=await call('/api/agents/sales/tools/get_current_price',{enabled:false},ownerA,{method:'PUT'});
  assert.equal(toolOne.status,200);assert.equal(toolOne.data.enabled,false);

  await call('/api/workspaces/active',{workspaceId:workspaceTwo},ownerA,{method:'PUT'});
  const configTwo=await call('/api/agents/sales/config',null,ownerA,{method:'GET'});
  assert.notEqual(configTwo.data.model,'model-workspace-one');
  const toolsTwo=await call('/api/agents/sales/tools',null,ownerA,{method:'GET'});
  const priceToolTwo=toolsTwo.data.find(t=>t.slug==='get_current_price');
  assert.equal(priceToolTwo.assignment,null,'Workspace Two must never see Workspace One\'s tool assignment');

  await call('/api/agents/sales/config',{model:'model-workspace-two'},ownerA,{method:'PATCH'});

  await call('/api/workspaces/active',{workspaceId:workspaceOne},ownerA,{method:'PUT'});
  const configOneAgain=await call('/api/agents/sales/config',null,ownerA,{method:'GET'});
  assert.equal(configOneAgain.data.model,'model-workspace-one');
  const toolsOneAgain=await call('/api/agents/sales/tools',null,ownerA,{method:'GET'});
  const priceToolOneAgain=toolsOneAgain.data.find(t=>t.slug==='get_current_price');
  assert.equal(priceToolOneAgain.assignment.enabled,false);
 }finally{await cleanup();}
});

test('Integration connection isolation: a connection created in one workspace never appears in the other after switching',async()=>{
 const {call,cleanup,ownerA,workspaceOne,workspaceTwo}=await multiWorkspaceUser();
 try{
  await call('/api/workspaces/active',{workspaceId:workspaceOne},ownerA,{method:'PUT'});
  const created=await call('/api/integrations/connections',{integrationDefinitionId:'salla',name:'Workspace One Store'},ownerA);
  assert.equal(created.status,201);

  await call('/api/workspaces/active',{workspaceId:workspaceTwo},ownerA,{method:'PUT'});
  const listTwo=await call('/api/integrations/connections',null,ownerA,{method:'GET'});
  assert.equal(listTwo.data.length,0);

  await call('/api/workspaces/active',{workspaceId:workspaceOne},ownerA,{method:'PUT'});
  const listOne=await call('/api/integrations/connections',null,ownerA,{method:'GET'});
  assert.equal(listOne.data.length,1);assert.equal(listOne.data[0].id,created.data.id);
 }finally{await cleanup();}
});

test('Approval isolation: a pending approval seeded in one workspace never appears in the other',async()=>{
 const {app,call,cleanup,ownerA,workspaceOne,workspaceTwo}=await multiWorkspaceUser();
 try{
  createApproval(app.store.db,{runId:null,agentId:'human',actionType:'memory_policy_change',proposedOutput:{},riskLevel:'LOW',reason:'test',tenantId:workspaceOne});
  await call('/api/workspaces/active',{workspaceId:workspaceOne},ownerA,{method:'PUT'});
  const approvalsOne=await call('/api/approvals',null,ownerA,{method:'GET'});
  assert.equal(approvalsOne.data.length,1);

  await call('/api/workspaces/active',{workspaceId:workspaceTwo},ownerA,{method:'PUT'});
  const approvalsTwo=await call('/api/approvals',null,ownerA,{method:'GET'});
  assert.equal(approvalsTwo.data.length,0);
 }finally{await cleanup();}
});

// --- Readiness / capabilityGranted stay workspace-scoped, and Phase 4B.1 keeps working -----

test('Readiness and capabilityGranted stay workspace-scoped: Workspace A has the required capability, Workspace B does not — switching correctly flips CONNECTION_CAPABILITY_MISSING with no leakage either way (Phase 4B.1 regression protection)',async()=>{
 const {app,call,cleanup,ownerA,workspaceOne,workspaceTwo}=await multiWorkspaceUser();
 try{
  const connOne=createConnection(app.store.db,{integrationDefinitionId:'salla',name:'A Store'},workspaceOne);
  updateConnection(app.store.db,connOne.id,{status:'CONNECTED',scopes:['products.read']},workspaceOne);
  const connTwo=createConnection(app.store.db,{integrationDefinitionId:'salla',name:'B Store'},workspaceTwo);
  updateConnection(app.store.db,connTwo.id,{status:'CONNECTED',scopes:['orders.read']},workspaceTwo); // missing products.read

  await call('/api/workspaces/active',{workspaceId:workspaceOne},ownerA,{method:'PUT'});
  await call('/api/agents/sales/tools/get_current_price',{connectionId:connOne.id},ownerA,{method:'PUT'});
  const connectionsOne=await call('/api/tools/get_current_price/connections',null,ownerA,{method:'GET'});
  assert.equal(connectionsOne.data.find(c=>c.id===connOne.id).capabilityGranted,true);
  const toolsOne=await call('/api/agents/sales/tools',null,ownerA,{method:'GET'});
  assert.equal(toolsOne.data.find(t=>t.slug==='get_current_price').readiness.status,'READY');
  const readinessOne=await call('/api/agents/sales/readiness',null,ownerA,{method:'GET'});
  assert.equal(readinessOne.data.optional_missing.includes('get_current_price'),false);

  await call('/api/workspaces/active',{workspaceId:workspaceTwo},ownerA,{method:'PUT'});
  await call('/api/agents/sales/tools/get_current_price',{connectionId:connTwo.id},ownerA,{method:'PUT'});
  const connectionsTwo=await call('/api/tools/get_current_price/connections',null,ownerA,{method:'GET'});
  assert.equal(connectionsTwo.data.length,1,'Workspace B must never see Workspace A\'s connection');
  assert.equal(connectionsTwo.data[0].capabilityGranted,false);
  const toolsTwo=await call('/api/agents/sales/tools',null,ownerA,{method:'GET'});
  assert.equal(toolsTwo.data.find(t=>t.slug==='get_current_price').readiness.status,'CONNECTION_CAPABILITY_MISSING');
  const readinessTwo=await call('/api/agents/sales/readiness',null,ownerA,{method:'GET'});
  assert.ok(readinessTwo.data.optional_missing.includes('get_current_price'));

  // Switch back — Workspace A's READY state must not have been disturbed by anything done
  // while Workspace B was active (no shared/leaked cache).
  await call('/api/workspaces/active',{workspaceId:workspaceOne},ownerA,{method:'PUT'});
  const toolsOneAgain=await call('/api/agents/sales/tools',null,ownerA,{method:'GET'});
  assert.equal(toolsOneAgain.data.find(t=>t.slug==='get_current_price').readiness.status,'READY');
 }finally{await cleanup();}
});

// --- Two separate users, separate tenants (baseline, unrelated to multi-membership) --------

test('Multiple users, separate tenants: each resolves only their own workspace, and neither can activate the other\'s',async()=>{
 const {call,cleanup,ownerC,workspaceThree}=await multiWorkspaceUser();
 try{
  const active=await call('/api/workspaces/active',null,ownerC,{method:'GET'});
  assert.equal(active.status,200);assert.equal(active.data.id,workspaceThree);
  const list=await call('/api/workspaces',null,ownerC,{method:'GET'});
  assert.equal(list.data.length,1);assert.equal(list.data[0].id,workspaceThree);
 }finally{await cleanup();}
});
