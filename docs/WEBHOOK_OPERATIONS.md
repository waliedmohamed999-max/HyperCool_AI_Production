# Webhook Operations (Phase 6G status)

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
  re-fetch from the provider). Guarded by an atomic, CAS-style `FAILED -> REPROCESSING` status
  transition (`transitionWebhookEventStatus`, a single `UPDATE ... WHERE status=?` whose affected-
  row count IS the lock) — two concurrent "Reprocess" clicks can never both proceed, and a second
  attempt on an already-`PROCESSED` event is refused (`NOT_REPROCESSABLE`), never silently
  re-dispatched.
- **UI**: the Connection page's "Advanced" drawer Webhook tab — URL/secret rotation, send test
  event, view failed events with a per-row Reprocess button (disabled when no raw payload was
  retained, e.g. for an event that failed before this phase).

## Proven by

- `tests/webhook-console.test.js` (7 tests): console view, URL rotation (old id genuinely stops
  resolving), secret rotation (other credential fields survive; old signature fails, new one
  works), a real test event through the actual pipeline, the failed inspector's masking, Safe
  Reprocess (including the CAS guard against a double reprocess), cross-tenant isolation.
- `tests/e2e/webhook-operations-journey.e2e.mjs` — a full real-browser journey: real webhook URL,
  a validly-signed event PROCESSED, rotate the public ID (old URL 404s, new one works), rotate the
  secret (old signature 401s, new one works). 13/13 checks pass.

## Still NOT built (honestly deferred)

- **No bulk/scheduled reprocess** — every reprocess is one explicit, confirmed click per event;
  there is no "reprocess all failed events for this connection" batch action.
- **No retry/backoff policy at all** — this platform still makes **no retry guarantee**. A failed
  delivery is recorded as `FAILED` (with its payload now retained) and nothing automatically
  retries it; Safe Reprocess is a manual, operator-triggered action, never an automatic background
  job. This is unchanged from Phase 6F's own honest statement and remains true.
- **No webhook delivery log beyond the existing `webhook_events` ledger** — there is no separate
  "delivery attempts" or "retry history" table; the ledger's own `status` transitions
  (`RECEIVED -> PROCESSED|FAILED -> REPROCESSING -> PROCESSED|FAILED`) are the only history kept.
- **Secret rotation does not verify the operator has updated the sender** — rotating immediately
  invalidates the old signature (no grace window), which is the secure default, but there is no
  "test the new secret before committing" dry-run step; an operator must rotate, then re-configure
  the sending platform, then optionally use Test Webhook to confirm.

## Why the remaining gaps were deferred

Bulk reprocess and automatic retry both touch real business-side-effect risk at a different scale
than a single, explicitly confirmed action — a batch or automatic retry that fires against
already-partially-propagated downstream state needs its own careful design (idempotency at the
Event Bus consumer level, not just at this ledger's level) that was judged out of scope alongside
everything else this phase already shipped.
