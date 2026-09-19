import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installCRM,createLead,getLead} from '../src/crm.js';
import {installWhatsAppTemplates} from '../src/runtime/whatsapp.js';
import {installAuditLog,listAuditLog} from '../src/audit.js';
import {resolveCampaignAudience,sendWhatsAppCampaign,CAMPAIGN_AUDIENCE_CAP} from '../src/runtime/whatsapp.js';

const owner={id:'owner-1',name:'Owner',role:'owner'};

function fixture(){
 const store=openStore(':memory:');
 installCRM(store.db);installWhatsAppTemplates(store.db);installAuditLog(store.db);
 return store;
}
function jsonResponse(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}
function patchLead(db,id,path,value){
 db.prepare(`UPDATE crm_leads SET json=json_set(json,'$.${path}',?) WHERE id=?`).run(typeof value==='boolean'?(value?1:0):value,id);
}
function makeLead(store,phone){
 const lead=createLead(store,{name:'عميل اختبار',customerType:'B2C',sourceType:'INBOUND',phone},owner);
 // json_set with a JS boolean stores 0/1 (SQLite has no boolean type) — force real JSON
 // true/false via the 'json(?)' cast so getLead()'s JSON.parse round-trips a real boolean,
 // matching every other boolean field already written by the real crm.js mutators. Also seed
 // a recent lastInboundAt so this lead is within WhatsApp's real 24h customer-service window
 // (see runtime/whatsapp.js's withinCustomerServiceWindow) and free-text sends are allowed.
 store.db.prepare(`UPDATE crm_leads SET json=json_set(json,'$.optOut',json('false'),'$.humanHold',json('false'),'$.lastInboundAt',?) WHERE id=?`).run(new Date().toISOString(),lead.id);
 return lead;
}
function setBool(db,id,path,value){db.prepare(`UPDATE crm_leads SET json=json_set(json,'$.${path}',json(?)) WHERE id=?`).run(value?'true':'false',id);}

const noNetwork=()=>{throw new Error('must not call network');};

// --- resolveCampaignAudience --------------------------------------------------------------

test('resolveCampaignAudience: rejects both leadIds and stageFilter, and neither',()=>{
 const store=fixture();try{
  assert.equal(resolveCampaignAudience(store.db,null,{leadIds:['a'],stageFilter:'NEW'}).error,'AUDIENCE_SELECTION_AMBIGUOUS');
  assert.equal(resolveCampaignAudience(store.db,null,{}).error,'AUDIENCE_SELECTION_REQUIRED');
 }finally{store.close();}
});

test('resolveCampaignAudience: leadIds over the cap is blocked, never truncated',()=>{
 const store=fixture();try{
  const tooMany=Array.from({length:CAMPAIGN_AUDIENCE_CAP+1},(_,i)=>'lead-'+i);
  const result=resolveCampaignAudience(store.db,null,{leadIds:tooMany});
  assert.equal(result.error,'AUDIENCE_TOO_LARGE');
  assert.equal(result.resolvedCount,CAMPAIGN_AUDIENCE_CAP+1);
  assert.equal(result.cap,CAMPAIGN_AUDIENCE_CAP);
 }finally{store.close();}
});

test('resolveCampaignAudience: a valid leadIds array passes through unchanged',()=>{
 const store=fixture();try{
  const result=resolveCampaignAudience(store.db,null,{leadIds:['a','b']});
  assert.deepEqual(result.leadIds,['a','b']);
 }finally{store.close();}
});

test('resolveCampaignAudience: stageFilter resolves real, tenant-scoped, consented leads only',()=>{
 const store=fixture();try{
  const eligible=createLead(store,{name:'مؤهل',customerType:'B2C',sourceType:'INBOUND',phone:'+966500000001'},owner);
  setBool(store.db,eligible.id,'consent.WhatsApp',true);
  const noPhone=createLead(store,{name:'بدون هاتف',customerType:'B2C',sourceType:'INBOUND'},owner);
  setBool(store.db,noPhone.id,'consent.WhatsApp',true);
  const noConsent=createLead(store,{name:'بدون موافقة',customerType:'B2C',sourceType:'INBOUND',phone:'+966500000002'},owner);
  const result=resolveCampaignAudience(store.db,null,{stageFilter:'NEW'});
  assert.deepEqual(result.leadIds,[eligible.id]);
 }finally{store.close();}
});

test('resolveCampaignAudience: an invalid stage name is rejected',()=>{
 const store=fixture();try{
  assert.equal(resolveCampaignAudience(store.db,null,{stageFilter:'NOT_A_STAGE'}).error,'INVALID_STAGE');
 }finally{store.close();}
});

// --- sendWhatsAppCampaign: dry-run never sends, classifies correctly ----------------------

