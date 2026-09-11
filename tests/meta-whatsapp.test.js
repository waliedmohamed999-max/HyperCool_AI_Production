import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {openStore} from '../src/store.js';
import {installCRM,createLead,getLead,updateLead} from '../src/crm.js';
import {installEvents,createEventBus} from '../src/runtime/events.js';
import {installEscalations,listEscalations} from '../src/runtime/escalations.js';
import {installCredentials,saveCredentials,getCredentials} from '../src/runtime/credentials.js';
import {installWhatsAppTemplates,listWhatsAppTemplates,sendWhatsAppMessage,syncWhatsAppTemplates,testWhatsAppConnection,whatsappConfigured} from '../src/runtime/whatsapp.js';
import {installWebhookEvents} from '../src/runtime/webhook-events.js';
import {handleVerificationChallenge,verifyMetaSignature,normalizeWhatsAppWebhook} from '../src/runtime/meta-webhooks.js';
import {metaOAuthConfigured,createMetaAuthorizeUrl,consumeMetaState,exchangeCodeAndResolveAssets,saveMetaConnection,resolveMetaAccessToken,connectedWhatsAppPhoneNumberId} from '../src/runtime/meta-oauth.js';
import {publishToInstagram,publishToFacebook,alreadyPublished} from '../src/runtime/meta-publishing.js';
import {findOrCreateLeadFromChannel,recordChannelMessage,updateMessageStatus,maybeEscalateHotLead} from '../src/crm.js';
import {installAuditLog} from '../src/audit.js';

const owner={id:'owner-1',name:'Owner',role:'owner'};
const connector={id:'connector:whatsapp',name:'موصل واتساب',role:'automation'};
const key32=randomBytes(32).toString('hex');

function fixture(){
 const store=openStore(':memory:');
 installCRM(store.db);installEvents(store.db);installEscalations(store.db);installCredentials(store.db);installWebhookEvents(store.db);installWhatsAppTemplates(store.db);installAuditLog(store.db);
 return store;
}
function jsonResponse(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}

// --- CRM channel plumbing ---------------------------------------------------------------

test('findOrCreateLeadFromChannel creates exactly one lead per phone number, never a duplicate on repeat contact',()=>{
 const store=fixture();try{
 const first=findOrCreateLeadFromChannel(store,{phone:'+966500000001',name:'Ahmed',channel:'WhatsApp'},connector);
 assert.equal(first.created,true);
 const second=findOrCreateLeadFromChannel(store,{phone:'+966500000001',name:'Ahmed'},connector);
 assert.equal(second.created,false);assert.equal(second.lead.id,first.lead.id);
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM crm_leads').get().n,1);
 }finally{store.close();}
});

test('recordChannelMessage: inbound updates lead state and is idempotent per externalMessageId',()=>{
 const store=fixture();try{
 const {lead}=findOrCreateLeadFromChannel(store,{phone:'+966500000002',name:'Sara',channel:'WhatsApp'},connector);
 const first=recordChannelMessage(store,{leadId:lead.id,channel:'WhatsApp',direction:'INBOUND',text:'كم سعر الجهاز؟',externalMessageId:'wamid.1',messageType:'text'},connector);
 assert.equal(first.replayed,undefined);
 assert.equal(first.optedOut,false);
 const reloaded=getLead(store.db,lead.id);
 assert.equal(reloaded.replyHold,true);assert.ok(reloaded.lastInboundAt);
 const replay=recordChannelMessage(store,{leadId:lead.id,channel:'WhatsApp',direction:'INBOUND',text:'كم سعر الجهاز؟',externalMessageId:'wamid.1'},connector);
 assert.equal(replay.replayed,true);
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM crm_messages').get().n,1);
 }finally{store.close();}
});

