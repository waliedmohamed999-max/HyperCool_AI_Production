// Universal Integration Platform (Phase 6E) — ZidConnectorAdapter. Authentication (OAuth2
// token exchange/refresh) needs Zid-specific code (src/runtime/zid-oauth.js — a real,
// documented flow, never a generic tenant-typed OAuth URL, Part 3/51), but ACTION EXECUTION
// reuses the exact same SSRF-hardened transport (`safeFetch`) the Generic REST Adapter uses —
// never a raw, unprotected `fetch` bypass (Part 17/18). This is deliberately a thin,
// provider-specific adapter, not a second execution runtime: every real call goes through the
// one safe transport, and the shape it returns is a plain `{status, output}` exactly like
// every other adapter in this codebase.
import {safeFetch,CONNECTOR_HTTP_ERROR_CODE} from '../core/ssrf.js';
import {CONNECTOR_ERROR_CODE} from '../core/enums.js';
import {refreshZidTokens} from '../../runtime/zid-oauth.js';
import {storeCredential} from '../../integrations/vault.js';

// Official, fixed base URL (docs.zid.sa/authorization: "API Base URL: https://api.zid.sa/v1") —
// platform-managed and never tenant-editable (Part 16): there is no `baseUrl` field a Builder
// or tenant could point elsewhere, unlike a Generic REST connector.
const BASE_URL='https://api.zid.sa/v1';
const ALLOWED_HOSTS=['api.zid.sa'];

// This adapter follows Salla's (Phase 6A) established `CONNECTOR_ERROR_CODE` vocabulary
// (short-form: AUTH_FAILED, RATE_LIMITED, ...) since it is a BUILT_IN adapter like Salla, not a
// GENERIC_REST one — that family instead uses its own `CONNECTOR_*`-prefixed string codes
// (`generic-rest/adapter.js`). `CONNECTOR_ERROR_CODE` has no dedicated "malformed body" value,
// so SSRF/timeout/network/oversized/malformed all collapse to the closest real code it defines:
// NETWORK_ERROR for anything connection-shaped, REMOTE_SERVER_ERROR for a response Zid itself
// returned but this adapter couldn't parse.
function mapHttpError(code) {
 return {
  [CONNECTOR_HTTP_ERROR_CODE.SSRF_BLOCKED]:CONNECTOR_ERROR_CODE.NETWORK_ERROR,
  [CONNECTOR_HTTP_ERROR_CODE.TIMEOUT]:CONNECTOR_ERROR_CODE.TIMEOUT,
  [CONNECTOR_HTTP_ERROR_CODE.NETWORK_ERROR]:CONNECTOR_ERROR_CODE.NETWORK_ERROR,
  [CONNECTOR_HTTP_ERROR_CODE.RESPONSE_TOO_LARGE]:CONNECTOR_ERROR_CODE.REMOTE_SERVER_ERROR,
  [CONNECTOR_HTTP_ERROR_CODE.INVALID_RESPONSE]:CONNECTOR_ERROR_CODE.REMOTE_SERVER_ERROR
 }[code]||CONNECTOR_ERROR_CODE.REMOTE_SERVER_ERROR;
}
// Official Zid error shape (docs.zid.sa/responses): {status, success:false, error:{code,
// message, fields}}. Mapped to this platform's own standardized connector error codes — the
// raw body (which could carry customer-identifying validation detail) is never returned as-is.
function mapHttpStatus(status) {
 if(status===401||status===403)return CONNECTOR_ERROR_CODE.AUTH_FAILED;
 if(status===404)return CONNECTOR_ERROR_CODE.REMOTE_NOT_FOUND;
 if(status===422)return CONNECTOR_ERROR_CODE.REMOTE_VALIDATION_ERROR;
 if(status===429)return CONNECTOR_ERROR_CODE.RATE_LIMITED;
 if(status>=500)return CONNECTOR_ERROR_CODE.REMOTE_SERVER_ERROR;
 return null;
}
function authHeaders(accessToken) {
 // docs.zid.sa/authorization: both headers carry the SAME access token value — "Authorization:
 // Bearer [access_token]" and "X-Manager-Token" containing that same access_token — confirmed
 // identically across four independent official endpoint pages (account profile, orders,
 // customers, the authorization overview itself). See docs/ZID_CONNECTOR.md.
 return {authorization:`Bearer ${accessToken}`,'x-manager-token':accessToken};
}
async function zidGet({path,query,accessToken,resolver,transport,timeoutMs=20000}) {
 const url=new URL(path,BASE_URL+'/');
 if(query)for(const [key,value] of Object.entries(query))if(value!==undefined&&value!==null)url.searchParams.set(key,String(value));
 let response;
 try {
  response=await safeFetch(url.href,{method:'GET',headers:authHeaders(accessToken),timeoutMs,maxResponseBytes:2*1024*1024,allowedHosts:ALLOWED_HOSTS,resolver,transport});
 } catch(error) {
  throw Object.assign(new Error('zid request failed'),{code:mapHttpError(error.code)});
 }
 const statusError=mapHttpStatus(response.status);
 if(statusError)throw Object.assign(new Error(`zid remote error ${response.status}`),{code:statusError,httpStatus:response.status});
 let parsed;
 try{parsed=JSON.parse(response.body.toString('utf8')||'null');}
 catch{throw Object.assign(new Error('invalid zid response'),{code:CONNECTOR_ERROR_CODE.REMOTE_SERVER_ERROR});}
 return parsed;
}
/**
 * Refresh-then-retry-once (Part 52/53): if the connection's stored token is expiring/expired
 * and a refresh token exists, refresh BEFORE the real call rather than reacting to a 401 —
 * avoids ever sending a known-stale token, and keeps this fully consistent with how
 * `resolveSallaAccessToken` already treats "expiring soon" for the existing Salla flow. A
 * concurrent double-refresh race (Part 53) is accepted at the same, already-established
 * granularity every other OAuth provider in this codebase relies on (the Vault's single-row
 * `UPDATE` per connection is the only real serialization point) — no new locking primitive is
 * introduced for this one connector.
 */
