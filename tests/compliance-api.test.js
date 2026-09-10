import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

const modelResponse=value=>new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(value)}],usage:{input_tokens:5,output_tokens:10}}),{status:200,headers:{'content-type':'application/json'}});
const decision=()=>({status:'OK',action:'CHECK',rationale:'Checked against approved memory',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],payload:{classification:'PASS',issues:[],corrected_text_if_possible:null,evidence_sources:[],verified_fields:[],blocked_fields:[],human_review_required:true,reason:'Matches approved facts'}});

test('compliance endpoint is advisory, role-gated to owner/reviewer and never changes content status',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hypercool-compliance-'));
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model'};
 const app=await createApp({dataDir:directory,env,fetcher:async()=>modelResponse(decision())});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session){const res=await fetch(base+path,{method:input?'POST':'GET',headers:{...(input?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{})},...(input?{body:JSON.stringify(input)}:{})});const data=await res.json();return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data.csrf};}
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/users',{username:'operator',name:'Operator',password:'test-password-long',role:'operator'},owner);
  await call('/api/users',{username:'reviewer',name:'Reviewer',password:'test-password-long',role:'reviewer'},owner);
  const operator=await call('/api/login',{username:'operator',password:'test-password-long'});
  const reviewer=await call('/api/login',{username:'reviewer',password:'test-password-long'});
  const fields={title:'Draft',body:'Body text',platform:'X',date:'2035-01-01',url:'https://hyper-cool.com/offers'};
  const draft=(await call('/api/content',fields,operator)).data;
  assert.equal((await call(`/api/content/${draft.id}/compliance`,{requestKey:'a'.repeat(20)},operator)).status,403);
  const first=await call(`/api/content/${draft.id}/compliance`,{requestKey:'a'.repeat(20)},reviewer);
  assert.equal(first.status,200);
  assert.equal(first.data.status,'COMPLETED');
  assert.equal(first.data.decision.payload.classification,'PASS');
  const replay=await call(`/api/content/${draft.id}/compliance`,{requestKey:'a'.repeat(20)},reviewer);
  assert.equal(replay.data.replayed,true);
  const list=await call(`/api/content/${draft.id}/compliance`,null,owner);
  assert.equal(list.status,200);
  assert.equal(list.data.length,1);
  const state=(await call('/api/state',null,owner)).data;
  assert.equal(state.content[0].status,'DRAFT');
  assert.equal(state.audit[0].action,'AI_COMPLIANCE_CHECKED');
  assert.equal((await call(`/api/content/${draft.id}/review`,{evidence:'Checked',facts:true,claims:true,link:true},reviewer)).status,200);
  assert.equal((await call(`/api/content/${draft.id}/compliance`,{requestKey:'b'.repeat(20)},reviewer)).status,409);
 }finally{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}
});
