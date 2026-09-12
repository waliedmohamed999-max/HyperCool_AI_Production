# Zid Connector (Phase 6E)

The first real, external, first-party connector built on top of the Universal Integration
Platform (Phase 6A-6D). Every fact below is drawn from Zid's own official developer
documentation — reviewed **2026-09-12** — never invented, never copied from a blog, tutorial,
or third-party integration writeup. Where the official docs were internally inconsistent or
silent, this connector deliberately does **less** rather than guess (see "What V1 does NOT
implement, and why" below).

## Official sources reviewed (2026-09-12)

- `https://docs.zid.sa/start-here` — Merchant API category index (Partner Dashboard, API
  category links).
- `https://docs.zid.sa/authorization` — OAuth2 flow, grant type, token headers, refresh.
- `https://docs.zid.sa/retrieve-a-list-of-products` — List Products endpoint + header table.
- `https://docs.zid.sa/list-of-orders` — List Orders endpoint, headers, response shape.
- `https://docs.zid.sa/list-of-customers` — List Customers endpoint, headers, response shape.
- `https://docs.zid.sa/get-manager-profile` — Manager/store identity profile endpoint.
- `https://docs.zid.sa/responses` — Standard error envelope, rate-limit (429) behavior.
- `https://docs.zid.sa/webhooks`, `https://docs.zid.sa/create-a-webhook`, and
  `https://help-partner.zid.sa/en/articles/8486213-what-webhook-events-does-zid-support` —
  webhook event catalog and registration endpoint.
- `https://share.apidog.com/apidoc/docs-site/613905/get-product-stock-by-id` — Product Stock
  endpoint (the header-scheme conflict this documents — see below).

## A. Base API URL

`https://api.zid.sa/v1` — confirmed on the Authorization overview page and consistent with
every endpoint path documented (e.g. `/v1/managers/store/orders`).

## B/C. Authentication method

**OAuth 2.0, Authorization Code grant** (confidential client — client_secret required
server-side). Authorize: `https://oauth.zid.sa/oauth/authorize`. Token: `https://oauth.zid.sa/
oauth/token`. Scopes are configured per registered app in the Partner Dashboard, not requested
as a fixed list by the connector itself ("select the needed scopes... via your application page
in the Partner Dashboard").

## D. Token lifecycle / E. Refresh

The token response carries `access_token`, `refresh_token`, and a numeric `expires_in` (seconds)
— this connector always computes `expiresAt` from that real, returned value, never a hardcoded
constant, even though Zid's own prose separately describes both the manager token and the
refresh token as lasting "1 year" in practice. Refresh is `grant_type=refresh_token` against the
same token endpoint, with `client_id`/`client_secret`/`redirect_uri`/`refresh_token`.

## F. Required headers

Every `/v1/managers/*` endpoint this connector calls (account profile, orders, customers)
documents the identical pair, confirmed independently on **four separate official pages**:

- `Authorization: Bearer {access_token}`
- `X-Manager-Token: {access_token}` (the SAME token value, under a second header name)

**A genuine documentation inconsistency worth recording**: the `/v1/products/` (List Products)
and `/v1/products/{id}/stocks/{id}/` (Product Stock) endpoint pages instead document
`Access-Token` and `Store-Id` headers, with a self-contradictory description ("Optional access
token... Required: Yes"). This does not match the `/v1/managers/*` pattern seen everywhere else
and could not be resolved through further public documentation research. **This is exactly why
V1 does not implement Products/Inventory read** (see below) — shipping a real integration
against an auth header contract this uncertain would be guessing through a security-sensitive
decision, which this phase's own ground rules explicitly forbid.

## G. API version

`v1` (the only version referenced anywhere in the path structure).

## H. Pagination

- Orders/Customers: `page` (page number) + `per_page` (records per page, "max 100 records" for
  orders). Customers additionally supports a cursor parameter `after` (documented as
  incompatible with `page`/`order_by`/`sort_by`) — not used by this V1 (page/per_page only, the
  simpler, universally-supported form).
- Products (not implemented — see above): `page`/`page_size`.

## I. Rate limits

Zid documents a 429 status ("You have sent too many requests in a given amount of time") with
no `X-RateLimit-*` headers or reset-time metadata. This connector maps 429 → `RATE_LIMITED` and
does **not** implement an aggressive automatic retry loop (Part 23 — "do not implement
aggressive retry"); a caller sees the real, honest rate-limited status and decides.

## J. Store/account identity

`GET /v1/managers/account/profile` ("Retrieve Manager's Profile") — a real, read-only, Manager-
role-only endpoint. Response includes `store.id` (integer), `store.title`, `store.uuid`. This
connector uses `store.id` as `externalAccountId` and `store.title` as the display name,
resolved automatically right after a successful OAuth token exchange (Part 21) and again on
every health check.

## K/N. Products / Inventory endpoints

**Documented but NOT implemented in V1** — see the header-scheme conflict under "F" above.
`docs.zid.sa/retrieve-a-list-of-products` (`GET /v1/products/`) and the stock endpoint
(`GET /v1/products/{product_id}/stocks/{stock_id}/`) exist and are real, but this connector does
not call them until that header contract is verified against a real, reachable Zid app (a live
sandbox test this environment cannot perform — see AN/AO).

## L. Orders endpoints — IMPLEMENTED

`GET /v1/managers/store/orders` — real, tested action `get_orders`. Response:
`{status, orders:[...], grand_total, total_order_count, total_order_count_per_status:{...}}`.

## M. Customers endpoints — IMPLEMENTED

`GET /v1/managers/store/customers` — real, tested action `get_customers`. Response:
`{status, customers:[...], grand_total, total_customers_count, active_customers_count,
inactive_customers_count, next_cursor}`.

## O. Webhooks

`docs.zid.sa/webhooks` documents real event names (`order.create`, `order.status.update`, plus
Product/Customer/Store/Abandoned-Cart categories) and a real creation endpoint
(`POST /v1/managers/webhooks`, fields `event`/`target_url`/`original_id`/optional `conditions`
and optional HTTP Basic `username`/`password` on the target URL itself).

## P. Webhook authentication

**No signing-secret or HMAC mechanism is documented anywhere in Zid's official webhook docs.**
The only authentication option Zid's own "Create a Webhook" endpoint documents is optional HTTP
Basic Auth credentials attached to the *receiving* URL — not a signature this platform could
verify against the payload. Per this phase's explicit rule ("If Zid provides no webhook
signature: report security limitation honestly. Do not invent HMAC"), **V1 ships no webhook
trigger at all** rather than inventing a verification scheme Zid never specified. `zidManifest`
declares `triggers: []` and `webhooks: null`; the existing generic webhook-URL route
(`GET /api/integrations/connections/:id/webhook`) correctly, honestly reports
`{status:'NOT_APPLICABLE', triggers:[]}` for every Zid connection (proven by a real test).

## Q/R/S/T. Event IDs, retry, error format, scopes — for context, not implemented this phase

Since no webhook is implemented, event-ID/idempotency/retry semantics were not exercised. The
REST error format (used for the two real read actions) is confirmed as
`{status, success:false, error:{code, message, fields}}` (`docs.zid.sa/responses`) and is
mapped to this platform's standard `CONNECTOR_ERROR_CODE` vocabulary without ever returning the
raw body (which could carry customer-identifying validation detail).

## Connection mode

**MULTI.** Each OAuth authorization produces a distinct, per-store access/refresh token pair
(the Manager Token is scoped to whichever store the merchant authorizes) — the identical
per-connection-credential model already proven safe for Salla's own MULTI-mode connections. A
tenant can connect more than one Zid store the same way they can connect more than one Salla
store.

## Capabilities

`commerce.orders.read`, `commerce.customers.read` — both already existed in the canonical
capability registry (added before this phase, for the accounting/commerce domain in general);
no new capability was invented (`zid.orders.read` never exists anywhere in this codebase).

## What V1 does NOT implement, and why

| Feature | Status | Why |
|---|---|---|
| Products read | Not implemented | Genuine, unresolved header-scheme conflict in Zid's own public docs (Access-Token/Store-Id vs Authorization/X-Manager-Token) |
| Inventory/stock read | Not implemented | Same conflict — the stock endpoint sits under the same `/v1/products/...` path family |
| Customers read | **Implemented** | Confirmed, consistent `/v1/managers/*` header contract |
| Webhooks (any event) | Not implemented | No signing-secret/HMAC mechanism documented anywhere officially |
| Write actions (create/update order, product, etc.) | Not implemented (explicitly out of V1 scope) | V1 is deliberately read-only for minimum production risk |
| PKCE | Not implemented | Not mentioned anywhere in official docs — never invented |

## Architecture — how Zid fits the existing platform with zero core changes

- **adapterType: `BUILT_IN`**, `is_system: true`, seeded idempotently in `src/integrations/
  definitions.js` alongside Salla/Anthropic/OpenAI/etc. — the exact same real-connector pattern,
  not a second definition model.
- **Manifest + adapter**: `src/connectors/zid/{manifest,adapter}.js`, registered in the static
  `src/connectors/registry.js` next to Salla — resolved by `resolveConnectorDynamic` exactly
  like every other `BUILT_IN` connector, with zero special-casing in the dynamic registry itself.
- **OAuth**: `src/runtime/zid-oauth.js` (authorize URL, token exchange, refresh) — a genuinely
  new, small, Zid-specific module, mirroring `salla-oauth.js`'s established shape so it slots
  into the SAME generic, existing multi-connection OAuth routes
  (`/api/integrations/oauth/:slug/start|callback`) via one new allowlist entry
  (`GENERIC_OAUTH_PROVIDERS` in `application.js`) — not a parallel OAuth system, and not a
  tenant-suppliable authorize/token URL (Part 3's "No Generic Unsafe OAuth").
- **Action execution**: reuses the exact same SSRF-hardened `safeFetch` (`core/ssrf.js`) the
  Generic REST Adapter uses — never a raw, unprotected `fetch`. The base URL is a fixed literal
  (`https://api.zid.sa/v1`), never tenant-editable.
- **Token refresh persistence**: `core/runtime.js`'s adapter call signature gained one additive
  parameter, `db` (alongside the pre-existing `manifest`), so an OAuth-backed adapter can persist
  a refreshed token pair back to the Vault itself. Every pre-6E adapter ignores the extra
  parameter exactly as they already ignore `manifest` — no adapter needed to change.
- **Generic tools**: `get_orders`/`get_customers` (`src/runtime/tools.js`) are capability-only
  (`integrationSlug: null`), the same pattern Phase 6D's `get_invoices` proved — auto-discovered
  for whichever connected commerce provider grants the matching capability, with **zero
  `if(connector==='zid')` branch** anywhere in the Agent Runtime, `tool-assignments.js`, or
  ConnectorRuntime's core dispatch (verified by a real source-grep test).

## AN/AO. Live vs. mock/contract verification — read this before trusting anything above in production

**No real Zid credentials exist in this development environment.** Every test in
`tests/zid-connector.test.js` (21 tests) is **MOCK/OFFICIAL-CONTRACT VERIFIED**: fixtures are
built field-for-field from the official documentation quoted above, and a mock transport
simulates `api.zid.sa`'s real, documented response shapes and error envelope. **Nothing in this
connector has been exercised against the real, live Zid API** — no real store was connected, no
real order or customer was ever fetched from a live Zid account.

Before any production pilot: connect one real Zid development/sandbox store (per Zid's own
partner-app testing process), and confirm — with real, non-mocked traffic — that:
1. The OAuth authorize/callback round trip actually completes against `oauth.zid.sa`.
2. The `Authorization`/`X-Manager-Token` header pair is genuinely sufficient for
   `/v1/managers/account/profile`, `/v1/managers/store/orders`, and `/v1/managers/store/
   customers` (this phase's confidence here is high — four independent doc pages agree — but
   "high confidence from documentation" is not the same claim as "verified against a live API").
3. Token refresh genuinely works after the real access token expires.

Only after that should the marketplace card graduate from "real code, contract-verified" to
"live-verified" in any user-facing sense.
