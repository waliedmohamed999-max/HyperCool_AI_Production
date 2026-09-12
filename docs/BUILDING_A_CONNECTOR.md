# Building a New Connector (Phase 6A baseline; Phase 6D will add a no-code Builder UI on top)

Today (Phase 6A), adding a connector for an existing, already-implemented provider means:

1. **Define the manifest** (`src/connectors/<slug>/manifest.js`) — category, availability
   (honest — `DEFINITION_ONLY`/`NOT_IMPLEMENTED` if there's no real API access yet, see
   `docs/CONNECTOR_SECURITY.md`'s "no invented endpoints" rule), connectionMode, auth, the
   capabilities it really has code for, and its actions (each with a `requiredCapability`
   already present in the manifest's own `capabilities` list).
2. **Define the adapter** (`src/connectors/<slug>/adapter.js`) — wrap the EXISTING
   implementation (see `docs/CONNECTOR_SDK.md`'s pattern). Never reimplement a provider's real
   network calls inside the adapter; the adapter translates, it doesn't duplicate. Never invent
   an endpoint/OAuth URL/scope without a real, referenced API contract — see the hard rule below.
3. **Validate**: `validateAdapter(adapter, manifest)` — call it once at module load (see
   `src/connectors/registry.js`) so a mismatch fails at boot, never at first real request.
4. **Register**: add the `{manifest, adapter}` pair to `src/connectors/registry.js`'s `ENTRIES`.
5. **Test**: at minimum, a real `healthCheck`/`executeAction` test against a mocked `fetcher`
   proving the adapter's translation is correct (see `tests/connector-sdk.test.js`'s Salla/
   Anthropic tests) — never a live external call in a test.

**No change to `src/runtime/runtime.js` (Agent Runtime), `src/integrations/vault.js`
(Credentials Vault), `src/runtime/agent-readiness.js` (Readiness), or `src/application.js`'s
existing routes is required for this** — that is the architectural proof Phase 6A set out to
deliver (Part 86: "No special modifications to Agent Runtime / Control Center core / Vault /
Readiness / Tool Mapping except generic framework hooks").

## What's still missing for a brand-new (not-yet-implemented) real provider

Wiring a NEW connector's manifest+adapter into the live app so a tenant can actually create a
connection, complete an OAuth flow, and have an agent tool resolve to it — that requires:
Phase 6B's Generic REST Connector (for a simple API-key/bearer provider with no special OAuth
needs) or a dedicated adapter using that provider's real, documented OAuth flow; Phase 6C's
Webhook Framework (if the provider sends events); and Phase 6D's Integration Builder UI +
Marketplace (so the connection appears in Control Center without hand-written frontend code).
None of these exist yet — Phase 6A only proves the SDK layer itself is sound.

## The one hard rule that never changes

**Never invent an endpoint, OAuth URL, or scope for a provider without a real, referenced API
contract.** A connector with no verified documentation is built as `DEFINITION_ONLY` or
`NOT_IMPLEMENTED` (Part 5's honest availability states) — never a fake `AVAILABLE`/`CONNECTED`.
