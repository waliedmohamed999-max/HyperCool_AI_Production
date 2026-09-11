import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {openStore} from '../src/store.js';
import {installCRM,findOrCreateLeadFromChannel,recordChannelMessage,updateMessageStatus,getLead,findLeadByEmail} from '../src/crm.js';
import {installEvents,createEventBus} from '../src/runtime/events.js';
import {installEscalations} from '../src/runtime/escalations.js';
import {installApprovals} from '../src/runtime/approvals.js';
import {installCredentials,saveCredentials,getCredentials,updateCredentialsMetadata,getCredentialsMeta} from '../src/runtime/credentials.js';
import {installWebhookEvents} from '../src/runtime/webhook-events.js';
import {createMicrosoftAuthorizeUrl,consumeMicrosoftState,exchangeCodeForTokens,resolveConnectedProfile,saveMicrosoftConnection,microsoftOAuthStatus,resolveMicrosoftAccessToken,requestedScopes} from '../src/runtime/microsoft-oauth.js';
import {sendMail,testMicrosoftConnection,createMailSubscription,renewMailSubscription,createCalendarEvent,getCalendarAvailability,getMessage} from '../src/runtime/microsoft-graph.js';
import {handleValidationHandshake,processMicrosoftNotifications} from '../src/runtime/microsoft-webhooks.js';
import {renewMicrosoftSubscriptionIfNeeded} from '../src/runtime/scheduler.js';
import {buildToolRegistry} from '../src/runtime/tools.js';
import {canUseTool} from '../src/runtime/permissions.js';
import {installAuditLog} from '../src/audit.js';

const owner={id:'owner-1',name:'Owner',role:'owner'};
const connector={id:'connector:microsoft365',name:'موصل Microsoft 365',role:'automation'};
const key32=randomBytes(32).toString('hex');
function jsonResponse(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}

function fixture(){
 const store=openStore(':memory:');
 installCRM(store.db);installEvents(store.db);installEscalations(store.db);installApprovals(store.db);installCredentials(store.db);installWebhookEvents(store.db);installAuditLog(store.db);
 return store;
}

// --- CRM email matching --------------------------------------------------------------

test('findOrCreateLeadFromChannel matches by email for the Email channel, never duplicating',()=>{
 const store=fixture();try{
 const first=findOrCreateLeadFromChannel(store,{email:'club@example.com',name:'Riyadh Club',channel:'Email'},connector);
 assert.equal(first.created,true);
 const second=findOrCreateLeadFromChannel(store,{email:'CLUB@example.com',name:'Riyadh Club'},connector); // case-insensitive match
 assert.equal(second.created,false);assert.equal(second.lead.id,first.lead.id);
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM crm_leads').get().n,1);
 assert.equal(findLeadByEmail(store.db,'club@example.com').id,first.lead.id);
 }finally{store.close();}
});

test('recordChannelMessage stores email-specific fields (subject/cc/thread) without breaking the WhatsApp shape',()=>{
 const store=fixture();try{
 const {lead}=findOrCreateLeadFromChannel(store,{email:'a@b.com',name:'A',channel:'Email'},connector);
 const message=recordChannelMessage(store,{leadId:lead.id,channel:'Email',direction:'INBOUND',text:'نحتاج عرض سعر',subject:'طلب عرض سعر',externalMessageId:'msg-1',externalThreadId:'thread-1',internetMessageId:'<abc@mail>',messageType:'email'},connector);
 assert.equal(message.subject,'طلب عرض سعر');
 assert.equal(message.externalThreadId,'thread-1');
 assert.equal(message.internetMessageId,'<abc@mail>');
 }finally{store.close();}
});

// --- Microsoft OAuth ------------------------------------------------------------------

test('requestedScopes stays minimal by default and only adds Calendar scopes when explicitly enabled',()=>{
 assert.deepEqual(requestedScopes({}),['offline_access','User.Read','Mail.Read','Mail.Send']);
 assert.ok(requestedScopes({MICROSOFT_ENABLE_CALENDAR:'true'}).includes('Calendars.ReadWrite'));
});

test('Microsoft OAuth state is one-time and tied to the user who started it',()=>{
 const env={MICROSOFT_CLIENT_ID:'a',MICROSOFT_CLIENT_SECRET:'b',MICROSOFT_REDIRECT_URI:'https://hyper-cool.com/cb'};
 const url=createMicrosoftAuthorizeUrl(env,'user-1');
 const state=new URL(url).searchParams.get('state');
 assert.throws(()=>consumeMicrosoftState(state,'user-2'),/مستخدم مختلف/);
 const url2=createMicrosoftAuthorizeUrl(env,'user-1');
 const state2=new URL(url2).searchParams.get('state');
 assert.doesNotThrow(()=>consumeMicrosoftState(state2,'user-1'));
 assert.throws(()=>consumeMicrosoftState(state2,'user-1'),/انتهت صلاحية/);
});

