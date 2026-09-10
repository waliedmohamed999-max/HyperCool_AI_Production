import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {openStore} from '../src/store.js';
import {createAuth} from '../src/auth.js';
import {installTenancy,ensureDefaultTenant,resolveTenantForUser,createTenant,getTenant,listTenantMembers} from '../src/tenancy.js';
import {installCredentials,saveCredentials,getCredentials,getCredentialsMeta,clearCredentials} from '../src/runtime/credentials.js';
import {installCRM,getLead,listLeads,createLead,findOrCreateLeadFromChannel,findLeadByPhone} from '../src/crm.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

const key32=randomBytes(32).toString('hex');
const connector={id:'connector:whatsapp',name:'موصل واتساب',role:'automation'};
function fixture(){
 const store=openStore(':memory:');
 installCRM(store.db);installCredentials(store.db);
 return store;
}

// --- Backfill / membership -----------------------------------------------------------

test('ensureDefaultTenant is a lossless, idempotent backfill: one tenant, every existing user attached with their real role',()=>{
 const store=fixture();try{
 const auth=createAuth(store.db);
 const owner=auth.createUser({username:'owner1',name:'Owner',password:'a-long-test-password'},'owner');
 const operator=auth.createUser({username:'op1',name:'Operator',password:'a-long-test-password'},'operator');
 const tenantId=ensureDefaultTenant(store.db);
 const again=ensureDefaultTenant(store.db);
 assert.equal(tenantId,again); // idempotent — never creates a second tenant
 const tenant=getTenant(store.db,tenantId);
 assert.equal(tenant.name,'HyperCool');assert.equal(tenant.status,'ACTIVE');
 const members=listTenantMembers(store.db,tenantId);
 assert.equal(members.length,2);
 assert.ok(members.find(m=>m.userId===owner.id&&m.role==='owner'&&m.isOwner===1));
 assert.ok(members.find(m=>m.userId===operator.id&&m.role==='operator'&&m.isOwner===0));
 }finally{store.close();}
});
test('resolveTenantForUser attaches a membership-less user to the default tenant on first resolution rather than leaving them tenant-less',()=>{
 const store=fixture();try{
 const auth=createAuth(store.db);
 const user=auth.createUser({username:'later',name:'Later User',password:'a-long-test-password'},'operator');
 // No ensureDefaultTenant call yet — resolveTenantForUser must create it itself.
 const tenantId=resolveTenantForUser(store.db,user.id);
 assert.ok(tenantId);
 assert.equal(listTenantMembers(store.db,tenantId).find(m=>m.userId===user.id)?.role,'operator');
 }finally{store.close();}
});
test('createTenant makes a brand-new, fully empty tenant — no shared data with any existing tenant',()=>{
 const store=fixture();try{
 const tenantA=ensureDefaultTenant(store.db);
 const auth=createAuth(store.db);
 const ownerB=auth.createUser({username:'ownerb',name:'Owner B',password:'a-long-test-password'},'owner');
 const tenantB=createTenant(store.db,{name:'Second Co',slug:'second-co'},ownerB.id);
 assert.notEqual(tenantA,tenantB);
 assert.equal(getTenant(store.db,tenantB).status,'TRIAL');
 assert.equal(listTenantMembers(store.db,tenantB).length,1);
 assert.equal(listLeads(store.db,tenantB).length,0);
 }finally{store.close();}
});

// --- Credentials IDOR ------------------------------------------------------------------

test('IDOR: Tenant A cannot read, list-into, or clear Tenant B\'s integration credential',()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 const tenantA=ensureDefaultTenant(store.db);
 const tenantB=createTenant(store.db,{name:'Second Co',slug:'second-co'});
 // Different provider names to respect the real schema (PRIMARY KEY(tenant_id,provider)) —
 // this proves tenant-scoped filtering, which is the real, testable protection this pass
 // ships; two tenants connecting the SAME provider is Phase 8/9 (composite connections),
 // deliberately out of scope — see docs/MULTI_TENANT_ARCHITECTURE.md.
 saveCredentials(store.db,env,'salla',{accessToken:'tenant-a-secret',expiresAt:null},{id:'u1',name:'Owner A'},tenantA);
 saveCredentials(store.db,env,'meta',{accessToken:'tenant-b-secret',expiresAt:null},{id:'u2',name:'Owner B'},tenantB);

 assert.equal(getCredentials(store.db,env,'meta',tenantA),null); // A can never read B's row
 assert.equal(getCredentialsMeta(store.db,'meta',tenantA),null);
 assert.equal(getCredentials(store.db,env,'salla',tenantB),null); // and vice versa
 assert.equal(getCredentials(store.db,env,'salla',tenantA).accessToken,'tenant-a-secret'); // but each reads its own fine

 clearCredentials(store.db,'meta',tenantA); // deleting under the WRONG tenant must be a no-op
 assert.equal(getCredentials(store.db,env,'meta',tenantB).accessToken,'tenant-b-secret'); // B's row survives A's delete attempt
 }finally{store.close();}
});
test('Two tenants CAN each independently connect the same static-env-var integration — resolveActiveTenantId default never leaks across an explicit tenantId call',()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 const tenantA=ensureDefaultTenant(store.db); // this is also "the default" resolveActiveTenantId returns
 const tenantB=createTenant(store.db,{name:'Second Co',slug:'second-co'});
 saveCredentials(store.db,env,'salla',{accessToken:'default-tenant-token',expiresAt:null},{id:'u1',name:'Owner A'}); // no tenantId passed — uses the default
 saveCredentials(store.db,env,'salla',{accessToken:'explicit-tenant-b-token',expiresAt:null},{id:'u2',name:'Owner B'},tenantB);
 assert.equal(getCredentials(store.db,env,'salla').accessToken,'default-tenant-token'); // implicit call still resolves A
 assert.equal(getCredentials(store.db,env,'salla',tenantB).accessToken,'explicit-tenant-b-token');
 assert.equal(getCredentials(store.db,env,'salla',tenantA).accessToken,'default-tenant-token');
 }finally{store.close();}
});

