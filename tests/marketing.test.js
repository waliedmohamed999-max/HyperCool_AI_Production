import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

async function harness(env={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-marketing-'));
 const app=await createApp({dataDir:directory,env:{PLATFORM_MAIL_TRANSPORT:'capture',...env}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method,headers={}}={}) {
  const res=await fetch(base+path,{method:method||(input?'POST':'GET'),headers:{...(input?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(input?{body:JSON.stringify(input)}:{})});
  const data=await res.json().catch(()=>null);
  return {status:res.status,data,headers:res.headers,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 return {app,base,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function latestMailTo(app,toEmail,kind) {
 const row=app.store.db.prepare('SELECT * FROM platform_mail_outbox WHERE to_email=? AND kind=? ORDER BY created_at DESC LIMIT 1').get(toEmail,kind);
 return row?JSON.parse(row.captured_body):null;
}
function extractToken(body,marker) {
 const match=(body.html+body.text).match(new RegExp(marker+'/([a-f0-9]+)'));
 return match?match[1]:null;
}
async function signupAndCreateWorkspace(call,app,{username,email,companyName}) {
 const signup=await call('/api/signup',{name:'مستخدم اختبار',username,email,password:'a-long-test-password'});
 const session={cookie:signup.cookie,csrf:signup.csrf};
 const mail=latestMailTo(app,email,'VERIFY_EMAIL');
 const token=extractToken(mail,'verify-email');
 await call('/api/account/email/verify',{token},null);
 await call('/api/workspaces',{companyName},session);
 return session;
}

test('Campaign lifecycle: create, generate strategy honestly fails without AI, update status, archive',async()=>{
 const {call,app,cleanup}=await harness();
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'mkt_owner1',email:'mkt1@example.com',companyName:'Nova Test'});
  const created=await call('/api/marketing/campaigns',{name:'حملة الصيف',goal:'زيادة المبيعات',channels:['Instagram','WhatsApp']},owner);
  assert.equal(created.status,201);
  assert.equal(created.data.status,'DRAFT');
  assert.deepEqual(created.data.channels,['Instagram','WhatsApp']);

  // No AI provider configured in this test env — strategy generation must fail honestly,
  // never fabricate a plan (matches the app-wide "no fake success" contract).
  const strategy=await call(`/api/marketing/campaigns/${created.data.id}/generate-strategy`,{},owner);
  assert.equal(strategy.status,200);
  assert.equal(strategy.data.run.status,'FAILED');
  assert.equal(strategy.data.campaign.strategy,null);

  const updated=await call(`/api/marketing/campaigns/${created.data.id}`,{status:'ACTIVE'},owner,{method:'PATCH'});
  assert.equal(updated.status,200);
  assert.equal(updated.data.status,'ACTIVE');

  const archived=await call(`/api/marketing/campaigns/${created.data.id}/archive`,{},owner);
  assert.equal(archived.status,200);
  const list=await call('/api/marketing/campaigns',null,owner,{method:'GET'});
  assert.equal(list.data.find(c=>c.id===created.data.id),undefined);
 } finally {await cleanup();}
});

test('Content lifecycle: illegal status transitions are rejected, legal ones succeed',async()=>{
 const {call,app,cleanup}=await harness();
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'mkt_owner2',email:'mkt2@example.com',companyName:'Nova Test 2'});
  const item=await call('/api/marketing/content',{channel:'Instagram',format:'post',body:'نص تجريبي'},owner);
  assert.equal(item.status,201);
  assert.equal(item.data.status,'DRAFT');

  const illegal=await call(`/api/marketing/content/${item.data.id}`,{status:'PUBLISHED'},owner,{method:'PATCH'});
  assert.equal(illegal.status,400);

  const toReview=await call(`/api/marketing/content/${item.data.id}`,{status:'IN_REVIEW'},owner,{method:'PATCH'});
  assert.equal(toReview.status,200);
  // Phase MKT-2 Part C: approval now requires a real, matching, non-BLOCK compliance result —
  // the full mocked-provider happy path is covered in tests/marketing-orchestration.test.js;
  // this test (no AI configured) only needs to prove the gate genuinely refuses without one.
  const toApprovedNoCompliance=await call(`/api/marketing/content/${item.data.id}`,{status:'APPROVED'},owner,{method:'PATCH'});
  assert.equal(toApprovedNoCompliance.status,409);
 } finally {await cleanup();}
});

test('Tenant isolation: Tenant B never sees Tenant A campaigns, content, or inbox conversations',async()=>{
 const {call,app,cleanup}=await harness();
 try {
  const ownerA=await signupAndCreateWorkspace(call,app,{username:'mkt_a',email:'mkta@example.com',companyName:'Tenant A'});
  const ownerB=await signupAndCreateWorkspace(call,app,{username:'mkt_b',email:'mktb@example.com',companyName:'Tenant B'});
  const campaignA=await call('/api/marketing/campaigns',{name:'حملة سرّية A'},ownerA);
  await call('/api/marketing/content',{channel:'X',format:'post',body:'محتوى A'},ownerA);

  const listB=await call('/api/marketing/campaigns',null,ownerB,{method:'GET'});
  assert.equal(listB.data.length,0);
  const contentB=await call('/api/marketing/content',null,ownerB,{method:'GET'});
  assert.equal(contentB.data.length,0);
  const getCrossTenant=await call(`/api/marketing/campaigns/${campaignA.data.id}`,null,ownerB,{method:'GET'});
  assert.equal(getCrossTenant.status,404);

  const inboxB=await call('/api/marketing/inbox',null,ownerB,{method:'GET'});
  assert.equal(inboxB.status,200);
  assert.equal(inboxB.data.length,0);
 } finally {await cleanup();}
});

test('Approval enforcement: a reviewer cannot create or mutate campaigns/content',async()=>{
 const {call,app,cleanup}=await harness();
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'mkt_owner3',email:'mkt3@example.com',companyName:'Nova Test 3'});
  const invite=await call('/api/workspaces/invitations',{email:'reviewer3@example.com',role:'reviewer'},owner);
  assert.equal(invite.status,201);
  const register=await call(`/api/invitations/${invite.data.token}/register`,{username:'reviewer3',name:'مراجع',password:'a-long-test-password'},null);
  assert.equal(register.status,200);
  const reviewer={cookie:register.cookie,csrf:register.data.csrf};

  const denied=await call('/api/marketing/campaigns',{name:'محاولة غير مصرح بها'},reviewer);
  assert.equal(denied.status,403);
  const item=await call('/api/marketing/content',{channel:'X',format:'post',body:'test'},owner);
  const deniedPatch=await call(`/api/marketing/content/${item.data.id}`,{status:'IN_REVIEW'},reviewer,{method:'PATCH'});
  assert.equal(deniedPatch.status,403);
  // Reads remain allowed for any member.
  const readOk=await call('/api/marketing/campaigns',null,reviewer,{method:'GET'});
  assert.equal(readOk.status,200);
 } finally {await cleanup();}
});

