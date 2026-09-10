import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.js';

test('weekly report is readable by any authenticated role, saved only by the owner and idempotent per week',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hypercool-reports-'));
 const app=await createApp({dataDir:directory,env:{}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session){const res=await fetch(base+path,{method:input?'POST':'GET',headers:{...(input?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{})},...(input?{body:JSON.stringify(input)}:{})});const data=await res.json();return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data.csrf};}
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/users',{username:'operator',name:'Operator',password:'test-password-long',role:'operator'},owner);
  const operator=await call('/api/login',{username:'operator',password:'test-password-long'});
  const view=await call('/api/reports/weekly',null,operator);
  assert.equal(view.status,200);
  assert.equal(view.data.current.deliveryStatus,'LOCAL_ONLY');
  assert.equal(view.data.saved.length,0);
  assert.equal((await call('/api/reports/weekly',{weekStart:'2026-09-06'},operator)).status,403);
  const saved=await call('/api/reports/weekly',{weekStart:'2026-09-06'},owner);
  assert.equal(saved.status,201);
  const replay=await call('/api/reports/weekly',{weekStart:'2026-09-06'},owner);
  assert.equal(replay.data.replayed,true);
  const after=await call('/api/reports/weekly',null,owner);
  assert.equal(after.data.saved.length,1);
  const state=(await call('/api/state',null,owner)).data;
  assert.equal(state.audit[0].action,'WEEKLY_REPORT_CREATED');
 }finally{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}
});
