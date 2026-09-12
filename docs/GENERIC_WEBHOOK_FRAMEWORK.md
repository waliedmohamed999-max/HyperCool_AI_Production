# Generic Webhook Framework (Phase 6C)

`src/connectors/generic-webhook/`. Reuses Phase 6A/6B's SDK and the platform's EXISTING
idempotency ledger (`webhook_events`) and Event Bus (`runtime/events.js`) — no second copy of
either was built.

## Architecture

```
External Platform
  ↓ POST /api/webhooks/connectors/:publicId  (application.js — the ONE generic route)
Public webhook identifier (integration_connections.webhook_public_id — random, unguessable)
  ↓ getConnectionByPublicId() — the ONLY lookup a webhook route is allowed to use
Connection → Tenant (resolved ONLY this way — never from the request body/query/headers)
  ↓ tenantOperationalBlockReason() — the same central check the Connector Runtime (6A) and
    the agent runtime (4C-7) already use
Connector manifest lookup (registry.js) → trigger selection (fixed, or an event-type
  discriminator field the manifest itself declares)
  ↓ webhook authentication (HMAC/HEADER_TOKEN/SHARED_SECRET/NONE — against the RAW request
    bytes, secret from the Vault, timing-safe compare)
  ↓ idempotency — storeWebhookEvent() (UNCHANGED from Phase 3.5), a real DB UNIQUE constraint,
    not an in-memory Set
  ↓ declarative mapping (src/connectors/core/mapping.js — the SAME engine 6B's Generic REST
    response mapping now delegates to)
  ↓ eventBus.emit(trigger.normalizedEventType, {...normalizedData, tenantId, connectionId,
    connectorId, correlationId})  — the EXISTING, unchanged Event Bus (runtime/events.js)
Frost / Agents / Workflows (whatever already subscribes to that Event Bus type)
```

## Public webhook identifier (Part 4)

`integration_connections.webhook_public_id` — a nullable column, additive (`ALTER TABLE ...
ADD COLUMN`, safe on the real, already-populated production DB — verified via a real dry-run
migration against a real backup this phase: counts and `integrity_check` unchanged before/
after). Generated lazily, once, via `getOrCreateWebhookPublicId()` — a 32-hex-character
`randomUUID()` with dashes stripped. Never the connection's own (sequential-feeling) primary
key. `GET /api/integrations/connections/:id/webhook` is the one safe way an owner retrieves
their real webhook URL — reports `NOT_APPLICABLE` honestly when the connector has no triggers
at all (true for every currently-registered real connector — Salla/Anthropic/OpenAI declare no
triggers yet).

**The public id grants routing, not authentication** (Part 83) — real security still depends on
the trigger's own HMAC/token verification once configured.

## Tenant resolution (Part 5/65)

Resolved exclusively from the connection the public id maps to. A `tenant_id` field anywhere in
the request body/query/headers is never read for this purpose — proven directly by a test that
sends a real, correctly-signed webhook with a spoofed `tenant_id` claiming a DIFFERENT tenant,
and asserts the event only ever reaches the real owning tenant.

## Trigger manifest schema (Part 7) — `src/connectors/generic-webhook/manifest.js`

