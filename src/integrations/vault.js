import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {encryptionKey,encrypt,decrypt,ENCRYPTION_VERSION} from '../runtime/crypto.js';

// CredentialVaultService — Multi-Tenant Phase 4A, Part 8/9/10/11. One encrypted payload per
// connection (never plaintext — `api_key`/`access_token`/`refresh_token`/`client_secret`
// only ever exist as ciphertext at rest), reusing the exact AES-256-GCM mechanism
// `credentials.js` already used (see `src/runtime/crypto.js`) rather than a second
// encryption architecture. `getCredentialForRuntime` is backend-internal only — no HTTP
// route in this codebase ever returns its result to a client (see application.js's routes,
// which only ever call the *Meta variants below).
export function installCredentialsVault(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS integration_credentials_vault (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL UNIQUE,
  credential_type TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  encryption_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_rotated_at TEXT
 );
 CREATE INDEX IF NOT EXISTS idx_credentials_vault_tenant ON integration_credentials_vault(tenant_id);`);
}
function requireKey(env) {
 const key=encryptionKey(env);
 if(!key)fail(500,'INTEGRATION_ENCRYPTION_KEY غير مُعد أو غير صالح (يجب أن يكون 32 بايت بترميز hex أو base64) — لا يمكن حفظ بيانات اعتماد مشفّرة بدونه');
 return key;
}
/** Replaces (or creates) the one credential row for a connection — a full replace, never a partial merge, since a stale field silently surviving a credential rotation is a real risk. */
export function storeCredential(db,env,{connectionId,credentialType,payload},tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const key=requireKey(env);
 const now=new Date().toISOString();
 const encrypted=encrypt(key,JSON.stringify(payload));
 const existing=db.prepare('SELECT id FROM integration_credentials_vault WHERE connection_id=?').get(connectionId);
 if(existing) {
  db.prepare('UPDATE integration_credentials_vault SET credential_type=?,encrypted_payload=?,encryption_version=?,updated_at=?,last_rotated_at=? WHERE connection_id=? AND tenant_id=?')
   .run(credentialType,encrypted,ENCRYPTION_VERSION,now,now,connectionId,resolvedTenantId);
 } else {
  db.prepare('INSERT INTO integration_credentials_vault (id,tenant_id,connection_id,credential_type,encrypted_payload,encryption_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
   .run(randomUUID(),resolvedTenantId,connectionId,credentialType,encrypted,ENCRYPTION_VERSION,now,now);
 }
 return {stored:true};
}
export const replaceCredential=storeCredential;
/** Backend-internal only — decrypts and returns the raw payload. Never called from an HTTP route handler directly; only from a provider adapter that needs a real token to call the provider's API. */
export function getCredentialForRuntime(db,env,connectionId,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const row=db.prepare('SELECT * FROM integration_credentials_vault WHERE connection_id=? AND tenant_id=?').get(connectionId,resolvedTenantId);
 if(!row)return null;
 const key=requireKey(env);
 return {credentialType:row.credential_type,payload:JSON.parse(decrypt(key,row.encrypted_payload)),encryptionVersion:row.encryption_version,updatedAt:row.updated_at,lastRotatedAt:row.last_rotated_at};
}
export function hasCredential(db,connectionId,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 return !!db.prepare('SELECT 1 FROM integration_credentials_vault WHERE connection_id=? AND tenant_id=?').get(connectionId,resolvedTenantId);
}
/** Safe metadata only — Phase 12: never the payload, never even its shape beyond a type tag. */
export function getCredentialMeta(db,connectionId,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const row=db.prepare('SELECT credential_type,created_at,updated_at,last_rotated_at FROM integration_credentials_vault WHERE connection_id=? AND tenant_id=?').get(connectionId,resolvedTenantId);
 if(!row)return {configured:false};
 return {configured:true,credentialType:row.credential_type,createdAt:row.created_at,updatedAt:row.updated_at,lastRotatedAt:row.last_rotated_at};
}
export function removeCredential(db,connectionId,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 db.prepare('DELETE FROM integration_credentials_vault WHERE connection_id=? AND tenant_id=?').run(connectionId,resolvedTenantId);
 return {removed:true};
}
export const rotateCredential=storeCredential;
