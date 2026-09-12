import {randomUUID,createHmac} from 'node:crypto';
import {resolveActiveTenantId} from '../tenancy.js';

// Generic inbound-webhook ledger shared by every provider (Salla today, Meta/WhatsApp
// now) — one table, one idempotency mechanism, never a second copy per provider. `source`
// distinguishes providers; `external_event_id` is unique PER source, so the same id from
// two different providers can never collide.
//
// Multi-Tenant Phase 2 (spec Part 18): a real `tenant_id` column exists and is backfilled,
// but FULL webhook-to-tenant ROUTING (resolving which tenant a delivery belongs to from the
// provider's own account/store/phone-number id — never trusting the payload's own claim of
// who it's for) is NOT implemented this pass: today's `integration_credentials` model still
// allows only one connection per provider per tenant with no lookup-by-external-account-id
// helper yet, so every delivery resolves to the one real tenant that exists (correct today,
// not yet load-bearing for a genuine second tenant with its own Salla/Meta connection — see
// docs/MULTI_TENANT_ARCHITECTURE.md).
export function installWebhookEvents(db) {
 const legacy=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='webhook_events'").get();
 if(legacy) {
  const columns=db.prepare('PRAGMA table_info(webhook_events)').all().map(c=>c.name);
  // This backfill must run ONLY the one time the column is actually being added (a genuine
  // pre-Phase-2 row has no tenant to fall back to but a real one, chosen once, forever) — it
  // must NEVER run unconditionally on every boot (Phase 3.5 change): a legitimately
  // TENANT_UNRESOLVED row (see storeWebhookEvent's `unresolved` flag below) also has a NULL
  // tenant_id, and silently "fixing" it on the next restart would erase the exact signal
  // this phase was built to preserve — and would throw TENANT_CONTEXT_REQUIRED and break
  // boot entirely the moment a second tenant exists.
  if(!columns.includes('tenant_id')) {
   db.exec('ALTER TABLE webhook_events ADD COLUMN tenant_id TEXT');
   db.prepare('UPDATE webhook_events SET tenant_id=? WHERE tenant_id IS NULL').run(resolveActiveTenantId(db));
  }
 } else {
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_events (
   id TEXT PRIMARY KEY, tenant_id TEXT, source TEXT NOT NULL, external_event_id TEXT NOT NULL, type TEXT NOT NULL,
   payload TEXT NOT NULL, status TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT, error TEXT,
   UNIQUE(source,external_event_id)
  );`);
 }
 db.exec('CREATE INDEX IF NOT EXISTS idx_webhook_events_tenant ON webhook_events(tenant_id);');
 // Phase 6G, Part 16 — Safe Reprocess needs the ORIGINAL raw body to re-run mapping/dispatch
 // against. The happy path (PROCESSED/DUPLICATE) still never persists it — Part 76/77 of
 // Phase 6C's own design note stands unchanged for the 99% success case; this column is only
 // ever populated when a delivery genuinely FAILS mapping (see generic-webhook/webhook.js),
 // specifically so that one delivery — and only that one — becomes safely reprocessable.
 const columns=db.prepare('PRAGMA table_info(webhook_events)').all().map(c=>c.name);
 if(!columns.includes('raw_payload'))db.exec('ALTER TABLE webhook_events ADD COLUMN raw_payload TEXT');
}
export function listWebhookEvents(db,{source,limit=50}={},tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 return source?db.prepare('SELECT * FROM webhook_events WHERE source=? AND tenant_id=? ORDER BY received_at DESC LIMIT ?').all(source,resolvedTenantId,limit)
  :db.prepare('SELECT * FROM webhook_events WHERE tenant_id=? ORDER BY received_at DESC LIMIT ?').all(resolvedTenantId,limit);
}
// Stores one delivery, ignoring it (changes===0) if this exact (source, externalEventId)
// was already recorded — the redelivery-safe core every webhook route builds on.
//
// Multi-Tenant Phase 3.5 (Part B7): `unresolved:true` is how a caller that has genuinely
// verified the delivery but could not map it to any tenant (an unknown WhatsApp
// phone_number_id, an unknown Microsoft subscriptionId, a Salla merchant with no
// unambiguous match — see webhook-tenant-resolver.js) records that fact honestly: `tenant_id`
// stays NULL (the column has always allowed this) and `status` is the diagnostic
// 'TENANT_UNRESOLVED', never a guessed tenant. This is the only place in the codebase a
// tenant-scoped write is allowed to store a NULL tenant_id — every other caller either
// supplies a real tenantId or accepts the fail-closed `resolveActiveTenantId` default.
export function storeWebhookEvent(db,{source,externalEventId,type,payload,tenantId=null,unresolved=false}) {
 const resolvedTenantId=unresolved?null:(tenantId||resolveActiveTenantId(db));
 const row={id:randomUUID(),tenantId:resolvedTenantId,source,externalEventId,type,payload:JSON.stringify(payload),status:unresolved?'TENANT_UNRESOLVED':'RECEIVED',receivedAt:new Date().toISOString()};
 const result=db.prepare('INSERT OR IGNORE INTO webhook_events (id,tenant_id,source,external_event_id,type,payload,status,received_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(row.id,row.tenantId,row.source,row.externalEventId,row.type,row.payload,row.status,row.receivedAt);
 return {stored:result.changes>0,id:row.id};
}
export function markWebhookEventProcessed(db,id,status,error=null,rawPayload=undefined) {
 if(rawPayload!==undefined)
  db.prepare('UPDATE webhook_events SET status=?,processed_at=?,error=?,raw_payload=? WHERE id=?').run(status,new Date().toISOString(),error,rawPayload===null?null:JSON.stringify(rawPayload),id);
 else
  db.prepare('UPDATE webhook_events SET status=?,processed_at=?,error=? WHERE id=?').run(status,new Date().toISOString(),error,id);
}
export function getWebhookEventById(db,id,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 return db.prepare('SELECT * FROM webhook_events WHERE id=? AND tenant_id=?').get(id,resolvedTenantId)||null;
}
export function listFailedWebhookEvents(db,tenantId,{source=null,limit=50}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 return source
  ?db.prepare("SELECT * FROM webhook_events WHERE tenant_id=? AND source=? AND status='FAILED' ORDER BY received_at DESC LIMIT ?").all(resolvedTenantId,source,limit)
  :db.prepare("SELECT * FROM webhook_events WHERE tenant_id=? AND status='FAILED' ORDER BY received_at DESC LIMIT ?").all(resolvedTenantId,limit);
}
/** Part 16 — atomic, CAS-guarded status transition (`WHERE status=fromStatus`): two concurrent
 * "Reprocess" clicks can never both report success, and a row that already moved on (e.g.
 * another operator's click landed first) is honestly reported as such rather than silently
 * double-processed. Returns true only if THIS call actually performed the transition. */
export function transitionWebhookEventStatus(db,id,tenantId,{fromStatus,toStatus,error=null}) {
 const result=db.prepare('UPDATE webhook_events SET status=?,processed_at=?,error=? WHERE id=? AND tenant_id=? AND status=?')
  .run(toStatus,new Date().toISOString(),error,id,tenantId,fromStatus);
 return result.changes>0;
}
// A stable fallback identifier for providers whose payload has no natural event id — hashes
// the payload itself, so an exact-duplicate redelivery (the case idempotency protects
// against) is still caught even without one.
export function contentHashId(payload) {
 return createHmac('sha256','webhook-fallback-key').update(JSON.stringify(payload||{})).digest('hex');
}
