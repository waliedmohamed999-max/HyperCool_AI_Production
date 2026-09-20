import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {PLANS,PLAN_IDS,getPlan,listPlans,effectivePlan,planAllowsAgent,planAllowsIntegration,planAllowsCommandCenter,planSeatLimitReached} from '../src/plans.js';

// --- Unit tests: src/plans.js is the single source of truth every real enforcement point
// (agent runs, integration connections, team invitations, Command Center) reads from. -------

test('PLAN_IDS/listPlans/getPlan are consistent with each other',()=>{
 assert.deepEqual(PLAN_IDS,['starter','growth','professional','enterprise']);
 assert.equal(listPlans().length,4);
 for(const id of PLAN_IDS)assert.equal(getPlan(id).id,id);
 assert.equal(getPlan('unknown'),null);
});

test('effectivePlan: a tenant with no plan or an unrecognized plan id is unrestricted (grandfather rule)',()=>{
 assert.equal(effectivePlan(null),null);
 assert.equal(effectivePlan({plan:null}),null);
 assert.equal(effectivePlan({plan:'legacy-tier-that-no-longer-exists'}),null);
 assert.equal(effectivePlan({plan:'professional'}).id,'professional');
});

test('planAllowsAgent: null plan (unrestricted) allows everything; a real plan enforces its own list',()=>{
 assert.equal(planAllowsAgent(null,'creative'),true);
 assert.equal(planAllowsAgent(PLANS.starter,'frost'),true);
 assert.equal(planAllowsAgent(PLANS.starter,'creative'),false);
 assert.equal(planAllowsAgent(PLANS.professional,'creative'),true);
 assert.equal(planAllowsAgent(PLANS.professional,'frost_commander'),true);
});

test('planAllowsIntegration: AI providers are always allowed (core infra, never a paid channel)',()=>{
 assert.equal(planAllowsIntegration(PLANS.starter,{category:'ai',slug:'anthropic'}),true);
 assert.equal(planAllowsIntegration(PLANS.starter,{category:'ai',slug:'openai'}),true);
});

test('planAllowsIntegration: Starter only includes WhatsApp; Growth adds Meta/X but not Salla',()=>{
 assert.equal(planAllowsIntegration(PLANS.starter,{category:'messaging',slug:'whatsapp',adapterType:'BUILT_IN'}),true);
 assert.equal(planAllowsIntegration(PLANS.starter,{category:'social',slug:'meta',adapterType:'BUILT_IN'}),false);
 assert.equal(planAllowsIntegration(PLANS.growth,{category:'social',slug:'meta',adapterType:'BUILT_IN'}),true);
 assert.equal(planAllowsIntegration(PLANS.growth,{category:'ecommerce',slug:'salla',adapterType:'BUILT_IN'}),false);
 assert.equal(planAllowsIntegration(PLANS.professional,{category:'ecommerce',slug:'salla',adapterType:'BUILT_IN'}),true);
});

test('planAllowsIntegration: a tenant-authored GENERIC_REST connector requires the customIntegrations feature',()=>{
 const genericDef={category:'other',slug:'custom-1',adapterType:'GENERIC_REST'};
 assert.equal(planAllowsIntegration(PLANS.professional,genericDef),false);
 assert.equal(planAllowsIntegration(PLANS.enterprise,genericDef),true);
});

test('planAllowsCommandCenter and planSeatLimitReached',()=>{
 assert.equal(planAllowsCommandCenter(null),true);
 assert.equal(planAllowsCommandCenter(PLANS.starter),false);
 assert.equal(planAllowsCommandCenter(PLANS.professional),true);
 assert.equal(planSeatLimitReached(null,999),false);
 assert.equal(planSeatLimitReached(PLANS.starter,1),false);
 assert.equal(planSeatLimitReached(PLANS.starter,2),true);
 assert.equal(planSeatLimitReached(PLANS.professional,999),false);
});

// --- HTTP-level tests: real enforcement wired into the live app. ---------------------------

