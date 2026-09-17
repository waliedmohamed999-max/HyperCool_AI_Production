import {randomBytes,createHash} from 'node:crypto';
import {ConnectorError} from '../connectors.js';
import {getCredentials,saveCredentials,clearCredentials,getCredentialsMeta,isExpiringSoon,credentialsConfigured} from './credentials.js';

// X's (Twitter's) real OAuth 2.0 endpoints, per developer.x.com. X's API v2 OAuth 2.0
// MANDATES PKCE for every client (confidential or public) — unlike Salla/Meta/Microsoft
// above, a plain authorization-code exchange without a code_verifier is rejected outright.
const AUTHORIZE_URL='https://twitter.com/i/oauth2/authorize';
const TOKEN_URL='https://api.twitter.com/2/oauth2/token';
const API_BASE='https://api.twitter.com/2';
// tweet.write/tweet.read/users.read for publishing + reading own post metrics;
// offline_access to receive a refresh token (without it the access token is single-use-session
// only and expires in ~2 hours with no way to renew short of reconnecting).
const DEFAULT_SCOPES=['tweet.read','tweet.write','users.read','offline_access'];

export function xOAuthConfigured(env) {
 return !!(env.X_CLIENT_ID && env.X_CLIENT_SECRET && env.X_REDIRECT_URI);
}
// PKCE verifier/challenge must survive the redirect round-trip alongside the CSRF state —
// same in-memory, single-process, 10-minute-expiry store used by every other OAuth flow
// in this app (see meta-oauth.js/salla-oauth.js); nothing here needs to survive a restart.
const pendingStates=new Map();
function base64url(buffer){return buffer.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function createXAuthorizeUrl(env,userId) {
 if(!xOAuthConfigured(env))throw new ConnectorError('X_OAUTH_NOT_CONFIGURED');
 const state=base64url(randomBytes(24));
 const codeVerifier=base64url(randomBytes(32));
 const codeChallenge=base64url(createHash('sha256').update(codeVerifier).digest());
 pendingStates.set(state,{userId,codeVerifier,at:Date.now()});
 const url=new URL(AUTHORIZE_URL);
 url.searchParams.set('response_type','code');
 url.searchParams.set('client_id',env.X_CLIENT_ID);
 url.searchParams.set('redirect_uri',env.X_REDIRECT_URI);
 url.searchParams.set('scope',DEFAULT_SCOPES.join(' '));
 url.searchParams.set('state',state);
 url.searchParams.set('code_challenge',codeChallenge);
 url.searchParams.set('code_challenge_method','S256');
 return url.href;
}
export function consumeXState(state,userId) {
 const entry=pendingStates.get(state);
 pendingStates.delete(state);
 if(!entry)throw Object.assign(new Error('انتهت صلاحية طلب الربط أو أنه غير معروف؛ ابدأ من جديد'),{status:400});
 if(Date.now()-entry.at>600000)throw Object.assign(new Error('انتهت صلاحية طلب الربط (أكثر من 10 دقائق)؛ ابدأ من جديد'),{status:400});
 if(entry.userId!==userId)throw Object.assign(new Error('طلب الربط بدأه مستخدم مختلف'),{status:403});
 return entry.codeVerifier;
}
function basicAuth(env){return 'Basic '+Buffer.from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`).toString('base64');}
async function requestJson(fetcher,url,options={}) {
 let response;
 try {response=await fetcher(url,{...options,signal:AbortSignal.timeout(20000)});}
 catch {throw new ConnectorError('NETWORK_OR_TIMEOUT');}
 let data;
 try {data=await response.json();} catch {throw new ConnectorError('INVALID_PROVIDER_RESPONSE');}
 if(!response.ok||data.error)throw new ConnectorError(response.status===401||response.status===403?'CREDENTIALS_REJECTED':response.status===429?'RATE_LIMITED':'PROVIDER_ERROR');
 return data;
}
export async function exchangeCodeForTokens({env,fetcher=fetch,code,codeVerifier}) {
 if(!xOAuthConfigured(env))throw new ConnectorError('X_OAUTH_NOT_CONFIGURED');
 const data=await requestJson(fetcher,TOKEN_URL,{
  method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',authorization:basicAuth(env)},
  body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:env.X_REDIRECT_URI,client_id:env.X_CLIENT_ID,code_verifier:codeVerifier}).toString()
 });
 if(!data.access_token)throw new ConnectorError('INVALID_PROVIDER_RESPONSE');
 return normalizeTokenResponse(data);
}
async function refreshTokens({env,fetcher,refreshToken}) {
 const data=await requestJson(fetcher,TOKEN_URL,{
  method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',authorization:basicAuth(env)},
  body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken,client_id:env.X_CLIENT_ID}).toString()
 });
 if(!data.access_token)throw new ConnectorError('INVALID_PROVIDER_RESPONSE');
 return normalizeTokenResponse(data);
}
function normalizeTokenResponse(data) {
 return {
  accessToken:data.access_token,
  refreshToken:data.refresh_token||null,
  expiresAt:Number.isFinite(data.expires_in)?new Date(Date.now()+data.expires_in*1000).toISOString():null,
  scopes:typeof data.scope==='string'?data.scope.split(' '):DEFAULT_SCOPES
 };
}
export async function resolveConnectedProfile({fetcher=fetch,accessToken}) {
 const data=await requestJson(fetcher,`${API_BASE}/users/me`,{headers:{authorization:`Bearer ${accessToken}`}});
 return {id:data.data?.id,username:data.data?.username,name:data.data?.name};
}
// Phase MKT-2, Part F/O — these three used to read/write `integration_credentials` with NO
// tenant_id at all, falling back to `resolveActiveTenantId(db)`'s single-tenant default
// exactly like the bug meta-oauth.js's own comment already documented and fixed for Meta.
// That default silently breaks (throws TENANT_CONTEXT_REQUIRED) the instant a second real
// tenant exists, and — worse, if that guard were ever loosened — could connect/read/disconnect
// the WRONG tenant's X account. `tenantId` threaded through from the real session at every
// call site closes this exactly like the Meta fix did.
export function saveXConnection(db,env,{accessToken,refreshToken,expiresAt,scopes},profile,user,tenantId=null) {
 return saveCredentials(db,env,'x',{
  accessToken,refreshToken,expiresAt,scopes,externalAccountId:profile?.id||null,
  metadata:{username:profile?.username||null,name:profile?.name||null}
 },user,tenantId);
}
export function xOAuthStatus(db,tenantId=null) {
 const meta=getCredentialsMeta(db,'x',tenantId);
 if(!meta)return {connected:false};
 return {connected:true,expiresAt:meta.expiresAt,scopes:meta.scopes,username:meta.metadata?.username||null,name:meta.metadata?.name||null,connectedByName:meta.connectedByName,connectedAt:meta.connectedAt,tokenExpired:isExpiringSoon(meta.expiresAt,0)};
}
export function disconnectX(db,tenantId=null) {
 clearCredentials(db,'x',tenantId);
}
/**
 * The only token that can actually publish is the OAuth user-context token — X's app-only
 * Bearer token (the classic X_BEARER_TOKEN static fallback pattern used by Salla/Meta/
 * Microsoft above) is real and useful for read-only calls, but the v2 POST /tweets endpoint
 * requires a user-context (OAuth 2.0 Authorization Code, or OAuth 1.0a user) token — an
 * app-only Bearer token is REJECTED by that endpoint. `kind` distinguishes the two: 'publish'
 * only ever returns the OAuth token (or null), 'read' also accepts the static bearer.
 */
export async function resolveXAccessToken({store,env,fetcher=fetch},kind='publish',tenantId=null) {
 if(credentialsConfigured(env)) {
  let creds;
  try {creds=getCredentials(store.db,env,'x',tenantId);} catch {creds=null;}
  if(creds) {
   if(!isExpiringSoon(creds.expiresAt))return {token:creds.accessToken,source:'oauth'};
   if(!creds.refreshToken)return kind==='read'&&env.X_BEARER_TOKEN?{token:env.X_BEARER_TOKEN,source:'static'}:null;
   try {
    const refreshed=await refreshTokens({env,fetcher,refreshToken:creds.refreshToken});
    saveCredentials(store.db,env,'x',{...refreshed,externalAccountId:creds.externalAccountId,metadata:undefined},null,tenantId);
    return {token:refreshed.accessToken,source:'oauth'};
   } catch {
    return kind==='read'&&env.X_BEARER_TOKEN?{token:env.X_BEARER_TOKEN,source:'static'}:null;
   }
  }
 }
 return kind==='read'&&env.X_BEARER_TOKEN?{token:env.X_BEARER_TOKEN,source:'static'}:null;
}