test('recordChannelMessage detects an inbound opt-out and stops it from being misread as a normal reply',()=>{
 const store=fixture();try{
 const {lead}=findOrCreateLeadFromChannel(store,{phone:'+966500000003',name:'Fahad',channel:'WhatsApp'},connector);
 const message=recordChannelMessage(store,{leadId:lead.id,channel:'WhatsApp',direction:'INBOUND',text:'stop',externalMessageId:'wamid.2'},connector);
 assert.equal(message.optedOut,true);
 assert.equal(getLead(store.db,lead.id).optOut,true);
 }finally{store.close();}
});

test('recordChannelMessage: outbound never sets replyHold/lastInboundAt (only inbound does)',()=>{
 const store=fixture();try{
 const {lead}=findOrCreateLeadFromChannel(store,{phone:'+966500000004',name:'Noor',channel:'WhatsApp'},connector);
 recordChannelMessage(store,{leadId:lead.id,channel:'WhatsApp',direction:'OUTBOUND',text:'مرحبًا',externalMessageId:'wamid.out.1'},connector);
 const reloaded=getLead(store.db,lead.id);
 assert.equal(reloaded.replyHold,false);assert.equal(reloaded.lastInboundAt,undefined);
 assert.ok(reloaded.lastOutboundAt);
 }finally{store.close();}
});

test('updateMessageStatus updates the SAME row in place, never creates a new one, and never regresses status',()=>{
 const store=fixture();try{
 const {lead}=findOrCreateLeadFromChannel(store,{phone:'+966500000005',name:'Reem',channel:'WhatsApp'},connector);
 recordChannelMessage(store,{leadId:lead.id,channel:'WhatsApp',direction:'OUTBOUND',text:'hi',externalMessageId:'wamid.out.2'},connector);
 const delivered=updateMessageStatus(store,'wamid.out.2','DELIVERED');
 assert.equal(delivered.found,true);assert.equal(delivered.message.status,'DELIVERED');assert.ok(delivered.message.deliveredAt);
 const read=updateMessageStatus(store,'wamid.out.2','READ');
 assert.equal(read.message.status,'READ');assert.ok(read.message.readAt);
 const regressed=updateMessageStatus(store,'wamid.out.2','SENT'); // a late "sent" after "read" must not regress
 assert.equal(regressed.ignored,true);
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM crm_messages').get().n,1);
 assert.deepEqual(updateMessageStatus(store,'wamid.nonexistent','READ'),{found:false});
 }finally{store.close();}
});

test('maybeEscalateHotLead creates a real escalation and emits LEAD_HOT only on a genuine COLD/WARM->HOT transition',()=>{
 const store=fixture();try{
 const lead=createLead(store,{name:'Gym Co',customerType:'B2B',company:'Riyadh Gym',sourceType:'INBOUND',phone:'+966511111111'},owner);
 const eventBus=createEventBus(store.db);
 const before=getLead(store.db,lead.id);
 const updated=updateLead(store,lead.id,{stage:'QUALIFIED',temperature:'HOT',reason:'Asked for formal quote for 4 units',city:'Riyadh',productNeed:'Cryo',quantity:4,timeline:'',budgetBand:'',expectedVersion:before.version},owner);
 const result=maybeEscalateHotLead(store,eventBus,before,updated,{agentId:'sales'});
 assert.ok(result);
 assert.equal(listEscalations(store.db).length,1);
 assert.equal(listEscalations(store.db)[0].priority,'P1');
 assert.equal(eventBus.list({type:'LEAD_HOT'}).length,1);
 // Already HOT -> HOT again must not create a second escalation.
 const before2=getLead(store.db,lead.id);
 const updated2=updateLead(store,lead.id,{stage:'QUALIFIED',temperature:'HOT',reason:'still hot',expectedVersion:before2.version},owner);
 maybeEscalateHotLead(store,eventBus,before2,updated2,{agentId:'sales'});
 assert.equal(listEscalations(store.db).length,1);
 }finally{store.close();}
});

// --- Meta webhook verification -----------------------------------------------------------

