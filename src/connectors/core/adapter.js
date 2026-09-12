// Universal Integration Platform (Phase 6A, Part 17) — the Connector Adapter contract. Plain
// JS has no interfaces, so this module is the runtime shape-check every adapter is validated
// against when registered (src/connectors/registry.js), rather than a class to extend — matching
// this codebase's existing preference for plain functions/objects over class hierarchies.
//
// An adapter WRAPS existing, already-tested provider code (Part 18 — "Do NOT rewrite every
// provider from zero") — it never reimplements the real network calls.

/** Methods every adapter MAY implement; only `healthCheck` is required (Part 17: "Optional
 * methods based on manifest" — an action-less DEFINITION_ONLY connector still needs no adapter
 * at all, but any REGISTERED adapter must be able to report its own health). */
const OPTIONAL_METHODS=['getIdentity','executeAction','refreshCredential','revoke','processWebhook'];
const REQUIRED_METHODS=['healthCheck'];

/**
 * Validates that `adapter` (a plain object of functions) satisfies the contract for the
 * capabilities its `manifest` actually declares — e.g. a manifest with actions must supply
 * `executeAction`; a manifest with webhooks must supply `processWebhook`. Throws with a precise
 * reason rather than failing silently at call time deep inside a real request.
 */
export function validateAdapter(adapter,manifest) {
 if(!adapter||typeof adapter!=='object')throw new Error(`Adapter for connector ${manifest?.slug} must be an object of functions`);
 for(const method of REQUIRED_METHODS)
  if(typeof adapter[method]!=='function')throw new Error(`Adapter for connector ${manifest.slug} must implement ${method}()`);
 if(manifest.actions?.length && typeof adapter.executeAction!=='function')
  throw new Error(`Connector ${manifest.slug} declares actions but its adapter has no executeAction()`);
 // Note: manifest.webhooks is allowed to be purely DESCRIPTIVE metadata about an existing,
 // real webhook route (e.g. Salla's own /api/webhooks/salla, unchanged since Phase 3.5) without
 // yet requiring a generic processWebhook() adapter method — the Webhook Framework that
 // actually invokes processWebhook() generically is Phase 6C's job, not 6A's. A connector that
 // DOES implement processWebhook still has it validated as a known method (see the loop below).
 for(const method of Object.keys(adapter))
  if(![...REQUIRED_METHODS,...OPTIONAL_METHODS].includes(method))
   throw new Error(`Adapter for connector ${manifest.slug} exposes unknown method ${method}() — not part of the adapter contract`);
 return true;
}
