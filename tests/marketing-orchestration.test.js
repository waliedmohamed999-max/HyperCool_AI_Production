import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {extractSafeCrmUpdates} from '../src/runtime/agent-crm-updates.js';

async function harness(fetcher) {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-mkt-orch-'));
 const app=await createApp({dataDir:directory,env:{ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',PLATFORM_MAIL_TRANSPORT:'capture'},fetcher});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 async function call(path,input,session,{method}={}) {
  const res=await fetch(base+path,{method:method||(input?'POST':'GET'),headers:{...(input?{'Content-Type':'application/json'}:{}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{})},...(input?{body:JSON.stringify(input)}:{})});
  const data=await res.json().catch(()=>null);
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],csrf:data?.csrf};
 }
 return {app,base,call,cleanup:async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function latestMailTo(app,toEmail,kind) {
 const row=app.store.db.prepare('SELECT * FROM platform_mail_outbox WHERE to_email=? AND kind=? ORDER BY created_at DESC LIMIT 1').get(toEmail,kind);
 return row?JSON.parse(row.captured_body):null;
}
function extractToken(body,marker) {
 const match=(body.html+body.text).match(new RegExp(marker+'/([a-f0-9]+)'));
 return match?match[1]:null;
}
async function signupAndCreateWorkspace(call,app,{username,email,companyName}) {
 const signup=await call('/api/signup',{name:'مستخدم اختبار',username,email,password:'a-long-test-password'});
 const session={cookie:signup.cookie,csrf:signup.csrf};
 const mail=latestMailTo(app,email,'VERIFY_EMAIL');
 const token=extractToken(mail,'verify-email');
 await call('/api/account/email/verify',{token},null);
 await call('/api/workspaces',{companyName},session);
 return session;
}
const textTurn=obj=>({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(obj)}],usage:{input_tokens:5,output_tokens:5}});
function complianceFetcher(classification) {
 return async(url,options)=>{
  const bodyText=typeof options?.body==='string'?options.body:'';
  if(bodyText.includes('Brand & Compliance Agent')) {
   // validateAgentDecision (src/agents.js) enforces: a BLOCK classification MUST carry
   // status:'BLOCKED' (never 'OK') — matching the same rule this system's own compliance
   // agent contract already requires everywhere else.
   const isBlock=classification==='BLOCK';
   return new Response(JSON.stringify(textTurn({status:isBlock?'BLOCKED':'OK',action:'REVIEW',rationale:'فحص حقيقي',verification:[],risk_level:isBlock?'HIGH':'LOW',escalation_required:isBlock,missing_data:[],payload:{classification,issues:isBlock?[{severity:'HIGH',field:'body',problem:'ادعاء غير موثق',correction:'أزل الادعاء',evidence_required:'مصدر رسمي'}]:[],corrected_text_if_possible:null,evidence_sources:[],verified_fields:['body'],blocked_fields:isBlock?['body']:[],human_review_required:classification!=='PASS',reason:'اختبار'}})),{status:200,headers:{'content-type':'application/json'}});
  }
  if(bodyText.includes('Creative Agent')) {
   return new Response(JSON.stringify(textTurn({status:'OK',action:'BRIEF',rationale:'موجز إبداعي حقيقي',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],payload:{format:'1:1',dimensions:'1080x1080',hero_asset:null,composition:'منتج في المنتصف',visual_hierarchy:['العنوان','الصورة','CTA'],on_image_text:['خصم 25%'],logo_placement:'أعلى اليسار',product_angles:['أمامي'],b_roll:[],transitions:[],reel_duration:null,subtitles:'لا',CTA_frame:'الإطار الأخير',required_assets:['صورة المنتج']}})),{status:200,headers:{'content-type':'application/json'}});
  }
  return new Response(JSON.stringify(textTurn({status:'NEEDS_DATA',action:'NONE',rationale:'not mocked',verification:[],risk_level:'LOW',escalation_required:false,missing_data:['x'],payload:null})),{status:200,headers:{'content-type':'application/json'}});
 };
}

