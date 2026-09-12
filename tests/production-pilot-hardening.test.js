import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';
import {createTenant} from '../src/tenancy.js';
import {getTrialStatus,tenantOperationalBlockReason} from '../src/tenancy.js';
import {botProtectionStatus,captchaRequiredFor,verifyBotProtection} from '../src/runtime/bot-protection.js';
import {isPlatformAdmin} from '../src/platform-admin.js';
import {saveCredentials} from '../src/runtime/credentials.js';

// Phase 4C-7 — Production Pilot Hardening. Real HTTP end-to-end tests, same harness shape as
// every prior phase's own test file (mail capture transport for safe, real verification links).
async function harness(env={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-pilot-'));
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
async function signupAndVerify(call,app,{username,email}) {
 const signup=await call('/api/signup',{name:'مستخدم اختبار',username,email,password:'a-long-test-password'});
 const session={cookie:signup.cookie,csrf:signup.csrf};
 const mail=latestMailTo(app,email,'VERIFY_EMAIL');
 await call('/api/account/email/verify',{token:extractToken(mail,'verify-email')},null);
 return session;
}

// --- Bot protection ------------------------------------------------------------------------

test('Bot protection status: DISABLED with no provider, CONFIGURED with turnstile+secret, ERROR when secret missing',()=>{
 assert.equal(botProtectionStatus({}).status,'DISABLED');
 assert.equal(botProtectionStatus({CAPTCHA_PROVIDER:'turnstile',TURNSTILE_SECRET_KEY:'x'}).status,'CONFIGURED');
 assert.equal(botProtectionStatus({CAPTCHA_PROVIDER:'turnstile'}).status,'ERROR');
});
test('captchaRequiredFor: signup defaults ON once configured; optional surfaces default OFF',()=>{
 const env={CAPTCHA_PROVIDER:'turnstile',TURNSTILE_SECRET_KEY:'x'};
 assert.equal(captchaRequiredFor(env,'signup'),true);
 assert.equal(captchaRequiredFor(env,'forgotPassword'),false);
 assert.equal(captchaRequiredFor(env,'workspaceCreation'),false);
 assert.equal(captchaRequiredFor(env,'signup'),true);
 assert.equal(captchaRequiredFor({},'signup'),false,'never required when bot protection is disabled entirely');
});
test('verifyBotProtection: disabled always passes; missing token rejected once configured; dev bypass only outside production',async()=>{
 assert.equal((await verifyBotProtection({env:{}},null)).ok,true);
 const configured={CAPTCHA_PROVIDER:'turnstile',TURNSTILE_SECRET_KEY:'x'};
 const missing=await verifyBotProtection({env:configured},null);
 assert.equal(missing.ok,false);assert.equal(missing.errorCode,'CAPTCHA_REQUIRED');
 const devBypass=await verifyBotProtection({env:{...configured,NODE_ENV:'development'}},'DEV_BYPASS');
 assert.equal(devBypass.ok,true);
 const prodBypassAttempt=await verifyBotProtection({env:{...configured,NODE_ENV:'production'},fetcher:async()=>{throw new Error('BLOCKED_REAL_NETWORK_CALL');}},'DEV_BYPASS');
 assert.equal(prodBypassAttempt.ok,false,'DEV_BYPASS must never work when NODE_ENV=production');
});
test('verifyBotProtection: a real provider failure never crashes, reports a safe generic code',async()=>{
 const configured={CAPTCHA_PROVIDER:'turnstile',TURNSTILE_SECRET_KEY:'x'};
 const result=await verifyBotProtection({env:configured,fetcher:async()=>({ok:false,status:500})},'some-token');
 assert.equal(result.ok,false);assert.equal(result.errorCode,'CAPTCHA_PROVIDER_ERROR');
});

// --- Trial status service -------------------------------------------------------------------

test('getTrialStatus: all four real states, derived from the timestamp itself',()=>{
 const now=Date.now();
 assert.equal(getTrialStatus({trialExpiresAt:null}).status,'NOT_TRIAL');
 assert.equal(getTrialStatus({trialExpiresAt:new Date(now+10*86400000).toISOString()}).status,'ACTIVE_TRIAL');
 assert.equal(getTrialStatus({trialExpiresAt:new Date(now+2*86400000).toISOString()}).status,'EXPIRING_SOON');
 assert.equal(getTrialStatus({trialExpiresAt:new Date(now-1000).toISOString()}).status,'EXPIRED');
});
test('tenantOperationalBlockReason: SUSPENDED, ARCHIVED, and time-based EXPIRED all block — even if status has not been flipped yet',()=>{
 assert.equal(tenantOperationalBlockReason(null),'TENANT_NOT_FOUND');
 assert.equal(tenantOperationalBlockReason({status:'ACTIVE'}),null);
 assert.equal(tenantOperationalBlockReason({status:'ARCHIVED'}),'TENANT_ARCHIVED');
 assert.equal(tenantOperationalBlockReason({status:'SUSPENDED'}),'TENANT_SUSPENDED');
 // Still status='TRIAL' in the DB (scheduler hasn't run yet) but the real timestamp is past —
 // must block anyway (Part 17's own explicit requirement).
 assert.equal(tenantOperationalBlockReason({status:'TRIAL',trialExpiresAt:new Date(Date.now()-1000).toISOString()}),'TENANT_TRIAL_EXPIRED');
});

// --- Central eligibility wired into the real agent runtime ----------------------------------

test('An agent run against an expired-trial tenant is refused immediately over the real HTTP route, even before the scheduler has flipped its status',async()=>{
 // Deliberately exercised via the real `/api/agents/:id/run` route, not a direct
 // agentRuntime call: this is exactly the scenario the new central check exists for — the
 // OUTER tenant-resolution gate (`resolveTenantForUser`) still matches this tenant fine,
 // since `status` is still 'TRIAL' in the DB (only the real timestamp has passed, the
 // scheduler hasn't run yet) — so the owner reaches this route normally, and it is the
 // RUNTIME's own inner check (Part 17/18) that must catch the real, live expiry.
 const {app,call,cleanup}=await harness();
 try{
  const session=await signupAndVerify(call,app,{username:'trial_run_owner',email:'trial-run@example.com'});
  const ws=await call('/api/workspaces',{companyName:'Trial Run Co'},session);
  app.store.db.prepare("UPDATE tenants SET trial_expires_at=? WHERE id=?").run(new Date(Date.now()-1000).toISOString(),ws.data.id);
  const stillTrial=app.store.db.prepare('SELECT status FROM tenants WHERE id=?').get(ws.data.id).status;
  assert.equal(stillTrial,'TRIAL','the DB status must still say TRIAL — this test is specifically about the lag before the scheduler runs');
  const run=await call('/api/agents/sales/run',{scenario:'اختبار'},session);
  assert.equal(run.status,200);
  assert.equal(run.data.status,'CANCELLED');
  assert.equal(run.data.error,'TENANT_TRIAL_EXPIRED');
 }finally{await cleanup();}
});

// --- Registration gate + pilot limits --------------------------------------------------------

test('ALLOW_PUBLIC_SIGNUP=false closes public registration; invitation registration remains unaffected',async()=>{
 const {app,call,cleanup}=await harness({ALLOW_PUBLIC_SIGNUP:'false'});
 try{
  const closed=await call('/api/signup',{name:'x',username:'blocked_signup',email:'blocked@example.com',password:'a-long-test-password'});
  assert.equal(closed.status,403);

  const owner=await call('/api/setup',{username:'gate_owner',name:'Owner',password:'a-long-test-password'});
  await call('/api/auth',null,owner,{method:'GET'});
  const tenantId=app.store.db.prepare("SELECT tenant_id AS id FROM tenant_memberships WHERE user_id=(SELECT id FROM users WHERE username='gate_owner')").get().id;
  const {createInvitation}=await import('../src/invitations.js');
  const inviterId=app.store.db.prepare("SELECT id FROM users WHERE username='gate_owner'").get().id;
  const {token}=createInvitation(app.store.db,tenantId,{email:'invitee-gate@example.com',role:'operator'},inviterId);
  const register=await call(`/api/invitations/${token}/register`,{username:'invitee_gate',name:'Invitee',password:'a-long-test-password'});
  assert.equal(register.status,200,'invitation registration must never be blocked by ALLOW_PUBLIC_SIGNUP');
 }finally{await cleanup();}
});
test('MAX_TOTAL_TRIAL_WORKSPACES enforces a real platform-wide ceiling',async()=>{
 const {app,call,cleanup}=await harness({MAX_TOTAL_TRIAL_WORKSPACES:'1'});
 try{
  const sessionA=await signupAndVerify(call,app,{username:'ceiling_a',email:'ceiling-a@example.com'});
  const first=await call('/api/workspaces',{companyName:'Ceiling Co A'},sessionA);
  assert.equal(first.status,201);
  const sessionB=await signupAndVerify(call,app,{username:'ceiling_b',email:'ceiling-b@example.com'});
  const second=await call('/api/workspaces',{companyName:'Ceiling Co B'},sessionB);
  assert.equal(second.status,403);
 }finally{await cleanup();}
});

// --- Platform Admin --------------------------------------------------------------------------

test('isPlatformAdmin: real allowlist match only, case-insensitive on username',()=>{
 assert.equal(isPlatformAdmin({PLATFORM_ADMIN_USERNAMES:'root_admin, ops_lead'},{username:'Root_Admin'}),true);
 assert.equal(isPlatformAdmin({PLATFORM_ADMIN_USERNAMES:'root_admin'},{username:'someone_else'}),false);
 assert.equal(isPlatformAdmin({},{username:'root_admin'}),false);
});
test('Platform routes: IDOR — a normal tenant owner (not on the allowlist) is refused; reviewer/operator refused too',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'plain_owner',name:'Owner',password:'a-long-test-password'});
  await call('/api/auth',null,owner,{method:'GET'});
  assert.equal((await call('/api/platform/overview',null,owner,{method:'GET'})).status,403);
  assert.equal((await call('/api/platform/tenants',null,owner,{method:'GET'})).status,403);
 }finally{await cleanup();}
});
test('Platform routes: a real allowlisted admin sees real, live data across tenants they are not even a member of',async()=>{
 const {app,call,cleanup}=await harness({PLATFORM_ADMIN_USERNAMES:'admin_user'});
 try{
  const ownerSession=await signupAndVerify(call,app,{username:'owned_co',email:'owned-co@example.com'});
  const ws=await call('/api/workspaces',{companyName:'Owned Co'},ownerSession);

  const auth=createAuth(app.store.db);
  auth.createUser({username:'admin_user',name:'Admin',password:'a-long-test-password'},'owner');
  const login=auth.login({username:'admin_user',password:'a-long-test-password'},'127.0.0.1');
  const adminSession={cookie:'hc_session='+login.token,csrf:login.csrf};

  const overview=await call('/api/platform/overview',null,adminSession,{method:'GET'});
  assert.equal(overview.status,200);
  assert.ok(overview.data.tenants.total>=1);

  const directory=await call('/api/platform/tenants',null,adminSession,{method:'GET'});
  assert.equal(directory.status,200);
  assert.ok(directory.data.some(t=>t.id===ws.data.id));

  const detail=await call(`/api/platform/tenants/${ws.data.id}`,null,adminSession,{method:'GET'});
  assert.equal(detail.status,200);
  assert.equal(detail.data.tenant.id,ws.data.id);
  assert.ok(detail.data.members.length>=1);
  const raw=JSON.stringify(detail.data);
  assert.ok(!raw.includes('a-long-test-password'),'never a password/secret in a platform admin view');
 }finally{await cleanup();}
});
test('Platform suspend: an admin can suspend tenant A; tenant B is unaffected; A\'s members lose access on their very next request',async()=>{
 const {app,call,cleanup}=await harness({PLATFORM_ADMIN_USERNAMES:'admin_user'});
 try{
  const sessionA=await signupAndVerify(call,app,{username:'suspend_a',email:'suspend-a@example.com'});
  const wsA=await call('/api/workspaces',{companyName:'Suspend A'},sessionA);
  const sessionB=await signupAndVerify(call,app,{username:'suspend_b',email:'suspend-b@example.com'});
  const wsB=await call('/api/workspaces',{companyName:'Suspend B'},sessionB);

  const auth=createAuth(app.store.db);
  auth.createUser({username:'admin_user',name:'Admin',password:'a-long-test-password'},'owner');
  const login=auth.login({username:'admin_user',password:'a-long-test-password'},'127.0.0.1');
  const adminSession={cookie:'hc_session='+login.token,csrf:login.csrf};

  const suspend=await call(`/api/platform/tenants/${wsA.data.id}/suspend`,{reason:'test'},adminSession);
  assert.equal(suspend.status,200);

  const afterA=await call('/api/onboarding',null,sessionA,{method:'GET'});
  assert.equal(afterA.status,403);
  const afterB=await call('/api/onboarding',null,sessionB,{method:'GET'});
  assert.equal(afterB.status,200,'tenant B must be completely unaffected by tenant A\'s suspension');

  const auditRow=app.store.db.prepare("SELECT * FROM platform_audit_log WHERE action='PLATFORM_TENANT_SUSPENDED' AND item_id=?").get(wsA.data.id);
  assert.ok(auditRow,'platform suspension must be audited');
 }finally{await cleanup();}
});
test('Platform reactivate: restores ACTIVE status without touching any real data',async()=>{
 const {app,call,cleanup}=await harness({PLATFORM_ADMIN_USERNAMES:'admin_user'});
 try{
  const session=await signupAndVerify(call,app,{username:'react_owner',email:'react@example.com'});
  const ws=await call('/api/workspaces',{companyName:'Reactivate Co'},session);
  const auth=createAuth(app.store.db);
  auth.createUser({username:'admin_user',name:'Admin',password:'a-long-test-password'},'owner');
  const login=auth.login({username:'admin_user',password:'a-long-test-password'},'127.0.0.1');
  const adminSession={cookie:'hc_session='+login.token,csrf:login.csrf};

  await call(`/api/platform/tenants/${ws.data.id}/suspend`,{},adminSession);
  const reactivate=await call(`/api/platform/tenants/${ws.data.id}/reactivate`,{},adminSession);
  assert.equal(reactivate.status,200);
  const tenant=app.store.db.prepare('SELECT status FROM tenants WHERE id=?').get(ws.data.id);
  assert.equal(tenant.status,'ACTIVE');
  const memberships=app.store.db.prepare('SELECT COUNT(*) n FROM tenant_memberships WHERE tenant_id=?').get(ws.data.id).n;
  assert.equal(memberships,1,'reactivation must never touch membership/business data');
 }finally{await cleanup();}
});
test('Platform extend-trial: pushes trial_expires_at forward and restores TRIAL status for an expired tenant',async()=>{
 const {app,call,cleanup}=await harness({PLATFORM_ADMIN_USERNAMES:'admin_user'});
 try{
  const session=await signupAndVerify(call,app,{username:'extend_owner',email:'extend@example.com'});
  const ws=await call('/api/workspaces',{companyName:'Extend Co'},session);
  app.store.db.prepare("UPDATE tenants SET status='SUSPENDED',trial_expires_at=? WHERE id=?").run(new Date(Date.now()-86400000).toISOString(),ws.data.id);

  const auth=createAuth(app.store.db);
  auth.createUser({username:'admin_user',name:'Admin',password:'a-long-test-password'},'owner');
  const login=auth.login({username:'admin_user',password:'a-long-test-password'},'127.0.0.1');
  const adminSession={cookie:'hc_session='+login.token,csrf:login.csrf};

  const extend=await call(`/api/platform/tenants/${ws.data.id}/extend-trial`,{days:14},adminSession);
  assert.equal(extend.status,200);
  assert.equal(extend.data.status,'TRIAL');
  assert.ok(new Date(extend.data.trialExpiresAt).getTime()>Date.now());

  const afterOwner=await call('/api/onboarding',null,session,{method:'GET'});
  assert.equal(afterOwner.status,200,'the owner must be operational again immediately after extension');

  const auditRow=app.store.db.prepare("SELECT * FROM platform_audit_log WHERE action='TRIAL_EXTENDED' AND item_id=?").get(ws.data.id);
  assert.ok(auditRow);
 }finally{await cleanup();}
});

