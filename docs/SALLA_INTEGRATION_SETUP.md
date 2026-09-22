# Salla Integration Setup

Salla is the source of truth for products, prices, and stock — `get_product`,
`get_current_price`, `get_stock` (the Agent Runtime's tools, `src/runtime/tools.js`) and
`generationContext()` (content generation, `src/knowledge.js`) all read from the
Salla-synced `products` table, never from Brand Memory or an agent's own guess.

Two independent authentication methods exist. **OAuth takes priority whenever both are
configured** (`src/runtime/salla-oauth.js` `resolveSallaAccessToken`); nothing about the
existing static-token setup changes if you don't touch OAuth at all.

## Method 1 — Static access token (simplest, already existed)

1. In your Salla Partner Portal / store admin, generate a personal or store access token
   with product-read scope.
2. `.env`: `SALLA_ACCESS_TOKEN=...`
3. Owner → Integrations page → Salla card → "Sync from Salla" (or `POST /api/salla/sync`).

No expiry handling, no refresh — rotate it manually if Salla ever revokes it.

## Method 2 — OAuth app (auto-refreshing, multi-merchant capable)

### In the Salla Partner Portal

1. Create an app (or use an existing one). Note its **Client ID** and **Client Secret**.
2. Set the app's **Redirect URI** to exactly
   `https://<your-domain>/api/integrations/salla/oauth/callback` (must match byte-for-byte
   what you put in `SALLA_REDIRECT_URI` below).
3. Request scopes covering at least `products.read` (add `orders.read`/`customers.read` if
   you plan to use those later — see "Not yet built" below).
4. Under Webhooks, note the **Webhook Secret** for the delivery method you choose (Token or
   Signature — see step 3 in the webhook section below).

### In `.env`

```dotenv
SALLA_CLIENT_ID=...
SALLA_CLIENT_SECRET=...
SALLA_REDIRECT_URI=https://<your-domain>/api/integrations/salla/oauth/callback
INTEGRATION_ENCRYPTION_KEY=<32-byte key, hex or base64>
```

Generate the encryption key once with:
```
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```
This key encrypts stored OAuth tokens at rest (AES-256-GCM) — it never leaves your host
environment, is never in the database or the repo, and is never returned by any API
response (only connection *metadata* — expiry, scopes, who connected it — is exposed;
`GET /api/integrations/salla/oauth/status`).

### Connect

1. Owner logs in → `GET /api/integrations/salla/oauth/start` (a button on the
   Integrations page should link here) → redirects to Salla's consent screen.
2. Approve → Salla redirects back to your callback URL with `code`/`state`.
3. The callback exchanges the code for tokens, encrypts and stores them, and redirects to
   `/#integrations`. The connection is now `connected: true` with an `expiresAt`.
4. Tokens refresh automatically (5 minutes before expiry) on the next Salla API call. If a
   refresh fails (revoked refresh token), the integration falls back to
   `SALLA_ACCESS_TOKEN` if one is set, otherwise surfaces as needing reconnection.
5. `POST /api/integrations/salla/disconnect` (owner) to revoke locally at any time.

## Webhooks — `POST /api/webhooks/salla`

Authenticity comes entirely from a shared secret, never a session cookie:

```dotenv
SALLA_WEBHOOK_SECRET=<the secret from your Salla app's webhook settings>
SALLA_WEBHOOK_STRATEGY=token        # or 'signature' — see step 3
SALLA_WEBHOOK_SIGNATURE_HEADER=     # only used when STRATEGY=signature; defaults to x-salla-signature
```

1. In the Partner Portal, set the webhook URL to `https://<your-domain>/api/webhooks/salla`.
2. **Confirm which verification method your app is actually configured with** — Salla
   supports sending the secret verbatim ("Token", checked by default against the
   `Authorization` header here) or an HMAC-SHA256 signature of the raw body ("Signature").
   This codebase has no live webhook to verify the exact convention against, so the header
   name and strategy are configurable rather than hardcoded — check your Partner Portal
   app settings and adjust `SALLA_WEBHOOK_STRATEGY`/`SALLA_WEBHOOK_SIGNATURE_HEADER` if
   they don't match what Salla is actually sending.
3. Every delivery is deduped (`webhook_events` table, unique per event) — a redelivery
   returns `{replayed: true}` without reprocessing.
4. Recognized event names map to internal events (`src/runtime/salla-webhooks.js`
   `EVENT_MAP`): `product.updated`/`product.created` → `PRODUCT_UPDATED`,
   `product.available`/`product.quantity.low` → `PRODUCT_STOCK_UPDATED`,
   `order.created` → `ORDER_CREATED`, `order.status.updated` → `ORDER_UPDATED`,
   `order.completed` → `ORDER_COMPLETED`. **Verify these exact event name strings against
   your Partner Portal's webhook event picker** — they are documented as of this codebase's
   own best knowledge, not confirmed against a live Salla webhook delivery. An event not in
   this table is still stored (`GET /api/webhooks/salla/events`, owner only) but never
   invents an internal event for something unrecognized.

## Test the connection

`POST /api/integrations/anthropic/test` → for Salla: `POST /api/integrations/salla/test`
(owner only) — resolves whichever access method is active (OAuth or static) and makes one
light read call. Returns `NOT_CONFIGURED`, `OK`, `AUTH_FAILED`, `RATE_LIMITED`, or
`NETWORK_ERROR`.

## What is NOT built yet (next increment, deliberately not rushed this pass)

- **A live REST pull of Salla's order list.** No such call has ever been verified against a
  real delivery from this codebase (see the caveats above). The agent tool `salla_syncOrders`
  (`src/connectors/salla/adapter.js`, action `list_recent_orders`) deliberately does not guess
  at this endpoint — it reads the real, already-working webhook ledger below instead, so it
  only ever returns orders this store has already pushed a delivery for.
- **Order/customer sync into the CRM.** The webhook infrastructure real-time-emits
  `ORDER_CREATED`/`ORDER_UPDATED`/`ORDER_COMPLETED` with the raw Salla payload, and the
  event bus is ready for a handler — but no code yet turns an order into a CRM lead/customer
  record, matches it against an existing one, or runs the post-purchase follow-up flow
  (B10/B11/B21-25 in the integration spec). This needs careful matching-conflict rules
  (phone/email collision, no destructive auto-merge) that deserve their own focused pass
  rather than being bolted on quickly next to OAuth+webhooks.
- **A full product/order reconciliation job** (periodic drift-detection sync beyond
  webhooks) — not scheduled. The existing manual "Sync from Salla" button (now OAuth-aware)
  still fully replaces the catalog on demand.
- **Multi-tenant store identity** — one Salla connection per HyperCool instance, matching
  this app's existing single-tenant design everywhere else.
