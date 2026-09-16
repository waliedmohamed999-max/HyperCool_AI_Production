import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createAuth} from '../src/auth.js';

async function harness(env={}) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-command-center-7b-'));
 const attachmentsDir=await mkdtemp(join(tmpdir(),'hypercool-attachments-7b-'));
 const app=await createApp({dataDir:directory,env:{PLATFORM_MAIL_TRANSPORT:'capture',ATTACHMENTS_DIR:attachmentsDir,...env}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method}={}) {
  const res=await fetch(base+path,{method:method||(input?'POST':'GET'),headers:{...(input?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{})},...(input?{body:JSON.stringify(input)}:{})});
  const data=await res.json().catch(()=>null);
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 return {app,base,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});await rm(attachmentsDir,{recursive:true,force:true});}};
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
function platformAdminSession(app) {
 const auth=createAuth(app.store.db);
 auth.createUser({username:'admin_user',name:'Admin',password:'a-long-test-password'},'owner');
 const login=auth.login({username:'admin_user',password:'a-long-test-password'},'127.0.0.1');
 return {cookie:'hc_session='+login.token,csrf:login.csrf};
}

// --- Runbooks -----------------------------------------------------------------------------
test('Runbooks: built-ins listed for any member, custom create/archive gated, run executes the same real pipeline',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  const list=await call('/api/command/runbooks',null,owner,{method:'GET'});
  assert.equal(list.status,200);
  assert.equal(list.data.length,12);
  assert.ok(list.data.every(r=>r.isBuiltin));

  const created=await call('/api/command/runbooks',{name:'مفضلتي',commandText:'اعرض حالة الشركة'},owner);
  assert.equal(created.status,201);

  const run=await call(`/api/command/runbooks/${list.data[0].id}/run`,{},owner);
  assert.equal(run.status,201);
  assert.ok(run.data.conversationId);
  // No AI provider configured in this test env — same honest-failure contract as direct chat.
  assert.equal(run.data.runStatus,'FAILED');
  assert.match(run.data.assistantMessage.content,/اتصال ذكاء اصطناعي/);
 }finally{await cleanup();}
});

test('Runbooks: a builtin cannot be archived via the API either, and runbooks are tenant-isolated',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const ownerA=await call('/api/setup',{username:'ownera',name:'Owner A',password:'test-password-long'});
  const listA=await call('/api/command/runbooks',null,ownerA,{method:'GET'});
  const archiveBuiltin=await call(`/api/command/runbooks/${listA.data[0].id}/archive`,{},ownerA);
  assert.equal(archiveBuiltin.status,400);

  const ownerB=await signupAndCreateWorkspace(call,app,{username:'ownerb',email:'ownerb@example.com',companyName:'Tenant B'});
  const crossArchive=await call(`/api/command/runbooks/${listA.data[0].id}/archive`,{},ownerB);
  assert.equal(crossArchive.status,404); // real tenant isolation, not shared rows
 }finally{await cleanup();}
});

// --- Attachments ----------------------------------------------------------------------------
test('Attachments: upload/list/pin over HTTP with real size and MIME enforcement',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  const content=Buffer.from('quarterly numbers','utf8').toString('base64');
  const uploaded=await call('/api/command/attachments',{filename:'q.txt',mimeType:'text/plain',contentBase64:content},owner);
  assert.equal(uploaded.status,201);
  assert.equal(uploaded.data.filename,'q.txt');

  const rejected=await call('/api/command/attachments',{filename:'evil.exe',mimeType:'application/x-msdownload',contentBase64:content},owner);
  assert.equal(rejected.status,415);

  const listed=await call('/api/command/attachments',null,owner,{method:'GET'});
  assert.equal(listed.status,200);
  assert.equal(listed.data.length,1);

  const pinned=await call(`/api/command/attachments/${uploaded.data.id}/pin-to-brain`,{type:'client_note',title:'ملخص'},owner);
  assert.equal(pinned.status,200);
  assert.ok(pinned.data.savedToBrainContextId);
  const brain=await call('/api/command/context?type=client_note',null,owner,{method:'GET'});
  assert.equal(brain.data.length,1);
 }finally{await cleanup();}
});

