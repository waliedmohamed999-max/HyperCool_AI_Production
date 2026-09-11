# Webhook Tenant Routing (Multi-Tenant Phase 3.5, Part B)

This document records how inbound webhooks (Salla, WhatsApp/Meta, Microsoft 365) now resolve
which tenant a delivery belongs to — and, just as importantly, what they never do.

## The rule (Part B1)

No route in this codebase ever reads a `tenant_id` claim from a webhook payload, a query
string, or a header as an identity source. There is no code path that would even look at
such a field if a malicious or misconfigured sender included one — proven directly in
`tests/webhook-tenant-routing.test.js`'s spoof test (a payload with a real, verified
`phone_number_id` belonging to Tenant A AND a top-level `tenant_id` claiming Tenant B routes
to Tenant A; the claim has zero effect).

Tenant identity always comes from a **provider-verified identifier**, resolved AFTER
signature/token verification, never before (`src/runtime/webhook-tenant-resolver.js`):

| Provider | Verified identity used | Matched against |
|---|---|---|
| WhatsApp (Meta) | `value.metadata.phone_number_id` (real Meta webhook field) | `integration_credentials.metadata.whatsapp.phoneNumberId`, populated at real OAuth-connect time (`meta-oauth.js`) |
| Microsoft 365 | `item.subscriptionId` (real Graph notification field) | `integration_credentials.metadata.mailSubscription.id`, populated at real `/api/integrations/microsoft/subscribe` time |
| Salla | `body.merchant` (real Salla webhook field) | `integration_credentials.external_account_id` for provider `salla` — see the Salla-specific note below |

## No new schema (Part B3/B4)

The mapping data above already existed in `integration_credentials` (tenant-scoped since
Phase 1) for WhatsApp and Microsoft — both were already being written into `metadata` at
real connect time by existing code, just never read back for routing. Building a separate
`integration_accounts` table would have duplicated that data and risked it drifting out of
sync, so this phase deliberately did not — matching the explicit instruction to build routing
foundation only, not a Connection UI, Credentials Vault, or Agent Tool Mapping.

## The Salla exception, and why it self-registers

Unlike WhatsApp/Microsoft, this codebase's Salla OAuth callback (`salla-oauth.js`) has never
populated `external_account_id` at connect time — its own long-standing comment says why:
there is no live Salla app in this environment to verify the exact "fetch the merchant id"
convention against, and guessing a field name risks silently breaking real webhooks later.

Leaving Salla webhooks permanently unresolved would have broken the one real tenant's
already-working Salla integration the moment fail-closed routing shipped. Instead,
`resolveTenantForSallaMerchant` self-registers the merchant id from the FIRST real webhook —
but only when it is unambiguous: exactly one Salla-connected tenant has no
`external_account_id` recorded yet. With one candidate, there is no guess (there is only one
tenant it could possibly belong to). The moment a SECOND such candidate exists, this
correctly refuses to register anything and falls through to `WEBHOOK_TENANT_UNRESOLVED`
instead — proven directly in `tests/webhook-tenant-routing.test.js`'s bootstrap-ambiguity
test (two Salla-connected tenants, neither registered yet → the delivery is unresolved and
neither row is mutated).

## Unknown identity: `WEBHOOK_TENANT_UNRESOLVED` (Part B6)

When a provider identity resolves to no tenant, the delivery is still recorded (never lose
real provider data) but as a diagnostic row: `webhook_events.tenant_id = NULL`,
`status = 'TENANT_UNRESOLVED'` — never a guessed tenant. `storeWebhookEvent`'s new
`unresolved: true` flag is the only place in the codebase allowed to store a NULL
`tenant_id` on a tenant-scoped write; every other caller either supplies a real `tenantId` or
accepts the fail-closed `resolveActiveTenantId` default. No business event (a CRM message, a
lead, an internal `CUSTOMER_MESSAGE_RECEIVED`/`ORDER_CREATED`/etc.) is ever created for an
unresolved delivery.

Honest gap: there is currently no admin UI or API route to list `TENANT_UNRESOLVED` events
(`listWebhookEvents` filters by a real `tenant_id`, which a NULL row never matches) — seeing
them today requires direct database access. Building that view was out of scope for this
pass (backend foundation only, no UI).

## Verification vs. routing are separate steps, always in that order (Part B13)

- Salla: `verifySallaWebhook` (token/HMAC) runs, then `body.merchant` is read.
- Meta: `verifyMetaSignature` (HMAC-SHA256) runs, then `value.metadata.phone_number_id` is read.
- Microsoft: `clientState` is checked per notification item FIRST; `resolveTenant(item.
  subscriptionId)` is only called for an item that already passed. Note that `clientState` is
  one shared secret (`MICROSOFT_WEBHOOK_SECRET`) across every tenant's subscription — it
  proves the notification really came from Graph, but cannot by itself say which tenant.
  That is exactly what the subscriptionId-based resolution step after it is for.

## Idempotency (Part B8)

Unchanged from before this phase: `(source, external_event_id)` stays the redelivery key —
`source` already separates providers, so no cross-provider or cross-tenant collision was ever
possible here. What changed is only WHAT gets stored alongside that key (`tenant_id`,
correctly resolved or NULL-with-diagnostic-status), never the key itself.

## Event propagation (Part C)

Every internal event a webhook emits (`CUSTOMER_MESSAGE_RECEIVED`, `CUSTOMER_OPTED_OUT`,
Salla's `ORDER_CREATED`/`PRODUCT_UPDATED`/etc.) now carries the real resolved `tenantId` in
its payload. `src/runtime/events.js`'s `emit()` stamps it onto the stored `agent_events` row,
and `src/runtime/orchestrator.js` (fixed in an earlier Phase 3 pass) reads it back and
threads it into the agent run it triggers — so a webhook-triggered agent run is attributed to
the webhook's real tenant end to end, proven in `tests/webhook-tenant-routing.test.js`'s
propagation test (Tenant A's WhatsApp message triggers exactly one `sales` agent run, visible
only in Tenant A's run list).

## What this does NOT cover

- Meta Page/Instagram webhooks: no route for these exists in this codebase today (only
  `/api/webhooks/meta/whatsapp`) — nothing to route.
- Multiple named connections per integration (two Salla stores, three Meta Pages for one
  tenant) — still one connection per provider per tenant, unchanged from Phase 1.
- A UI or API to inspect `TENANT_UNRESOLVED` diagnostic events (see above).
- Populating Salla's `external_account_id` at real connect time (would replace the
  self-registration bootstrap with a direct lookup) — blocked on having a live Salla app to
  verify the exact API call against, same as before this phase.

## Verification performed

`tests/webhook-tenant-routing.test.js` — 6 new real two-tenant HTTP tests: correct routing
for each of two tenants' own WhatsApp numbers, an unknown phone_number_id resolving to
nobody, the spoofed-tenant-claim test, the Salla ambiguous-bootstrap safety test, and the
webhook→event→agent-run propagation test. Every existing webhook test across
`meta-whatsapp.test.js`, `meta-whatsapp-api.test.js`, `microsoft-email.test.js`,
`microsoft-email-api.test.js`, `salla-integration.test.js`, `salla-integration-api.test.js`,
and `feature-flags.test.js` was updated to establish a real (mocked) provider connection
before sending a webhook that expects to be processed — exactly what a real deployment must
do now, and a stricter, more honest test than what existed before this phase (which could
process a webhook with no connection at all). Full suite: 297/297 green.
