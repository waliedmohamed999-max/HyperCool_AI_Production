import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {getIntegrationDefinition} from './definitions.js';
import {effectivePlanForTenantId,planAllowsIntegration} from '../plans.js';

// IntegrationConnection — Multi-Tenant Phase 4A, Part 4/5/6. Per-tenant, and — the whole
// point of this phase — MULTIPLE per (tenant, provider): a tenant can hold "Main Store" and
// "Riyadh Store" as two independent `salla` connections, "Sales Number" and "Support Number"
// as two independent `whatsapp` connections, and so on. There is deliberately no
// UNIQUE(tenant_id, integration_definition_id) constraint here — that was the OLD
// `integration_credentials` model this phase replaces.
//
// Uniqueness that IS enforced: the same real external account can never belong to two
// different tenants (a partial unique index on (integration_definition_id,
// external_account_id) where external_account_id is known) — this is a real security
// boundary, not a convenience constraint. It does NOT apply while external_account_id is
// still NULL (before identity is resolved), since multiple such rows are expected during
// the connect flow.
export function installIntegrationConnections(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS integration_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  integration_definition_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('NOT_CONFIGURED','CONNECTING','CONNECTED','DEGRADED','ERROR','TOKEN_EXPIRED','PERMISSION_MISSING','DISCONNECTED')),
  external_account_id TEXT,
  external_account_type TEXT,
  external_account_name TEXT,
  external_account_metadata TEXT,
  scopes TEXT,
  connected_by TEXT,
  connected_at TEXT,
  last_health_check TEXT,
  last_success_at TEXT,
  last_error_at TEXT,
  last_error_code TEXT,
  last_error_message_safe TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_integration_connections_tenant ON integration_connections(tenant_id);
 CREATE INDEX IF NOT EXISTS idx_integration_connections_tenant_def ON integration_connections(tenant_id,integration_definition_id);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_connections_external_account ON integration_connections(integration_definition_id,external_account_id) WHERE external_account_id IS NOT NULL;
 CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_connections_one_default ON integration_connections(tenant_id,integration_definition_id) WHERE is_default=1;`);
 // Phase 6C (Part 4) — an unguessable, non-sequential public identifier a webhook-capable
 // connection can be reached by, so /api/webhooks/connectors/:publicId never exposes this
 // table's real (sequential-feeling, cross-referenceable) primary key. Nullable and generated
 // lazily (getOrCreateWebhookPublicId, webhook.js) — most connections never need one.
 const columns=db.prepare('PRAGMA table_info(integration_connections)').all().map(c=>c.name);
 if(!columns.includes('webhook_public_id'))db.exec('ALTER TABLE integration_connections ADD COLUMN webhook_public_id TEXT');
 db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_connections_webhook_public_id ON integration_connections(webhook_public_id) WHERE webhook_public_id IS NOT NULL;');
 // Phase 6D originally added this column from installDynamicConnectorTables (store.js) — moved
 // here too (Phase 6G) so it exists for ANY test/bootstrap path that installs this table without
 // also installing the dynamic-connector tables; `updateConnection` below always writes it.
 if(!columns.includes('connector_version'))db.exec('ALTER TABLE integration_connections ADD COLUMN connector_version INTEGER');
}
function hydrate(row) {
 return {
  id:row.id,tenantId:row.tenant_id,integrationDefinitionId:row.integration_definition_id,name:row.name,status:row.status,
  externalAccountId:row.external_account_id,externalAccountType:row.external_account_type,externalAccountName:row.external_account_name,
  externalAccountMetadata:row.external_account_metadata?JSON.parse(row.external_account_metadata):null,
  scopes:row.scopes?JSON.parse(row.scopes):[],connectedBy:row.connected_by,connectedAt:row.connected_at,
  lastHealthCheck:row.last_health_check,lastSuccessAt:row.last_success_at,lastErrorAt:row.last_error_at,
  lastErrorCode:row.last_error_code,lastErrorMessageSafe:row.last_error_message_safe,
  isDefault:!!row.is_default,createdAt:row.created_at,updatedAt:row.updated_at,
  webhookPublicId:row.webhook_public_id||null,connectorVersion:row.connector_version??null
 };
}
/** Creates a new, empty (NOT_CONFIGURED) connection — never with a credential attached; that's the Vault's job. */
export function createConnection(db,{integrationDefinitionId,name,connectedBy=null},tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const definition=getIntegrationDefinition(db,integrationDefinitionId);
 if(!definition)fail(400,'تكامل غير معروف');
 // Universal Integration Platform (Phase 6D, Part 41) — a DISABLED connector blocks new
 // connections outright; a DRAFT one was never published and is therefore never tenant-visible
 // in the first place (getTenantCatalog filters it out) — this is the one enforcement point a
 // tenant's own createConnection call can never bypass regardless of how it learned the slug.
 if(definition.status==='DISABLED')fail(400,'هذا التكامل معطَّل حاليًا من قِبل مسؤول المنصة (DISABLED)');
 if(definition.status==='DRAFT')fail(400,'هذا التكامل لا يزال مسودة ولم يُنشر بعد');
 // Packages (src/plans.js) — a tenant's plan may not include this integration (e.g. Starter
 // only includes WhatsApp). A tenant with no assigned plan is unrestricted (grandfather rule).
 const plan=effectivePlanForTenantId(db,resolvedTenantId);
 if(!planAllowsIntegration(plan,definition))fail(403,'هذا التكامل غير متاح في باقتك الحالية — يمكنك الترقية من صفحة الباقات');
 const id=randomUUID(),now=new Date().toISOString();
 const isDefault=db.prepare('SELECT COUNT(*) n FROM integration_connections WHERE tenant_id=? AND integration_definition_id=?').get(resolvedTenantId,integrationDefinitionId).n===0?1:0;
 db.prepare(`INSERT INTO integration_connections (id,tenant_id,integration_definition_id,name,status,connected_by,is_default,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run(id,resolvedTenantId,integrationDefinitionId,name,'NOT_CONFIGURED',connectedBy,isDefault,now,now);
 return getConnection(db,id,resolvedTenantId);
}
export function listConnections(db,{integrationDefinitionId}={},tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const rows=integrationDefinitionId
  ?db.prepare('SELECT * FROM integration_connections WHERE tenant_id=? AND integration_definition_id=? ORDER BY created_at').all(resolvedTenantId,integrationDefinitionId)
  :db.prepare('SELECT * FROM integration_connections WHERE tenant_id=? ORDER BY integration_definition_id,created_at').all(resolvedTenantId);
 return rows.map(hydrate);
}
// Throws 404 exactly like every other tenant-scoped getter in this codebase (getLead,
// getContent, ...) — a wrong-tenant connection id is indistinguishable from one that never
// existed.
export function getConnection(db,id,tenantId=null) {
 const row=db.prepare('SELECT * FROM integration_connections WHERE id=? AND tenant_id=?').get(id,tenantId||resolveActiveTenantId(db));
 if(!row)fail(404,'الاتصال غير موجود');
 return hydrate(row);
}
export function getConnectionOrNull(db,id,tenantId=null) {
 const row=db.prepare('SELECT * FROM integration_connections WHERE id=? AND tenant_id=?').get(id,tenantId||resolveActiveTenantId(db));
 return row?hydrate(row):null;
}
/**
 * Phase 6C (Part 5) — the ONE lookup a generic inbound webhook route is allowed to use: no
 * tenant filter, because the whole point of a public webhook id is that the caller (an
 * external platform) has no session/tenant context at all — the tenant is resolved FROM this
 * row, never supplied by the caller. Never trust a tenant_id/tenantId the request itself claims.
 */
