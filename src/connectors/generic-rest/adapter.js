// Universal Integration Platform (Phase 6B, Part 3/17) — GenericRestConnectorAdapter. ONE
// shared adapter instance used by every declarative REST connector definition (Acme today,
// a future real provider tomorrow) — it never hardcodes a provider's own base URL, path, or
// auth secret; all of that comes from the manifest (static, per-connector) and the connection's
// own Vault credential (per-tenant, per-connection), threaded in by ConnectorRuntime.
import {safeFetch,CONNECTOR_HTTP_ERROR_CODE} from '../core/ssrf.js';
import {CONNECTOR_ERROR_CODE} from '../core/enums.js';
import {buildQueryMapping,buildBodyMapping,fillPathTemplate,applyResponseMapping} from './mapping.js';
import {buildSafeHeaders} from './headers.js';
import {resolveGenericOAuth2Credential} from '../../runtime/generic-oauth2.js';

class AuthConfigError extends Error {constructor(message){super(message);this.code=CONNECTOR_ERROR_CODE.CAPABILITY_MISSING;}}

function buildAuthHeaders(auth,credential) {
 if(auth.type==='NONE')return {};
 if(auth.type==='API_KEY') {
  const apiKey=credential?.payload?.apiKey;
  if(!apiKey)throw new AuthConfigError('missing API key credential');
  return {[(auth.headerName||'X-Api-Key').toLowerCase()]:apiKey};
 }
 if(auth.type==='BEARER_TOKEN') {
  const token=credential?.payload?.token;
  if(!token)throw new AuthConfigError('missing bearer token credential');
  return {authorization:`Bearer ${token}`};
 }
 if(auth.type==='BASIC') {
  const {username,password}=credential?.payload||{};
  if(!username)throw new AuthConfigError('missing basic auth credential');
  return {authorization:'Basic '+Buffer.from(`${username}:${password||''}`).toString('base64')};
 }
 // Phase 6G, Part 18-24 — a Platform-Admin-defined Generic OAuth2 connector (see
 // src/runtime/generic-oauth2.js). The credential passed in here has ALREADY been through
 // `resolveOAuth2Credential` below (refreshed-if-needed, persisted) by the time this runs.
 if(auth.type==='OAUTH2') {
  const accessToken=credential?.payload?.accessToken;
  if(!accessToken)throw new AuthConfigError('missing OAuth2 credential');
  return {authorization:`Bearer ${accessToken}`};
 }
 throw new AuthConfigError(`unsupported auth type: ${auth.type}`);
}
/** Refreshes-then-persists an OAUTH2 credential on demand (Part 24 — exact connection, Vault
 * credential, no cross-connection fallback) before every real call; every other auth type
 * passes its credential through unchanged. */
async function resolveOAuth2Credential({auth,env,db,connection,credential,fetcher}) {
 if(auth.type!=='OAUTH2'||!connection||!db)return credential;
 try{return await resolveGenericOAuth2Credential({auth,env,db,connection,credential,fetcher:fetcher||fetch});}
 catch{return credential;} // a failed refresh surfaces as a normal auth failure below, not a crash
}

function mapHttpError(code) {
 return {
  [CONNECTOR_HTTP_ERROR_CODE.SSRF_BLOCKED]:'CONNECTOR_SSRF_BLOCKED',
  [CONNECTOR_HTTP_ERROR_CODE.TIMEOUT]:'CONNECTOR_TIMEOUT',
  [CONNECTOR_HTTP_ERROR_CODE.NETWORK_ERROR]:'CONNECTOR_NETWORK_ERROR',
  [CONNECTOR_HTTP_ERROR_CODE.RESPONSE_TOO_LARGE]:'CONNECTOR_RESPONSE_TOO_LARGE',
  [CONNECTOR_HTTP_ERROR_CODE.INVALID_RESPONSE]:'CONNECTOR_INVALID_RESPONSE'
 }[code]||code||'CONNECTOR_REMOTE_ERROR';
}
// Part 43 — safe, honest HTTP status mapping (never assumed to be exactly right for every
// provider's own semantics, but a reasonable, documented default).
function mapHttpStatus(status) {
 if(status===401||status===403)return 'CONNECTOR_AUTH_FAILED';
 if(status===404)return 'CONNECTOR_REMOTE_NOT_FOUND';
 if(status===409||status===422)return 'CONNECTOR_REMOTE_VALIDATION_ERROR';
 if(status===429)return 'CONNECTOR_RATE_LIMITED';
 if(status>=500)return 'CONNECTOR_REMOTE_ERROR';
 return null;
}

