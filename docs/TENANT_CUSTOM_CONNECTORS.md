# Tenant Custom Connector Governance (Phase 6H status)

Phase 6F left `ENABLE_TENANT_CUSTOM_CONNECTORS` gating **nothing real** — only the flag existed,
with an honest warning that no tenant-facing endpoint checked it at all. **Phase 6G built the
real workflow**, in `src/connectors/dynamic/tenant-custom.js`.

## The real workflow

1. **Tenant Draft** (`createTenantConnectorDraft`) — a tenant owner (only when
   `ENABLE_TENANT_CUSTOM_CONNECTORS=true`) creates a `GENERIC_REST` connector definition scoped
   to their own tenant (`integration_definitions.owner_tenant_id`) — never visible to any other
   tenant, never auto-published.
2. **Security Validation** — the SAME real checks a Platform-Admin-created definition already
   gets (SSRF-validated HTTPS-only base URL, known-capability-only, capability-declared-before-
   action) plus tenant-specific restrictions (below), enforced at every write, not just at
   submission time.
3. **Submit for Review** (`submitTenantConnectorForReview`) — re-validated through the EXACT SAME
   validator (`hydrateAndValidate`) a Platform-Admin publish uses; a draft that would fail to
   publish can never even enter the review queue.
4. **Platform Review** (`listPendingTenantConnectors` / `reviewTenantConnector`) — every
   tenant-submitted `PENDING` draft appears in a real Platform Admin queue (Platform page,
   "موصلات المستأجرين بانتظار المراجعة"); the admin can **Approve**, **Reject**, or **Request
   Changes**, each decision audited (`TENANT_CONNECTOR_REVIEWED`).
5. **Approved -> Tenant Usage** — approval publishes the connector (`status: PUBLISHED`) and
   snapshots a real version 1 (it participates in the exact same versioning system a
   Platform-Admin connector does), but `getTenantCatalog`/`getConnectorForBuilder` both filter on
   `ownerTenantId` — it **never** becomes visible in the global marketplace for any other tenant,
   only the submitting tenant ever sees or can connect to it.
6. **Revision after Reject/Request Changes** — the tenant can edit the draft
   (`updateTenantConnectorDraft`, which resets `reviewStatus` back to `null`, an un-submitted
   draft) and resubmit.

## Tenant-specific restrictions actually enforced