test('sendWhatsAppCampaign dry-run: never calls the network and never writes crm_messages, classifies eligible vs blocked correctly',async()=>{
 const store=fixture();try{
  const env={WHATSAPP_ACCESS_TOKEN:'wa-token',WHATSAPP_PHONE_NUMBER_ID:'12345'};
  const eligible=makeLead(store,'+966500000010');
  const optedOut=makeLead(store,'+966500000011');setBool(store.db,optedOut.id,'optOut',true);
  const onHold=makeLead(store,'+966500000012');setBool(store.db,onHold.id,'humanHold',true);
  const noPhone=createLead(store,{name:'بدون هاتف',customerType:'B2C',sourceType:'INBOUND'},owner);

  const result=await sendWhatsAppCampaign({store,env,fetcher:noNetwork},
   {leadIds:[eligible.id,optedOut.id,onHold.id,noPhone.id],text:'مرحبًا',dryRun:true},owner,null);

  assert.equal(result.status,'PREVIEW');
  assert.equal(result.totalResolved,4);
  assert.deepEqual(result.eligible,[{leadId:eligible.id}]);
  assert.deepEqual(new Set(result.blocked.map(b=>b.leadId)),new Set([optedOut.id,onHold.id,noPhone.id]));
  assert.equal(result.blocked.find(b=>b.leadId===optedOut.id).reason,'OPT_OUT');
  assert.equal(result.blocked.find(b=>b.leadId===onHold.id).reason,'HUMAN_HOLD');
  assert.equal(result.blocked.find(b=>b.leadId===noPhone.id).reason,'NO_PHONE');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM crm_messages').get().n,0);
 }finally{store.close();}
});

test('sendWhatsAppCampaign dry-run: an audience over the cap is blocked before any lookup',async()=>{
 const store=fixture();try{
  const tooMany=Array.from({length:CAMPAIGN_AUDIENCE_CAP+1},(_,i)=>'lead-'+i);
  const result=await sendWhatsAppCampaign({store,env:{},fetcher:noNetwork},{leadIds:tooMany,text:'hi',dryRun:true},owner,null);
  assert.equal(result.status,'BLOCKED');assert.equal(result.reason,'AUDIENCE_TOO_LARGE');
 }finally{store.close();}
});

// --- sendWhatsAppCampaign: real send — mixed outcomes, honest bookkeeping -----------------

test('sendWhatsAppCampaign real send: sends to eligible recipients, skips ineligible ones, records a message + audit row per real send only',async()=>{
 const store=fixture();try{
  const env={WHATSAPP_ACCESS_TOKEN:'wa-token',WHATSAPP_PHONE_NUMBER_ID:'12345'};
  const willSend=makeLead(store,'+966500000020');
  const optedOut=makeLead(store,'+966500000021');setBool(store.db,optedOut.id,'optOut',true);
  let sends=0;
  const fetcher=async()=>{sends++;return jsonResponse({messages:[{id:'wamid.'+sends}]});};

  const result=await sendWhatsAppCampaign({store,env,fetcher},
   {leadIds:[willSend.id,optedOut.id],text:'عرض خاص',campaignId:'camp-1'},owner,null);

  assert.equal(result.status,'OK');
  assert.equal(result.sent,1);assert.equal(result.skipped,1);assert.equal(result.failed,0);
  assert.equal(sends,1); // the opted-out lead never reaches the network
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM crm_messages').get().n,1);
  const auditRows=listAuditLog(store.db).filter(a=>a.itemId===willSend.id&&a.action==='WHATSAPP_CAMPAIGN_MESSAGE_SENT');
  assert.equal(auditRows.length,1);
 }finally{store.close();}
});

test('sendWhatsAppCampaign real send: a provider failure is recorded as FAILED with its error class, never as a fake success',async()=>{
 const store=fixture();try{
  const env={WHATSAPP_ACCESS_TOKEN:'wa-token',WHATSAPP_PHONE_NUMBER_ID:'12345'};
  const lead=makeLead(store,'+966500000030');
  const result=await sendWhatsAppCampaign({store,env,fetcher:async()=>jsonResponse({error:{code:190,message:'Invalid OAuth'}},401)},
   {leadIds:[lead.id],text:'hi'},owner,null);
  assert.equal(result.status,'OK');
  assert.equal(result.failed,1);assert.equal(result.sent,0);
  assert.equal(result.results[0].status,'FAILED');assert.equal(result.results[0].reason,'AUTH');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM crm_messages').get().n,0);
 }finally{store.close();}
});

test('sendWhatsAppCampaign real send: INTEGRATION_REQUIRED when WhatsApp is not configured, never a fake send',async()=>{
 const store=fixture();try{
  const lead=makeLead(store,'+966500000040');
  const result=await sendWhatsAppCampaign({store,env:{},fetcher:noNetwork},{leadIds:[lead.id],text:'hi'},owner,null);
  assert.equal(result.status,'INTEGRATION_REQUIRED');
 }finally{store.close();}
});