export function getConnectionByPublicId(db,publicId) {
 if(!publicId)return null;
 const row=db.prepare('SELECT * FROM integration_connections WHERE webhook_public_id=?').get(publicId);
 return row?hydrate(row):null;
}
/** Lazily assigns a real, cryptographically random public id the first time one is needed —
 * most connections never call this. Idempotent: returns the existing one if already set. */
export function getOrCreateWebhookPublicId(db,id,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const current=getConnection(db,id,resolvedTenantId);
 if(current.webhookPublicId)return current.webhookPublicId;
 const publicId=randomUUID().replace(/-/g,'');
 db.prepare('UPDATE integration_connections SET webhook_public_id=?,updated_at=? WHERE id=? AND tenant_id=?').run(publicId,new Date().toISOString(),id,resolvedTenantId);
 return publicId;
}
/** Phase 6G, Part 10 — Webhook Console "Rotate URL": UNCONDITIONALLY replaces the public id
 * (unlike the lazy get-or-create above) so the OLD url stops resolving to anything immediately —
 * `getConnectionByPublicId` looks up by exact value, so once this row's column changes, the old
 * value simply matches no connection at all, the same "not found" a webhook route already gives
 * an unknown id. */
export function rotateWebhookPublicId(db,id,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 getConnection(db,id,resolvedTenantId); // 404s if wrong tenant
 const publicId=randomUUID().replace(/-/g,'');
 db.prepare('UPDATE integration_connections SET webhook_public_id=?,updated_at=? WHERE id=? AND tenant_id=?').run(publicId,new Date().toISOString(),id,resolvedTenantId);
 return publicId;
}
export function updateConnection(db,id,patch,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const current=getConnection(db,id,resolvedTenantId);
 const merged={...current,...patch};
 // Phase 6G fix: `connectorVersion` (the Versioning UI's pin — Part 42/108/109) was hydrated
 // on read but never actually written here, so nothing that ever called updateConnection could
 // pin/migrate/roll back a connection's version despite the column and read path both existing
 // since Phase 6D — a real, silent gap, not by design (see docs/CONNECTOR_VERSION_MANAGEMENT.md).
 db.prepare(`UPDATE integration_connections SET name=?,status=?,external_account_id=?,external_account_type=?,external_account_name=?,external_account_metadata=?,scopes=?,connected_by=?,connected_at=?,last_health_check=?,last_success_at=?,last_error_at=?,last_error_code=?,last_error_message_safe=?,connector_version=?,updated_at=? WHERE id=? AND tenant_id=?`)
  .run(merged.name,merged.status,merged.externalAccountId,merged.externalAccountType,merged.externalAccountName,
   merged.externalAccountMetadata?JSON.stringify(merged.externalAccountMetadata):null,
   merged.scopes?JSON.stringify(merged.scopes):null,merged.connectedBy,merged.connectedAt,merged.lastHealthCheck,
   merged.lastSuccessAt,merged.lastErrorAt,merged.lastErrorCode,merged.lastErrorMessageSafe,merged.connectorVersion??null,new Date().toISOString(),id,resolvedTenantId);
 return getConnection(db,id,resolvedTenantId);
}
/** Phase 29: exactly one default per (tenant, provider) — enforced by the partial unique index above; this clears any prior default first so the swap is atomic. */
export function setDefaultConnection(db,id,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const connection=getConnection(db,id,resolvedTenantId);
 db.exec('BEGIN IMMEDIATE');
 try {
  db.prepare('UPDATE integration_connections SET is_default=0 WHERE tenant_id=? AND integration_definition_id=?').run(resolvedTenantId,connection.integrationDefinitionId);
  db.prepare('UPDATE integration_connections SET is_default=1,updated_at=? WHERE id=? AND tenant_id=?').run(new Date().toISOString(),id,resolvedTenantId);
  db.exec('COMMIT');
 } catch(error) {db.exec('ROLLBACK');throw error;}
 return getConnection(db,id,resolvedTenantId);
}
export function getDefaultConnection(db,integrationDefinitionId,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const row=db.prepare('SELECT * FROM integration_connections WHERE tenant_id=? AND integration_definition_id=? AND is_default=1').get(resolvedTenantId,integrationDefinitionId);
 return row?hydrate(row):null;
}
/**
 * Phase 41-43: the resolver every legacy (connection-unaware) call site goes through.
 * Exactly one connection for this provider → return it (safe, unambiguous). More than one
 * with a real default set → return the default. More than one with NO default → refuse to
 * guess: throws CONNECTION_SELECTION_REQUIRED rather than silently picking the first row.
 * Zero connections → returns null (NOT_CONFIGURED, matches today's "not connected").
 */
