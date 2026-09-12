# Canonical Capability Registry (Phase 6A)

> **Phase 6B update**: the Generic REST Connector (`docs/GENERIC_REST_CONNECTOR.md`) enforces
> this registry directly — `validateManifest()` canonicalizes and de-duplicates every declared
> capability, and every action's `requiredCapability` must already be in the manifest's own
> `capabilities` list (Part 52/53) — there is no path for a Generic REST connector definition to
> invent an unknown or privileged capability string (`system.admin`, `security.write`, etc.);
> such a manifest simply fails validation.



`src/connectors/core/capability-registry.js`. One shared taxonomy so no future connector
invents a new name for a concept that already exists — additive only, never renames anything
`src/runtime/tools.js`/`src/runtime/capability-map.js` already rely on.

## Real legacy aliases found by the Phase 6 integration audit

These are the ONLY actual naming inconsistencies the audit found in the live codebase — not a
hypothetical list. `canonicalizeCapability()` maps each to its canonical id; the legacy string
keeps working everywhere it's already used (`tool_definitions`, `agent_tool_assignments`).

| Legacy string (still live in `tools.js`) | Used by | Canonical id |
|---|---|---|
| `publishing` | Meta's `meta_publish` tool | `social.publish` |
| `publish` | X's `x_publish` tool | `social.publish` |
| `organization.publish` | LinkedIn's `linkedin_publish` tool | `social.publish` |
| `orders.read` | Salla's `salla_syncOrders` stub (still `isAvailable:false`) | `commerce.orders.read` |
| `commerce.stock.read` | Salla's `get_stock` tool | `commerce.inventory.read` |
| `commerce.price.read` | Salla's `get_current_price` tool | `commerce.pricing.read` |

## Canonical registry

See `CANONICAL_CAPABILITIES` in the source for the full, current list (commerce.*, messaging.*,
mail.*, calendar.*, social.*, ai.*, crm.*, memory.*, analytics.*, content.*, design.*) — every
entry corresponds to a capability that has REAL code behind it today (verified by the same
audit), not an aspirational placeholder.

## What this registry does NOT do (yet)

- It does not replace `src/runtime/capability-map.js`'s `(provider, capability) → OAuth scopes`
  enforcement — that remains the real, live gate `tool-assignments.js`'s `resolveToolConnection`
  calls on every tool-to-connection resolution, completely unchanged this phase.
- It does not change `agent-readiness.js`'s tool-slug-based `REQUIRED_TOOLS`/`OPTIONAL_TOOLS`
  policy tables into capability-based ones — that is a real, larger change (Part 75/117/118)
  deferred to a later Phase 6 sub-phase once Generic Tool Binding (Part 20/21) has a second real
  provider per capability to prove interchangeability against (e.g. a future Zid connector next
  to Salla for `commerce.products.read`).