test('Website widget: disabled by default, requires an allowed origin, rate-limits, never leaks secrets',async()=>{
 const {call,app,cleanup}=await harness();
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'mkt_owner4',email:'mkt4@example.com',companyName:'Nova Test 4'});
  const config=await call('/api/marketing/widget',null,owner,{method:'GET'});
  assert.equal(config.status,200);
  assert.equal(config.data.status,'DISABLED');
  assert.ok(config.data.publicWidgetId);

  // Disabled widget: the public endpoint must refuse even a request with a plausible origin.
  const disabledAttempt=await call(`/api/public/widget/${config.data.publicWidgetId}/chat`,{text:'مرحبا'},null,{headers:{Origin:'https://example.com'}});
  assert.equal(disabledAttempt.status,404);

  const enable=await call('/api/marketing/widget',{status:'ACTIVE',allowedDomains:['example.com']},owner,{method:'PATCH'});
  assert.equal(enable.status,200);
  assert.equal(enable.data.status,'ACTIVE');

  // Wrong/disallowed origin is refused even though the widget itself is active.
  const wrongOrigin=await call(`/api/public/widget/${config.data.publicWidgetId}/chat`,{text:'مرحبا'},null,{headers:{Origin:'https://attacker.test'}});
  assert.equal(wrongOrigin.status,403);

  // Correct origin succeeds, creates a real lead, and — with no AI configured in this test
  // env — honestly reports no reply rather than fabricating one.
  const ok=await call(`/api/public/widget/${config.data.publicWidgetId}/chat`,{text:'عندي سؤال عن المنتج',name:'زائر'},null,{headers:{Origin:'https://example.com'}});
  assert.equal(ok.status,200);
  assert.ok(ok.data.leadId);
  assert.equal(ok.data.aiAvailable,false);
  assert.equal(JSON.stringify(ok.data).toLowerCase().includes('token'),false);
  assert.equal(JSON.stringify(ok.data).toLowerCase().includes('secret'),false);

  // A second message from the SAME visitor (same leadId) must not create a second lead.
  const second=await call(`/api/public/widget/${config.data.publicWidgetId}/chat`,{text:'رسالة ثانية',leadId:ok.data.leadId},null,{headers:{Origin:'https://example.com'}});
  assert.equal(second.status,200);
  assert.equal(second.data.leadId,ok.data.leadId);
  const inbox=await call('/api/marketing/inbox',null,owner,{method:'GET'});
  assert.equal(inbox.data.filter(c=>c.leadId===ok.data.leadId).length,1);

  // Rate limit: hammer the endpoint past the configured per-minute cap.
  let rateLimited=false;
  for(let i=0;i<15;i++) {
   const attempt=await call(`/api/public/widget/${config.data.publicWidgetId}/chat`,{text:'سبام',leadId:ok.data.leadId},null,{headers:{Origin:'https://example.com'}});
   if(attempt.status===429){rateLimited=true;break;}
  }
  assert.ok(rateLimited,'expected the widget rate limiter to eventually reject a burst of requests');

  // A completely unknown widget id must 404, never leak whether it exists but is disabled.
  const unknown=await call('/api/public/widget/doesnotexist/chat',{text:'hi'},null,{headers:{Origin:'https://example.com'}});
  assert.equal(unknown.status,404);
 } finally {await cleanup();}
});

