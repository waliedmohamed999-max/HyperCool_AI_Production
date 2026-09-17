import {createHmac} from 'node:crypto';
import {safeEqual} from './credentials.js';
import {fail} from '../auth.js';
import {installWebhookEvents,listWebhookEvents,storeWebhookEvent,markWebhookEventProcessed} from './webhook-events.js';

// Shared by WhatsApp/Instagram/Facebook — all three are subscriptions on the SAME Meta App
// webhook mechanism (GET verification handshake + X-Hub-Signature-256 on every POST). Reuses
// the generic webhook_events table (see runtime/webhook-events.js) with source='meta'.
export {installWebhookEvents,listWebhookEvents};

// Meta's real webhook verification handshake (Meta for Developers > Webhooks): on
// subscribing, Meta sends GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
// and expects the raw challenge string echoed back if the verify token matches.
export function handleVerificationChallenge(query,env) {
 if(query.get('hub.mode')!=='subscribe')fail(400,'Unsupported hub.mode');
 if(!safeEqual(query.get('hub.verify_token')||'',env.META_VERIFY_TOKEN||''))fail(403,'Verify token mismatch');
 return query.get('hub.challenge')||'';
}
// Every POST carries X-Hub-Signature-256: sha256=<hex hmac of the raw body using the App
// Secret>. This is Meta's one real, documented mechanism — unlike Salla's ambiguous
// Token-vs-Signature choice, there is nothing to configure here.
export function verifyMetaSignature(req,rawBody,env) {
 const secret=env.META_WEBHOOK_SECRET||env.META_APP_SECRET;
 if(!secret)fail(401,'META_WEBHOOK_SECRET أو META_APP_SECRET غير مُعد');
 const header=req.headers['x-hub-signature-256'];
 if(!header||!header.startsWith('sha256='))fail(401,'ترويسة توقيع Meta مفقودة');
 const expected='sha256='+createHmac('sha256',secret).update(rawBody).digest('hex');
 if(!safeEqual(header,expected))fail(401,'توقيع ويبهوك Meta غير صالح');
}
/**
 * Normalizes one WhatsApp Business Account webhook payload (the real Meta "messages"
 * webhook shape: entry[].changes[].value.messages[] for inbound, .statuses[] for delivery
 * updates) into plain {phone, name, externalMessageId, text, messageType, media} records
 * the caller (the /api/webhooks/meta/whatsapp route) turns into real CRM messages. Every
 * individual message/status is deduped through the shared webhook_events ledger, so a
 * redelivered webhook (which can bundle already-seen items alongside new ones) never
 * double-processes just the ones it already saw.
 *
 * Multi-Tenant Phase 3.5 (Part B10): each `value` carries Meta's own `metadata.phone_number_id`
 * — the real WhatsApp Business number the message was sent to — which `resolveTenant` (see
 * webhook-tenant-resolver.js's resolveTenantForWhatsAppPhoneNumberId) maps to the tenant that
 * actually connected that number. Resolved per `value`, not once for the whole delivery,
 * since a single webhook POST can in principle batch entries for more than one connected
 * number. A `value` whose phone_number_id resolves to no tenant is still recorded (never
 * lost) but marked `unresolved: true` and never turned into a real CRM message.
 */
export function normalizeWhatsAppWebhook(db,body,resolveTenant) {
 const results={messages:[],statuses:[],skipped:0};
 for(const entry of body?.entry||[]) {
  for(const change of entry.changes||[]) {
   const value=change.value||{};
   const contact=value.contacts?.[0];
   const tenantId=resolveTenant(value.metadata?.phone_number_id||null);
   for(const msg of value.messages||[]) {
    if(!tenantId) {
     storeWebhookEvent(db,{source:'meta',externalEventId:msg.id,type:'whatsapp.message',payload:msg,unresolved:true});
     results.messages.push({replayed:false,unresolved:true,externalMessageId:msg.id});
     continue;
    }
    const {stored,id}=storeWebhookEvent(db,{source:'meta',externalEventId:msg.id,type:'whatsapp.message',payload:msg,tenantId});
    if(!stored){results.messages.push({replayed:true,externalMessageId:msg.id});continue;}
    try {
     const normalized=normalizeInboundMessage(msg,contact);
     markWebhookEventProcessed(db,id,'PROCESSED');
     results.messages.push({replayed:false,tenantId,...normalized});
    } catch(error) {markWebhookEventProcessed(db,id,'ERROR',error.message);results.messages.push({replayed:false,error:error.message,externalMessageId:msg.id});}
   }
   for(const status of value.statuses||[]) {
    if(!tenantId) {
     storeWebhookEvent(db,{source:'meta',externalEventId:status.id+':'+status.status,type:'whatsapp.status',payload:status,unresolved:true});
     results.statuses.push({replayed:false,unresolved:true});
     continue;
    }
    const {stored,id}=storeWebhookEvent(db,{source:'meta',externalEventId:status.id+':'+status.status,type:'whatsapp.status',payload:status,tenantId});
    if(!stored){results.statuses.push({replayed:true});continue;}
    markWebhookEventProcessed(db,id,'PROCESSED');
    results.statuses.push({replayed:false,externalMessageId:status.id,status:status.status.toUpperCase(),errorCode:status.errors?.[0]?.title||null});
   }
   if(!value.messages?.length && !value.statuses?.length)results.skipped++;
  }
 }
 return results;
}
function normalizeInboundMessage(msg,contact) {
 const phone='+'+String(msg.from||'').replace(/^\+/,'');
 const name=contact?.profile?.name||null;
 const base={phone,name,externalMessageId:msg.id};
 if(msg.type==='text')return {...base,messageType:'text',text:msg.text?.body||''};
 if(msg.type==='button')return {...base,messageType:'button_reply',text:msg.button?.text||''};
 if(msg.type==='interactive')return {...base,messageType:'interactive_reply',text:msg.interactive?.button_reply?.title||msg.interactive?.list_reply?.title||''};
 if(['image','document','audio','video','sticker'].includes(msg.type))return {...base,messageType:'media',text:'',media:{kind:msg.type,id:msg[msg.type]?.id||null,mimeType:msg[msg.type]?.mime_type||null,caption:msg[msg.type]?.caption||null}};
 if(msg.type==='location')return {...base,messageType:'location',text:'',media:{kind:'location',latitude:msg.location?.latitude,longitude:msg.location?.longitude,name:msg.location?.name||null}};
 // Any message type not explicitly handled is still recorded honestly as MEDIA_RECEIVED
 // with metadata only — never analyzed or guessed at, per the integration spec.
 return {...base,messageType:'unsupported',text:'',media:{kind:msg.type}};
}

