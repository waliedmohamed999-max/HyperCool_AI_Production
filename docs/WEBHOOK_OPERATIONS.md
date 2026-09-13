# Webhook Operations (Phase 6H status)

The Generic Webhook Framework itself (inbound processing, HMAC/header-token/shared-secret auth,
idempotency, Event Bus dispatch) is real and fully documented in
`docs/GENERIC_WEBHOOK_FRAMEWORK.md`. Phase 6F documented the operational tooling around it as
**not built** — rotation, test events, a failed-event inspector, and safe reprocess. **Phase 6G
built all of it**, in `src/connectors/generic-webhook/operations.js`.

## What's real now

- **Webhook Console** (`getWebhookConsoleView`): the real webhook URL, public id, per-trigger
  auth type, last received/processed timestamps, and a real failed-event count — one live read,
  no invented numbers.
- **Public ID rotation** (`rotateWebhookUrl` / `rotateWebhookPublicId` in `connections.js`): the
  connection's `webhook_public_id` column is unconditionally replaced. The OLD value simply stops
  matching any row the moment this happens — `getConnectionByPublicId` does an exact lookup, so
  there is no grace window and nothing further to revoke; this matches the platform's existing
  "a rotated/removed credential takes effect immediately" convention everywhere else.
- **Secret rotation** (`rotateWebhookSecret`): generates a fresh, cryptographically random secret
  and merges it into the connection's EXISTING Vault credential (`storeCredential` is a full
  replace, so every other field — e.g. the connector's own primary `apiKey` — is explicitly
  preserved here rather than silently dropped). The new secret is returned to the caller **once**;
  no route ever exposes it again afterward, and the UI shows it in a read-only field with an
  explicit "shown once, copy it now" notice.
- **Test Webhook** (`sendTestWebhookEvent`): reuses the exact same `processGenericWebhook`
  pipeline a real external delivery goes through — auth, mapping, idempotency, Event Bus dispatch
  — never a second, looser "preview" implementation. The synthetic event id is namespaced
  (`__internalTest:true` marker in the payload) so it can never be confused with — or collide
  with — a genuine delivery, and the UI/response both label it `internalTest: true` rather than
  implying a provider actually sent it.
- **Failed Webhook Inspector** (`listFailedWebhookEventsForConnection` /
  `getFailedWebhookEventDetail`): the list is safe metadata only (time, trigger, external event
  id, error code, status, correlation id) — no raw payload by default (Part 14). The detail view,
  gated to Platform Admin OR the tenant owner of that exact connection (never a bare "operator"
  role, and never any other tenant's), shows the raw payload with a best-effort mask over
  sensitive-looking key names (`token`, `secret`, `password`, `api_key`, `authorization`, `card`,
  `cvv`, `iban`) — a courtesy on top of, never a substitute for, the route-level authorization
  check.
- **Raw payload retention, but only for genuine failures**: `webhook_events` gained a nullable
  `raw_payload` column, populated **only** on the mapping-failure path (`generic-webhook/
  webhook.js`) — the success path (`PROCESSED`/`DUPLICATE`) still never persists it, unchanged
  from Phase 6C's own deliberate design. This is what makes Safe Reprocess possible without
  changing the platform's existing low-retention posture for the 99% happy path.
- **Safe Reprocess** (`reprocessFailedWebhookEvent`): re-runs mapping+dispatch against the
  ORIGINAL stored payload of the EXACT SAME event (same identity — never a new row, never a
  re-fetch from the provider). Guarded by an atomic, CAS-style status transition
  (`transitionWebhookEventStatus`, a single `UPDATE ... WHERE status=?` whose affected-row count IS
  the lock) claimed from whatever the row's real current status is — two concurrent "Reprocess"
  clicks can never both proceed, and a second attempt on an already-`PROCESSED` event is refused
  (`NOT_REPROCESSABLE`), never silently re-dispatched. Phase 6H extended this to also accept
  `DEAD_LETTER` as a starting state (see Automatic Webhook Retry below) — an event that exhausted
  its automatic retry budget can still be manually fixed and reprocessed by a human.
- **Bulk Webhook Reprocess (Phase 6H)** — `src/connectors/dynamic/bulk-operations.js`:
  `previewBulkWebhookReprocess` returns the exact total matched count (by connector + optional
  tenant/date-range/error-code) plus a bounded, oldest-first sample. `bulkReprocessWebhookEvents`
  reuses the exact same single-event `reprocessFailedWebhookEvent` pipeline for every selected
  event (either an explicit pre-confirmed `eventIds` list or the same filter the preview used),
  bounded to 100 events per call. Only ever selects `status='FAILED'` rows at the DB level, so
  `PROCESSED`/`DUPLICATE` events are structurally never touched. Classifies each outcome
  `PROCESSED` / `STILL_FAILED` (mapping genuinely fails again — a real, expected outcome) /
  `SKIPPED` (a structurally safe refusal) / `FAILED` (unexpected); every attempt is persisted to
  the same `bulk_operations` audit table Bulk Version Migration uses.
- **Automatic Webhook Retry with backoff/dead-letter (Phase 6H)** —
  `src/connectors/generic-webhook/retry.js`: a bounded, backed-off retry loop for FAILED generic
  webhook deliveries, reusing the EXISTING `webhook_events` ledger (two new additive columns,
  `retry_count`/`next_retry_at` — never a second queue table) and the EXISTING scheduler tick
  (`runtime/scheduler.js`) rather than a bespoke timer. A newly-FAILED event with a stored raw
  payload gets scheduled for its first retry (`RETRY_SCHEDULED`, a 1min/5min/15min backoff ladder,
  `WEBHOOK_MAX_RETRIES`-configurable, default 3). A due retry re-runs the exact same
  mapping+dispatch step the original delivery uses, claimed via a `PROCESSING` in-flight state kept
  deliberately distinct from manual reprocess's own `REPROCESSING` (the two flows can never collide
  on the same CAS guard). Success dispatches through the real Event Bus exactly once
  (`automaticRetry:true`); exhausting the retry budget moves the event to `DEAD_LETTER` instead of
  retrying forever — still visible and manually reprocessable (see above). An event with no stored
  raw payload (a pre-Phase-6G failure) is honestly never auto-scheduled.
