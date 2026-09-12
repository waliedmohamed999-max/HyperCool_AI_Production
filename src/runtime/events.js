import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {resolveActiveTenantId} from '../tenancy.js';

// The fixed vocabulary from the spec. Anything else is a programming error, not a runtime one.
export const EVENT_TYPES=[
 'CUSTOMER_MESSAGE_RECEIVED','LEAD_CREATED','LEAD_QUALIFIED','LEAD_HOT','QUOTE_REQUESTED','QUOTE_SENT',
 'ORDER_CREATED','ORDER_UPDATED','ORDER_COMPLETED','CART_ABANDONED','CONTENT_IDEA_CREATED','CONTENT_COPY_READY',
 'CONTENT_COMPLIANCE_PASSED','CONTENT_APPROVED','CONTENT_PUBLISHED','FOLLOWUP_DUE','AGENT_RUN_FAILED',
 // Emitted by planning.js's prepareDue the moment a scheduled job actually becomes due AND
 // still passes every approval/hash check (READY_FOR_CONNECTOR) — this is what turns a
 // schedule into a real publish attempt; see orchestrator.js's route to the 'publishing'
 // agent. Never fired for a job that becomes BLOCKED instead.
 'CONTENT_PUBLISH_REQUESTED',
 'INTEGRATION_FAILED','COMPETITOR_SIGNAL_FOUND','DAILY_BRIEF_REQUIRED','WEEKLY_REPORT_REQUIRED',
 // Real Salla webhook-derived events (src/runtime/salla-webhooks.js) — not yet consumed by
 // any agent route in orchestrator.js; they exist so the event IS real and observable
 // (Operations Log, /api/events) even before a specific agent reacts to them.
 'PRODUCT_UPDATED','PRODUCT_STOCK_UPDATED',
 // Emitted the moment src/crm.js detects an opt-out (manual entry or channel webhook) —
 // stopFollowups() already runs synchronously in the same call, so no agent needs to react
 // to this to make opt-out effective; it exists for observability/audit and so a future
 // handler (e.g. cross-channel opt-out propagation) has a real event to subscribe to.
 'CUSTOMER_OPTED_OUT',
 // Phase 6D, Part 44/51/54 — a real, explicit, reviewed addition (never invented silently for
 // a demo): backs the real `accounting.invoices.read`/write capability category and the Acme
 // ERP Builder proof connector's `invoice_created` webhook trigger. No existing event type
 // (ORDER_*, QUOTE_*, ...) is semantically an invoice — this is genuinely new, not a reuse.
 'INVOICE_CREATED'
];

// Multi-Tenant Phase 2 (spec Part 10 — Event Bus isolation). `tenant_id` is a real,
// queryable column, not just a payload field, resolved the same optional way as
// everywhere else: a caller that includes `tenantId` in its payload gets that value
// stored; one that doesn't (most of today's 12 emit() call sites, several of which are
// tied to still-globally-scoped content — see docs/MULTI_TENANT_ARCHITECTURE.md) gets the
// one real tenant that exists today, never a fabricated or wrong value.
export function installEvents(db) {
 const legacy=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_events'").get();
 if(legacy) {
  const columns=db.prepare('PRAGMA table_info(agent_events)').all().map(c=>c.name);
  if(!columns.includes('tenant_id'))db.exec('ALTER TABLE agent_events ADD COLUMN tenant_id TEXT');
 } else {
  db.exec('CREATE TABLE IF NOT EXISTS agent_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, run_id TEXT, tenant_id TEXT, created_at TEXT NOT NULL);');
 }
 db.exec('CREATE INDEX IF NOT EXISTS idx_agent_events_tenant ON agent_events(tenant_id);');
 const unresolved=db.prepare('SELECT COUNT(*) n FROM agent_events WHERE tenant_id IS NULL').get().n;
 if(unresolved>0)db.prepare('UPDATE agent_events SET tenant_id=? WHERE tenant_id IS NULL').run(resolveActiveTenantId(db));
}
export function listEvents(db,{type,limit=50}={},tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 if(type)return db.prepare('SELECT * FROM agent_events WHERE type=? AND tenant_id=? ORDER BY rowid DESC LIMIT ?').all(type,resolvedTenantId,limit);
 return db.prepare('SELECT * FROM agent_events WHERE tenant_id=? ORDER BY rowid DESC LIMIT ?').all(resolvedTenantId,limit);
}

/**
 * In-process pub/sub, persisted for audit/observability. emit() never throws on a
 * handler failure (one bad subscriber must not break the publisher or the others);
 * Frost subscribes here to route events to agents.
 */
export function createEventBus(db) {
 const emitter=new EventEmitter();
 emitter.setMaxListeners(50);
 function emit(type,payload={},runId=null) {
  if(!EVENT_TYPES.includes(type))throw new Error('Unknown event type: '+type);
  const tenantId=payload.tenantId||resolveActiveTenantId(db);
  const row={id:randomUUID(),type,payload:JSON.stringify(payload),run_id:runId,tenant_id:tenantId,created_at:new Date().toISOString()};
  db.prepare('INSERT INTO agent_events (id,type,payload,run_id,tenant_id,created_at) VALUES (?,?,?,?,?,?)').run(row.id,row.type,row.payload,row.run_id,row.tenant_id,row.created_at);
  emitter.emit(type,{...payload,tenantId,__eventId:row.id,__runId:runId});
  return row.id;
 }
 function on(type,handler) {
  emitter.on(type,async payload=>{try{await handler(payload);}catch(error){emit('AGENT_RUN_FAILED',{source:'event_handler',type,message:error.message,tenantId:payload.tenantId});}});
 }
 return {emit,on,list:(opts,tenantId)=>listEvents(db,opts,tenantId)};
}
