# Universal Integration Platform — Connector Versioning (Phase 6D)

> **Phase 6E note**: this snapshot/pinning policy applies to `GENERIC_REST` (Builder-published)
> connectors only. Zid (`docs/ZID_CONNECTOR.md`) is `adapterType: BUILT_IN` — a real, code-
> reviewed, versioned-by-git-commit connector exactly like Salla/Anthropic/OpenAI, with no
> `connector_actions`/`connector_triggers` rows and no per-connection `connector_version`
> pinning; a code change to `src/connectors/zid/*` ships to every existing Zid connection on the
> next deploy, the same as any other BUILT_IN connector fix always has.

## The policy (Policy B)

> A published Connector Definition's manifest is an immutable snapshot. The live
> `integration_definitions` row (plus its `connector_actions`/`connector_triggers` children) is a
> **working copy** a Platform Admin keeps editing. A new **publish** creates a new, immutable,
> numbered snapshot. An existing `integration_connections` row stays pinned to whichever version
> was live when it was created (or, more precisely, whenever it was explicitly pinned — see
> below) — it never silently starts behaving differently because someone edited the connector
> after the fact.

This was one of two policies considered. The rejected alternative ("every connection always
tracks the live definition") was rejected because it means a Platform Admin fixing a typo'd path
on Connector X can silently break every tenant's already-working integration with that connector
the moment they hit publish — completely invisible until a tenant's next action call starts
failing. Policy B trades a small amount of complexity (a `connector_version` column, a snapshot
table) for the guarantee that **publishing a new version to any dynamic connector never
retroactively changes what an existing, already-CONNECTED tenant's integration does.**

## The mechanics

**Snapshot storage** (`connector_definition_versions`, `src/connectors/dynamic/store.js`):

```sql
CREATE TABLE connector_definition_versions (
 id TEXT PRIMARY KEY,
 connector_definition_id TEXT NOT NULL,
 version INTEGER NOT NULL,
 manifest_snapshot TEXT NOT NULL,   -- the FULL, already-validated manifest, JSON
 published_at TEXT NOT NULL,
 published_by_user_id TEXT,
 UNIQUE(connector_definition_id, version)
);
```

`publishConnector` (`src/connectors/dynamic/builder.js`) computes the manifest exactly once
(`hydrateAndValidate` — the same validator runtime resolution itself uses), computes the next
version number, and calls `saveVersionSnapshot(db, definitionId, version, manifest,
actorUserId)`. The snapshot is never mutated after that — a later publish only ever `INSERT`s a
new row at a new version number.

**Version numbering**: the definition is created with `version:1` at DRAFT time. The FIRST
publish uses that same `1` (no snapshot exists yet, so there's nothing to "bump" from). Every
SUBSEQUENT publish (editing an already-published definition and publishing again) increments:
`newVersion = definition.publishedAt ? definition.version + 1 : definition.version`.

**Pinning a connection**: `integration_connections` gained an additive `connector_version INTEGER`
column. `createConnection` itself does **not** pin a version automatically in this phase — a real
connect flow is expected to read the definition's current `version` at the moment of connecting
and record it explicitly (the test suite does this with a direct `UPDATE ... SET
connector_version = ?`, documenting the exact real-world sequence a connect endpoint would
follow). A connection with `connector_version IS NULL` (never explicitly pinned) always resolves
against the LIVE definition — this is deliberately the same behavior a NEW connection created
right now would have, so "no version pinned yet" is never treated as an error state.

**Resolution** (`src/connectors/dynamic/registry.js`'s `resolveConnectorDynamic`): both
`executeConnectorAction` and `checkConnectorHealth` (`src/connectors/core/runtime.js`) fetch the
connection FIRST (before resolving the connector), and pass
`{connectorVersion: connection?.connectorVersion ?? null}` into `resolveConnectorDynamic`:

- `connectorVersion` given → look up that exact snapshot (`getVersionSnapshot`). Found → use it,
  regardless of what the live row currently says. Not found (e.g. the version was never actually
  published, a data inconsistency) → fall through to the live-row path below.
- `connectorVersion` null, or no matching snapshot → the definition must be `PUBLISHED` right
  now, and the LIVE row is hydrated and validated fresh.

This means an old, pinned connection is completely insulated from any edit made to the connector
after it connected — including an edited action path, a changed capability list, or a changed
health check — until/unless something explicitly re-pins it to a newer version.

## A concrete example (from `tests/integration-builder.test.js`)

1. Publish Acme ERP → version 1, action `get_invoices` has `pathTemplate: '/invoices'`.
2. A tenant connects → their connection is pinned to version 1.
3. The Platform Admin edits the action's path to `/v2/invoices` and publishes again → version 2,
   a NEW immutable snapshot. The version-1 snapshot is asserted, in the test, to be byte-for-byte
   unchanged (`v1Snapshot.actions[0].rest.pathTemplate === '/invoices'`, still).
4. The OLD, pinned connection executes `get_invoices` → still hits `/invoices` (proven against a
   mock transport that only responds `200` on `/invoices`, `404` on anything else — a genuine
   regression here would show up as `CONNECTOR_REMOTE_NOT_FOUND`, not a silent pass).
5. A BRAND-NEW connection created now (unpinned) → resolves the LIVE definition, which — since
   v2 is the latest publish — matches v2's `/v2/invoices` path.

## A real bug this phase found and fixed

`executeConnectorAction`/`checkConnectorHealth` originally called
`resolveConnector(connectorSlug, {connectionVersion: ...})` — but `resolveConnectorDynamic`
destructures `{connectorVersion = null}`. The property name mismatch (`connectionVersion` vs.
`connectorVersion`) meant the pinned version was silently dropped on every call, and resolution
always fell through to the live/latest manifest — meaning an old, pinned connection would have
started executing against a NEWLY PUBLISHED version's action path the moment anyone republished
the connector, exactly the failure mode Policy B exists to prevent. Caught by the
"Versioning" test in `tests/integration-builder.test.js` (it failed with `'ERROR' !== 'OK'`, then
`CONNECTOR_REMOTE_NOT_FOUND` once the errorCode was inspected — the old connection was hitting
`/v2/invoices` against a mock that only served `/invoices`). Fixed at both call sites in
`src/connectors/core/runtime.js`. A full-codebase grep confirmed no other occurrence of the
`connectionVersion` spelling exists anywhere in `src/` or `tests/`.

## What's deliberately NOT done this phase

- **No UI to browse old versions or roll back to one.** The data model supports it (every
  snapshot is retained forever, nothing is ever deleted) but no Builder UI screen was built for
  it this phase.
- **No automatic re-pinning / migration of old connections to a new version.** A tenant stays on
  whatever version they connected against until a future phase adds an explicit "upgrade this
  connection" action.
