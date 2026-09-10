import {randomBytes} from 'node:crypto';
import {ConnectorError} from '../connectors.js';
import {getCredentials,saveCredentials,clearCredentials,getCredentialsMeta,updateCredentialsMetadata,isExpiringSoon,credentialsConfigured} from './credentials.js';

// LinkedIn's real OAuth 2.0 endpoints per the LinkedIn Developer docs. Confirm against your
// own app's dashboard before relying on them in production — which scopes are actually
// GRANTED depends entirely on which LinkedIn API products your app has been approved for
// (see docs/LINKEDIN_INTEGRATION_SETUP.md); requesting a scope your app isn't approved for
// fails the consent screen, it does not silently downgrade.
const AUTHORIZE_URL='https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL='https://www.linkedin.com/oauth/v2/accessToken';
const API_BASE='https://api.linkedin.com/v2';
// openid/profile/email resolve the connected person's identity (Sign In with LinkedIn using
// OpenID Connect — the "Share on LinkedIn" product). w_organization_social/r_organization_social/
// rw_organization_admin are needed to publish to and enumerate a Company Page, and require the
// separate "Community Management API" product, which LinkedIn grants only on request/review —
// see Part V of the setup doc. This app never publishes to a personal profile (spec Part G).
const DEFAULT_SCOPES=['openid','profile','email','w_organization_social','r_organization_social','rw_organization_admin'];

export function linkedInOAuthConfigured(env) {
 return !!(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET && env.LINKEDIN_REDIRECT_URI);
}
const pendingStates=new Map();
export function createLinkedInAuthorizeUrl(env,userId) {
 if(!linkedInOAuthConfigured(env))throw new ConnectorError('LINKEDIN_OAUTH_NOT_CONFIGURED');
 const state=randomBytes(24).toString('base64url');
 pendingStates.set(state,{userId,at:Date.now()});
 const url=new URL(AUTHORIZE_URL);
 url.searchParams.set('response_type','code');
 url.searchParams.set('client_id',env.LINKEDIN_CLIENT_ID);
 url.searchParams.set('redirect_uri',env.LINKEDIN_REDIRECT_URI);
 url.searchParams.set('scope',DEFAULT_SCOPES.join(' '));
 url.searchParams.set('state',state);
 return url.href;
}
export function consumeLinkedInState(state,userId) {
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
 if(!response.ok)throw new ConnectorError(response.status===401||response.status===403?'CREDENTIALS_REJECTED':response.status===429?'RATE_LIMITED':'PROVIDER_ERROR');
 return data;
}
export async function exchangeCodeForTokens({env,fetcher=fetch,code}) {
 if(!linkedInOAuthConfigured(env))throw new ConnectorError('LINKEDIN_OAUTH_NOT_CONFIGURED');
 const data=await requestJson(fetcher,TOKEN_URL,{
  method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:env.LINKEDIN_REDIRECT_URI,client_id:env.LINKEDIN_CLIENT_ID,client_secret:env.LINKEDIN_CLIENT_SECRET}).toString()
 });
 if(!data.access_token)throw new ConnectorError('INVALID_PROVIDER_RESPONSE');
 return {
  accessToken:data.access_token,
  // A refresh_token is only ever returned to apps LinkedIn has enrolled in "Programmatic
  // Refresh Tokens" — most apps get none, and the 60-day access token must be re-authorized
  // by a human when it expires (see the "reauthorize" surfacing in linkedInOAuthStatus below).
  refreshToken:data.refresh_token||null,
  expiresAt:Number.isFinite(data.expires_in)?new Date(Date.now()+data.expires_in*1000).toISOString():null,
  scopes:typeof data.scope==='string'?data.scope.split(/[, ]+/).filter(Boolean):DEFAULT_SCOPES
 };
}
export async function resolveConnectedProfile({fetcher=fetch,accessToken}) {
 const data=await requestJson(fetcher,`${API_BASE}/userinfo`,{headers:{authorization:`Bearer ${accessToken}`}});
 return {sub:data.sub,name:data.name||null,email:data.email||null};
}
/**
 * Resolves the Company Page(s) this connected person actually administers — LinkedIn has no
 * "pick one page" UI equivalent to Meta's; this is the real API call (organizationAcls) that
 * lists them. Requires rw_organization_admin, which is exactly the scope most likely to be
 * missing on a freshly-created app (see setup doc) — a failure here is expected and handled,
 * not a bug: the connection still succeeds as identity-only, just without publishing capability
 * until an organization is resolved.
 */
