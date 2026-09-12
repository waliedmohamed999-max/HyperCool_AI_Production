# Connector Version Management (Phase 6F status)

The versioning **policy and backend** are real and fully described in
`docs/CONNECTOR_VERSIONING.md` (Phase 6D's Policy B: immutable published snapshots, a connection
pins whichever version was live when it connected, `connector_definition_versions` retains every
snapshot forever). This document records, honestly, what Phase 6F did and did not add on top of
that for a Platform Admin actually browsing/managing versions.

## What's real

- Every publish creates a real, permanent, immutable JSON snapshot (`getVersionSnapshot`).
- A connection's `connector_version` column correctly pins it, and `resolveConnectorDynamic`
  resolves the pinned snapshot instead of the live definition when one is pinned — proven by a
  real regression test (`tests/integration-builder.test.js`'s "Versioning" test) that publishes
  v2 with a changed action path and confirms the v1-pinned connection still executes against the
  old path.
- The Builder's Review tab shows the definition's current real `version` number.

## What's NOT built (deferred)

- **No UI to list every past version** (v1, v2, v3...) with its own status/created/published
  date — only the live definition's current version number is shown anywhere in the UI.
- **No version diff view** — there is no screen that shows what changed between two snapshots
  (auth config, actions, paths, capabilities, webhooks, health).
- **No "Create New Draft Version" button distinct from just editing the live definition** —
  today, editing a published definition's actions/fields and clicking Publish again IS how a new
  version gets created (Policy B's existing mechanism); there is no separate "start drafting v3
  while v2 stays live" workflow.
- **No connection version migration UI** — an operator cannot, through any screen, look at an
  old-pinned connection and choose "migrate to v2" with a before/after diff, confirmation, and
  automatic health re-check. The only way a connection's version pin changes today is the
  low-level `connector_version` column, which nothing in the UI writes.
- **No rollback UI** — there is no button to move a connection back to an earlier published
  version.

## Why deferred

A safe migration/rollback workflow needs: a real diff renderer, a health re-check gate, and a
rollback path that itself can't silently break a working connection — building this correctly
was judged too large for this pass alongside everything else in Phase 6F's scope. The
underlying data model (`connector_definition_versions`, `connector_version` column) already
supports it; a future phase can build the UI/workflow without any new schema.