async function harness(env={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-plans-'));
 const app=await createApp({dataDir:directory,env:{PLATFORM_MAIL_TRANSPORT:'capture',...env}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method}={}) {
  const res=await fetch(base+path,{method:method||(input?'POST':'GET'),headers:{...(input?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{})},...(input?{body:JSON.stringify(input)}:{})});
  const data=await res.json().catch(()=>null);
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 return {app,base,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}

test('GET /api/plans: any authenticated member sees all 4 plans; a fresh tenant has no plan assigned',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  const res=await call('/api/plans',null,owner);
  assert.equal(res.status,200);
  assert.equal(res.data.plans.length,4);
  assert.deepEqual(res.data.plans.map(p=>p.id),['starter','growth','professional','enterprise']);
  assert.equal(res.data.currentPlanId,null);
 }finally{await cleanup();}
});

test('PATCH /api/tenant/plan: only an owner can assign a plan; an operator/reviewer is refused',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/users',{username:'operator',name:'Operator',password:'test-password-long',role:'operator'},owner);
  const operator=await call('/api/login',{username:'operator',password:'test-password-long'});
  const refused=await call('/api/tenant/plan',{planId:'starter'},operator,{method:'PATCH'});
  assert.equal(refused.status,403);
  const badId=await call('/api/tenant/plan',{planId:'not-a-real-plan'},owner,{method:'PATCH'});
  assert.equal(badId.status,400);
  const ok=await call('/api/tenant/plan',{planId:'starter'},owner,{method:'PATCH'});
  assert.equal(ok.status,200);
  assert.equal(ok.data.plan,'starter');
  const nowCurrent=await call('/api/plans',null,owner);
  assert.equal(nowCurrent.data.currentPlanId,'starter');
 }finally{await cleanup();}
});

test('Starter plan: agent not included in the plan is cancelled with PLAN_AGENT_NOT_INCLUDED, without spending any tokens',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/tenant/plan',{planId:'starter'},owner,{method:'PATCH'});
  const blocked=await call('/api/agents/creative/run',{scenario:'test scenario'},owner);
  assert.equal(blocked.status,200);
  assert.equal(blocked.data.status,'CANCELLED');
  assert.equal(blocked.data.error,'PLAN_AGENT_NOT_INCLUDED');
  const allowed=await call('/api/agents/copy/run',{scenario:'test scenario'},owner);
  assert.notEqual(allowed.data.error,'PLAN_AGENT_NOT_INCLUDED');
 }finally{await cleanup();}
});

test('Professional plan: every agent is included, including ones Starter excludes',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/tenant/plan',{planId:'professional'},owner,{method:'PATCH'});
  const res=await call('/api/agents/creative/run',{scenario:'test scenario'},owner);
  assert.notEqual(res.data.error,'PLAN_AGENT_NOT_INCLUDED');
 }finally{await cleanup();}
});

test('Starter plan: creating a connection outside the plan (Meta) is refused; WhatsApp (included) succeeds',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/tenant/plan',{planId:'starter'},owner,{method:'PATCH'});
  const blocked=await call('/api/integrations/connections',{integrationDefinitionId:'meta',name:'صفحتنا'},owner);
  assert.equal(blocked.status,403);
  const allowed=await call('/api/integrations/connections',{integrationDefinitionId:'whatsapp',name:'رقم الأعمال'},owner);
  assert.equal(allowed.status,201);
 }finally{await cleanup();}
});

test('Starter plan: the Frost Command Center API is fully blocked (403 PLAN_FEATURE_NOT_INCLUDED); Professional allows it',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/tenant/plan',{planId:'starter'},owner,{method:'PATCH'});
  const blocked=await call('/api/command/conversations',null,owner);
  assert.equal(blocked.status,403);
  assert.equal(blocked.data.error,'PLAN_FEATURE_NOT_INCLUDED');
  await call('/api/tenant/plan',{planId:'professional'},owner,{method:'PATCH'});
  const allowed=await call('/api/command/conversations',null,owner);
  assert.equal(allowed.status,200);
 }finally{await cleanup();}
});

test('Starter plan: inviting beyond maxTeamMembers(2) is refused; resending an existing pending invite still works',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/tenant/plan',{planId:'starter'},owner,{method:'PATCH'});
  // Seat 1 is the owner itself; one more invitation reaches Starter's cap of 2.
  const firstInvite=await call('/api/workspaces/invitations',{email:'member1@example.com',role:'operator'},owner);
  assert.equal(firstInvite.status,201);
  const secondInvite=await call('/api/workspaces/invitations',{email:'member2@example.com',role:'operator'},owner);
  assert.equal(secondInvite.status,403);
  const resend=await call('/api/workspaces/invitations',{email:'member1@example.com',role:'operator'},owner);
  assert.equal(resend.status,201);
 }finally{await cleanup();}
});

test('A tenant with no plan assigned is never affected by plan gating (grandfather rule)',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  const conn=await call('/api/integrations/connections',{integrationDefinitionId:'meta',name:'صفحتنا'},owner);
  assert.equal(conn.status,201);
  const run=await call('/api/agents/creative/run',{scenario:'test scenario'},owner);
  assert.notEqual(run.data.error,'PLAN_AGENT_NOT_INCLUDED');
  const cc=await call('/api/command/conversations',null,owner);
  assert.equal(cc.status,200);
 }finally{await cleanup();}
});
