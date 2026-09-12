# Webhook Operations — Status (Phase 6F)

The Generic Webhook Framework itself (inbound processing, HMAC/header-token/shared-secret auth,
idempotency, Event Bus dispatch) is real and fully documented in
`docs/GENERIC_WEBHOOK_FRAMEWORK.md`. This document covers the **operational tooling** around it
that Phase 6F's spec asked for — what's real, what isn't.

## What's real

- **Webhook URL visibility**: `GET /api/integrations/connections/:id/webhook` (Phase 6C) returns
  the connection's real, unguessable webhook URL and its declared triggers — already used by the
  Builder/marketplace flow, unchanged this phase.
- **Idempotency**: the real `webhook_events` table's `UNIQUE(source, external_event_id)`
  constraint — a genuine DB-level guarantee, not an in-memory set — proven safe under real
  concurrent delivery in `tests/webhook-burst.test.js`.
- **Failure visibility (aggregate only)**: the Integration Platform dashboard card now shows a
  real, live, platform-wide count of `webhook_events` rows with `status='FAILED'`
  (`buildPlatformOverview`'s new `failedWebhooks` field, Phase 6F).

## What's NOT built (deferred)

- **Webhook URL rotation** — there is no endpoint or UI action to rotate a connection's
  `webhook_public_id`. The old URL never becomes invalid because nothing ever changes it.
- **Webhook secret rotation** — there is no endpoint or UI action to rotate the HMAC/token
  secret stored in a connection's Vault credential. Changing it today means manually re-storing
  a new credential through the existing generic-credential route (which was designed for initial
  connection, not secret rotation specifically — it works, but isn't labeled or flowed as a
  "rotate" action).
- **Test Event / sample delivery** — there is no "send an internal sample event through the same
  pipeline" action; the only way to exercise a webhook trigger today is a real, correctly-signed
  HTTP POST to the real URL (as every automated test in this codebase already does).
- **Failed webhook inspector** — there is no screen listing individual failed `webhook_events`
  rows (timestamp, connector, trigger, error code, correlation id) — only the aggregate COUNT
  exists (see above).
- **Safe reprocess** — there is no action to explicitly re-run a FAILED webhook event's mapping/
  dispatch using its already-stored idempotency row.
- **Documented retry semantics**: this platform makes NO retry guarantee at all today — a failed
  webhook delivery is recorded as FAILED and nothing automatically retries it. It is explicitly
  **not** exactly-once, **not** at-least-once by platform retry (idempotency only protects
  against the SENDER retrying the same delivery, which this platform then correctly collapses to
  one processed event) — if the sender never retries a delivery that failed on this platform's
  side, that event is simply lost until a future "safe reprocess" feature exists.

## Why deferred

Rotation and reprocessing both touch security-sensitive state (a secret used for signature
verification; re-triggering a real Event Bus dispatch that may already have downstream side
effects) — building them correctly needs careful design of exactly when the OLD credential/URL
stops being honored and what "safe" reprocessing means for an event that may have already
partially propagated. Given this phase's overall scope, this was judged lower priority than the
discoverability, Builder-completeness, and Manual Action Runner work that was completed instead.