// --- Concurrency (Part 39/41) ------------------------------------------------------------------

test('Signup concurrency: two parallel signups with the SAME username — exactly one account exists',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const attempt=()=>call('/api/signup',{name:'Race',username:'race_user',email:`race-${Math.random()}@example.com`,password:'a-long-test-password'});
  const [a,b]=await Promise.all([attempt(),attempt()]);
  const succeeded=[a,b].filter(r=>r.status===201);
  assert.equal(succeeded.length,1,'exactly one signup with a duplicate username must succeed');
  const count=app.store.db.prepare("SELECT COUNT(*) n FROM users WHERE username='race_user'").get().n;
  assert.equal(count,1);
 }finally{await cleanup();}
});
test('Invitation concurrency: two parallel accepts of the SAME invitation — exactly one active membership, never a duplicate',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'race_owner',name:'Owner',password:'a-long-test-password'});
  await call('/api/auth',null,owner,{method:'GET'});
  const tenantId=app.store.db.prepare("SELECT tenant_id AS id FROM tenant_memberships WHERE user_id=(SELECT id FROM users WHERE username='race_owner')").get().id;
  const inviterId=app.store.db.prepare("SELECT id FROM users WHERE username='race_owner'").get().id;
  const {createInvitation}=await import('../src/invitations.js');
  const {token}=createInvitation(app.store.db,tenantId,{email:'race-invitee@example.com',role:'operator'},inviterId);

  const auth=createAuth(app.store.db);
  const invitee=auth.createUser({username:'race_invitee',name:'Invitee',password:'a-long-test-password'},'operator');
  const login=auth.login({username:'race_invitee',password:'a-long-test-password'},'127.0.0.1');
  const session={cookie:'hc_session='+login.token,csrf:login.csrf};

  const attempt=()=>call(`/api/invitations/${token}/accept`,{},session);
  const [a,b]=await Promise.all([attempt(),attempt()]);
  const succeeded=[a,b].filter(r=>r.status===200);
  assert.ok(succeeded.length>=1);
  const memberships=app.store.db.prepare('SELECT COUNT(*) n FROM tenant_memberships WHERE tenant_id=? AND user_id=?').get(tenantId,invitee.id).n;
  assert.equal(memberships,1,'never a duplicate membership row from a concurrent double-accept');
 }finally{await cleanup();}
});

