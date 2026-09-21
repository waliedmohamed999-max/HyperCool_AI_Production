import {randomBytes} from 'node:crypto';
import {ConnectorError} from '../connectors.js';
import {envForTenant} from './credential-policy.js';
import {getCredentials,saveCredentials,clearCredentials,getCredentialsMeta,isExpiringSoon,credentialsConfigured} from './credentials.js';

// Microsoft identity platform (Azure AD / Entra ID) v2.0 endpoints. `tenant` is
// 'organizations' (any work/school account), 'common' (work/school + personal), or a
// specific tenant GUID — confirm which your Azure app registration is set to; a mismatch
// here is the most common real-world OAuth failure for this provider.
function authorizeUrl(tenant){return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;}
function tokenUrl(tenant){return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;}
export const GRAPH_BASE=process.env.MICROSOFT_GRAPH_BASE_URL_DEFAULT||'https://graph.microsoft.com/v1.0';
// Least-privilege set for what this integration actually does: read/send mail, read the
// signed-in user's own profile, and (only if calendar is enabled) read/write their
// calendar. offline_access is required to receive a refresh_token at all.
const DEFAULT_SCOPES=['offline_access','User.Read','Mail.Read','Mail.Send'];
const CALENDAR_SCOPES=['Calendars.Read','Calendars.ReadWrite'];

export function microsoftOAuthConfigured(env) {
 return !!(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && env.MICROSOFT_REDIRECT_URI);
}
function tenant(env){return env.MICROSOFT_TENANT_ID||'organizations';}
function graphBase(env){return env.MICROSOFT_GRAPH_BASE_URL||GRAPH_BASE;}
export function requestedScopes(env) {
 return env.MICROSOFT_ENABLE_CALENDAR==='true'?[...DEFAULT_SCOPES,...CALENDAR_SCOPES]:DEFAULT_SCOPES;
}
const pendingStates=new Map();
// `externalState` (optional): a DB-backed, tenant-bound single-use state from integrations/oauth-state.js (used by the merchant
// portal flow). When given, this function neither generates nor remembers an in-memory state.
export function createMicrosoftAuthorizeUrl(env,userId,externalState=null) {
 if(!microsoftOAuthConfigured(env))throw new ConnectorError('MICROSOFT_OAUTH_NOT_CONFIGURED');
 const state=externalState||randomBytes(24).toString('base64url');
 if(!externalState)pendingStates.set(state,{userId,at:Date.now()});
 const url=new URL(authorizeUrl(tenant(env)));
 url.searchParams.set('client_id',env.MICROSOFT_CLIENT_ID);
 url.searchParams.set('redirect_uri',env.MICROSOFT_REDIRECT_URI);
 url.searchParams.set('response_type','code');
 url.searchParams.set('response_mode','query');
 url.searchParams.set('scope',requestedScopes(env).join(' '));
 url.searchParams.set('state',state);
 return url.href;
}
export function consumeMicrosoftState(state,userId) {
 const entry=pendingStates.get(state);
 pendingStates.delete(state);
 if(!entry)throw Object.assign(new Error('انتهت صلاحية طلب الربط أو أنه غير معروف؛ ابدأ من جديد'),{status:400});
 if(Date.now()-entry.at>600000)throw Object.assign(new Error('انتهت صلاحية طلب الربط (أكثر من 10 دقائق)؛ ابدأ من جديد'),{status:400});
 if(entry.userId!==userId)throw Object.assign(new Error('طلب الربط بدأه مستخدم مختلف'),{status:403});
 return true;
}
async function requestJson(fetcher,url,options={}) {
 let response;
 try {response=await fetcher(url,{...options,signal:AbortSignal.timeout(20000)});}
 catch {throw new ConnectorError('NETWORK_OR_TIMEOUT');}
 let data;
 try {data=await response.json();} catch {throw new ConnectorError('INVALID_PROVIDER_RESPONSE');}
 if(!response.ok||data.error)throw new ConnectorError(response.status===401||response.status===403?'CREDENTIALS_REJECTED':response.status===429?'RATE_LIMITED':'PROVIDER_ERROR');
 return data;
}
function normalizeTokenResponse(data) {
 return {
  accessToken:data.access_token,refreshToken:data.refresh_token||null,
  expiresAt:Number.isFinite(data.expires_in)?new Date(Date.now()+data.expires_in*1000).toISOString():null,
  scopes:typeof data.scope==='string'?data.scope.split(' '):[]
 };
}
export async function exchangeCodeForTokens({env,fetcher=fetch,code}) {
 if(!microsoftOAuthConfigured(env))throw new ConnectorError('MICROSOFT_OAUTH_NOT_CONFIGURED');
 const data=await requestJson(fetcher,tokenUrl(tenant(env)),{
  method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({client_id:env.MICROSOFT_CLIENT_ID,client_secret:env.MICROSOFT_CLIENT_SECRET,redirect_uri:env.MICROSOFT_REDIRECT_URI,grant_type:'authorization_code',code,scope:requestedScopes(env).join(' ')}).toString()
 });
 if(!data.access_token)throw new ConnectorError('INVALID_PROVIDER_RESPONSE');
 return normalizeTokenResponse(data);
}
async function refreshTokens({env,fetcher,refreshToken}) {
 const data=await requestJson(fetcher,tokenUrl(tenant(env)),{
  method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({client_id:env.MICROSOFT_CLIENT_ID,client_secret:env.MICROSOFT_CLIENT_SECRET,grant_type:'refresh_token',refresh_token:refreshToken,scope:requestedScopes(env).join(' ')}).toString()
 });
 if(!data.access_token)throw new ConnectorError('INVALID_PROVIDER_RESPONSE');
 return normalizeTokenResponse(data);
}
/** After the token exchange, fetch /me once to store the real connected identity (email,
 * display name, tenant) — never invented, never left blank when it's this cheap to get. */
