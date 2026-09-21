import {ConnectorError} from '../connectors.js';
import {resolveMetaAccessToken} from './meta-oauth.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {envForTenant} from './credential-policy.js';

const GRAPH_VERSION='v21.0';
const GRAPH_BASE='https://graph.facebook.com/'+GRAPH_VERSION;

async function requestJson(fetcher,url,options={}) {
 let response;
 try {response=await fetcher(url,{...options,signal:AbortSignal.timeout(45000)});}
 catch {throw new ConnectorError('NETWORK_OR_TIMEOUT');}
 let data;
 try {data=await response.json();} catch {throw new ConnectorError('INVALID_PROVIDER_RESPONSE');}
 if(!response.ok||data.error)throw new ConnectorError(response.status===401||response.status===403?'CREDENTIALS_REJECTED':response.status===429?'RATE_LIMITED':'PROVIDER_ERROR');
 return data;
}
// Multi-Tenant Phase 4B (Part 63/94) — these two lookups used to read `integration_credentials`
// by provider ALONE, with no tenant_id filter at all: with a second tenant's `meta` row in the
// same table, SQLite would return whichever row it happened to store first, silently leaking
// one tenant's Instagram/Page id into another tenant's publish call. `tenantId` (threaded from
// ctx.tenantId at every real call site) closes that; a null tenantId falls back to
// resolveActiveTenantId(db) exactly as before, for the one tenant that exists today.
function instagramAccountId(db,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const row=db.prepare('SELECT metadata FROM integration_credentials WHERE provider=? AND tenant_id=?').get('meta',resolvedTenantId);
 return row?.metadata?JSON.parse(row.metadata)?.instagram?.id:null;
}
function pageId(db,env,tenantId=null) { env=envForTenant(db,env,tenantId);
 if(env.META_PAGE_ID)return env.META_PAGE_ID;
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const row=db.prepare('SELECT external_account_id FROM integration_credentials WHERE provider=? AND tenant_id=?').get('meta',resolvedTenantId);
 return row?.external_account_id||null;
}
/**
 * Instagram's real publish flow is two calls: create a media container (image/video URL +
 * caption), then publish that container. Facebook Pages publish directly in one call. Both
 * require a Page/IG-linked access token, never a personal user token. Callers (the
 * meta_publish tool) are responsible for every safety check listed in the spec's
 * "PUBLISHING SAFETY" section BEFORE calling this — this function assumes they already
 * passed and only executes the actual API calls.
 */
export async function publishToInstagram({store,env,fetcher=fetch},{imageUrl,caption},tenantId=null) {
 const resolved=resolveMetaAccessToken({store,env},'page',tenantId);
 const igId=instagramAccountId(store.db,tenantId);
 if(!resolved||!igId)return {status:'INTEGRATION_REQUIRED',integration:'meta'};
 const container=await requestJson(fetcher,`${GRAPH_BASE}/${igId}/media`,{
  method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${resolved.token}`},
  body:JSON.stringify({image_url:imageUrl,caption})
 });
 if(!container.id)return {status:'FAILED',errorDetail:'No container id returned'};
 const published=await requestJson(fetcher,`${GRAPH_BASE}/${igId}/media_publish`,{
  method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${resolved.token}`},
  body:JSON.stringify({creation_id:container.id})
 });
 if(!published.id)return {status:'FAILED',errorDetail:'No published post id returned'};
 return {status:'PUBLISHED',externalPostId:published.id,liveUrl:`https://www.instagram.com/p/${published.id}/`};
}
/**
 * Phase MKT-2, Part I/J — real Messenger/Instagram DM reply via Meta's unified Send API
 * (`POST /{page-id}/messages`), which the Messenger Platform docs confirm also serves
 * Instagram messaging once a Page's Instagram account is linked, using the SAME Page access
 * token as Facebook publishing/comments. `recipientId` is the sender's PSID/IGSID captured
 * off the real inbound webhook — never a phone number or arbitrary id, matching Meta's own
 * requirement that a business can only message a user within an open conversation window.
 */
