// Universal Integration Platform (Phase 6G, Part 39-42) — Connection/Connector Usage
// Analytics. Every number here is a real, live aggregate over the EXISTING audit log
// (`CONNECTOR_ACTION_EXECUTED`/`CONNECTOR_ACTION_FAILED`, already recorded by
// src/connectors/core/runtime.js) and the EXISTING webhook ledger
// (`runtime/webhook-events.js`) — never a second metrics table, never a fabricated number
// (Part 42: this is operational visibility only, explicitly NOT a billing meter).
import {getConnection} from '../integrations/connections.js';

const WINDOW_HOURS={'24h':24,'7d':24*7,'30d':24*30};
// Part 40 — a bounded scan window; consistent with this codebase's own documented
// "fine at pilot scale, revisit before thousands of audit rows" performance note
// (application.js's connection-action-history route carries the identical caveat).
const MAX_ROWS_SCANNED=20000;

function cutoffIso(window) {
 const hours=WINDOW_HOURS[window]||WINDOW_HOURS['7d'];
 return new Date(Date.now()-hours*3600*1000).toISOString();
}
const ACTION_ROWS=`SELECT tenant_id,item_id,created_at,json FROM audit_logs WHERE action IN ('CONNECTOR_ACTION_EXECUTED','CONNECTOR_ACTION_FAILED') AND created_at>=? ORDER BY created_at DESC LIMIT ?`;

/** Part 39/40 — ONE tenant's own connection: real call counts/latency/webhook activity within
 * a 24h/7d/30d window, tenant-scoped throughout (never leaks another tenant's numbers). */
export function getConnectionUsage(db,tenantId,connectionId,window='7d') {
 const connection=getConnection(db,connectionId,tenantId);
 const cutoff=cutoffIso(window);
 const rows=db.prepare('SELECT item_id,created_at,json FROM audit_logs WHERE tenant_id=? AND action IN (?,?) AND item_id=? AND created_at>=? ORDER BY created_at DESC LIMIT ?')
  .all(tenantId,'CONNECTOR_ACTION_EXECUTED','CONNECTOR_ACTION_FAILED',connectionId,cutoff,MAX_ROWS_SCANNED);
 let success=0,failure=0,latencySum=0,latencyCount=0,lastUsedAt=null;
 for(const row of rows) {
  const entry=JSON.parse(row.json);
  if(entry.status==='OK')success++; else failure++;
  if(Number.isFinite(entry.latencyMs)){latencySum+=entry.latencyMs;latencyCount++;}
  if(!lastUsedAt||row.created_at>lastUsedAt)lastUsedAt=row.created_at;
 }
 const source=`connector:${connection.integrationDefinitionId}`;
 const webhookReceived=db.prepare('SELECT COUNT(*) c FROM webhook_events WHERE tenant_id=? AND source=? AND received_at>=?').get(tenantId,source,cutoff).c;
 const webhookFailed=db.prepare("SELECT COUNT(*) c FROM webhook_events WHERE tenant_id=? AND source=? AND status='FAILED' AND received_at>=?").get(tenantId,source,cutoff).c;
 return {
  window,actionCalls:success+failure,success,failure,
  averageLatencyMs:latencyCount?Math.round(latencySum/latencyCount):null,
  lastUsedAt,webhookReceived,webhookFailed
 };
}

/** Part 41 — a Platform Admin's Connector Analytics: aggregated across EVERY tenant that has a
 * connection to this connector — a genuinely cross-tenant read, so it deliberately bypasses
 * `listAuditLog`'s own always-tenant-scoped default (see audit.js) via a direct, bounded query,
 * then attributes each row to this specific connector by its own `connectorSlug` field (the
 * same field `CONNECTOR_ACTION_EXECUTED`/`_FAILED` entries already carry — never re-deriving it
 * from a guess). */
export function getConnectorAnalytics(db,slug,window='7d') {
 const cutoff=cutoffIso(window);
 const connectionsCount=db.prepare('SELECT COUNT(*) c FROM integration_connections WHERE integration_definition_id=?').get(slug).c;
 const activeTenants=db.prepare("SELECT COUNT(DISTINCT tenant_id) c FROM integration_connections WHERE integration_definition_id=? AND status IN ('CONNECTED','DEGRADED')").get(slug).c;
 const healthDistribution=Object.fromEntries(
  db.prepare('SELECT status,COUNT(*) c FROM integration_connections WHERE integration_definition_id=? GROUP BY status').all(slug).map(r=>[r.status,r.c])
 );
 const rows=db.prepare(ACTION_ROWS).all(cutoff,MAX_ROWS_SCANNED);
 let calls=0,failures=0;
 for(const row of rows) {
  const entry=JSON.parse(row.json);
  if(entry.connectorSlug!==slug)continue;
  calls++;
  if(entry.status!=='OK')failures++;
 }
 return {slug,window,connectionsCount,activeTenants,calls,failures,healthDistribution};
}
