# Universal Integration Platform — Connector Framework (Phase 6A)

> **Phase 6B update**: the Generic REST Connector (`src/connectors/generic-rest/`) now exists on
> top of this exact framework — see `docs/GENERIC_REST_CONNECTOR.md` and
> `docs/CONNECTOR_SSRF_SECURITY.md`. The only changes to the files described below: (1)
> `core/runtime.js`'s `executeConnectorAction` now threads a `manifest` (plus optional
> `resolver`/`transport` test hooks) into `adapter.executeAction()` — purely additive, ignored by
> the 6A adapters; (2) a new `checkConnectorHealth()` export in the same file, alongside (never
> replacing) the pre-existing `src/integrations/health.js`; (3) one additive entry,
> `'connector_action'`, was already present in `approvals.js`'s `ACTION_TYPES` from 6A and is
> reused unchanged. Everything else below is exactly as Phase 6A left it.

> **Phase 6C update**: the Generic Webhook Framework (`src/connectors/generic-webhook/`) —
> see `docs/GENERIC_WEBHOOK_FRAMEWORK.md`, `docs/DATA_MAPPING_ENGINE.md`,
> `docs/EVENT_NORMALIZATION.md`. New: `integration_connections.webhook_public_id` (additive
> column, migration verified safe against a real production DB copy), a real
> `POST /api/webhooks/connectors/:publicId` route and `GET .../connections/:id/webhook` route in
> `application.js`, and the canonical mapping engine promoted to `core/mapping.js` (6B's mapper
> now delegates to it). Existing Salla/Meta/Microsoft webhook routes are completely unchanged.

## What this phase actually built

A real, additive Connector SDK under `src/connectors/` that can represent an existing
integration (Salla, Anthropic, OpenAI wrapped so far) as a `{manifest, adapter}` pair, plus a
central `ConnectorRuntime.execute()` pipeline that runs any connector action through the same
tenant/capability/health/approval/audit checks. **Nothing in `src/application.js`'s live HTTP
routes was rewired this phase** — the existing Salla/Meta/Microsoft/X/LinkedIn/Anthropic/OpenAI
code paths are byte-for-byte unchanged (all 471 pre-existing tests pass unmodified). This phase
proves the SDK is sound by wrapping 3 real providers around it, not by replacing anything live.

## Why: the real problem this solves

Before this phase, every provider's auth/health/action logic was hand-written and directly
referenced by slug in `src/application.js`, `src/integrations/health.js`,
`src/runtime/tools.js`, and `src/connectors.js` (see the Phase 6 integration audit —
`docs/CAPABILITY_REGISTRY.md`'s own audit section, plus the hardcoded-branch list). Adding a
new provider meant touching all of those files. A **Connector Manifest** + **Adapter** pair
lets a future provider (Zid, TikTok, an accounting API — see `docs/BUILDING_A_CONNECTOR.md`)
declare its shape once and plug into one runtime, without any of those files changing again.

## Architecture

```
ConnectorManifest (static data: id, slug, category, auth, capabilities, actions, ...)
        ↓ validated by
src/connectors/core/manifest.js  (validateManifest — throws on any structural problem)
        ↓ paired with
ConnectorAdapter (a plain object: healthCheck, executeAction, ...) — wraps EXISTING provider code
        ↓ validated by
src/connectors/core/adapter.js  (validateAdapter — shape-checks the adapter against its manifest)
        ↓ both registered in
src/connectors/registry.js  (fails fast at module load if any pair is invalid)
        ↓ invoked through
src/connectors/core/runtime.js  (executeConnectorAction — the one real execution pipeline)
```

## The execution pipeline (`executeConnectorAction`)

Exactly the 13-step pipeline this phase's spec required, reusing EXISTING infrastructure at
every step rather than building a second copy:

1. Tenant validation — `tenancy.js`'s `tenantOperationalBlockReason` (the same central check
   the agent runtime uses since Phase 4C-7 — a suspended/trial-expired tenant is blocked here too).
