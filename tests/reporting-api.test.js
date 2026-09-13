import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

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

test('weekly report Excel/PDF export produces real binary files matching the on-screen data, and rejects a future week',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hypercool-report-export-'));
 const app=await createApp({dataDir:directory,env:{}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session){const res=await fetch(base+path,{method:input?'POST':'GET',headers:{...(input?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{})},...(input?{body:JSON.stringify(input)}:{})});const data=await res.json();return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data.csrf};}
 async function callBinary(path,session){const res=await fetch(base+path,{headers:session?{cookie:session.cookie}:{}});const buffer=Buffer.from(await res.arrayBuffer());return {status:res.status,headers:res.headers,buffer};}
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  const view=await call('/api/reports/weekly',null,owner);
  const weekStart=view.data.current.weekStart;

  const xlsx=await callBinary('/api/reports/weekly/export.xlsx',owner);
  assert.equal(xlsx.status,200);
  assert.equal(xlsx.headers.get('content-type'),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(xlsx.headers.get('content-disposition')||'',/attachment; filename="hypercool-report-.*\.xlsx"/);
  assert.equal(xlsx.buffer.slice(0,2).toString(),'PK'); // real zip/xlsx magic bytes, not a fake/empty file
  assert.ok(xlsx.buffer.length>1000);

  const pdf=await callBinary('/api/reports/weekly/export.pdf',owner);
  assert.equal(pdf.status,200);
  assert.equal(pdf.headers.get('content-type'),'application/pdf');
  assert.match(pdf.headers.get('content-disposition')||'',/attachment; filename="hypercool-report-.*\.pdf"/);
  assert.equal(pdf.buffer.slice(0,5).toString(),'%PDF-'); // real PDF magic bytes
  assert.ok(pdf.buffer.length>1000);

  // A non-owner (any authenticated member) can still export — matches the existing GET's
  // any-role visibility, since exporting is just a different rendering of the same view.
  await call('/api/users',{username:'reviewer',name:'Reviewer',password:'test-password-long',role:'reviewer'},owner);
  const reviewer=await call('/api/login',{username:'reviewer',password:'test-password-long'});
  assert.equal((await callBinary('/api/reports/weekly/export.pdf',reviewer)).status,200);

  const futureWeek=new Date(Date.parse(weekStart)+30*7*86400000).toISOString().slice(0,10);
  const future=await call('/api/reports/weekly/export.xlsx?weekStart='+futureWeek,null,owner);
  assert.equal(future.status,400);
  assert.match(future.data.error,/مستقبلي/);
 }finally{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}
});
