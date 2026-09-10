import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

test('API revisions revoke schedules, retain history and automation cannot impersonate an owner',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hypercool-planning-'));
 const token='t'.repeat(40),app=await createApp({dataDir:directory,env:{AUTOMATION_TOKEN:token}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,headers={}){const res=await fetch(base+path,{method:input?'POST':'GET',headers:{...(input?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},...(input?{body:JSON.stringify(input)}:{})});const data=await res.json();return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data.csrf};}
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/users',{username:'operator',name:'Operator',password:'test-password-long',role:'operator'},owner);
  const operator=await call('/api/login',{username:'operator',password:'test-password-long'});
  assert.equal((await call('/api/automation/status')).status,401);
  assert.equal((await call('/api/automation/status',null,null,{'x-hypercool-token':token})).status,200);
  assert.equal((await call('/api/users',null,null,{'x-hypercool-token':token})).status,401);
  assert.equal((await call('/api/automation/approve',{},null,{'x-hypercool-token':token})).status,404);
  assert.equal((await call('/api/calendar',{startDate:'2035-01-01'},operator)).status,201);
  const fields={title:'Draft',body:'Original',englishCopy:'Original English',platform:'X',date:'2035-01-01',url:'https://hyper-cool.com/offers'};
  const draft=(await call('/api/content',fields,operator)).data;
  await call(`/api/content/${draft.id}/review`,{evidence:'Checked',facts:true,claims:true,link:true},owner);
  assert.equal((await call(`/api/content/${draft.id}/approve`,{},owner)).status,200);
  const schedule={contentId:draft.id,scheduledAt:'2035-01-01T12:00:00+03:00'};
  assert.equal((await call('/api/schedule',schedule,operator)).status,403);
  assert.equal((await call('/api/schedule',schedule,owner)).status,201);
  assert.equal((await call(`/api/content/${draft.id}/revise`,{...fields,reason:'edit'},operator)).status,403);
  const revised=await call(`/api/content/${draft.id}/revise`,{...fields,body:'Edited',reason:'Correction'},owner);
  assert.equal(revised.status,200);assert.equal(revised.data.status,'DRAFT');assert.equal(revised.data.parentId,draft.id);
  const plan=(await call('/api/planning',null,owner)).data;
  assert.equal(plan.jobs[0].status,'CANCELLED');assert.equal(plan.slots.find(s=>s.platform==='X'&&s.date==='2035-01-01').contentId,null);
  assert.equal((await call(`/api/content/${revised.data.id}/approve`,{},owner)).status,409);
  const state=(await call('/api/state',null,owner)).data;
  assert.equal(state.content.find(item=>item.id===draft.id).body,'Original');
  assert.equal(state.content.find(item=>item.id===draft.id).status,'SUPERSEDED');
  assert.equal((await call(`/api/content/${revised.data.id}/reject`,{reason:'Needs work'},owner)).data.status,'REJECTED');
  const first=await call('/api/automation/daily-brief',{},null,{'x-hypercool-token':token});
  assert.equal(first.status,200);assert.equal(first.data.deliveryStatus,'LOCAL_ONLY');
  assert.equal((await call('/api/automation/daily-brief',{},null,{'x-hypercool-token':token})).data.replayed,true);
 }finally{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}
});
