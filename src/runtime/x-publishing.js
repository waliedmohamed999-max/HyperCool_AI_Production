import {resolveXAccessToken} from './x-oauth.js';

// Well-known, permanently public tweet (Jack Dorsey's first tweet) — used ONLY to verify a
// read-only app-only Bearer token can reach the API at all when no OAuth user is connected.
// This is a real, stable public post id, not fabricated test data; it is never touched, read
// for content, or treated as anything but a connectivity ping.
const WELL_KNOWN_PUBLIC_TWEET_ID='20';

const API_BASE='https://api.twitter.com/2';
// X's real limit (standard tier). A future premium-tier account with a longer limit is a
// per-account fact this codebase cannot know from here — configurable, not hardcoded deep
// inside validation logic, so a future override doesn't require touching the publish path.
export const X_MAX_TWEET_LENGTH=280;

// X shortens every URL to exactly 23 characters via t.co regardless of its real length —
// approximating that (rather than counting raw URL length) avoids rejecting perfectly
// postable copy just because a real product URL happens to be long. Emoji/ZWJ sequences can
// still count differently under X's own grapheme rules than this simple code-point count;
// documented here rather than silently pretended to be exact.
export function tweetLength(text) {
 const withShortenedUrls=String(text||'').replace(/https?:\/\/\S+/g,'x'.repeat(23));
 return Array.from(withShortenedUrls).length;
}
export function validateTweetText(text) {
 if(typeof text!=='string'||!text.trim())return {valid:false,reason:'EMPTY_TEXT'};
 if(tweetLength(text)>X_MAX_TWEET_LENGTH)return {valid:false,reason:'TOO_LONG',length:tweetLength(text),limit:X_MAX_TWEET_LENGTH};
 return {valid:true};
}
/**
 * Maps a failed X API response to the standardized failure classification (spec Part S).
 * `retryAfterSeconds` is read straight from X's own Retry-After header when present — never
 * guessed — so a caller can respect the provider's real backoff instead of inventing one.
 */
export function classifyXError(status,data,retryAfterSeconds=null) {
 if(status===429)return {code:'RATE_LIMIT',retryAfterSeconds};
 if(status===401)return {code:'AUTH_FAILED'};
 if(status===403) {
  const detail=(data?.detail||data?.title||'').toLowerCase();
  if(detail.includes('duplicate'))return {code:'DUPLICATE_REQUEST'};
  return {code:'PERMISSION_MISSING'};
 }
 if(status===400)return {code:'INVALID_CONTENT'};
 if(status>=500)return {code:'API_UNAVAILABLE'};
 return {code:'UNKNOWN'};
}
async function requestJson(fetcher,url,options={}) {
 let response;
 try {response=await fetcher(url,{...options,signal:AbortSignal.timeout(30000)});}
 catch {return {networkError:true};}
 let data=null;
 try {data=await response.json();} catch { /* some X endpoints return no body on success */ }
 return {response,data};
}
/**
 * Publishes exactly one tweet. Requires the OAuth user-context token (see x-oauth.js's
 * `resolveXAccessToken(...,'publish')` — the app-only static bearer cannot post). On a
 * genuine network failure/timeout (no HTTP response at all) this returns STATUS_UNKNOWN
 * rather than FAILED — the request may have gone through on X's side; the caller (see
 * runtime/tools.js x_publish) must never blindly retry that state (spec Part Q).
 */
