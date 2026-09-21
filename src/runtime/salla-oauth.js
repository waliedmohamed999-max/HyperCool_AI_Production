import {randomBytes} from 'node:crypto';
import {ConnectorError} from '../connectors.js';
import {envForTenant} from './credential-policy.js';
import {getCredentials,saveCredentials,clearCredentials,getCredentialsMeta,isExpiringSoon,credentialsConfigured} from './credentials.js';

// Salla's real OAuth 2.0 endpoints per their Partners Portal documentation. Confirm these
// against your own app's settings before relying on them in production — third-party API
// base URLs can change, and this file has no way to verify them without a live app.
const AUTHORIZE_URL='https://accounts.salla.sa/oauth2/auth';
const TOKEN_URL='https://accounts.salla.sa/oauth2/token';
const DEFAULT_SCOPES=['offline_access','products.read','orders.read','customers.read'];

export function oauthConfigured(env) {
 return !!(env.SALLA_CLIENT_ID && env.SALLA_CLIENT_SECRET && env.SALLA_REDIRECT_URI);
}
// A short-lived, in-memory state store for the OAuth CSRF nonce — this is a single local
// server process (see docs/agent-runtime.md), so this never needs to survive a restart;
// a state older than 10 minutes is treated as expired.
const pendingStates=new Map();
// Multi-Tenant Phase 4A: `externalState`, when supplied, is a real DB-backed token from the
// new generic multi-connection OAuth flow (src/integrations/oauth-state.js) — this function
// then builds the exact same authorize URL but does NOT touch its own in-memory
// `pendingStates` map at all (that map is only ever consulted by consumeState below, which
// the new flow never calls). The existing single-connection route
// (`/api/integrations/salla/oauth/start`) is completely unchanged: it never passes this
// argument, so it keeps generating and consuming its own in-memory state exactly as before.
export function createAuthorizeUrl(env,userId,externalState=null) {
 if(!oauthConfigured(env))throw new ConnectorError('SALLA_OAUTH_NOT_CONFIGURED');
 const state=externalState||randomBytes(24).toString('base64url');
 if(!externalState)pendingStates.set(state,{userId,at:Date.now()});
 const url=new URL(AUTHORIZE_URL);
 url.searchParams.set('client_id',env.SALLA_CLIENT_ID);
 url.searchParams.set('response_type','code');
 url.searchParams.set('redirect_uri',env.SALLA_REDIRECT_URI);
 url.searchParams.set('scope',DEFAULT_SCOPES.join(' '));
 url.searchParams.set('state',state);
 return url.href;
}
export function consumeState(state,userId) {
 const entry=pendingStates.get(state);
 pendingStates.delete(state);
 if(!entry)throw Object.assign(new Error('انتهت صلاحية طلب الربط أو أنه غير معروف؛ ابدأ من جديد'),{status:400});
 if(Date.now()-entry.at>600000)throw Object.assign(new Error('انتهت صلاحية طلب الربط (أكثر من 10 دقائق)؛ ابدأ من جديد'),{status:400});
 if(entry.userId!==userId)throw Object.assign(new Error('طلب الربط بدأه مستخدم مختلف'),{status:403});
 return true;
}
async function requestJson(fetcher,url,options) {
 let response;
 try {response=await fetcher(url,{...options,signal:AbortSignal.timeout(20000)});}
 catch {throw new ConnectorError('NETWORK_OR_TIMEOUT');}
 let data;
 try {data=await response.json();} catch {throw new ConnectorError('INVALID_PROVIDER_RESPONSE');}
 if(!response.ok)throw new ConnectorError(response.status===401||response.status===403?'CREDENTIALS_REJECTED':response.status===429?'RATE_LIMITED':'PROVIDER_ERROR');
 return data;
}
export async function exchangeCodeForTokens({env,fetcher=fetch,code}) {
 if(!oauthConfigured(env))throw new ConnectorError('SALLA_OAUTH_NOT_CONFIGURED');
 const data=await requestJson(fetcher,TOKEN_URL,{
  method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({grant_type:'authorization_code',client_id:env.SALLA_CLIENT_ID,client_secret:env.SALLA_CLIENT_SECRET,redirect_uri:env.SALLA_REDIRECT_URI,code}).toString()
 });
 if(!data.access_token)throw new ConnectorError('INVALID_PROVIDER_RESPONSE');
 return normalizeTokenResponse(data);
}
async function refreshTokens({env,fetcher,refreshToken}) {
 const data=await requestJson(fetcher,TOKEN_URL,{
  method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({grant_type:'refresh_token',client_id:env.SALLA_CLIENT_ID,client_secret:env.SALLA_CLIENT_SECRET,refresh_token:refreshToken}).toString()
 });
 if(!data.access_token)throw new ConnectorError('INVALID_PROVIDER_RESPONSE');
 return normalizeTokenResponse(data);
}
function normalizeTokenResponse(data) {
 return {
  accessToken:data.access_token,
  refreshToken:data.refresh_token||null,
  expiresAt:Number.isFinite(data.expires_in)?new Date(Date.now()+data.expires_in*1000).toISOString():null,
  scopes:typeof data.scope==='string'?data.scope.split(' '):[]
 };
}
export function sallaOAuthStatus(db,env,tenantId=null) {
 if(!oauthConfigured(env))return {configured:false};
 const meta=getCredentialsMeta(db,'salla',tenantId);
 if(!meta)return {configured:true,connected:false};
 return {configured:true,connected:true,expiresAt:meta.expiresAt,scopes:meta.scopes,externalAccountId:meta.externalAccountId,connectedByName:meta.connectedByName,connectedAt:meta.connectedAt,tokenExpired:isExpiringSoon(meta.expiresAt,0)};
}
export function disconnectSalla(db,tenantId=null) {
 clearCredentials(db,'salla',tenantId);
}
/**
 * The single entry point every Salla API call should go through to get a bearer token —
 * prefers a connected OAuth token (refreshing it first if it's about to expire), and falls
 * back to the long-lived SALLA_ACCESS_TOKEN static token used before OAuth existed, so
 * nothing that already worked breaks. Returns null (never throws) when neither is usable,
 * so callers can report INTEGRATION_REQUIRED/NOT_CONFIGURED honestly instead of crashing.
 */
