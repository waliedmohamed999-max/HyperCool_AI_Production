import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {expireTrials} from '../src/tenancy.js';

// Phase 4C-6 — Self-Service Signup + New Company Creation + Trial Workspace. Real HTTP
// end-to-end tests, same harness shape as tests/platform-identity.test.js (mail capture
// transport so a real verification link can be read back without any network call).
async function harness(env={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-selfservice-'));
 const app=await createApp({dataDir:directory,env:{PLATFORM_MAIL_TRANSPORT:'capture',...env}});
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
function latestMailTo(app,toEmail,kind) {
 const row=app.store.db.prepare('SELECT * FROM platform_mail_outbox WHERE to_email=? AND kind=? ORDER BY created_at DESC LIMIT 1').get(toEmail,kind);
 return row?JSON.parse(row.captured_body):null;
}
function extractToken(body,marker) {
 const match=(body.html+body.text).match(new RegExp(marker+'/([a-f0-9]+)'));
 return match?match[1]:null;
}
async function signupAndVerify(call,app,{username,email,name='مستخدم اختبار'}) {
 const signup=await call('/api/signup',{name,username,email,password:'a-long-test-password'});
 const session={cookie:signup.cookie,csrf:signup.csrf};
 const mail=latestMailTo(app,email,'VERIFY_EMAIL');
 const token=extractToken(mail,'verify-email');
 await call('/api/account/email/verify',{token},null);
 return session;
}

test('Public signup: username created, email pending, cannot create workspace yet',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const signup=await call('/api/signup',{name:'مستخدم جديد',username:'newbie_signup',email:'newbie@example.com',password:'a-long-test-password'});
  assert.equal(signup.status,201);
  assert.equal(signup.data.user.username,'newbie_signup');
  assert.equal(signup.data.user.email,null);
  assert.equal(signup.data.delivered,true);
  const session={cookie:signup.cookie,csrf:signup.csrf};
  const create=await call('/api/workspaces',{companyName:'شركة تجريبية'},session);
  assert.equal(create.status,403);
  assert.equal(create.data.error,'EMAIL_VERIFICATION_REQUIRED');
 }finally{await cleanup();}
});

test('After verification, the same user CAN create a workspace',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const session=await signupAndVerify(call,app,{username:'verified_signup',email:'verified@example.com'});
  const create=await call('/api/workspaces',{companyName:'شركة تجريبية للاختبار'},session);
  assert.equal(create.status,201);
  assert.ok(create.data.id);
  assert.ok(create.data.slug);
  assert.ok(create.data.trialExpiresAt);
 }finally{await cleanup();}
});

test('Legacy username-only owner can use their existing tenant but cannot self-create a new one until verified',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'legacy_owner_6',name:'Legacy',password:'a-long-test-password'});
  const existing=await call('/api/auth',null,owner,{method:'GET'});
  assert.ok(existing.data.user); // existing tenant access unaffected
  const create=await call('/api/workspaces',{companyName:'شركة جديدة'},owner);
  assert.equal(create.status,403);
  assert.equal(create.data.error,'EMAIL_VERIFICATION_REQUIRED');
 }finally{await cleanup();}
});

test('Tenant creation is correct: real tenant, single owner membership, TRIAL status, trial timestamps, 12 agent configs seeded, zero business data',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const session=await signupAndVerify(call,app,{username:'creator_full',email:'creator-full@example.com'});
  const create=await call('/api/workspaces',{companyName:'منشأة كاملة',defaultLocale:'en',timezone:'Africa/Cairo'},session);
  const tenantId=create.data.id;

  const tenant=app.store.db.prepare('SELECT * FROM tenants WHERE id=?').get(tenantId);
  assert.equal(tenant.status,'TRIAL');
  assert.ok(tenant.trial_started_at);
  assert.ok(tenant.trial_expires_at);
  assert.equal(tenant.default_locale,'en');
  assert.equal(tenant.timezone,'Africa/Cairo');

  const memberships=app.store.db.prepare('SELECT * FROM tenant_memberships WHERE tenant_id=?').all(tenantId);
  assert.equal(memberships.length,1);
  assert.equal(memberships[0].role,'owner');
  assert.equal(memberships[0].is_owner,1);

  const agentConfigs=app.store.db.prepare('SELECT * FROM tenant_agent_configs WHERE tenant_id=?').all(tenantId);
  assert.equal(agentConfigs.length,12);
  assert.ok(agentConfigs.every(c=>!c.ai_connection_id));

  const connections=app.store.db.prepare('SELECT COUNT(*) n FROM integration_connections WHERE tenant_id=?').get(tenantId);
  assert.equal(connections.n,0);
 }finally{await cleanup();}
});