test('handleVerificationChallenge accepts the correct verify token and echoes the challenge, rejects a wrong one',()=>{
 const env={META_VERIFY_TOKEN:'a-real-verify-token'};
 const good=new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':'a-real-verify-token','hub.challenge':'12345'});
 assert.equal(handleVerificationChallenge(good,env),'12345');
 const bad=new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':'wrong','hub.challenge':'12345'});
 assert.throws(()=>handleVerificationChallenge(bad,env),/Verify token mismatch/);
});

test('verifyMetaSignature is a real HMAC-SHA256 (X-Hub-Signature-256) over the exact raw body',()=>{
 const env={META_WEBHOOK_SECRET:'meta-secret'};
 const raw='{"entry":[]}';
 const validSig='sha256='+createHmac('sha256','meta-secret').update(raw).digest('hex');
 assert.doesNotThrow(()=>verifyMetaSignature({headers:{'x-hub-signature-256':validSig}},raw,env));
 assert.throws(()=>verifyMetaSignature({headers:{'x-hub-signature-256':validSig}},raw+' ',env),/توقيع/);
 assert.throws(()=>verifyMetaSignature({headers:{}},raw,env),/ترويسة/);
 assert.throws(()=>verifyMetaSignature({headers:{'x-hub-signature-256':validSig}},raw,{}),/META_WEBHOOK_SECRET/);
});

// --- WhatsApp inbound normalization --------------------------------------------------------

test('normalizeWhatsAppWebhook parses a real text message payload and is idempotent on redelivery',()=>{
 const store=fixture();try{
 const payload={entry:[{changes:[{value:{contacts:[{profile:{name:'Khalid'}}],messages:[{id:'wamid.abc',from:'966500000009',type:'text',text:{body:'كم سعر جهاز الكرايو؟'}}]}}]}]};
 const first=normalizeWhatsAppWebhook(store.db,payload,()=>'test-tenant');
 assert.equal(first.messages.length,1);
 assert.equal(first.messages[0].replayed,false);
 assert.equal(first.messages[0].phone,'+966500000009');
 assert.equal(first.messages[0].name,'Khalid');
 assert.equal(first.messages[0].messageType,'text');
 assert.equal(first.messages[0].text,'كم سعر جهاز الكرايو؟');
 const redelivered=normalizeWhatsAppWebhook(store.db,payload,()=>'test-tenant');
 assert.equal(redelivered.messages[0].replayed,true);
 }finally{store.close();}
});

test('normalizeWhatsAppWebhook records an unsupported message type honestly as metadata-only, never guesses its content',()=>{
 const store=fixture();try{
 const payload={entry:[{changes:[{value:{messages:[{id:'wamid.sticker.1',from:'966500000010',type:'sticker',sticker:{id:'s1'}}]}}]}]};
 const result=normalizeWhatsAppWebhook(store.db,payload,()=>'test-tenant');
 assert.equal(result.messages[0].messageType,'media');
 assert.equal(result.messages[0].media.kind,'sticker');
 assert.equal(result.messages[0].text,'');
 }finally{store.close();}
});

test('normalizeWhatsAppWebhook handles delivery-status updates separately from messages',()=>{
 const store=fixture();try{
 const payload={entry:[{changes:[{value:{statuses:[{id:'wamid.out.9',status:'delivered'}]}}]}]};
 const result=normalizeWhatsAppWebhook(store.db,payload,()=>'test-tenant');
 assert.equal(result.statuses.length,1);
 assert.equal(result.statuses[0].status,'DELIVERED');
 assert.equal(result.messages.length,0);
 }finally{store.close();}
});

// --- WhatsApp send / templates -------------------------------------------------------------

test('sendWhatsAppMessage returns INTEGRATION_REQUIRED honestly when nothing is configured, never a fake success',async()=>{
 const store=fixture();try{
 const result=await sendWhatsAppMessage({store,env:{},fetcher:()=>{throw new Error('must not call network');}},{to:'+966500000000',text:'hi'});
 assert.equal(result.status,'INTEGRATION_REQUIRED');
 assert.equal(whatsappConfigured({store,env:{}}),false);
 }finally{store.close();}
});