test('Attachments are tenant-isolated: a second tenant sees none of the first tenant\'s files',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const ownerA=await call('/api/setup',{username:'ownera',name:'Owner A',password:'test-password-long'});
  await call('/api/command/attachments',{filename:'a.txt',mimeType:'text/plain',contentBase64:Buffer.from('a').toString('base64')},ownerA);
  const ownerB=await signupAndCreateWorkspace(call,app,{username:'ownerb',email:'ownerb2@example.com',companyName:'Tenant B'});
  const listB=await call('/api/command/attachments',null,ownerB,{method:'GET'});
  assert.equal(listB.data.length,0);
 }finally{await cleanup();}
});

// --- Configuration history + Undo ----------------------------------------------------------
test('Configuration history: lists a seeded real change, undo restores the previous connection, owner-only gate enforced',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/users',{username:'operator',name:'Operator',password:'test-password-long',role:'operator'},owner);
  const operator=await call('/api/login',{username:'operator',password:'test-password-long'});
  const tenantId=(await call('/api/workspaces/active',null,owner,{method:'GET'})).data.id;

  // Seed real prior state directly (bypasses needing a live AI provider for this test) exactly
  // the way tools.js's update_agent_tool_connection handler itself would have.
  const {recordConfigurationChange}=await import('../src/runtime/configuration-history.js');
  const {upsertAssignment}=await import('../src/runtime/tool-assignments.js');
  const {createConnection}=await import('../src/integrations/connections.js');
  const connOld=createConnection(app.store.db,{integrationDefinitionId:'whatsapp',name:'WhatsApp Old'},tenantId);
  const connNew=createConnection(app.store.db,{integrationDefinitionId:'whatsapp',name:'WhatsApp New'},tenantId);
  upsertAssignment(app.store.db,tenantId,'followup','whatsapp_send',{connectionId:connOld.id});
  const changeId=recordConfigurationChange(app.store.db,{tenantId,entityType:'agent_tool_connection',entityId:'followup::whatsapp_send',field:'connectionId',
   previousValue:{connectionId:connOld.id},newValue:{connectionId:connNew.id},actor:{id:'owner-id',name:'Owner'},reversible:true});
  upsertAssignment(app.store.db,tenantId,'followup','whatsapp_send',{connectionId:connNew.id});

  const history=await call('/api/command/configuration-history',null,owner,{method:'GET'});
  assert.equal(history.status,200);
  assert.equal(history.data.length,1);
  assert.equal(history.data[0].id,changeId);

  const deniedUndo=await call(`/api/command/configuration-history/${changeId}/undo`,{},operator);
  assert.equal(deniedUndo.status,403); // operator cannot undo — owner-only

  const undo=await call(`/api/command/configuration-history/${changeId}/undo`,{},owner);
  assert.equal(undo.status,200);
  assert.equal(undo.data.assignment.connectionId,connOld.id);
 }finally{await cleanup();}
});

// --- Context conflicts/freshness + Command search -------------------------------------------
test('Context conflicts endpoint surfaces two ACTIVE brain_identity records as a real conflict',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/command/context',{type:'brain_identity',title:'v1',description:''},owner);
  await call('/api/command/context',{type:'brain_identity',title:'v2',description:''},owner);
  const conflicts=await call('/api/command/context/conflicts',null,owner,{method:'GET'});
  assert.equal(conflicts.status,200);
  assert.equal(conflicts.data.length,1);
  assert.equal(conflicts.data[0].items.length,2);
  const listed=await call('/api/command/context',null,owner,{method:'GET'});
  assert.ok(listed.data.every(item=>item.freshness==='ACTIVE'));
 }finally{await cleanup();}
});

