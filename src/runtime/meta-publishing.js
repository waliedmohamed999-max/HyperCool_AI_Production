import {ConnectorError} from '../connectors.js';
import {resolveMetaAccessToken} from './meta-oauth.js';

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
function instagramAccountId(db) {
 const row=db.prepare('SELECT metadata FROM integration_credentials WHERE provider=?').get('meta');
 return row?.metadata?JSON.parse(row.metadata)?.instagram?.id:null;
}
function pageId(db,env) {
 return env.META_PAGE_ID||(()=>{const row=db.prepare('SELECT external_account_id FROM integration_credentials WHERE provider=?').get('meta');return row?.external_account_id||null;})();
}
/**
 * Instagram's real publish flow is two calls: create a media container (image/video URL +
 * caption), then publish that container. Facebook Pages publish directly in one call. Both
 * require a Page/IG-linked access token, never a personal user token. Callers (the
 * meta_publish tool) are responsible for every safety check listed in the spec's
 * "PUBLISHING SAFETY" section BEFORE calling this — this function assumes they already
 * passed and only executes the actual API calls.
 */
export async function publishToInstagram({store,env,fetcher=fetch},{imageUrl,caption}) {
 const resolved=resolveMetaAccessToken({store,env},'page');
 const igId=instagramAccountId(store.db);
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
export async function publishToFacebook({store,env,fetcher=fetch},{message,link}) {
 const resolved=resolveMetaAccessToken({store,env},'page');
 const id=pageId(store.db,env);
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