// Phase MKT-2, Part I — Facebook Messenger and Instagram DMs share the EXACT SAME webhook
// shape (`entry[].messaging[]` with sender/recipient/message), the only difference being
// `body.object` ('page' vs 'instagram') and which connected id `entry.id` resolves against
// (see webhook-tenant-resolver.js's resolveTenantForMetaPageId). `platform` is derived from
// `body.object` so the caller can record the right CRM channel ('Facebook' vs 'Instagram')
// without guessing from the payload shape itself.
export function normalizeMetaMessagingWebhook(db,body,resolveTenant) {
 const platform=body?.object==='instagram'?'Instagram':'Facebook';
 const results={messages:[],skipped:0};
 for(const entry of body?.entry||[]) {
  const tenantId=resolveTenant(entry.id||null);
  for(const event of entry.messaging||[]) {
   const message=event.message;
   if(!message||message.is_echo) {results.skipped++;continue;} // an echo of our OWN outbound send, never treated as inbound
   const externalMessageId=message.mid;
   if(!tenantId) {
    storeWebhookEvent(db,{source:'meta',externalEventId:externalMessageId,type:platform.toLowerCase()+'.message',payload:event,unresolved:true});
    results.messages.push({replayed:false,unresolved:true,externalMessageId});
    continue;
   }
   const {stored,id}=storeWebhookEvent(db,{source:'meta',externalEventId:externalMessageId,type:platform.toLowerCase()+'.message',payload:event,tenantId});
   if(!stored){results.messages.push({replayed:true,externalMessageId});continue;}
   try {
    const senderId=event.sender?.id||null;
    if(!senderId)throw new Error('NO_SENDER_ID');
    markWebhookEventProcessed(db,id,'PROCESSED');
    results.messages.push({replayed:false,tenantId,platform,senderId,externalMessageId,text:message.text||'',messageType:message.attachments?.length?'media':'text',media:message.attachments?.length?{kind:message.attachments[0].type,url:message.attachments[0].payload?.url||null}:null});
   } catch(error) {markWebhookEventProcessed(db,id,'ERROR',error.message);results.messages.push({replayed:false,error:error.message,externalMessageId});}
  }
 }
 return results;
}
/**
 * Facebook/Instagram comment webhooks arrive as `entry[].changes[]` with `field==='comments'`
 * — a genuinely different shape from DMs (no `messaging[]` array). "Supported comments/
 * replies" per the spec means: real, verified, deduped intake into the SAME CRM/lead model —
 * NOT an automatic public reply, which stays out of scope here exactly like every other
 * outbound action in this codebase (always a separate, gated tool call).
 */
export function normalizeMetaCommentWebhook(db,body,resolveTenant) {
 const platform=body?.object==='instagram'?'Instagram':'Facebook';
 const results={comments:[],skipped:0};
 for(const entry of body?.entry||[]) {
  const tenantId=resolveTenant(entry.id||null);
  for(const change of entry.changes||[]) {
   if(change.field!=='comments'){results.skipped++;continue;}
   const value=change.value||{};
   const externalCommentId=value.comment_id;
   if(!tenantId) {
    storeWebhookEvent(db,{source:'meta',externalEventId:externalCommentId,type:platform.toLowerCase()+'.comment',payload:value,unresolved:true});
    results.comments.push({replayed:false,unresolved:true,externalCommentId});
    continue;
   }
   const {stored,id}=storeWebhookEvent(db,{source:'meta',externalEventId:externalCommentId,type:platform.toLowerCase()+'.comment',payload:value,tenantId});
   if(!stored){results.comments.push({replayed:true,externalCommentId});continue;}
   try {
    const senderId=value.from?.id||null;
    if(!senderId)throw new Error('NO_SENDER_ID');
    markWebhookEventProcessed(db,id,'PROCESSED');
    results.comments.push({replayed:false,tenantId,platform,senderId,externalCommentId,text:value.text||'',postId:value.post_id||value.media?.id||null});
   } catch(error) {markWebhookEventProcessed(db,id,'ERROR',error.message);results.comments.push({replayed:false,error:error.message,externalCommentId});}
  }
 }
 return results;
}
