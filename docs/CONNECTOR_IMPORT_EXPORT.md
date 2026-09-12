# Connector Import / Export / Clone (Phase 6F)

Real, tested, Platform-Admin-only features on top of the existing Integration Builder — no new
framework, no new trust surface.

## Clone

`POST /api/platform/connectors/:id/clone` (`cloneConnectorDefinition`,
`src/connectors/dynamic/builder.js`). Copies a real, existing `GENERIC_REST` definition's
declarative shape — auth config, base URL, capabilities, every action, every trigger — into a
brand-new `DRAFT` under a new slug. A system connector (`is_system=1`, e.g. Salla/Zid) cannot be
cloned this way (`SYSTEM_CONNECTOR_READONLY`) — its real behavior lives in code, not in
`connector_actions`/`connector_triggers`, so "cloning" it would silently produce an empty,
non-functional draft. **Never copies a credential** — a definition never holds one to begin
with; only `integration_connections` + the Vault do, and neither table is touched by clone.

## Export

`GET /api/platform/connectors/:id/export` (`exportConnectorDefinition`). Returns a plain,
portable JSON object: `{formatVersion, slug, nameAr, nameEn, category, descriptionAr,
descriptionEn, adapterType, connectionMode, auth, rest, capabilities, actions, triggers}`.
Every field here is already, by construction, secret-free — `auth`/`rest` on a definition hold
only non-secret configuration (a header NAME like `X-Api-Key`, never a header VALUE; a base URL,
never a token). Proven by a real test that scans the exported JSON for leaked secret-shaped
strings. A system connector cannot be exported (same rationale as Clone).

## Import

`POST /api/platform/connectors/import` (`importConnectorDefinition`). Accepts the exact shape
`exportConnectorDefinition` produces, plus an optional `slug` override (useful for re-importing
under a different name to avoid a slug collision). **The imported JSON is never trusted
directly** — every field re-enters through the identical validated entry points a human typing
the same values into the Builder wizard would go through:

- `createDraftConnector` — slug format, adapter type, connection mode, auth type/config
  (including `API_KEY` requiring a real `headerName`), the base URL through the real SSRF
  validator, every capability checked against the canonical registry.
- `upsertActionForConnector` — the action's capability must already be declared, and must be a
  known canonical capability.
- `upsertTriggerForConnector` — required trigger fields, and (via `hydrateAndValidate` at
  publish time) the trigger's normalized event type must be a real, existing `EVENT_TYPES` entry
  from the platform's own Event Bus.

A malformed or deliberately malicious export (an unsafe base URL, an invented capability, a
tampered event type) is rejected with the exact same error a Platform Admin would get typing it
by hand — proven by a real test that re-imports a tampered export and confirms both
`UNSAFE_BASE_URL` and `UNKNOWN_CAPABILITY` are still enforced.

A subtlety worth documenting: `listTriggersForDefinition`'s hydrated output shape
(`discriminatorPath`/`discriminatorValue`) is not byte-identical to what `upsertTriggerForConnector`
expects as input (`eventTypeField`/`eventTypeValue`) — a small, easy-to-miss asymmetry in the
existing store/hydrate contract. Clone/Export/Import all funnel through one shared
`triggerToUpsertInput()` helper so this conversion happens in exactly one place.

## What's NOT built

- No export/import for a `BUILT_IN`/`AI_PROVIDER` (system) connector — by design (see above).
- No versioned export (exporting always reflects the LIVE working copy, never a specific past
  published version's frozen snapshot — see `docs/CONNECTOR_VERSION_MANAGEMENT.md`).
- No bulk import (one file, one connector, per request).