async function performRequest({manifest,action,input,credential,resolver,transport,env,db,connection,fetcher}) {
 const auth=manifest.auth;
 const resolvedCredential=await resolveOAuth2Credential({auth,env,db,connection,credential,fetcher});
 const authHeaders=buildAuthHeaders(auth,resolvedCredential);
 const rest=action.rest;
 const path=fillPathTemplate(rest.pathTemplate,input);
 const query=buildQueryMapping(rest.queryMapping,input);
 const headers=buildSafeHeaders({headerMapping:rest.headerMapping,input,authHeaders});
 const body=['POST','PUT','PATCH'].includes(rest.httpMethod)?buildBodyMapping(rest.bodyMapping,input):null;
 if(body && Buffer.byteLength(body)>rest.maxRequestBytes)
  return {status:'ERROR',errorCode:'CONNECTOR_REQUEST_TOO_LARGE'};
 if(body)headers['content-type']='application/json';
 const baseUrl=manifest.rest.tenantConfigurableHost && input.__connectionBaseUrl?input.__connectionBaseUrl:manifest.rest.baseUrl;
 const url=new URL(path+(query?`?${query}`:''),baseUrl).href;
 let response;
 try {
  response=await safeFetch(url,{
   method:rest.httpMethod,headers,body,timeoutMs:action.timeoutMs,maxResponseBytes:rest.maxResponseBytes,
   allowHttp:manifest.rest.allowHttp,allowedHosts:manifest.rest.tenantConfigurableHost?null:manifest.rest.allowedHosts,
   resolver,transport
  });
 } catch(error) {
  return {status:'ERROR',errorCode:mapHttpError(error.code)};
 }
 const statusError=mapHttpStatus(response.status);
 if(statusError) {
  // Part 44 — the raw remote body may carry sensitive data; it is deliberately never returned.
  return {status:'ERROR',errorCode:statusError,httpStatus:response.status};
 }
 let parsed;
 try{parsed=JSON.parse(response.body.toString('utf8')||'null');}
 catch{return {status:'ERROR',errorCode:'CONNECTOR_INVALID_RESPONSE'};}
 const output=rest.responseMapping?applyResponseMapping(rest.responseMapping,parsed):parsed;
 return {status:'OK',output,httpStatus:response.status};
}

export const genericRestAdapter={
 async healthCheck({credential,manifest,resolver,transport,env,db,connection,fetcher}) {
  const health=manifest.rest.health;
  if(!health)return {status:'OK'}; // no declared health check — nothing to verify beyond auth presence
  if(!['GET','HEAD'].includes((health.method||'GET').toUpperCase()))
   return {status:'ERROR',errorCode:'CONNECTOR_INVALID_RESPONSE'}; // Part 47 — health is read-only, never POST
  const resolvedCredential=await resolveOAuth2Credential({auth:manifest.auth,env,db,connection,credential,fetcher});
  const authHeaders=(()=>{try{return buildAuthHeaders(manifest.auth,resolvedCredential);}catch{return null;}})();
  if(authHeaders===null)return {status:'NOT_CONFIGURED',errorCode:CONNECTOR_ERROR_CODE.CAPABILITY_MISSING};
  const url=new URL(health.path,manifest.rest.baseUrl).href;
  try {
   const response=await safeFetch(url,{method:(health.method||'GET').toUpperCase(),headers:authHeaders,timeoutMs:10000,maxResponseBytes:256*1024,allowHttp:manifest.rest.allowHttp,allowedHosts:manifest.rest.allowedHosts,resolver,transport});
   if(health.expectedStatus && response.status!==health.expectedStatus)return {status:mapHttpStatus(response.status)?'ERROR':'DEGRADED',errorCode:mapHttpStatus(response.status)||'CONNECTOR_INVALID_RESPONSE'};
   return {status:'OK'};
  } catch(error) {
   return {status:'ERROR',errorCode:mapHttpError(error.code)};
  }
 },
 async executeAction({action,input,credential,manifest,resolver,transport,env,db,connection,fetcher}) {
  return performRequest({manifest,action,input,credential,resolver,transport,env,db,connection,fetcher});
 }
};