export function resolveProviderAccount(db,integrationDefinitionId,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const rows=db.prepare('SELECT * FROM integration_connections WHERE tenant_id=? AND integration_definition_id=? ORDER BY created_at').all(resolvedTenantId,integrationDefinitionId).map(hydrate);
 if(rows.length===0)return null;
 if(rows.length===1)return rows[0];
 const def=rows.find(r=>r.isDefault);
 if(def)return def;
 throw Object.assign(new Error('CONNECTION_SELECTION_REQUIRED'),{code:'CONNECTION_SELECTION_REQUIRED',status:409,connections:rows.map(r=>({id:r.id,name:r.name}))});
}
export function disconnectConnection(db,id,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 getConnection(db,id,resolvedTenantId); // 404s if wrong tenant
 db.prepare("UPDATE integration_connections SET status='DISCONNECTED',updated_at=? WHERE id=? AND tenant_id=?").run(new Date().toISOString(),id,resolvedTenantId);
 return getConnection(db,id,resolvedTenantId);
}
/**
 * Phase 36-38: prefer archiving (DISCONNECTED, already the case after disconnectConnection)
 * over hard delete when historical records might reference this connection_id (webhook
 * events, audit log entries). Hard delete is only safe once nothing references the id — this
 * phase does not yet have a dependency scan (no feature writes a real connection_id onto a
 * business record until Phase 4B's tool mapping), so this stays a soft delete for now,
 * consistent with "preserve metadata/history" over silent hard deletion.
 */
export function deleteConnection(db,id,tenantId=null) {
 return disconnectConnection(db,id,tenantId);
}