export async function resolveConnectedProfile({env,fetcher,accessToken}) {
 const data=await requestJson(fetcher,`${graphBase(env)}/me?$select=id,displayName,mail,userPrincipalName`,{headers:{authorization:`Bearer ${accessToken}`}});
 return {accountId:data.id,displayName:data.displayName||null,email:data.mail||data.userPrincipalName||null};
}
export function saveMicrosoftConnection(db,env,{accessToken,refreshToken,expiresAt,scopes},profile,user,tenantId=null) {
 return saveCredentials(db,env,'microsoft365',{
  accessToken,refreshToken,expiresAt,scopes,externalAccountId:profile.accountId,
  metadata:{email:profile.email,displayName:profile.displayName,tenantId:env.MICROSOFT_TENANT_ID||'organizations',calendarEnabled:scopes.some(s=>s.toLowerCase().includes('calendars'))}
 },user,tenantId);
}
export function microsoftOAuthStatus(db,tenantId=null) {
 const meta=getCredentialsMeta(db,'microsoft365',tenantId);
 if(!meta)return {connected:false};
 return {connected:true,expiresAt:meta.expiresAt,scopes:meta.scopes,email:meta.metadata?.email||null,displayName:meta.metadata?.displayName||null,tenantId:meta.metadata?.tenantId||null,calendarEnabled:!!meta.metadata?.calendarEnabled,connectedByName:meta.connectedByName,connectedAt:meta.connectedAt,tokenExpired:isExpiringSoon(meta.expiresAt,0)};
}
export function disconnectMicrosoft(db,tenantId=null) {
 clearCredentials(db,'microsoft365',tenantId);
}
/**
 * Every Graph API call goes through here. Refreshes automatically when the stored token is
 * within 5 minutes of expiry; on a refresh failure, falls back to the legacy static
 * MICROSOFT_ACCESS_TOKEN env var if one is set (matching the Salla/Meta precedent), else
 * returns null so callers can report TOKEN_EXPIRED/INTEGRATION_REQUIRED honestly.
 */
export async function resolveMicrosoftAccessToken({store,env,fetcher=fetch},tenantId=null) {
 env=envForTenant(store.db,env,tenantId);
 if(credentialsConfigured(env)) {
  let creds;
  try {creds=getCredentials(store.db,env,'microsoft365',tenantId);} catch {creds=null;}
  if(creds) {
   if(!isExpiringSoon(creds.expiresAt))return {token:creds.accessToken,source:'oauth'};
   if(!creds.refreshToken)return env.MICROSOFT_ACCESS_TOKEN?{token:env.MICROSOFT_ACCESS_TOKEN,source:'static'}:null;
   try {
    const refreshed=await refreshTokens({env,fetcher,refreshToken:creds.refreshToken});
    saveCredentials(store.db,env,'microsoft365',{...refreshed,externalAccountId:creds.externalAccountId,metadata:creds.metadata},null,tenantId);
    return {token:refreshed.accessToken,source:'oauth'};
   } catch {
    return env.MICROSOFT_ACCESS_TOKEN?{token:env.MICROSOFT_ACCESS_TOKEN,source:'static'}:null;
   }
  }
 }
 return env.MICROSOFT_ACCESS_TOKEN?{token:env.MICROSOFT_ACCESS_TOKEN,source:'static'}:null;
}