export async function sendMetaMessage({store,env,fetcher=fetch},{recipientId,text},tenantId=null) {
 const resolved=resolveMetaAccessToken({store,env},'page',tenantId);
 const id=pageId(store.db,env,tenantId);
 if(!resolved||!id)return {status:'INTEGRATION_REQUIRED',integration:'meta'};
 if(!recipientId)return {status:'FAILED',errorDetail:'NO_RECIPIENT_ID'};
 if(typeof text!=='string'||!text.trim())return {status:'FAILED',errorDetail:'EMPTY_TEXT'};
 try {
  const sent=await requestJson(fetcher,`${GRAPH_BASE}/${id}/messages`,{
   method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${resolved.token}`},
   body:JSON.stringify({recipient:{id:recipientId},message:{text},messaging_type:'RESPONSE'})
  });
  if(!sent.message_id)return {status:'FAILED',errorDetail:'NO_MESSAGE_ID_RETURNED'};
  return {status:'SENT',externalMessageId:sent.message_id};
 } catch(error) {
  if(error?.code==='CREDENTIALS_REJECTED')return {status:'FAILED',errorCode:'AUTH_FAILED'};
  if(error?.code==='RATE_LIMITED')return {status:'FAILED',errorCode:'RATE_LIMITED'};
  return {status:'STATUS_UNKNOWN',errorCode:error?.code||'UNKNOWN'};
 }
}
export async function publishToFacebook({store,env,fetcher=fetch},{message,link},tenantId=null) {
 const resolved=resolveMetaAccessToken({store,env},'page',tenantId);
 const id=pageId(store.db,env,tenantId);
 if(!resolved||!id)return {status:'INTEGRATION_REQUIRED',integration:'meta'};
 const published=await requestJson(fetcher,`${GRAPH_BASE}/${id}/feed`,{
  method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${resolved.token}`},
  body:JSON.stringify({message,...(link?{link}:{})})
 });
 if(!published.id)return {status:'FAILED',errorDetail:'No published post id returned'};
 return {status:'PUBLISHED',externalPostId:published.id,liveUrl:`https://www.facebook.com/${published.id}`};
}
/**
 * Meta gives no client-supplied idempotency key for a publish call, so the real protection
 * against a duplicate post after a request timeout is: check whether THIS content item
 * already recorded an externalPostId before ever attempting to publish it again — never a
 * blind retry (spec: "POST PUBLISH TIMEOUT" / "PUBLISHING SAFETY: idempotency").
 */
export function alreadyPublished(job) {
 return !!job?.externalPostId;
}