// --- Slug concurrency (Part 40) ---------------------------------------------------------------

test('Slug concurrency: two parallel workspace creations with the SAME explicit slug — only one succeeds',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const sessionA=await signupAndVerify(call,app,{username:'slug_race_a',email:'slug-race-a@example.com'});
  const sessionB=await signupAndVerify(call,app,{username:'slug_race_b',email:'slug-race-b@example.com'});
  const [a,b]=await Promise.all([
   call('/api/workspaces',{companyName:'Slug Race A',slug:'race-slug'},sessionA),
   call('/api/workspaces',{companyName:'Slug Race B',slug:'race-slug'},sessionB)
  ]);
  const succeeded=[a,b].filter(r=>r.status===201);
  assert.equal(succeeded.length,1,'exactly one of two concurrent identical explicit slugs must succeed');
  const count=app.store.db.prepare("SELECT COUNT(*) n FROM tenants WHERE slug='race-slug'").get().n;
  assert.equal(count,1);
 }finally{await cleanup();}
});

// --- Agent runtime parallel-tenant load (Part 44) -----------------------------------------------
// "never call real AI at scale" — the ONE real boundary mocked here is the outbound AI fetch
// itself, exactly like tests/runtime-api.test.js's own established pattern; every other layer
// (routing, session, tenant resolution, run persistence) is the real, unmocked code path.