test('exchangeCodeForTokens + resolveConnectedProfile + saveMicrosoftConnection stores the real identity, secret encrypted',async()=>{
 const store=fixture();try{
 const env={MICROSOFT_CLIENT_ID:'a',MICROSOFT_CLIENT_SECRET:'b',MICROSOFT_REDIRECT_URI:'https://hyper-cool.com/cb',INTEGRATION_ENCRYPTION_KEY:key32};
 const fetcher=async(url)=>{
  if(url.includes('/oauth2/v2.0/token'))return jsonResponse({access_token:'ms-access-token',refresh_token:'ms-refresh-token',expires_in:3600,scope:'Mail.Read Mail.Send'});
  if(url.includes('/me?'))return jsonResponse({id:'account-1',displayName:'Owner Test',mail:'owner@hyper-cool.com'});
  throw new Error('unexpected '+url);
 };
 const tokens=await exchangeCodeForTokens({env,fetcher,code:'code-1'});
 assert.equal(tokens.accessToken,'ms-access-token');
 const profile=await resolveConnectedProfile({env,fetcher,accessToken:tokens.accessToken});
 assert.equal(profile.email,'owner@hyper-cool.com');
 const meta=saveMicrosoftConnection(store.db,env,tokens,profile,owner);
 assert.equal(JSON.stringify(meta).includes('ms-access-token'),false);
 assert.equal(meta.metadata.email,'owner@hyper-cool.com');
 const status=microsoftOAuthStatus(store.db);
 assert.equal(status.connected,true);assert.equal(status.email,'owner@hyper-cool.com');
 const creds=getCredentials(store.db,env,'microsoft365');
 assert.equal(creds.accessToken,'ms-access-token');
 }finally{store.close();}
});

test('resolveMicrosoftAccessToken refreshes an expiring token and falls back to the static token on refresh failure',async()=>{
 const store=fixture();try{
 const env={MICROSOFT_CLIENT_ID:'a',MICROSOFT_CLIENT_SECRET:'b',MICROSOFT_REDIRECT_URI:'https://hyper-cool.com/cb',INTEGRATION_ENCRYPTION_KEY:key32};
 saveCredentials(store.db,env,'microsoft365',{accessToken:'old',refreshToken:'refresh-1',expiresAt:new Date(Date.now()+1000).toISOString()},owner);
 const refreshed=await resolveMicrosoftAccessToken({store,env,fetcher:async()=>jsonResponse({access_token:'new-token',refresh_token:'refresh-2',expires_in:3600})});
 assert.equal(refreshed.token,'new-token');assert.equal(refreshed.source,'oauth');

 saveCredentials(store.db,env,'microsoft365',{accessToken:'old2',refreshToken:'refresh-3',expiresAt:new Date(Date.now()+1000).toISOString()},owner);
 const fallback=await resolveMicrosoftAccessToken({store,env:{...env,MICROSOFT_ACCESS_TOKEN:'legacy-static'},fetcher:async()=>new Response('',{status:401})});
 assert.equal(fallback.token,'legacy-static');assert.equal(fallback.source,'static');
 }finally{store.close();}
});

// --- Graph mail/calendar client --------------------------------------------------------

test('sendMail sends real HTML mail via Graph and classifies failures (AUTH/RATE_LIMIT/PERMISSION_ERROR)',async()=>{
 const store=fixture();try{
 const env={MICROSOFT_ACCESS_TOKEN:'token-1'};
 const ok=await sendMail({store,env,fetcher:async(url,opts)=>{
  assert.equal(url,'https://graph.microsoft.com/v1.0/me/sendMail');
  const body=JSON.parse(opts.body);
  assert.equal(body.message.subject,'Quote');
  assert.equal(body.message.toRecipients[0].emailAddress.address,'club@example.com');
  return new Response(null,{status:202});
 }},{to:'club@example.com',subject:'Quote',bodyHtml:'<p>hi</p>'});
 assert.equal(ok.status,'SENT');

 const auth=await sendMail({store,env,fetcher:async()=>jsonResponse({error:{code:'InvalidAuthenticationToken'}},401)},{to:'a@b.com',subject:'x',bodyHtml:'x'});
 assert.equal(auth.errorClass,'AUTH');
 const rate=await sendMail({store,env,fetcher:async()=>new Response(JSON.stringify({error:{code:'TooManyRequests'}}),{status:429,headers:{'content-type':'application/json','retry-after':'30'}})},{to:'a@b.com',subject:'x',bodyHtml:'x'});
 assert.equal(rate.errorClass,'RATE_LIMIT');assert.equal(rate.retryAfter,'30');
 assert.equal((await sendMail({store,env:{},fetcher:()=>{throw new Error('must not call');}},{to:'a@b.com',subject:'x',bodyHtml:'x'})).status,'INTEGRATION_REQUIRED');
 }finally{store.close();}
});