test('Compliance gate: a real PASS result allows IN_REVIEW -> APPROVED',async()=>{
 const {call,app,cleanup}=await harness(complianceFetcher('PASS'));
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'orch1',email:'orch1@example.com',companyName:'Orch Test 1'});
  const item=await call('/api/marketing/content',{channel:'Instagram',format:'post',body:'نص حقيقي للاختبار'},owner);
  await call(`/api/marketing/content/${item.data.id}`,{status:'IN_REVIEW'},owner,{method:'PATCH'});
  const compliance=await call(`/api/marketing/content/${item.data.id}/run-compliance`,{},owner);
  assert.equal(compliance.status,200);
  assert.equal(compliance.data.content.complianceClassification,'PASS');
  assert.equal(compliance.data.content.complianceValid,true);
  const approved=await call(`/api/marketing/content/${item.data.id}`,{status:'APPROVED'},owner,{method:'PATCH'});
  assert.equal(approved.status,200);
  assert.equal(approved.data.status,'APPROVED');
 } finally {await cleanup();}
});

test('Compliance gate: a real BLOCK result permanently refuses APPROVED for that content',async()=>{
 const {call,app,cleanup}=await harness(complianceFetcher('BLOCK'));
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'orch2',email:'orch2@example.com',companyName:'Orch Test 2'});
  const item=await call('/api/marketing/content',{channel:'Instagram',format:'post',body:'ادعاء طبي غير موثق'},owner);
  await call(`/api/marketing/content/${item.data.id}`,{status:'IN_REVIEW'},owner,{method:'PATCH'});
  const compliance=await call(`/api/marketing/content/${item.data.id}/run-compliance`,{},owner);
  assert.equal(compliance.data.content.complianceClassification,'BLOCK');
  const approved=await call(`/api/marketing/content/${item.data.id}`,{status:'APPROVED'},owner,{method:'PATCH'});
  assert.equal(approved.status,409);
 } finally {await cleanup();}
});

test('Compliance invalidation: editing content after a PASS check refuses approval until re-checked',async()=>{
 const {call,app,cleanup}=await harness(complianceFetcher('PASS'));
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'orch3',email:'orch3@example.com',companyName:'Orch Test 3'});
  const item=await call('/api/marketing/content',{channel:'Instagram',format:'post',body:'نص أصلي'},owner);
  await call(`/api/marketing/content/${item.data.id}`,{status:'IN_REVIEW'},owner,{method:'PATCH'});
  await call(`/api/marketing/content/${item.data.id}/run-compliance`,{},owner);
  // Edit the body AFTER the check — the stored compliance hash no longer matches.
  await call(`/api/marketing/content/${item.data.id}`,{body:'نص مختلف بعد الفحص'},owner,{method:'PATCH'});
  const staleApprove=await call(`/api/marketing/content/${item.data.id}`,{status:'APPROVED'},owner,{method:'PATCH'});
  assert.equal(staleApprove.status,409);
  // Re-running compliance against the NEW text re-validates it.
  const recheck=await call(`/api/marketing/content/${item.data.id}/run-compliance`,{},owner);
  assert.equal(recheck.data.content.complianceValid,true);
  const approved=await call(`/api/marketing/content/${item.data.id}`,{status:'APPROVED'},owner,{method:'PATCH'});
  assert.equal(approved.status,200);
 } finally {await cleanup();}
});

test('Creative brief generation populates the real creativeBrief field from a real agent run',async()=>{
 const {call,app,cleanup}=await harness(complianceFetcher('PASS'));
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'orch4',email:'orch4@example.com',companyName:'Orch Test 4'});
  const item=await call('/api/marketing/content',{channel:'Instagram',format:'post',body:'نص للإبداع'},owner);
  const creative=await call(`/api/marketing/content/${item.data.id}/generate-creative`,{},owner);
  assert.equal(creative.status,200);
  assert.equal(creative.data.content.creativeBrief.dimensions,'1080x1080');
  assert.ok(creative.data.content.creativeRunId);
 } finally {await cleanup();}
});

