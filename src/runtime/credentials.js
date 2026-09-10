import {randomBytes,createCipheriv,createDecipheriv,timingSafeEqual} from 'node:crypto';
import {fail} from '../auth.js';

// Generic encrypted OAuth/API-credential store for any integration that needs one (Salla
// today; the same table/functions work for a future integration without a new schema).
// Nothing here is ever readable as plaintext outside this process: AES-256-GCM with a key
// that only ever lives in the host environment (INTEGRATION_ENCRYPTION_KEY), never the
// database or the repo. If that key is missing, saving a credential fails closed — this
// app never stores an OAuth token unencrypted "for now."
export function installCredentials(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS integration_credentials (
  provider TEXT PRIMARY KEY,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at TEXT,
  scopes TEXT,
  external_account_id TEXT,
  connected_by TEXT,
  connected_by_name TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
 );`);
 // Additive, guarded columns (see runtime/registry.js for the same pattern) — added for
 // Meta, whose connection needs more than one secret (a user token AND a per-Page access
 // token) plus several non-secret asset identifiers (Page id/name, Instagram id/username,
 // WhatsApp Business Account id, phone number id) that Salla's simpler single-token model
 // never needed. `extra_enc` is encrypted exactly like the access/refresh token; `metadata`
 // is plain JSON because none of those asset ids are secrets.
 const columns=db.prepare("PRAGMA table_info(integration_credentials)").all().map(c=>c.name);
 if(!columns.includes('extra_enc'))db.exec('ALTER TABLE integration_credentials ADD COLUMN extra_enc TEXT');
 if(!columns.includes('metadata'))db.exec('ALTER TABLE integration_credentials ADD COLUMN metadata TEXT');
}
function encryptionKey(env) {
 const raw=env.INTEGRATION_ENCRYPTION_KEY;
 if(!raw)return null;
 // Accept hex (64 chars) or base64 (44 chars incl. padding) — either way must decode to
 // exactly 32 bytes for AES-256. Anything else is a misconfiguration, not something to
 // silently pad/truncate into a weaker or wrong key.
 let key;
 try {key=/^[0-9a-fA-F]{64}$/.test(raw)?Buffer.from(raw,'hex'):Buffer.from(raw,'base64');}
 catch {return null;}
 return key.length===32?key:null;
}
export function credentialsConfigured(env) {
 return !!encryptionKey(env);
}
function encrypt(key,plaintext) {
 const iv=randomBytes(12);
 const cipher=createCipheriv('aes-256-gcm',key,iv);
 const ciphertext=Buffer.concat([cipher.update(plaintext,'utf8'),cipher.final()]);
 const authTag=cipher.getAuthTag();
 return [iv,authTag,ciphertext].map(b=>b.toString('base64')).join('.');
}
function decrypt(key,packed) {
 const [ivB64,tagB64,dataB64]=packed.split('.');
 if(!ivB64||!tagB64||!dataB64)throw new Error('Malformed encrypted credential');
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(ivB64,'base64'));
 decipher.setAuthTag(Buffer.from(tagB64,'base64'));
 return Buffer.concat([decipher.update(Buffer.from(dataB64,'base64')),decipher.final()]).toString('utf8');
}
export function saveCredentials(db,env,provider,{accessToken,refreshToken,expiresAt,scopes,externalAccountId,extra,metadata},user) {
 const key=encryptionKey(env);
 if(!key)fail(500,'INTEGRATION_ENCRYPTION_KEY غير مُعد أو غير صالح (يجب أن يكون 32 بايت بترميز hex أو base64) — لا يمكن حفظ بيانات اعتماد مشفّرة بدونه');
 if(typeof accessToken!=='string'||!accessToken)fail(400,'access token مطلوب');
 const now=new Date().toISOString();
 const row={
  provider,accessTokenEnc:encrypt(key,accessToken),refreshTokenEnc:refreshToken?encrypt(key,refreshToken):null,
  expiresAt:expiresAt||null,scopes:scopes?JSON.stringify(scopes):null,externalAccountId:externalAccountId||null,
  extraEnc:extra!==undefined?encrypt(key,JSON.stringify(extra)):null,metadata:metadata!==undefined?JSON.stringify(metadata):null,
  connectedBy:user?.id||null,connectedByName:user?.name||null,connectedAt:now,updatedAt:now
 };
 // On an existing row, a token refresh (user=null, no new human action) must NOT overwrite
 // who originally connected the integration — only an explicit reconnect (a real user
 // passed in) may change that attribution.
 db.prepare(`INSERT INTO integration_credentials (provider,access_token_enc,refresh_token_enc,expires_at,scopes,external_account_id,extra_enc,metadata,connected_by,connected_by_name,connected_at,updated_at)
  VALUES (@provider,@accessTokenEnc,@refreshTokenEnc,@expiresAt,@scopes,@externalAccountId,@extraEnc,@metadata,@connectedBy,@connectedByName,@connectedAt,@updatedAt)
  ON CONFLICT(provider) DO UPDATE SET access_token_enc=excluded.access_token_enc,refresh_token_enc=excluded.refresh_token_enc,expires_at=excluded.expires_at,scopes=excluded.scopes,external_account_id=COALESCE(excluded.external_account_id,integration_credentials.external_account_id),extra_enc=COALESCE(excluded.extra_enc,integration_credentials.extra_enc),metadata=COALESCE(excluded.metadata,integration_credentials.metadata),connected_by=COALESCE(excluded.connected_by,integration_credentials.connected_by),connected_by_name=COALESCE(excluded.connected_by_name,integration_credentials.connected_by_name),updated_at=excluded.updated_at`).run(row);
 return getCredentialsMeta(db,provider);
}
// Decrypted tokens never leave this module except through this function, called only by
// the server-side code that actually needs to make an authenticated API call — never by
// any route that returns JSON to the browser (see getCredentialsMeta for the safe, public shape).
export function getCredentials(db,env,provider) {
 let row;
 try {row=db.prepare('SELECT * FROM integration_credentials WHERE provider=?').get(provider);}
 catch {return null;}
 if(!row)return null;
 const key=encryptionKey(env);
 if(!key)fail(500,'INTEGRATION_ENCRYPTION_KEY غير مُعد أو غير صالح');
 return {
  accessToken:decrypt(key,row.access_token_enc),
  refreshToken:row.refresh_token_enc?decrypt(key,row.refresh_token_enc):null,
  expiresAt:row.expires_at,scopes:row.scopes?JSON.parse(row.scopes):[],externalAccountId:row.external_account_id,
  extra:row.extra_enc?JSON.parse(decrypt(key,row.extra_enc)):null,
  metadata:row.metadata?JSON.parse(row.metadata):null,
  connectedAt:row.connected_at
 };
}
// Safe to expose to the frontend: metadata only, never the token values. `metadata` is
// included because it holds non-secret asset identifiers (Page name, IG username, phone
// number) meant to be shown on the Integrations page — `extra` (which may hold a secondary
// secret like a Page access token) never is.
export function getCredentialsMeta(db,provider) {
 // Defensive against a store that never ran installCredentials() (an older test fixture, or
 // a future call site that only needs the OTHER tables this module doesn't own) — "no
 // credentials table" and "no credentials for this provider" are the same answer to any
 // caller: not connected, never a crash.
 let row;
 try {row=db.prepare('SELECT provider,expires_at,scopes,external_account_id,metadata,connected_by_name,connected_at,updated_at FROM integration_credentials WHERE provider=?').get(provider);}
 catch {return null;}
 if(!row)return null;
 return {provider:row.provider,expiresAt:row.expires_at,scopes:row.scopes?JSON.parse(row.scopes):[],externalAccountId:row.external_account_id,metadata:row.metadata?JSON.parse(row.metadata):null,connectedByName:row.connected_by_name,connectedAt:row.connected_at,updatedAt:row.updated_at};
}
// Merges `patch` into the existing (non-secret) metadata blob without touching the
// encrypted token columns at all — for operational state that belongs next to a
// connection (e.g. Microsoft's mail webhook subscription id/expiry) but isn't itself a
// secret and shouldn't require re-supplying the access token just to update.
export function updateCredentialsMetadata(db,provider,patch) {
 const row=db.prepare('SELECT metadata FROM integration_credentials WHERE provider=?').get(provider);
 if(!row)return null;
 const merged={...(row.metadata?JSON.parse(row.metadata):{}),...patch};
 db.prepare('UPDATE integration_credentials SET metadata=?,updated_at=? WHERE provider=?').run(JSON.stringify(merged),new Date().toISOString(),provider);
 return merged;
}
export function clearCredentials(db,provider) {
 db.prepare('DELETE FROM integration_credentials WHERE provider=?').run(provider);
}
export function isExpiringSoon(expiresAt,withinMs=300000) {
 if(!expiresAt)return false;
 return Date.parse(expiresAt)-Date.now()<withinMs;
}
// Constant-time string compare, used by webhook verification — never a plain === on a secret.
export function safeEqual(a,b) {
 const bufA=Buffer.from(String(a||''),'utf8'),bufB=Buffer.from(String(b||''),'utf8');
 if(bufA.length!==bufB.length)return false;
 return timingSafeEqual(bufA,bufB);
}
