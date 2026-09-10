import {createHmac} from 'node:crypto';
import {safeEqual} from './credentials.js';
import {fail} from '../auth.js';
import {installWebhookEvents,listWebhookEvents,storeWebhookEvent,markWebhookEventProcessed,contentHashId} from './webhook-events.js';

export {installWebhookEvents,listWebhookEvents};
/**
 * Two verification strategies because Salla's Partner Portal lets a merchant/app choose
 * either "Token" (the shared secret sent verbatim in a header) or "Signature" (HMAC-SHA256
 * of the raw body). Confirm which one your Salla app is configured with — the header names
 * and exact strategy are configurable via env rather than hardcoded, since this codebase
 * has no live Salla webhook to verify the exact convention against.
 */
export function verifySallaWebhook(req,rawBody,env) {
 const secret=env.SALLA_WEBHOOK_SECRET;
 if(!secret)fail(401,'SALLA_WEBHOOK_SECRET غير مُعد');
 const strategy=env.SALLA_WEBHOOK_STRATEGY||'token';
 if(strategy==='signature') {
  const header=(env.SALLA_WEBHOOK_SIGNATURE_HEADER||'x-salla-signature').toLowerCase();
  const provided=req.headers[header];
  if(!provided)fail(401,'ترويسة التوقيع مفقودة');
  const expected=createHmac('sha256',secret).update(rawBody).digest('hex');
  if(!safeEqual(provided,expected))fail(401,'توقيع الويبهوك غير صالح');
  return;
 }
 // 'token' strategy: the secret is sent back verbatim, conventionally in Authorization.
 const provided=req.headers['authorization']?.replace(/^Bearer\s+/i,'')||req.headers['x-salla-security-strategy']||req.headers['x-webhook-token'];
 if(!provided||!safeEqual(provided,secret))fail(401,'رمز الويبهوك غير صالح');
}
// Known Salla webhook event names → HyperCool internal event type. Anything not listed here
// is stored (for audit/observability) but never translated into a fabricated internal event
// — verify the exact event names your Salla app actually sends (Partner Portal > Webhooks)
// and extend this table rather than guessing further entries.
const EVENT_MAP={
 'product.updated':'PRODUCT_UPDATED',
 'product.created':'PRODUCT_UPDATED',
 'product.available':'PRODUCT_STOCK_UPDATED',
 'product.quantity.low':'PRODUCT_STOCK_UPDATED',
 'order.created':'ORDER_CREATED',
 'order.status.updated':'ORDER_UPDATED',
 'order.completed':'ORDER_COMPLETED'
};
function idempotencyKey(body) {
 // Prefer a real, stable identifier from the payload; a webhook delivery with no natural
 // id still gets deduped by hashing its own content, so an exact-duplicate redelivery
 // (the case idempotency exists to protect against) is still caught.
 if(body?.data?.id!=null)return `${body.event||'unknown'}:${body.data.id}:${body.created_at||''}`;
 return contentHashId(body);
}
export function processSallaWebhook({db,eventBus,body}) {
 const type=typeof body?.event==='string'?body.event:'unknown';
 const externalId=idempotencyKey(body);
 const {stored,id}=storeWebhookEvent(db,{source:'salla',externalEventId:externalId,type,payload:body});
 if(!stored)return {replayed:true,type};
 const internalType=EVENT_MAP[type];
 let emittedEventId=null;
 try {
  if(internalType && eventBus)emittedEventId=eventBus.emit(internalType,{source:'salla',sallaEvent:type,data:body?.data??null});
  markWebhookEventProcessed(db,id,internalType?'PROCESSED':'UNMAPPED');
 } catch(error) {
  markWebhookEventProcessed(db,id,'ERROR',error.message);
  throw error;
 }
 return {replayed:false,type,internalType:internalType||null,eventId:emittedEventId};
}