- **Per-tenant limit**: `MAX_CUSTOM_CONNECTORS_PER_TENANT` (env var, default `3`) — counts every
  definition this tenant owns regardless of status. **Phase 6H** added a real per-tenant PLATFORM
  override: a nullable `tenants.custom_connector_limit` column (the same "nullable = no override,
  use the global default" convention `max_agent_level` already established), settable only by a
  Platform Admin from the tenant detail drawer (`POST /api/platform/tenants/:id/custom-connector-
  limit`, audited as `TENANT_CUSTOM_CONNECTOR_LIMIT_UPDATED`). `effectiveCustomConnectorLimit(db,
  env,tenantId)` — the tenant's own override when set, else the global default — is the ONE
  function both the draft-creation enforcement and the Platform tenant-detail display call, so
  there is never a second computation that could disagree.
- **URL policy**: HTTPS only, no `allowHttp` escape hatch (unlike a Platform-Admin connector,
  which may opt into `http://` for local testing), no `tenantConfigurableHost` — the SAME SSRF
  module (`validateOutboundUrl`) blocks private/reserved/loopback/metadata ranges with zero
  relaxation.
- **Capability policy**: `isKnownCapability` (no invented strings) AND a forbidden-prefix
  denylist (`platform.*`, `security.*`, `admin.*`, `permissions.*`) — even though the canonical
  registry does not currently contain any such capability, this is a defensive floor against a
  hypothetical future one.
- **Auth type policy**: only `NONE`/`API_KEY`/`BEARER_TOKEN`/`BASIC` — **OAuth2 is excluded from
  tenant self-service** by design: a working OAuth2 connector needs a real, Platform-Admin-
  provisioned `clientIdEnvKey`/`clientSecretEnvKey` pair in the platform's own process
  environment (see `docs/GENERIC_OAUTH2.md`), which a tenant could never provide anyway — refusing
  it up front is honest, not a workaround.
- **Event policy**: a tenant custom connector's webhook triggers go through the same
  `hydrateAndValidate`/`validateWebhookManifest` check requiring a real, already-existing
  `EVENT_TYPES` entry, exactly like a Platform-Admin connector, PLUS the tenant-specific webhook
  policy below (Phase 6H).
- **Webhook trigger policy (Phase 6H)**: `upsertTenantConnectorTrigger`/
  `deleteTenantConnectorTrigger`/`listTenantConnectorTriggers` reuse the EXACT SAME
  `connector_triggers` table and Generic Webhook Framework pipeline every Platform-Admin trigger
  uses — never a second, parallel webhook model. Restrictions: authentication type must be `HMAC`
  or `HEADER_TOKEN` only (`NONE` and `SHARED_SECRET` refused — a tenant-owned inbound endpoint
  always requires a real secret); `normalizedEventType` must be in a safe allowlist
  (`ORDER_CREATED`/`ORDER_UPDATED`/`ORDER_COMPLETED`/`CART_ABANDONED`/`PRODUCT_UPDATED`/
  `PRODUCT_STOCK_UPDATED`/`CUSTOMER_MESSAGE_RECEIVED`/`INVOICE_CREATED`) — deliberately excluding
  privileged/internal-automation-driving event types (`CONTENT_PUBLISH_REQUESTED`,
  `AGENT_RUN_FAILED`, etc.); a `MAX_CUSTOM_CONNECTOR_TRIGGERS` env var (default 3) caps the trigger
  count per connector, with re-upserting an existing slug (an edit) never counting against the
  limit.
- **Write policy**: any `POST`/`PUT`/`PATCH`/`DELETE` action declared on a tenant custom
  connector has `requiresApprovalDefault` forced to `true` — a tenant can tighten this (it already
  defaults to true) but can **never** loosen it, even by explicitly passing `false`.

## Ownership and isolation

`owner_tenant_id`/`review_status`/`review_notes`/`reviewed_by_user_id`/`reviewed_at` are additive
columns on the existing `integration_definitions` table (no second, parallel connector model).
Every read (`listOwnTenantConnectors`, `getTenantCatalog`) and write
(`updateTenantConnectorDraft`, `submitTenantConnectorForReview`) is scoped by `owner_tenant_id`
— a wrong-tenant id is indistinguishable from one that never existed (`CONNECTOR_NOT_FOUND`, the
same IDOR-safe convention every other tenant-scoped getter in this codebase already uses).
Platform Admin's existing `disableConnector` (unchanged) works on a tenant-owned connector exactly
as it does on a Platform-Admin one — the tenant cannot bypass a platform-level disable.

## UI

- **Tenant-facing**: Control Center → Integrations tab → "موصلاتي المخصصة" ("My custom
  connectors"), visible only to a tenant owner and only once the backend confirms the flag is
  actually on (the section renders nothing at all otherwise — never a client-side guess). Create
  draft, edit while in Draft, manage webhook triggers ("أحداث Webhook", Phase 6H — add/delete,
  auth type and event type restricted to the same safe allowlist the backend enforces), Submit for
  Review.
- **Platform-Admin-facing**: Platform page → "موصلات المستأجرين بانتظار المراجعة" ("Tenant
  connectors awaiting review") — Approve / Request Changes / Reject, reusing the existing
  connector wizard (read/edit access, since the admin already has full platform access) for full
  detail viewing, which now also shows any tenant-declared triggers (Phase 6H). The tenant detail
  drawer gained a "Custom connector limit for this tenant" section (Phase 6H) — the real current
  count/effective limit and a global-default-vs-custom-value override form.

## Proven by

- `tests/tenant-custom-connectors.test.js` (13 tests): flag-off refusal, the full lifecycle,
  tenant-only catalog visibility, per-tenant limits, forbidden capability prefixes, an unknown
  (non-forbidden-prefix) capability rejection, SSRF/HTTPS-only policy with no relaxation, OAuth2
  exclusion, forced write-approval, cross-tenant isolation, Platform Admin disable, and (Phase 6H)
  the per-tenant limit override raising/lowering the effective limit for exactly one tenant plus
  input validation.
- `tests/tenant-custom-webhooks.test.js` (5 tests, Phase 6H): auth-type policy, event-type
  allowlist, trigger-limit enforcement (with an edit-doesn't-count regression guard), delete+list+
  cross-tenant isolation, and a full end-to-end test — draft with an HMAC trigger → submit →
  Platform Admin's review view shows the real trigger → approve → tenant connects and stores a
  webhook secret → a real signed test event flows through the actual Generic Webhook Framework
  pipeline to `PROCESSED`.
- `tests/production-pilot-hardening.test.js` (Phase 6H): a real HTTP end-to-end test proving the
  custom-connector-limit-override route itself refuses a non-platform-admin (even the tenant's own
  owner) with 403, and that a platform admin's change is real, audited, and reversible.
- `tests/e2e/tenant-custom-governance-journey.e2e.mjs` — two genuinely separate browser
  sessions/tenants: Tenant Owner drafts+submits, Platform Admin reviews+approves through the real
  UI, the submitting tenant connects to their own approved connector, and a THIRD, separate
  tenant's own catalog never sees it.
- `tests/e2e/phase6h-closure-journey.e2e.mjs` (Phase 6H) — creates a webhook trigger through the
  real "أحداث Webhook" UI while still DRAFT, submits, and confirms Platform Admin approval still
  succeeds with the trigger intact.

## What's still NOT built (honestly deferred)

- **No notification** to the tenant when their draft is approved/rejected/changes-requested
  (email or in-app) — they must check the Integrations tab themselves to see the updated
  `reviewStatus`.
- **The tenant-facing UI itself only covers the basics** (slug/names/base URL/auth type/
  capabilities) needed for a minimal REST connector — action management beyond creation
  (editing/deleting a declared action) has a backend route but no dedicated table/row UI yet on
  the tenant side (the Platform Admin's existing wizard, reused for viewing, has the fuller
  action-management UI already).
- **No "why was I rejected" rich history** — only the single latest `reviewNotes`/`reviewStatus`
  is kept; a full audit trail of every review decision exists in `platform_audit_log`
  (`TENANT_CONNECTOR_REVIEWED`) but has no dedicated tenant-facing history view yet.
- **Tenant webhook triggers are read/write-REST-plus-inbound-webhook only** — a tenant custom
  connector still cannot declare OAuth2 (see the Auth type policy above); this is unchanged and
  remains a deliberate exclusion, not an oversight.

## History

Phase 6G built the core security-critical governance path (isolation, SSRF, capability/write
policy, the review gate itself) and honestly documented the per-tenant limit override and
tenant-facing webhook triggers as out of scope. Phase 6H closed both of those exact gaps.
