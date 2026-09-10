import {ConnectorError} from '../connectors.js';
import {resolveMicrosoftAccessToken} from './microsoft-oauth.js';

function graphBase(env){return env.MICROSOFT_GRAPH_BASE_URL||'https://graph.microsoft.com/v1.0';}
async function requestJson(fetcher,url,options={}) {
 let response;
 try {response=await fetcher(url,{...options,signal:AbortSignal.timeout(30000)});}
 catch {throw new ConnectorError('NETWORK_OR_TIMEOUT');}
 if(response.status===204)return {ok:true,status:204,data:null,headers:response.headers};
 let data=null;
 try {data=await response.json();} catch { /* some Graph responses (e.g. sendMail success) have no body */ }
 return {ok:response.ok,status:response.status,data,headers:response.headers};
}
// Real Graph error codes mapped to the fixed vocabulary the integration spec asks for —
// never a random retry, always a classified, actionable failure (same discipline as
// runtime/whatsapp.js's classifySendError).
function classifyError(status,data) {
 const code=data?.error?.code||'';
 if(status===401||code==='InvalidAuthenticationToken')return 'AUTH';
 if(status===429||code==='TooManyRequests')return 'RATE_LIMIT';
 if(status===403)return 'PERMISSION_ERROR';
 if(code==='ErrorInvalidRecipients'||code==='ErrorNonExistentMailbox')return 'INVALID_RECIPIENT';
 if(status>=500)return 'API_UNAVAILABLE';
 return 'OTHER';
}
export async function microsoftConfigured({store,env}) {
 return !!(await resolveMicrosoftAccessToken({store,env}));
}
async function authHeaders({store,env,fetcher}) {
 const resolved=await resolveMicrosoftAccessToken({store,env,fetcher});
 if(!resolved)return null;
 return {authorization:`Bearer ${resolved.token}`};
}
export async function testMicrosoftConnection({store,env,fetcher=fetch}) {
 const headers=await authHeaders({store,env,fetcher});
 if(!headers)return {result:'NOT_CONFIGURED',code:'MICROSOFT_NOT_CONFIGURED'};
 const {ok,status,data}=await requestJson(fetcher,`${graphBase(env)}/me?$select=displayName,mail,userPrincipalName`,{headers});
 if(!ok)return {result:classifyError(status,data)==='AUTH'?'AUTH_FAILED':'NETWORK_ERROR',code:data?.error?.code||'MICROSOFT_TEST_FAILED'};
 return {result:'OK',email:data.mail||data.userPrincipalName,displayName:data.displayName};
}
/**
 * Real sendMail via Graph. `retryAfterFromHeaders` surfaces Graph's own Retry-After (429)
 * so a caller can back off correctly instead of guessing a delay (spec Part BF).
 */
export async function sendMail({store,env,fetcher=fetch},{to,cc,bcc,subject,bodyHtml,attachments=[]}) {
 const headers=await authHeaders({store,env,fetcher});
 if(!headers)return {status:'INTEGRATION_REQUIRED',integration:'microsoft365'};
 const recipient=addr=>({emailAddress:{address:addr}});
 const message={
  subject,body:{contentType:'HTML',content:bodyHtml},
  toRecipients:(Array.isArray(to)?to:[to]).map(recipient),
  ...(cc?.length?{ccRecipients:cc.map(recipient)}:{}),
  ...(bcc?.length?{bccRecipients:bcc.map(recipient)}:{}),
  ...(attachments.length?{attachments:attachments.map(a=>({'@odata.type':'#microsoft.graph.fileAttachment',name:a.name,contentType:a.mimeType,contentBytes:a.contentBase64}))}:{})
 };
 const {ok,status,data,headers:respHeaders}=await requestJson(fetcher,`${graphBase(env)}/me/sendMail`,{
  method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({message,saveToSentItems:true})
 });
 if(!ok) {
  const errorClass=classifyError(status,data);
  return {status:'FAILED',errorClass,errorDetail:data?.error?.message||null,retryAfter:errorClass==='RATE_LIMIT'?respHeaders?.get?.('retry-after')||null:null};
 }
 // Graph's sendMail returns 202 Accepted with NO message id in the body — the only way to
 // learn the real internetMessageId/id is to look the sent message up afterward (Sent
 // Items, most recent, matching subject+recipient) — done by the caller if it needs it,
 // never fabricated here.
 return {status:'SENT'};
}
/** Finds the just-sent message in Sent Items to recover its real Graph id/internetMessageId
 * for threading — best-effort; a caller that doesn't get a match still has a SENT message
 * recorded, just without a provider id to correlate future replies against. */
