import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {createTenant,resolveTenantForUser} from '../src/tenancy.js';
import {randomUUID} from 'node:crypto';

// Phase 3 cross-tenant IDOR matrix — covers every surface newly tenant-scoped in this phase
// (content_items, calendar_slots/schedule_jobs, ai_runs, compliance_runs,
// whatsapp_templates, crm_requests) that Phase 1/2's own tests (tenancy.test.js,
// tenancy-phase2.test.js) predate and therefore never exercised. Same harness/twoTenants
// shape as tenancy-phase2.test.js, reused deliberately rather than reinvented.
async function harness(env={}){
 const directory=await mkdtemp(join(tmpdir(),'hypercool-tenancy3-'));
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
async function twoTenants(env={}) {
 const {app,call,cleanup}=await harness(env);
 const ownerA=await call('/api/setup',{username:'ownera',name:'Owner A',password:'a-long-test-password'});
 // Phase 4C-1: resolve Owner A's own membership while still the sole tenant — see the same
 // note in tests/tenancy-phase2.test.js.
 await call('/api/auth',null,ownerA,{method:'GET'});
 const auth=createAuth(app.store.db);
 const userB=auth.createUser({username:'ownerb',name:'Owner B',password:'a-long-test-password'},'owner');
 const tenantB=createTenant(app.store.db,{name:'Second Co',slug:'second-co'},userB.id);
 app.store.db.prepare('DELETE FROM tenant_memberships WHERE user_id=? AND tenant_id!=?').run(userB.id,tenantB);
 const loginB=auth.login({username:'ownerb',password:'a-long-test-password'},'127.0.0.1');
 const ownerB={cookie:'hc_session='+loginB.token,csrf:loginB.csrf};
 const userA=app.store.db.prepare("SELECT id FROM users WHERE username='ownera'").get();
 const tenantA=resolveTenantForUser(app.store.db,userA.id);
 return {app,call,cleanup,ownerA,ownerB,tenantA,tenantB};
}

test('IDOR: Tenant B cannot read, review, approve, or schedule Tenant A\'s content by guessing its real id',async()=>{
 const {call,cleanup,ownerA,ownerB}=await twoTenants();
 try{
  await call('/api/calendar',{startDate:'2035-02-04'},ownerA); // Sunday
  const fields={title:'Cryo launch',body:'Original body',englishCopy:'Original English',platform:'X',date:'2035-02-04',url:'https://hyper-cool.com/offers'};
  const draft=(await call('/api/content',fields,ownerA)).data;

  // Tenant A's dashboard shows it; Tenant B's dashboard is genuinely empty.
  const dashA=(await call('/api/content/dashboard',null,ownerA,{method:'GET'})).data;
  const dashB=(await call('/api/content/dashboard',null,ownerB,{method:'GET'})).data;
  assert.equal(dashA.kpis.drafts.value,1);
  assert.equal(dashB.kpis.drafts.value,0);

  // Direct-id review/approve/revise/reject by Tenant B all 404 — never a distinguishable
  // "exists but isn't yours" response.
  const reviewByB=await call(`/api/content/${draft.id}/review`,{evidence:'Checked',facts:true,claims:true,link:true},ownerB);
  assert.equal(reviewByB.status,404);
  const approveByB=await call(`/api/content/${draft.id}/approve`,{},ownerB);
  assert.equal(approveByB.status,404);
  const reviseByB=await call(`/api/content/${draft.id}/revise`,{...fields,reason:'edit'},ownerB);
  assert.equal(reviseByB.status,404);
  const rejectByB=await call(`/api/content/${draft.id}/reject`,{reason:'no'},ownerB);
  assert.equal(rejectByB.status,404);

  // Tenant A approves for real, then Tenant B still cannot schedule it into ITS OWN calendar.
  await call(`/api/content/${draft.id}/review`,{evidence:'Checked',facts:true,claims:true,link:true},ownerA);
  await call(`/api/content/${draft.id}/approve`,{},ownerA);
  await call('/api/calendar',{startDate:'2035-02-04'},ownerB);
  const scheduleByB=await call('/api/schedule',{contentId:draft.id,scheduledAt:'2035-02-04T12:00:00+03:00'},ownerB);
  assert.equal(scheduleByB.status,404);
  // Tenant A schedules it into ITS OWN calendar without issue.
  const scheduleByA=await call('/api/schedule',{contentId:draft.id,scheduledAt:'2035-02-04T12:00:00+03:00'},ownerA);
  assert.equal(scheduleByA.status,201);
 }finally{await cleanup();}
});

test('IDOR: calendar_slots and schedule_jobs never cross tenants — each owner sees only its own calendar',async()=>{
 const {call,cleanup,ownerA,ownerB}=await twoTenants();
 try{
  await call('/api/calendar',{startDate:'2035-03-04'},ownerA); // Sunday
  const planA=(await call('/api/planning',null,ownerA,{method:'GET'})).data;
  const planB=(await call('/api/planning',null,ownerB,{method:'GET'})).data;
  assert.ok(planA.slots.length>0);
  assert.equal(planB.slots.length,0); // Tenant B has no calendar at all until it creates its own
  await call('/api/calendar',{startDate:'2035-03-04'},ownerB);
  const planBAfter=(await call('/api/planning',null,ownerB,{method:'GET'})).data;
  assert.equal(planBAfter.slots.length,planA.slots.length); // same shape, fully independent rows
 }finally{await cleanup();}
});

test('IDOR: whatsapp_templates never leak across tenants (seeded directly, matching a real Meta sync\'s row shape)',async()=>{
 const {app,call,cleanup,tenantA,tenantB}=await twoTenants();
 try{
  const ownerA=await call('/api/login',{username:'ownera',password:'a-long-test-password'});
  const ownerB=await call('/api/login',{username:'ownerb',password:'a-long-test-password'});
  const now=new Date().toISOString();
  app.store.db.prepare('INSERT INTO whatsapp_templates (id,tenant_id,template_external_id,name,language,category,status,components,last_synced_at) VALUES (?,?,?,?,?,?,?,?,?)')
   .run(randomUUID(),tenantA,'ext-1','quote_followup','ar','MARKETING','APPROVED','[]',now);
  const templatesA=(await call('/api/whatsapp/templates',null,ownerA,{method:'GET'})).data;
  const templatesB=(await call('/api/whatsapp/templates',null,ownerB,{method:'GET'})).data;
  assert.equal(templatesA.length,1);
  assert.equal(templatesB.length,0);
  // Tenant B can independently sync-insert a template of the SAME name+language — the old
  // global UNIQUE(name,language) would have made this collide/fail; it must not anymore.
  app.store.db.prepare('INSERT INTO whatsapp_templates (id,tenant_id,template_external_id,name,language,category,status,components,last_synced_at) VALUES (?,?,?,?,?,?,?,?,?)')
   .run(randomUUID(),tenantB,'ext-2','quote_followup','ar','MARKETING','PENDING','[]',now);
  const templatesBAfter=(await call('/api/whatsapp/templates',null,ownerB,{method:'GET'})).data;
  assert.equal(templatesBAfter.length,1);
  assert.equal(templatesBAfter[0].status,'PENDING'); // its own row, not Tenant A's APPROVED one
 }finally{await cleanup();}
});

test('IDOR: crm_requests idempotency cache never lets Tenant B replay or collide with Tenant A\'s cached follow-up draft',async()=>{
 const {call,cleanup,ownerA,ownerB}=await twoTenants();
 try{
  const leadA=(await call('/api/crm/leads',{name:'Riyadh Club',customerType:'B2B',sourceType:'INBOUND',company:'Riyadh Club',email:'club-a@example.com',productUrl:'https://hyper-cool.com/offers'},ownerA)).data;
  const leadB=(await call('/api/crm/leads',{name:'Jeddah Club',customerType:'B2B',sourceType:'INBOUND',company:'Jeddah Club',email:'club-b@example.com',productUrl:'https://hyper-cool.com/offers'},ownerB)).data;
  await call(`/api/crm/leads/${leadA.id}/update`,{...leadA,stage:'QUOTE_SENT',temperature:'WARM',reason:'quote recorded',expectedVersion:1},ownerA);
  await call(`/api/crm/leads/${leadB.id}/update`,{...leadB,stage:'QUOTE_SENT',temperature:'WARM',reason:'quote recorded',expectedVersion:1},ownerB);
  await call(`/api/crm/leads/${leadA.id}/contact`,{expectedVersion:2,action:'CONSENT',channel:'Email',confirmed:true,evidence:'Customer asked to follow up',obtainedAt:new Date().toISOString()},ownerA);
  await call(`/api/crm/leads/${leadB.id}/contact`,{expectedVersion:2,action:'CONSENT',channel:'Email',confirmed:true,evidence:'Customer asked to follow up',obtainedAt:new Date().toISOString()},ownerB);
  const sharedRequestKey=randomUUID(); // the exact same client-supplied idempotency key, reused across tenants on purpose
  const startAt=new Date(Date.now()+3*86400000).toISOString();
  const draftA=await call(`/api/crm/leads/${leadA.id}/followups`,{requestKey:sharedRequestKey,sequence:'QUOTE',channel:'Email',startAt,evidence:'Quote reference Q-A'},ownerA);
  assert.equal(draftA.status,201);
  // Tenant B uses the SAME requestKey string for its OWN, completely different lead — the
  // old global crm_requests PK (key alone) would have either falsely 409'd ("مفتاح الطلب
  // مستخدم") or, worse, replayed Tenant A's cached items back to Tenant B. Neither may happen.
  const draftB=await call(`/api/crm/leads/${leadB.id}/followups`,{requestKey:sharedRequestKey,sequence:'QUOTE',channel:'Email',startAt,evidence:'Quote reference Q-B'},ownerB);
  assert.equal(draftB.status,201);
  assert.notEqual(draftB.data.replayed,true);
  assert.notEqual(draftB.data.items[0].leadId,draftA.data.items[0].leadId);
  assert.equal(draftB.data.items[0].leadId,leadB.id);
  // Tenant A's own follow-up list never shows Tenant B's items.
  const crmA=(await call('/api/crm',null,ownerA,{method:'GET'})).data;
  assert.equal(crmA.followups.length,3);
  assert.ok(crmA.followups.every(f=>f.leadId===leadA.id));
 }finally{await cleanup();}
});

test('IDOR: ai_runs never leak across tenants (seeded directly, matching a real generate() row shape)',async()=>{
 const {app,call,cleanup,tenantA,tenantB}=await twoTenants();
 try{
  const ownerA=await call('/api/login',{username:'ownera',password:'a-long-test-password'});
  const ownerB=await call('/api/login',{username:'ownerb',password:'a-long-test-password'});
  const userA=app.store.db.prepare("SELECT id FROM users WHERE username='ownera'").get();
  const run={id:randomUUID(),status:'COMPLETED',createdAt:new Date().toISOString(),finishedAt:new Date().toISOString(),actorId:userA.id,productId:'123',title:'t',brief:{},model:'test-model'};
  app.store.db.prepare('INSERT INTO ai_runs (id,tenant_id,request_key,request_hash,actor_id,status,json) VALUES (?,?,?,?,?,?,?)')
   .run(run.id,tenantA,randomUUID(),'hash-a',userA.id,run.status,JSON.stringify(run));
  const runsA=(await call('/api/ai/runs',null,ownerA,{method:'GET'})).data;
  const runsB=(await call('/api/ai/runs',null,ownerB,{method:'GET'})).data;
  assert.equal(runsA.length,1);
  assert.equal(runsB.length,0);
 }finally{await cleanup();}
});

test('IDOR: compliance_runs never leak across tenants — Tenant B cannot read Tenant A\'s compliance history by guessing the content id',async()=>{
 const {call,cleanup,app,tenantA}=await twoTenants();
 try{
  const ownerA=await call('/api/login',{username:'ownera',password:'a-long-test-password'});
  const ownerB=await call('/api/login',{username:'ownerb',password:'a-long-test-password'});
  await call('/api/calendar',{startDate:'2035-04-01'},ownerA);
  const fields={title:'t',body:'b',platform:'Instagram',date:'2035-04-01',url:'https://hyper-cool.com/offers'};
  const draft=(await call('/api/content',fields,ownerA)).data;
  const runId=randomUUID();
  app.store.db.prepare('INSERT INTO compliance_runs (id,tenant_id,content_id,request_key,content_hash,actor_id,status,json) VALUES (?,?,?,?,?,?,?,?)')
   .run(runId,tenantA,draft.id,randomUUID(),'hash','actor','COMPLETED',JSON.stringify({id:runId,contentId:draft.id,status:'COMPLETED'}));
  const checksA=(await call(`/api/content/${draft.id}/compliance`,null,ownerA,{method:'GET'})).data;
  assert.equal(checksA.length,1);
  const checksB=await call(`/api/content/${draft.id}/compliance`,null,ownerB,{method:'GET'});
  // Tenant B doesn't own this content id at all, so the read resolves against ITS OWN
  // (empty) tenant scope — genuinely zero results, never Tenant A's real compliance history.
  assert.equal(checksB.status,200);
  assert.equal(checksB.data.length,0);
 }finally{await cleanup();}
});
