import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.js';
import {initialState} from '../src/domain.js';
import {openStore} from '../src/store.js';
import {agentDefinitions,validateDecision,validateAgentDecision,buildAgentPrompt} from '../src/agents.js';

test('authenticated workflow enforces roles, CSRF, provenance and persistence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hypercool-test-'));
 const app=await createApp({dataDir:dir,env:{}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function request(path,input,session,extra={}){
  const response=await fetch(base+path,{method:input?'POST':'GET',headers:{...(input?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...extra},...(input?{body:JSON.stringify(input)}:{})});
  const data=await response.json();return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],csrf:data.csrf};
 }
 try {
  assert.equal((await request('/api/state')).status,401);
  assert.equal((await request('/api/auth')).data.needsSetup,true);
  const owner=await request('/api/setup',{username:'owner',name:'Owner',password:'a-long-test-password'});
  assert.equal(owner.status,200);
  assert.equal((await request('/api/setup',{username:'other',name:'Other',password:'a-long-test-password'})).status,409);
  assert.equal((await request('/api/users',{username:'bad',name:'Bad',password:'a-long-test-password',role:'operator'},owner,{'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await request('/api/users',{username:'operator',name:'Operator',password:'a-long-test-password',role:'operator'},owner)).status,201);
  assert.equal((await request('/api/users',{username:'reviewer',name:'Reviewer',password:'a-long-test-password',role:'reviewer'},owner)).status,201);
  const operator=await request('/api/login',{username:'operator',password:'a-long-test-password'});
  const reviewer=await request('/api/login',{username:'reviewer',password:'a-long-test-password'});
  assert.equal((await request('/api/memory',{key:'voice'},operator)).status,403);
  assert.equal((await request('/api/salla/sync',{},reviewer)).status,403);
  assert.equal((await request('/api/ai/draft',{},reviewer)).status,403);
  assert.equal((await request('/api/connections',null,owner)).data.anthropic.configured,false);
  assert.equal((await request('/api/memory',{key:'voice',kind:'brand_voice',value:'نبرة واضحة',source:'Brand guide',changeReason:'Initial',status:'APPROVED',expectedVersion:0},owner)).status,201);
  assert.equal((await request('/api/memory',null,operator)).data.length,1);
  assert.equal((await request('/api/users',null,operator)).status,403);
  const draft={title:'Test',body:'Test content',platform:'Instagram',date:'2026-09-10',url:'https://hyper-cool.com/offers'};
  assert.equal((await request('/api/content',draft,reviewer)).status,403);
  const created=await request('/api/content',draft,operator);
  assert.equal(created.status,201);
  const path='/api/content/'+created.data.id;
  assert.notEqual((await request(path+'/approve',{},owner)).status,200);
  const review={reviewer:'Forged name',evidence:'Verified store page',facts:true,claims:true,link:true};
  assert.equal((await request(path+'/review',review,operator)).status,403);
  const reviewed=await request(path+'/review',review,reviewer);
  assert.equal(reviewed.status,200);
  assert.equal(reviewed.data.review.reviewer,'Reviewer');
  assert.equal((await request(path+'/approve',{},reviewer)).status,403);
  assert.equal((await request(path+'/approve',{owner:'Forged'},owner)).data.approval.owner,'Owner');
  const state=(await request('/api/state',null,owner)).data;
  assert.equal(state.content[0].status,'APPROVED');
  assert.equal(state.audit[0].actorId,owner.data.user.id);
  assert.equal((await request('/api/state',null,owner,{Origin:'https://evil.test'})).status,403);
  assert.equal((await request('/api/logout',{},owner)).status,200);
  assert.equal((await request('/api/state',null,owner)).status,401);
 } finally {await new Promise(resolve=>app.server.close(resolve));app.store.close();}
 const reopened=openStore(join(dir,'hypercool.sqlite'));
 try{assert.equal(reopened.read().content[0].status,'APPROVED');assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,3);}finally{reopened.close();await rm(dir,{recursive:true,force:true});}
});

test('legacy migration runs once and transaction failure rolls back',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hypercool-migration-'));
 const legacy=initialState();legacy.content.push({id:'legacy',status:'APPROVED'});
 await writeFile(join(dir,'state.json'),JSON.stringify(legacy));
 const store=openStore(join(dir,'db.sqlite'),join(dir,'state.json'));
 try {
  assert.equal(store.read().content[0].legacyUnauthenticated,true);
  assert.throws(()=>store.mutate(state=>{state.content=[];throw new Error('rollback');}));
  assert.equal(store.read().content.length,1);
 } finally {store.close();}
 const reopened=openStore(join(dir,'db.sqlite'),join(dir,'state.json'));
 try {assert.equal(reopened.read().content.length,1);}finally{reopened.close();await rm(dir,{recursive:true,force:true});}
});

test('all source prompts load and malformed decisions fail closed',()=>{
 assert.equal(agentDefinitions.length,12);
 assert.equal(new Set(agentDefinitions.map(a=>a.id)).size,12);
 for(const agent of agentDefinitions)assert.match(agent.prompt,/SYSTEM/);
 const decision={status:'OK',action:'DRAFT',rationale:'Source provided',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],payload:{}};
 assert.equal(validateDecision(decision),decision);
 for(const value of [{...decision,status:'MADE_UP'},{...decision,extra:true},{...decision,status:'NEEDS_DATA'},{...decision,risk_level:'HIGH'},{...decision,verification:[{field:'price'}]}])assert.throws(()=>validateDecision(value));
 for(const agent of agentDefinitions) {
  assert.throws(()=>validateAgentDecision(agent.id,decision));
  assert.throws(()=>validateAgentDecision(agent.id,{...decision,payload:null}));
  assert.doesNotThrow(()=>validateAgentDecision(agent.id,{...decision,status:'NEEDS_DATA',missing_data:['source'],payload:null}));
  assert.match(buildAgentPrompt(agent.id),/RUNTIME CONTRACT ADAPTER/);
 }
});