2. Connector manifest lookup (`registry.js`, or an injected `resolveConnector` in tests).
3. Action definition lookup within the manifest.
4. Connection validation — `integrations/connections.js`'s `getConnectionOrNull` (already
   tenant-scoped; a cross-tenant connection id resolves to `null`, never another tenant's row).
5. Capability validation — the connection's own connector must declare the capability the
   action requires.
6. Connection health (status-based: `CONNECTED`/`DEGRADED` only).
7. Permission — deferred to the caller (the same pattern every existing route already follows
   via `authorize(session,[...])` before reaching business logic).
8. Approval if required — reuses the EXISTING Approval Engine (`runtime/approvals.js`)
   unchanged, via a new `'connector_action'` entry in its `ACTION_TYPES` list (the only edit to
   pre-existing business logic this phase made — purely additive, nothing removed or renamed).
9. Vault credential retrieval — `integrations/vault.js`'s `getCredentialForRuntime` (the
   decrypted payload is passed to the adapter and NEVER logged/audited — see step 12).
10. Adapter execution — the ONE place a real network call happens.
11. Response validation — structural only this phase (a full JSON-Schema check on
    `action.outputSchema` is Phase 6B's Data Mapping Engine's job).
12. Audit — `CONNECTOR_ACTION_EXECUTED`/`CONNECTOR_ACTION_FAILED`/`CONNECTOR_ACTION_PENDING_APPROVAL`,
    tenant-scoped, safe fields only (status, error code, latency, correlation id — never the
    raw output or any credential).
13. Result — `{status, ...adapterOutput, correlationId, latencyMs}`.

## What's deliberately NOT done this phase (by design, not oversight)

- **Agent Runtime is not rewired.** `src/runtime/runtime.js`'s tool-call path still resolves
  providers exactly as it always has. Making a generic agent Tool call through
  `ConnectorRuntime.execute()` instead is Phase 6B/6D's job, once the Generic REST Connector and
  Integration Builder give a real reason to (today's 3 wrapped connectors are all read-only,
  proof-of-architecture only).
- **Webhook processing is not generic yet.** A manifest may DESCRIBE an existing webhook route
  (`salla/manifest.js`'s `webhooks` field), but nothing calls `adapter.processWebhook()`
  generically — Salla's real webhook still runs through its own existing, unchanged
  `/api/webhooks/salla` route. That is Phase 6C's Webhook Framework.
- **No Generic REST Connector, no Builder UI, no Marketplace UI.** Phases 6B/6D.
- **Meta/WhatsApp/Microsoft/X/LinkedIn are not yet wrapped as connectors.** Only Salla (proving
  a real `MULTI`-mode OAuth2 provider with a real action) and Anthropic/OpenAI (proving a real
  `API_KEY` provider) were wrapped this phase, per the explicit instruction to check in before
  continuing further. Wrapping the remaining 5 is a mechanical, lower-risk repeat of the exact
  same pattern — see `docs/BUILDING_A_CONNECTOR.md`.

## Files

- `src/connectors/core/enums.js` — shared vocabularies (category, availability, connection
  mode, auth type, action type, risk level, idempotency policy, webhook auth type, error code).
- `src/connectors/core/capability-registry.js` — the canonical capability list + legacy aliases.
- `src/connectors/core/manifest.js` — `validateManifest()`.
- `src/connectors/core/adapter.js` — `validateAdapter()`.
- `src/connectors/core/runtime.js` — `executeConnectorAction()`.
- `src/connectors/registry.js` — the assembled, validated registry of real connectors.
- `src/connectors/{salla,anthropic,openai}/{manifest,adapter}.js` — the 3 wrapped providers.
- `tests/connector-sdk.test.js` — 17 new tests (manifest/adapter validation, capability
  aliasing, and the full runtime pipeline including a real approval-gated write action, a
  suspended-tenant block, and a cross-tenant IDOR check).
