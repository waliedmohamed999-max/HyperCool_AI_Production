# Connector Version Management (Phase 6H status)

The version **model and policy** have been real since Phase 6D — see `docs/CONNECTOR_VERSIONING.md`
(Policy B: immutable published snapshots in `connector_definition_versions`, a connection pins
whichever version it was connected against via `integration_connections.connector_version`).
Phase 6F added Builder-side visibility notes but left the actual UI, the connect-time pin, and
connection-level migration/rollback unbuilt (see that phase's own honest admission, preserved
below in "History"). **Phase 6G built all of it.**

## What's real now

- **The connect-time pin is now actually written.** `updateConnection` (Phase 6D onward) never
  included `connector_version` in its own `UPDATE` statement — a real, silent gap: every
  connection ever created stayed unpinned (`connector_version IS NULL`) regardless of what the
  data model intended. Fixed in `src/integrations/connections.js`. Both real connect-success
  paths — the generic OAuth2 callback and the generic-credential route — now pin a `GENERIC_REST`
  connection to the connector's live `PUBLISHED` version at the exact moment it becomes
  `CONNECTED`.
- **Versions tab** (Integration Builder, step 7): `listConnectorVersions` (`src/connectors/
  dynamic/builder.js`) returns every real, permanent snapshot — version number, status
  (`PUBLISHED` for the one matching the definition's current live version, `ARCHIVED` for every
  older one), real `publishedAt`/`publishedByUserId`, a live `COUNT` of connections currently
  pinned to it, and a computed `changeType` summary (a real diff against the previous version,
  never a guess). While a new draft version is being prepared, a synthetic `DRAFT` row appears
  too (see below).
- **Version diff**: `computeManifestDiff`/`getVersionDiff` structurally compares two snapshots —
  connection mode, auth type (never a secret value — a manifest's `auth` block is non-secret
  config only, by construction), capabilities added/removed, actions added/removed/changed
  (by field), triggers added/removed/changed, health check changes. One algorithm, used by both
  the Versions tab's diff view and the Connection page's pre-migration preview.
- **"Create New Draft Version" — Safe Published Version Lifecycle (Phase 6H).** Phase 6G's
  `createDraftVersion` used to flip the live definition row itself to `DRAFT`, which meant no
  *new* connection could be started against the connector at all while a Platform Admin drafted
  the next version — an honest, but real, limitation. Phase 6H replaced this with a genuinely
  **parallel draft-overlay workspace**: new tables `connector_draft_meta`/`connector_draft_actions`/
  `connector_draft_triggers` (schema-identical mirrors of the live `connector_actions`/
  `connector_triggers`, see `src/connectors/dynamic/draft-store.js`). Creating a draft version now
  populates the overlay and leaves `integration_definitions.status='PUBLISHED'` and every live
  action/trigger row **completely untouched** — the connector keeps accepting brand-new
  connections (pinned to the current live version, exactly as before) for the entire time a
  Platform Admin is editing the draft. Editing actions/triggers/basic info while a draft exists
  transparently redirects to the overlay (`upsertActionForConnector`/`upsertTriggerForConnector`/
  `updateDraftConnector` in `src/connectors/dynamic/builder.js`); `getConnectorForBuilder` merges
  the overlay into its response and adds `hasDraft`/`liveVersion`/`liveStatus` fields so the UI can
  show a persistent "you are editing a draft; vN keeps serving new connections" banner. Publishing
  (`publishFromOverlay`) validates the **overlay's own raw manifest** first — a validation failure
  never touches the live tables — and only on success replaces the live content, bumps the
  version, snapshots it, and discards the overlay. `discardDraftVersion` throws the overlay away
  without ever having touched anything live. `listConnectorVersions`'s per-row status is now
  labeled `LIVE` (the one currently serving traffic) / `PREVIOUS` (an older immutable snapshot) /
  `DRAFT` (the in-progress overlay, derived from `hasDraftOverlay()` rather than the definition's
  own `status`).
- **Connection Version Migration** (`src/connectors/dynamic/connection-versions.js`,
  `previewVersionMigration`/`migrateConnectionVersion`): a real, three-step safe pipeline —
  (1) the target version must have a real, retained snapshot; (2) **hard capability-compatibility
  gate** — every active `agent_tool_assignments` row using this connection is checked against the
  target version's capabilities; if migrating would silently break one, the migration is refused
  outright (`CAPABILITY_REGRESSION`) *before* anything is touched; (3) a **real health check**
  (the same `genericRestAdapter.healthCheck` the runtime itself uses) is run against the
  *candidate* version — only a successful check ever updates the pin. Any failure at any step
  leaves the connection completely unchanged on its old version — there is no partial-write state
  to roll back from, because nothing is written until every check passes.