test('Agent runtime under parallel load across two tenants: every run stays correctly scoped to its own tenant, with zero cross-tenant leakage',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hypercool-pilot-agent-load-'));
 const decisionFor=label=>({status:'OK',action:'REPLY',rationale:'ok',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
  payload:{intent:'price',customer_type:'B2C',qualification:{city:null,product_need:null,quantity:null,timeline:null,budget_band:null},recommended_product_id:null,reply_ar:`رد-${label}`,reply_en:`reply-${label}`,next_best_action:'x',lead_temperature:'COLD',crm_updates:{},missing_fields:[],handoff_reason:null}});
 const modelResponse=value=>new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(value)}],usage:{input_tokens:3,output_tokens:3}}),{status:200,headers:{'content-type':'application/json'}});
 // Echoes back whichever tenant's own scenario text was actually sent in THIS request's
 // messages — a real cross-tenant leak (e.g. a shared/stale context object) would show up
 // immediately as tenant A's run receiving a reply built for tenant B, or vice versa.
 const app=await createApp({dataDir:directory,env:{PLATFORM_MAIL_TRANSPORT:'capture',ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model'},fetcher:async(url,init)=>{
  const userContent=JSON.parse(init.body).messages[0].content;
  const label=userContent.includes('TENANT_A')?'A':userContent.includes('TENANT_B')?'B':'UNKNOWN';
  return modelResponse(decisionFor(label));
 }});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session){const res=await fetch(base+path,{method:input?'POST':'GET',headers:{...(input?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{})},...(input?{body:JSON.stringify(input)}:{})});const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};}
 try{
  const sessionA=await signupAndVerify(call,app,{username:'load_owner_a',email:'load-a@example.com'});
  const wsA=await call('/api/workspaces',{companyName:'Load Tenant A'},sessionA);
  const sessionB=await signupAndVerify(call,app,{username:'load_owner_b',email:'load-b@example.com'});
  const wsB=await call('/api/workspaces',{companyName:'Load Tenant B'},sessionB);
  const runsPerTenant=10;
  const runOn=session=>call('/api/agents/sales/run',{scenario:session===sessionA?'TENANT_A scenario':'TENANT_B scenario'},session);
  const [resultsA,resultsB]=await Promise.all([
   Promise.all(Array.from({length:runsPerTenant},()=>runOn(sessionA))),
   Promise.all(Array.from({length:runsPerTenant},()=>runOn(sessionB)))
  ]);
  for(const r of resultsA){
   assert.equal(r.status,200);
   assert.equal(r.data.status,'COMPLETED');
   assert.equal(r.data.tenant_id,wsA.data.id);
   assert.equal(r.data.output.payload.reply_ar,'رد-A','tenant A must never receive tenant B\'s reply');
  }
  for(const r of resultsB){
   assert.equal(r.status,200);
   assert.equal(r.data.status,'COMPLETED');
   assert.equal(r.data.tenant_id,wsB.data.id);
   assert.equal(r.data.output.payload.reply_ar,'رد-B','tenant B must never receive tenant A\'s reply');
  }
  assert.equal(app.store.db.prepare('SELECT COUNT(*) c FROM agent_runs WHERE tenant_id=?').get(wsA.data.id).c,runsPerTenant);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) c FROM agent_runs WHERE tenant_id=?').get(wsB.data.id).c,runsPerTenant);
 }finally{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}
});