test('Website widget CORS: OPTIONS preflight only reflects an actually-allowed origin',async()=>{
 const {call,app,cleanup}=await harness();
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'mkt_owner5',email:'mkt5@example.com',companyName:'Nova Test 5'});
  await call('/api/marketing/widget',{status:'ACTIVE',allowedDomains:['allowed.com']},owner,{method:'PATCH'});
  const config=await call('/api/marketing/widget',null,owner,{method:'GET'});

  const goodPreflight=await call(`/api/public/widget/${config.data.publicWidgetId}/chat`,null,null,{method:'OPTIONS',headers:{Origin:'https://allowed.com'}});
  assert.equal(goodPreflight.status,204);
  assert.equal(goodPreflight.headers.get('access-control-allow-origin'),'https://allowed.com');

  const badPreflight=await call(`/api/public/widget/${config.data.publicWidgetId}/chat`,null,null,{method:'OPTIONS',headers:{Origin:'https://not-allowed.com'}});
  assert.equal(badPreflight.status,204);
  assert.equal(badPreflight.headers.get('access-control-allow-origin'),null);
 } finally {await cleanup();}
});

test('Workspace switch: marketing overview reflects only the active tenant\'s real data',async()=>{
 const {call,app,cleanup}=await harness();
 try {
  const ownerA=await signupAndCreateWorkspace(call,app,{username:'mkt_switch_a',email:'switcha@example.com',companyName:'Switch A'});
  const ownerB=await signupAndCreateWorkspace(call,app,{username:'mkt_switch_b',email:'switchb@example.com',companyName:'Switch B'});
  await call('/api/marketing/campaigns',{name:'حملة A فقط'},ownerA);
  const overviewA=await call('/api/marketing/overview',null,ownerA,{method:'GET'});
  const overviewB=await call('/api/marketing/overview',null,ownerB,{method:'GET'});
  assert.equal(overviewA.data.marketing.campaigns.total,1);
  assert.equal(overviewB.data.marketing.campaigns.total,0);
 } finally {await cleanup();}
});