// --- CRM IDOR ----------------------------------------------------------------------------

test('IDOR: Tenant A cannot fetch, list, or search into Tenant B\'s lead by guessing its real id',()=>{
 const store=fixture();try{
 const tenantA=ensureDefaultTenant(store.db);
 const tenantB=createTenant(store.db,{name:'Second Co',slug:'second-co'});
 const leadA=createLead(store,{name:'Riyadh Club',customerType:'B2B',sourceType:'INBOUND',company:'Riyadh Club'},{id:'u1',name:'Owner A'},tenantA);
 const leadB=createLead(store,{name:'Jeddah Club',customerType:'B2B',sourceType:'INBOUND',company:'Jeddah Club'},{id:'u2',name:'Owner B'},tenantB);

 assert.throws(()=>getLead(store.db,leadB.id,tenantA),/غير موجود/); // A guessing B's real UUID still 404s
 assert.throws(()=>getLead(store.db,leadA.id,tenantB),/غير موجود/);
 assert.equal(getLead(store.db,leadA.id,tenantA).id,leadA.id); // each still reads its own fine

 const leadsA=listLeads(store.db,tenantA),leadsB=listLeads(store.db,tenantB);
 assert.equal(leadsA.length,1);assert.equal(leadsB.length,1);
 assert.equal(leadsA[0].id,leadA.id);assert.equal(leadsB[0].id,leadB.id);
 }finally{store.close();}
});
test('The SAME phone number is two independent leads in two different tenants — composite (tenant_id, contact_key) uniqueness, not global',()=>{
 const store=fixture();try{
 const tenantA=ensureDefaultTenant(store.db);
 const tenantB=createTenant(store.db,{name:'Second Co',slug:'second-co'});
 const {lead:leadA,created:createdA}=findOrCreateLeadFromChannel(store,{phone:'+966500000001',name:'Club',channel:'WhatsApp'},connector,tenantA);
 const {lead:leadB,created:createdB}=findOrCreateLeadFromChannel(store,{phone:'+966500000001',name:'Club',channel:'WhatsApp'},connector,tenantB);
 assert.equal(createdA,true);assert.equal(createdB,true);
 assert.notEqual(leadA.id,leadB.id); // two real, separate lead records — no collision, no merge
 assert.equal(findLeadByPhone(store.db,'+966500000001',tenantA).id,leadA.id);
 assert.equal(findLeadByPhone(store.db,'+966500000001',tenantB).id,leadB.id);
 // Re-delivering the same channel event under tenant A must still resolve to A's lead, never B's.
 const {lead:again,created:createdAgain}=findOrCreateLeadFromChannel(store,{phone:'+966500000001',name:'Club',channel:'WhatsApp'},connector,tenantA);
 assert.equal(createdAgain,false);assert.equal(again.id,leadA.id);
 }finally{store.close();}
});

// --- HTTP-level IDOR: two real logged-in sessions, two real tenants ---------------------

async function harness(env){
 const directory=await mkdtemp(join(tmpdir(),'hypercool-tenancy-'));
 const app=await createApp({dataDir:directory,env});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}){
  const hasBody=input!==undefined && input!==null && method!=='GET';
  const res=await fetch(base+path,{method:method||(input!=null?'POST':'GET'),redirect:'manual',headers:{...(hasBody?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(hasBody?{body:typeof input==='string'?input:JSON.stringify(input)}:{})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 return {app,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}
test('HTTP E2E: a second real tenant, created directly (no onboarding UI exists yet), sees none of the first tenant\'s CRM data through the real API',async()=>{
 const {app,call,cleanup}=await harness({});
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  const leadA=await call('/api/crm/leads',{name:'Riyadh Club',customerType:'B2B',sourceType:'INBOUND',company:'Riyadh Club'},owner);
  assert.equal(leadA.status,201);

  // Create a second real user + a second real, independent tenant, and move that user into it.
  const auth=createAuth(app.store.db);
  const userB=auth.createUser({username:'operatorb',name:'Operator B',password:'a-long-test-password'},'operator');
  const tenantB=createTenant(app.store.db,{name:'Second Co',slug:'second-co'},userB.id);
  app.store.db.prepare('DELETE FROM tenant_memberships WHERE user_id=? AND tenant_id!=?').run(userB.id,tenantB); // was auto-attached to the default tenant at boot too — leave only the real membership
  const sessionB=auth.login({username:'operatorb',password:'a-long-test-password'},'127.0.0.1');

  const bSession={cookie:'hc_session='+sessionB.token,csrf:sessionB.csrf};
  const crmAsB=await call('/api/crm',null,bSession,{method:'GET'});
  assert.equal(crmAsB.status,200);
  assert.equal(crmAsB.data.leads.length,0); // Tenant B's CRM is genuinely empty — Tenant A's lead is invisible
  assert.equal((await call(`/api/crm/leads/${leadA.data.id}`,null,bSession,{method:'GET'})).status,404); // direct IDOR by real id
 }finally{await cleanup();}
});
