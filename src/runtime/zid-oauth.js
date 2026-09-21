import {ConnectorError} from '../connectors.js';
import {safeFetch} from '../connectors/core/ssrf.js';

// Phase 6E — Zid's real OAuth 2.0 endpoints per the official Zid Developers documentation
// (docs.zid.sa/authorization, reviewed 2026-09-12 — see docs/ZID_CONNECTOR.md for the full
// documentation audit). Authorization Code grant, confidential client (client_secret required
// server-side). PKCE is NOT documented anywhere in the official docs — never invented (Part 5).
const AUTHORIZE_URL='https://oauth.zid.sa/oauth/authorize';
const TOKEN_URL='https://oauth.zid.sa/oauth/token';

export function zidOAuthConfigured(env) {
 return !!(env.ZID_CLIENT_ID && env.ZID_CLIENT_SECRET && env.ZID_REDIRECT_URI);
}

/**
 * Matches the exact call shape the existing generic multi-connection OAuth route
 * (`/api/integrations/oauth/:slug/start`, application.js) already uses for Salla —
 * `(env, userId, externalState)` — so both providers sit behind one uniform map entry.
 * `userId` is unused here (Zid's flow always supplies a real, DB-backed `externalState` from
 * `integrations/oauth-state.js`, so there is no in-memory-state fallback to key by user, unlike
 * the legacy single-connection Salla flow this mirrors).
 */
export function createZidAuthorizeUrl(env,_userId,externalState) {
 if(!zidOAuthConfigured(env))throw new ConnectorError('ZID_OAUTH_NOT_CONFIGURED');
 const url=new URL(AUTHORIZE_URL);
 url.searchParams.set('client_id',env.ZID_CLIENT_ID);
 url.searchParams.set('response_type','code');
 url.searchParams.set('redirect_uri',env.ZID_REDIRECT_URI);
 url.searchParams.set('state',externalState);
 return url.href;
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
export async function exchangeZidCodeForTokens({env,fetcher=fetch,code}) {
 if(!zidOAuthConfigured(env))throw new ConnectorError('ZID_OAUTH_NOT_CONFIGURED');
 const data=await requestJson(fetcher,TOKEN_URL,{
  method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({grant_type:'authorization_code',client_id:env.ZID_CLIENT_ID,client_secret:env.ZID_CLIENT_SECRET,redirect_uri:env.ZID_REDIRECT_URI,code}).toString()
 });
 if(!data.access_token)throw new ConnectorError('INVALID_PROVIDER_RESPONSE');
 return normalizeZidTokenResponse(data);
}
export async function refreshZidTokens({env,fetcher=fetch,refreshToken}) {
 if(!zidOAuthConfigured(env))throw new ConnectorError('ZID_OAUTH_NOT_CONFIGURED');
 const data=await requestJson(fetcher,TOKEN_URL,{
  method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({grant_type:'refresh_token',client_id:env.ZID_CLIENT_ID,client_secret:env.ZID_CLIENT_SECRET,redirect_uri:env.ZID_REDIRECT_URI,refresh_token:refreshToken}).toString()
 });
 if(!data.access_token)throw new ConnectorError('INVALID_PROVIDER_RESPONSE');
 return normalizeZidTokenResponse(data);
}
// Zid's docs state the refresh token itself "will expire in 1 year" but only ever give a
// numeric `expires_in` (seconds) for the ACCESS token in the token response — never a fixed
// "1 year" numeric constant is hardcoded here; expiresAt is always computed from the real,
// returned `expires_in`.
function normalizeZidTokenResponse(data) {
 return {
  accessToken:data.access_token,
  refreshToken:data.refresh_token||null,
  expiresAt:Number.isFinite(data.expires_in)?new Date(Date.now()+data.expires_in*1000).toISOString():null,
  scopes:typeof data.scope==='string'?data.scope.split(' '):[]
 };
}

export async function resolveZidIdentity({env,fetcher,accessToken}) {
 // docs.zid.sa/get-manager-profile — GET /v1/managers/account/profile, the same real,
 // read-only endpoint Zid's health check uses (Part 20/21) — resolves the real store id/name
 // right after a successful token exchange, through the SSRF-hardened transport, never the
 // bare `fetcher`.
 const response=await safeFetch('https://api.zid.sa/v1/managers/account/profile',{
  method:'GET',headers:{authorization:`Bearer ${accessToken}`,'x-manager-token':accessToken},
  timeoutMs:10000,maxResponseBytes:256*1024,allowedHosts:['api.zid.sa']
 });
 if(response.status!==200)return null;
 const profile=JSON.parse(response.body.toString('utf8')||'null');
 if(!profile?.store?.id)return null;
 return {externalAccountId:String(profile.store.id),externalAccountName:profile.store.title||null};
}
