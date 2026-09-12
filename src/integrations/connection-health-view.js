// Universal Integration Platform (Phase 6G, Part 25-27) — Reauthorization UX. A pure, additive
// DISPLAY layer over the connection's REAL, already-enforced `status` column (never a new DB
// enum/CHECK-constraint rebuild — real production-DB risk for zero behavioral gain, since
// nothing here changes what the runtime actually allows). `integration_connections.status`
// keeps its exact existing 8 values (see connections.js's CHECK constraint) — this module only
// gives the UI a richer, honest label to show a human, computed fresh from that status plus the
// Vault credential's own `expiresAt` (never the token itself — Part 27).
import {getCredentialMeta,getCredentialForRuntime} from './vault.js';

const REAUTH_ELIGIBLE_AUTH_TYPES=new Set(['OAUTH2']);

/** Part 25 — one of CONNECTED/DEGRADED/AUTH_FAILED/REAUTH_REQUIRED/UNHEALTHY/DISCONNECTED/
 * DISABLED, derived from real signals only:
 * - a DISABLED connector definition always wins (Part 38 — a tenant can never bypass this)
 * - DISCONNECTED/CONNECTED/DEGRADED pass straight through (already honest, already real)
 * - TOKEN_EXPIRED means the runtime's own OAuth refresh already failed or found no refresh
 *   token — that is EXACTLY what REAUTH_REQUIRED means, never merely "auth failed once"
 * - PERMISSION_MISSING (a real, distinct scope problem) and a generic ERROR whose last error
 *   code looks auth-shaped both surface as AUTH_FAILED (recoverable by reconnecting); any other
 *   ERROR surfaces as the more general UNHEALTHY
 */
function deriveDisplayStatus(connection,definitionStatus) {
 if(definitionStatus==='DISABLED')return 'DISABLED';
 if(connection.status==='DISCONNECTED')return 'DISCONNECTED';
 if(connection.status==='CONNECTED')return 'CONNECTED';
 if(connection.status==='DEGRADED')return 'DEGRADED';
 if(connection.status==='TOKEN_EXPIRED')return 'REAUTH_REQUIRED';
 if(connection.status==='PERMISSION_MISSING')return 'AUTH_FAILED';
 if(connection.status==='ERROR') {
  const code=(connection.lastErrorCode||'').toUpperCase();
  return /AUTH|CREDENTIALS_REJECTED|401|403/.test(code)?'AUTH_FAILED':'UNHEALTHY';
 }
 return connection.status; // NOT_CONFIGURED/CONNECTING — shown as-is, never relabeled
}

const EXPIRING_SOON_MS=24*60*60*1000; // 24h — a conservative, documented heads-up window
/** Part 27 — token expiry UX: never the token value itself, only a timestamp + derived label. */
function deriveTokenExpiry(connection,credentialMeta,expiresAt) {
 if(!expiresAt)return {status:'UNKNOWN',expiresAt:null};
 const remaining=Date.parse(expiresAt)-Date.now();
 if(remaining<=0)return {status:connection.status==='TOKEN_EXPIRED'?'REAUTH_REQUIRED':'EXPIRED',expiresAt};
 if(remaining<=EXPIRING_SOON_MS)return {status:'EXPIRING_SOON',expiresAt};
 return {status:'HEALTHY',expiresAt};
}

/**
 * Reads `expiresAt` from the Vault (backend-internal, per vault.js's own doc comment — never
 * exposed further than this one timestamp field) ONLY for an OAuth2-authenticated connection;
 * every other auth type has no concept of token expiry and reports UNKNOWN honestly.
 */
export function buildConnectionHealthView(db,env,connection,definition) {
 const displayStatus=deriveDisplayStatus(connection,definition?.status);
 const authType=definition?.authConfig?.type||definition?.authType;
 let tokenExpiry={status:'UNKNOWN',expiresAt:null};
 if(REAUTH_ELIGIBLE_AUTH_TYPES.has(authType) || definition?.slug==='zid' || definition?.slug==='salla') {
  try {
   const credential=getCredentialForRuntime(db,env,connection.id,connection.tenantId);
   tokenExpiry=deriveTokenExpiry(connection,null,credential?.payload?.expiresAt||null);
  } catch { /* no encryption key configured yet, or no credential at all — stays UNKNOWN */ }
 }
 return {
  displayStatus,tokenExpiry,
  reconnectEligible:REAUTH_ELIGIBLE_AUTH_TYPES.has(authType)&&['AUTH_FAILED','REAUTH_REQUIRED'].includes(displayStatus)
 };
}
