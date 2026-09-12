# Universal Integration Platform — Data-Driven Marketplace (Phase 6D)

> **Phase 6E update**: Zid (`docs/ZID_CONNECTOR.md`) is the first real, external, first-party
> BUILT_IN connector proven through this exact catalog with zero frontend changes — it is seeded
> (never Builder-authored) and appears in `GET /api/integrations/catalog` and the Control Center
> Integrations tab purely because it is a `PUBLISHED` row in the same `integration_definitions`
> table Salla/Anthropic/OpenAI already use. No marketplace card was hand-written for it.

> **Phase 6F update**: the documented SPA staleness gap below (nav links never refetching data)
> is now FIXED for both this page and the Platform page — see `app.js`'s `refetchPageIfNeeded`.
> Publishing a connector and switching tabs shows it immediately; a full reload is no longer
> required. Also: a Manual Action Runner and Action History now exist on each connection card
> (`docs/INTEGRATION_OPERATIONS.md`), and the `GET /api/tools/:slug/connections` route — used by
> the Agent config drawer's own connection dropdown — had a real bug fixed where a generic,
> capability-only tool (`get_invoices`/`get_orders`/`get_customers`) always got an empty list.

## The tenant-facing catalog

`GET /api/integrations/catalog` (owner/operator only, `application.js`) returns
`getTenantCatalog(db)` (`src/connectors/dynamic/builder.js`): every `integration_definitions` row
with `status === 'PUBLISHED'`, projected to safe metadata only — slug, names, category,
description, icon key, capabilities, availability, connection mode, and auth type. A `DRAFT`
connector is excluded outright (never even 404s meaningfully to a tenant — it simply isn't in the
list); a `DISABLED` one is excluded too (no NEW connection can be started against it, though an
existing connection to it is still visible and manageable — see below). This is the ONE
real-time source of truth for "what can this tenant connect right now," whether the connector is
a code-defined built-in (Salla, Anthropic, ...) or a Builder-published dynamic one — there is no
separate code path for either kind.

## Control Center: catalog-driven, not hardcoded

`src/runtime/control-center.js`'s `buildIntegrationsSummary` — the aggregation backing every
Control Center tab via `GET /api/control-center/summary` — already read
`listIntegrationDefinitions(db)` before this phase (a real, data-driven catalog since Phase 4A);
this phase's actual gap was that it never filtered `DRAFT` rows and never surfaced `status`/
`capabilities` to the frontend. Both are fixed: `DRAFT` definitions are excluded from the summary
entirely (Part 39/40 — a Platform Admin's in-progress work is never visible to any tenant), and
each provider entry now carries its real `status`, `capabilities`, and `isSystem` flag.

`public/pages/control-center.js`'s Integrations tab groups provider cards by their real
`category` (computed from the live data, `[...new Set(providers.map(p => p.category))]` — a
brand-new category value from a Builder-published connector needs zero frontend change to get
its own section). A card shows its real capabilities (`accounting.invoices.read`, etc.), its real
connection-mode badge, and — for a `DISABLED` dynamic connector — an honest "Disabled by
platform" badge instead of silently vanishing while it may still have a live connection a tenant
needs to manage.

**Canva remains honestly unavailable** — `isAvailable: 0`, no real implementation anywhere —
completely untouched by this phase.

## The Generic Connection UI

Before this phase, "Add Connection" only had two hand-written branches: Salla (OAuth redirect)
and Anthropic/OpenAI (an API-key form hardcoded to those two slugs' own test-and-store route).
Any other provider's "Add Connection" click was a **silent no-op** — a pre-existing, undocumented
gap this phase closed generically rather than adding a third hardcoded branch.

`startGenericConnect()` (`control-center.js`) is the one form every `GENERIC_REST`/Builder-
published connector's connect flow uses, driven entirely by the real `authType` the catalog
reports for that connector:

| authType | Form field(s) | Submitted as |
|---|---|---|
| `API_KEY` | one password field | `{apiKey}` |
| `BEARER_TOKEN` | one password field | `{token}` |
| `BASIC` | username + password | `{username, password}` |
| `NONE` | none (an explanatory note only) | `{}` |

Submission is two real backend calls: `POST /api/integrations/connections` (creates the
connection row, `NOT_CONFIGURED`), then `PUT /api/integrations/connections/:id/generic-
credential` — a NEW route, `application.js`, that stores the credential and then runs a REAL
health check (`checkConnectorHealth`, the same ConnectorRuntime pipeline the Agent tool path
uses) BEFORE marking the connection `CONNECTED`. A failing credential — or an unreachable base
URL, or (for a connector with no health check configured) trivially nothing to fail — is never
silently accepted as success; the route 422s and the connection stays un-connected. No secret
field is ever re-rendered after submit; nothing is written to `localStorage`/`sessionStorage`.

A built-in OAuth2 provider with zero connections yet (WhatsApp/Meta/Microsoft 365/X/LinkedIn)
still has no generic "add first connection" path through this button in this pass — each has its
own dedicated OAuth start route, not wired to this particular UI entry point. Clicking "Add
Connection" for one of those now shows an honest "not available" message instead of the silent
no-op it used to be, and instead of a confusing 400 from attempting the generic-REST-only route.

## Verifying it end-to-end

Proven at three layers, deliberately not just one:

1. **Function-level** (`tests/integration-builder.test.js`, 20 tests) — Builder backend
   functions called directly, including cross-tenant isolation and secret-never-leaks checks.
2. **Real HTTP** (`tests/integration-builder-http.test.js`, 8 tests) — the actual
   `application.js` routes, a real server, real cookies/CSRF, including the honest-failure path
   for an unreachable base URL and the full inbound-webhook HMAC round trip.
3. **Real browser** (Playwright, run during this phase's verification, not checked into the test
   suite as a repeatable CI job this pass) — a Platform Admin creates "Acme ERP" purely through
   the Builder wizard, publishes it, and a tenant sees it appear automatically in their Control
   Center (grouped under its own category, with a working generic "Add Connection" dialog) after
   their own session's next full load — see the note on SPA navigation below.

### A real, pre-existing SPA behavior worth knowing about

This application's nav links (`showPage()` in `public/app.js`) only toggle which already-
rendered page is visible — they do not refetch data. Only a full `render()` (a fresh page load or
login) re-fetches `/api/control-center/summary`. This means if the SAME browser tab is already
open when a Platform Admin publishes a new connector, clicking between tabs in that same tab
will not show it until the next full reload/login — a platform-wide behavior affecting every
page equally (agent config changes, team membership changes, etc. have the identical property),
not something introduced by or specific to this phase. A real tenant owner's own separate login
session sees the new connector immediately, correctly, with zero special-casing.
