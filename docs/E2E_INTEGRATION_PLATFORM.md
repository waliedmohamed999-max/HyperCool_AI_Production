# Integration Platform — Playwright E2E Suite (Phase 6F/6G)

Five real browser journeys against a real, ephemeral instance of the actual application (a fresh
temp SQLite data directory + a real HTTP server on an ephemeral port) — zero mocking of the app
itself. Run all five with:

```
npm run test:e2e
```

Each script exits `0` on success, `1` on any failed check, and prints `OK -`/`FAIL-` per
assertion plus a `=== JOURNEY N SUMMARY ===` block — safe to wire into a CI step.

## Journey 1 — Builder → Publish → Marketplace (`tests/e2e/builder-marketplace.e2e.mjs`)

A Platform Admin creates a real dynamic connector ("Acme ERP"-style) entirely through the
Integration Builder UI — Basics/Auth/Capabilities, one action, publish — and the connector
appears automatically in the tenant-facing catalog. Proves: zero hand-written frontend code is
needed for a new connector; a `DRAFT` connector is invisible to the catalog; publishing makes it
visible immediately.

## Journey 2 — Tenant Connect → Health → Tool Assignment → Safe Read (`tests/e2e/tenant-connect-journey.e2e.mjs`)

A Platform Admin publishes a connector; the SAME session (also a real tenant owner) discovers it
automatically in Control Center's Integrations tab, connects via the Generic Connection UI, and
the generic `get_invoices` tool's own connection-compatibility route lists the resulting
connection. Proves: catalog-driven discoverability with zero per-provider frontend branch; the
generic-capability tool compatibility route (Phase 6F's own bug fix) actually works end-to-end.

## Journey 3 — Versioning (`tests/e2e/versioning-journey.e2e.mjs`, Phase 6G)

Publish v1 (no health check declared, so "connect" succeeds honestly without any live network
call — this suite deliberately never dials a real third-party API, matching every other journey
here) → connect (pinned to v1) → create v2 via the Versions tab (edit the action's path, publish)
→ confirm the EXISTING connection is completely unaffected (still pinned to v1) → migrate through
the real Advanced-drawer UI (pre-flight diff+impact preview, explicit confirmation, a real health
check against the candidate version) → confirm the pin actually moved to v2 → roll back → confirm
it moved back to v1. **8/8 checks pass.**

## Journey 4 — Webhook Operations (`tests/e2e/webhook-operations-journey.e2e.mjs`, Phase 6G)

Publish a connector with a real HMAC webhook trigger (auth `NONE` for the connector's own primary
credential, so this journey needs zero outbound network — only INBOUND webhook delivery, driven
by direct `fetch()` calls to the real webhook URL, exactly like a genuine external sender would)
→ connect → rotate the webhook secret for the first time through the real Advanced-drawer UI (the
secret shown exactly once) → deliver a validly HMAC-signed event, confirm `PROCESSED` → rotate the
public ID through the UI → confirm the OLD URL now 404s and the NEW one still accepts the SAME
secret → rotate the secret again → confirm the OLD signature now fails (401) and the NEW one
works. **13/13 checks pass.**

## Journey 5 — Tenant Custom Connector Governance (`tests/e2e/tenant-custom-governance-journey.e2e.mjs`, Phase 6G)

`ENABLE_TENANT_CUSTOM_CONNECTORS=true`. Unlike Journeys 1-4, this uses **two genuinely separate
Playwright browser contexts/sessions/tenants** (the Platform Admin's own signup, and a second,
independently created Tenant Owner + tenant — created via the same backend functions the app's
own signup route calls, with a real session cookie injected into its own browser context, since
this journey's point is proving isolation between two REAL distinct sessions, not exercising the
signup form itself). The Tenant Owner creates a custom connector draft and submits it for review;
the Platform Admin's real "Pending Custom Connectors" queue shows it and approves it; the
connector becomes visible ONLY in the submitting tenant's own catalog (verified against a THIRD,
separate tenant's catalog, which never sees it); the tenant connects to their own newly-approved
connector. **12/12 checks pass.**

## Why these specific safe-network choices

Every journey deliberately avoids a real outbound call to a live third-party API — the exact same
constraint `tests/integration-builder-http.test.js`'s own header comment already documents ("SSRF
correctly rejects any local test server bound to a private/loopback address, and no real Acme-ERP-
shaped API exists to call"). Journeys 1/2/3 use a connector with **no declared health check**
(`genericRestAdapter.healthCheck` returns `OK` immediately when `manifest.rest.health` is
`undefined` — a real, honest, zero-network success path, not a shortcut). Journey 4 uses `auth:
{type:'NONE'}` so connecting needs no outbound call either, and only exercises the INBOUND webhook
direction (which needs no outbound network by construction). Journey 5 uses the same no-health-
check pattern for its own connect step. The outbound REST call pipeline itself (SSRF-validated
`safeFetch`, real request/response mapping) is already proven at the function level with an
injected `resolver`/`transport` in `tests/connector-versioning.test.js`, `tests/usage-
analytics.test.js`, and `tests/integration-builder.test.js` — this E2E suite proves the UI wiring
and real HTTP routing, not the outbound-call pipeline a second time.

## What's NOT covered by this suite

- No visual regression / screenshot diffing.
- No accessibility audit automation (contrast, ARIA correctness) — covered manually per the
  Phase 6D/6F RTL/LTR/responsive passes, not by these scripts.
- No load/concurrency testing of the real webhook idempotency guarantee under true concurrent
  delivery — that is covered separately by `tests/webhook-burst.test.js` (function-level, not
  E2E).
