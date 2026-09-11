// Multi-Tenant Phase 3.5 (Part B) — resolves which tenant a webhook delivery actually
// belongs to, from the provider's OWN verified identity (a WhatsApp phone_number_id, a
// Microsoft Graph subscriptionId, a Salla merchant id) — NEVER from anything the payload
// itself claims to be. No route in this codebase ever reads payload.tenant_id, a query
// string tenant id, or a tenant header as an identity source; a spoofed claim of that shape
// has no code path that would even look at it.
//
// No new schema: the mapping data this needs already exists in `integration_credentials`
// (tenant-scoped since Phase 1) — WhatsApp's phone_number_id and Microsoft's subscription id
// are both written into `metadata` at real OAuth-connect/subscribe time (meta-oauth.js,
// the /api/integrations/microsoft/subscribe route). Building a second, separate mapping
// table would only duplicate that data and risk it drifting out of sync — exactly the
// "don't overbuild" instruction this phase was scoped against.
export function resolveTenantForWhatsAppPhoneNumberId(db,phoneNumberId) {
 if(!phoneNumberId)return null;
 for(const row of db.prepare("SELECT tenant_id AS tenantId, metadata FROM integration_credentials WHERE provider='meta'").all()) {
  const metadata=row.metadata?JSON.parse(row.metadata):null;
  if(metadata?.whatsapp?.phoneNumberId===phoneNumberId)return row.tenantId;
 }
 return null;
}
export function resolveTenantForMicrosoftSubscription(db,subscriptionId) {
 if(!subscriptionId)return null;
 for(const row of db.prepare("SELECT tenant_id AS tenantId, metadata FROM integration_credentials WHERE provider='microsoft365'").all()) {
  const metadata=row.metadata?JSON.parse(row.metadata):null;
  if(metadata?.mailSubscription?.id===subscriptionId)return row.tenantId;
 }
 return null;
}
/**
 * Salla webhook payloads carry a top-level `merchant` (store) id — matched against
 * `integration_credentials.external_account_id` for provider='salla'. Unlike WhatsApp/
 * Microsoft above, this codebase's Salla OAuth callback (salla-oauth.js) has never populated
 * `external_account_id` at connect time — its own comments already say why: there is no live
 * Salla app in this environment to verify the exact "fetch the merchant id" convention
 * against, and inventing one would risk a wrong field name silently breaking real webhooks.
 *
 * Rather than leave every Salla webhook permanently unresolved (which would break the one
 * real tenant's already-working Salla integration the moment fail-closed routing lands),
 * this self-registers the merchant id from the FIRST real webhook received — but ONLY when
 * doing so is unambiguous: exactly one Salla-connected tenant has no `external_account_id`
 * recorded yet. With one candidate there is no guess involved (there is only one tenant this
 * merchant id could possibly belong to); the moment a second such candidate exists, this
 * stops self-registering and correctly falls through to WEBHOOK_TENANT_UNRESOLVED instead of
 * picking one arbitrarily. Once populated (by this bootstrap, or by a future real connect-
 * time fetch once a live Salla app can be verified), resolution is a plain lookup.
 */
export function resolveTenantForSallaMerchant(db,merchantId) {
 if(merchantId===null||merchantId===undefined)return null;
 const merchantKey=String(merchantId);
 const direct=db.prepare("SELECT tenant_id AS tenantId FROM integration_credentials WHERE provider='salla' AND external_account_id=?").get(merchantKey);
 if(direct)return direct.tenantId;
 const candidates=db.prepare("SELECT tenant_id AS tenantId FROM integration_credentials WHERE provider='salla' AND external_account_id IS NULL").all();
 if(candidates.length===1) {
  db.prepare("UPDATE integration_credentials SET external_account_id=? WHERE provider='salla' AND tenant_id=?").run(merchantKey,candidates[0].tenantId);
  return candidates[0].tenantId;
 }
 return null;
}
