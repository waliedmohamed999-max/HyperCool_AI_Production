import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {createTenant} from '../src/tenancy.js';

async function harness(env={}){
 const directory=await mkdtemp(join(tmpdir(),'hypercool-tenancy2-'));
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
// Sets up two fully independent real tenants (Tenant A = the default one from app boot,
// Tenant B = created fresh) each with their own logged-in owner session, over real HTTP —
// exactly the shape spec Phase 8 requires ("استخدم HTTP E2E وليس service tests فقط").
async function twoTenants(env={}) {
 const {app,call,cleanup}=await harness(env);
 const ownerA=await call('/api/setup',{username:'ownera',name:'Owner A',password:'a-long-test-password'});
 // Phase 4C-1: resolve Owner A's own tenant membership (lazily attached to the sole
 // pre-existing default tenant) WHILE it is still the only tenant in the system — exactly
 // what a real signup flow does on the very next authenticated request. Creating Tenant B
 // first would otherwise leave Owner A with zero memberships once >1 tenant exists, which
 // now correctly throws NO_WORKSPACE_ACCESS instead of silently guessing — see
 // docs/WORKSPACE_SELECTION.md.
 await call('/api/auth',null,ownerA,{method:'GET'});
 const auth=createAuth(app.store.db);
 const userB=auth.createUser({username:'ownerb',name:'Owner B',password:'a-long-test-password'},'owner');
 const tenantB=createTenant(app.store.db,{name:'Second Co',slug:'second-co'},userB.id);
 app.store.db.prepare('DELETE FROM tenant_memberships WHERE user_id=? AND tenant_id!=?').run(userB.id,tenantB);
 const loginB=auth.login({username:'ownerb',password:'a-long-test-password'},'127.0.0.1');
 const ownerB={cookie:'hc_session='+loginB.token,csrf:loginB.csrf};
 return {app,call,cleanup,ownerA,ownerB,tenantB};
}

test('IDOR: Tenant B cannot read Tenant A\'s brand memory, agent runs, approvals, escalations, or weekly reports',async()=>{
 const {call,cleanup,ownerA,ownerB}=await twoTenants();
 try{
  // Tenant A creates a real brand memory entry.
  const memA=await call('/api/memory',{kind:'brand_voice',key:'voice',value:'واثقة ومباشرة',source:'دليل العلامة',changeReason:'إعداد أولي',status:'APPROVED',expectedVersion:0},ownerA);
  assert.equal(memA.status,201);
  const memListA=await call('/api/memory',null,ownerA,{method:'GET'});
  assert.equal(memListA.data.length,1);
  const memListB=await call('/api/memory',null,ownerB,{method:'GET'});
  assert.equal(memListB.data.length,0); // Tenant B sees none of Tenant A's brand memory

  // Tenant A triggers a real agent run (Frost has no external dependency and always exists).
  const runA=await call('/api/agents/frost/run',{scenario:'اختبار داخلي'},ownerA);
  assert.equal(runA.status,200);
  const runsListA=(await call('/api/agents/frost/runs',null,ownerA,{method:'GET'})).data;
  assert.equal(runsListA.length,1);
  const runsListB=(await call('/api/agents/frost/runs',null,ownerB,{method:'GET'})).data;
  assert.equal(runsListB.length,0); // Tenant B sees none of Tenant A's agent runs
  const directRunFetchByB=await call(`/api/agents/runs/${runsListA[0].id}`,null,ownerB,{method:'GET'});
  assert.equal(directRunFetchByB.status,404); // guessing the real run id doesn't work either

  // Tenant A's weekly report doesn't leak to Tenant B.
  await call('/api/reports/weekly',{},ownerA);
  const reportsA=(await call('/api/reports/weekly',null,ownerA,{method:'GET'})).data.saved;
  const reportsB=(await call('/api/reports/weekly',null,ownerB,{method:'GET'})).data.saved;
  assert.ok(reportsA.length>=1);
  assert.equal(reportsB.length,0);
  }finally{await cleanup();}
});

test('IDOR: Tenant B cannot decide or even see Tenant A\'s pending approval by guessing its real id',async()=>{
 const {call,cleanup,ownerA,ownerB}=await twoTenants();
 try{
 const lead=await call('/api/crm/leads',{name:'Riyadh Club',customerType:'B2B',sourceType:'INBOUND',company:'Riyadh Club',email:'club@example.com'},ownerA);
 const draft=await call(`/api/crm/leads/${lead.data.id}/email-send`,{subject:'Quote',bodyHtml:'<p>...</p>',category:'quote'},ownerA);
 assert.equal(draft.data.status,'WAITING_APPROVAL');
 const approvalsA=(await call('/api/approvals',null,ownerA,{method:'GET'})).data;
 assert.equal(approvalsA.length,1);
 const approvalsB=(await call('/api/approvals',null,ownerB,{method:'GET'})).data;
 assert.equal(approvalsB.length,0); // Tenant B's approval center is genuinely empty
 const decideByB=await call(`/api/approvals/${approvalsA[0].id}/decide`,{decision:'APPROVED'},ownerB);
 assert.equal(decideByB.status,404); // cannot decide an approval belonging to another tenant
 }finally{await cleanup();}
});

test('IDOR: Tenant B cannot resolve Tenant A\'s hot-lead escalation by guessing its real id',async()=>{
 const {call,cleanup,ownerA,ownerB}=await twoTenants();
 try{
 const lead=await call('/api/crm/leads',{name:'Club',customerType:'B2B',sourceType:'INBOUND',company:'Club'},ownerA);
 await call(`/api/crm/leads/${lead.data.id}/update`,{stage:'QUALIFIED',temperature:'HOT',reason:'مهتم فعليًا',expectedVersion:1},ownerA);
 const escalationsA=(await call('/api/escalations',null,ownerA,{method:'GET'})).data;
 assert.equal(escalationsA.length,1);
 const escalationsB=(await call('/api/escalations',null,ownerB,{method:'GET'})).data;
 assert.equal(escalationsB.length,0);
 const resolveByB=await call(`/api/escalations/${escalationsA[0].id}/resolve`,{},ownerB);
 assert.equal(resolveByB.status,404);
 }finally{await cleanup();}
});

test('IDOR: Tenant B\'s Salla product catalog sync never touches or deletes Tenant A\'s catalog (the critical DELETE-wipe bug fix)',async()=>{
 const {app,call,cleanup,ownerA,ownerB}=await twoTenants();
 try{
 const {replaceProducts}=await import('../src/knowledge.js');
 const {resolveTenantForUser}=await import('../src/tenancy.js');
 const authRowA=app.store.db.prepare("SELECT id FROM users WHERE username='ownera'").get();
 const tenantA=resolveTenantForUser(app.store.db,authRowA.id);
 replaceProducts(app.store.db,[{id:'p1',name:{value:'Cryo A'}}],true,tenantA);
 const productsA=(await call('/api/products',null,ownerA,{method:'GET'})).data;
 assert.equal(productsA.length,1);
 // Tenant B syncs its OWN (empty) catalog — must never wipe Tenant A's rows.
 const {resolveTenantForUser:resolveB}=await import('../src/tenancy.js');
 const authRowB=app.store.db.prepare("SELECT id FROM users WHERE username='ownerb'").get();
 const tenantB=resolveB(app.store.db,authRowB.id);
 replaceProducts(app.store.db,[],true,tenantB);
 const productsAAfter=(await call('/api/products',null,ownerA,{method:'GET'})).data;
 assert.equal(productsAAfter.length,1); // still there — the old global DELETE FROM products bug is fixed
 const productsB=(await call('/api/products',null,ownerB,{method:'GET'})).data;
 assert.equal(productsB.length,0);
 }finally{await cleanup();}
});