export async function resolveAdministeredOrganizations({fetcher=fetch,accessToken}) {
 const data=await requestJson(fetcher,`${API_BASE}/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&projection=(elements*(organizationalTarget~(id,localizedName)))`,{headers:{authorization:`Bearer ${accessToken}`,'X-Restli-Protocol-Version':'2.0.0'}});
 return (data.elements||[]).map(el=>({id:String(el['organizationalTarget~']?.id||''),name:el['organizationalTarget~']?.localizedName||null})).filter(org=>org.id);
}
export function saveLinkedInConnection(db,env,{accessToken,refreshToken,expiresAt,scopes},profile,organization,user) {
 return saveCredentials(db,env,'linkedin',{
  accessToken,refreshToken,expiresAt,scopes,externalAccountId:organization?.id||profile?.sub||null,
  metadata:{profile:profile?{sub:profile.sub,name:profile.name,email:profile.email}:null,organization:organization||null}
 },user);
}
export function linkedInOAuthStatus(db) {
 const meta=getCredentialsMeta(db,'linkedin');
 if(!meta)return {connected:false};
 return {
  connected:true,expiresAt:meta.expiresAt,scopes:meta.scopes,
  profile:meta.metadata?.profile||null,organization:meta.metadata?.organization||null,
  publishingCapable:!!meta.metadata?.organization?.id,
  connectedByName:meta.connectedByName,connectedAt:meta.connectedAt,
  tokenExpired:isExpiringSoon(meta.expiresAt,0),reauthorizeRequired:isExpiringSoon(meta.expiresAt,0)
 };
}
export function disconnectLinkedIn(db) {
 clearCredentials(db,'linkedin');
}
export function setLinkedInOrganization(db,organization) {
 return updateCredentialsMetadata(db,'linkedin',{organization});
}
function organizationIdFromMeta(db,env) {
 if(env.LINKEDIN_ORGANIZATION_ID)return env.LINKEDIN_ORGANIZATION_ID;
 const meta=getCredentialsMeta(db,'linkedin');
 return meta?.metadata?.organization?.id||null;
}
/**
 * LinkedIn access tokens with no refresh_token simply cannot be silently renewed — this
 * returns null once expired rather than attempting a refresh call guaranteed to fail
 * (spec Part AO: "if reauthorization required, show action in Integration UI", which
 * linkedInOAuthStatus's `reauthorizeRequired` flag drives). Falls back to a static
 * LINKEDIN_ACCESS_TOKEN + LINKEDIN_ORGANIZATION_ID pair for a manually-issued token.
 */
export async function resolveLinkedInAccessToken({store,env,fetcher=fetch}) {
 if(credentialsConfigured(env)) {
  let creds;
  try {creds=getCredentials(store.db,env,'linkedin');} catch {creds=null;}
  if(creds) {
   if(!isExpiringSoon(creds.expiresAt))return {token:creds.accessToken,organizationId:organizationIdFromMeta(store.db,env),source:'oauth'};
   return env.LINKEDIN_ACCESS_TOKEN?{token:env.LINKEDIN_ACCESS_TOKEN,organizationId:env.LINKEDIN_ORGANIZATION_ID||null,source:'static'}:null;
  }
 }
 return env.LINKEDIN_ACCESS_TOKEN?{token:env.LINKEDIN_ACCESS_TOKEN,organizationId:env.LINKEDIN_ORGANIZATION_ID||null,source:'static'}:null;
}