test('Compliance/Creative runs are gated to owner/operator — a reviewer is refused',async()=>{
 const {call,app,cleanup}=await harness(complianceFetcher('PASS'));
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'orch5',email:'orch5@example.com',companyName:'Orch Test 5'});
  const item=await call('/api/marketing/content',{channel:'Instagram',format:'post',body:'test'},owner);
  const invite=await call('/api/workspaces/invitations',{email:'reviewer5@example.com',role:'reviewer'},owner);
  const register=await call(`/api/invitations/${invite.data.token}/register`,{username:'reviewer5',name:'مراجع',password:'a-long-test-password'},null);
  const reviewer={cookie:register.cookie,csrf:register.data.csrf};
  const deniedCompliance=await call(`/api/marketing/content/${item.data.id}/run-compliance`,{},reviewer);
  assert.equal(deniedCompliance.status,403);
  const deniedCreative=await call(`/api/marketing/content/${item.data.id}/generate-creative`,{},reviewer);
  assert.equal(deniedCreative.status,403);
 } finally {await cleanup();}
});

// --- Part E: safe CRM update application (pure-function unit tests — no HTTP needed) --------
test('extractSafeCrmUpdates: only allowlisted fields pass through, stage is never auto-applied',()=>{
 const decision={
  intent:'price',customer_type:'B2C',
  qualification:{city:'الرياض',product_need:'عطر',quantity:2,timeline:'هذا الأسبوع',budget_band:'200-400'},
  lead_temperature:'HOT',
  crm_updates:{stage:'WON',notes:'ملاحظة حرة',city:'جدة',arbitraryModelField:'should be dropped',temperature:'HOT'}
 };
 const {safe,stageProposal}=extractSafeCrmUpdates(decision);
 assert.equal(safe.city,'جدة'); // explicit crm_updates.city wins over qualification.city
 assert.equal(safe.productNeed,'عطر');
 assert.equal(safe.temperature,'HOT');
 assert.equal(safe.quantity,2);
 assert.equal('notes' in safe,false); // not on the allowlist — dropped, not erred on
 assert.equal('arbitraryModelField' in safe,false);
 assert.equal(stageProposal,'WON'); // reported separately — caller must route through approval
});
test('extractSafeCrmUpdates: an invalid temperature/stage value is dropped, never applied blindly',()=>{
 const {safe,stageProposal}=extractSafeCrmUpdates({lead_temperature:'SCALDING',crm_updates:{stage:'NOT_A_REAL_STAGE'}});
 assert.equal('temperature' in safe,false);
 assert.equal(stageProposal,null);
});
test('extractSafeCrmUpdates: a missing/malformed decision payload never throws',()=>{
 assert.deepEqual(extractSafeCrmUpdates(null),{safe:{},stageProposal:null});
 assert.deepEqual(extractSafeCrmUpdates({}),{safe:{},stageProposal:null});
});

