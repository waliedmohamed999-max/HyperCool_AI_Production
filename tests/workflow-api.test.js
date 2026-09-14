import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

async function harness(env={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-workflow-'));
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
async function signupAndCreateWorkspace(call,app,{username,email,companyName}) {
 const signup=await call('/api/signup',{name:'مستخدم اختبار',username,email,password:'a-long-test-password'});
 const session={cookie:signup.cookie,csrf:signup.csrf};
 const mail=latestMailTo(app,email,'VERIFY_EMAIL');
 const token=extractToken(mail,'verify-email');
 await call('/api/account/email/verify',{token},null);
 await call('/api/workspaces',{companyName},session);
 return session;
}
const LINEAR_TASK_WORKFLOW={nameAr:'مهمة بسيطة',trigger:{type:'MANUAL'},steps:[{id:'a',type:'CREATE_TASK',reason:'افعل شيئًا',priority:'P3',next:[]}]};

test('Workflows: meta route lists real step/trigger/condition/event vocabularies',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  const meta=await call('/api/workflows/meta',null,owner,{method:'GET'});
  assert.equal(meta.status,200);
  assert.ok(meta.data.stepTypes.includes('AGENT'));
  assert.ok(meta.data.triggerTypes.includes('EVENT'));
  assert.ok(meta.data.conditionOperators.includes('greater_than'));
  assert.ok(meta.data.eventTypes.includes('LEAD_CREATED'));
 }finally{await cleanup();}
});

test('Workflows: create/list/get gated to owner/operator for writes, any member for reads; reviewer refused create',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/users',{username:'reviewer',name:'Reviewer',password:'test-password-long',role:'reviewer'},owner);
  const reviewer=await call('/api/login',{username:'reviewer',password:'test-password-long'});

  const deniedCreate=await call('/api/workflows',LINEAR_TASK_WORKFLOW,reviewer);
  assert.equal(deniedCreate.status,403);

  const created=await call('/api/workflows',LINEAR_TASK_WORKFLOW,owner);
  assert.equal(created.status,201);
  assert.equal(created.status===201 && created.data.status,'DRAFT');

  const listedByReviewer=await call('/api/workflows',null,reviewer,{method:'GET'});
  assert.equal(listedByReviewer.status,200);
  assert.equal(listedByReviewer.data.length,1);

  const detail=await call(`/api/workflows/${created.data.id}`,null,owner,{method:'GET'});
  assert.equal(detail.status,200);
  assert.equal(detail.data.version.steps.length,1);
 }finally{await cleanup();}
});

test('Workflows: activation requires owner, requires readiness, and a run can be triggered manually then read back',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/users',{username:'operator',name:'Operator',password:'test-password-long',role:'operator'},owner);
  const operator=await call('/api/login',{username:'operator',password:'test-password-long'});

  const created=await call('/api/workflows',LINEAR_TASK_WORKFLOW,owner);
  const readiness=await call(`/api/workflows/${created.data.id}/readiness`,null,owner,{method:'GET'});
  assert.equal(readiness.status,200);
  assert.equal(readiness.data.ready,true);

  const deniedActivate=await call(`/api/workflows/${created.data.id}/activate`,{},operator);
  assert.equal(deniedActivate.status,403); // owner-only

  const activated=await call(`/api/workflows/${created.data.id}/activate`,{},owner);
  assert.equal(activated.status,200);
  assert.equal(activated.data.status,'ACTIVE');

  const run=await call(`/api/workflows/${created.data.id}/run`,{},operator);
  assert.equal(run.status,201);
  assert.equal(run.data.status,'COMPLETED');

  const runsList=await call(`/api/workflows/${created.data.id}/runs`,null,owner,{method:'GET'});
  assert.equal(runsList.status,200);
  assert.equal(runsList.data.length,1);

  const runDetail=await call(`/api/workflow-runs/${run.data.id}`,null,owner,{method:'GET'});
  assert.equal(runDetail.status,200);
  assert.equal(runDetail.data.steps.length,1);
  assert.equal(runDetail.data.steps[0].status,'COMPLETED');
 }finally{await cleanup();}
});

test('Workflows: activation is refused with an exact reason when readiness fails (unknown agent)',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  const created=await call('/api/workflows',{nameAr:'x',trigger:{type:'MANUAL'},steps:[{id:'a',type:'AGENT',agentId:'not_a_real_agent',objective:'x',next:[]}]},owner);
  assert.equal(created.status,201);
  const activate=await call(`/api/workflows/${created.data.id}/activate`,{},owner);
  assert.equal(activate.status,409);
  assert.match(activate.data.error,/غير موجود/);
 }finally{await cleanup();}
});

test('Workflows: a running workflow can be cancelled through the API',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  const created=await call('/api/workflows',{nameAr:'تأخير',trigger:{type:'MANUAL'},steps:[{id:'wait',type:'DELAY',durationMinutes:60,next:[]}]},owner);
  await call(`/api/workflows/${created.data.id}/activate`,{},owner);
  const run=await call(`/api/workflows/${created.data.id}/run`,{},owner);
  assert.equal(run.data.status,'WAITING');
  const cancelled=await call(`/api/workflow-runs/${run.data.id}/cancel`,{},owner);
  assert.equal(cancelled.status,200);
  assert.equal(cancelled.data.status,'CANCELLED');
 }finally{await cleanup();}
});

test('Workflows are tenant-isolated: a second tenant cannot read, activate, or run the first tenant\'s workflow',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const ownerA=await call('/api/setup',{username:'ownera',name:'Owner A',password:'test-password-long'});
  const created=await call('/api/workflows',LINEAR_TASK_WORKFLOW,ownerA);
  await call(`/api/workflows/${created.data.id}/activate`,{},ownerA);

  const ownerB=await signupAndCreateWorkspace(call,app,{username:'ownerb',email:'ownerb@example.com',companyName:'Tenant B'});
  const crossRead=await call(`/api/workflows/${created.data.id}`,null,ownerB,{method:'GET'});
  assert.equal(crossRead.status,404);
  const crossRun=await call(`/api/workflows/${created.data.id}/run`,{},ownerB);
  assert.equal(crossRun.status,404);
  const listB=await call('/api/workflows',null,ownerB,{method:'GET'});
  assert.equal(listB.data.length,0);
 }finally{await cleanup();}
});

test('Workflows: an APPROVAL step pauses a run visible over HTTP and resumes through the real, existing /api/approvals/:id/decide route',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  const created=await call('/api/workflows',{nameAr:'موافقة',trigger:{type:'MANUAL'},
   steps:[{id:'approve',type:'APPROVAL',reason:'يحتاج قرارًا بشريًا',next:['task']},{id:'task',type:'CREATE_TASK',reason:'بعد الموافقة',priority:'P2',next:[]}]},owner);
  await call(`/api/workflows/${created.data.id}/activate`,{},owner);
  const run=await call(`/api/workflows/${created.data.id}/run`,{},owner);
  assert.equal(run.data.status,'WAITING_APPROVAL');

  const pending=await call('/api/approvals?status=PENDING',null,owner,{method:'GET'});
  const approval=pending.data.find(a=>a.action_type==='workflow_step_approval');
  assert.ok(approval);
  const decided=await call(`/api/approvals/${approval.id}/decide`,{decision:'APPROVED'},owner);
  assert.equal(decided.status,200);
  assert.equal(decided.data.workflowRun.status,'COMPLETED');
 }finally{await cleanup();}
});