Extends Phase 6A's base trigger fields (`id, slug, eventType, payloadSchema, eventIdPath,
timestampPath, mappingDefinition`) with: `authentication` (see below), `normalizedEventType`
(must be a REAL, already-existing `runtime/events.js` `EVENT_TYPES` value — see
`docs/EVENT_NORMALIZATION.md`), `eventIdPolicy` (`REQUIRED`/`OPTIONAL`/`NONE`),
`eventTypeField`/`eventTypeValue` (discriminator-based trigger selection), and
`timestampHeader`/`maxSkewSeconds` (optional replay-window check). Duplicate trigger slugs
within one connector are rejected at manifest-validation time.

## Trigger selection (Part 9)

A connector with exactly one trigger and no discriminator uses it unconditionally ("fixed
endpoint trigger"). A connector with multiple triggers must declare `eventTypeField` per
trigger (e.g. `"event"`) and the exact `eventTypeValue` it matches (e.g. `"order.created"`) — an
event value that matches no declared trigger is rejected as `CONNECTOR_WEBHOOK_UNKNOWN_EVENT`,
never silently promoted into an arbitrary system event.

## Authentication (Part 10-16)

`NONE` (requires the manifest's own explicit `allowNone:true`, same pattern as Generic REST's
`auth.type: NONE`), `HMAC` (raw-bytes SHA-256, timing-safe compare, secret from the Vault —
never re-serialized JSON, verified directly by a dedicated test), `HEADER_TOKEN`, `SHARED_SECRET`
(header-based — a query-string variant was deliberately not built, since secrets in URLs are
routinely logged by intermediaries; Part 15's documented preference). Every secret lives in
`integration_credentials_vault` as `credential.payload.webhookSecret` — never in the manifest or
connection metadata.

## Idempotency / replay (Part 20-26)

Reuses `runtime/webhook-events.js`'s existing `webhook_events` table and its real
`UNIQUE(source, external_event_id)` constraint — a duplicate delivery (even two truly
*concurrent* identical deliveries, proven by a real `Promise.all` test) collapses to exactly one
`PROCESSED` result and one Event Bus dispatch; every redelivery reports `DUPLICATE`, a normal
2xx, never a second business event. `eventIdPolicy: REQUIRED` refuses an event with no real,
stable id outright (Part 22's honest documented limitation: `NONE` policy — for a provider
genuinely incapable of a stable id — gets a fresh random key every delivery and therefore
**cannot** be deduplicated; this is stated plainly, never silently pretended safe). An optional
`maxSkewSeconds` replay-window check runs only when the manifest explicitly declares a real
timestamp field — never invented for a provider that has none.

## Delivery semantics — no "exactly once" claim (Part 48/49)

**At-least-once delivery, at-most-once *business* processing.** The webhook HTTP layer is
deduplicated at the database level (the real, atomic constraint above) — so the same external
event can never trigger the Event Bus twice. The Event Bus itself (`runtime/events.js`) is a
synchronous, in-process `EventEmitter` — a handler that throws is caught and reported as
`AGENT_RUN_FAILED`, never silently lost, but this is standard in-process pub/sub semantics, not
a distributed, persisted queue with delivery guarantees. This is stated honestly; "exactly once"
in the distributed-systems sense is never claimed.

## Failure after the idempotency row is inserted (Part 50)

If mapping fails AFTER the `webhook_events` row is inserted, the row is marked `FAILED` (not
silently left `RECEIVED` forever) and the real error is audited — but the row itself is NOT
re-attempted automatically (no blind auto-retry of what could be a side-effect-bearing dispatch,
Part 52). A future replay would require a real provider redelivery (most webhook providers retry
on a non-2xx response) or a manual, explicit re-processing action — neither exists yet as
tooling in Phase 6C; documented as a known limitation.

## HTTP ACK behavior (Part 53)

| Case | HTTP status |
|---|---|
| Authenticated + processed | 200, `{status:'PROCESSED', eventId}` |
| Authenticated + duplicate | 200, `{status:'DUPLICATE', eventId}` |
| Invalid/missing signature | 401 |
| Unknown public id / disconnected connection | 404 |
| Tenant not operational (suspended/trial-expired) | 409 |
| Invalid JSON / missing required event id | 400 |
| Mapping failure | 422 |
| Body too large | 413 |

Every error body is `{error: <safe, generic message>}` — never a stack trace, DB error, Vault
error, or tenant detail (Part 110, verified by a real HTTP test).

## Audit (Part 75) and privacy (Part 76/77)

`CONNECTOR_WEBHOOK_RECEIVED`/`REJECTED`/`DUPLICATE`/`PROCESSED`/`FAILED` — safe metadata only
(connector/connection/tenant id, trigger slug, external event id, error code, never a secret).
Unlike some existing provider webhooks, the raw payload is deliberately **not** persisted in
`webhook_events` for a generic connector — only the trigger slug is stored alongside the
existing idempotency key; the normalized (already-mapped, already-minimal) data is what reaches
the Event Bus's own `agent_events` row.

## Connection health is never poisoned by a random caller (Part 111)

A repeated invalid signature against a connection's webhook endpoint has **zero effect** on that
connection's own `status`/health — verified directly by a test sending 5 consecutive bad
signatures and confirming the connection stays `CONNECTED`. Only the connector's own real,
authenticated health check (Phase 6A/6B's `checkConnectorHealth`) can ever change that.

## What's deliberately deferred (documented, not silently skipped)

- **Public id / webhook secret rotation** (Part 56/57) — not built this phase; a real Vault
  credential replacement already works (reuses existing `storeCredential`), but no dedicated
  "rotate" endpoint or grace-period logic exists yet.
- **Mapping preview service** (Part 85-87) — the mapping engine (`applyMapping`) is already a
  pure, side-effect-free function safely callable for a preview; no dedicated preview API route
  was added this phase (Phase 6D's Builder is the natural home for it).
- **Existing Salla/Meta/Microsoft webhooks were NOT migrated onto this framework** — by design
  (Part 2/73): they continue to work completely unchanged, verified by their own existing,
  unmodified test suites passing.
- **Rate limiting on the generic endpoint** (Part 55) — not added this phase; an unknown public
  id is at least rejected cheaply (one indexed lookup, no write) before any expensive work.