test('Atomic failure: if seeding fails mid-bootstrap, no tenant/membership/config is left behind',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const session=await signupAndVerify(call,app,{username:'atomic_fail',email:'atomic-fail@example.com'});
  const before=app.store.db.prepare('SELECT COUNT(*) n FROM tenants').get().n;
  const beforeMemberships=app.store.db.prepare('SELECT COUNT(*) n FROM tenant_memberships').get().n;

  // Force a genuine mid-transaction failure: corrupt the agent-config seeding path by
  // dropping the table it writes to, so seedTenantAgentConfigs throws for real.
  app.store.db.exec('DROP TABLE tenant_agent_configs');
  const create=await call('/api/workspaces',{companyName:'شركة ستفشل'},session);
  assert.equal(create.status,400);

  const after=app.store.db.prepare('SELECT COUNT(*) n FROM tenants').get().n;
  const afterMemberships=app.store.db.prepare('SELECT COUNT(*) n FROM tenant_memberships').get().n;
  assert.equal(after,before,'no orphan tenant row after a failed bootstrap');
  assert.equal(afterMemberships,beforeMemberships,'no orphan membership row after a failed bootstrap');
 }finally{await cleanup();}
});

test('Double submit: two back-to-back create requests from the same session produce exactly one workspace',async()=>{
 // The real invariant (Part 72) is "one workspace, not duplicate" — WHICH rejection reason
 // the loser gets is a timing detail: if it lands while the winner's request is still
 // in-flight it sees 409 (the explicit guard); if it lands just after the winner already
 // committed, it correctly sees 403 WORKSPACE_LIMIT_REACHED instead (equally correct — the
 // user is now genuinely at their limit). Either way, never two tenants.
 const {app,call,cleanup}=await harness();
 try{
  const session=await signupAndVerify(call,app,{username:'double_submit',email:'double-submit@example.com'});
  const userId=app.store.db.prepare("SELECT id FROM users WHERE username='double_submit'").get().id;
  const [first,second]=await Promise.all([
   call('/api/workspaces',{companyName:'شركة النقر المزدوج'},session),
   call('/api/workspaces',{companyName:'شركة النقر المزدوج'},session)
  ]);
  const succeeded=[first,second].filter(r=>r.status===201);
  const rejected=[first,second].filter(r=>r.status!==201);
  assert.equal(succeeded.length,1,'exactly one of the two concurrent requests must succeed');
  assert.equal(rejected.length,1);
  assert.ok(['طلب إنشاء منشأة آخر قيد التنفيذ لهذا الحساب بالفعل','WORKSPACE_LIMIT_REACHED'].includes(rejected[0].data.error),'the loser must be rejected for a real, understood reason: '+rejected[0].data.error);
  const {countSelfCreatedWorkspaces}=await import('../src/tenancy.js');
  assert.equal(countSelfCreatedWorkspaces(app.store.db,userId),1,'never two tenants from one double-click');
 }finally{await cleanup();}
});

test('Workspace limit: a user at the self-created-workspace cap is blocked from creating another; invited memberships never count against it',async()=>{
 const {app,call,cleanup}=await harness({SELF_SERVICE_MAX_OWNED_WORKSPACES:'1'});
 try{
  const session=await signupAndVerify(call,app,{username:'limited_user',email:'limited@example.com'});
  const first=await call('/api/workspaces',{companyName:'المنشأة الأولى'},session);
  assert.equal(first.status,201);
  const second=await call('/api/workspaces',{companyName:'المنشأة الثانية'},session);
  assert.equal(second.status,403);
  assert.equal(second.data.error,'WORKSPACE_LIMIT_REACHED');

  // An owner-role invitation to a DIFFERENT, unrelated workspace, accepted afterward, must NOT
  // be blocked by this same self-created-workspace limit (Part 13).
  const auth=createAuth(app.store.db);
  const otherFounder=auth.createUser({username:'other_founder',name:'Other',password:'a-long-test-password'},'owner');
  const {createTenant}=await import('../src/tenancy.js');
  const otherTenantId=createTenant(app.store.db,{name:'Someone Else\'s Company',slug:'someone-elses-company'},otherFounder.id);
  const {createInvitation}=await import('../src/invitations.js');
  const {token}=createInvitation(app.store.db,otherTenantId,{email:'limited@example.com',role:'owner'},otherFounder.id);
  const accept=await call(`/api/invitations/${token}/accept`,{},session);
  assert.equal(accept.status,200,'accepting an invitation to become owner elsewhere must never be blocked by the self-created-workspace limit');
  const userId=app.store.db.prepare("SELECT id FROM users WHERE username='limited_user'").get().id;
  const {countSelfCreatedWorkspaces}=await import('../src/tenancy.js');
  assert.equal(countSelfCreatedWorkspaces(app.store.db,userId),1,'the invited-into workspace must not be counted as self-created');
 }finally{await cleanup();}
});

