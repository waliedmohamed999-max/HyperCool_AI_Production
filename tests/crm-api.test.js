import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.js';
import {openStore} from '../src/store.js';
import {getLead} from '../src/crm.js';

test('CRM API restricts customer data and approvals, persists records and has no sending endpoint',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hypercool-crm-'));const app=await createApp({dataDir:directory,env:{}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session){const response=await fetch(base+path,{method:input?'POST':'GET',headers:{...(input?{'content-type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{})},...(input?{body:JSON.stringify(input)}:{})});const data=await response.json();return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],csrf:data.csrf};}
 let leadId;
 try{
  assert.equal((await call('/api/crm')).status,401);
  const owner=await call('/api/setup',{name:'Owner',username:'owner',password:'test-password-long'});
  for(const role of ['operator','reviewer'])await call('/api/users',{name:role,username:role,password:'test-password-long',role},owner);
  const operator=await call('/api/login',{username:'operator',password:'test-password-long'}),reviewer=await call('/api/login',{username:'reviewer',password:'test-password-long'});
  assert.equal((await call('/api/crm',null,reviewer)).status,403);
  let lead=(await call('/api/crm/leads',{name:'Private Customer',customerType:'B2C',sourceType:'INBOUND',email:'private@example.test',productUrl:'https://hyper-cool.com/offers'},operator)).data;leadId=lead.id;
  assert.ok(leadId);
  assert.equal((await call('/api/crm/leads/'+leadId,null,reviewer)).status,403);
  const contact={expectedVersion:lead.version,action:'CONSENT',channel:'Email',evidence:'Customer request',confirmed:true,obtainedAt:new Date().toISOString()};
  assert.equal((await call(`/api/crm/leads/${leadId}/contact`,contact,operator)).status,403);
  lead=(await call(`/api/crm/leads/${leadId}/contact`,contact,owner)).data;
  lead=(await call(`/api/crm/leads/${leadId}/update`,{...lead,expectedVersion:lead.version,stage:'QUOTE_SENT',temperature:'HOT',reason:'Quote recorded',assignedTo:owner.data.user.id},operator)).data;
  const followups=await call(`/api/crm/leads/${leadId}/followups`,{requestKey:crypto.randomUUID(),sequence:'QUOTE',channel:'Email',startAt:new Date(Date.now()+3*86400000).toISOString(),evidence:'Quote Q1'},operator);
  assert.equal(followups.status,201);const id=followups.data.items[0].id;
  assert.equal((await call(`/api/crm/followups/${id}/approve`,{},operator)).status,403);
  assert.equal((await call(`/api/crm/followups/${id}/approve`,{},owner)).status,200);
  assert.equal((await call('/api/crm/send',{},owner)).status,404);
  assert.equal((await call('/api/crm/followups/prepare',{},owner)).data.sent,0);
  assert.equal((await call(`/api/crm/leads/${leadId}/contact`,{expectedVersion:lead.version,action:'OPT_OUT',evidence:'Customer declined'},operator)).status,200);
  const result=(await call('/api/crm/leads/'+leadId,null,owner)).data;
  assert.equal(result.lead.optOut,true);assert.ok(result.followups.every(f=>f.status==='HOLD'));
  assert.equal(JSON.stringify((await call('/api/state',null,reviewer)).data).includes('Private Customer'),false);
 }finally{await new Promise(resolve=>app.server.close(resolve));app.store.close();}
 const reopened=openStore(join(directory,'hypercool.sqlite'));try{assert.equal(getLead(reopened.db,leadId).optOut,true);}finally{reopened.close();await rm(directory,{recursive:true,force:true});}
});