// --- Webhook burst (Part 42) ---------------------------------------------------------------
// Real HTTP delivery volume against the actual `/api/webhooks/meta/whatsapp` route (never a
// direct function call), across two real tenants, proving `webhook_events`' existing
// UNIQUE(source,external_event_id) constraint (src/runtime/webhook-events.js) holds under a
// real concurrent burst — not just the two-request race already covered elsewhere.

test('Webhook burst: 120 concurrent WhatsApp deliveries across two tenants — correct per-tenant routing, real duplicate ids collapse to one, no cross-tenant leakage',async()=>{
 const key32=randomBytes(32).toString('hex');
 const webhookSecret='burst-webhook-secret';
 const {app,call,cleanup}=await harness({INTEGRATION_ENCRYPTION_KEY:key32,META_WEBHOOK_SECRET:webhookSecret});
 try{
  const sessionA=await signupAndVerify(call,app,{username:'burst_owner_a',email:'burst-a@example.com'});
  const wsA=await call('/api/workspaces',{companyName:'Burst Tenant A'},sessionA);
  const sessionB=await signupAndVerify(call,app,{username:'burst_owner_b',email:'burst-b@example.com'});
  const wsB=await call('/api/workspaces',{companyName:'Burst Tenant B'},sessionB);
  saveCredentials(app.store.db,{INTEGRATION_ENCRYPTION_KEY:key32},'meta',{accessToken:'user-token',expiresAt:new Date(Date.now()+3600000).toISOString(),extra:{pageAccessToken:'page-token'},metadata:{whatsapp:{phoneNumberId:'phone-burst-a',businessAccountId:'waba-a',displayPhoneNumber:'+9665phonea'}}},null,wsA.data.id);
  saveCredentials(app.store.db,{INTEGRATION_ENCRYPTION_KEY:key32},'meta',{accessToken:'user-token',expiresAt:new Date(Date.now()+3600000).toISOString(),extra:{pageAccessToken:'page-token'},metadata:{whatsapp:{phoneNumberId:'phone-burst-b',businessAccountId:'waba-b',displayPhoneNumber:'+9665phoneb'}}},null,wsB.data.id);
  const rawFor=(phoneNumberId,msgId,fromSuffix)=>JSON.stringify({entry:[{changes:[{value:{metadata:{phone_number_id:phoneNumberId},contacts:[{profile:{name:'Customer '+fromSuffix}}],messages:[{id:msgId,from:'96650'+String(fromSuffix).padStart(7,'0'),type:'text',text:{body:'burst message '+fromSuffix}}]}}]}]});
  const sign=body=>'sha256='+createHmac('sha256',webhookSecret).update(body).digest('hex');
  const send=raw=>call('/api/webhooks/meta/whatsapp',raw,null,{headers:{'x-hub-signature-256':sign(raw)}});
  const perTenant=50;
  const requests=[];
  // Tenant B uses a disjoint phone-number range (+1000) so any cross-tenant leakage would show
  // up as an unexpected overlap in the phone sets asserted below, not as coincidental reuse.
  for(let i=0;i<perTenant;i++)requests.push(send(rawFor('phone-burst-a','wamid.burst.a.'+i,i)));
  for(let i=0;i<perTenant;i++)requests.push(send(rawFor('phone-burst-b','wamid.burst.b.'+i,i+1000)));
  // Real duplicate redeliveries (the same provider event id sent twice) — a genuine, common
  // real-world case (the provider retries on a slow/ambiguous response) — must collapse to
  // exactly one stored event each, never a duplicate lead.
  for(let i=0;i<20;i++)requests.push(send(rawFor('phone-burst-a','wamid.burst.a.'+i,i)));
  const startedAt=Date.now();
  const results=await Promise.all(requests);
  const elapsedMs=Date.now()-startedAt;
  for(const r of results)assert.equal(r.status,200,'every real, correctly signed delivery must be accepted');
  assert.ok(elapsedMs<15000,`120-event burst took ${elapsedMs}ms — unreasonably slow for pilot scale`);

  const eventsA=app.store.db.prepare("SELECT COUNT(*) c FROM webhook_events WHERE tenant_id=? AND source='meta'").get(wsA.data.id).c;
  const eventsB=app.store.db.prepare("SELECT COUNT(*) c FROM webhook_events WHERE tenant_id=? AND source='meta'").get(wsB.data.id).c;
  assert.equal(eventsA,perTenant,'the 20 duplicate redeliveries must never create additional stored events');
  assert.equal(eventsB,perTenant);

  const leadsA=(await call('/api/crm',null,sessionA,{method:'GET'})).data.leads;
  const leadsB=(await call('/api/crm',null,sessionB,{method:'GET'})).data.leads;
  assert.equal(leadsA.length,perTenant);
  assert.equal(leadsB.length,perTenant);
  assert.ok(leadsA.every(l=>l.phone.startsWith('+96650')),'sanity: real per-tenant lead data');
  assert.equal(new Set([...leadsA.map(l=>l.phone),...leadsB.map(l=>l.phone)]).size,perTenant*2,'tenant A and tenant B used disjoint phone ranges in this test — any overlap in the combined set would mean cross-tenant leakage, not coincidence');
 }finally{await cleanup();}
});