test('Eligibility endpoint reports the real, current policy and usage honestly',async()=>{
 const {app,call,cleanup}=await harness({SELF_SERVICE_MAX_OWNED_WORKSPACES:'2',TRIAL_DAYS:'7'});
 try{
  const session=await signupAndVerify(call,app,{username:'elig_user',email:'elig@example.com'});
  const before=await call('/api/workspaces/eligibility',null,session,{method:'GET'});
  assert.equal(before.data.allowed,true);
  assert.equal(before.data.emailVerified,true);
  assert.equal(before.data.ownedCount,0);
  assert.equal(before.data.maxOwnedWorkspaces,2);
  assert.equal(before.data.trialDays,7);
  await call('/api/workspaces',{companyName:'Eligibility Co'},session);
  const after=await call('/api/workspaces/eligibility',null,session,{method:'GET'});
  assert.equal(after.data.ownedCount,1);
 }finally{await cleanup();}
});

test('Slug: auto-generated from company name when omitted, and a reserved word is rejected for an explicit slug',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const session=await signupAndVerify(call,app,{username:'slug_user',email:'slug@example.com'});
  const auto=await call('/api/workspaces',{companyName:'Frost Cooling Co'},session);
  assert.equal(auto.status,201);
  assert.equal(auto.data.slug,'frost-cooling-co');

  const sessionB=await signupAndVerify(call,app,{username:'slug_user_b',email:'slug-b-reserved@example.com'});
  const reserved=await call('/api/workspaces',{companyName:'شركة أخرى',slug:'admin'},sessionB);
  assert.equal(reserved.status,409);
  assert.equal(reserved.data.error,'WORKSPACE_SLUG_RESERVED');
 }finally{await cleanup();}
});

test('Explicit slug conflict returns WORKSPACE_SLUG_TAKEN with a real free suggestion',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const sessionA=await signupAndVerify(call,app,{username:'slug_a',email:'slug-a@example.com'});
  const first=await call('/api/workspaces',{companyName:'Acme Co',slug:'acme'},sessionA);
  assert.equal(first.status,201);

  const sessionB=await signupAndVerify(call,app,{username:'slug_b',email:'slug-b@example.com'});
  const conflict=await call('/api/workspaces',{companyName:'Something Else',slug:'acme'},sessionB);
  assert.equal(conflict.status,409);
  assert.equal(conflict.data.error,'WORKSPACE_SLUG_TAKEN');
  assert.ok(conflict.data.suggestion && conflict.data.suggestion!=='acme');
  assert.equal(app.store.db.prepare('SELECT id FROM tenants WHERE slug=?').get(conflict.data.suggestion),undefined);
 }finally{await cleanup();}
});

test('Tenant isolation: Workspace B created via self-service cannot see Workspace A\'s data at all',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const sessionA=await signupAndVerify(call,app,{username:'iso_a',email:'iso-a@example.com'});
  const wsA=await call('/api/workspaces',{companyName:'Isolation A'},sessionA);
  await call('/api/crm/leads',{name:'عميل سري A',customerType:'B2C',sourceType:'INBOUND'},sessionA);

  const sessionB=await signupAndVerify(call,app,{username:'iso_b',email:'iso-b@example.com'});
  const wsB=await call('/api/workspaces',{companyName:'Isolation B'},sessionB);
  assert.notEqual(wsA.data.id,wsB.data.id);

  const crmB=await call('/api/crm',null,sessionB,{method:'GET'});
  const namesB=JSON.stringify(crmB.data);
  assert.ok(!namesB.includes('عميل سري A'),'Workspace B must never see Workspace A\'s CRM data');

  const controlCenterB=await call('/api/control-center/summary',null,sessionB,{method:'GET'});
  assert.equal(controlCenterB.data.workspace.id,wsB.data.id);
  assert.equal(controlCenterB.data.integrations.configuredProviders,0);
 }finally{await cleanup();}
});

test('New self-service workspace starts with real, honest empty Control Center state and a real trial banner',async()=>{
 const {app,call,cleanup}=await harness({TRIAL_DAYS:'14'});
 try{
  const session=await signupAndVerify(call,app,{username:'empty_state',email:'empty-state@example.com'});
  const ws=await call('/api/workspaces',{companyName:'Empty State Co'},session);
  const summary=await call('/api/control-center/summary',null,session,{method:'GET'});
  assert.equal(summary.data.agents.total,12);
  assert.equal(summary.data.agents.ready,0); // no AI configured yet — never fake-ready
  assert.equal(summary.data.integrations.configuredProviders,0);
  assert.equal(summary.data.aiProviders.length,0);
  assert.ok(summary.data.workspace.trial);
  assert.equal(summary.data.workspace.trial.active,true);
  assert.equal(summary.data.workspace.trial.daysRemaining,14);
 }finally{await cleanup();}
});