export async function publishTweet({store,env,fetcher=fetch},{text},tenantId=null) {
 const resolved=await resolveXAccessToken({store,env,fetcher},'publish',tenantId);
 if(!resolved)return {status:'INTEGRATION_REQUIRED',integration:'x'};
 const validation=validateTweetText(text);
 if(!validation.valid)return {status:'FAILED',errorCode:'INVALID_CONTENT',errorDetail:validation.reason};
 const {response,data,networkError}=await requestJson(fetcher,`${API_BASE}/tweets`,{
  method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${resolved.token}`},
  body:JSON.stringify({text})
 });
 if(networkError)return {status:'STATUS_UNKNOWN',errorCode:'API_UNAVAILABLE',errorDetail:'NETWORK_OR_TIMEOUT'};
 if(!response.ok||!data?.data?.id) {
  const classified=classifyXError(response.status,data,response.headers.get('retry-after')?Number(response.headers.get('retry-after')):null);
  return {status:'FAILED',errorCode:classified.code,retryAfterSeconds:classified.retryAfterSeconds||null,errorDetail:data?.detail||data?.title||null};
 }
 const id=data.data.id;
 return {status:'PUBLISHED',externalPostId:id,liveUrl:`https://x.com/i/web/status/${id}`};
}
/**
 * Best-effort metrics for one tweet — public_metrics is available at the standard access
 * level, but a lower/restricted tier (or a token missing tweet.read) can still 403. Never
 * converts a missing field into 0: an unreturned metric stays null and the caller marks
 * analytics coverage PARTIAL, not fabricates a zero (spec Part W/Y).
 */
export async function getXPostMetrics({store,env,fetcher=fetch},externalPostId,tenantId=null) {
 const resolved=await resolveXAccessToken({store,env,fetcher},'read',tenantId);
 if(!resolved)return {status:'INTEGRATION_REQUIRED'};
 const {response,data,networkError}=await requestJson(fetcher,`${API_BASE}/tweets/${externalPostId}?tweet.fields=public_metrics`,{headers:{authorization:`Bearer ${resolved.token}`}});
 if(networkError)return {status:'NOT_AVAILABLE',reason:'NETWORK_OR_TIMEOUT'};
 if(!response.ok||!data?.data)return {status:'NOT_AVAILABLE',reason:classifyXError(response.status,data).code};
 const metrics=data.data.public_metrics||{};
 return {
  status:'OK',platform:'X',externalPostId,capturedAt:new Date().toISOString(),
  impressions:metrics.impression_count??null,reach:null,
  engagements:Number.isFinite(metrics.like_count)&&Number.isFinite(metrics.reply_count)&&Number.isFinite(metrics.retweet_count)?metrics.like_count+metrics.reply_count+metrics.retweet_count:null,
  likes:metrics.like_count??null,comments:metrics.reply_count??null,shares:metrics.retweet_count??null,clicks:null,video_views:null
 };
}
/**
 * Phase MKT-2, Part F — the connected account's real follower count via X API v2's
 * `users/me` with `user.fields=public_metrics`. Needs the OAuth user-context token (same as
 * publishing) — the read-only app bearer alone cannot resolve "me". Reported as
 * INTEGRATION_REQUIRED (not NOT_AVAILABLE) when only the bearer-only read path is configured,
 * matching testXConnection's existing distinction between full OAuth and read-only setups.
 */
export async function getXFollowerCount({store,env,fetcher=fetch},tenantId=null) {
 const resolved=await resolveXAccessToken({store,env,fetcher},'publish',tenantId);
 if(!resolved)return {status:'INTEGRATION_REQUIRED'};
 const {response,data,networkError}=await requestJson(fetcher,`${API_BASE}/users/me?user.fields=public_metrics`,{headers:{authorization:`Bearer ${resolved.token}`}});
 if(networkError)return {status:'NOT_AVAILABLE',reason:'NETWORK_OR_TIMEOUT'};
 if(!response.ok||!data?.data)return {status:'NOT_AVAILABLE',reason:classifyXError(response.status,data).code};
 const followers=data.data.public_metrics?.followers_count;
 if(!Number.isFinite(followers))return {status:'NOT_AVAILABLE',reason:'NO_DATA_RETURNED'};
 return {status:'OK',capturedAt:new Date().toISOString(),followers,userId:data.data.id||null};
}
/**
 * Real, minimal connectivity check for the Integrations page's "اختبار الاتصال" button —
 * never claims OK without an actual API response. An OAuth connection proves full identity
 * (and therefore publishing capability); a static X_BEARER_TOKEN-only setup can only prove
 * read reachability (see resolveXAccessToken's 'publish' vs 'read' distinction above), so it
 * is reported honestly as such rather than as a full OK.
 */
export async function testXConnection({store,env,fetcher=fetch},tenantId=null) {
 const oauth=await resolveXAccessToken({store,env,fetcher},'publish',tenantId);
 if(oauth) {
  const {response,data,networkError}=await requestJson(fetcher,`${API_BASE}/users/me`,{headers:{authorization:`Bearer ${oauth.token}`}});
  if(networkError)return {result:'NETWORK_ERROR',code:'NETWORK_OR_TIMEOUT'};
  if(!response.ok)return {result:classifyXError(response.status,data).code==='AUTH_FAILED'?'AUTH_FAILED':'NETWORK_ERROR',code:classifyXError(response.status,data).code};
  return {result:'OK',username:data.data?.username||null};
 }
 const readOnly=await resolveXAccessToken({store,env,fetcher},'read',tenantId);
 if(!readOnly)return {result:'NOT_CONFIGURED',code:'X_NOT_CONFIGURED'};
 const {response,data,networkError}=await requestJson(fetcher,`${API_BASE}/tweets/${WELL_KNOWN_PUBLIC_TWEET_ID}`,{headers:{authorization:`Bearer ${readOnly.token}`}});
 if(networkError)return {result:'NETWORK_ERROR',code:'NETWORK_OR_TIMEOUT'};
 if(!response.ok)return {result:classifyXError(response.status,data).code==='AUTH_FAILED'?'AUTH_FAILED':'NETWORK_ERROR',code:classifyXError(response.status,data).code};
 return {result:'CONFIGURED_READ_ONLY',code:'X_BEARER_READ_ONLY',note:'Bearer token verified for reads only — publishing needs the OAuth "Connect X" flow.'};
}
