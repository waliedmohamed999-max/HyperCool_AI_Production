import {randomUUID,createHmac} from 'node:crypto';

// Generic inbound-webhook ledger shared by every provider (Salla today, Meta/WhatsApp
// now) — one table, one idempotency mechanism, never a second copy per provider. `source`
// distinguishes providers; `external_event_id` is unique PER source, so the same id from
// two different providers can never collide.
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
// Stores one delivery, ignoring it (changes===0) if this exact (source, externalEventId)
// was already recorded — the redelivery-safe core every webhook route builds on.
export function storeWebhookEvent(db,{source,externalEventId,type,payload}) {
 const row={id:randomUUID(),source,externalEventId,type,payload:JSON.stringify(payload),status:'RECEIVED',receivedAt:new Date().toISOString()};
 const result=db.prepare('INSERT OR IGNORE INTO webhook_events (id,source,external_event_id,type,payload,status,received_at) VALUES (?,?,?,?,?,?,?)')
  .run(row.id,row.source,row.externalEventId,row.type,row.payload,row.status,row.receivedAt);
 return {stored:result.changes>0,id:row.id};
}
export function markWebhookEventProcessed(db,id,status,error=null) {
 db.prepare('UPDATE webhook_events SET status=?,processed_at=?,error=? WHERE id=?').run(status,new Date().toISOString(),error,id);
}
// A stable fallback identifier for providers whose payload has no natural event id — hashes
// the payload itself, so an exact-duplicate redelivery (the case idempotency protects
// against) is still caught even without one.
export function contentHashId(payload) {
 return createHmac('sha256','webhook-fallback-key').update(JSON.stringify(payload||{})).digest('hex');
}
