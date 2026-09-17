import {randomBytes} from 'node:crypto';
import {ConnectorError} from '../connectors.js';
import {getCredentials,saveCredentials,clearCredentials,getCredentialsMeta,isExpiringSoon,credentialsConfigured} from './credentials.js';

// Meta's real OAuth 2.0 (Facebook Login for Business) endpoints and Graph API base, per
// Meta for Developers documentation. Confirm against your own app's dashboard before
// relying on them in production — Graph API versions change.
const GRAPH_VERSION='v21.0';
const AUTHORIZE_URL='https://www.facebook.com/'+GRAPH_VERSION+'/dialog/oauth';
const TOKEN_URL='https://graph.facebook.com/'+GRAPH_VERSION+'/oauth/access_token';
const GRAPH_BASE='https://graph.facebook.com/'+GRAPH_VERSION;
// Minimum scopes to receive/send WhatsApp messages, read a connected Page's Instagram
// account, and publish to both. Trim in your own app review submission if you don't need
// every capability — Meta app review only grants what you actually request and justify.
const DEFAULT_SCOPES=['business_management','pages_show_list','pages_read_engagement','pages_manage_metadata','pages_messaging','instagram_basic','instagram_manage_messages','instagram_content_publish','whatsapp_business_management','whatsapp_business_messaging'];