- **Rollback** (`rollbackConnectionVersion`): finds the nearest *lower* version that still has a
  real retained snapshot (never assumes `N-1` exists) and runs it through the exact same safe
  migration gate above.
- **Bulk Connection Version Migration (Phase 6H)** — `src/connectors/dynamic/bulk-operations.js`:
  `previewBulkVersionMigration` is a network-free, read-only preview (total affected connections,
  distinct tenants, a per-connection capability-regression flag) built from the exact same data
  the single-connection preview uses. `bulkMigrateConnections` reuses the **exact same
  single-connection safe-migration pipeline** described above, one connection at a time, bounded
  to 200 per call, classifying each outcome `READY`/`SKIPPED` (a known-safe refusal — capability
  regression, unhealthy target version) /`FAILED` (unexpected). `bulkRollbackOperation` rolls back
  only the connections a specific prior bulk operation actually migrated (`status==='READY'`),
  each to its own exact recorded prior version, through the same safety gate in reverse. Every
  bulk attempt is persisted to a new `bulk_operations` audit table (readable via
  `GET /api/platform/bulk/operations[/:id]`). Exposed in the Builder's Versions tab as a "Bulk
  Migrate Connections" button (shown once ≥2 real versions exist) with a live preview, per-
  connection selection (capability-regression rows unchecked by default), and a results table with
  a one-click Rollback.
- **Version audit**: `CONNECTOR_VERSION_CREATED` (on draft-version creation),
  `CONNECTOR_VERSION_PUBLISHED` (alongside the existing general `CONNECTOR_PUBLISHED`, on every
  publish including the first), `CONNECTION_VERSION_MIGRATED`, `CONNECTION_VERSION_ROLLED_BACK` —
  all real `recordAudit`/`recordPlatformAudit` calls in `application.js`'s routes.
- **UI**: the Builder wizard's Versions tab (list + diff + create-draft-version); the Connection
  page's "Advanced" drawer Version tab (current/available version, migrate with a pre-flight
  diff+impact preview and explicit confirmation, rollback).

## Proven by

- `tests/connector-versioning.test.js` (10 tests): version list/diff/create-draft-version, the
  safe migration success path, the capability-regression refusal (and that the connection stays
  on the old version), the health-check-failure refusal (same guarantee), rollback, a
  `getConnectorDependencies` regression guard, and (Phase 6H) a dedicated test proving the live
  `connector_actions` rows are byte-for-byte unaffected by draft edits and that a brand-new
  connection can still be created against the live connector while a draft is in progress.
- `tests/bulk-version-migration.test.js` (5 tests, Phase 6H): preview never mutates state;
  execution migrates only the healthy connection while an unhealthy one is left untouched; the
  200-connection batch bound; rollback restores exactly the migrated connections; Platform Admin
  gating.
- `tests/e2e/versioning-journey.e2e.mjs` — a full real-browser journey: publish v1, connect
  (pinned to v1), create v2 via the Versions tab, confirm the existing connection is unaffected,
  migrate through the real UI, confirm the pin actually changed, then roll back.
- `tests/e2e/phase6h-closure-journey.e2e.mjs` (Phase 6H) — opens the real Bulk Migrate
  Connections drawer, verifies the live preview's affected-connection count, executes, and
  confirms the connection is actually pinned to the new version afterward.

## What's still NOT built (honestly deferred)

- **No bulk "migrate to a version other than the current live one" preset** — bulk migration
  always targets a specific `fromVersion`/`toVersion` pair the operator picks explicitly; there is
  no "migrate everyone to whatever is newest" shortcut (deliberate — Part 8's "never inferred
  silently" rule).
- **No UI to browse a raw JSON diff** — the diff view is a structured summary (added/removed/
  changed lists), not a line-by-line JSON diff; sufficient for the fields that actually matter
  (capabilities/actions/triggers/auth/health/connectionMode) but not a generic object-diff tool.

## History

Phase 6D built the model. Phase 6F's own `docs/CONNECTOR_VERSION_MANAGEMENT.md` (this file,
previous revision) honestly listed every one of the "What's real now" items above as **not
built** — that gap is what Phase 6G closed. Phase 6G's own real limitation — a connector was
either fully live (one version) or fully drafting (no new connections) at any moment, never both
— is what Phase 6H's Safe Published Version Lifecycle closed, alongside adding Bulk Connection
Version Migration.