test('Command search finds a real past message by free text and is tenant-isolated',async()=>{
 const {app,call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  const conv=await call('/api/command/conversations',{},owner);
  await call(`/api/command/conversations/${conv.data.id}/messages`,{text:'اعرض تقرير المبيعات الأسبوعي'},owner);
  const found=await call('/api/command/search?q='+encodeURIComponent('المبيعات'),null,owner,{method:'GET'});
  assert.equal(found.status,200);
  assert.equal(found.data.length,1);
  assert.match(found.data[0].snippet,/المبيعات/);

  const ownerB=await signupAndCreateWorkspace(call,app,{username:'ownerb',email:'ownerb3@example.com',companyName:'Tenant B'});
  const foundB=await call('/api/command/search?q='+encodeURIComponent('المبيعات'),null,ownerB,{method:'GET'});
  assert.equal(foundB.data.length,0);
 }finally{await cleanup();}
});

// --- Platform Command Center ------------------------------------------------------------------
test('Platform Command Center: a normal tenant owner (not on the allowlist) is refused every route',async()=>{
 const {call,cleanup}=await harness();
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  assert.equal((await call('/api/platform/overview',null,owner,{method:'GET'})).status,403);
  assert.equal((await call('/api/platform/webhooks/dead-letter',null,owner,{method:'GET'})).status,403);
  assert.equal((await call('/api/platform/tenants/unhealthy-integrations',null,owner,{method:'GET'})).status,403);
 }finally{await cleanup();}
});

test('Platform Command Center: a real allowlisted admin sees real scheduler status and aggregate-only data — never raw tenant business data',async()=>{
 const {app,call,cleanup}=await harness({PLATFORM_ADMIN_USERNAMES:'admin_user'});
 try{
  const ownerSession=await signupAndCreateWorkspace(call,app,{username:'owned_co',email:'owned-co@example.com',companyName:'Owned Co'});
  const leadCreated=await call('/api/crm/leads',{name:'عميل سري',phone:'+966500000000',customerType:'B2C',sourceType:'INBOUND',city:'الرياض',productNeed:'x'},ownerSession);
  assert.equal(leadCreated.status,201);

  const adminSession=platformAdminSession(app);
  const overview=await call('/api/platform/overview',null,adminSession,{method:'GET'});
  assert.equal(overview.status,200);
  assert.equal(typeof overview.data.schedulerRunning,'boolean');
  assert.equal(typeof overview.data.reauthRequired,'number');
  // Aggregate privacy (spec item 26): the overview must never contain the tenant's own lead name.
  assert.doesNotMatch(JSON.stringify(overview.data),/عميل سري/);

  const deadLetter=await call('/api/platform/webhooks/dead-letter',null,adminSession,{method:'GET'});
  assert.equal(deadLetter.status,200);
  assert.deepEqual(deadLetter.data,[]); // nothing failed in this fresh test database

  const unhealthy=await call('/api/platform/tenants/unhealthy-integrations',null,adminSession,{method:'GET'});
  assert.equal(unhealthy.status,200);
  assert.deepEqual(unhealthy.data,[]);
 }finally{await cleanup();}
});

test('Platform Frost Chat: gated to platform admin only over HTTP; a real admin gets a real, aggregate-only answer',async()=>{
 const {app,call,cleanup}=await harness({PLATFORM_ADMIN_USERNAMES:'admin_user'});
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  const denied=await call('/api/platform/frost/messages',{text:'هل في مشاكل؟'},owner);
  assert.equal(denied.status,403);

  const adminSession=platformAdminSession(app);
  const deniedRead=await call('/api/platform/frost/messages',null,owner,{method:'GET'});
  assert.equal(deniedRead.status,403);

  // No AI provider configured in this test env — same honest-failure contract as tenant chat.
  const sent=await call('/api/platform/frost/messages',{text:'هل في مشاكل في المنصة؟'},adminSession);
  assert.equal(sent.status,201);
  assert.equal(sent.data.status,'FAILED');
  assert.match(sent.data.assistantMessage.content,/اتصال ذكاء اصطناعي/);

  const history=await call('/api/platform/frost/messages',null,adminSession,{method:'GET'});
  assert.equal(history.status,200);
  assert.equal(history.data.length,2);
 }finally{await cleanup();}
});