test('Guided Onboarding handoff: a new self-service workspace starts NOT_STARTED and is not marked complete by tenant creation itself',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const session=await signupAndVerify(call,app,{username:'onboard_handoff',email:'onboard-handoff@example.com'});
  await call('/api/workspaces',{companyName:'Onboarding Handoff Co'},session);
  const onboarding=await call('/api/onboarding',null,session,{method:'GET'});
  assert.equal(onboarding.data.status,'NOT_STARTED');
  assert.equal(onboarding.data.steps.find(s=>s.id==='ai').state,'NOT_STARTED');
 }finally{await cleanup();}
});

test('Trial expiry: the scheduler flips an overdue TRIAL tenant to SUSPENDED without deleting any data, and it stops being schedule-eligible',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const session=await signupAndVerify(call,app,{username:'trial_expire',email:'trial-expire@example.com'});
  const ws=await call('/api/workspaces',{companyName:'Trial Expiry Co'},session);
  app.store.db.prepare("UPDATE tenants SET trial_expires_at=? WHERE id=?").run(new Date(Date.now()-1000).toISOString(),ws.data.id);

  const expiredIds=expireTrials(app.store.db);
  assert.ok(expiredIds.includes(ws.data.id));

  const tenant=app.store.db.prepare('SELECT status,trial_expires_at,name FROM tenants WHERE id=?').get(ws.data.id);
  assert.equal(tenant.status,'SUSPENDED');
  assert.ok(tenant.trial_expires_at,'trial_expires_at must remain set — expiry never deletes data');
  assert.equal(tenant.name,'Trial Expiry Co');

  const {listTenants}=await import('../src/tenancy.js');
  const eligible=listTenants(app.store.db);
  assert.ok(!eligible.some(t=>t.id===ws.data.id),'an expired trial must no longer be scheduler-eligible');
 }finally{await cleanup();}
});

test('Existing legacy ACTIVE tenant is completely unaffected by this phase',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'legacy_untouched',name:'Legacy',password:'a-long-test-password'});
  await call('/api/auth',null,owner,{method:'GET'});
  const tenant=app.store.db.prepare("SELECT tenant_id AS id FROM tenant_memberships WHERE user_id=(SELECT id FROM users WHERE username='legacy_untouched')").get().id;
  const row=app.store.db.prepare('SELECT status,trial_started_at,trial_expires_at FROM tenants WHERE id=?').get(tenant);
  assert.equal(row.status,'ACTIVE');
  assert.equal(row.trial_started_at,null);
  assert.equal(row.trial_expires_at,null);
 }finally{await cleanup();}
});

test('Self-service workspace creation can be disabled platform-wide via env, independent of email verification',async()=>{
 const {app,call,cleanup}=await harness({ALLOW_SELF_SERVICE_WORKSPACE_CREATION:'false'});
 try{
  const session=await signupAndVerify(call,app,{username:'disabled_flag',email:'disabled-flag@example.com'});
  const create=await call('/api/workspaces',{companyName:'Should Not Exist'},session);
  assert.equal(create.status,403);
 }finally{await cleanup();}
});

test('IDOR/role-escalation: client-supplied ownerUserId/tenantId/status/role fields are silently ignored — creator is always the session user',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const sessionA=await signupAndVerify(call,app,{username:'idor_a',email:'idor-a@example.com'});
  const auth=createAuth(app.store.db);
  const userB=auth.createUser({username:'idor_b',name:'B',password:'a-long-test-password'},'owner');
  const create=await call('/api/workspaces',{companyName:'IDOR Attempt',ownerUserId:userB.id,tenantId:'fake-id',status:'ACTIVE',role:'owner',plan:'enterprise'},sessionA);
  assert.equal(create.status,201);
  const membership=app.store.db.prepare('SELECT user_id FROM tenant_memberships WHERE tenant_id=?').get(create.data.id);
  const userAId=app.store.db.prepare("SELECT id FROM users WHERE username='idor_a'").get().id;
  assert.equal(membership.user_id,userAId,'the creator is always the authenticated session user, never a client-supplied id');
  const tenant=app.store.db.prepare('SELECT status FROM tenants WHERE id=?').get(create.data.id);
  assert.equal(tenant.status,'TRIAL','client-supplied status is never trusted — always starts TRIAL');
 }finally{await cleanup();}
});