// Phase MKT-2, Part F — real per-post/account analytics. Mirrors the exact honest-degradation
// pattern already established for LinkedIn/X (linkedin-publishing.js/x-publishing.js): a
// missing or unsupported metric becomes `null` with `status:'NOT_AVAILABLE'`/a per-field
// reason, NEVER a fabricated 0 or estimate. Facebook Page posts and Instagram media use
// separate Graph API insights metric sets — requesting the wrong metric for a media type
// (e.g. `saved` on a video reel) 400s the WHOLE call on some API versions, so each metric is
// requested individually and a per-metric failure never blocks the others.
async function fetchInsightMetric(fetcher,url,token,metric) {
 try {
  const response=await fetcher(`${url}?metric=${metric}&access_token=${encodeURIComponent(token)}`,{signal:AbortSignal.timeout(20000)});
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data||data.error)return null;
  const value=data.data?.[0]?.values?.[0]?.value;
  return typeof value==='number'?value:null;
 } catch {return null;}
}
export async function getFacebookPostInsights({store,env,fetcher=fetch},externalPostId,tenantId=null) {
 const resolved=resolveMetaAccessToken({store,env},'page',tenantId);
 if(!resolved)return {status:'INTEGRATION_REQUIRED'};
 const base=`${GRAPH_BASE}/${externalPostId}/insights`;
 const [impressions,engagedUsers,clicks]=await Promise.all([
  fetchInsightMetric(fetcher,base,resolved.token,'post_impressions'),
  fetchInsightMetric(fetcher,base,resolved.token,'post_engaged_users'),
  fetchInsightMetric(fetcher,base,resolved.token,'post_clicks')
 ]);
 if(impressions===null&&engagedUsers===null&&clicks===null)return {status:'NOT_AVAILABLE',reason:'NO_METRICS_RETURNED'};
 return {
  status:'OK',platform:'Facebook',externalPostId,capturedAt:new Date().toISOString(),
  impressions,reach:null,engagements:engagedUsers,likes:null,comments:null,shares:null,clicks,video_views:null
 };
}
export async function getInstagramMediaInsights({store,env,fetcher=fetch},externalPostId,tenantId=null) {
 const resolved=resolveMetaAccessToken({store,env},'page',tenantId);
 if(!resolved)return {status:'INTEGRATION_REQUIRED'};
 const base=`${GRAPH_BASE}/${externalPostId}/insights`;
 const [impressions,reach,engagement,saved]=await Promise.all([
  fetchInsightMetric(fetcher,base,resolved.token,'impressions'),
  fetchInsightMetric(fetcher,base,resolved.token,'reach'),
  fetchInsightMetric(fetcher,base,resolved.token,'engagement'),
  fetchInsightMetric(fetcher,base,resolved.token,'saved')
 ]);
 if(impressions===null&&reach===null&&engagement===null&&saved===null)return {status:'NOT_AVAILABLE',reason:'NO_METRICS_RETURNED'};
 return {
  status:'OK',platform:'Instagram',externalPostId,capturedAt:new Date().toISOString(),
  impressions,reach,engagements:engagement,likes:null,comments:null,shares:saved,clicks:null,video_views:null
 };
}
/**
 * Account-level follower counts — the one metric available with NO specific post needed.
 * Facebook Pages expose `fan_count`; Instagram Business accounts expose `followers_count`.
 * Each is fetched independently so a Page-only (no linked Instagram) connection still
 * reports its real Facebook follower count instead of failing the whole call.
 */
export async function getMetaFollowerCounts({store,env,fetcher=fetch},tenantId=null) {
 const resolved=resolveMetaAccessToken({store,env},'page',tenantId);
 if(!resolved)return {status:'INTEGRATION_REQUIRED'};
 const fbId=pageId(store.db,env,tenantId);
 const igId=instagramAccountId(store.db,tenantId);
 let facebookFollowers=null,instagramFollowers=null;
 if(fbId) {
  try {
   const response=await fetcher(`${GRAPH_BASE}/${fbId}?fields=fan_count&access_token=${encodeURIComponent(resolved.token)}`,{signal:AbortSignal.timeout(20000)});
   const data=await response.json().catch(()=>null);
   if(response.ok&&typeof data?.fan_count==='number')facebookFollowers=data.fan_count;
  } catch { /* left null — never fabricated */ }
 }
 if(igId) {
  try {
   const response=await fetcher(`${GRAPH_BASE}/${igId}?fields=followers_count&access_token=${encodeURIComponent(resolved.token)}`,{signal:AbortSignal.timeout(20000)});
   const data=await response.json().catch(()=>null);
   if(response.ok&&typeof data?.followers_count==='number')instagramFollowers=data.followers_count;
  } catch { /* left null — never fabricated */ }
 }
 if(facebookFollowers===null&&instagramFollowers===null)return {status:'NOT_AVAILABLE',reason:'NO_METRICS_RETURNED'};
 return {status:'OK',capturedAt:new Date().toISOString(),facebookFollowers,instagramFollowers,pageId:fbId||null,instagramAccountId:igId||null};
}