export function metaOAuthConfigured(env) {
 return !!(env.META_APP_ID && env.META_APP_SECRET && env.META_REDIRECT_URI);
}
const pendingStates=new Map();
export function createMetaAuthorizeUrl(env,userId) {
 if(!metaOAuthConfigured(env))throw new ConnectorError('META_OAUTH_NOT_CONFIGURED');
 const state=randomBytes(24).toString('base64url');
 pendingStates.set(state,{userId,at:Date.now()});
 const url=new URL(AUTHORIZE_URL);
 url.searchParams.set('client_id',env.META_APP_ID);
 url.searchParams.set('redirect_uri',env.META_REDIRECT_URI);
 url.searchParams.set('response_type','code');
 url.searchParams.set('scope',DEFAULT_SCOPES.join(','));
 url.searchParams.set('state',state);
 return url.href;
}
export function consumeMetaState(state,userId) {
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
/**
 * Meta's real asset-resolution chain: short-lived user token → long-lived user token (~60
 * days) → the Pages the user manages (each with its own never-expiring Page access token as
 * long as the long-lived user token stays valid) → that Page's connected Instagram Business
 * Account and WhatsApp Business Account/phone number. This is what "select/resolve business
 * assets" (spec Part D) means concretely — Meta has no single "pick an asset" API call.
 * Picks the FIRST page returned; a business with multiple Pages needs a real picker UI,
 * which is out of scope for this pass (see the setup doc's "not yet built" section).
 */
export async function exchangeCodeAndResolveAssets({env,fetcher=fetch,code}) {
 if(!metaOAuthConfigured(env))throw new ConnectorError('META_OAUTH_NOT_CONFIGURED');
 const shortLived=await requestJson(fetcher,`${TOKEN_URL}?client_id=${env.META_APP_ID}&redirect_uri=${encodeURIComponent(env.META_REDIRECT_URI)}&client_secret=${env.META_APP_SECRET}&code=${code}`);
 if(!shortLived.access_token)throw new ConnectorError('INVALID_PROVIDER_RESPONSE');
 const longLived=await requestJson(fetcher,`${TOKEN_URL}?grant_type=fb_exchange_token&client_id=${env.META_APP_ID}&client_secret=${env.META_APP_SECRET}&fb_exchange_token=${shortLived.access_token}`);
 const userToken=longLived.access_token||shortLived.access_token;
 const expiresIn=longLived.expires_in||shortLived.expires_in;
 const pages=await requestJson(fetcher,`${GRAPH_BASE}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${userToken}`);
 const page=pages.data?.[0]||null;
 let whatsapp=null;
 if(page) {
  try {
   const wabas=await requestJson(fetcher,`${GRAPH_BASE}/me/businesses?fields=owned_whatsapp_business_accounts{id,phone_numbers{id,display_phone_number}}&access_token=${userToken}`);
   const waba=wabas.data?.[0]?.owned_whatsapp_business_accounts?.data?.[0];
   const phone=waba?.phone_numbers?.data?.[0];
   if(waba&&phone)whatsapp={businessAccountId:waba.id,phoneNumberId:phone.id,displayPhoneNumber:phone.display_phone_number};
  } catch { /* WhatsApp is optional — a Meta connection without a WABA is still a valid Instagram/Facebook-only connection. */ }
 }
 return {
  userAccessToken:userToken,
  expiresAt:Number.isFinite(expiresIn)?new Date(Date.now()+expiresIn*1000).toISOString():null,
  scopes:DEFAULT_SCOPES,
  page:page?{id:page.id,name:page.name,accessToken:page.access_token}:null,
  instagram:page?.instagram_business_account?{id:page.instagram_business_account.id,username:page.instagram_business_account.username}:null,
  whatsapp
 };
}
/** Persists the resolved assets: the user token is the "access token" (used to refresh
 * page tokens later if ever needed); the Page access token and full asset shape go in the
 * encrypted `extra` blob (the Page token IS a bearer secret, unlike the ids around it);
 * the ids/names/usernames meant for display go in the plain `metadata`. */
// Phase MKT-2, Part F/O — tenantId now threads through every real call site instead of
// silently falling back to the single-tenant default (see x-oauth.js's matching comment).
export function saveMetaConnection(db,env,{userAccessToken,expiresAt,scopes,page,instagram,whatsapp},user,tenantId=null) {
 return saveCredentials(db,env,'meta',{
  accessToken:userAccessToken,expiresAt,scopes,externalAccountId:page?.id||null,
  extra:{pageAccessToken:page?.accessToken||null},
  metadata:{page:page?{id:page.id,name:page.name}:null,instagram:instagram||null,whatsapp:whatsapp||null}
 },user,tenantId);
}
export function metaOAuthStatus(db,tenantId=null) {
 const meta=getCredentialsMeta(db,'meta',tenantId);
 if(!meta)return {connected:false};
 return {connected:true,expiresAt:meta.expiresAt,scopes:meta.scopes,page:meta.metadata?.page||null,instagram:meta.metadata?.instagram||null,whatsapp:meta.metadata?.whatsapp||null,connectedByName:meta.connectedByName,connectedAt:meta.connectedAt,tokenExpired:isExpiringSoon(meta.expiresAt,0)};
}
export function disconnectMeta(db,tenantId=null) {
 clearCredentials(db,'meta',tenantId);
}
/**
 * Every Meta/WhatsApp API call goes through here for its bearer token. `kind` picks which
 * secret to use: 'page' for Page/Instagram-publishing calls (the Page access token, which
 * does not expire on its own), 'user' for calls that specifically need the user token, or
 * 'whatsapp' for the WhatsApp Cloud API (Meta's WhatsApp product uses the SAME Page-linked
 * system user token in this app's connection model — see whatsapp.js). Falls back to the
 * legacy static WHATSAPP_ACCESS_TOKEN/META_ACCESS_TOKEN env vars so nothing that already
 * worked breaks. Returns null (never throws) when nothing is usable.
 */
export function resolveMetaAccessToken({store,env},kind='page',tenantId=null) {
 if(credentialsConfigured(env)) {
  let creds;
  try {creds=getCredentials(store.db,env,'meta',tenantId);} catch {creds=null;}
  if(creds && !isExpiringSoon(creds.expiresAt)) {
   if(kind==='page'||kind==='whatsapp') {
    const pageToken=creds.extra?.pageAccessToken;
    if(pageToken)return {token:pageToken,source:'oauth',metadata:creds.metadata};
   }
   return {token:creds.accessToken,source:'oauth',metadata:creds.metadata};
  }
 }
 const staticToken=kind==='whatsapp'?(env.WHATSAPP_ACCESS_TOKEN||env.META_ACCESS_TOKEN):env.META_ACCESS_TOKEN;
 return staticToken?{token:staticToken,source:'static',metadata:null}:null;
}
export function connectedWhatsAppPhoneNumberId(db,env,tenantId=null) {
 if(env.WHATSAPP_PHONE_NUMBER_ID)return env.WHATSAPP_PHONE_NUMBER_ID;
 const meta=getCredentialsMeta(db,'meta',tenantId);
 return meta?.metadata?.whatsapp?.phoneNumberId||null;
}
