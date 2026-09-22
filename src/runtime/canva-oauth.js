import {randomBytes,createHash} from 'node:crypto';
import {ConnectorError} from '../connectors.js';
import {envForTenant} from './credential-policy.js';
import {getCredentials,saveCredentials,clearCredentials,getCredentialsMeta,isExpiringSoon,credentialsConfigured} from './credentials.js';

// Canva Connect API's real, published OAuth 2.0 endpoints (developers.canva.com) — PKCE
// (S256) is REQUIRED by Canva for every client, same as X's flow (see x-oauth.js). No live
// call against these has been made from this codebase; verify against your own Canva
// Developer Portal app before relying on this in production (same discipline this codebase
// already applies to Salla's webhook conventions — see docs/SALLA_INTEGRATION_SETUP.md).
const AUTHORIZE_URL='https://www.canva.com/api/oauth/authorize';
const TOKEN_URL='https://api.canva.com/rest/v1/oauth/token';
const API_BASE='https://api.canva.com/rest/v1';
// Minimal footprint: only what this codebase's real health check (GET /v1/users/me) needs.
// Widen this ONLY alongside a real, verified new connector action — never speculatively.
const DEFAULT_SCOPES=['profile:read'];

export function canvaOAuthConfigured(env) {
 return !!(env.CANVA_CLIENT_ID && env.CANVA_CLIENT_SECRET && env.CANVA_REDIRECT_URI);
}
const pendingStates=new Map();
function base64url(buffer){return buffer.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function createCanvaAuthorizeUrl(env,userId,externalState=null,externalVerifier=null) {
 if(!canvaOAuthConfigured(env))throw new ConnectorError('CANVA_OAUTH_NOT_CONFIGURED');
 const state=externalState||base64url(randomBytes(24));
 const codeVerifier=externalVerifier||base64url(randomBytes(32));
 const codeChallenge=base64url(createHash('sha256').update(codeVerifier).digest());
 if(!externalState)pendingStates.set(state,{userId,codeVerifier,at:Date.now()});
 const url=new URL(AUTHORIZE_URL);
 url.searchParams.set('response_type','code');
 url.searchParams.set('client_id',env.CANVA_CLIENT_ID);
 url.searchParams.set('redirect_uri',env.CANVA_REDIRECT_URI);
 url.searchParams.set('scope',DEFAULT_SCOPES.join(' '));
 url.searchParams.set('state',state);
 url.searchParams.set('code_challenge',codeChallenge);
 url.searchParams.set('code_challenge_method','S256');
 return url.href;
}
export function consumeCanvaState(state,userId) {
 const entry=pendingStates.get(state);
 pendingStates.delete(state);
 if(!entry)throw Object.assign(new Error('انتهت صلاحية طلب الربط أو أنه غير معروف؛ ابدأ من جديد'),{status:400});
 if(Date.now()-entry.at>600000)throw Object.assign(new Error('انتهت صلاحية طلب الربط (أكثر من 10 دقائق)؛ ابدأ من جديد'),{status:400});
 if(entry.userId!==userId)throw Object.assign(new Error('طلب الربط بدأه مستخدم مختلف'),{status:403});
 return entry.codeVerifier;
}
function basicAuth(env){return 'Basic '+Buffer.from(`${env.CANVA_CLIENT_ID}:${env.CANVA_CLIENT_SECRET}`).toString('base64');}
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
 if(!canvaOAuthConfigured(env))throw new ConnectorError('CANVA_OAUTH_NOT_CONFIGURED');
 const data=await requestJson(fetcher,TOKEN_URL,{
  method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',authorization:basicAuth(env)},
  body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:env.CANVA_REDIRECT_URI,code_verifier:codeVerifier}).toString()
 });
 if(!data.access_token)throw new ConnectorError('INVALID_PROVIDER_RESPONSE');
 return normalizeTokenResponse(data);
}
async function refreshTokens({env,fetcher,refreshToken}) {
 const data=await requestJson(fetcher,TOKEN_URL,{
  method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',authorization:basicAuth(env)},
  body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken}).toString()
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
 // Canva's documented /v1/users/me shape nests the team member id under `team_user` — kept
 // defensive (never throws on a missing field) since this has no live-call verification yet.
 return {id:data?.team_user?.user_id||data?.id||null,teamId:data?.team_user?.team_id||null};
}
export function saveCanvaConnection(db,env,{accessToken,refreshToken,expiresAt,scopes},profile,user,tenantId=null) {
 return saveCredentials(db,env,'canva',{
  accessToken,refreshToken,expiresAt,scopes,externalAccountId:profile?.id||null,
  metadata:{teamId:profile?.teamId||null}
 },user,tenantId);
}
export function canvaOAuthStatus(db,tenantId=null) {
 const meta=getCredentialsMeta(db,'canva',tenantId);
 if(!meta)return {connected:false};
 return {connected:true,expiresAt:meta.expiresAt,scopes:meta.scopes,connectedByName:meta.connectedByName,connectedAt:meta.connectedAt,tokenExpired:isExpiringSoon(meta.expiresAt,0)};
}
export function disconnectCanva(db,tenantId=null) {
 clearCredentials(db,'canva',tenantId);
}
export async function resolveCanvaAccessToken({store,env,fetcher=fetch},tenantId=null) {
 env=envForTenant(store.db,env,tenantId);
 if(!credentialsConfigured(env))return null;
 let creds;
 try {creds=getCredentials(store.db,env,'canva',tenantId);} catch {creds=null;}
 if(!creds)return null;
 if(!isExpiringSoon(creds.expiresAt))return {token:creds.accessToken,source:'oauth'};
 if(!creds.refreshToken)return null;
 try {
  const refreshed=await refreshTokens({env,fetcher,refreshToken:creds.refreshToken});
  saveCredentials(store.db,env,'canva',{...refreshed,externalAccountId:creds.externalAccountId,metadata:undefined},null,tenantId);
  return {token:refreshed.accessToken,source:'oauth'};
 } catch {
  return null;
 }
}
