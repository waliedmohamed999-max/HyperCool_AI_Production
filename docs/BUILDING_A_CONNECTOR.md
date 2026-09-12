# Building a New Connector (Phase 6A baseline; Phase 6D added a no-code Builder UI on top)

> **Phase 6E update**: Zid (`docs/ZID_CONNECTOR.md`) is a real, worked example of this doc's
> ORIGINAL file-based pattern (below) used for exactly the reason it exists: a provider needing
> real OAuth2 token exchange/refresh that the Builder's GENERIC_REST-only auth types (NONE/
> API_KEY/BEARER_TOKEN/BASIC) cannot express. Its action execution still reuses the SSRF-hardened
> transport, never a bespoke HTTP client — see `src/connectors/zid/adapter.js`.

> **Phase 6D update**: for a plain REST/HTTP API with NONE/API_KEY/BEARER_TOKEN/BASIC auth, you
> no longer need to write ANY file at all — a Platform Admin can create, configure, test, and
> publish the connector entirely through the Integration Builder UI (`#platform`,
> `docs/INTEGRATION_BUILDER.md`). This doc's file-based pattern (below, and the 6B "write a
> manifest, reuse `genericRestAdapter`" shortcut) remains the right choice for: a provider needing
> a real custom adapter (OAuth2, token refresh, non-REST behavior), a `BUILT_IN`/`AI_PROVIDER`
> connector (reserved for real, code-reviewed implementations — the Builder can only create
> `GENERIC_REST` ones), or simply a connector a developer wants under source control /
> code review before it ever reaches a Platform Admin's hands. Both paths converge on the exact
> same validator (`validateManifest`/`validateRestManifest`/`validateWebhookManifest`) and the
> exact same `ConnectorRuntime.execute()` pipeline — neither is a "lesser" connector. See
> `docs/DYNAMIC_CONNECTOR_DEFINITIONS.md`.

> **Phase 6B update**: for a plain REST/HTTP API (no special OAuth needs), you no longer need to
> write a custom adapter at all — write a manifest using `validateRestManifest()`
> (`src/connectors/generic-rest/manifest.js`) and reuse the shared `genericRestAdapter`
> (`src/connectors/generic-rest/adapter.js`) directly, exactly like
> `src/connectors/acme/manifest.js` does. See `docs/GENERIC_REST_CONNECTOR.md`. A custom
> adapter (this doc's original pattern below) is still the right choice for a provider with a
> real OAuth2 flow, token refresh, or any behavior the generic engine doesn't cover.

Today (Phase 6A), adding a connector for an existing, already-implemented provider means:

1. **Define the manifest** (`src/connectors/<slug>/manifest.js`) — category, availability
   (honest — `DEFINITION_ONLY`/`NOT_IMPLEMENTED` if there's no real API access yet, see the hard
   rule at the bottom of this doc: never invent an endpoint), connectionMode, auth, the
   capabilities it really has code for, and its actions (each with a `requiredCapability`
   already present in the manifest's own `capabilities` list).
2. **Define the adapter** (`src/connectors/<slug>/adapter.js`) — wrap the EXISTING
   implementation (see `docs/CONNECTOR_SDK.md`'s pattern). Never reimplement a provider's real
   network calls inside the adapter; the adapter translates, it doesn't duplicate. Never invent
   an endpoint/OAuth URL/scope without a real, referenced API contract — see the hard rule below.
3. **Validate**: `validateAdapter(adapter, manifest)` — call it once at module load (see
   `src/connectors/registry.js`) so a mismatch fails at boot, never at first real request.
4. **Register**: add the `{manifest, adapter}` pair to `src/connectors/registry.js`'s `ENTRIES`.
5. **Test**: at minimum, a real `healthCheck`/`executeAction` test against a mocked `fetcher`
   proving the adapter's translation is correct (see `tests/connector-sdk.test.js`'s Salla/
   Anthropic tests) — never a live external call in a test.

**No change to `src/runtime/runtime.js` (Agent Runtime), `src/integrations/vault.js`
(Credentials Vault), `src/runtime/agent-readiness.js` (Readiness), or `src/application.js`'s
existing routes is required for this** — that is the architectural proof Phase 6A set out to
deliver (Part 86: "No special modifications to Agent Runtime / Control Center core / Vault /
Readiness / Tool Mapping except generic framework hooks").

## What's still missing for a brand-new (not-yet-implemented) real provider

Wiring a NEW connector's manifest+adapter into the live app so a tenant can actually create a
connection, complete an OAuth flow, and have an agent tool resolve to it — that requires:
Phase 6B's Generic REST Connector (for a simple API-key/bearer provider with no special OAuth
needs) or a dedicated adapter using that provider's real, documented OAuth flow; Phase 6C's
Webhook Framework (if the provider sends events); and Phase 6D's Integration Builder UI +
Marketplace (so the connection appears in Control Center without hand-written frontend code).
None of these exist yet — Phase 6A only proves the SDK layer itself is sound.

## The one hard rule that never changes

**Never invent an endpoint, OAuth URL, or scope for a provider without a real, referenced API
contract.** A connector with no verified documentation is built as `DEFINITION_ONLY` or
`NOT_IMPLEMENTED` (Part 5's honest availability states) — never a fake `AVAILABLE`/`CONNECTED`.

## Phase 6C update: adding a webhook trigger to a connector

For a connector that also receives inbound events, build the manifest with
`validateWebhookManifest()` (`src/connectors/generic-webhook/manifest.js`) instead of
`validateManifest`/`validateRestManifest` directly (it calls through to whichever applies) and
add a `triggers` array — see `src/connectors/acme/manifest.js`'s real `order_created` trigger and
`docs/GENERIC_WEBHOOK_FRAMEWORK.md`. No new webhook route is needed: the generic
`POST /api/webhooks/connectors/:publicId` route already dispatches to any registered connector's
declared triggers.

## Conceptual future example: Zid (Phase 6, Part 105) — illustration only, not implemented

*Illustration only — no Zid endpoint, scope, URL, webhook header, or payload field below has
been verified against Zid's own documentation, and none is implemented anywhere in this
codebase.* If Zid's real, documented REST API is confirmed at implementation time, a real Zid
connector would likely look like a Generic REST manifest (`docs/GENERIC_REST_CONNECTOR.md`)
declaring the same canonical capabilities Salla already proves out — `commerce.products.read`,
`commerce.orders.read`, `commerce.inventory.read` — so that an existing generic commerce Tool
could resolve to either Salla or Zid per tenant, with no Agent Runtime change. If Zid also sends
real webhooks, its trigger(s) would map to the same real `ORDER_CREATED` Event Bus type Acme's
own test trigger already proves reaches (`docs/EVENT_NORMALIZATION.md`) — never a fabricated
HMAC header name or payload shape. **Actual endpoints, auth flow, scopes, and webhook contract
must come from Zid's official documentation** at that time, never guessed from this example.

## Conceptual future example: accounting providers (Part 106) — illustration only

Odoo, Zoho Books, and QuickBooks could each, in principle, expose capabilities like
`accounting.invoices.read`/`accounting.invoices.write`/`accounting.customers.read` through the
same Generic REST framework once their real, documented REST APIs are confirmed — the
`ACCOUNTING` category already exists in `src/connectors/core/enums.js` for exactly this, but
none of these specific capability ids are in the canonical registry yet (Part 9/106:
`docs/CAPABILITY_REGISTRY.md` only lists capabilities with real code behind them today) — they
would be added to `CANONICAL_CAPABILITIES` at the same time a real accounting connector is
actually implemented, following the existing `category.action` naming convention. No
implementation exists for any of the three today.
