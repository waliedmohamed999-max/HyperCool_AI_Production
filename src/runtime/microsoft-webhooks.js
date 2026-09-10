import {safeEqual} from './credentials.js';
import {fail} from '../auth.js';
import {installWebhookEvents,listWebhookEvents,storeWebhookEvent,markWebhookEventProcessed} from './webhook-events.js';

// Microsoft Graph change notifications — a different real mechanism from Meta's HMAC
// signature or Salla's token/signature choice: (1) subscription creation triggers an
// immediate validation POST with ?validationToken=... that must be echoed back as plain
// text within 10 seconds, and (2) every subsequent notification carries a `clientState`
// string per item (the secret WE chose when creating the subscription — see
// microsoft-graph.js createMailSubscription) instead of a body signature. Reuses the
// generic webhook_events ledger (source='microsoft365').
export {installWebhookEvents,listWebhookEvents};

export function handleValidationHandshake(url) {
 return url.searchParams.get('validationToken');
}
/**
 * Verifies clientState on every notification item and deduplicates by
 * (subscriptionId + resource id + changeType) — a notification only says "something
 * changed," never the content, so this returns the list of Graph message ids that still
 * need an actual GET to fetch (the caller does that via microsoft-graph.js getMessage).
 * An item whose clientState doesn't match is dropped and logged, never trusted.
 */
export function processMicrosoftNotifications(db,body,env) {
 const expected=env.MICROSOFT_WEBHOOK_SECRET;
 const results={toFetch:[],rejected:0,replayed:0};
 for(const item of body?.value||[]) {
  if(!expected||!safeEqual(item.clientState||'',expected)){results.rejected++;continue;}
  const externalId=`${item.subscriptionId}:${item.resourceData?.id}:${item.changeType}`;
  const {stored,id}=storeWebhookEvent(db,{source:'microsoft365',externalEventId:externalId,type:'mail.'+item.changeType,payload:item});
  if(!stored){results.replayed++;continue;}
  markWebhookEventProcessed(db,id,'PROCESSED');
  if(item.changeType==='created' && item.resourceData?.id)results.toFetch.push({messageId:item.resourceData.id,subscriptionId:item.subscriptionId});
 }
 return results;
}
export function requireWebhookSecretConfigured(env) {
 if(!env.MICROSOFT_WEBHOOK_SECRET)fail(401,'MICROSOFT_WEBHOOK_SECRET غير مُعد');
}
