import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {fail} from '../auth.js';
import {encryptionKey,encrypt,decrypt} from '../runtime/crypto.js';

// OAuthStateService — Multi-Tenant Phase 4A, Part 21/22. A real, DB-backed replacement for
// the in-memory `pendingStates` Map pattern every existing *-oauth.js module uses today
// (meta-oauth.js, salla-oauth.js, microsoft-oauth.js, x-oauth.js, linkedin-oauth.js) — those
// modules and their existing routes are UNCHANGED in this phase (see
// docs/INTEGRATION_CONNECTION_ARCHITECTURE.md's compatibility-layer note); this table is
// what the NEW generic multi-connection OAuth routes (`/api/integrations/:slug/oauth/start`)
// use instead, since they need a state that is tenant-bound (not just user-bound) and tied
// to a specific pending `integration_connections` row.
export function installOAuthStates(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS oauth_states (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  integration_definition_id TEXT NOT NULL,
  connection_id TEXT,
  state_token_hash TEXT NOT NULL UNIQUE,
  pkce_verifier_enc TEXT,
  return_url TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);`);
}
function hashToken(token) {
 // Same approach as session tokens elsewhere in this codebase: the raw, high-entropy token
 // is only ever held by the browser (in the redirect URL) — the DB stores a lookup hash, not
 // the token itself, so a DB read alone can never forge a valid state.
 return createHash('sha256').update(token).digest('hex');
}
const TTL_MS=600000; // 10 minutes — matches every existing *-oauth.js module's in-memory expiry
/**
 * Creates a real, single-use, tenant+user+provider-bound state token. Returns the RAW token
 * (goes into the redirect URL's `state` param) — only its hash is ever stored.
 */
export function createOAuthState(db,{tenantId,userId,integrationDefinitionId,connectionId=null,pkceVerifier=null,returnUrl=null},env={}) {
 const token=randomBytes(24).toString('base64url');
 const now=Date.now();
 let pkceVerifierEnc=null;
 if(pkceVerifier) {
  const key=encryptionKey(env);
  if(!key)fail(500,'INTEGRATION_ENCRYPTION_KEY غير مُعد أو غير صالح');
  pkceVerifierEnc=encrypt(key,pkceVerifier);
 }
 db.prepare(`INSERT INTO oauth_states (id,tenant_id,user_id,integration_definition_id,connection_id,state_token_hash,pkce_verifier_enc,return_url,expires_at,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),tenantId,userId,integrationDefinitionId,connectionId,hashToken(token),pkceVerifierEnc,returnUrl,new Date(now+TTL_MS).toISOString(),new Date(now).toISOString());
 return token;
}
/**
 * Verifies and CONSUMES a state token (Part 22: single-use, tenant/user/provider bound,
 * expiry bound) — marks it used in the same call so a replay (the exact same token used
 * twice) is rejected even if the row is still technically within its expiry window.
 */
export function consumeOAuthState(db,token,{userId,integrationDefinitionId},env={}) {
 const row=db.prepare('SELECT * FROM oauth_states WHERE state_token_hash=?').get(hashToken(token));
 if(!row)fail(400,'انتهت صلاحية طلب الربط أو أنه غير معروف؛ ابدأ من جديد');
 if(row.used_at)fail(400,'تم استخدام طلب الربط هذا بالفعل؛ ابدأ من جديد');
 if(Date.parse(row.expires_at)<Date.now())fail(400,'انتهت صلاحية طلب الربط (أكثر من 10 دقائق)؛ ابدأ من جديد');
 if(row.user_id!==userId)fail(403,'طلب الربط بدأه مستخدم مختلف');
 if(row.integration_definition_id!==integrationDefinitionId)fail(400,'طلب الربط لا يطابق نوع التكامل');
 db.prepare('UPDATE oauth_states SET used_at=? WHERE id=?').run(new Date().toISOString(),row.id);
 let pkceVerifier=null;
 if(row.pkce_verifier_enc) {
  const key=encryptionKey(env);
  pkceVerifier=key?decrypt(key,row.pkce_verifier_enc):null;
 }
 return {tenantId:row.tenant_id,userId:row.user_id,integrationDefinitionId:row.integration_definition_id,connectionId:row.connection_id,pkceVerifier,returnUrl:row.return_url};
}
/** Housekeeping only — expired rows are already refused by consumeOAuthState; this just keeps the table from growing forever. Safe to call opportunistically (e.g. from installOAuthStates callers), never required for correctness. */
export function pruneExpiredOAuthStates(db) {
 return db.prepare('DELETE FROM oauth_states WHERE expires_at<?').run(new Date().toISOString()).changes;
}