test('sendWhatsAppMessage sends real text via the WhatsApp Cloud API and classifies failures correctly',async()=>{
 const store=fixture();try{
 const env={WHATSAPP_ACCESS_TOKEN:'wa-token',WHATSAPP_PHONE_NUMBER_ID:'12345'};
 const ok=await sendWhatsAppMessage({store,env,fetcher:async(url,opts)=>{
  assert.equal(url,'https://graph.facebook.com/v21.0/12345/messages');
  assert.equal(JSON.parse(opts.body).type,'text');
  return jsonResponse({messages:[{id:'wamid.sent.1'}]});
 }},{to:'+966500000000',text:'hi'});
 assert.equal(ok.status,'SENT');assert.equal(ok.externalMessageId,'wamid.sent.1');

 const authFail=await sendWhatsAppMessage({store,env,fetcher:async()=>jsonResponse({error:{code:190,message:'Invalid OAuth'}},401)},{to:'+966500000000',text:'hi'});
 assert.equal(authFail.status,'FAILED');assert.equal(authFail.errorClass,'AUTH');

 const templateRequired=await sendWhatsAppMessage({store,env,fetcher:async()=>jsonResponse({error:{code:131047,message:'template required'}},400)},{to:'+966500000000',text:'hi'});
 assert.equal(templateRequired.errorClass,'TEMPLATE_REQUIRED');
 }finally{store.close();}
});

test('syncWhatsAppTemplates pulls real approval status from Meta and upserts by name+language, never invents Approved',async()=>{
 const store=fixture();try{
 const env={WHATSAPP_ACCESS_TOKEN:'wa-token',WHATSAPP_BUSINESS_ACCOUNT_ID:'waba-1'};
 const fetcher=async(url)=>{
  assert.match(url,/\/waba-1\/message_templates/);
  return jsonResponse({data:[{id:'tpl-1',name:'quote_followup',language:'ar',category:'MARKETING',status:'PENDING',components:[]}]});
 };
 const result=await syncWhatsAppTemplates({store,env,fetcher});
 assert.equal(result.synced,1);
 const templates=listWhatsAppTemplates(store.db);
 assert.equal(templates[0].status,'PENDING');
 // Re-sync with an updated status must UPDATE the same row, not add a second one.
 await syncWhatsAppTemplates({store,env,fetcher:async()=>jsonResponse({data:[{id:'tpl-1',name:'quote_followup',language:'ar',category:'MARKETING',status:'APPROVED',components:[]}]})});
 const updated=listWhatsAppTemplates(store.db);
 assert.equal(updated.length,1);assert.equal(updated[0].status,'APPROVED');
 }finally{store.close();}
});

// --- Meta OAuth + publishing -----------------------------------------------------------

test('Meta OAuth: state is one-time and tied to the user who started it',()=>{
 const env={META_APP_ID:'a',META_APP_SECRET:'b',META_REDIRECT_URI:'https://hyper-cool.com/cb'};
 const url=createMetaAuthorizeUrl(env,'user-1');
 const state=new URL(url).searchParams.get('state');
 assert.throws(()=>consumeMetaState(state,'user-2'),/مستخدم مختلف/);
 const url2=createMetaAuthorizeUrl(env,'user-1');
 const state2=new URL(url2).searchParams.get('state');
 assert.doesNotThrow(()=>consumeMetaState(state2,'user-1'));
 assert.throws(()=>consumeMetaState(state2,'user-1'),/انتهت صلاحية/); // one-time use
});