async function resolveAccessToken({env,db,connection,credential}) {
 const accessToken=credential?.payload?.accessToken;
 const expiresAt=credential?.payload?.expiresAt;
 const refreshToken=credential?.payload?.refreshToken;
 if(!accessToken)return {token:null,refreshed:null};
 if(!expiresAt||new Date(expiresAt).getTime()-Date.now()>5*60*1000)return {token:accessToken,refreshed:null};
 if(!refreshToken)return {token:null,refreshed:null,reauthRequired:true};
 try {
  const refreshed=await refreshZidTokens({env,refreshToken});
  // Part 52 — persist the new token pair back to the Vault immediately so the NEXT call
  // reuses it instead of refreshing again on every request; only possible when a real `db`+
  // `connection` were threaded through by ConnectorRuntime (Phase 6E's additive `db` param).
  if(db&&connection)storeCredential(db,env,{connectionId:connection.id,credentialType:'oauth_tokens',payload:{accessToken:refreshed.accessToken,refreshToken:refreshed.refreshToken||refreshToken,expiresAt:refreshed.expiresAt}},connection.tenantId);
  return {token:refreshed.accessToken,refreshed};
 } catch {
  // Part 54 — refresh failed (expired/revoked refresh token): reauthorization required, never
  // a silent fallback to some other tenant/global credential.
  return {token:null,refreshed:null,reauthRequired:true};
 }
}

export const zidAdapter={
 async healthCheck({env,db,credential,connection,resolver,transport}) {
  const {token,reauthRequired}=await resolveAccessToken({env,db,connection,credential});
  if(!token)return {status:reauthRequired?'TOKEN_EXPIRED':'NOT_CONFIGURED',errorCode:reauthRequired?CONNECTOR_ERROR_CODE.AUTH_FAILED:CONNECTOR_ERROR_CODE.CAPABILITY_MISSING};
  try {
   const profile=await zidGet({path:'managers/account/profile',accessToken:token,resolver,transport,timeoutMs:10000});
   if(!profile?.store?.id)return {status:'ERROR',errorCode:CONNECTOR_ERROR_CODE.REMOTE_SERVER_ERROR};
   return {status:'OK',externalAccountId:String(profile.store.id),externalAccountName:profile.store.title||null};
  } catch(error) {
   return {status:'ERROR',errorCode:error.code||CONNECTOR_ERROR_CODE.REMOTE_SERVER_ERROR};
  }
 },
 async executeAction({action,input,env,db,credential,connection,resolver,transport}) {
  const {token,reauthRequired}=await resolveAccessToken({env,db,connection,credential});
  if(!token)return {status:'ERROR',errorCode:reauthRequired?CONNECTOR_ERROR_CODE.AUTH_FAILED:CONNECTOR_ERROR_CODE.CAPABILITY_MISSING};
  try {
   if(action.slug==='get_orders') {
    // docs.zid.sa/list-of-orders: GET /v1/managers/store/orders, query params page/per_page.
    const data=await zidGet({path:'managers/store/orders',accessToken:token,resolver,transport,timeoutMs:action.timeoutMs,
     query:{page:input?.page,per_page:input?.perPage}});
    return {status:'OK',output:{orders:data.orders||[],totalOrderCount:data.total_order_count??null}};
   }
   if(action.slug==='get_customers') {
    // docs.zid.sa/list-of-customers: GET /v1/managers/store/customers, query params page/per_page.
    const data=await zidGet({path:'managers/store/customers',accessToken:token,resolver,transport,timeoutMs:action.timeoutMs,
     query:{page:input?.page,per_page:input?.perPage}});
    return {status:'OK',output:{customers:data.customers||[],totalCustomersCount:data.total_customers_count??null}};
   }
   return {status:'ERROR',errorCode:CONNECTOR_ERROR_CODE.CAPABILITY_MISSING};
  } catch(error) {
   return {status:'ERROR',errorCode:error.code||CONNECTOR_ERROR_CODE.REMOTE_SERVER_ERROR};
  }
 }
};
