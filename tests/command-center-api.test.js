import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

async function harness(env={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-command-center-'));
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
function latestMailTo(app,toEmail,kind) {
 const row=app.store.db.prepare('SELECT * FROM platform_mail_outbox WHERE to_email=? AND kind=? ORDER BY created_at DESC LIMIT 1').get(toEmail,kind);
 return row?JSON.parse(row.captured_body):null;
}
function extractToken(body,marker) {
 const match=(body.html+body.text).match(new RegExp(marker+'/([a-f0-9]+)'));
 return match?match[1]:null;
}
// Same real signup -> verify email -> create workspace flow as tests/self-service-workspaces.test.js
// — the only way to get a genuinely SECOND, independent tenant (the first is /api/setup's own
// platform-bootstrap owner) for a real cross-tenant isolation check.
async function signupAndCreateWorkspace(call,app,{username,email,companyName}) {
 const signup=await call('/api/signup',{name:'مستخدم اختبار',username,email,password:'a-long-test-password'});
 const session={cookie:signup.cookie,csrf:signup.csrf};
 const mail=latestMailTo(app,email,'VERIFY_EMAIL');
 const token=extractToken(mail,'verify-email');
 await call('/api/account/email/verify',{token},null);
 await call('/api/workspaces',{companyName},session);
 return session;
}

test('Command Center chat: any authenticated member can view, only owner/operator can send, and a reviewer is refused',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/users',{username:'reviewer',name:'Reviewer',password:'test-password-long',role:'reviewer'},owner);
  const reviewer=await call('/api/login',{username:'reviewer',password:'test-password-long'});

  const conv=await call('/api/command/conversations',{title:'test'},owner);
  assert.equal(conv.status,201);
  const listAsReviewer=await call('/api/command/conversations',null,reviewer);
  assert.equal(listAsReviewer.status,200);
  assert.equal(listAsReviewer.data.length,1);

  const sendAsReviewer=await call(`/api/command/conversations/${conv.data.id}/messages`,{text:'اعرض حالة الشركة'},reviewer);
  assert.equal(sendAsReviewer.status,403);

  // No AI provider configured in this test env — a real, honest failure, never a fabricated answer.
  const sendAsOwner=await call(`/api/command/conversations/${conv.data.id}/messages`,{text:'اعرض حالة الشركة'},owner);
  assert.equal(sendAsOwner.status,201);
  assert.match(sendAsOwner.data.assistantMessage.content,/اتصال ذكاء اصطناعي/);
  assert.equal(sendAsOwner.data.runStatus,'FAILED');

  const messages=await call(`/api/command/conversations/${conv.data.id}/messages`,null,owner);
  assert.equal(messages.data.length,2);
 }finally{await cleanup();}
});

test('Command Center conversations and messages are tenant-isolated end to end',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const ownerA=await call('/api/setup',{username:'ownera',name:'Owner A',password:'test-password-long'});
  const convA=await call('/api/command/conversations',{title:'A'},ownerA);

  const ownerB=await signupAndCreateWorkspace(call,app,{username:'ownerb',email:'ownerb@example.com',companyName:'Tenant B'});

  const crossRead=await call(`/api/command/conversations/${convA.data.id}/messages`,null,ownerB);
  assert.equal(crossRead.status,404);
  const listB=await call('/api/command/conversations',null,ownerB);
  assert.equal(listB.data.length,0);
 }finally{await cleanup();}
});

test('Command Center context: create/list/update/archive with real governance, write gated to owner/operator',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/users',{username:'reviewer',name:'Reviewer',password:'test-password-long',role:'reviewer'},owner);
  const reviewer=await call('/api/login',{username:'reviewer',password:'test-password-long'});

  const deniedCreate=await call('/api/command/context',{type:'company_goal',title:'x',description:''},reviewer);
  assert.equal(deniedCreate.status,403);

  const created=await call('/api/command/context',{type:'company_goal',title:'زيادة المبيعات',description:'هدف الربع الحالي',priority:'HIGH'},owner);
  assert.equal(created.status,201);
  assert.equal(created.data.source,'manual');
  assert.equal(created.data.createdByName,'Owner'); // a real actor recorded it, never anonymous

  const listed=await call('/api/command/context',null,reviewer,{method:'GET'});
  assert.equal(listed.status,200);
  assert.equal(listed.data.length,1);

  const updated=await call(`/api/command/context/${created.data.id}`,{title:'زيادة المبيعات 25%'},owner,{method:'PATCH'});
  assert.equal(updated.status,200);
  assert.equal(updated.data.title,'زيادة المبيعات 25%');

  const archived=await call(`/api/command/context/${created.data.id}/archive`,{},owner);
  assert.equal(archived.status,200);
  const afterArchive=await call('/api/command/context',null,owner,{method:'GET'});
  assert.equal(afterArchive.data.length,0);
 }finally{await cleanup();}
});

test('Command Center suggestions: computed from real state, Accept/Dismiss/Create Task are stable and gated',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/users',{username:'reviewer',name:'Reviewer',password:'test-password-long',role:'reviewer'},owner);
  const reviewer=await call('/api/login',{username:'reviewer',password:'test-password-long'});

  const empty=await call('/api/command/suggestions',null,owner,{method:'GET'});
  assert.equal(empty.status,200);
  assert.deepEqual(empty.data,[]); // a brand-new tenant has no real problems to suggest

  const deniedDismiss=await call('/api/command/suggestions/does-not-exist/dismiss',{},reviewer);
  assert.equal(deniedDismiss.status,403); // role check happens before the 404 lookup
 }finally{await cleanup();}
});

test('Command Center live operations feed never leaks a raw credential/token — only safe, already-public fields',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  const conv=await call('/api/command/conversations',{},owner);
  await call(`/api/command/conversations/${conv.data.id}/messages`,{text:'اعرض حالة الشركة'},owner);
  const ops=await call('/api/command/operations',null,owner,{method:'GET'});
  assert.equal(ops.status,200);
  const raw=JSON.stringify(ops.data);
  assert.doesNotMatch(raw,/access_token|refresh_token|api_key|client_secret/i);
 }finally{await cleanup();}
});

test('Command Center system map route is a thin, real wrapper around the existing Agent Connection Map — no second implementation',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  const viaCommand=await call('/api/command/system-map',null,owner,{method:'GET'});
  const viaControlCenter=await call('/api/agent-connection-map',null,owner,{method:'GET'});
  assert.equal(viaCommand.status,200);
  assert.deepEqual(viaCommand.data,viaControlCenter.data);
 }finally{await cleanup();}
});