test('exchangeCodeAndResolveAssets resolves the real Page/Instagram/WhatsApp chain and saveMetaConnection stores it correctly split (secret vs metadata)',async()=>{
 const store=fixture();try{
 const env={META_APP_ID:'a',META_APP_SECRET:'b',META_REDIRECT_URI:'https://hyper-cool.com/cb',INTEGRATION_ENCRYPTION_KEY:key32};
 const fetcher=async(url)=>{
  if(url.includes('fb_exchange_token'))return jsonResponse({access_token:'long-lived-user-token',expires_in:5184000});
  if(url.includes('/oauth/access_token'))return jsonResponse({access_token:'short-lived-token',expires_in:3600});
  if(url.includes('/me/accounts'))return jsonResponse({data:[{id:'page-1',name:'HyperCool Page',access_token:'page-token-secret',instagram_business_account:{id:'ig-1',username:'hypercool'}}]});
  if(url.includes('/me/businesses'))return jsonResponse({data:[{owned_whatsapp_business_accounts:{data:[{id:'waba-1',phone_numbers:{data:[{id:'phone-1',display_phone_number:'+966500000000'}]}}]}}]});
  throw new Error('unexpected url '+url);
 };
 const assets=await exchangeCodeAndResolveAssets({env,fetcher,code:'auth-code'});
 assert.equal(assets.page.id,'page-1');assert.equal(assets.instagram.username,'hypercool');assert.equal(assets.whatsapp.phoneNumberId,'phone-1');
 const meta=saveMetaConnection(store.db,env,assets,owner);
 assert.equal(JSON.stringify(meta).includes('page-token-secret'),false); // the secret never appears in the safe/public shape
 assert.equal(meta.metadata.page.name,'HyperCool Page');
 const creds=getCredentials(store.db,env,'meta');
 assert.equal(creds.extra.pageAccessToken,'page-token-secret');
 const resolved=resolveMetaAccessToken({store,env},'page');
 assert.equal(resolved.token,'page-token-secret');assert.equal(resolved.source,'oauth');
 assert.equal(connectedWhatsAppPhoneNumberId(store.db,env),'phone-1');
 }finally{store.close();}
});

test('publishToInstagram uses the two-step container->publish flow and returns a real external post id',async()=>{
 const store=fixture();try{
 const env={INTEGRATION_ENCRYPTION_KEY:key32};
 saveCredentials(store.db,env,'meta',{accessToken:'user-token',expiresAt:new Date(Date.now()+3600000).toISOString(),extra:{pageAccessToken:'page-token'},metadata:{instagram:{id:'ig-1',username:'x'}}},owner);
 let calls=0;
 const result=await publishToInstagram({store,env,fetcher:async(url)=>{
  calls++;
  if(calls===1){assert.match(url,/\/ig-1\/media$/);return jsonResponse({id:'container-1'});}
  assert.match(url,/\/ig-1\/media_publish$/);return jsonResponse({id:'post-1'});
 }},{imageUrl:'https://hyper-cool.com/a.jpg',caption:'test'});
 assert.equal(result.status,'PUBLISHED');assert.equal(result.externalPostId,'post-1');
 assert.equal(calls,2);
 }finally{store.close();}
});

test('meta_publish safety: alreadyPublished() prevents a second publish attempt after a timeout, no duplicate post',()=>{
 assert.equal(alreadyPublished({externalPostId:'post-1'}),true);
 assert.equal(alreadyPublished({}),false);
 assert.equal(alreadyPublished(null),false);
});

test('publishToFacebook posts to the Page feed directly (one call, no container step)',async()=>{
 const store=fixture();try{
 const env={META_ACCESS_TOKEN:'legacy-page-token',META_PAGE_ID:'page-9'};
 const result=await publishToFacebook({store,env,fetcher:async(url,opts)=>{
  assert.match(url,/\/page-9\/feed$/);
  assert.equal(JSON.parse(opts.body).message,'hello');
  return jsonResponse({id:'fb-post-1'});
 }},{message:'hello'});
 assert.equal(result.status,'PUBLISHED');assert.equal(result.externalPostId,'fb-post-1');
 }finally{store.close();}
});
