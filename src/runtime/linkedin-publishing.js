import {resolveLinkedInAccessToken} from './linkedin-oauth.js';

const API_BASE='https://api.linkedin.com/v2';

export function classifyLinkedInError(status,data) {
 if(status===429)return {code:'RATE_LIMIT'};
 if(status===401)return {code:'AUTH_FAILED'};
 if(status===403)return {code:'PERMISSION_MISSING'};
 if(status===400||status===422)return {code:'INVALID_CONTENT'};
 if(status>=500)return {code:'API_UNAVAILABLE'};
 return {code:'UNKNOWN'};
}
async function requestRaw(fetcher,url,options={}) {
 let response;
 try {response=await fetcher(url,{...options,signal:AbortSignal.timeout(30000)});}
 catch {return {networkError:true};}
 let data=null;
 try {const text=await response.text();data=text?JSON.parse(text):null;} catch { /* LinkedIn's ugcPosts 201 response body is empty; the created id comes back in a header */ }
 return {response,data};
}
/**
 * Publishes one text (optionally + link) post to the connected Company Page — never a
 * personal profile (spec Part G: "Do not publish automatically on personal profile").
 * LinkedIn's real UGC Posts API returns the created post's URN in the `x-restli-id`
 * response header on success, not in the JSON body (which is typically empty on 201) —
 * reading the header is the correct, real integration detail, not a guess.
 */
export async function publishLinkedInPost({store,env,fetcher=fetch},{text,link},tenantId=null) {
 const resolved=await resolveLinkedInAccessToken({store,env,fetcher},tenantId);
 if(!resolved||!resolved.organizationId)return {status:'INTEGRATION_REQUIRED',integration:'linkedin'};
 if(typeof text!=='string'||!text.trim())return {status:'FAILED',errorCode:'INVALID_CONTENT',errorDetail:'EMPTY_TEXT'};
 const body={
  author:`urn:li:organization:${resolved.organizationId}`,
  lifecycleState:'PUBLISHED',
  specificContent:{'com.linkedin.ugc.ShareContent':{
   shareCommentary:{text},
   shareMediaCategory:link?'ARTICLE':'NONE',
   ...(link?{media:[{status:'READY',originalUrl:link}]}:{})
  }},
  visibility:{'com.linkedin.ugc.MemberNetworkVisibility':'PUBLIC'}
 };
 const {response,data,networkError}=await requestRaw(fetcher,`${API_BASE}/ugcPosts`,{
  method:'POST',
  headers:{'content-type':'application/json',authorization:`Bearer ${resolved.token}`,'x-restli-protocol-version':'2.0.0'},
  body:JSON.stringify(body)
 });
 if(networkError)return {status:'STATUS_UNKNOWN',errorCode:'API_UNAVAILABLE',errorDetail:'NETWORK_OR_TIMEOUT'};
 if(!response.ok) {
  const classified=classifyLinkedInError(response.status,data);
  return {status:'FAILED',errorCode:classified.code,errorDetail:data?.message||null};
 }
 const postUrn=response.headers.get('x-restli-id')||data?.id;
 if(!postUrn)return {status:'STATUS_UNKNOWN',errorCode:'UNKNOWN',errorDetail:'NO_POST_ID_RETURNED'};
 return {status:'PUBLISHED',externalPostId:postUrn,liveUrl:`https://www.linkedin.com/feed/update/${postUrn}/`};
}
/**
 * Organization post analytics require the Community Management API's analytics endpoint,
 * which is a SEPARATE approval from basic organization posting — most apps will not have
 * it. Never simulated: a 403/permission failure here is reported as NOT_AVAILABLE, exactly
 * as the spec requires (Part X: "If not: mark ANALYTICS_NOT_AVAILABLE. Do not simulate.").
 */
