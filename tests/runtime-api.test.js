import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.js';

const decision=()=>({status:'OK',action:'REPLY',rationale:'ok',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],
 payload:{intent:'price',customer_type:'B2C',qualification:{city:null,product_need:null,quantity:null,timeline:null,budget_band:null},recommended_product_id:null,reply_ar:'رد',reply_en:'reply',next_best_action:'x',lead_temperature:'COLD',crm_updates:{},missing_fields:[],handoff_reason:null}});
const modelResponse=value=>new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(value)}],usage:{input_tokens:3,output_tokens:3}}),{status:200,headers:{'content-type':'application/json'}});

test('agent runtime is exposed over HTTP with correct role gating, and the seeded registry is visible on /api/agents',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hypercool-runtime-'));
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model'};
 const app=await createApp({dataDir:directory,env,fetcher:async()=>modelResponse(decision())});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session){const res=await fetch(base+path,{method:input?'POST':'GET',headers:{...(input?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{})},...(input?{body:JSON.stringify(input)}:{})});const data=await res.json();return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data.csrf};}
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  await call('/api/users',{username:'reviewer',name:'Reviewer',password:'test-password-long',role:'reviewer'},owner);
  const reviewer=await call('/api/login',{username:'reviewer',password:'test-password-long'});

  const agents=await call('/api/agents',null,owner);
  assert.equal(agents.data.length,12);
  const sales=agents.data.find(a=>a.id==='sales');
  assert.equal(sales.runtimeStatus,'WAITING_INTEGRATION');
  assert.match(sales.runtimeLabel,/واتساب/);
  const compliance=agents.data.find(a=>a.id==='compliance');
  assert.equal(compliance.runtimeStatus,'ONLINE');

  assert.equal((await call('/api/agents/sales/run',{scenario:'كم سعر جهاز الكرايو؟'},reviewer)).status,403);
  const run=await call('/api/agents/sales/run',{scenario:'كم سعر جهاز الكرايو؟'},owner);
  assert.equal(run.status,200);
  assert.equal(run.data.status,'COMPLETED');
  assert.equal(run.data.output.payload.reply_ar,'رد');

  const runs=await call('/api/agents/sales/runs',null,reviewer);
  assert.equal(runs.data.length,1);
  const detail=await call('/api/agents/runs/'+run.data.id,null,reviewer);
  assert.equal(detail.data.id,run.data.id);
  assert.ok(Array.isArray(detail.data.toolCalls));

  const health=await call('/api/agents/sales/health',null,reviewer);
  assert.equal(health.data.status,'NOT_ELIGIBLE');

  assert.equal((await call('/api/agents/sales/enabled',{enabled:false},reviewer)).status,403);
  assert.equal((await call('/api/agents/sales/enabled',{enabled:false},owner)).status,200);
  const disabledRun=await call('/api/agents/sales/run',{scenario:'x'},owner);
  assert.equal(disabledRun.data.status,'CANCELLED');

  const escalations=await call('/api/escalations',null,reviewer);
  assert.equal(escalations.status,200);
  const approvals=await call('/api/approvals',null,reviewer);
  assert.equal(approvals.status,200);
 }finally{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}
});

test('CRM lead creation and inbound messages both trigger the sales agent automatically, with zero human clicks',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hypercool-e2e-'));
 const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model'};
 const app=await createApp({dataDir:directory,env,fetcher:async()=>modelResponse(decision())});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session){const res=await fetch(base+path,{method:input?'POST':'GET',headers:{...(input?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{})},...(input?{body:JSON.stringify(input)}:{})});const data=await res.json();return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data.csrf};}
 try{
  const owner=await call('/api/setup',{username:'owner',name:'Owner',password:'test-password-long'});
  // creating the lead alone (no message yet) must already trigger an automatic triage run
  const lead=await call('/api/crm/leads',{name:'Test Customer',customerType:'B2C',sourceType:'INBOUND',phone:'+966501234567'},owner);
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal((await call('/api/agents/sales/runs',null,owner)).data.length,1);
  const recorded=await call(`/api/crm/leads/${lead.data.id}/messages`,{channel:'WhatsApp',text:'السلام عليكم عندكم جهاز كرايو وكم سعره؟',intent:'general',eventKey:'evt-1'},owner);
  assert.equal(recorded.status,201);
  await new Promise(resolve=>setTimeout(resolve,100));
  const runs=await call('/api/agents/sales/runs',null,owner);
  assert.equal(runs.data.length,2);
  assert.ok(runs.data.every(run=>run.trigger_type==='EVENT'));

  // the pause switch must stop this automatic behaviour without touching manual test runs
  assert.equal((await call('/api/frost/pause',{reason:'maintenance'},owner)).data.paused,true);
  await call(`/api/crm/leads/${lead.data.id}/messages`,{channel:'WhatsApp',text:'رسالة ثانية',intent:'general',eventKey:'evt-2'},owner);
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal((await call('/api/agents/sales/runs',null,owner)).data.length,2); // unchanged while paused
  const manual=await call('/api/agents/sales/run',{scenario:'test while paused'},owner);
  assert.equal(manual.data.status,'COMPLETED'); // manual/test runs are never gated by pause
  assert.equal((await call('/api/frost/resume',{},owner)).data.paused,false);
 }finally{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}
});
