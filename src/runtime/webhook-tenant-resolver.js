// Multi-Tenant Phase 3.5 (Part B), cut over to `integration_connections` in Phase 4A
// (Part 19) — resolves which tenant a webhook delivery actually belongs to, from the
// provider's OWN verified identity (a WhatsApp phone_number_id, a Microsoft Graph
// subscriptionId, a Salla merchant id) — NEVER from anything the payload itself claims to
// be. No route in this codebase ever reads payload.tenant_id, a query string tenant id, or a
// tenant header as an identity source; a spoofed claim of that shape has no code path that
// would even look at it.
//
// `integration_connections` (not the legacy `integration_credentials` table) is now the
// source of truth here: the compatibility bridge in credentials.js keeps every legacy write
// mirrored into it in real time (see src/integrations/legacy-sync.js), and the new generic
// multi-connection OAuth routes (application.js) write to it directly — so this is the one
// place both paths' connections are visible together.
//
// There is no separate 'whatsapp' connection row (see legacy-sync.js's own note): a WhatsApp
// number is resolved from the mirrored 'meta' connection's metadata, exactly as
// runtime/whatsapp.js already reads WhatsApp capability from getCredentialsMeta(db,'meta').
export function resolveTenantForWhatsAppPhoneNumberId(db,phoneNumberId) {
 if(!phoneNumberId)return null;
 for(const row of db.prepare("SELECT tenant_id AS tenantId, external_account_metadata AS metadata FROM integration_connections WHERE integration_definition_id='meta'").all()) {
  const metadata=row.metadata?JSON.parse(row.metadata):null;
  if(metadata?.whatsapp?.phoneNumberId===phoneNumberId)return row.tenantId;
 }
 return null;
}
/**
 * Phase MKT-2, Part I — resolves a Facebook Messenger or Instagram DM/comment webhook to the
 * tenant that actually connected that Page/Instagram Business Account. Meta's real messaging
 * webhook shape puts the id the message was sent TO as `entry[].id` — a Page id for the
 * 'page' object (Messenger), or the Instagram Business Account id for the 'instagram' object.
 * This checks both: `external_account_id` is the connected Page (matches saveMetaConnection's
 * `externalAccountId:page.id`), and the mirrored `metadata.instagram.id` is the linked IG
 * account — exactly the same two ids `meta-publishing.js`'s `pageId`/`instagramAccountId`
 * helpers already read for outbound publishing.
 */
export function resolveTenantForMetaPageId(db,pageOrInstagramId) {
 if(!pageOrInstagramId)return null;
 for(const row of db.prepare("SELECT tenant_id AS tenantId, external_account_id AS externalAccountId, external_account_metadata AS metadata FROM integration_connections WHERE integration_definition_id='meta'").all()) {
  if(row.externalAccountId===pageOrInstagramId)return row.tenantId;
  const metadata=row.metadata?JSON.parse(row.metadata):null;
  if(metadata?.instagram?.id===pageOrInstagramId)return row.tenantId;
 }
 return null;
}
export function resolveTenantForMicrosoftSubscription(db,subscriptionId) {
 if(!subscriptionId)return null;
 for(const row of db.prepare("SELECT tenant_id AS tenantId, external_account_metadata AS metadata FROM integration_connections WHERE integration_definition_id='microsoft365'").all()) {
  const metadata=row.metadata?JSON.parse(row.metadata):null;
  if(metadata?.mailSubscription?.id===subscriptionId)return row.tenantId;
 }
 return null;
}
/**
 * Salla webhook payloads carry a top-level `merchant` (store) id — matched against
 * `integration_connections.external_account_id` for provider='salla'. This codebase's Salla
 * OAuth callbacks (both the legacy single-connection route and the new generic multi-store
 * one — salla-oauth.js / application.js) have never resolved a real merchant id at connect
 * time — there is no live Salla app in this environment to verify the exact "fetch the
 * merchant profile" endpoint against, and inventing one would risk a wrong field name
 * silently breaking real webhooks.
 *
 * Rather than leave every Salla webhook permanently unresolved, this self-registers the
 * merchant id from the FIRST real webhook received for it — but ONLY when doing so is
 * unambiguous: exactly one Salla connection ANYWHERE (across every tenant — matching the
 * real-world constraint that a given merchant id can only ever belong to one store, enforced
 * by this table's own partial unique index on (integration_definition_id,
 * external_account_id)) has no `external_account_id` recorded yet. With one candidate there
 * is no guess involved; the moment a second such candidate exists (a second tenant, or a
 * second store for the same tenant, both still unresolved), this stops self-registering and
 * correctly falls through to WEBHOOK_TENANT_UNRESOLVED instead of picking one arbitrarily.
 * Once populated (by this bootstrap, or by a future real connect-time fetch once a live
 * Salla app can be verified), resolution is a plain lookup.
 */
export function resolveTenantForSallaMerchant(db,merchantId) {
 if(merchantId===null||merchantId===undefined)return null;
 const merchantKey=String(merchantId);
 const direct=db.prepare("SELECT tenant_id AS tenantId FROM integration_connections WHERE integration_definition_id='salla' AND external_account_id=?").get(merchantKey);
 if(direct)return direct.tenantId;
 const candidates=db.prepare("SELECT id,tenant_id AS tenantId FROM integration_connections WHERE integration_definition_id='salla' AND external_account_id IS NULL AND status!='DISCONNECTED'").all();
 if(candidates.length===1) {
  db.prepare("UPDATE integration_connections SET external_account_id=?,updated_at=? WHERE id=?").run(merchantKey,new Date().toISOString(),candidates[0].id);
  return candidates[0].tenantId;
 }
 return null;
}
