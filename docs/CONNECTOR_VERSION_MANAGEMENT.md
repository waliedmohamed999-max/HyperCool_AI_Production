# Connector Version Management (Phase 6G status)

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
- **"Create New Draft Version"**: `createDraftVersion` flips the live definition row back to
  `DRAFT` so further edits accumulate toward the *next* publish — **without touching the
  already-immutable current snapshot**. This is safe because `resolveConnectorDynamic` only ever
  refuses a *pinned* resolution when the definition is `DISABLED`, never merely `DRAFT` — every
  connection already pinned to the live version keeps executing exactly as before while a
  Platform Admin drafts the next one. The trade-off: no *new* connection can be started against
  the connector until it is republished (the same rule that already applied to any `DRAFT`
  connector) — there is no "two versions live for new connections simultaneously" blue/green
  mode; that would need a genuinely different architecture (parallel action/trigger rows per
  version) and was judged out of scope for this pass.
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
- **Version audit**: `CONNECTOR_VERSION_CREATED` (on draft-version creation),
  `CONNECTOR_VERSION_PUBLISHED` (alongside the existing general `CONNECTOR_PUBLISHED`, on every
  publish including the first), `CONNECTION_VERSION_MIGRATED`, `CONNECTION_VERSION_ROLLED_BACK` —
  all real `recordAudit`/`recordPlatformAudit` calls in `application.js`'s routes.
- **UI**: the Builder wizard's Versions tab (list + diff + create-draft-version); the Connection
  page's "Advanced" drawer Version tab (current/available version, migrate with a pre-flight
  diff+impact preview and explicit confirmation, rollback).

## Proven by

- `tests/connector-versioning.test.js` (8 tests): version list/diff/create-draft-version, the
  safe migration success path, the capability-regression refusal (and that the connection stays
  on the old version), the health-check-failure refusal (same guarantee), rollback, and a
  `getConnectorDependencies` regression guard.
- `tests/e2e/versioning-journey.e2e.mjs` — a full real-browser journey: publish v1, connect
  (pinned to v1), create v2 via the Versions tab, confirm the existing connection is unaffected,
  migrate through the real UI, confirm the pin actually changed, then roll back. 8/8 checks pass.

## What's still NOT built (honestly deferred)

- **No parallel "v2 live for new connections while v3 drafts" mode** — see the trade-off note
  above; a connector is either fully live (one version, `PUBLISHED`) or fully drafting (`DRAFT`,
  no new connections) at any moment.
- **No bulk "migrate every connection on this connector to the latest version" action** — each
  connection is migrated individually, one at a time, by design (a bulk action would need its own
  confirmation/rollback semantics across many connections, judged too large for this pass).
- **No UI to browse a raw JSON diff** — the diff view is a structured summary (added/removed/
  changed lists), not a line-by-line JSON diff; sufficient for the fields that actually matter
  (capabilities/actions/triggers/auth/health/connectionMode) but not a generic object-diff tool.

## History

Phase 6D built the model. Phase 6F's own `docs/CONNECTOR_VERSION_MANAGEMENT.md` (this file,
previous revision) honestly listed every one of the "What's real now" items above as **not
built** — that gap is what Phase 6G closed.
