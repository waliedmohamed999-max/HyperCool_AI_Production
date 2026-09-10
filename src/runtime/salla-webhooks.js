import {randomUUID,createHmac} from 'node:crypto';
import {safeEqual} from './credentials.js';
import {fail} from '../auth.js';

export function installWebhookEvents(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, external_event_id TEXT NOT NULL, type TEXT NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT, error TEXT,
  UNIQUE(source,external_event_id)
 );`);
}
export function listWebhookEvents(db,{source,limit=50}={}) {
 return source?db.prepare('SELECT * FROM webhook_events WHERE source=? ORDER BY received_at DESC LIMIT ?').all(source,limit)
  :db.prepare('SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?').all(limit);
}
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
 return createHmac('sha256','webhook-fallback-key').update(JSON.stringify(body||{})).digest('hex');
}
export function processSallaWebhook({db,eventBus,body}) {
 const type=typeof body?.event==='string'?body.event:'unknown';
 const externalId=idempotencyKey(body);
 const row={id:randomUUID(),source:'salla',externalEventId:externalId,type,payload:JSON.stringify(body),status:'RECEIVED',receivedAt:new Date().toISOString()};
 const result=db.prepare('INSERT OR IGNORE INTO webhook_events (id,source,external_event_id,type,payload,status,received_at) VALUES (?,?,?,?,?,?,?)')
  .run(row.id,row.source,row.externalEventId,row.type,row.payload,row.status,row.receivedAt);
 if(result.changes===0)return {replayed:true,type};
 const internalType=EVENT_MAP[type];
 let emittedEventId=null;
 try {
  if(internalType && eventBus) {
   emittedEventId=eventBus.emit(internalType,{source:'salla',sallaEvent:type,data:body?.data??null});
  }
  db.prepare('UPDATE webhook_events SET status=?,processed_at=? WHERE id=?').run(internalType?'PROCESSED':'UNMAPPED',new Date().toISOString(),row.id);
 } catch(error) {
  db.prepare('UPDATE webhook_events SET status=?,processed_at=?,error=? WHERE id=?').run('ERROR',new Date().toISOString(),error.message,row.id);
  throw error;
 }
 return {replayed:false,type,internalType:internalType||null,eventId:emittedEventId};
}