export async function resolveSallaAccessToken({store,env,fetcher=fetch},tenantId=null) {
 env=envForTenant(store.db,env,tenantId);
 const db=store.db;
 if(credentialsConfigured(env)) {
  let creds;
  try {creds=getCredentials(db,env,'salla',tenantId);} catch {creds=null;}
  if(creds) {
   if(!isExpiringSoon(creds.expiresAt)) return {token:creds.accessToken,source:'oauth'};
   if(!creds.refreshToken) return env.SALLA_ACCESS_TOKEN?{token:env.SALLA_ACCESS_TOKEN,source:'static'}:null;
   try {
    const refreshed=await refreshTokens({env,fetcher,refreshToken:creds.refreshToken});
    saveCredentials(store.db,env,'salla',{...refreshed,externalAccountId:creds.externalAccountId},null,tenantId);
    return {token:refreshed.accessToken,source:'oauth'};
   } catch {
    // Refresh failed (expired/revoked refresh token) — fall through to the static token if
    // one exists rather than hard-failing every Salla call; TOKEN_EXPIRED is still visible
    // via sallaOAuthStatus() for the Integrations page to surface.
    return env.SALLA_ACCESS_TOKEN?{token:env.SALLA_ACCESS_TOKEN,source:'static'}:null;
   }
  }
 }
 return env.SALLA_ACCESS_TOKEN?{token:env.SALLA_ACCESS_TOKEN,source:'static'}:null;
}