- **Platform Operations visibility (Phase 6H)** — `listDeadLetterEvents`/`listPendingRetries`
  (Platform Admin only) plus `GET /api/platform/webhooks/{dead-letters,pending-retries}`: real,
  live, cross-tenant lists surfaced on the Platform dashboard's new "Platform Operations" section,
  alongside the most recent Bulk Operations (version migrations + webhook reprocesses).
- **UI**: the Connection page's "Advanced" drawer Webhook tab — URL/secret rotation, send test
  event, view failed events (now also showing `RETRY_SCHEDULED`/`DEAD_LETTER` rows with a real
  retry-count/next-retry-at column) with a per-row Reprocess button (disabled when no raw payload
  was retained, or while an event is actively `RETRY_SCHEDULED`); the Builder's Webhooks tab gained
  a "Bulk Reprocess Failed Webhooks" button (filters, live preview, per-event selection, results).

## Proven by

- `tests/webhook-console.test.js` (7 tests): console view, URL rotation (old id genuinely stops
  resolving), secret rotation (other credential fields survive; old signature fails, new one
  works), a real test event through the actual pipeline, the failed inspector's masking, Safe
  Reprocess (including the CAS guard against a double reprocess), cross-tenant isolation.
- `tests/bulk-webhook-reprocess.test.js` (5 tests, Phase 6H): exact preview counts with zero side
  effects; a genuinely fixed event reprocesses to PROCESSED while a still-broken one is
  STILL_FAILED and stays selectable; the 100-event batch bound; an explicit `eventIds` selection
  touches only those exact events; refusal when nothing matches, Platform Admin gating.
- `tests/webhook-automatic-retry.test.js` (9 tests, Phase 6H): first-scheduling backoff window; a
  due retry succeeding against a repaired payload; a retry failing again and rescheduling with the
  next backoff step; exhausting a configured retry budget into `DEAD_LETTER`;
  `WEBHOOK_MAX_RETRIES=0` going straight to `DEAD_LETTER`; manual reprocess still working on a
  `DEAD_LETTER` event; an event with no raw payload never auto-scheduled; the sweep never touching
  an already-`PROCESSED` event; Platform Admin gating on the new visibility functions.
- `tests/e2e/webhook-operations-journey.e2e.mjs` — a full real-browser journey: real webhook URL,
  a validly-signed event PROCESSED, rotate the public ID (old URL 404s, new one works), rotate the
  secret (old signature 401s, new one works).
- `tests/e2e/phase6h-closure-journey.e2e.mjs` (Phase 6H) — creates a tenant custom connector
  webhook trigger through the real UI and confirms it survives Platform Admin review.

## Still NOT built (honestly deferred)

- **No configurable backoff ladder beyond the fixed 1min/5min/15min steps** — `WEBHOOK_MAX_RETRIES`
  controls how many retries happen, not how long each wait is; a per-connector or per-tenant
  custom backoff schedule was judged unnecessary complexity for this pass.
- **No webhook delivery log beyond the existing `webhook_events` ledger** — there is no separate
  "delivery attempts" or "retry history" table; the ledger's own `status` transitions
  (`RECEIVED -> PROCESSED|FAILED -> RETRY_SCHEDULED -> PROCESSING -> PROCESSED|RETRY_SCHEDULED|
  DEAD_LETTER`, or `FAILED|DEAD_LETTER -> REPROCESSING -> PROCESSED|FAILED` for a manual reprocess)
  are the only history kept — no per-attempt row, just the current state plus a running
  `retry_count`.
- **Secret rotation does not verify the operator has updated the sender** — rotating immediately
  invalidates the old signature (no grace window), which is the secure default, but there is no
  "test the new secret before committing" dry-run step; an operator must rotate, then re-configure
  the sending platform, then optionally use Test Webhook to confirm.
- **The retry sweep's timing granularity matches the scheduler's own tick interval**
  (`SCHEDULER_INTERVAL_MS`, default 5 minutes) — a retry "due" at the 1-minute mark is actually
  attempted on the next tick that happens to run after it, not to-the-second on schedule. Backed
  off, bounded, and eventually consistent; not a precision timer.

## History

Phase 6G built the manual operator tooling (rotation, test events, the failed-event inspector,
Safe Reprocess) and honestly documented bulk reprocess and automatic retry as out of scope. Phase
6H closed both of those exact gaps, plus added cross-tenant Platform Operations visibility for
Dead Letter events and pending retries.
