# Event Normalization (Phase 6C)

## The canonical event taxonomy IS the existing Event Bus vocabulary — a deliberate deviation
from the spec's example naming style

Phase 6's own spec suggested a dotted taxonomy (`commerce.order.created`,
`messaging.message.received`, ...). This codebase already has a real, live, enforced taxonomy:
`runtime/events.js`'s `EVENT_TYPES` array (`ORDER_CREATED`, `PRODUCT_UPDATED`,
`CUSTOMER_MESSAGE_RECEIVED`, ...) — `createEventBus()`'s `emit()` **throws** on any type not in
that list. `src/runtime/salla-webhooks.js` already has a real, working precedent for exactly
this normalization: Salla's raw `'order.created'` webhook event is mapped to the Event Bus's own
`'ORDER_CREATED'` before dispatch.

Given a real taxonomy already exists and is already enforced, Phase 6C's `normalizedEventType`
field requires exactly one of these existing `EVENT_TYPES` values — inventing a second, parallel
dotted-name taxonomy that then needs its own further translation step into the real one would be
precisely the "parallel event infrastructure" Part 43/47 explicitly forbid. This is a conscious,
documented architectural decision, not an oversight.

## Trigger → normalized event (Part 45)

A connector's trigger declares which real Event Bus type it dispatches as. Acme's
`order_created` trigger declares `normalizedEventType: 'ORDER_CREATED'` — the exact same real
event Salla's own webhook already dispatches for the same real-world concept, proving a generic
connector reaches the identical, existing downstream event (Frost/Agents/Operations Log/`/api/
events` all already understand `ORDER_CREATED`) with zero new Event Bus code.

## Never falsely normalize (Part 46)

`validateWebhookManifest()` rejects any `normalizedEventType` that isn't a real, already-declared
`EVENT_TYPES` value — a connector cannot invent `'ACME_SPECIAL_THING'` and have it silently
accepted as a system event. If a future connector's event has no real semantic match in the
existing vocabulary, the correct fix is to add a new, real entry to `EVENT_TYPES` (an explicit,
reviewed, additive change to `runtime/events.js` — exactly like `PRODUCT_STOCK_UPDATED` was added
for Salla) — never to force a mismatch into an existing type.

## Normalized event shape reaching the Event Bus

```js
eventBus.emit(trigger.normalizedEventType, {
 ...mappedData,       // only the fields the trigger's mappingDefinition explicitly selected
 tenantId,            // resolved from the connection, never the payload
 connectionId,
 connectorId,          // the manifest's own slug
 correlationId         // the webhook_events row id — ties the event back to its real delivery
});
```

This is the SAME shape `createEventBus()` already persists into `agent_events` and hands to
every subscriber — no new event envelope was invented.