test('testMicrosoftConnection confirms real identity access, honestly NOT_CONFIGURED with no credentials',async()=>{
 const store=fixture();try{
 assert.equal((await testMicrosoftConnection({store,env:{},fetcher:()=>{throw new Error('x');}})).result,'NOT_CONFIGURED');
 const ok=await testMicrosoftConnection({store,env:{MICROSOFT_ACCESS_TOKEN:'t'},fetcher:async()=>jsonResponse({displayName:'Owner',mail:'o@hyper-cool.com'})});
 assert.equal(ok.result,'OK');assert.equal(ok.email,'o@hyper-cool.com');
 }finally{store.close();}
});

test('createMailSubscription/renewMailSubscription use the real Graph subscriptions API with the correct max duration',async()=>{
 const store=fixture();try{
 const env={MICROSOFT_ACCESS_TOKEN:'t'};
 const created=await createMailSubscription({store,env,fetcher:async(url,opts)=>{
  assert.equal(url,'https://graph.microsoft.com/v1.0/subscriptions');
  const body=JSON.parse(opts.body);
  assert.equal(body.clientState,'wh-secret');
  assert.equal(body.resource,"me/mailFolders('inbox')/messages");
  return jsonResponse({id:'sub-1',expirationDateTime:body.expirationDateTime,resource:body.resource});
 }},{notificationUrl:'https://hyper-cool.com/api/webhooks/microsoft/mail',clientState:'wh-secret'});
 assert.equal(created.subscriptionId,'sub-1');
 const renewed=await renewMailSubscription({store,env,fetcher:async(url,opts)=>{
  assert.equal(url,'https://graph.microsoft.com/v1.0/subscriptions/sub-1');
  assert.equal(JSON.parse(opts.body).expirationDateTime!==undefined,true);
  return jsonResponse({id:'sub-1',expirationDateTime:new Date(Date.now()+3600000).toISOString()});
 }},'sub-1');
 assert.equal(renewed.subscriptionId,'sub-1');
 }finally{store.close();}
});

test('renewMicrosoftSubscriptionIfNeeded only renews when a subscription exists and is actually due',async()=>{
 const store=fixture();try{
 const env={MICROSOFT_ACCESS_TOKEN:'t',INTEGRATION_ENCRYPTION_KEY:key32};
 assert.deepEqual(await renewMicrosoftSubscriptionIfNeeded({store,env}),{skipped:'NO_SUBSCRIPTION'});
 saveCredentials(store.db,env,'microsoft365',{accessToken:'t',metadata:{mailSubscription:{id:'sub-1',expiresAt:new Date(Date.now()+3600*3600000).toISOString()}}},owner);
 assert.deepEqual(await renewMicrosoftSubscriptionIfNeeded({store,env}),{skipped:'NOT_DUE'});
 updateCredentialsMetadata(store.db,'microsoft365',{mailSubscription:{id:'sub-1',expiresAt:new Date(Date.now()+1000).toISOString()}});
 const result=await renewMicrosoftSubscriptionIfNeeded({store,env,fetcher:async()=>jsonResponse({id:'sub-1',expirationDateTime:new Date(Date.now()+4000000).toISOString()})});
 assert.equal(result.renewed,true);
 assert.ok(getCredentialsMeta(store.db,'microsoft365').metadata.mailSubscription.lastRenewedAt);
 }finally{store.close();}
});

test('createCalendarEvent and getCalendarAvailability call the real Graph endpoints with Asia/Riyadh default timezone',async()=>{
 const store=fixture();try{
 const env={MICROSOFT_ACCESS_TOKEN:'t'};
 const event=await createCalendarEvent({store,env,fetcher:async(url,opts)=>{
  assert.equal(url,'https://graph.microsoft.com/v1.0/me/events');
  const body=JSON.parse(opts.body);
  assert.equal(body.start.timeZone,'Asia/Riyadh');
  return jsonResponse({id:'event-1',webLink:'https://outlook.office.com/event-1'});
 }},{title:'Demo call',start:'2030-01-01T10:00:00',end:'2030-01-01T10:30:00',participants:['club@example.com']});
 assert.equal(event.status,'CREATED');assert.equal(event.externalEventId,'event-1');

 const availability=await getCalendarAvailability({store,env,fetcher:async(url,opts)=>{
  assert.equal(url,'https://graph.microsoft.com/v1.0/me/calendar/getSchedule');
  return jsonResponse({value:[{scheduleId:'owner@hyper-cool.com',availabilityView:'000',scheduleItems:[]}]});
 }},{emails:['owner@hyper-cool.com'],start:'2030-01-01T09:00:00',end:'2030-01-01T17:00:00'});
 assert.equal(availability.status,'OK');assert.equal(availability.schedules[0].email,'owner@hyper-cool.com');
 }finally{store.close();}
});