// --- Part E, HTTP-level: the Website Chat widget's sales-agent CRM update application --------
function widgetSalesFetcher(withStageChange) {
 return async(url,options)=>{
  const bodyText=typeof options?.body==='string'?options.body:'';
  if(bodyText.includes('Conversation & Closing Agent')||bodyText.includes('CUSTOMER_MESSAGE_RECEIVED')||bodyText.includes('WebsiteChat')) {
   return new Response(JSON.stringify(textTurn({status:'OK',action:'ANSWER',rationale:'رد حقيقي',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],payload:{
    intent:'price',customer_type:'B2C',qualification:{city:'الدمام',product_need:'عطر شتوي',quantity:null,timeline:null,budget_band:null},
    recommended_product_id:null,reply_ar:'أهلًا! التوصيل متاح للدمام.',reply_en:'Hi! Delivery is available to Dammam.',
    next_best_action:'send_catalog_link',lead_temperature:'WARM',crm_updates:withStageChange?{stage:'QUALIFIED'}:{},missing_fields:[],handoff_reason:null
   }})),{status:200,headers:{'content-type':'application/json'}});
  }
  return new Response(JSON.stringify(textTurn({status:'NEEDS_DATA',action:'NONE',rationale:'not mocked',verification:[],risk_level:'LOW',escalation_required:false,missing_data:['x'],payload:null})),{status:200,headers:{'content-type':'application/json'}});
 };
}
test('Website widget: safe CRM fields (city, temperature) auto-apply from a real sales-agent decision',async()=>{
 const {call,app,cleanup}=await harness(widgetSalesFetcher(false));
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'orch6',email:'orch6@example.com',companyName:'Orch Test 6'});
  await call('/api/marketing/widget',{status:'ACTIVE',allowedDomains:['example.com']},owner,{method:'PATCH'});
  const config=await call('/api/marketing/widget',null,owner,{method:'GET'});
  const chatRes=await fetch(app.base??`http://127.0.0.1:${app.server.address().port}`);
  const res=await fetch(`http://127.0.0.1:${app.server.address().port}/api/public/widget/${config.data.publicWidgetId}/chat`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:JSON.stringify({text:'هل يوجد توصيل للدمام؟',name:'زائر'})});
  const chat=await res.json();
  assert.equal(res.status,200);
  assert.ok(chat.reply);
  const leadDetail=await call(`/api/crm/leads/${chat.leadId}`,null,owner,{method:'GET'});
  assert.equal(leadDetail.data.lead.city,'الدمام');
  assert.equal(leadDetail.data.lead.temperature,'WARM');
  assert.equal(leadDetail.data.lead.stage,'NEW'); // never auto-changed
 } finally {await cleanup();}
});
test('Website widget: a proposed STAGE change creates a real Approval Center entry instead of auto-applying, and applies on human approval',async()=>{
 const {call,app,cleanup}=await harness(widgetSalesFetcher(true));
 try {
  const owner=await signupAndCreateWorkspace(call,app,{username:'orch7',email:'orch7@example.com',companyName:'Orch Test 7'});
  await call('/api/marketing/widget',{status:'ACTIVE',allowedDomains:['example.com']},owner,{method:'PATCH'});
  const config=await call('/api/marketing/widget',null,owner,{method:'GET'});
  const res=await fetch(`http://127.0.0.1:${app.server.address().port}/api/public/widget/${config.data.publicWidgetId}/chat`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:JSON.stringify({text:'أريد الشراء الآن',name:'زائر'})});
  const chat=await res.json();
  const leadBefore=await call(`/api/crm/leads/${chat.leadId}`,null,owner,{method:'GET'});
  assert.equal(leadBefore.data.lead.stage,'NEW'); // NOT auto-applied
  const pending=await call('/api/approvals?status=PENDING',null,owner,{method:'GET'});
  const stageApproval=pending.data.find(a=>a.action_type==='marketing_crm_stage_update' && a.proposed_output.leadId===chat.leadId);
  assert.ok(stageApproval,'expected a real pending approval for the proposed stage change');
  assert.equal(stageApproval.proposed_output.toStage,'QUALIFIED');
  const decided=await call(`/api/approvals/${stageApproval.id}/decide`,{decision:'APPROVED'},owner);
  assert.equal(decided.status,200);
  assert.equal(decided.data.leadUpdateResult.status,'APPLIED');
  const leadAfter=await call(`/api/crm/leads/${chat.leadId}`,null,owner,{method:'GET'});
  assert.equal(leadAfter.data.lead.stage,'QUALIFIED');
 } finally {await cleanup();}
});
