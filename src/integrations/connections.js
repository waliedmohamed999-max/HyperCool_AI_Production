import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {getIntegrationDefinition} from './definitions.js';

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
}
function hydrate(row) {
 return {
  id:row.id,tenantId:row.tenant_id,integrationDefinitionId:row.integration_definition_id,name:row.name,status:row.status,
  externalAccountId:row.external_account_id,externalAccountType:row.external_account_type,externalAccountName:row.external_account_name,
  externalAccountMetadata:row.external_account_metadata?JSON.parse(row.external_account_metadata):null,
  scopes:row.scopes?JSON.parse(row.scopes):[],connectedBy:row.connected_by,connectedAt:row.connected_at,
  lastHealthCheck:row.last_health_check,lastSuccessAt:row.last_success_at,lastErrorAt:row.last_error_at,
  lastErrorCode:row.last_error_code,lastErrorMessageSafe:row.last_error_message_safe,
  isDefault:!!row.is_default,createdAt:row.created_at,updatedAt:row.updated_at
 };
}
/** Creates a new, empty (NOT_CONFIGURED) connection — never with a credential attached; that's the Vault's job. */
export function createConnection(db,{integrationDefinitionId,name,connectedBy=null},tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 if(!getIntegrationDefinition(db,integrationDefinitionId))fail(400,'تكامل غير معروف');
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
export function updateConnection(db,id,patch,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const current=getConnection(db,id,resolvedTenantId);
 const merged={...current,...patch};
 db.prepare(`UPDATE integration_connections SET name=?,status=?,external_account_id=?,external_account_type=?,external_account_name=?,external_account_metadata=?,scopes=?,connected_by=?,connected_at=?,last_health_check=?,last_success_at=?,last_error_at=?,last_error_code=?,last_error_message_safe=?,updated_at=? WHERE id=? AND tenant_id=?`)
  .run(merged.name,merged.status,merged.externalAccountId,merged.externalAccountType,merged.externalAccountName,
   merged.externalAccountMetadata?JSON.stringify(merged.externalAccountMetadata):null,
   merged.scopes?JSON.stringify(merged.scopes):null,merged.connectedBy,merged.connectedAt,merged.lastHealthCheck,
   merged.lastSuccessAt,merged.lastErrorAt,merged.lastErrorCode,merged.lastErrorMessageSafe,new Date().toISOString(),id,resolvedTenantId);
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
