# Generic REST Connector (Phase 6B)

> **Phase 6C update**: response mapping now delegates to the canonical engine promoted to
> `src/connectors/core/mapping.js` (`docs/DATA_MAPPING_ENGINE.md`) — same behavior, same
> `applyResponseMapping()` export, now with real prototype-pollution/depth/array limits it did
> not have in 6B. A REST-and-webhook connector (like Acme) validates through
> `validateWebhookManifest()` instead of `validateRestManifest()` directly — it calls through to
> the REST validation first, then layers webhook trigger validation on top.

`src/connectors/generic-rest/`. A single, shared `genericRestAdapter` (`adapter.js`) that
executes ANY REST connector's declarative manifest — no per-provider code. See
`docs/CONNECTOR_SSRF_SECURITY.md` for the security layer every request goes through, and
`docs/BUILDING_A_CONNECTOR.md` for the general connector-authoring pattern this extends.

## Architecture

```
Connector Definition (manifest, code-based this phase — Phase 6D adds a Builder UI over it)
  rest.baseUrl / rest.allowedHosts / rest.tenantConfigurableHost / rest.health
  actions[].rest.{httpMethod, pathTemplate, queryMapping, headerMapping, bodyMapping, responseMapping}
        ↓ validated by
src/connectors/generic-rest/manifest.js (validateRestManifest — extends 6A's validateManifest)
        ↓ executed by
src/connectors/generic-rest/adapter.js (genericRestAdapter — ONE shared instance)
        ↓ through
src/connectors/core/runtime.js (executeConnectorAction — unchanged 6A pipeline, Part 51)
        ↓ using
src/connectors/core/ssrf.js (safeFetch — every outbound byte)
src/connectors/generic-rest/mapping.js (declarative query/body/response mapping, no eval)
src/connectors/generic-rest/headers.js (dangerous-header + auth-header-ownership filtering)
```

## Definition vs. Connection (Part 4)

The **Connector Definition** (manifest) is global — `baseUrl`, `allowedHosts`, `auth.type`, and
every action's shape are fixed, code-defined data, never per-tenant. The **Connection** is
tenant-scoped (`integration_connections`, unchanged from Phase 4B/6A) and holds only: which
tenant, its own status/health, and a reference to its own Vault credential
(`integration_credentials_vault`, unchanged). No secret ever lives in the manifest.

## Authentication (Part 5-9)

`auth.type` ∈ `NONE, API_KEY, BEARER_TOKEN, BASIC` — generic OAuth2 is explicitly deferred
(Part 39); an `OAUTH2`-typed connector still requires a real, dedicated adapter (like Salla's
from Phase 6A), not the generic one. `NONE` requires an explicit `auth.allowNone:true` in the
manifest — it is never inferred from a simply-missing credential at execution time (a missing
credential when auth is actually required fails as `CONNECTION_UNHEALTHY`/an explicit auth
error, never silently treated as "no auth needed").

| Type | Manifest declares | Vault credential payload | Header sent |
|---|---|---|---|
| `API_KEY` | `auth.headerName` | `{apiKey}` | `<headerName>: <apiKey>` |
| `BEARER_TOKEN` | — | `{token}` | `Authorization: Bearer <token>` |
| `BASIC` | — | `{username, password}` | `Authorization: Basic <base64>` |
| `NONE` | `auth.allowNone:true` | — | none |

The `Authorization` header (and every dangerous infrastructure header — `Host`,
`Content-Length`, `Connection`, `Transfer-Encoding`, `Proxy-*`, `Forwarded`, `Via`,
`X-Forwarded-*`, `Upgrade`) can **never** be set via a manifest's declarative `headerMapping` —
only the real auth strategy above may ever produce `Authorization` (Part 16).

## Action definition (Part 10-17)

`httpMethod` ∈ `GET, POST, PUT, PATCH, DELETE, HEAD`. `pathTemplate` (e.g. `/orders/{orderId}`)
is a **path only** — it can never smuggle a scheme, host, or `//` (Part 13/14); the real request
URL is always `manifest.rest.baseUrl` + the filled path template, nothing else. Path variables
are percent-encoded.

**Safe default risk** when a manifest doesn't declare its own (Part 12) — a write method never
silently defaults LOW:

| Method | Default actionType | Default riskLevel |
|---|---|---|
| GET, HEAD | READ | LOW |
| POST | EXTERNAL_WRITE | MEDIUM |
| PUT, PATCH | EXTERNAL_WRITE | HIGH |
| DELETE | DESTRUCTIVE | HIGH |

## Declarative mapping (Part 15/17/18/19) — no eval, ever

- `queryMapping`/`bodyMapping`: `{"page": "$input.page"}` — `$input.foo` looks up `input.foo`;
  anything else is a literal constant. No functions, no template engine, no `eval`/`new
  Function`.
- `responseMapping`: `{path:"a.b"}`, `{const:...}`, `{string|number|boolean:<mapping>}`,
  `{fallback:[...]}`, `{array:{from:"orders",item:{id:"id",total:"total"}}}`,
  `{object:{...}}` — a small, closed set of safe primitives (`src/connectors/generic-rest/mapping.js`),
  intentionally NOT the full Phase 6C Data Mapping Engine.

## Execution & safety (Part 51/61-65/90-95)

Every action runs through the unchanged Phase 6A `executeConnectorAction()` pipeline — tenant
check, tenant-scoped connection lookup (IDOR-safe), capability check, connection-health check,
the **existing** Approval Engine (a write-shaped action `WAITING_APPROVAL`s a real approval row
and the adapter is provably never called before it resolves — see the tests), Vault credential
retrieval, then `genericRestAdapter.executeAction()`, then audit. There is no second, parallel
execution path — a Generic REST connector cannot bypass any of this.

## Health checks (Part 47/48/57/97)

Declarative, read-only only (`GET`/`HEAD`), through the exact same `safeFetch` SSRF layer —
`checkConnectorHealth()` (`src/connectors/core/runtime.js`) is the tenant-scoped entry point,
additive alongside (never replacing) the pre-existing `src/integrations/health.js` dispatcher
that still serves every pre-6A provider unchanged.

## The Acme test connector (Part 54-57)

`src/connectors/acme/manifest.js` — a real manifest (`get_products`, `get_orders`, and a
write-shaped `create_order` proving approval safety) used ONLY by
`tests/generic-rest-connector.test.js` against a fully injected, deterministic mock transport.
**It is deliberately never registered in `src/connectors/registry.js`** — the real, live
registry loaded by the running application contains only Salla/Anthropic/OpenAI, exactly as in
Phase 6A. `acme.test` uses the IANA/RFC 2606-reserved test TLD; no real company is named or
impersonated.

## Generic capability proof (Part 58/59/96)

Both Salla (Phase 6A) and Acme declare the same canonical capability,
`commerce.products.read` — proving a generic commerce Tool could resolve to either, with **zero
Acme-specific branch anywhere in `ConnectorRuntime`** (verified directly in the test suite by
reading `runtime.js`'s own source and asserting it contains no `acme` reference at all). An
`AgentToolAssignment` still pins one exact `connection_id` — assigning the Acme connection
always executes Acme, never Salla, even though both satisfy the same capability (Part 59) —
that part of the architecture (wiring a real generic Tool through this path) remains Phase 6D's
job; 6B proves the underlying mechanism is sound.