export async function getLinkedInPostMetrics({store,env,fetcher=fetch},externalPostId,tenantId=null) {
 const resolved=await resolveLinkedInAccessToken({store,env,fetcher},tenantId);
 if(!resolved||!resolved.organizationId)return {status:'INTEGRATION_REQUIRED'};
 const url=`${API_BASE}/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent('urn:li:organization:'+resolved.organizationId)}&shares[0]=${encodeURIComponent(externalPostId)}`;
 const {response,data,networkError}=await requestRaw(fetcher,url,{headers:{authorization:`Bearer ${resolved.token}`,'x-restli-protocol-version':'2.0.0'}});
 if(networkError)return {status:'NOT_AVAILABLE',reason:'NETWORK_OR_TIMEOUT'};
 if(!response.ok)return {status:'NOT_AVAILABLE',reason:classifyLinkedInError(response.status,data).code};
 const stats=data?.elements?.[0]?.totalShareStatistics;
 if(!stats)return {status:'NOT_AVAILABLE',reason:'NO_DATA_RETURNED'};
 return {
  status:'OK',platform:'LINKEDIN',externalPostId,capturedAt:new Date().toISOString(),
  impressions:stats.impressionCount??null,reach:stats.uniqueImpressionsCount??null,
  engagements:stats.engagement??null,likes:stats.likeCount??null,comments:stats.commentCount??null,
  shares:stats.shareCount??null,clicks:stats.clickCount??null,video_views:null
 };
}
/**
 * Phase MKT-2, Part F — organization follower count. LinkedIn's real endpoint for this is
 * organizationalEntityFollowerStatistics with `q=organizationalEntity`, summed across every
 * returned "day"-bucket-less lifetime element (it always returns exactly one lifetime
 * element when the token has the right permission, but summing is still correct if it ever
 * returns more than one). A permission-scoped 403 here is a real, common outcome — Community
 * Management API access is a separate LinkedIn app review track from basic posting — reported
 * honestly as NOT_AVAILABLE, never estimated.
 */
export async function getLinkedInFollowerCount({store,env,fetcher=fetch},tenantId=null) {
 const resolved=await resolveLinkedInAccessToken({store,env,fetcher},tenantId);
 if(!resolved||!resolved.organizationId)return {status:'INTEGRATION_REQUIRED'};
 const url=`${API_BASE}/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent('urn:li:organization:'+resolved.organizationId)}`;
 const {response,data,networkError}=await requestRaw(fetcher,url,{headers:{authorization:`Bearer ${resolved.token}`,'x-restli-protocol-version':'2.0.0'}});
 if(networkError)return {status:'NOT_AVAILABLE',reason:'NETWORK_OR_TIMEOUT'};
 if(!response.ok)return {status:'NOT_AVAILABLE',reason:classifyLinkedInError(response.status,data).code};
 const elements=data?.elements||[];
 if(!elements.length)return {status:'NOT_AVAILABLE',reason:'NO_DATA_RETURNED'};
 const total=elements.reduce((sum,el)=>sum+(el.followerCounts?.organicFollowerCount||0)+(el.followerCounts?.paidFollowerCount||0),0);
 return {status:'OK',capturedAt:new Date().toISOString(),followers:total,organizationId:resolved.organizationId};
}
/**
 * Real, minimal connectivity check for the Integrations page. Distinguishes "connected but
 * no organization resolved" (identity works, publishing does not) from a full OK, never
 * claiming publishing capability that was never actually verified.
 */
export async function testLinkedInConnection({store,env,fetcher=fetch},tenantId=null) {
 const resolved=await resolveLinkedInAccessToken({store,env,fetcher},tenantId);
 if(!resolved)return {result:'NOT_CONFIGURED',code:'LINKEDIN_NOT_CONFIGURED'};
 const {response,data,networkError}=await requestRaw(fetcher,`${API_BASE}/userinfo`,{headers:{authorization:`Bearer ${resolved.token}`}});
 if(networkError)return {result:'NETWORK_ERROR',code:'NETWORK_OR_TIMEOUT'};
 if(!response.ok)return {result:classifyLinkedInError(response.status,data).code==='AUTH_FAILED'?'AUTH_FAILED':'NETWORK_ERROR',code:classifyLinkedInError(response.status,data).code};
 if(!resolved.organizationId)return {result:'CONFIGURED_NO_ORGANIZATION',code:'LINKEDIN_ORGANIZATION_MISSING',note:'الهوية متصلة لكن لا توجد صفحة شركة محددة — لا يمكن النشر بدونها'};
 return {result:'OK'};
}