export async function findRecentSentMessage({store,env,fetcher=fetch},{subject,to}) {
 const headers=await authHeaders({store,env,fetcher});
 if(!headers)return null;
 const filter=encodeURIComponent(`subject eq '${subject.replace(/'/g,"''")}'`);
 const {ok,data}=await requestJson(fetcher,`${graphBase(env)}/me/mailFolders/sentitems/messages?$filter=${filter}&$top=5&$orderby=sentDateTime desc`,{headers});
 if(!ok||!data?.value?.length)return null;
 const match=data.value.find(m=>m.toRecipients?.some(r=>r.emailAddress?.address?.toLowerCase()===String(to).toLowerCase()))||data.value[0];
 return match?{externalMessageId:match.id,internetMessageId:match.internetMessageId,externalThreadId:match.conversationId}:null;
}
export async function getMessage({store,env,fetcher=fetch},messageId) {
 const headers=await authHeaders({store,env,fetcher});
 if(!headers)return null;
 const {ok,data}=await requestJson(fetcher,`${graphBase(env)}/me/messages/${messageId}?$select=id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,bodyPreview,body,receivedDateTime,hasAttachments,isDraft`,{headers});
 return ok?data:null;
}
// --- Webhook subscriptions (Graph change notifications) ---------------------------------
export async function createMailSubscription({store,env,fetcher=fetch},{notificationUrl,clientState}) {
 const headers=await authHeaders({store,env,fetcher});
 if(!headers)throw new ConnectorError('MICROSOFT_NOT_CONFIGURED');
 // 4230 minutes (~70.5 hours) is Graph's real maximum for a mail resource subscription —
 // this is why renewal (runtime/scheduler.js) exists, not an oversight.
 const expirationDateTime=new Date(Date.now()+4230*60000).toISOString();
 const {ok,status,data}=await requestJson(fetcher,`${graphBase(env)}/subscriptions`,{
  method:'POST',headers:{...headers,'content-type':'application/json'},
  body:JSON.stringify({changeType:'created',notificationUrl,resource:'me/mailFolders(\'inbox\')/messages',expirationDateTime,clientState})
 });
 if(!ok)throw new ConnectorError(classifyError(status,data)==='AUTH'?'CREDENTIALS_REJECTED':'PROVIDER_ERROR');
 return {subscriptionId:data.id,expiresAt:data.expirationDateTime,resource:data.resource};
}
export async function renewMailSubscription({store,env,fetcher=fetch},subscriptionId) {
 const headers=await authHeaders({store,env,fetcher});
 if(!headers)throw new ConnectorError('MICROSOFT_NOT_CONFIGURED');
 const expirationDateTime=new Date(Date.now()+4230*60000).toISOString();
 const {ok,status,data}=await requestJson(fetcher,`${graphBase(env)}/subscriptions/${subscriptionId}`,{
  method:'PATCH',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({expirationDateTime})
 });
 if(!ok)throw new ConnectorError(classifyError(status,data)==='AUTH'?'CREDENTIALS_REJECTED':'PROVIDER_ERROR');
 return {subscriptionId:data.id,expiresAt:data.expirationDateTime};
}
export async function deleteMailSubscription({store,env,fetcher=fetch},subscriptionId) {
 const headers=await authHeaders({store,env,fetcher});
 if(!headers)return;
 await requestJson(fetcher,`${graphBase(env)}/subscriptions/${subscriptionId}`,{method:'DELETE',headers}).catch(()=>{});
}
// --- Calendar -----------------------------------------------------------------------------
export async function createCalendarEvent({store,env,fetcher=fetch},{title,start,end,timezone='Asia/Riyadh',participants=[],location,notes}) {
 const headers=await authHeaders({store,env,fetcher});
 if(!headers)return {status:'INTEGRATION_REQUIRED',integration:'microsoft365'};
 const event={
  subject:title,start:{dateTime:start,timeZone:timezone},end:{dateTime:end,timeZone:timezone},
  ...(location?{location:{displayName:location}}:{}),
  ...(notes?{body:{contentType:'Text',content:notes}}:{}),
  attendees:participants.map(addr=>({emailAddress:{address:addr},type:'required'}))
 };
 const {ok,status,data}=await requestJson(fetcher,`${graphBase(env)}/me/events`,{
  method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(event)
 });
 if(!ok)return {status:'FAILED',errorClass:classifyError(status,data),errorDetail:data?.error?.message||null};
 return {status:'CREATED',externalEventId:data.id,webLink:data.webLink};
}
export async function getCalendarAvailability({store,env,fetcher=fetch},{emails,start,end,timezone='Asia/Riyadh'}) {
 const headers=await authHeaders({store,env,fetcher});
 if(!headers)return {status:'INTEGRATION_REQUIRED',integration:'microsoft365'};
 const {ok,status,data}=await requestJson(fetcher,`${graphBase(env)}/me/calendar/getSchedule`,{
  method:'POST',headers:{...headers,'content-type':'application/json'},
  body:JSON.stringify({schedules:emails,startTime:{dateTime:start,timeZone:timezone},endTime:{dateTime:end,timeZone:timezone},availabilityViewInterval:30})
 });
 if(!ok)return {status:'FAILED',errorClass:classifyError(status,data)};
 return {status:'OK',schedules:(data.value||[]).map(s=>({email:s.scheduleId,availabilityView:s.availabilityView,busy:(s.scheduleItems||[]).map(i=>({start:i.start?.dateTime,end:i.end?.dateTime,status:i.status}))}))};
}
