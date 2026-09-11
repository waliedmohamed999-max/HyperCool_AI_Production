import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installKnowledge,saveMemory} from '../src/knowledge.js';
import {installCompliance,createComplianceChecker,listComplianceChecks} from '../src/compliance.js';
import {createContent} from '../src/domain.js';
import {installContent,insertContent,getContent,writeContent} from '../src/content.js';
import {installAuditLog,listAuditLog} from '../src/audit.js';
import {resolveActiveTenantId} from '../src/tenancy.js';

const user={id:'reviewer-id',name:'Reviewer',role:'reviewer'};
const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model'};
const draft=(over={})=>createContent({title:'فكرة محتوى',body:'نص المسودة',platform:'Instagram',date:'2026-09-10',url:'https://hyper-cool.com/offers',...over});
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
const modelResponse=value=>response({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(value)}],usage:{input_tokens:5,output_tokens:15}});
const decision=(payload={})=>({status:'OK',action:'CHECK',rationale:'Checked against approved memory',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],payload:{classification:'PASS',issues:[],corrected_text_if_possible:null,evidence_sources:[],verified_fields:[],blocked_fields:[],human_review_required:true,reason:'Matches approved facts',...payload}});
function fixture(){const store=openStore(':memory:');installKnowledge(store.db);installCompliance(store.db);installContent(store.db);installAuditLog(store.db);return store;}
function seed(store,over={}){const item=draft(over);insertContent(store.db,item);return item;}

test('compliance check is advisory, requires DRAFT status and deduplicates by request key',async()=>{
 const store=fixture();let calls=0;
 try{
  const item=seed(store);
  const check=createComplianceChecker(store,env,async(url,options)=>{
   calls++;assert.equal(url,'https://api.anthropic.com/v1/messages');
   assert.equal(options.headers['x-api-key'],env.ANTHROPIC_API_KEY);
   assert.equal(options.body.includes('test-secret'),false);
   return modelResponse(decision());
  });
  const requestKey=crypto.randomUUID();
  const first=await check(item.id,{requestKey},user);
  assert.equal(first.status,'COMPLETED');assert.equal(first.decision.payload.classification,'PASS');
  const second=await check(item.id,{requestKey},user);
  assert.equal(second.replayed,true);assert.equal(calls,1);
  assert.equal(listComplianceChecks(store.db,item.id).length,1);
  assert.equal(getContent(store.db,item.id).status,'DRAFT');
  assert.equal(listAuditLog(store.db)[0].action,'AI_COMPLIANCE_CHECKED');
 }finally{store.close();}
});

test('reusing a request key for a different actor or a changed draft is rejected',async()=>{
 const store=fixture();
 try{
  const item=seed(store);
  const check=createComplianceChecker(store,env,async()=>modelResponse(decision()));
  const requestKey=crypto.randomUUID();
  await check(item.id,{requestKey},user);
  await assert.rejects(()=>check(item.id,{requestKey},{...user,id:'other-user'}),/مستخدم/);
  writeContent(store.db,{...item,body:'Different text entirely'});
  await assert.rejects(()=>check(item.id,{requestKey},user),/مستخدم/);
 }finally{store.close();}
});

test('compliance check is rejected once content leaves DRAFT and never mutates content',async()=>{
 const store=fixture();
 try{
  const item=seed(store);
  writeContent(store.db,{...item,status:'REVIEWED'});
  const check=createComplianceChecker(store,env,async()=>{throw new Error('must not call provider');});
  await assert.rejects(()=>check(item.id,{requestKey:crypto.randomUUID()},user),/للمسودات/);
 }finally{store.close();}
});

test('content changed mid-check fails without leaking a stale result',async()=>{
 const store=fixture();
 try{
  const item=seed(store);
  const check=createComplianceChecker(store,env,async()=>{
   writeContent(store.db,{...item,body:'Changed while the model was thinking'});
   return modelResponse(decision());
  });
  const run=await check(item.id,{requestKey:crypto.randomUUID()},user);
  assert.equal(run.status,'ERROR');assert.equal(run.errorCode,'CONTENT_CHANGED');
 }finally{store.close();}
});

test('a BLOCK classification must carry a BLOCKED envelope status or the run fails closed',async()=>{
 const store=fixture();
 try{
  const item=seed(store);
  const check=createComplianceChecker(store,env,async()=>modelResponse({...decision({classification:'BLOCK'}),status:'OK'}));
  const run=await check(item.id,{requestKey:crypto.randomUUID()},user);
  assert.equal(run.status,'ERROR');assert.equal(run.errorCode,'INVALID_MODEL_OUTPUT');
 }finally{store.close();}
});

test('missing Anthropic configuration prevents the provider call',async()=>{
 const store=fixture();
 try{
  const item=seed(store);
  const check=createComplianceChecker(store,{},async()=>{throw new Error('must not call');});
  await assert.rejects(()=>check(item.id,{requestKey:crypto.randomUUID()},user),/Anthropic/);
 }finally{store.close();}
});

test('an interrupted run is marked INTERRUPTED on restart and is not silently replayed',async()=>{
 const store=fixture();
 try{
  const item=seed(store);
  store.db.prepare('INSERT INTO compliance_runs (id,tenant_id,content_id,request_key,content_hash,actor_id,status,json) VALUES (?,?,?,?,?,?,?,?)').run('stuck',resolveActiveTenantId(store.db),item.id,'stuck-key','hash','actor','RUNNING','{}');
  createComplianceChecker(store,env,async()=>{throw new Error('must not call');});
  assert.equal(store.db.prepare('SELECT status FROM compliance_runs WHERE id=?').get('stuck').status,'INTERRUPTED');
 }finally{store.close();}
});
