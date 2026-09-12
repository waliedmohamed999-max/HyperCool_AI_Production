# Pilot Feedback Log (Phase 5, Part 34)

Lightweight, running log of real issues found during the controlled production pilot. One row
per issue — filled in as real pilot usage happens, never backfilled with invented examples.
Never include sensitive customer content (names, phone numbers, message text) — describe the
mechanism, not the data.

Every entry that represents a real production bug must be resolved through
`docs/PILOT_RUNBOOK.md`'s "No Silent Fixes" procedure: root cause, tenant affected, data impact,
the fix, and the regression test added — before "fix status" is marked done.

| Date | Tenant | Area | Issue | Severity (P0/P1/P2) | Reproduction | Decision | Fix status |
|---|---|---|---|---|---|---|---|
| 2026-09-12 | Existing real HyperCool tenant (owner: waliedaboelezz) | AI Provider Connection | `PUT /api/integrations/connections/:id/credential` rejected a genuinely valid Anthropic/OpenAI API key with `ANTHROPIC_NOT_CONFIGURED`/`OPENAI_NOT_CONFIGURED`. Root cause: `testAnthropicConnection`/`testOpenAIConnection` (`src/connectors.js`) gated on `connectionStatus(env).configured`, which requires a PLATFORM-WIDE `ANTHROPIC_MODEL`/`OPENAI_MODEL`/`OPENAI_DEFAULT_MODEL` env var — a legacy, pre-multi-tenant concept unrelated to a tenant's own per-connection key (Phase 4B's "tenant supplies their own key" flow never sets a platform model env var). The real network call (`GET /v1/models`) never used a model at all, so the gate was pure dead weight blocking every real per-tenant connection. A pre-existing test comment had already documented this exact requirement as a workaround, without anyone flagging it as a bug. | P1 (blocked legitimate use, no data/security impact) | Submit any valid Anthropic/OpenAI key via the Integrations UI on a deployment with no platform-level `ANTHROPIC_MODEL`/`OPENAI_MODEL` set — always fails `*_NOT_CONFIGURED` regardless of key validity. | Fix the two test functions to check only for the API key's own presence, since the network call needs nothing else. | **Fixed** — `src/connectors.js`; regression test added: `tests/integration-connections-api.test.js` ("Phase 5 pilot regression — PUT credential ... succeeds ... even when NO platform-level ANTHROPIC_MODEL/OPENAI_MODEL env var is set at all"). 471/471 tests passing. |
