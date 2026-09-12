# Universal Integration Platform — Integration Builder (Phase 6D)

> **Phase 6G update**: the wizard gained an 8th step, **Versions** (list/diff/"Create New Draft
> Version" — see `docs/CONNECTOR_VERSION_MANAGEMENT.md`), and the Basics/Auth panel gained a full
> **OAUTH2** auth-type option (authorizeUrl/tokenUrl/scopes/PKCE/client-auth-method/identity-
> endpoint/client-credential-env-var-references — see `docs/GENERIC_OAUTH2.md`) so a Platform
> Admin can define a brand-new working OAuth2 connector without any code change. The Platform
> page also gained a "Pending Custom Connectors" review queue for Tenant Custom Connector drafts
> (`docs/TENANT_CUSTOM_CONNECTORS.md`).

> **Phase 6F update**: a dedicated "Integration Builder" sidebar entry now links straight here
> (see `docs/INTEGRATION_PLATFORM_COMPLETE.md`); the landing table gained Adapter/Auth/
> Capabilities/Action-count/Webhook-count/Updated columns plus status tabs (All/Draft/
> Published/Disabled); a Platform Admin can now Clone, Export, and Import a connector
> (`docs/CONNECTOR_IMPORT_EXPORT.md`); the action editor gained a real Mapping Preview; and
> disabling a connector now shows a live dependency count before the confirmation.

The Integration Builder is the Platform-Admin-only UI (inside `#platform`, `public/pages/
platform.js`) over the Builder backend described in `docs/DYNAMIC_CONNECTOR_DEFINITIONS.md`. It
is reachable only when the signed-in session is a Platform Admin (`auth.isPlatformAdmin`, from
`/api/auth`) — every route it calls is independently, server-side gated regardless of what the
UI shows, exactly like the rest of the Platform Operations dashboard.

## Layout

A new "Connectors" section (`#pf-connectors`) sits below the existing Tenant Directory on the
Platform page. It lists every connector — system (Salla, Anthropic, ...) and dynamic — with its
real status, version, and live connection count, sourced from `GET /api/platform/connectors`.
A system connector opens a small read-only detail view (name, slug, capabilities, connection
count) with an explicit note that it is managed in code, not here. A dynamic connector opens the
full wizard.

## The wizard

A single drawer with five sections, backed by `GET /api/platform/connectors/:id` for state and
one API call per save action — never a giant client-side form submitted once at the end:

1. **Basics / Authentication / Capabilities** (combined into one panel — see "Design note"
   below): slug, Arabic/English name, category, description, connection mode, base URL (`https`
   only — the SSRF-hardened `validateOutboundUrl` runs before anything is ever saved),
   `allowHttp` (for local testing only), auth type + header name, and a checkbox list of
   capabilities sourced from `GET /api/platform/capabilities` (the real canonical registry — no
   freehand text field a Platform Admin could typo into a rejected publish). The first save here
   is `POST /api/platform/connectors` (creates the `DRAFT`); every save after that is `PATCH
   /api/platform/connectors/:id`. Slug, adapter type, and connection mode are locked (disabled in
   the form) once created — the backend does not accept changes to them via this path either.
2. **Actions**: a list of the connector's declared REST actions plus an "Add Action" form (HTTP
   method, path template, required capability — drawn from the connector's OWN declared
   capabilities only, risk level, approval requirement, and an optional response array path for
   the mapping preview). Delete removes one action.
3. **Webhooks**: the same list/add pattern for triggers — auth type (HMAC/header-token/shared-
   secret/none), signature header/prefix, external event id path/policy, and the normalized
   event type. The normalized event type must be a real, already-existing `EVENT_TYPES` entry
   from the platform's own Event Bus (`src/runtime/events.js`) — enforced server-side by
   `validateWebhookManifest`, never a second, invented taxonomy.
4. **Health Check**: method (`GET`/`HEAD` only — health is read-only by construction), path,
   expected status code. Saved via the same `PATCH` route, merged into the connector's
   `rest_config.health`.
5. **Review & Publish**: shows the live status/version/dependency count, a "Validate" button
   (`POST .../validate` — the exact same validator `publishConnector` itself uses, so a green
   check here means the definition WILL publish cleanly), "Publish Now" (with an explicit
   confirmation, since it becomes tenant-visible immediately), and — once published —
   "Disable"/"Reactivate".

### Design note: why Basics/Auth/Capabilities share one panel

The backend's `createDraftConnector` is atomic — it needs a base URL, an auth type, and a
capability list all at once to run its SSRF/auth/capability validation and produce a real,
useful draft. Splitting these into three separate wizard STEPS would mean holding partially-
entered, unvalidated state across steps before anything is ever saved. Combining them into one
panel with one "Create Draft" action means the very first thing that reaches the server is
already a complete, independently valid draft — consistent with this phase's broader principle
that the Builder's own validation is never weaker or later than the backend's.

## Publish confirmation and safety rails

- Publishing shows an explicit warning ("this becomes visible to every tenant immediately") and
  requires a second confirm click — never a single accidental click away from a marketplace-wide
  change.
- The Validate button surfaces the EXACT error a failed publish would produce (unknown
  capability, unsafe URL, invalid mapping, duplicate slug, invalid auth config, invalid webhook
  event type — see `docs/DYNAMIC_CONNECTOR_DEFINITIONS.md`'s validation section) — never a vague
  "something went wrong".
- Disable asks for confirmation and explains the real, honest effect: new connections and new
  executions are blocked, existing connection data is preserved (nothing is ever deleted).

## What a Platform Admin cannot do here

- Cannot create a `BUILT_IN`/`AI_PROVIDER` connector (`INVALID_ADAPTER_TYPE`) — those remain
  real, code-reviewed adapters.
- Cannot upload a file, paste a script, or reference a module path — every field maps to a plain
  JSON column.
- Cannot publish a definition with an unknown capability, an unsafe base URL, or an invalid auth
  config — the backend validates every one of these at save time, not just at publish time.
- Cannot edit or disable a system connector from this UI (`SYSTEM_CONNECTOR_READONLY`).

## Verifying it end-to-end

A full Playwright journey (Platform Admin logs in via the real first-run setup screen → creates
"Acme ERP" purely through this wizard: Basics/Auth/Capabilities → Actions → Review → Publish,
zero code touched → the connector automatically appears in a tenant's Control Center Integrations
tab, grouped under its real category, with a working "Add Connection" flow) was run against a
live, ephemeral instance of the real application (not a mock) during this phase's own
verification pass. See `docs/INTEGRATION_MARKETPLACE.md` for the tenant-facing half of that
journey.
