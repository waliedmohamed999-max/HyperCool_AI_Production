import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installCRM,createLead,listLeads,getLead,updateLead,recordMessage,contactControl,createFollowups,approveFollowup,prepareFollowups,listFollowups,cancelFollowups,leadDetail} from '../src/crm.js';
import {installAuditLog} from '../src/audit.js';
const owner={id:'owner',name:'Owner',role:'owner'},operator={id:'operator',name:'Operator',role:'operator'};
const data=()=>({name:'Customer',customerType:'B2B',company:'Test Facility',sourceType:'INBOUND',phone:'+966500000001',email:'customer@example.test',city:'Khobar',productNeed:'Equipment',productUrl:'https://hyper-cool.com/offers'});
function fixture(){const store=openStore(':memory:');installCRM(store.db);installAuditLog(store.db);const lead=createLead(store,data(),operator);return {store,lead};}
function update(store,id,overrides={}){const lead=getLead(store.db,id);return updateLead(store,id,{...lead,stage:'QUOTE_SENT',reason:'Quotation recorded manually',expectedVersion:lead.version,...overrides},owner);}
function consent(store,id,channel='Email'){const lead=getLead(store.db,id);return contactControl(store,id,{expectedVersion:lead.version,action:'CONSENT',channel,confirmed:true,evidence:'Customer explicitly requested follow-up',obtainedAt:new Date().toISOString()},owner);}
const followupInput=()=>({requestKey:crypto.randomUUID(),sequence:'QUOTE',channel:'Email',startAt:new Date(Date.now()+3*86400000).toISOString(),evidence:'Quote reference Q-1'});
test('CRM deduplicates normalized contacts and requires a sourced dated B2B trigger',()=>{
 const {store}=fixture();try{
  assert.throws(()=>createLead(store,{...data(),email:'CUSTOMER@EXAMPLE.TEST',phone:''},operator),/سابق/);
  assert.throws(()=>createLead(store,{...data(),email:'other@example.test',phone:'+966 50 000 0001'},operator),/سابق/);
  assert.throws(()=>createLead(store,{...data(),email:'',phone:'',sourceType:'RESEARCH'},operator));
  const lead=createLead(store,{...data(),email:'',phone:'',sourceType:'RESEARCH',sourceUrl:'https://example.test/news',trigger:'New facility',triggerDate:'2020-01-01T00:00:00Z',fitScore:4,routeIn:'Procurement office',sourceChecked:true},operator);
  assert.equal(lead.research.fitScore,4);assert.equal(lead.consent.Email,null);assert.equal(listLeads(store.db).length,2);
 }finally{store.close();}
});
test('follow-up requires channel-specific consent and preserves maximum touches and cooldown',()=>{
 const {store,lead}=fixture();try{
  update(store,lead.id);
  assert.throws(()=>createFollowups(store,lead.id,followupInput(),operator),/NO_CONSENT/);
  consent(store,lead.id);
  assert.throws(()=>createFollowups(store,lead.id,{...followupInput(),channel:'WhatsApp'},operator),/NO_CONSENT/);
  assert.throws(()=>createFollowups(store,lead.id,{...followupInput(),startAt:new Date(Date.now()+1000).toISOString()},operator),/48/);
  const input=followupInput(),result=createFollowups(store,lead.id,input,operator);
  assert.equal(result.items.length,3);assert.equal(Date.parse(result.items[1].dueAt)-Date.parse(result.items[0].dueAt),48*3600000);
  assert.equal(createFollowups(store,lead.id,input,operator).replayed,true);
  assert.throws(()=>createFollowups(store,lead.id,followupInput(),operator),/نشطة/);
  assert.equal(listFollowups(store.db).length,3);
 }finally{store.close();}
});
test('new inbound message holds all approved follow-ups and replay does not repeat effects',()=>{
 const {store,lead}=fixture();try{
  update(store,lead.id);consent(store,lead.id);const {items}=createFollowups(store,lead.id,followupInput(),operator);
  for(const item of items)approveFollowup(store,item.id,owner);
  const due=Date.parse(items[0].dueAt)+1;
  assert.deepEqual(prepareFollowups(store,owner,due),{ready:1,held:0,sent:0});
  const event={eventKey:'incoming-1',text:'Can we discuss?',channel:'Email',intent:'quote'};
  recordMessage(store,lead.id,event,operator);
  assert.equal(getLead(store.db,lead.id).temperature,'HOT');assert.equal(getLead(store.db,lead.id).replyHold,true);
  assert.ok(listFollowups(store.db).every(item=>item.status==='HOLD'&&item.approval===null));
  const version=getLead(store.db,lead.id).version;assert.equal(recordMessage(store,lead.id,event,operator).replayed,true);assert.equal(getLead(store.db,lead.id).version,version);
  assert.throws(()=>recordMessage(store,lead.id,{...event,text:'different'},operator),/أخرى/);
  assert.throws(()=>createFollowups(store,lead.id,followupInput(),operator),/CUSTOMER_REPLIED/);
 }finally{store.close();}
});
test('opt-out clears both channels and operators cannot restore consent or remove holds',()=>{
 const {store,lead}=fixture();try{
  update(store,lead.id);consent(store,lead.id);consent(store,lead.id,'WhatsApp');createFollowups(store,lead.id,followupInput(),operator);
  recordMessage(store,lead.id,{eventKey:'stop-1',text:'STOP',channel:'WhatsApp',intent:'general'},operator);
  const current=getLead(store.db,lead.id);assert.equal(current.optOut,true);assert.deepEqual(current.consent,{Email:null,WhatsApp:null});
  assert.ok(listFollowups(store.db).every(item=>item.holdReason==='OPT_OUT'));
  assert.throws(()=>contactControl(store,lead.id,{expectedVersion:current.version,action:'RESOLVE_HOLD',evidence:'handled'},operator),/للمالك/);
  assert.throws(()=>contactControl(store,lead.id,{expectedVersion:current.version,action:'CONSENT',channel:'Email',confirmed:true,evidence:'old',obtainedAt:'2020-01-01T00:00:00Z'},owner),/بعد رفض/);
 }finally{store.close();}
});
test('high value and medical cases require human handling and closed deals cannot follow up',()=>{
 const {store,lead}=fixture();try{
  update(store,lead.id,{valueSAR:100001});let current=getLead(store.db,lead.id);assert.equal(current.humanHold,true);
  assert.throws(()=>contactControl(store,lead.id,{expectedVersion:current.version,action:'RESOLVE_HOLD',evidence:'handled'},owner),/فوق الحد/);
  update(store,lead.id,{valueSAR:5000});current=getLead(store.db,lead.id);contactControl(store,lead.id,{expectedVersion:current.version,action:'RESOLVE_HOLD',evidence:'Corrected estimate'},owner);
  recordMessage(store,lead.id,{eventKey:'medical-1',text:'Question',channel:'Phone',intent:'medical'},operator);
  assert.equal(leadDetail(store.db,lead.id).handoff.reason,'MEDICAL');
  current=getLead(store.db,lead.id);contactControl(store,lead.id,{expectedVersion:current.version,action:'RESOLVE_HOLD',evidence:'Specialist handled'},owner);consent(store,lead.id);update(store,lead.id,{stage:'WON'});
  assert.throws(()=>createFollowups(store,lead.id,followupInput(),operator),/DEAL_CLOSED/);
 }finally{store.close();}
});
test('stale writes, changed contexts and tampered approvals fail closed without leaking conversations into audit',()=>{
 const {store,lead}=fixture();try{
  update(store,lead.id);consent(store,lead.id);const {items}=createFollowups(store,lead.id,followupInput(),operator);approveFollowup(store,items[0].id,owner);
  const row=JSON.parse(store.db.prepare('SELECT json FROM crm_followups WHERE id=?').get(items[0].id).json);row.messageAr='Tampered';store.db.prepare('UPDATE crm_followups SET json=? WHERE id=?').run(JSON.stringify(row),row.id);
  assert.equal(prepareFollowups(store,owner,Date.parse(row.dueAt)+1).held,1);
  assert.throws(()=>updateLead(store,lead.id,{...getLead(store.db,lead.id),expectedVersion:1,reason:'stale'},owner),/تحديث/);
  recordMessage(store,lead.id,{eventKey:'pii-1',text:'Private message body 123',channel:'Email',intent:'general'},operator);
  assert.equal(JSON.stringify(store.read().audit).includes('Private message body'),false);
  cancelFollowups(store,lead.id,owner);assert.ok(listFollowups(store.db).every(item=>item.status==='HOLD'));
 }finally{store.close();}
});
