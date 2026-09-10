import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.js';

test('agent autonomy is owner-only to change, visible to everyone, and reflected in /api/agents',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hypercool-autonomy-'));
 const app=await createApp({dataDir:directory,env:{}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session){const res=await fetch(base+path,{method:input?'POST':'GET',headers:{...(input?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{})},...(input?{body:JSON.stringify(input)}:{})});const data=await res.json();return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data.csrf};}
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/users',{username:'operator',name:'Operator',password:'test-password-long',role:'operator'},owner);
  const operator=await call('/api/login',{username:'operator',password:'test-password-long'});
  const before=await call('/api/agents',null,operator);
  assert.equal(before.data.find(a=>a.id==='copy').level,'L0');
  assert.equal((await call('/api/agents/copy/autonomy',{level:'L1',reason:'clean run',expectedVersion:0},operator)).status,403);
  const promoted=await call('/api/agents/copy/autonomy',{level:'L1',reason:'clean run',expectedVersion:0},owner);
  assert.equal(promoted.status,201);
  assert.equal(promoted.data.direction,'PROMOTED');
  const after=await call('/api/agents',null,operator);
  assert.equal(after.data.find(a=>a.id==='copy').level,'L1');
  assert.equal(after.data.find(a=>a.id==='strategy').level,'L0');
  const log=await call('/api/agents/copy/autonomy',null,operator);
  assert.equal(log.status,200);
  assert.equal(log.data.length,1);
  assert.equal((await call('/api/agents/copy/autonomy',{level:'L2',reason:'stale',expectedVersion:0},owner)).status,409);
  assert.equal((await call('/api/agents/does-not-exist/autonomy',{level:'L1',reason:'x',expectedVersion:0},owner)).status,404);
  const state=(await call('/api/state',null,owner)).data;
  assert.equal(state.audit[0].action,'AGENT_PROMOTED');
 }finally{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}
});