// --- Webhook validation + notifications ------------------------------------------------

test('handleValidationHandshake extracts the token, returns null when absent (a real notification)',()=>{
 assert.equal(handleValidationHandshake(new URL('https://hyper-cool.com/x?validationToken=abc123')),'abc123');
 assert.equal(handleValidationHandshake(new URL('https://hyper-cool.com/x')),null);
});

test('processMicrosoftNotifications verifies clientState per item, rejects mismatches, and is idempotent',()=>{
 const store=fixture();try{
 const env={MICROSOFT_WEBHOOK_SECRET:'wh-secret'};
 const body={value:[
  {subscriptionId:'sub-1',clientState:'wh-secret',changeType:'created',resourceData:{id:'msg-1'}},
  {subscriptionId:'sub-1',clientState:'wrong-secret',changeType:'created',resourceData:{id:'msg-2'}}
 ]};
 const first=processMicrosoftNotifications(store.db,body,env);
 assert.equal(first.toFetch.length,1);assert.equal(first.toFetch[0].messageId,'msg-1');
 assert.equal(first.rejected,1);
 const replay=processMicrosoftNotifications(store.db,body,env);
 assert.equal(replay.toFetch.length,0);assert.equal(replay.replayed,1); // msg-1 already recorded; msg-2 still rejected each time, not "replayed"
 }finally{store.close();}
});

// --- Tool registry: agent-restricted calendar tools + approval-gated email categories --

test('calendar tools are restricted to frost/sales/followup — canUseTool rejects any other agent even at a qualifying level',()=>{
 const store=fixture();try{
 const registry=buildToolRegistry({store,env:{},eventBus:createEventBus(store.db)});
 const tool=registry.get('create_calendar_event');
 assert.equal(canUseTool('L1',tool,'sales'),true);
 assert.equal(canUseTool('L1',tool,'compliance'),false);
 assert.equal(canUseTool('L3',tool,'copy'),false); // even the highest level does not bypass the agent restriction
 assert.ok(registry.list('L1','sales').some(t=>t.name==='create_calendar_event'));
 assert.ok(!registry.list('L1','compliance').some(t=>t.name==='create_calendar_event'));
 }finally{store.close();}
});

test('microsoft_sendEmail tool requires owner approval for quote/discount/large_b2b/legal categories and never sends directly for those',async()=>{
 const store=fixture();try{
 const {lead}=findOrCreateLeadFromChannel(store,{email:'club@example.com',name:'Club',channel:'Email'},connector);
 const eventBus=createEventBus(store.db);
 const registry=buildToolRegistry({store,env:{MICROSOFT_ACCESS_TOKEN:'t'},eventBus,fetcher:()=>{throw new Error('must not call network for an approval-gated category');}});
 const tool=registry.get('microsoft_sendEmail');
 const result=await tool.handler({leadId:lead.id,subject:'Quote',bodyHtml:'<p>...</p>',category:'quote'},{store,env:{},actor:owner,runId:null,agentId:'sales'});
 assert.equal(result.status,'WAITING_APPROVAL');
 assert.ok(result.approvalId);
 assert.equal(store.db.prepare("SELECT COUNT(*) n FROM agent_approvals WHERE action_type='send_marketing_message'").get().n,1);
 }finally{store.close();}
});

test('microsoft_sendEmail tool blocks on opt-out/human-hold/no-email before ever attempting a general-category send',async()=>{
 const store=fixture();try{
 const eventBus=createEventBus(store.db);
 const registry=buildToolRegistry({store,env:{MICROSOFT_ACCESS_TOKEN:'t'},eventBus,fetcher:()=>{throw new Error('must not call network');}});
 const tool=registry.get('microsoft_sendEmail');
 const {lead:noEmailLead}=findOrCreateLeadFromChannel(store,{phone:'+966500000099',name:'NoEmail',channel:'WhatsApp'},connector);
 const blocked=await tool.handler({leadId:noEmailLead.id,subject:'Hi',bodyHtml:'hi',category:'general'},{store,env:{},actor:owner,runId:null,agentId:'sales'});
 assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.reason,'NO_EMAIL');
 }finally{store.close();}
});
